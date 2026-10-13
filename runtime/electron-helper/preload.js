// preload 桥：只暴露窗口控制原语——
//   - setBounds：宠物窗口逐帧跟随（renderer 上报包围盒的屏幕坐标，主进程 setContentBounds）。
//     x/y/width/height = 窗口内容区坐标（用于移动窗口）；boxX/boxY = 宠物包围盒左上角
//     （工作区坐标）——碰撞站场必须用包围盒坐标，不能用窗口坐标（窗口 = 包围盒 + 四周外扩 margin，
//     差半只宠物宽，会让跨窗碰撞检测整体错位）。
//     size/bottomPad = 碰撞站场登记用（静止宠物只发 set-bounds，靠它带上尺寸才能被其它
//     飞行宠物撞到）；vx/vy = 当前速度（飞行中实时值，静止/拖拽 = 0）。
//   - setInteractive：点击穿透翻转——窗口默认整窗穿透（透明像素不挡下层应用），
//     renderer 在光标进/出宠物身体命中区时上报，主进程 setIgnoreMouseEvents 翻转。
//   - setInputBusy：**我正在用这个窗口的鼠标输入**（拖拽中 / 菜单开着 / 对话弹窗开着），
//     由渲染端上报。主进程光看光标位置与窗口位移分不清"拖拽跟手"和"漫游/抛掷"，而渲染端知道。
//     busy 期间主进程的兜底通道**绝不翻回穿透**（一旦翻回，渲染端正在用的 window 级
//     pointermove/pointerup 就断了：宠物会按旧速度飞出去，连松手的 pointerup 都收不到）。
//     只在状态翻转时发一次（幂等，不逐帧）。
//   - 宠物间碰撞（跨窗，主进程 broker）：
//       reportFlight：飞行中每 ~30ms 上报自己的状态（位置/速度/尺寸）→ 主进程汇聚并广播；
//       onFlightStates：订阅主进程广播的全量宠物状态（碰撞检测用其它宠物的最新位置/速度）；
//       reportCollide：本窗飞行方检测到撞到 targetId → 主进程把动量结果转发给目标窗；
//       onPetHit：订阅「你被撞了」→ 用新初速 startThrow 抛出去（与浏览器 onHit 同语义）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petBridge', {
  setBounds(x, y, width, height, boxX, boxY, size, bottomPad, vx, vy) {
    ipcRenderer.send('pet:set-bounds', { x, y, width, height, boxX, boxY, size, bottomPad, vx, vy });
  },
  setInteractive(interactive) {
    ipcRenderer.send('pet:set-interactive', !!interactive);
  },
  // 我正在用这个窗口的鼠标输入（拖拽中/菜单开/弹窗开）：主进程兜底通道在 busy 期间绝不翻回穿透
  setInputBusy(busy) {
    ipcRenderer.send('pet:input-busy', !!busy);
  },
  // 右键菜单「打开Harness」：主进程唤起 DSH 桌面端并聚焦其主窗口（dsh:// 协议）
  openHarness() {
    ipcRenderer.send('pet:open-harness');
  },
  // 桌面可见性（右键「隐藏桌宠」/ 标题栏「工具」菜单）：主进程 hide/show 全部宠物窗口
  setDesktopHidden(hidden) {
    ipcRenderer.send('pet:set-desktop-hidden', !!hidden);
  },
  // ---- 宠物间碰撞（跨窗 broker）----
  reportFlight(state) {
    ipcRenderer.send('pet:report-flight', state);
  },
  onFlightStates(cb) {
    ipcRenderer.on('pet:flight-states', (e, states) => cb(states));
  },
  reportCollide(targetId, vx, vy) {
    ipcRenderer.send('pet:collide-result', { targetId, vx, vy });
  },
  onPetHit(cb) {
    ipcRenderer.on('pet:hit', (e, payload) => cb(payload));
  },
  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转后主进程重算桌面几何并推来
  // （{hull, areas, primaryIndex}，屏幕坐标）——渲染端就地重挂视口与边界。
  onDisplays(cb) {
    ipcRenderer.on('pet:displays', (e, geo) => cb(geo));
  },
  // 自动隐藏配置（主进程拉到后推来）：右键菜单要显示「全屏后自动显示桌宠：开/关」的当前状态。
  // 菜单项本身不支持勾选态（buildPanel 只认 label/children），所以状态写进文案里。
  onAutoHideCfg(cb) {
    ipcRenderer.on('pet:autohide-cfg', (e, cfg) => cb(cfg));
  },
  // 右键菜单切换「全屏后自动显示」：先由主进程即时改内存（马上生效），再由它转存到配置。
  setAutoRestore(on) {
    ipcRenderer.send('pet:set-auto-restore', !!on);
  },
});
