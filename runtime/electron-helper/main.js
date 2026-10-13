/**
 * dsh-pet desktop helper —— Electron 主进程
 *
 * 职责：为**每只桌面宠物**开一个独立的局部小窗口（透明、置顶、不可激活），
 * 窗口 = 宠物包围盒 + 四周外扩余量（renderer 的 WINDOW_MARGIN_RATIO，为气泡/弹窗预留空间），
 * 宠物移动时 renderer 逐帧上报 bounds，本进程 setContentBounds 让窗口跟随宠物。
 *
 * 为什么是「局部小窗口」而不是「全屏透明画布」：全屏透明置顶窗会触发 Windows DWM 视频合成黑屏
 * （播放中的视频画面变黑、声音继续）。触发与窗口**绝对尺寸无关**，需四项齐备：透明置顶 + 非点击穿透
 * + 可聚焦且已聚焦 + **完整盖住视频窗**（98% 覆盖即安全；一个仅占屏幕 26% 的小窗同样能触发，issue #60
 * 的单变量实测矩阵）。本进程恰好会凑齐前三项——悬停宠物即整窗翻成可交互、show() 出去的窗口本就是
 * 聚焦的——而全屏画布又把第四项白送（必然完整遮挡非全屏播放的视频），故"不做全屏画布"的结论不变，
 * 只是理由换成这套条件；现有形态靠**默认整窗穿透 + 小窗几乎不可能完整遮挡视频窗**规避。
 * （旧注释写作"窗口不全屏就不黑"，那是把 0.1.x 的「全屏画布 → 每宠小窗」与输入模型改造这两件
 * 同时发生的事，混成了一个自变量。）
 * 输入：窗口默认**整窗点击穿透**（setIgnoreMouseEvents(true,{forward:true})），渲染端在光标
 * 进/出宠物身体命中区时经 pet:set-interactive 翻转可交互——透明像素不挡下层应用，
 * 与浏览器 overlay（仅 .dsh-pet-hit 可交互）严格对齐。
 *
 * 数据通道（bridge 模式，DSH_PET_BRIDGE=1 由宿主注入）：
 * 渲染端不再直连宿主 WebServer（DSH Desktop 2.0.3+ 的浏览器访问闸门会拦无令牌裸 HTTP）——
 * 本进程注册自定义 scheme `dsh-pet-bridge://`，protocol.handle 收到渲染端请求后
 * 经 stdin/stdout JSON 行协议转发宿主（helper-process.ts 的 BridgeHandler），
 * 宿主用与 HTTP 路由同一份 handlePetRoute 应答；素材应答带文件绝对路径，本进程读盘返回。
 * 无 DSH_PET_BRIDGE（手动 start-desktop / 开发流）时保持旧路径：渲染端直接 HTTP 访问宿主。
 *
 * 进程存亡（issue #56）：本进程的 stdout/stderr 是宿主给的管道，宿主一退出读端就消失（下一次写
 * 就是 EPIPE，而 Electron 默认处理器只会弹框且不退出）。故有「宿主存活」一节：管道守卫 +
 * 宿主 PID 探测，宿主没了就自己退——见那里的注释。
 *
 * 启动模式（issue #63）：若被以「纯 Node 模式」拉起（宿主透传了 ELECTRON_RUN_AS_NODE），内置
 * electron 模块不会注册，下面的 require 会失败——报一句能定位原因的话再退出，别只留 MODULE_NOT_FOUND。
 */
let electronApi;
try {
  electronApi = require('electron');
} catch (error) {
  process.stderr.write(
    '[dsh-pet helper] 启动失败：本进程被以「纯 Node 模式」拉起（ELECTRON_RUN_AS_NODE=' +
      JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null) +
      '）。该变量必须在 spawn 前删除（见 src/host/helper-process.ts 的 helperSpawnEnv），' +
      '运行期再删无效，设成空串会让 Electron 直接 abort。原始错误：' +
      (error instanceof Error ? error.message.split('\n')[0] : String(error)) +
      '\n',
  );
  process.exit(3);
}
const { app, BrowserWindow, ipcMain, screen, shell, protocol, desktopCapturer } = electronApi;
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync, appendFileSync, statSync } = require('node:fs');
const fsPromises = require('node:fs/promises');
// 点击穿透兜底通道的纯判定（不依赖 Electron 的 forward 鼠标钩子；见文件头注释）
const { decideWindowIgnore } = require('./pointer-target.js');
// 宿主存活判定（issue #56：宿主退出 → 管道断开 → 自己退，绝不弹框、绝不留僵尸）
const { HOST_POLL_MS, hostIsGone, isBrokenPipeError, parseHostPid } = require('./host-liveness.js');

// 允许无用户手势直接播放（余额动画等）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 显式定名：Helper 是被 `electron.exe <main.js>` 直接拉起的，Electron 取不到 app 名会回落成
// "Electron"，userData 便落到 %APPDATA%\Electron —— 那是所有这么跑的 Electron 脚本的公共目录，
// 我们的 DPI 缓存与 Chromium profile 都会和别人混在一起。必须赶在任何 getPath('userData') 之前设。
app.setName('dsh-pet-electron-helper');

/** DPI 探测子进程模式：不建窗口，只把主屏 scaleFactor 打到 stdout 就退出（见 probePrimaryScale） */
const DPI_PROBE = process.env.DSH_PET_DPI_PROBE === '1';
/** 探测进程的输出标记（父进程按它抓值） */
const DPI_MARK = 'dsh-pet-primary-scale:';

// ---------- 宿主存活（issue #56）：管道断开 / 父进程消失 → 自己退出 ----------
//
// 【为什么必须自己退】宿主退出后，它在 helper 的 stdout/stderr 上握着的管道读端一起关闭；helper
// 下一次写（bridge 协议行 —— 渲染端每秒至少一条 /state 轮询）拿到 EPIPE。未处理的 'error'
// 事件 = 未捕获异常，而 Electron 主进程自带的处理器只弹一个模态框、**且不退出**
// （lib/browser/init.ts 原文注释："Don't quit on fatal error"）—— 桌宠就此卡死、进程赖着不走。
// 真机实测（宿主存活、只切断 stdout 管道）：那次写之后主线程彻底停住，14 秒里一次心跳都没有，
// 进程也一直没有退出。
//
// 两条路都要有，缺一不可：
//   ① 管道守卫：任何一次写失败都不许变成异常；管道断开本身就是"宿主已死"的铁证 → 立刻退。
//      它只在**上层真的写**的时候才触发；
//   ② 宿主探测：每 HOST_POLL_MS 用 kill(pid, 0) 问一次宿主还在不在，ESRCH 即退。
//      渲染端崩了/根本没起来时一次写都不会发生，只有 ② 能收敛。
// 两条路都只经 exitForDeadHost()，且只退一次。
let hostGone = false;
/** 宿主没了 → 立刻退出。这里**不能**再打日志：管道已经断了，写只会再踩一次同一个错误 */
function exitForDeadHost() {
  if (hostGone) return;
  hostGone = true;
  app.exit(0); // 宿主消失是"环境要求我退"，不是自身崩溃，退出码 0
}

// ① 管道守卫：必须赶在**任何一次写**之前装上（probePrimaryScale 失败就会往 stderr 写）
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (isBrokenPipeError(error)) exitForDeadHost();
    // 其余流错误同样吞掉：Electron 的默认处理是弹模态框，任何流错误都不值得拿桌宠去换一个框
  });
}

// ② 宿主探测：DSH_PET_HOST_PID 由宿主 spawn 时注入；未注入/非法 → parseHostPid 给 0 → 不探测（不误退）。
// DPI 探测实例是一次性短命进程（它的父进程是 helper 而不是宿主），不参与这套机制。
const HOST_PID = parseHostPid(process.env.DSH_PET_HOST_PID);
if (!DPI_PROBE && HOST_PID > 0) {
  setInterval(() => {
    if (hostIsGone(HOST_PID)) exitForDeadHost();
  }, HOST_POLL_MS).unref?.();
}

// Windows 透明分层窗口（WS_EX_LAYERED）在 DWM 硬件加速合成下存在多处缺陷：
//   - 拖拽移动时窗口四周出现黑色边框（#37）
//   - 大透明窗移动覆盖小透明窗时，被覆盖窗口内容丢失（显示"消失"）
// 本进程只渲染轻量宠物动画（640×360），改走软件合成以规避上述缺陷，
// 不影响浏览器形态与主 DSH（独立进程）；非 Windows（macOS/Linux）合成路径不同，保留硬件加速。
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
}

// ---------- 全局 DPI 线性化（多显示器异构缩放的根因修复） ----------
//
// Windows 上 Chromium 的 DIP↔物理 换算是**逐显示器**的仿射变换，而且
// ScreenWin::DIPToScreenRect(hwnd, rect) 用的是「hwnd 当前归属屏」的那一组参数：
//   physical = (dip − D.dipOrigin) × D.scale + D.pixelOrigin
// 归属由 MonitorFromWindow(MONITOR_DEFAULTTONEAREST) 按面积占比决定，窗口骑缝时会反复翻转。
// 两屏缩放不同时，同一个 DIP 值在翻转前后落到不同物理位置、算出不同物理尺寸
// （实测 1.5/1.75 双屏：位置差 110px、924 DIP 宽的窗口尺寸差 231px），
// 于是 setContentBounds 每帧的落点在两套坐标系之间横跳 —— 这就是拖过屏缝时的「分身闪烁」，
// 也是两屏缩放一致时同样骑缝却毫无问题的原因。
//
// --force-device-scale-factor 让 Chromium 的 GetMonitorScaleFactors() 对所有显示器
// 直接返回同一个值，全部屏塌缩成**同一个**仿射变换 ⇒ DIPToScreenRect 的结果与窗口归属无关。
//
// 取值必须是 **1**，不能取主屏的 scaleFactor。实测（tools/probe-dpi.cjs，1.5 + 1.75 双屏）：
//   forced=1.5 → display.bounds 被二次缩放（主屏物理 3840 宽报成 1706 = 3840/1.5/1.5，
//                而同一块屏的 workArea 报 2560 = 3840/1.5，两者自相矛盾）。
//                DIPToScreenPoint 用 bounds.origin() 当 dipOrigin，于是
//                pixelOrigin(3840) ≠ dipOrigin(1706)×1.5，副屏多出 1281px 的**恒定**偏移——
//                比不加 switch 时的 75px 还糟。
//   forced=1   → bounds 与 workArea 一致，每块屏都满足 pixelOrigin == dipOrigin×scale，
//                DIP 与物理像素成为恒等映射，探针的 DELTA 全 0（尺寸差 231×151 也一并归零）。
// 所以这里锁死 1：坐标系 = Windows 物理像素，跨屏几何再无换算与舍入。
//
// 代价：宠物尺寸的单位从 DIP 变成物理像素，不补偿的话在 150% 的屏上会小 1/1.5。
// 用探测到的**真实主屏 scaleFactor** 乘进渲染端的 CONFIG.scale 抵掉（见 petScale()）——
// 主屏上的观感与修复前逐像素相同；其余屏改按主屏缩放渲染宠物（同尺寸同分辨率的两块屏上
// 物理大小反而一致了）。探测失败就整个不启用，退回修复前行为，不做没有补偿的缩放。
//
// 环境变量 DSH_PET_FORCE_DSF：'0' = 关闭本机制；其它正数 = 强制该值（排障用，会踩上面的 bug）。
//
// 取值时机是个麻烦：switch 必须在 app ready 之前设，而那时 screen 模块还不可用。
// 所以首次启动 spawn 一个自己的探测子进程（DSH_PET_DPI_PROBE=1，只打印 scaleFactor 就退出，
// ~0.5s）并把结果落盘；之后每次启动直接读缓存，零开销。

/** 主屏缩放缓存文件（userData 在 ready 前即可用） */
function dpiCacheFile() {
  return path.join(app.getPath('userData'), 'primary-scale.json');
}

function readCachedPrimaryScale() {
  try {
    const v = Number(JSON.parse(readFileSync(dpiCacheFile(), 'utf8')).scaleFactor);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0; // 首次启动/文件损坏：当作无缓存，重新探测
  }
}

function writeCachedPrimaryScale(value) {
  try {
    writeFileSync(dpiCacheFile(), JSON.stringify({ scaleFactor: value }), 'utf8');
  } catch (e) {
    console.error('[dsh-pet-desktop-helper] write dpi cache failed:', String(e && e.message ? e.message : e));
  }
}

/** 从探测子进程的输出里抓 scaleFactor（0 = 没抓到） */
function parseProbeOutput(text) {
  const m = new RegExp(DPI_MARK + '([0-9.]+)').exec(String(text || ''));
  const v = m ? Number(m[1]) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 拉起探测子进程读主屏 scaleFactor（同一个 electron + 同一个 main.js，走 DPI_PROBE 分支） */
function probePrimaryScale() {
  const opts = {
    env: { ...process.env, DSH_PET_DPI_PROBE: '1', DSH_PET_BRIDGE: '0', DSH_PET_SMOKE: '0' },
    timeout: 20000,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  let out = '';
  try {
    out = execFileSync(process.execPath, [__filename, '--dsh-pet-dpi-probe'], opts);
  } catch (e) {
    // 只认 stdout，不认退出码：一个不开窗口的 Electron 进程调 app.exit() 在 Windows 上
    // 偶发 0xC0000005（退出期访问违例），但那时值早就写出来了，丢掉它纯属浪费一次冷启动。
    out = e && e.stdout ? String(e.stdout) : '';
    if (!parseProbeOutput(out)) {
      const detail = [
        e && e.status !== undefined ? 'status=' + e.status : '',
        e && e.stderr ? 'stderr=' + String(e.stderr).trim().slice(0, 300) : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.error(
        '[dsh-pet-desktop-helper] dpi probe failed:',
        String(e && e.message ? e.message : e).split('\n')[0],
        detail,
      );
      return 0; // 探测失败：不加 switch，退回修复前行为（多屏异构 DPI 会闪，但不影响可用性）
    }
  }
  const v = parseProbeOutput(out);
  if (v > 0) writeCachedPrimaryScale(v);
  return v;
}

/** 真实主屏 scaleFactor（探测所得；0 = 未知）。开启线性化后 screen API 只会报 1，只能靠它。 */
let PRIMARY_SCALE = 0;
/** 实际生效的强制缩放（0 = 未启用，坐标系维持修复前的逐屏 DIP） */
let FORCED_SCALE = 0;
if (!DPI_PROBE && process.env.DSH_PET_FORCE_DSF !== '0') {
  PRIMARY_SCALE = readCachedPrimaryScale() || probePrimaryScale();
  const override = Number(process.env.DSH_PET_FORCE_DSF);
  const forced = Number.isFinite(override) && override > 0 ? override : PRIMARY_SCALE > 0 ? 1 : 0;
  if (forced > 0) {
    app.commandLine.appendSwitch('force-device-scale-factor', String(forced));
    FORCED_SCALE = forced;
  }
}

/**
 * 渲染端的 CONFIG.scale：宿主给的基准 × 物理像素补偿。
 * 线性化开启后 1 逻辑像素 = 1 物理像素，宠物按主屏缩放放大回原来的观感。
 */
function petScale() {
  const base = Number(process.env.DSH_PET_SCALE || '1') || 1;
  return FORCED_SCALE > 0 && PRIMARY_SCALE > 0 ? base * (PRIMARY_SCALE / FORCED_SCALE) : base;
}

/** bridge 模式：DSH_PET_BRIDGE=1（宿主注入）。开启时注册 dsh-pet-bridge scheme + 管道转发 */
const BRIDGE = process.env.DSH_PET_BRIDGE === '1';
/** 协议行前缀（与 helper-process.ts 的 BRIDGE_PREFIX 一致） */
const BRIDGE_PREFIX = 'dsh-pet-bridge:';

if (BRIDGE) {
  // 自定义 scheme：standard（可解析 URL）+ secure（按 https 对待）+ supportFetchAPI（fetch 可用）
  // + stream（视频流）+ corsEnabled（让 CORS 规则生效，配合响应里的 ACAO 头放行 file:// 源页面）
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'dsh-pet-bridge',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** 窗口表：petId -> BrowserWindow */
const windows = new Map();

/** 统一显隐所有桌宠窗口：手动「隐藏桌宠」与自动隐藏共用这一条路径（只隐藏窗口，不退出 helper）。 */
function setAllPetWindowsVisible(visible) {
  for (const win of windows.values()) {
    if (win.isDestroyed()) continue;
    if (visible) win.show();
    else win.hide();
  }
}

/** win.id -> 上一次**请求**的内容区矩形（"x,y,w,h"）：pet:set-bounds 的去重基准，见那里的注释 */
const lastRequestedBounds = new Map();

/**
 * 宠物间碰撞 broker 状态：petId -> { x, y, vx, vy, size, bottomPad }。
 * 来源：pet:set-bounds（位置+尺寸+速度，随漫游/拖拽/静止保真上报，每帧一次）+
 *       pet:report-flight（飞行中每 ~30ms 高频补充速度）。
 * 任何更新都广播全量给所有窗口——每窗飞行方用它做跨窗碰撞检测（滞后 ≤ 1 帧，可接受）。
 */
const petStates = new Map();

/** 把当前全量宠物状态广播给所有窗口（碰撞检测的共享站场） */
function broadcastPetStates() {
  const states = {};
  for (const [pid, s] of petStates) {
    states[pid] = { x: s.x, y: s.y, vx: s.vx, vy: s.vy, size: s.size, bottomPad: s.bottomPad };
  }
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send('pet:flight-states', states);
  }
}

/** 记录/更新一只宠物的状态并广播 */
function updatePetState(petId, partial) {
  const prev = petStates.get(petId) || { x: 0, y: 0, vx: 0, vy: 0, size: 0, bottomPad: 0 };
  petStates.set(petId, Object.assign({}, prev, partial));
  broadcastPetStates();
}

/**
 * 每窗口当前穿透状态（true = 整窗点击穿透）。所有 setIgnoreMouseEvents 只经本文件
 * （创建时初始化 + pet:set-interactive 翻转 + 光标兜底轮询），这里镜像真实状态，供冒烟断言/排查使用
 * （Electron 无 isIgnoringMouseEvents 取值 API）。
 */
const windowIgnore = new Map();

/** 翻转整窗穿透的**唯一出口**：状态与 windowIgnore 镜像永远一起更新（穿透期间保留 forward） */
function setWindowIgnore(win, ignore) {
  win.setIgnoreMouseEvents(ignore, { forward: true });
  windowIgnore.set(win.id, ignore);
}

/** 兜底通道的光标轮询间隔（ms，与 issue #55 报告者实测值一致） */
const POINTER_POLL_MS = 60;
/** 冒烟期间暂停兜底轮询：它按**真实光标**翻转 windowIgnore，会干扰冒烟对渲染端通道的断言 */
let pointerFallbackPaused = false;

/**
 * 每窗口「渲染端正拿着鼠标输入」标记（win.id → true/false），由渲染端经 `pet:input-busy` 上报。
 *
 * 为什么必须由渲染端说了算：兜底通道判定的是"光标与**窗口矩形**"的关系，而窗口矩形比宠物身体大
 * 一圈（四周各半只宠物的余量）。拖拽时宠物由 rAF 弹簧追赶光标、**滞后**于光标；甩得快时滞后量
 * 超过那一圈余量，光标就落在矩形外 → 判成"窗外" → 翻回穿透 → 渲染端正在拖拽的 window 级
 * pointermove/pointerup 全断（鼠标还按着，宠物却按旧速度"飞"出去，连松手都没人报）。
 *
 * 主进程**无法自行判断**这件事（光看光标位置和窗口位移分不清"拖拽跟手"与"漫游/抛掷"），
 * 而渲染端知道（拖拽中 / 菜单开着 / 对话弹窗开着）。所以只由它上报，busy 期间本进程绝不翻回穿透。
 */
const inputBusy = new Map();

/**
 * 桌面宠物列表（[{id,size}]）：宿主经 DSH_PET_PETS 透传（每只宠物一个窗口）。
 * 解析失败/未透传（手动 start-desktop）时回落到单个默认宠物窗口；renderer 首帧发来的
 * set-bounds 会按真实配置自校正尺寸与位置。
 */
function petsFromEnv() {
  try {
    const raw = process.env.DSH_PET_PETS || '';
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.map((p, i) => ({
        id: String(p?.id ?? `pet-${i}`),
        size: Number(p?.size) > 0 ? Number(p.size) : 462,
        index: i,
      }));
    }
  } catch {
    /* fallthrough */
  }
  return [{ id: 'main', size: 462, index: 0 }];
}

/** 窗口初始尺寸 = 宠物包围盒 + 四周外扩余量（4×0.5×size，与 renderer 的 WINDOW_MARGIN_RATIO 一致；
 *  renderer 首帧 set-bounds 会按真实配置精确覆盖，这里只是避免启动瞬间的尺寸跳变）。 */
function petWindowSize(size) {
  const height = (size * 9) / 16;
  const bottomPad = (size * (9 / 16) * (360 - 330)) / 360;
  const m = Math.round(size * 0.5);
  return { width: Math.round(size) + m * 2, height: Math.round(height + bottomPad) + m * 2 };
}

/**
 * 桌面几何：**逐显示器的工作区列表** + 它们的外接矩形 + 主屏下标。
 *
 * 外接矩形（hull）仍然是渲染端视口 VIEW 的来源——它只用作坐标系原点与比例换算基准。
 * 但所有边界判定（漫游落点 / 抛掷反弹 / 角落定位 / 菜单夹取）必须走 areas 的**并集**：
 * 显示器摆放不规则时 hull 里会有大片不属于任何屏的空洞，以 hull 为边界会把宠物放进去
 * （实测右倒 T 型双屏：hull 的 23.7% 是空洞，宠物飞进去就彻底看不见了）。
 */
function deskGeometry() {
  const displays = screen.getAllDisplays();
  const areas = displays.map((d) => ({
    x: d.workArea.x,
    y: d.workArea.y,
    width: d.workArea.width,
    height: d.workArea.height,
  }));
  // 每块屏的**完整面板**（含任务栏区）：抛掷的「越界侧有没有邻屏」探测用它，否则任务栏
  // 在接缝处挖出的工作区条带会被当成墙，宠物穿不过上下叠放的屏（见 shared/physics.ts）
  const panels = displays.map((d) => ({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
  }));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of areas) {
    x0 = Math.min(x0, a.x);
    y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x + a.width);
    y1 = Math.max(y1, a.y + a.height);
  }
  const primaryId = screen.getPrimaryDisplay().id;
  const primaryIndex = Math.max(
    0,
    displays.findIndex((d) => d.id === primaryId),
  );
  return { hull: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, areas, panels, primaryIndex };
}

function createPetWindows() {
  const geo = deskGeometry();
  const area = geo.hull;
  const configUrl = process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config';
  const pets = petsFromEnv();
  const scale = petScale();
  for (const pet of pets) {
    // 初始窗口尺寸也要吃缩放补偿，否则启动瞬间会有一次可见的尺寸跳变
    const { width, height } = petWindowSize(pet.size * scale);
    const win = new BrowserWindow({
      width,
      height,
      x: area.x, // 初始左上角；renderer 首帧按配置角落/位置校正
      y: area.y,
      show: false,
      useContentSize: true,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      // 可聚焦：对话输入框/菜单需要窗口焦点才能打字（focusable:false 会让输入框永远无法聚焦）。
      // 别把这里当成黑屏的无关项：可聚焦 + 已聚焦本身就是 DWM 视频黑屏的四项触发条件之一（见文件头），
      // 而 show() 出来就是聚焦状态——真正在挡的是「默认整窗穿透」+「小窗几乎不可能完整遮挡视频窗」
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        paintWhenInitiallyHidden: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 窗口被其他窗口（另一只宠物）完全遮挡时，Chromium 默认会暂停本窗口渲染，
    // 导致大宠物移动盖过小宠物时小宠物显示为"消失"。关闭后台节流，让被遮挡
    // 窗口持续渲染，移开遮挡后立刻恢复显示。
    win.webContents.setBackgroundThrottling(false);
    // 屏蔽 Electron 默认右键菜单：右键菜单由渲染端统一自绘组件弹出（两端一致），绝无双菜单
    win.webContents.on('context-menu', (event) => event.preventDefault());
    // 页面级缩放 = petScale()（渲染端 CONFIG.scale 的同一来源）：整窗内容统一放大，渲染端坐标系
    // 回到 CSS 像素——右键菜单/积分弹窗/聊天框等固定 px UI 随之恢复 DIP 观感，不再逐处补偿
    // （见 DESIGN.md §3.5；跨进程交换仍走物理像素，由渲染端 toScreen/toLocal 收口）。
    // webPreferences.zoomFactor 对 show:false 的窗口不生效（实测），须在加载完成后设置。
    win.webContents.on('did-finish-load', () => {
      win.webContents.setZoomFactor(scale);
    });
    // 默认整窗点击穿透（renderer 在光标进/出身体命中区时经 IPC 翻转可交互）；
    // forward:true 保证穿透期间 mousemove 仍转发进渲染端做命中判定。
    setWindowIgnore(win, true);
    win.once('ready-to-show', () => win.show());
    // [#55 兜底显示] paintWhenInitiallyHidden:false 时渲染器可能不产出首帧，ready-to-show 便永不触发
    // （Electron 文档原文：ready-to-show "will never fire if you use paintWhenInitiallyHidden: false"），
    // 而 show() 只挂在它上面 → 窗口永远隐藏（进程活着、宠物逻辑照跑，桌面上什么都没有）。
    // 页面加载完成后强制兜底一次；zoomFactor 的设置在更早注册的 did-finish-load 里，顺序不受影响。
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.show();
      }, 400);
    });
    // [#55 兜底交互] 上面的翻转链路只有「Electron forward 鼠标钩子 → 渲染端命中判定」一个入口，
    // 该钩子在 Windows 上可能静默失效（回调超时被系统摘掉 / 被别的软件钩子干扰）→ 光标悬浮无反应、
    // 拖不动、点击与右键全废。这里由主进程按**真实光标位置**独立判定，不依赖那条转发链路：
    // 与 renderer 那条通道并存且判定区域一致（状态未变不翻转），转发正常的环境行为完全不变。
    //
    // 唯一不可自行决定的事：**渲染端正拿着鼠标输入时不得翻回穿透**（见 inputBusy）。
    // 本进程无从判断这件事——光看光标位置与窗口位移分不清"拖拽跟手"和"漫游/抛掷"，所以由渲染端上报。
    const pointerTimer = setInterval(() => {
      if (pointerFallbackPaused || win.isDestroyed()) return;
      const b = win.getBounds();
      if (b.width < 8 || b.height < 8) return; // 尺寸还没落定（renderer 首帧上报前）
      const ignoring = windowIgnore.get(win.id) !== false;
      const next = decideWindowIgnore(b, screen.getCursorScreenPoint(), ignoring, inputBusy.get(win.id) === true);
      if (next !== ignoring) setWindowIgnore(win, next);
    }, POINTER_POLL_MS);
    win.on('closed', () => {
      clearInterval(pointerTimer);
      windows.delete(pet.id);
      lastRequestedBounds.delete(win.id);
      windowIgnore.delete(win.id);
      inputBusy.delete(win.id);
    });
    win
      .loadFile('index.html', {
        query: {
          configUrl,
          bridge: BRIDGE ? '1' : '0',
          scale: String(scale),
          petIndex: String(pet.index),
          workAreaW: String(area.width),
          workAreaH: String(area.height),
          workAreaX: String(area.x),
          workAreaY: String(area.y),
          // 逐屏工作区（屏幕坐标）+ 主屏下标：渲染端所有边界判定走它们的并集，不走外接矩形。
          // 首帧就要用（position() 定角落），所以走 query；运行期变化再经 pet:displays 推送。
          areas: JSON.stringify(geo.areas),
          // 逐屏完整面板（含任务栏区）：抛掷越界侧探测用（任务栏条带不当墙，见 shared/physics.ts）
          panels: JSON.stringify(geo.panels),
          primaryIndex: String(geo.primaryIndex),
        },
      })
      .catch((error) => {
        console.error(`[dsh-pet-desktop-helper] page load failed (${pet.id}):`, error);
        win.destroy();
      });
    windows.set(pet.id, win);
  }
}

// ---------- bridge 协议（渲染端 custom scheme → 本进程 → 宿主 stdout JSON 行 + 本地回调） ----------
// 渲染端的每个 fetch 都落到 dsh-pet-bridge://，protocol.handle 把请求以一行 JSON 写 stdout 转发宿主。
// 宿主应答**不走近 0 号管道**：Electron 主进程在 Windows 上收不到 piped stdin（electron#4218），
// 所以本进程开一个 127.0.0.1 随机端口 HTTP 回调（DSH 闸门只拦 DSH WebServer 路由，管不到这里）；
// 请求行携带回调 URL，宿主处理完 POST 应答回来，按 id 唤醒等待中的请求。
// 素材（webm/字体/光标）：宿主只回文件绝对路径，本进程自行读盘应答（二进制不过管道）。
// 协议行统一前缀 BRIDGE_PREFIX，宿主侧按前缀区分协议与日志（console 输出也走 stdout）。

let bridgeSeq = 0;
/** id -> {resolve, reject}：一个请求对应宿主的一次回调应答 */
const bridgePending = new Map();
let bridgeCallbackUrl = '';

/** 渲染端请求 → 宿主（请求行带回调 URL）；返回宿主应答（{status, contentType?, body?, file?}），超时抛错 */
function bridgeRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const id = ++bridgeSeq;
    bridgePending.set(id, { resolve, reject });
    process.stdout.write(BRIDGE_PREFIX + JSON.stringify({ id, method, url, body, cb: bridgeCallbackUrl }) + '\n');
    // 宿主若长期不应答（进程退出/宿主动作挂起）不无限挂起：45s 兜底（LLM 生成最长 30-60s）
    setTimeout(() => {
      const p = bridgePending.get(id);
      if (!p) return;
      bridgePending.delete(id);
      p.reject(new Error('bridge request timeout'));
    }, 45000).unref?.();
  });
}

/** 把宿主回调应答（{id, status, ...}）派发给对应请求 */
function bridgeResolve(resp) {
  const p = resp && bridgePending.get(resp.id);
  if (!p) return;
  bridgePending.delete(resp.id);
  p.resolve(resp);
}

/** 本地回调服务器：宿主把应答 POST 到这里（127.0.0.1 随机端口，绕开 stdin/DSH 闸门） */
function startBridgeCallback() {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/respond') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('dsh-pet: not found');
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        bridgeResolve(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('dsh-pet: bad payload');
      }
    });
    req.on('error', () => {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('dsh-pet: bad payload');
    });
  });
  server.on('error', (e) => {
    console.error('[dsh-pet-desktop-helper] bridge callback server error:', String(e && e.message ? e.message : e));
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    bridgeCallbackUrl = 'http://127.0.0.1:' + (addr && typeof addr === 'object' ? addr.port : 0) + '/respond';
    console.error('[dsh-pet-desktop-helper] bridge callback: ' + bridgeCallbackUrl);
  });
  return server;
}

/** 处理一个渲染端请求：拼宿主请求行 → 等应答 → 组装 Response（素材读盘） */
async function handleBridgeRequest(request) {
  const url = new URL(request.url); // dsh-pet-bridge://dsh-pet/dsh-pet-7340/...
  const method = request.method || 'GET';
  let body;
  if (method === 'POST' || method === 'PUT') {
    body = await request.text();
  }
  const resp = await bridgeRequest(method, url.pathname + url.search, body);
  const headers = { 'access-control-allow-origin': '*' }; // 渲染端页面是 file:// 源，scheme 跨源需 CORS
  if (resp.contentType) headers['content-type'] = resp.contentType;
  if (resp.file) {
    // 素材：直接读盘返回（宿主已解析好绝对路径；带 range 让视频能拖动进度条）
    try {
      const data = await fsPromises.readFile(resp.file);
      return new Response(new Uint8Array(data), { status: resp.status || 200, headers });
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] bridge file read failed:', resp.file, e);
      return new Response('dsh-pet: asset read failed', { status: 500, headers });
    }
  }
  return new Response(resp.body ?? '', { status: resp.status || 200, headers });
}

app.whenReady().then(() => {
  // 探测子进程：此时没有 force-device-scale-factor，读到的是 Windows 的真实主屏缩放。
  // 退出推迟一拍——在 ready 回调里直接 app.exit() 会赶在 stdout 落盘前拆掉进程
  if (DPI_PROBE) {
    process.stdout.write(DPI_MARK + screen.getPrimaryDisplay().scaleFactor + '\n');
    setTimeout(() => app.exit(0), 0);
    return;
  }
  console.error(
    '[dsh-pet-desktop-helper] displays: ' +
      JSON.stringify(deskGeometry()) +
      ' forcedScaleFactor=' +
      (FORCED_SCALE || 'off') +
      ' primaryScale=' +
      (PRIMARY_SCALE || 'unknown') +
      ' petScale=' +
      petScale(),
  );

  if (BRIDGE) {
    // 自定义 scheme 接住渲染端全部请求（配置/余额/碎碎念/广播/素材）
    protocol.handle('dsh-pet-bridge', (request) =>
      handleBridgeRequest(request).catch((e) => {
        console.error('[dsh-pet-desktop-helper] bridge handler error:', String(e && e.message ? e.message : e));
        return new Response('dsh-pet: bridge error', {
          status: 502,
          headers: { 'access-control-allow-origin': '*' },
        });
      }),
    );
    startBridgeCallback(); // 宿主应答回调服务器（stdin 在 Electron 主进程不可用，改走本地 HTTP）
  }

  createPetWindows();

  // ---------- 自动隐藏：检测到「不该露脸」的窗口就自己躲起来 ----------
  // 场景：共享屏幕 / 放映 PPT 时，桌宠出现在画面里很尴尬。
  // 手段：desktopCapturer 能列出所有窗口的**标题**（Electron 自带，不需要原生模块或 FFI）。
  //       PPT 放映时会多出一个「幻灯片放映」窗口，钉钉共享时窗口标题也会变，据此判定。
  // 语义（按用户要求定）：
  //   · 命中 → 隐藏一次；
  //   · 条件消失 → **不自动显示**，等用户手动打开（工具菜单「打开桌宠」）；
  //   · 命中只处理一次（autoHideHandled）：这样用户手动打开后，不会被下一轮轮询立刻又藏起来，
  //     直到那次共享/放映真正结束（窗口消失）后复位，下次再命中才会再隐藏。
  // 配置**现拉**，不靠宿主注入环境变量：注入方案意味着改关键词要重启 DSH 才生效，
// 而 helper 本来就能访问 host 的 /config（渲染端一直在用）。现拉一次即可：
// 改完配置重启 helper 生效，运行中还会定期重拉，连重启都不用。
  const AUTOHIDE_CONFIG_URL = process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config';

  /** 自动隐藏的诊断日志。helper 是独立进程、stderr 不好取，
   *  所以把关键判定落到文件里——排查"关了开关还是躲"这类问题时，
   *  直接看这个文件就知道 helper 当时用的是哪个开关值、命中在哪条路径。 */
  const AUTOHIDE_LOG = 'C:\\Users\\JDT\\.dsh\\dsh-pet\\autohide-log.txt';
  const ahLog = (msg) => {
    try {
      const line = `${new Date().toISOString()} ${msg}\n`;
      // 简单截断：超过 ~256KB 就重开，避免无限增长
      try {
        if (statSync(AUTOHIDE_LOG).size > 256 * 1024) writeFileSync(AUTOHIDE_LOG, '');
      } catch {
        /* 文件还不存在 */
      }
      appendFileSync(AUTOHIDE_LOG, line);
    } catch {
      /* 日志失败不影响功能 */
    }
  };

  // ---------- 全屏检测（koffi 调 Win32） ----------
  // 业界通行做法（见「推送者桌宠」那篇开发者视角的文章）：不看应用在干什么，
  // 只看**前台窗口是否覆盖整个显示器**。覆盖面因此很广：PPT 放映 / 视频全屏 /
  // 游戏 / 全屏共享都能躲，不依赖任何应用的内部状态（钉钉也不对外暴露共享状态）。
  //
  // ⚠️ 经典误判：任务栏设「自动隐藏」时，**最大化**窗口的矩形也会覆盖整个显示器，
  //    光比矩形会把普通最大化程序当成全屏。所以必须结合窗口样式——
  //    真全屏（F11 / 放映模式 / 游戏独占）是无边框的 WS_POPUP，最大化仍带 WS_OVERLAPPEDWINDOW。
  //    （dsh-pet-indesktop 的 Releases 里就记着这个坑：最大化时桌宠被误隐藏且不恢复。）
  let detectFullscreen = () => null;

  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const MONITORINFO = koffi.struct('MONITORINFO', {
      cbSize: 'uint32',
      rcMonitor: RECT,
      rcWork: RECT,
      dwFlags: 'uint32',
    });

    const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
    const GetWindowRect = user32.func('bool GetWindowRect(void *hWnd, _Out_ RECT *lpRect)');
    const GetWindowTextW = user32.func('int GetWindowTextW(void *hWnd, _Out_ uint16 *lpString, int nMaxCount)');
    const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)');
    const GetWindowLongW = user32.func('long GetWindowLongW(void *hWnd, int nIndex)');
    const MonitorFromWindow = user32.func('void *MonitorFromWindow(void *hwnd, uint32 dwFlags)');
    const GetMonitorInfoW = user32.func('bool GetMonitorInfoW(void *hMonitor, _Inout_ MONITORINFO *lpmi)');
    const IsWindowVisible = user32.func('bool IsWindowVisible(void *hWnd)');
    const IsIconic = user32.func('bool IsIconic(void *hWnd)');
    // koffi 的回调必须先用 koffi.proto() 声明原型，再在签名里用 `Proto *`。
    // 直接在签名里写 `bool __stdcall(void*, intptr_t)` 会抛
    // "Unexpected character '(' in type specifier"，而这类异常会被下面的 catch 吞掉，
    // 表现为「功能莫名不生效」——排查时务必别让 catch 静默。
    const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(void *hwnd, intptr_t lParam)');
    const EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)');
    const OpenProcess = kernel32.func('void *OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)');
    const QueryFullProcessImageNameW = kernel32.func(
      'bool QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, _Out_ uint16 *lpExeName, _Inout_ uint32 *lpdwSize)',
    );
    const CloseHandle = kernel32.func('bool CloseHandle(void *hObject)');

    const MONITOR_DEFAULTTONEAREST = 2;
    const GWL_STYLE = -16;
    const WS_POPUP = 0x80000000;
    /** 可调整大小的厚边框：最大化窗口保留它，真全屏砍掉 */
    const WS_THICKFRAME = 0x00040000;
    /** 系统菜单（左上角图标菜单）：最大化窗口保留它，真全屏砍掉 */
    const WS_SYSMENU = 0x00080000;
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    /**
     * 「像真全屏吗」——用来把**最大化**窗口排除掉。
     *
     * 为什么不用 WS_POPUP：实测一个真·无边框全屏窗口（WinForms FormBorderStyle.None）
     * 的 style 是 0x16010000，**并不含 WS_POPUP**；而现代应用（微信等）普遍自绘标题栏，
     * 也都不含 WS_CAPTION。所以这两个"教科书判据"在真实环境里都不可靠。
     *
     * 可靠的差别在：**最大化窗口保留可调整边框与系统菜单，真全屏会把它们砍掉**。
     * 实测：无边框全屏 0x16010000 → 两者皆无 ✓；最大化窗口（如 Firefox 0x17cf0000）→ 两者皆有 ✗。
     */
    const looksFullscreen = (style) => {
      const popup = !!(style & WS_POPUP);
      const thickFrame = !!(style & WS_THICKFRAME);
      const sysMenu = !!(style & WS_SYSMENU);
      return popup || (!thickFrame && !sysMenu);
    };

    const winTitle = (hwnd) => {
      const buf = new Uint16Array(512);
      const n = GetWindowTextW(hwnd, buf, 512);
      return n > 0 ? Buffer.from(buf.buffer, 0, n * 2).toString('utf16le') : '';
    };
    const winPid = (hwnd) => {
      const out = [0];
      GetWindowThreadProcessId(hwnd, out);
      return out[0];
    };
    const procName = (pid) => {
      const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!h) return '';
      try {
        const buf = new Uint16Array(1024);
        const size = [1024];
        if (!QueryFullProcessImageNameW(h, 0, buf, size)) return '';
        const full = Buffer.from(buf.buffer, 0, size[0] * 2).toString('utf16le');
        return (full.split('\\').pop() || '').toLowerCase();
      } finally {
        CloseHandle(h);
      }
    };

    /** 不该因它而隐藏桌宠的进程：
     *  · explorer.exe / DSH 自己（桌面、任务栏、以及桌宠所在的 DSH）
     *  · 一串 Windows 系统 UI 宿主——它们的窗口尺寸常常正好是全屏，实测会误判。
     *    典型是 textinputhost.exe（输入体验/触摸键盘），探针里就被它骗过一次。 */
    const EXCLUDED_PROCS = new Set([
      'explorer.exe',
      'deepseek harness.exe',
      'dsh-desktop-host.exe',
      'textinputhost.exe',
      'startmenuexperiencehost.exe',
      'shellexperiencehost.exe',
      'searchhost.exe',
      'searchapp.exe',
      'lockapp.exe',
      'dwm.exe',
    ]);
    /** 无意义的系统窗口，直接跳过 */
    const EXCLUDED_TITLES = new Set(['Program Manager', 'Windows 默认锁屏界面', 'Default IME', 'MSCTFIME UI']);

    /** 单个窗口是否处于真全屏；是则返回 {title, proc, hwnd}，否则 null。
     *  判定 = ① 矩形覆盖整个显示器 ② 窗口样式「像真全屏」（排除最大化）。 */
    const inspectWindow = (hwnd) => {
      if (!hwnd) return null;
      if (IsIconic(hwnd) || !IsWindowVisible(hwnd)) return null;

      const pid = winPid(hwnd);
      if (!pid || pid === process.pid) return null;
      const proc = procName(pid);
      if (proc && EXCLUDED_PROCS.has(proc)) return null;

      const title = winTitle(hwnd);
      if (!title || EXCLUDED_TITLES.has(title)) return null;

      const rect = {};
      if (!GetWindowRect(hwnd, rect)) return null;
      const mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
      const mi = { cbSize: 40 };
      if (!GetMonitorInfoW(mon, mi)) return null;

      // 要盖住整个**显示器**（而不是工作区）：最大化只到工作区，真全屏才盖过任务栏那一条
      const covers =
        rect.left <= mi.rcMonitor.left &&
        rect.top <= mi.rcMonitor.top &&
        rect.right >= mi.rcMonitor.right &&
        rect.bottom >= mi.rcMonitor.bottom;
      if (!covers) return null;

      // 还要「像真全屏」：把最大化窗口排除掉（详见 looksFullscreen 的说明）
      const style = GetWindowLongW(hwnd, GWL_STYLE) >>> 0;
      return looksFullscreen(style) ? { title, proc, hwnd, kind: 'fullscreen' } : null;
    };

    /** 找全屏窗口。**先看前台**（最快也最准），找不到再扫一遍所有顶层可见窗口。
     *
     *  为什么要扫全部、而不只看前台：共享屏幕 / 放映 PPT 时那个全屏窗口未必在前台
     *  （你可能同时在看别的），此时只认前台就会漏判。而且实测发现，从脚本启动的全屏窗口
     *  **常常抢不到前台**（Windows 会拒绝后台进程的前台请求），只认前台会让这类场景永远失效。 */
    detectFullscreen = () => {
      const fg = inspectWindow(GetForegroundWindow());
      if (fg) return fg;

      let found = null;
      let cb;
      try {
        cb = koffi.register((hwnd) => {
          const r = inspectWindow(hwnd);
          if (r) {
            found = r;
            return false; // 找到一个就停
          }
          return true;
        }, koffi.pointer(EnumWindowsProc));
        EnumWindows(cb, 0);
      } catch {
        /* 回调注册/枚举失败就当没找到，不影响关键词那条途径 */
      } finally {
        if (cb) {
          try {
            koffi.unregister(cb);
          } catch {
            /* ignore */
          }
        }
      }
      return found;
    };
  } catch (e) {
    // koffi 缺失或加载失败：静默降级成「只做关键词匹配」，绝不让桌宠起不来
    console.error('[dsh-pet-autohide] 全屏检测不可用（koffi 加载失败）：' + (e && e.message ? e.message : String(e)));
  }
  const AUTOHIDE_OFF = { enabled: false, pollSec: 3, fullscreen: false, patterns: [], autoRestore: false };
  let autoHideCfg = AUTOHIDE_OFF;
  /** /config 的响应按**宠物 id 分组**（形如 {"main":{"pets":[...], ...全局段}}），
   *  而 autoHide 是全局段、会被并进每只宠物，所以取第一只的即可。 */
  const loadAutoHideCfg = async () => {
    try {
      const res = await fetch(AUTOHIDE_CONFIG_URL);
      const cfg = await res.json();
      const first = cfg && typeof cfg === 'object' ? cfg[Object.keys(cfg)[0]] : null;
      const a = first?.autoHide;
      if (!a || typeof a !== 'object') {
        autoHideCfg = AUTOHIDE_OFF;
        return;
      }
      autoHideCfg = {
        enabled: a.enabled === true,
        pollSec: Number(a.pollSec) > 0 ? Number(a.pollSec) : 3,
        fullscreen: a.fullscreen !== false, // 默认开：全屏检测是覆盖面最广的那条
        patterns: Array.isArray(a.windowTitlePatterns)
          ? a.windowTitlePatterns.filter((p) => typeof p === 'string' && p)
          : [],
        autoRestore: a.autoRestore === true, // 默认关＝保持「手动打开」，由用户在配置里决定
      };
    } catch {
      autoHideCfg = AUTOHIDE_OFF; // 拉不到就当没开：绝不能因为配置读不到就把桌宠乱藏
    }
    pushAutoHideCfg(); // 配置有变就同步给菜单（文案里的「开/关」要跟着变）
  };
  let autoHideHandled = false;
  /** 当前这次隐藏是不是「自动隐藏」造成的。只有它才归 autoRestore 管——
   *  用户手动「隐藏桌宠」时，绝不能被自动恢复逻辑擅自显示出来。 */
  let autoHiddenByUs = false;

  /** 把我们的显隐状态告诉 host，让它的 desktopVisible 与**实际**保持一致。
   *  为什么必须做：host 的 /hide、/show 会「值没变就跳过写 state」，而自动隐藏是 helper
   *  自己 win.hide() 的、host 并不知情（仍以为可见）。不同步的话，用户点「打开桌宠」
   *  恰好落在「值没变」那条路径上，state 永不更新 → 渲染端收不到指令 → **桌宠再也叫不回来**。
   *  （已实测踩到；host 那侧也顺手去掉了去重，但这段不依赖它，reload helper 即可生效。） */
  const notifyHostVisible = (visible) => {
    try {
      const url = AUTOHIDE_CONFIG_URL.replace(/\/config$/, visible ? '/show' : '/hide');
      void fetch(url, { method: 'POST' }).catch(() => {});
    } catch {
      /* 通知失败不影响隐藏本身 */
    }
  };

  /** 把当前 autoHide 配置推给所有渲染端——右键菜单要显示「全屏后自动显示桌宠：开/关」。
   *  菜单面板由 buildPanel 现搭，只认 label/children、没有勾选态，所以状态只能写进文案。 */
  const pushAutoHideCfg = () => {
    for (const win of windows.values()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send('pet:autohide-cfg', autoHideCfg);
      } catch {
        /* 窗口正在销毁就跳过 */
      }
    }
  };

  /** 把 autoRestore 落盘。
   *  优先走 host 的 /autohide（那边过 saveUserConfig 校验）；但该路由是本改造新加的，
   *  **要等 DSH 重启才存在**，旧 host 上会落到 thumb 兜底分支回 400，所以失败就自己写文件。
   *  自己写只动 autoHide.autoRestore 一个键、其余原样写回，风险可控。
   *  （不落盘的后果很具体：helper 每 30s 会重拉配置，改动会被覆盖回去，开关自己弹回。） */
  const persistAutoRestore = async (on) => {
    try {
      const res = await fetch(AUTOHIDE_CONFIG_URL.replace(/\/config$/, '/autohide'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoRestore: on }),
      });
      if (res.ok) return;
    } catch {
      /* 落到下面的回退路径 */
    }
    try {
      const meta = await (await fetch(AUTOHIDE_CONFIG_URL.replace(/\/config$/, '/config/meta'))).json();
      const userPath = meta?.user;
      if (!userPath) return;
      const raw = JSON.parse(readFileSync(userPath, 'utf8'));
      raw.autoHide = {
        ...raw.autoHide && typeof raw.autoHide === 'object' ? raw.autoHide : {},
        autoRestore: on,
      };
      writeFileSync(userPath, JSON.stringify(raw, null, 2), 'utf8');
    } catch (e) {
      console.error('[dsh-pet-autohide] autoRestore 落盘失败：' + (e && e.message ? e.message : String(e)));
    }
  };

  /** 右键菜单点了「全屏后自动显示桌宠」：**先改内存**（立即生效，不等配置往返），再落盘。 */
  ipcMain.on('pet:set-auto-restore', (event, on) => {
    const next = on === true;
    autoHideCfg = { ...autoHideCfg, autoRestore: next };
    autoHideHandled = false; // 让新开关立刻能重新判定一次
    pushAutoHideCfg();
    void persistAutoRestore(next);
    console.error(`[dsh-pet-autohide] autoRestore 已切换为 ${next}`);
  });

  /** 找一个「该躲开」的理由；没有就返回 null。
   *  两条来源：① 前台窗口全屏（广度优先）② 窗口标题关键词（补全屏之外的场景）。 */
  const findForbiddenWindow = async () => {
    if (autoHideCfg.fullscreen) {
      const fs = detectFullscreen();
      if (fs) return { title: fs.title, pattern: `全屏应用（${fs.proc || '未知'}）`, kind: 'fullscreen' };
    }
    if (!autoHideCfg.patterns.length) return null;
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    for (const s of sources) {
      const title = String(s.name ?? '');
      for (const p of autoHideCfg.patterns) if (title.includes(p)) return { title, pattern: p, kind: 'title' };
    }
    return null;
  };

  const autoHideTick = async () => {
    // ⚠️ enabled 必须在这里判，而不是"启动时是否注册了定时器"。
    // 定时器是无条件常驻的（见下方注册处），开关随时可能被用户改；
    // 第一版把判定放在注册前，结果是：关掉开关照样藏，之后再打开也永远不生效
    // （启动时若恰好是关的，定时器压根没注册，后面重拉了配置也没人跑 tick）。
    if (!autoHideCfg.enabled) {
      if (autoHiddenByUs) {
        // 开关被关掉的瞬间，把「是我们藏的」那一次收回来——用户关它就是要它别再躲
        autoHiddenByUs = false;
        autoHideHandled = false;
        setAllPetWindowsVisible(true);
        notifyHostVisible(true);
        ahLog('开关已关闭（enabled=false），收回自动隐藏');
      }
      return;
    }
    let hit = null;
    try {
      hit = await findForbiddenWindow();
    } catch (e) {
      ahLog(`枚举失败，跳过本轮：${e && e.message ? e.message : String(e)}`);
      return; // 枚举失败（权限/驱动异常）静默跳过这一轮，不要因此反复藏
    }
    if (!hit) {
      // 条件消失：复位闸门，下次再命中还能藏
      if (autoHideHandled && autoHiddenByUs && autoHideCfg.autoRestore) {
        setAllPetWindowsVisible(true); // 只有开了 autoRestore 才自动放回来
        autoHiddenByUs = false;
        notifyHostVisible(true);
        ahLog('条件结束，按 autoRestore 自动显示桌宠');
      }
      autoHideHandled = false;
      return;
    }
    if (autoHideHandled) return; // 本次命中已处理过（用户可能已手动打开，别再藏）
    autoHideHandled = true;
    setAllPetWindowsVisible(false);
    autoHiddenByUs = true;
    notifyHostVisible(false); // 同步给 host，否则「打开桌宠」会被去重掉、叫不回来
    ahLog(
      `命中隐藏：kind=${hit.kind} pattern=「${hit.pattern}」窗口=「${hit.title}」` +
        `（当时 enabled=${autoHideCfg.enabled} fullscreen=${autoHideCfg.fullscreen}）`,
    );
    console.error(`[dsh-pet-autohide] 命中「${hit.pattern}」（窗口：${hit.title}），已隐藏桌宠 ${windows.size} 个窗口`);
  };

  // 定时器**无条件常驻**，开关状态交给 autoHideTick 每轮自己判。
  // 第一版是"启动时若未启用就直接 return、连定时器都不注册"，导致：
  //   · 关掉开关后 tick 仍在跑（它当时不判 enabled）→ 照样藏；
  //   · 之后再打开开关也永远不生效（定时器从未注册）。
  // 用 1s 的细粒度心跳 + tick 内按 pollSec 限流，这样改 pollSec 也不必重建定时器。
  let autoHideLastRun = 0;
  const autoHideHeartbeat = () => {
    const now = Date.now();
    const interval = Math.max(1, Number(autoHideCfg.pollSec) || 3) * 1000;
    if (now - autoHideLastRun < interval) return;
    autoHideLastRun = now;
    void autoHideTick();
  };

  /** 轻量同步开关：每 3s 只读 /autohide（响应很小），拿到 enabled/fullscreen/autoRestore。
   *  为什么要单独做一条快通道：整份 /config 重拉是 30s 一次、响应几十 KB，
   *  用户在菜单里点完开关如果马上去共享，30s 内 helper 用的还是**旧开关值**——
   *  表现就是"明明关了还是躲"。关键词那类不常改的东西仍走 30s 的 /config。 */
  const syncAutoHideSwitches = async () => {
    try {
      const res = await fetch(AUTOHIDE_CONFIG_URL.replace(/\/config$/, '/autohide'));
      if (!res.ok) return;
      const a = await res.json();
      const next = {
        ...autoHideCfg,
        enabled: a.enabled === true,
        fullscreen: a.fullscreen !== false,
        autoRestore: a.autoRestore === true,
      };
      const changed =
        next.enabled !== autoHideCfg.enabled ||
        next.fullscreen !== autoHideCfg.fullscreen ||
        next.autoRestore !== autoHideCfg.autoRestore;
      autoHideCfg = next;
      if (changed) {
        ahLog(`开关已同步：enabled=${next.enabled} fullscreen=${next.fullscreen} autoRestore=${next.autoRestore}`);
        pushAutoHideCfg();
      }
    } catch {
      /* 拉不到就保持现状 */
    }
  };

  void loadAutoHideCfg().then(() => {
    setInterval(autoHideHeartbeat, 1000);
    setInterval(() => void syncAutoHideSwitches(), 3 * 1000);
    // 整份配置（含关键词）仍 30s 重拉一次
    setInterval(() => void loadAutoHideCfg(), 30 * 1000);
    ahLog(
      `检测常驻启动：enabled=${autoHideCfg.enabled}，每 ${autoHideCfg.pollSec}s 检查一次，` +
        `全屏检测=${autoHideCfg.fullscreen ? '开' : '关'}，autoRestore=${autoHideCfg.autoRestore ? '开' : '关'}，` +
        `关键词 ${JSON.stringify(autoHideCfg.patterns)}`,
    );
  });

  // 宠物窗口跟随：renderer 逐帧上报窗口内容区位置/尺寸
  ipcMain.on('pet:set-bounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const x = Number(bounds?.x);
    const y = Number(bounds?.y);
    const width = Number(bounds?.width);
    const height = Number(bounds?.height);
    if (![x, y, width, height].every(Number.isFinite)) return;
    // 去重必须比较**我们上一次请求的值**，绝不能拿 win.getContentBounds() 回读值来比：
    // 跨缩放屏的 DIP↔物理 往返有 ScaleToEnclosingRect（向外取整）与 origin 舍入，
    // 读回值与设定值永远不相等，去重永远不生效，反而变成每帧强制重设窗口位置。
    const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    const key = rect.x + ',' + rect.y + ',' + rect.width + ',' + rect.height;
    if (lastRequestedBounds.get(win.id) !== key) {
      lastRequestedBounds.set(win.id, key);
      win.setContentBounds(rect, false);
    }
    // 碰撞站场：位置必须用**包围盒左上角**（renderer 显式上报 boxX/boxY）——
    // 窗口坐标 = 包围盒 − margin（半只宠物宽），直接拿窗口坐标会让跨窗检测整体错位
    const petId = [...windows.keys()].find((id) => windows.get(id) === win);
    if (petId) {
      const bx = Number(bounds?.boxX);
      const by = Number(bounds?.boxY);
      const size = Number(bounds?.size);
      const bottomPad = Number(bounds?.bottomPad);
      const vx = Number(bounds?.vx);
      const vy = Number(bounds?.vy);
      // 位置 + 尺寸 + 速度一并登记：set-bounds 是每次位置变化都会触发的全量上报
      // （此前只更新 x/y，静止宠物 size 永远为 0，跨窗碰撞检测 `!o.size` 直接跳过它）；
      // 速度取渲染端上报值（飞行中实时、静止/拖拽 = 0），落地后不再残留旧飞行速度。
      updatePetState(petId, {
        x: Number.isFinite(bx) ? bx : x,
        y: Number.isFinite(by) ? by : y,
        size: Number.isFinite(size) && size > 0 ? size : petStates.get(petId)?.size || 0,
        bottomPad: Number.isFinite(bottomPad) && bottomPad > 0 ? bottomPad : petStates.get(petId)?.bottomPad || 0,
        vx: Number.isFinite(vx) ? vx : 0,
        vy: Number.isFinite(vy) ? vy : 0,
      });
    }
  });

  // 飞行状态上报（碰撞站场）：renderer 飞行中每 ~30ms 上报一次自己的位置/速度/尺寸
  ipcMain.on('pet:report-flight', (event, state) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const petId = [...windows.keys()].find((id) => windows.get(id) === win);
    if (!petId) return;
    const s = state || {};
    const x = Number(s.x);
    const y = Number(s.y);
    const vx = Number(s.vx);
    const vy = Number(s.vy);
    const size = Number(s.size);
    const bottomPad = Number(s.bottomPad);
    if (![x, y, vx, vy, size, bottomPad].every(Number.isFinite)) return;
    updatePetState(petId, { x, y, vx, vy, size, bottomPad });
  });

  // 碰撞结果转发：飞行方窗口检测到撞到 targetId → 把动量结果（目标新初速）转发给目标窗口
  ipcMain.on('pet:collide-result', (event, payload) => {
    const targetId = payload && typeof payload === 'object' ? String(payload.targetId || '') : '';
    const vx = Number(payload?.vx);
    const vy = Number(payload?.vy);
    if (!targetId || !Number.isFinite(vx) || !Number.isFinite(vy)) return;
    const targetWin = windows.get(targetId);
    if (targetWin && !targetWin.isDestroyed()) {
      targetWin.webContents.send('pet:hit', { vx, vy });
    }
  });

  // 点击穿透翻转：renderer 在光标进/出身体命中区时上报；穿透期间仍保留 forward（mousemove 继续转发）。
  // 兜底轮询（见 createPetWindows）也走同一个出口 setWindowIgnore，两条通道共享同一份镜像状态。
  ipcMain.on('pet:set-interactive', (event, interactive) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    setWindowIgnore(win, !interactive);
  });

  // 渲染端正拿着鼠标输入（拖拽中 / 菜单开着 / 对话弹窗开着）：兜底轮询据此绝不翻回穿透。
  // 只存标记、不直接翻转窗口——**唯一出口**仍是 setWindowIgnore（在兜底轮询里按完整规则判定），
  // 否则会出现"两条通道抢着翻同一个窗口"的竞态。
  ipcMain.on('pet:input-busy', (event, busy) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    inputBusy.set(win.id, !!busy);
  });

  // 右键菜单「打开Harness」：唤起 DSH 桌面端并聚焦其主窗口。
  // 走 dsh:// 协议（桌面端启动时 setAsDefaultProtocolClient("dsh") 注册，指向 DeepSeek Harness.exe）：
  //   桌面端已在运行 → 新实例拿不到单实例锁，立即 quit；主实例收到 second-instance →
  //     focusPrimaryWindow()（restore + show + focus，窗口已销毁则重建）；
  //   桌面端未运行 → 正常启动它。
  // 用协议而不是硬编码 exe 路径：安装目录/盘符变化都不用改这里。
  ipcMain.on('pet:open-harness', () => {
    shell.openExternal('dsh://open').catch((error) => {
      console.error('[dsh-pet-desktop-helper] open harness failed:', error);
    });
  });

  // 桌面可见性（host 的 /hide、/show → /state 轮询 → 渲染端 → 这里）：对每只宠物窗口 hide/show。
  // **只隐藏窗口，不退出 helper**：渲染进程要继续轮询 /state，否则收不到"显示"指令，
  // 桌宠会永久失联（与 host-liveness 那套"宿主没了才退出"是两回事，别混）。
  ipcMain.on('pet:set-desktop-hidden', (event, hidden) => {
    setAllPetWindowsVisible(!hidden);
  });

  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转都会让桌面几何失效。原先几何只在
  // createPetWindows() 算一次并经 URL query 注入，渲染端 VIEW 是模块顶层常量，运行期永不更新——
  // 表现为「改了分辨率后可移动范围还是旧的」。这里重算并推给所有窗口，渲染端就地重挂。
  let displaysTimer = null;
  const pushDisplays = () => {
    const geo = deskGeometry();
    lastRequestedBounds.clear(); // 坐标系变了，去重缓存作废，下一帧必须真的重设一次
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('pet:displays', geo);
    }
    console.error('[dsh-pet-desktop-helper] displays changed: ' + JSON.stringify(geo));
    // 主屏缩放可能一起变了（它决定宠物的尺寸补偿）。线性化生效期间 screen API 只报被强制的值，
    // 真实值只能靠探测子进程拿；不一致就刷新缓存，下次启动自动用上。
    if (FORCED_SCALE > 0) {
      setTimeout(() => {
        const real = probePrimaryScale();
        if (real > 0 && Math.abs(real - PRIMARY_SCALE) > 1e-6) {
          console.error(
            '[dsh-pet-desktop-helper] primary scaleFactor changed ' +
              PRIMARY_SCALE +
              ' -> ' +
              real +
              '; restart the desktop pet to resize',
          );
        }
      }, 1000).unref?.();
    }
  };
  /** 显示器事件会连发（一次改动能来好几条），去抖后只重算一次 */
  const scheduleDisplays = () => {
    if (displaysTimer) clearTimeout(displaysTimer);
    displaysTimer = setTimeout(() => {
      displaysTimer = null;
      pushDisplays();
    }, 300);
  };
  screen.on('display-metrics-changed', scheduleDisplays);
  screen.on('display-added', scheduleDisplays);
  screen.on('display-removed', scheduleDisplays);

  // 冒烟自检模式（默认关闭）：DSH_PET_SMOKE=1 时延时截图到 DSH_PET_SMOKE_OUT 后退出，
  // 用于验证窗口/渲染/动画链路（如 CI 或本地验证）。
  if (process.env.DSH_PET_SMOKE === '1') {
    const smokeOut = process.env.DSH_PET_SMOKE_OUT || path.join(app.getPath('temp'), 'dsh-pet-smoke.png');
    const afterMs = Number(process.env.DSH_PET_SMOKE_AFTER_MS || 9000);
    const target = windows.values().next().value;
    if (target) {
      // 转发渲染端 console（定位动画/余额/错误问题）
      target.webContents.on('console-message', (event) => {
        console.log(`[renderer:${event.level}] ${event.message}`);
      });
    }
    setTimeout(async () => {
      try {
        const first = windows.values().next().value;
        if (first && !first.isDestroyed()) {
          const dump = await first.webContents.executeJavaScript(`(async () => ({
            hasBridge: typeof window.petBridge !== 'undefined',
            hasSetInteractive: typeof window.petBridge?.setInteractive === 'function',
            viewport: window.innerWidth + 'x' + window.innerHeight,
            dpr: window.devicePixelRatio,
            debug: window.__dshPetDebug || null,
            sprites: document.querySelectorAll('.pet-sprite').length,
            errorVisible: document.getElementById('pet-error').classList.contains('visible'),
            errorText: document.getElementById('pet-error').textContent,
            firstBubble: (document.querySelector('.pet-bubble.is-on') || { textContent: '' }).textContent.slice(0, 120),
            hitCursor: (function () {
              var hit = document.querySelector('.pet-hit');
              return hit ? getComputedStyle(hit).cursor : '';
            })(),
            dragTransform: (function () {
              var hit = document.querySelector('.pet-hit');
              var stage = document.querySelector('.pet-stage');
              if (!hit || !stage) return 'no-sprite';
              var out = { idle: stage.style.transform };
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
              out.duringClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
              out.afterClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 200, screenX: 200, screenY: 200, pointerId: 92 }));
              hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
              out.duringDrag = stage.style.transform;
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
              out.afterDrag = stage.style.transform;
              return out;
            })(),
            releaseKeptPosition: await (async function () {
              // 独立不变量：把宠物先拖到工作区内的固定安全点（600,300），松手后窗口位置必须原地不动。
              // 拖拽抛掷物理（弹簧跟手+甩抛）下：指针长距跳跃后弹簧需要 ~0.3s 收敛，
              // 松手前停留超过 RELEASE_STALE_MS(150ms) 判为「温柔放下」（估速 null，不抛掷）——
              // 所以先等弹簧到位、再停留才松手，只测"释放瞬间是否位移"。
              var d = window.__dshPetDebug;
              var hit = document.querySelector('.pet-hit');
              if (!d || !d.dragPos || !hit) return null;
              var P = { x: d.dragPos.x, y: d.dragPos.y };
              var T = { x: 600, y: 300 }; // 目标窗口左上角（1708×1020 工作区内，远离四边）
              var upX = 1000 + (T.x - P.x);
              var upY = 600 + (T.y - P.y);
              var sleep = function (ms) {
                return new Promise(function (r) {
                  setTimeout(r, ms);
                });
              };
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1000, clientY: 600, screenX: 1000, screenY: 600, pointerId: 93 }));
              hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
              await sleep(400); // 弹簧跟随收敛
              var during = { x: d.dragPos.x, y: d.dragPos.y };
              await sleep(200); // 轨迹过期 → 估速 null → 温柔放下（不抛掷）
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
              await sleep(80); // 释放处理完成
              var released = d.lastDragRelease ? { x: d.lastDragRelease.x, y: d.lastDragRelease.y } : null;
              return {
                during: during,
                released: released,
                kept: !!(released && Math.abs(released.x - during.x) <= 1 && Math.abs(released.y - during.y) <= 1),
              };
            })(),
            interactiveFlip: (function () {
              // 点击穿透命中判定：光标在命中区内→可交互；移出→穿透；拖拽中（pointer 已捕获）→强制可交互。
              // hitRect 是 sprite 坐标，mousemove 用窗口坐标——测试事件需加上窗口外扩余量 winMargin。
              var d = window.__dshPetDebug;
              var hit = document.querySelector('.pet-hit');
              if (!d || !d.hitRect || !d.winMargin || !hit) return null;
              var r = d.hitRect;
              var m = d.winMargin;
              var xIn = m.l + r.x + r.w / 2;
              var yIn = m.t + r.y + r.h / 2;
              var xOut = Math.max(0, m.l + r.x - 20);
              var yOut = Math.max(0, m.t + r.y - 20);
              var out = {};
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn }));
              out.inside = d.interactive === true;
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
              out.outside = d.interactive === false;
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn, pointerId: 94 }));
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
              out.duringDragForced = d.interactive === true;
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut, pointerId: 94 }));
              return out;
            })(),
            videoSrcA: (document.querySelectorAll('.pet-sprite video')[0] || { src: '' }).src,
            videoSrcB: (document.querySelectorAll('.pet-sprite video')[1] || { src: '' }).src,
            // 右键菜单自检：在命中区派发 contextmenu → 校验菜单挂载/根文案/子面板/运行错误
            menuSmoke: await (async function () {
              // 前面 drag/release/interactive 测试刚拖过宠：justDragged 100ms 内屏蔽右键，
              // 真实用户不会拖完立刻右键——先等 250ms 消除该时序影响
              await new Promise(function (resolve) {
                setTimeout(resolve, 250);
              });
              var hit = document.querySelector('.pet-hit');
              var d = window.__dshPetDebug;
              if (!hit || !d) return null;
              var errsBefore = (d.errors || []).length;
              try {
                hit.dispatchEvent(
                  new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 400, clientY: 260, screenX: 400, screenY: 260 }),
                );
              } catch (err) {
                return { threw: String(err), menuMounted: false };
              }
              var menu = document.querySelector('.dsh-pet-menu');
              var out = {
                threw: null,
                menuMounted: !!menu,
                menuOpen: d.menuOpen === true,
                rootText: menu ? menu.textContent.slice(0, 60) : '',
                errsNew: (d.errors || []).length - errsBefore,
              };
              if (menu) {
                var branch = menu.querySelector('.dsh-pet-menu-branch');
                if (branch) {
                  branch.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: menu }));
                  var panels = Array.prototype.slice.call(
                    menu.querySelectorAll('.dsh-pet-menu-column'),
                  );
                  var visible = function () {
                    return panels.filter(function (p) {
                      return p.style.display !== 'none';
                    });
                  };
                  out.panelCount = panels.length;
                  out.lvl2AfterHoverRoot = visible().length;
                  // 二级：悬停「动作」下的第一个分类 → 打开三级面板（具体动画）
                  var panel1 = visible().filter(function (p) {
                    return p !== panels[0];
                  })[0];
                  if (panel1) {
                    var cat = panel1.querySelector('.dsh-pet-menu-branch');
                    if (cat) {
                      cat.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: panel1 }));
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 50);
                      });
                      out.lvl3AfterHoverCat = visible().length;
                      // 重放用户路径：鼠标从分类项移向三级面板（先离开分类项进入 4px 缝隙，
                      // 再进入三级面板）——缝隙里 mouseleave 会排 160ms 关闭定时器
                      cat.dispatchEvent(
                        new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                      );
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 60);
                      });
                      var panel2 = visible()[visible().length - 1];
                      if (panel2) {
                        panel2.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
                      }
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 220);
                      });
                      out.lvl3SurvivedAfterReenter = visible().length;
                      // 极端情况：缝隙停留超过关闭延时（鼠标犹豫）
                      cat.dispatchEvent(
                        new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                      );
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 260);
                      });
                      out.lvl3AfterGapHover = visible().length;
                    }
                  }
                }
              }
              return out;
            })(),
          }))()`);
          console.log(
            '[dsh-pet-desktop-helper] smoke dump: windows=' +
              windows.size +
              ' ids=' +
              JSON.stringify([...windows.keys()]) +
              ' => ' +
              JSON.stringify(dump),
          );
          console.log('[dsh-pet-desktop-helper] smoke bounds:', JSON.stringify(first.getContentBounds()));
          // 点击穿透 round-trip：setInteractive(true)→窗口捕获输入（忽略鼠标=false）；
          // setInteractive(false)→恢复整窗穿透（忽略鼠标=true）。状态取自主进程镜像 windowIgnore。
          // 期间暂停兜底轮询：它按真实光标位置翻转，冒烟时鼠标不在宠物身上会覆盖本断言的状态。
          pointerFallbackPaused = true;
          await first.webContents.executeJavaScript('window.petBridge.setInteractive(true); true;');
          await new Promise((r) => setTimeout(r, 80));
          const interactiveIgnoring = windowIgnore.get(first.id);
          await first.webContents.executeJavaScript('window.petBridge.setInteractive(false); true;');
          await new Promise((r) => setTimeout(r, 80));
          const passthroughIgnoring = windowIgnore.get(first.id);
          pointerFallbackPaused = false;
          console.log(
            '[dsh-pet-desktop-helper] smoke interactive round-trip:',
            JSON.stringify({ interactiveIgnoring, passthroughIgnoring }),
          );
          const image = await first.webContents.capturePage();
          writeFileSync(smokeOut, image.toPNG());
          console.log('[dsh-pet-desktop-helper] smoke capture:', smokeOut);
        }
      } catch (error) {
        console.error('[dsh-pet-desktop-helper] smoke capture failed:', error);
      }
      setTimeout(() => app.quit(), 500);
    }, afterMs);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
