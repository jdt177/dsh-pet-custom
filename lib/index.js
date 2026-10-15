import { copyFileSync, createReadStream, existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { BlockAssembler, ReasoningEffortId, createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { downloadArtifact } from "@electron/get";
import extract from "@electron-internal/extract-zip";

//#region src/host/balance/internal.ts
/**
* 余额查询的**内部工具**（host 侧）：网络策略 + 响应校验 + 金额处理。
*
* 只给 ./providers/* 用。所有服务商共用同一套口径：
* - 网络：20s 超时 + 3 次重试（实测该环境对境外端点间歇性超时）；
* - 校验：必填字段缺失/非法一律 `throw`，**绝不静默当 0**（失败要显式暴露成 fetch-error）；
* - 可选字段：缺失就是缺失（`undefined`），不补默认值。
*/
/** 抓取超时（ms） */
const FETCH_TIMEOUT_MS = 2e4;
/** 单次抓取失败后的重试次数（失败间隔 0.8s 线性退避） */
const RETRIES = 3;
/** fetch 一次，带超时；失败抛错（调用方决定是否重试） */
async function fetchOnce(url, key) {
	return fetch(url, {
		headers: {
			Authorization: "Bearer " + key,
			"User-Agent": "dsh-pet-balance"
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
}
async function fetchWithRetry(url, key) {
	let last;
	for (let i = 0; i <= RETRIES; i++) try {
		return await fetchOnce(url, key);
	} catch (e) {
		last = e;
		if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
	}
	throw last instanceof Error ? last : new Error(String(last));
}
function num(value, what) {
	const n = Number(value);
	if (!Number.isFinite(n)) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return n;
}
function str(value, what) {
	if (typeof value !== "string" || value.length === 0) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return value;
}
function looseNum(value) {
	if (value === void 0 || value === null || value === "") return void 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : void 0;
}
function obj(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/**
* 重置时间：字符串原样（ISO 8601）；数字时间戳按秒/毫秒自动识别转 ISO；0 / 负数 / 非法 → undefined。
* 真实报文里空闲窗口是 `resetAt: 0`（占位值，不是 1970 年重置）→ 视为「无重置时间」。
*/
function resetTime(value) {
	if (typeof value === "string") return value.length > 0 ? value : void 0;
	const n = looseNum(value);
	if (n === void 0 || n <= 0) return void 0;
	const ms = n < 1e12 ? n * 1e3 : n;
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? void 0 : d.toISOString();
}
function readWindow(value) {
	const w = obj(value);
	if (!w) return void 0;
	const used = looseNum(w.used);
	const cap = looseNum(w.cap);
	if (used === void 0 || cap === void 0 || cap <= 0) return void 0;
	return {
		percent: Math.max(0, used / cap * 100),
		capUsd: cap,
		resetsAt: resetTime(w.resetAt)
	};
}
function queryString(params) {
	const pairs = Object.entries(params).filter(([, v]) => v !== void 0);
	return pairs.length > 0 ? "?" + pairs.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&") : "";
}
function money(value, what) {
	const raw = str(value, what);
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new Error("dsh-pet: 账号余额金额非法 " + what);
	return n.toFixed(2);
}
function sumMoney(a, b) {
	return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
}

//#endregion
//#region src/host/balance/providers/commandcode.ts
/** 控制面基址（`/alpha/*` 固定在根域名） */
const API_BASE = "https://api.commandcode.ai";
/** 滚动窗时长（展示名）：本服务商的 5h 窗口就是 `windowLimits.fiveHour` */
const ROLLING_LABEL$1 = "5h";
/** 抓一次 JSON（GET + Bearer），HTTP 非 2xx 抛错；`label` 是接口路径，只进错误信息（便于自查哪一个失败） */
async function fetchJson(url, key, label) {
	const res = await fetchWithRetry(url, key);
	if (!res.ok) throw new Error("commandcode " + label + " HTTP " + res.status);
	return await res.json();
}
function parseCommandCode(creditsBody, subscriptionBody, summaryBody, provider) {
	const root = obj(creditsBody);
	const credits = obj(root?.credits);
	if (!credits) throw new Error("dsh-pet: commandcode 响应缺少 credits");
	const creditFields = [
		credits.monthlyCredits,
		credits.purchasedCredits,
		credits.freeCredits
	];
	if (creditFields.every((v) => looseNum(v) === void 0)) throw new Error("dsh-pet: commandcode credits 响应缺少额度字段");
	const remaining = creditFields.reduce((sum, v) => sum + Math.max(0, looseNum(v) ?? 0), 0);
	const summary = obj(summaryBody);
	const spentRaw = summary?.totalCost;
	if (spentRaw === void 0 || spentRaw === null) throw new Error("dsh-pet: commandcode usage 响应缺少 totalCost");
	const spent = Math.max(0, num(spentRaw, "totalCost"));
	const pool = spent + remaining;
	const data = { monthly: pool > 0 ? spent / pool * 100 : 0 };
	if (pool > 0) data.monthlyCapUsd = pool;
	const subscription = obj(obj(subscriptionBody)?.data);
	const periodEnd = subscription?.currentPeriodEnd;
	if (typeof periodEnd === "string" && periodEnd.length > 0) data.monthlyResetsAt = periodEnd;
	const limits = obj(root?.windowLimits) ?? obj(credits.windowLimits);
	if (limits?.limited === true) {
		const fiveHour = readWindow(limits.fiveHour);
		if (fiveHour) {
			data.rolling = fiveHour.percent;
			data.rollingCapUsd = fiveHour.capUsd;
			data.rollingLabel = ROLLING_LABEL$1;
			if (fiveHour.resetsAt) data.rollingResetsAt = fiveHour.resetsAt;
		}
		const weekly = readWindow(limits.weekly);
		if (weekly) {
			data.weekly = weekly.percent;
			data.weeklyCapUsd = weekly.capUsd;
			if (weekly.resetsAt) data.weeklyResetsAt = weekly.resetsAt;
		}
	}
	return {
		ok: true,
		provider,
		shape: "windows",
		data
	};
}
const commandCode = {
	ids: ["commandcode"],
	credential: {
		mode: "ref",
		ref: "COMMANDCODE_API_KEY"
	},
	async fetch({ key, provider }) {
		const whoami = obj(await fetchJson(API_BASE + "/alpha/whoami" + queryString({ limits: "1" }), key, "/alpha/whoami"));
		const org = obj(whoami?.org);
		const orgId = typeof org?.id === "string" && org.id.length > 0 ? org.id : void 0;
		const credits = await fetchJson(API_BASE + "/alpha/billing/credits" + queryString({ orgId }), key, "/alpha/billing/credits");
		let subscription;
		try {
			subscription = await fetchJson(API_BASE + "/alpha/billing/subscriptions" + queryString({ orgId }), key, "/alpha/billing/subscriptions");
		} catch {
			subscription = void 0;
		}
		const periodStart = obj(obj(subscription)?.data)?.currentPeriodStart;
		const summary = await fetchJson(API_BASE + "/alpha/usage/summary" + queryString({
			since: typeof periodStart === "string" ? periodStart : void 0,
			orgId
		}), key, "/alpha/usage/summary");
		return parseCommandCode(credits, subscription, summary, provider);
	}
};

//#endregion
//#region src/host/balance/deepseek-common.ts
const DEEPSEEK_FULL_BALANCE = "20";
function deepseekPricingTier(now = new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		weekday: "short",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(now);
	const pick = (type) => parts.find((p) => p.type === type)?.value;
	const weekday = pick("weekday");
	const hour = Number(pick("hour"));
	if (weekday === "Sat" || weekday === "Sun") return "idle";
	return hour >= 9 && hour < 12 || hour >= 14 && hour < 18 ? "peak" : "idle";
}

//#endregion
//#region src/host/balance/providers/deepseek-account.ts
function parseAccountBalance(snapshot, provider) {
	if (!snapshot) throw new Error("dsh-pet: 账号未登录（deepseek-account）");
	if (snapshot.status !== "ready") throw new Error("dsh-pet: 账号余额查询失败");
	const wallets = Array.isArray(snapshot.value) ? snapshot.value : [];
	if (wallets.length === 0) throw new Error("dsh-pet: 账号没有充值钱包余额");
	const first = obj(wallets[0]);
	if (!first) throw new Error("dsh-pet: 账号钱包结构非法");
	const currency = typeof first.currency === "string" && first.currency.length > 0 ? first.currency : "CNY";
	const toppedUp = money(first.balance, "balance");
	const bonus = (Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : []).map((w) => obj(w)).find((w) => w !== void 0 && w.currency === currency);
	const granted = bonus ? money(bonus.balance, "bonus balance") : "0.00";
	return {
		ok: true,
		provider,
		shape: "money",
		data: {
			currency,
			total: sumMoney(granted, toppedUp),
			granted,
			toppedUp,
			fullBalance: DEEPSEEK_FULL_BALANCE,
			tier: deepseekPricingTier()
		}
	};
}
const deepseekAccount = {
	ids: ["deepseek-account"],
	credential: { mode: "none" },
	async fetch({ provider, resolveAccount }) {
		if (!resolveAccount) throw new Error("dsh-pet: 缺少账号服务（" + provider + "）");
		return parseAccountBalance(await resolveAccount(), provider);
	}
};

//#endregion
//#region src/host/balance/providers/deepseek-official.ts
const deepseekOfficial = {
	ids: ["deepseek-official"],
	credential: {
		mode: "ref",
		ref: "DEEPSEEK_API_KEY"
	},
	async fetch({ key, provider }) {
		const res = await fetchWithRetry("https://api.deepseek.com/user/balance", key);
		if (!res.ok) throw new Error("deepseek balance HTTP " + res.status);
		const body = await res.json();
		const infos = body?.balance_infos;
		if (!Array.isArray(infos) || infos.length === 0) throw new Error("dsh-pet: deepseek balance 响应缺少 balance_infos");
		const first = infos[0];
		return {
			ok: true,
			provider,
			shape: "money",
			data: {
				currency: str(first.currency, "currency"),
				total: str(first.total_balance, "total_balance"),
				granted: str(first.granted_balance, "granted_balance"),
				toppedUp: str(first.topped_up_balance, "topped_up_balance"),
				fullBalance: DEEPSEEK_FULL_BALANCE,
				tier: deepseekPricingTier()
			}
		};
	}
};

//#endregion
//#region src/host/balance/providers/opencode-go.ts
/** 各窗口满额度金额（USD）。业务常量：12 = 5h（5 小时滚动窗口）、30 = 周、60 = 月 */
const QUOTA_USD = {
	rolling: 12,
	weekly: 30,
	monthly: 60
};
/** 滚动窗时长（展示名）：本服务商是 5 小时 */
const ROLLING_LABEL = "5h";
const opencodeGo = {
	ids: ["opencode-go"],
	credential: {
		mode: "ref",
		ref: "OPENCODE_GO_API_KEY"
	},
	async fetch({ key, provider }) {
		const res = await fetchWithRetry("https://opencode.ai/zen/go/v1/usage", key);
		if (!res.ok) throw new Error("opencode usage HTTP " + res.status);
		const body = await res.json();
		const usage = body?.usage;
		if (!usage || typeof usage !== "object") throw new Error("dsh-pet: opencode usage 响应缺少 usage");
		const u = usage;
		const rolling = u.rolling, weekly = u.weekly, monthly = u.monthly;
		if (!rolling || !weekly || !monthly) throw new Error("dsh-pet: opencode usage 响应缺少窗口");
		return {
			ok: true,
			provider,
			shape: "windows",
			data: {
				rolling: num(rolling.percent, "rolling.percent"),
				weekly: num(weekly.percent, "weekly.percent"),
				monthly: num(monthly.percent, "monthly.percent"),
				rollingCapUsd: QUOTA_USD.rolling,
				weeklyCapUsd: QUOTA_USD.weekly,
				monthlyCapUsd: QUOTA_USD.monthly,
				rollingLabel: ROLLING_LABEL,
				rollingResetsAt: str(rolling.resetsAt, "rolling.resetsAt"),
				weeklyResetsAt: str(weekly.resetsAt, "weekly.resetsAt"),
				monthlyResetsAt: str(monthly.resetsAt, "monthly.resetsAt")
			}
		};
	}
};

//#endregion
//#region src/host/balance/index.ts
const BALANCE_PROVIDERS = [
	opencodeGo,
	commandCode,
	deepseekOfficial,
	deepseekAccount
];
function matchBalanceProvider(provider) {
	return BALANCE_PROVIDERS.find((p) => p.ids.includes(provider));
}
/**
* 失败结果（三种 reason 一个出口，避免各处手写字段）。
* `message` 缺省时**不写这个键** —— 叶子的形状是对外契约，多一个 `undefined` 键会让
* `deepStrictEqual` 一类的严格比对失败（消费端也按「有/无」判断）。
*/
function failed(provider, reason, message) {
	return message === void 0 ? {
		ok: false,
		provider,
		reason
	} : {
		ok: false,
		provider,
		reason,
		message
	};
}
async function queryBalance(provider, resolveKey, resolveAccount) {
	const def = matchBalanceProvider(provider);
	if (!def) return failed(provider, "unsupported");
	let key = "";
	if (def.credential.mode === "ref") {
		const resolved = await resolveKey(def.credential.ref);
		if (!resolved) return failed(provider, "credential-missing", "缺少凭证 " + def.credential.ref);
		key = resolved;
	} else if (!resolveAccount) return failed(provider, "credential-missing", "缺少账号服务（" + provider + "）");
	try {
		return await def.fetch({
			provider,
			key,
			resolveAccount
		});
	} catch (e) {
		return failed(provider, "fetch-error", e instanceof Error ? e.message : String(e));
	}
}

//#endregion
//#region src/host/llm-reasoning.ts
async function supportsReasoningOff(ctx, provider, model) {
	const llm = ctx.llm;
	if (!llm || typeof llm.resolveModelInfo !== "function") return false;
	try {
		const info = await llm.resolveModelInfo(provider, model);
		return info?.reasoning?.efforts?.some((e) => e.id === "off") ?? false;
	} catch {
		return false;
	}
}

//#endregion
//#region src/host/model-selection.ts
function configuredModel(conf, key) {
	const raw = conf?.[key];
	if (!raw || typeof raw !== "object") return void 0;
	const m = raw;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return void 0;
	const provider = m.provider.trim();
	const model = m.model.trim();
	return provider && model ? {
		provider,
		model
	} : void 0;
}
function currentModel(ctx) {
	try {
		const sel = ctx.agentDefaultModel?.currentSelection();
		return sel?.provider && sel?.model ? {
			provider: sel.provider,
			model: sel.model
		} : void 0;
	} catch {
		return void 0;
	}
}
function modelCandidates(ctx, preferred) {
	const out = [];
	const push = (m) => {
		if (!m) return;
		if (out.some((x) => x.provider === m.provider && x.model === m.model)) return;
		out.push(m);
	};
	push(preferred);
	push(currentModel(ctx));
	return out;
}
function modelLabel(m) {
	return m.provider + "/" + m.model;
}

//#endregion
//#region src/host/whisper.ts
/** 单次生成超时（ms）：骈骈念不需要长输出，30s 足够 */
const TIMEOUT_MS$1 = 3e4;
/** 碎碎念指令：纯文本（原行为） */
const USER_TEXT = "随便说一句日常碎碎念，一句就好，20 字以内。";
/**
* 碎碎念指令：带表情包（用户开启 whisperImageEnabled 时）——要求模型配合作画说一句。
* 明确「正文仍是一句话」：图是配图，不是让模型描述画面本身。
*/
function userTextWithMeme(meme) {
	return "随便说一句日常碎碎念，一句就好，20 字以内。\n这次会配一张表情包一起显示，图的内容是：" + meme.name + "（" + meme.desc + "）。\n请让这句话和这张图的情绪/场景自然契合，像是配合画面说出来的；不要描述画面本身。";
}
async function generateWhisper(ctx, system, meme, preferred) {
	const candidates = modelCandidates(ctx, preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: "模型未返回文本"
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith$1(ctx, llm, sel, system, meme);
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) console.warn(`dsh-pet: 碎碎念用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用**一个**确定的 provider/model 跑一次生成（候选链的一环；失败原样返回结构化原因，不吞） */
async function generateWith$1(ctx, llm, sel, system, meme) {
	const deadline = AbortSignal.timeout(TIMEOUT_MS$1);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const options = {
		provider: sel.provider,
		model: sel.model,
		messages: [createUserMessage({
			content: [{
				type: "text",
				text: meme ? userTextWithMeme(meme) : USER_TEXT
			}],
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: "模型未返回文本"
	};
	return meme ? {
		ok: true,
		text,
		image: meme.name
	} : {
		ok: true,
		text
	};
}

//#endregion
//#region src/host/memes.ts
function readMemePool(memes, dirs) {
	if (!memes || typeof memes !== "object" || Array.isArray(memes)) return [];
	if (dirs.length === 0) return [];
	const out = [];
	for (const [name$1, desc] of Object.entries(memes)) {
		const text = typeof desc === "string" ? desc.trim() : "";
		if (!name$1 || !text) continue;
		if (!dirs.some((dir) => existsSync(join(dir, name$1 + ".png")))) continue;
		out.push({
			name: name$1,
			desc: text
		});
	}
	return out;
}
function pickMeme(pool, random = Math.random) {
	if (pool.length === 0) return void 0;
	const idx = Math.floor(random() * pool.length) % pool.length;
	return pool[idx];
}
function matchMeme(pool, name$1) {
	const key = String(name$1 ?? "").trim();
	return key ? pool.find((m) => m.name === key) : void 0;
}
/** 配图选择标记：`[图:名称]` 附在回复末尾（容忍全角冒号与前后空白） */
const IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/;
function extractChatImage(text, pool) {
	const m = IMG_TAG.exec(text);
	if (!m) return { text };
	const hit = matchMeme(pool, m[1] ?? "");
	const body = text.slice(0, m.index).trim();
	if (!hit || !body) return { text };
	return {
		text: body,
		image: hit.name
	};
}
function memeCatalog(pool) {
	return pool.map((m) => "- " + m.name + "：" + m.desc).join("\n");
}
function limitPool(pool, limit) {
	const n = Math.floor(Number(limit));
	if (!Number.isFinite(n) || n <= 0) return pool;
	return pool.slice(0, n);
}

//#endregion
//#region src/host/chat.ts
/** 单次生成超时（ms）：对话等 LLM 回复，60s 足够 */
const TIMEOUT_MS = 6e4;
/** 配图指令：附在 user 正文之后（紧邻回答位置，模型更容易遵守） */
function imageInstruction(pool) {
	return "\n\n[配图] 回复结尾可选附一张表情包给用户看，从下列清单里挑最贴合当前语境的：\n" + memeCatalog(pool) + "\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。";
}
async function generateChat(ctx, system, history, userText, pool = [], preferred) {
	const candidates = modelCandidates(ctx, preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: "模型未返回文本"
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith(ctx, llm, sel, system, history, userText, pool);
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) console.warn(`dsh-pet: 对话用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用**一个**确定的 provider/model 跑一次对话生成（候选链的一环；失败原样返回结构化原因，不吞） */
async function generateWith(ctx, llm, sel, system, history, userText, pool) {
	const historyMessages = history.map((m) => m.role === "user" ? createUserMessage({
		content: [{
			type: "text",
			text: m.content
		}],
		source: { kind: "user" }
	}) : createAssistantMessage({
		content: [{
			type: "text",
			text: m.content
		}],
		source: {
			provider: sel.provider,
			model: sel.model
		}
	}));
	const deadline = AbortSignal.timeout(TIMEOUT_MS);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const wantImage = pool.length > 0;
	const options = {
		provider: sel.provider,
		model: sel.model,
		messages: [...historyMessages, createUserMessage({
			content: [{
				type: "text",
				text: wantImage ? userText + imageInstruction(pool) : userText
			}],
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: "模型未返回文本"
	};
	if (!wantImage) return {
		ok: true,
		text
	};
	const picked = extractChatImage(text, pool);
	return picked.image ? {
		ok: true,
		text: picked.text,
		image: picked.image
	} : {
		ok: true,
		text: picked.text
	};
}

//#endregion
//#region src/host/config.ts
/** 位置角落白名单 */
const CORNERS = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right"
];
const CORNER_SET = new Set(CORNERS);
/** display 白名单 */
const PET_DISPLAYS = [
	"web",
	"desktop",
	"both",
	"none"
];
const PET_DISPLAY_SET = new Set(PET_DISPLAYS);
const ID_FORBIDDEN = /[\\/:\x00-\x1f]/;
/**
* 「全局默认 + 种类可覆盖」的顶层字段白名单 —— 用户层（main-config.jsonc）里写下的值会成为
* **所有条目**的默认值；种类文件 `pet/<名>-config.json` 仍可在自己顶层覆盖（写了就用自己那份）。
*
* 判据：这几个是**用户级「成本 / 偏好 / 环境 / 节奏」参数**，不是「这个种类长什么样」——
*   - `chatMemoryRounds`：带多少历史进上下文 = token 成本
*   - `whisperModel` / `chatModel`：碎碎念 / 对话用哪个模型 = 成本与能力偏好
*   - `whisperImageEnabled` / `chatImageEnabled`：要不要把表情包清单附进请求 = token 成本
*   - `chatImageLimit`：对话那张清单**最多几张**——同属 token 成本（清单每条消息都附）
*   - `eventsRefreshSec`：多久调一次模型 / 拉一次余额 = 成本与节奏。注意它内部两个键的**消费端**
*     不同：`.whisper` 按宠物所属条目读（种类可覆盖）；`.balance` 只读 main 条目
*     （余额数据一份 + host 只有一个定时器，架构上给不了每种类一个周期）
*   - `physics`：拖拽抛掷手感；`petCollision` 更是**跨宠物**行为（相撞按动量守恒弹开），
*     按种类分在语义上站不住：两只不同种类的宠物相撞时用谁的系数？
*   - `confineToScreen`：多屏是用户环境 / 使用习惯，不是宠物属性
*
* 不在名单里的顶层字段基座仍是**内置默认**：`whisperPrompt`（人设）、`memes`（表情包）、
* `animations` / `animationWeights`（与素材根绑定）、`workStatusTexts`（文案）——一个种类一份
* 动画池 / 一份人设 / 一个表情包目录，各写一份才是 pet pack 的意义。
*/
const GLOBAL_DEFAULT_KEYS = [
	"physics",
	"confineToScreen",
	"whisperImageEnabled",
	"chatImageEnabled",
	"chatImageLimit",
	"chatMemoryRounds",
	"whisperModel",
	"chatModel",
	"eventsRefreshSec"
];
/** 已告警过的 文件:字段（进程内去重：同一问题只告警一次，避免每请求刷屏；重启重置） */
const warnedKeys = new Set();
function warnOnce(key, message) {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	console.warn("dsh-pet: " + message);
}
/** 剥除 JSONC 注释（行注释 // 与块注释）得到纯 JSON */
function stripJsonc(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\\:])\/\/.*$/gm, "$1").trim();
}
/** 读取并解析 JSONC 文件；不存在/解析失败 → undefined（调用方决定处理） */
function readJsonc(path) {
	try {
		const raw = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
		return raw && typeof raw === "object" ? raw : void 0;
	} catch {
		return void 0;
	}
}
function readUserConfig(paths) {
	const file = effectiveUserFile(paths);
	return file ? readJsonc(file) : void 0;
}
function userConfigUnparsable(paths) {
	const file = effectiveUserFile(paths);
	return file !== void 0 && readJsonc(file) === void 0;
}
/** 实际生效的用户层文件：优先 .jsonc；不存在则回落到旧的 .json（迁移前的老用户）；
*  两者都不存在 → undefined（首次使用，无用户层）。 */
function effectiveUserFile(paths) {
	if (existsSync(paths.userFile)) return paths.userFile;
	if (paths.legacyUserFile && existsSync(paths.legacyUserFile)) return paths.legacyUserFile;
	return void 0;
}
function migrateUserConfig(paths, log) {
	const legacy = paths.legacyUserFile;
	if (!legacy || !existsSync(legacy) || existsSync(paths.userFile)) return false;
	try {
		renameSync(legacy, paths.userFile);
	} catch {
		return false;
	}
	log?.(`用户配置已迁移到 JSONC：${legacy} → ${paths.userFile}`);
	return true;
}
/** 扫描 pet/ 目录：<名>-config.(json|jsonc) → 条目（按文件名排序） */
function scanPetFiles(petDir) {
	let entries;
	try {
		entries = readdirSync(petDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((e) => e.isFile()).map((e) => e.name).filter((name$1) => /^.+?-config\.(json|jsonc)$/.test(name$1)).sort().map((name$1) => ({
		prefix: name$1.replace(/-config\.(json|jsonc)$/, ""),
		path: join(petDir, name$1)
	}));
}
/** animations 段完整性校验（与旧 assertAnimationsHost 同一套规则；不 throw，非法返回 false） */
function animationsValid(a) {
	if (!a || typeof a !== "object") return false;
	const anims = a;
	for (const key of [
		"idle",
		"turn",
		"drag",
		"clicks"
	]) if (!Array.isArray(anims[key])) return false;
	const moves = anims.moves;
	if (!moves || typeof moves !== "object" || typeof moves.default !== "object" || moves.default === null || !Array.isArray(moves.actions)) return false;
	if (!Array.isArray(anims.categories)) return false;
	const ev = anims.events;
	if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
	const evEntries = ev;
	for (const pool of Object.values(evEntries)) {
		if (!Array.isArray(pool) || pool.length === 0) return false;
		for (const slot of pool) if (typeof slot === "string") {
			if (slot.length === 0) return false;
		} else if (Array.isArray(slot)) {
			if (slot.length === 0) return false;
			for (const name$1 of slot) if (typeof name$1 !== "string" || name$1.length === 0) return false;
		} else return false;
	}
	const balance = evEntries.balance;
	return Array.isArray(balance) && balance.length > 0;
}
/** animationWeights 段校验（idle/turn/move 三个非负数字） */
function weightsValid(w) {
	if (!w || typeof w !== "object") return false;
	const weights = w;
	for (const key of [
		"idle",
		"turn",
		"move"
	]) {
		const v = Number(weights[key]);
		if (!Number.isFinite(v) || v < 0) return false;
	}
	return true;
}
/** physics 段校验：gravity ≥ 0（0 = 无重力，合法）、restitution ∈ [0,1]、groundFriction ≥ 0（均为有限数字）、
*  ceilingBounce 为布尔、throwPower > 0（有限数字）、petCollision 为布尔 */
function physicsValid(value) {
	if (!value || typeof value !== "object") return false;
	const p = value;
	const g = Number(p.gravity);
	const r = Number(p.restitution);
	const f = Number(p.groundFriction);
	const tp = Number(p.throwPower);
	return Number.isFinite(g) && g >= 0 && Number.isFinite(r) && r >= 0 && r <= 1 && Number.isFinite(f) && f >= 0 && typeof p.ceilingBounce === "boolean" && Number.isFinite(tp) && tp > 0 && typeof p.petCollision === "boolean";
}
/** whisperModel / chatModel 段校验：{ provider, model } 两个字符串，
*  **要么都留空（= 跟随当前对话的模型）要么都非空**——只填一半（选了服务商没选模型，或反之）
*  会拼出"用 A 家的模型名去问 B 家"这种必然失败的组合，按非法处理（告警 + 取默认）。 */
function modelSelectionValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const m = value;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return false;
	return m.provider.trim() === "" === (m.model.trim() === "");
}
/** workStatusTexts 段校验：二维数组——外层每项都是非空字符串数组（档位文案，每档可多句随机）；空数组不可用 */
function workStatusTextsValid(value) {
	if (!Array.isArray(value) || value.length === 0) return false;
	for (const group of value) {
		if (!Array.isArray(group) || group.length === 0) return false;
		for (const text of group) if (typeof text !== "string" || text.length === 0) return false;
	}
	return true;
}
/** 顶层标量字段的合法性（非法与缺失同处理：取默认值 + 告警） */
function topFieldValid(key, value) {
	switch (key) {
		case "whisperPrompt": return typeof value === "string" && value.length > 0;
		case "chatMemoryRounds": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "chatImageLimit": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "notificationsEnabled": return typeof value === "boolean";
		case "whisperImageEnabled": return typeof value === "boolean";
		case "chatImageEnabled": return typeof value === "boolean";
		case "confineToScreen": return typeof value === "boolean";
		case "animations": return animationsValid(value);
		case "animationWeights": return weightsValid(value);
		case "eventsRefreshSec": return eventsRefreshSecValid(value);
		case "physics": return physicsValid(value);
		case "whisperModel":
		case "chatModel": return modelSelectionValid(value);
		case "workStatusTexts": return workStatusTextsValid(value);
		default: return true;
	}
}
/**
* eventsRefreshSec 段校验：事件名 → 间隔秒（正的有限数字）。
*
* 只校验「写下的每个值都合法」，**不**要求键集合与内置默认一致——这个字段和别的顶层字段
* 一样是**整段替换**：缺的键就是缺（消费端各自兜底 1800 / 300），多写的键原样保留
* （不再像旧的逐键深合并那样静默丢弃不认识的键）。空对象合法（等于全走消费端兜底）。
*/
function eventsRefreshSecValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	for (const v of Object.values(value)) {
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) return false;
	}
	return true;
}
/**
* 文件宠物条目的合并基座：内置默认 + 白名单字段改用**用户层**的值。
*
* 为什么：那 9 个字段是用户级成本/偏好/环境/节奏参数，不是种类属性——用户在设置页改一次，
* 期望所有宠物（含 pet pack）都生效。没有这一步，文件宠物只能拿到内置默认值，
* 于是"设置页写着全局、实际只影响主宠物"（见 GLOBAL_DEFAULT_KEYS 的判据）。
*
* 语义仍是「种类可覆盖」：种类文件顶层写了自己的值 → 走 overlay 覆盖（mergeEntry 负责）。
* 用户层写了但非法的值直接跳过（main 条目那边合并时已告警过一次，这里不再重复刷屏）。
*/
function packBase(base, mainOverlay) {
	if (!mainOverlay) return base;
	let out;
	for (const key of GLOBAL_DEFAULT_KEYS) {
		const own = mainOverlay[key];
		if (own === void 0 || !topFieldValid(key, own)) continue;
		out ?? (out = { ...base });
		out[key] = own;
	}
	return out ?? base;
}
/** 一个覆盖文件 → 完整条目：顶层逐字段合并（没写/非法 → 内置默认 + 告警），pets 逐实例 */
function mergeEntry(base, overlay, label, basePets, seenIds) {
	const out = {};
	for (const key of Object.keys(base)) {
		if (key === "pets") {
			out.pets = mergePets(basePets, overlay?.[key], label, seenIds);
			continue;
		}
		const own = overlay ? overlay[key] : void 0;
		if (own === void 0) {
			out[key] = base[key];
			continue;
		}
		if (!topFieldValid(key, own)) {
			warnOnce(`${label}:${key}`, `「${label}」的 ${key} 非法，已取默认值`);
			out[key] = base[key];
			continue;
		}
		out[key] = own;
	}
	return out;
}
/** pets 数组合并：文件没写/空 → 默认列表；逐实例合并（缺字段 → 内置默认 pets[0]，静默）。 */
function mergePets(basePets, raw, label, seenIds) {
	const basePet = basePets[0] ?? {};
	if (!Array.isArray(raw) || raw.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 缺失或为空，已取默认宠物列表`);
		return basePets;
	}
	const out = [];
	for (const item of raw) {
		const pet = mergePet(basePet, item, label, seenIds);
		if (pet) out.push(pet);
	}
	if (out.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 全部被跳过（id 非法/重复/冲突），已取默认宠物列表`);
		return basePets;
	}
	return out;
}
/** 宠物实例字段取数字；缺失 → 静默取默认（结构性常态）；显式写但非法 → 告警 + 默认 */
function petNumber(own, def, min, label, field, id) {
	const n = Number(own);
	if (own !== void 0 && own !== null && Number.isFinite(n) && n >= min) return n;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Number(def);
}
/** 宠物实例字段取布尔；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petBool(own, def, label, field, id) {
	if (typeof own === "boolean") return own;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Boolean(def);
}
/** 宠物实例字段取白名单枚举；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petEnum(own, set, def, label, field, id) {
	if (typeof own === "string" && set.has(own)) return own;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return typeof def === "string" ? def : "";
}
/** 一只实例 → 完成品实例（id 必须自己的且全局唯一；其余字段没写/非法 → 默认 + 告警） */
function mergePet(base, raw, label, seenIds) {
	const p = raw && typeof raw === "object" ? raw : {};
	const id = typeof p.id === "string" ? p.id.trim() : "";
	if (!id || id.length > 64 || ID_FORBIDDEN.test(id) || seenIds.has(id)) {
		warnOnce(`${label}:id:${id || "(空)"}`, `「${label}」的宠物 id「${id || "(空)"}」非法、重复或已存在，已跳过该实例`);
		return null;
	}
	seenIds.add(id);
	const rawName = typeof p.name === "string" ? p.name.trim() : "";
	const name$1 = rawName || id;
	if (!rawName) warnOnce(`${label}:name:${id}`, `宠物「${id}」缺少 name，已按 id 处理`);
	const basePos = base.position && typeof base.position === "object" ? base.position : {};
	const ownPos = p.position && typeof p.position === "object" ? p.position : {};
	return {
		id,
		name: name$1,
		size: petNumber(p.size, base.size, 1, label, "size", id),
		balanceEnabled: petBool(p.balanceEnabled, base.balanceEnabled, label, "balanceEnabled", id),
		whisperEnabled: petBool(p.whisperEnabled, base.whisperEnabled, label, "whisperEnabled", id),
		workStatusEnabled: petBool(p.workStatusEnabled, base.workStatusEnabled, label, "workStatusEnabled", id),
		fixedEnabled: petBool(p.fixedEnabled, base.fixedEnabled, label, "fixedEnabled", id),
		display: petEnum(p.display, PET_DISPLAY_SET, base.display, label, "display", id),
		position: {
			corner: petEnum(ownPos.corner, CORNER_SET, basePos.corner, label, "position.corner", id),
			marginX: petNumber(ownPos.marginX, basePos.marginX, -Infinity, label, "position.marginX", id),
			marginY: petNumber(ownPos.marginY, basePos.marginY, -Infinity, label, "position.marginY", id)
		}
	};
}
function readAllConfig(paths) {
	const base = readJsonc(paths.defaultFile);
	if (!base) throw new Error("dsh-pet: 内置默认配置缺失或解析失败（安装损坏）：" + paths.defaultFile);
	const basePets = Array.isArray(base.pets) ? base.pets : [];
	const seenIds = new Set();
	const out = {};
	const userFile = effectiveUserFile(paths);
	const mainOverlay = userFile ? readJsonc(userFile) : void 0;
	if (userFile && !mainOverlay) warnOnce("file:" + userFile, "用户主配置解析失败，已按无用户配置处理：" + userFile);
	out.main = mergeEntry(base, mainOverlay, "main-config.jsonc", basePets, seenIds);
	const filePetBase = packBase(base, mainOverlay);
	for (const file of scanPetFiles(paths.petDir)) {
		const parsed = readJsonc(file.path);
		if (!parsed) {
			warnOnce("file:" + file.path, "文件宠物配置解析失败，已跳过：" + file.path);
			continue;
		}
		out[file.prefix] = mergeEntry(filePetBase, parsed, file.prefix + "-config.json", basePets, seenIds);
	}
	return out;
}
function flattenPetList(merged) {
	const out = [];
	for (const conf of Object.values(merged)) if (Array.isArray(conf?.pets)) out.push(...conf.pets);
	return out;
}
function findPetInstance(merged, petId) {
	for (const [entry, conf] of Object.entries(merged)) {
		const pets = Array.isArray(conf?.pets) ? conf.pets : [];
		const found = pets.find((p) => String(p.id) === petId);
		if (found) return {
			entry,
			conf,
			pet: found
		};
	}
	return void 0;
}
function saveUserConfig(raw, existing) {
	const o = raw && typeof raw === "object" ? raw : {};
	const arr = Array.isArray(o.pets) ? o.pets : null;
	if (!arr || !arr.length) return null;
	const out = [];
	for (const p of arr) {
		if (!p || typeof p !== "object") return null;
		const pp = p;
		const id = String(pp.id ?? "");
		if (!id || id.length > 64 || ID_FORBIDDEN.test(id)) return null;
		const size = Number(pp.size);
		if (!Number.isFinite(size) || size <= 0) return null;
		let name$1 = typeof pp.name === "string" ? pp.name.trim() : "";
		if (!name$1) {
			console.warn(`dsh-pet: pet「${id}」缺少 name，已按默认 ${id}（宠物 id）处理`);
			name$1 = id;
		}
		const balanceEnabled = pp.balanceEnabled;
		if (typeof balanceEnabled !== "boolean") return null;
		const whisperEnabled = pp.whisperEnabled;
		if (whisperEnabled !== void 0 && typeof whisperEnabled !== "boolean") return null;
		const workStatusEnabled = pp.workStatusEnabled;
		if (workStatusEnabled !== void 0 && typeof workStatusEnabled !== "boolean") return null;
		const fixedEnabled = pp.fixedEnabled;
		if (fixedEnabled !== void 0 && typeof fixedEnabled !== "boolean") return null;
		/** 透明度（可选，0 < opacity ≤ 1）：桌面版右键「透明度」滑块写的，浏览器端不用 */
		const opacity = pp.opacity === void 0 ? void 0 : Number(pp.opacity);
		if (opacity !== void 0 && (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1)) return null;
		const display = String(pp.display ?? "");
		if (!PET_DISPLAY_SET.has(display)) return null;
		const pos = pp.position && typeof pp.position === "object" ? pp.position : {};
		const corner = String(pos.corner ?? "");
		if (!CORNER_SET.has(corner)) return null;
		const marginX = Number(pos.marginX);
		const marginY = Number(pos.marginY);
		if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
		out.push({
			id,
			name: name$1,
			size,
			balanceEnabled,
			whisperEnabled,
			workStatusEnabled,
			fixedEnabled,
			...opacity === void 0 ? {} : { opacity },
			display,
			position: {
				corner,
				marginX,
				marginY
			}
		});
	}
	const ne = o.notificationsEnabled;
	if (ne !== void 0 && typeof ne !== "boolean") return null;
	const wie = o.whisperImageEnabled;
	if (wie !== void 0 && typeof wie !== "boolean") return null;
	const cie = o.chatImageEnabled;
	if (cie !== void 0 && typeof cie !== "boolean") return null;
	const cts = o.confineToScreen;
	if (cts !== void 0 && typeof cts !== "boolean") return null;
	const ph = o.physics;
	if (ph !== void 0 && !physicsValid(ph)) return null;
	const wm = o.whisperModel;
	if (wm !== void 0 && !modelSelectionValid(wm)) return null;
	const cm = o.chatModel;
	if (cm !== void 0 && !modelSelectionValid(cm)) return null;
	const cmr = o.chatMemoryRounds;
	if (cmr !== void 0 && !topFieldValid("chatMemoryRounds", cmr)) return null;
	const cil = o.chatImageLimit;
	if (cil !== void 0 && !topFieldValid("chatImageLimit", cil)) return null;
	const cleanModel = (v) => ({
		provider: String(v.provider).trim(),
		model: String(v.model).trim()
	});
	const outConfig = { pets: out };
	// autoHide 是本地改造新增的顶层字段，不在下面的白名单里——设置页保存时按原样带回去，
	// 否则用户每存一次设置，自动隐藏的关键词就被清空了。
	// ⚠️ 第二个形参叫 existing（不是 prev）——写成 prev?.autoHide 会 ReferenceError，
	// 而那条路径只在"真的保存一次配置"时才走到，用无效参数测 400 是发现不了的。
	const prevAutoHide = existing?.autoHide;
	if (prevAutoHide && typeof prevAutoHide === "object") outConfig.autoHide = prevAutoHide;
	if (ne !== void 0) outConfig.notificationsEnabled = ne;
	if (wie !== void 0) outConfig.whisperImageEnabled = wie;
	if (cie !== void 0) outConfig.chatImageEnabled = cie;
	if (cts !== void 0) outConfig.confineToScreen = cts;
	if (ph !== void 0) outConfig.physics = ph;
	if (wm !== void 0) outConfig.whisperModel = cleanModel(wm);
	if (cm !== void 0) outConfig.chatModel = cleanModel(cm);
	if (cmr !== void 0) outConfig.chatMemoryRounds = Number(cmr);
	if (cil !== void 0) outConfig.chatImageLimit = Number(cil);
	const bodyOwned = new Set(["pets"]);
	if (ne !== void 0) bodyOwned.add("notificationsEnabled");
	if (wie !== void 0) bodyOwned.add("whisperImageEnabled");
	if (cie !== void 0) bodyOwned.add("chatImageEnabled");
	if (cts !== void 0) bodyOwned.add("confineToScreen");
	if (ph !== void 0) bodyOwned.add("physics");
	if (wm !== void 0) bodyOwned.add("whisperModel");
	if (cm !== void 0) bodyOwned.add("chatModel");
	if (cmr !== void 0) bodyOwned.add("chatMemoryRounds");
	if (cil !== void 0) bodyOwned.add("chatImageLimit");
	if (existing && typeof existing === "object") for (const key of Object.keys(existing)) {
		if (bodyOwned.has(key)) continue;
		outConfig[key] = existing[key];
	}
	return outConfig;
}
function syncUserConfigFromDefault(paths) {
	const raw = readFileSync(paths.defaultFile, "utf8");
	mkdirSync(dirname(paths.userFile), { recursive: true });
	writeFileSync(paths.userFile, raw, "utf8");
}
function sliceMemoryRounds(messages, rounds) {
	return rounds > 0 ? messages.slice(-Math.floor(rounds) * 2) : [];
}

//#endregion
//#region src/host/broadcast.ts
function normalizeBroadcastText(text) {
	return typeof text === "string" ? text.trim() : "";
}
function decideBroadcast(args) {
	const { cfg, requested, active, memeDirs } = args;
	const text = normalizeBroadcastText(args.text);
	if (!text) return {
		ok: false,
		reason: "bad-request",
		message: "text 为空"
	};
	const petId = String(requested || active || "main");
	if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	const rawImage = typeof args.image === "string" ? args.image.trim() : "";
	if (!rawImage) return {
		ok: true,
		petId,
		text
	};
	const found = findPetInstance(cfg, petId);
	const conf = found ? found.conf : cfg.main ?? {};
	const hit = matchMeme(readMemePool(conf.memes, memeDirs(found ? found.entry : "main")), rawImage);
	if (!hit) return {
		ok: false,
		reason: "unknown-image",
		message: "配图不在表情包池内：" + rawImage
	};
	return {
		ok: true,
		petId,
		text,
		image: hit.name
	};
}

//#endregion
//#region src/host/anim.ts
/** 字符串数组收窄（配置里的池子；非数组/空串 → 空数组） */
function strings(v) {
	return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== "") : [];
}
function animationNames(animations) {
	const a = animations && typeof animations === "object" ? animations : {};
	const out = [];
	const push = (names) => {
		for (const n of names) if (!out.includes(n)) out.push(n);
	};
	push(strings(a.idle));
	push(strings(a.turn));
	push(strings(a.drag));
	push(strings(a.clicks));
	const moves = a.moves && typeof a.moves === "object" ? a.moves : {};
	push(Array.isArray(moves.actions) ? moves.actions.map((m) => m && typeof m === "object" ? m.name : void 0).filter((x) => typeof x === "string" && x !== "") : []);
	if (Array.isArray(a.categories)) {
		for (const c of a.categories) if (c && typeof c === "object") push(strings(c.actions));
	}
	const events = a.events && typeof a.events === "object" ? a.events : {};
	for (const key of Object.keys(events)) {
		const pool = events[key];
		if (!Array.isArray(pool)) continue;
		const names = [];
		for (const slot of pool) if (typeof slot === "string") names.push(slot);
		else names.push(...strings(slot));
		push(names);
	}
	return out;
}
function decideAnim(args) {
	const { cfg, requested, active } = args;
	const name$1 = typeof args.name === "string" ? args.name.trim() : "";
	if (!name$1) return {
		ok: false,
		reason: "bad-request",
		message: "name 为空"
	};
	const petId = String(requested || active || "main");
	if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	const conf = (findPetInstance(cfg, petId) ?? { conf: cfg.main ?? {} }).conf;
	const allowed = animationNames(conf.animations);
	if (!allowed.includes(name$1)) return {
		ok: false,
		reason: "unknown-animation",
		message: "没有这个动画：" + name$1
	};
	return {
		ok: true,
		petId,
		name: name$1
	};
}

//#endregion
//#region src/host/work-status.ts
/**
* turn/end reason.kind → 状态：
*   completed → success、错误系（error/max-tokens/timeout）→ error、blocked → waiting（回合被阻塞，等用户确认）；
*   其余（aborted 等）→ null＝该会话回合已结束，由调用方清理会话回空闲——绝不残留上一档
*   （否则回合被打断后会永远卡在 working，即当年"这一步正在进行中哦"挂死的根因）。
*/
function turnEndState(kind) {
	if (kind === "completed") return "success";
	if (kind === "error" || kind === "max-tokens" || kind === "timeout") return "error";
	if (kind === "blocked") return "waiting";
	return null;
}
/** ask_user_question 工具名：模型在等用户选择题答复 → 归为 waiting（等待确认）而非普通工作 */
const USER_QUESTION_TOOL$1 = "ask_user_question";
const GOAL_UPDATE_TOOL = "update_goal";
function goalUpdateAction(args) {
	try {
		const o = JSON.parse(args);
		const action = String(o?.action ?? "");
		if (action === "complete" || action === "blocked") return action;
	} catch {}
	return null;
}
function completedState(turn) {
	if (!turn?.goalRound) return "success";
	if (turn.closing === "blocked") return "error";
	if (turn.closing === "complete") return "success";
	return "result";
}
function reduceWorkStatus(event, turn) {
	switch (event?.type) {
		case "turn/start": return "thinking";
		case "tool/call": {
			if (String(event?.data?.name ?? "") === USER_QUESTION_TOOL$1) return "waiting";
			return "working";
		}
		case "tool/result": return "result";
		case "approval/asked": return "waiting";
		case "turn/end": {
			const reason = turnEndState(String(event?.data?.reason?.kind ?? ""));
			if (reason === "success") return completedState(turn);
			return reason;
		}
		default: return null;
	}
}
const TASK_TEXT_MAX = 40;
function currentTaskFromTodo(event) {
	const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
	let current;
	for (const t of todos) if (t?.status === "in_progress") current = t;
	if (!current) current = todos.find((t) => t?.status === "pending");
	const content = String(current?.content ?? "").trim();
	if (!content) return null;
	const points = Array.from(content);
	return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join("")}…` : content;
}
const WORK_STATUS_PRIORITY = {
	waiting: 60,
	error: 50,
	working: 40,
	thinking: 30,
	result: 25,
	success: 20
};
function pickDisplayed(entries) {
	let best;
	for (const entry of entries) if (!best || WORK_STATUS_PRIORITY[entry.state] > WORK_STATUS_PRIORITY[best.state] || WORK_STATUS_PRIORITY[entry.state] === WORK_STATUS_PRIORITY[best.state] && entry.seq > best.seq) best = entry;
	return best;
}
var WorkStatusStore = class {
	constructor() {
		this.sessions = new Map();
		this.snap = {
			state: null,
			task: null,
			ts: 0
		};
	}
	/** 该会话当前是否有活动条目（决定 todo/write 是否还值得更新它的文案） */
	has(sessionId) {
		return this.sessions.has(sessionId);
	}
	/** 该会话当前档位（无条目 / 已清 → undefined） */
	stateOf(sessionId) {
		return this.sessions.get(sessionId)?.state;
	}
	/** 写会话状态（保留该会话已有的 task）；同状态且 seq 不更新 → 无变化返回 false（防刷屏） */
	setState(sessionId, state, seq = 0) {
		const prev = this.sessions.get(sessionId);
		if (prev?.state === state && prev.seq >= seq) return false;
		this.sessions.set(sessionId, {
			state,
			seq,
			task: prev?.task ?? null
		});
		this.refresh();
		return true;
	}
	/** 写该会话的任务详情（null = 清空）；会话无活动条目 → 不动（它不会被展示） */
	setTask(sessionId, task) {
		const prev = this.sessions.get(sessionId);
		if (!prev || prev.task === task) return false;
		this.sessions.set(sessionId, {
			...prev,
			task
		});
		this.refresh();
		return true;
	}
	/** 清掉某会话（回合结束 / 终态过期）：它的 task 一并消失，不会残留到后续活动里 */
	clear(sessionId) {
		if (!this.sessions.delete(sessionId)) return false;
		this.refresh();
		return true;
	}
	/** 展示快照（对象引用稳定，供 /work-status 直接序列化） */
	snapshot() {
		return this.snap;
	}
	/** 重算展示：state 与 task **任一**变化才更新 ts（轮询侧据此触发，两端都靠它刷新） */
	refresh() {
		const best = pickDisplayed(this.sessions.values());
		const nextState = best?.state ?? null;
		const nextTask = best?.task ?? null;
		if (nextState === this.snap.state && nextTask === this.snap.task) return;
		this.snap.state = nextState;
		this.snap.task = nextTask;
		this.snap.ts = Date.now();
	}
};

//#endregion
//#region src/host/notify-events.ts
function shouldNotifySession(session) {
	const header = session?.header;
	if (!header || typeof header !== "object") return true;
	if (header.origin === "subagent") return false;
	const depth = header.delegationDepth;
	if (typeof depth === "number" && Number.isFinite(depth) && depth > 0) return false;
	return true;
}
function turnEndNotifyKind(kind) {
	if (kind === "completed") return "completed";
	if (kind === "error" || kind === "max-tokens") return kind;
	return null;
}
/** ask_user_question 工具名（与 work-status.ts 同源；该工具触发时模型在等用户选择题答复） */
const USER_QUESTION_TOOL = "ask_user_question";
function parseToolQuestions(args) {
	if (typeof args !== "string") return null;
	try {
		const parsed = JSON.parse(args);
		const questions = parsed?.questions;
		if (!Array.isArray(questions)) return null;
		return questions;
	} catch {
		return null;
	}
}
function reduceNotifyFrame(event) {
	if (!event?.type) return null;
	switch (event.type) {
		case "turn/end": {
			const reason = event.data?.reason;
			const kind = turnEndNotifyKind(reason?.kind);
			if (!kind) return null;
			return {
				type: "session/event",
				event: {
					type: "turn/end",
					data: { reason }
				}
			};
		}
		case "approval/asked": {
			const data = event.data ?? {};
			return {
				type: "approval/requested",
				...typeof data.toolName === "string" && data.toolName ? { toolName: data.toolName } : {},
				...typeof data.reason === "string" && data.reason ? { reason: data.reason } : {}
			};
		}
		case "tool/call": {
			if (String(event.data?.name ?? "") !== USER_QUESTION_TOOL) return null;
			const questions = parseToolQuestions(event.data?.arguments);
			if (!questions || questions.length === 0) return null;
			return {
				type: "question/requested",
				questions
			};
		}
		default: return null;
	}
}
function agentErrorFrame(error) {
	const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "");
	return {
		type: "host/agent-error",
		message
	};
}

//#endregion
//#region src/host/storage-paths.ts
const DESKTOP_APP_NAME = "dsh-pet-electron-helper";
/** Electron 下载缓存的应用名（@electron/get 写死 env-paths('electron')，与插件名无关） */
const ELECTRON_PATHS_NAME = "electron";
/**
* 桌面端 userData 目录（Electron app.getPath('userData') 的等价推导）。
*
* 与 Electron 的口径逐平台对齐：
*   win32  = %APPDATA%\<name>（appData 在 Windows 就是 Roaming）
*   darwin = ~/Library/Application Support/<name>
*   linux  = $XDG_CONFIG_HOME/<name>，未设则 ~/.config/<name>
*/
function desktopUserDataDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), DESKTOP_APP_NAME);
	if (platform === "darwin") return join(home, "Library", "Application Support", DESKTOP_APP_NAME);
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), DESKTOP_APP_NAME);
}
/**
* Electron 安装包下载缓存目录（@electron/get 默认 cacheRoot = env-paths('electron').cache）。
*
* env-paths 的口径：win32 在 LOCALAPPDATA 下多一层 Cache，macOS 用 ~/Library/Caches，
* Linux 用 $XDG_CACHE_HOME（默认 ~/.cache）——都是「应用名单独一层」。
* 该目录与其它用 @electron/get 的工具共用，删掉只是下次重新下载。
*/
function electronCacheDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), ELECTRON_PATHS_NAME, "Cache");
	if (platform === "darwin") return join(home, "Library", "Caches", ELECTRON_PATHS_NAME);
	return join(env.XDG_CACHE_HOME || join(home, ".cache"), ELECTRON_PATHS_NAME);
}
function storageEntries(input) {
	const items = [
		{
			key: "userData",
			path: input.userDataRoot
		},
		{
			key: "electron",
			path: input.electronDir
		},
		{
			key: "desktopCache",
			path: desktopUserDataDir(input)
		},
		{
			key: "electronCache",
			path: electronCacheDir(input)
		},
		{
			key: "package",
			path: input.packageRoot
		}
	];
	return items.map((it) => ({
		...it,
		exists: existsSync(it.path)
	}));
}
function profileNameFrom(packageRoot$1) {
	const m = /[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/][^\\/]+[\\/]?$/.exec(packageRoot$1);
	return m?.[1];
}

//#endregion
//#region src/host/state.ts
/** 空叶子：counter=0 表示"从未写过"——前端首拉把它当基线，之后 counter 变化才渲染 */
const emptyLeaf = () => ({
	counter: 0,
	data: null
});
var PollStateStore = class {
	constructor() {
		this.last = 0;
		this.sections = {
			balance: emptyLeaf(),
			workStatus: emptyLeaf(),
			notify: emptyLeaf(),
			desktop: emptyLeaf()
		};
		this.pets = new Map();
	}
	/** 下一个 counter：`Date.now()` 与「上一个 +1」取大——单调、不回退、同毫秒不重复 */
	next() {
		this.last = Math.max(Date.now(), this.last + 1);
		return this.last;
	}
	/**
	* 写一个全局叶子（余额 / 工作状态 / 通知）。
	* 每次都整体替换叶子对象（不原地改字段），保证 `read()` 拿到的引用不会半新半旧。
	*/
	writeSection(name$1, data) {
		this.sections[name$1] = {
			counter: this.next(),
			data
		};
	}
	/** 写一只宠物的叶子（宠物条目不存在则自动建立，两个槽位一起建好，形状恒定） */
	writePet(petId, leaf, data) {
		let entry = this.pets.get(petId);
		if (!entry) {
			entry = {
				say: emptyLeaf(),
				anim: emptyLeaf()
			};
			this.pets.set(petId, entry);
		}
		entry[leaf] = {
			counter: this.next(),
			data
		};
	}
	/**
	* 当前 S（GET /state 的响应体）。
	* 返回的 sections 是浅拷贝、pets 是新建对象——叶子对象本身共享，但写入永远整体替换，
	* 所以消费端不会读到写了一半的叶子。
	*/
	read() {
		return {
			sections: { ...this.sections },
			pets: Object.fromEntries(this.pets)
		};
	}
};

//#endregion
//#region src/host/helper-process.ts
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const defaultHelperMain = resolve(packageRoot, "runtime", "electron-helper", "main.js");
const BRIDGE_PREFIX = "dsh-pet-bridge:";
function resolveElectronPath(candidates = []) {
	const seen = new Set();
	const list = [];
	const push = (value) => {
		if (!value || seen.has(value)) return;
		seen.add(value);
		list.push(value);
	};
	for (const value of candidates) push(value);
	if (process.env.DSH_PET_ELECTRON_PATH) push(process.env.DSH_PET_ELECTRON_PATH);
	try {
		const resolved = require("electron");
		if (typeof resolved === "string" && resolved) push(resolved);
	} catch {}
	push(defaultElectronExe());
	return list.find((value) => existsSync(value));
}
function hasGraphicalDisplay() {
	if (process.platform !== "linux") return true;
	if (process.env.DSH_PET_DESKTOP_FORCE === "1") return true;
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
function dshHomeDir() {
	const userProfile = process.env.USERPROFILE || process.env.HOME || "";
	return process.env.DSH_HOME || join(userProfile, ".dsh");
}
/** 当前平台标识（win32 / darwin / linux） */
const PLAT = process.platform;
/** $DSH_HOME/electron 落地目录下，可执行文件的相对路径（按平台） */
const ELECTRON_REL = PLAT === "win32" ? "electron.exe" : PLAT === "darwin" ? join("Electron.app", "Contents", "MacOS", "Electron") : "electron";
function electronLandingDir() {
	return join(dshHomeDir(), "electron");
}
function defaultElectronExe() {
	return join(electronLandingDir(), ELECTRON_REL);
}
async function ensureElectronDownload(options = {}) {
	const version = options.version || process.env.DSH_PET_ELECTRON_VERSION || "43.3.0";
	const mirror = options.mirror || process.env.DSH_PET_ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
	const timeoutMs = options.timeoutMs ?? 10 * 60 * 1e3;
	const targetDir = electronLandingDir();
	const exe = defaultElectronExe();
	if (existsSync(exe)) return exe;
	const log = (message) => console.log(`[dsh-pet] ${message}`);
	const warn = (message) => console.warn(`[dsh-pet] ${message}`);
	const startedAt = Date.now();
	log(`Electron not found, downloading v${version} (${PLAT}-${process.arch}) ...`);
	mkdirSync(targetDir, { recursive: true });
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`Electron download timed out after ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
		let nextLogAt = Date.now() + 3e3;
		try {
			const zipPath = await downloadArtifact({
				version: `v${version}`,
				artifactName: "electron",
				mirrorOptions: { mirror: mirror.replace(/\/$/, "") + "/" },
				downloadOptions: {
					signal: controller.signal,
					quiet: true,
					getProgressCallback: async (progress) => {
						const now = Date.now();
						if (!progress.total || now < nextLogAt) return;
						nextLogAt = now + 3e3;
						log(`downloading ${(progress.transferred / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB`);
					}
				}
			});
			const seconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
			log(`download complete (${seconds}s), extracting to ${targetDir} ...`);
			await extract(zipPath, { dir: targetDir });
			if (!existsSync(exe)) throw new Error(`Electron zip extracted, but ${ELECTRON_REL} not found`);
			const readySeconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
			log(`ready in ${readySeconds}s: ${exe}`);
			return exe;
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		warn(`ensure failed: ${error instanceof Error ? error.message : String(error)}`);
		warn("desktop pet unavailable. Set DSH_PET_ELECTRON_PATH to an existing Electron, or retry later.");
		return void 0;
	}
}
function defaultLaunch(options = {}) {
	const electronPath = resolveElectronPath([options.electronPath]);
	if (!electronPath) throw new Error("dsh-pet: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.");
	const helperPath = options.helperPath || defaultHelperMain;
	return {
		command: electronPath,
		args: [helperPath]
	};
}
const HELPER_STOP_TIMEOUT_MS = 3e3;
const HELPER_STOP_GRACE_MS = 1e3;
function helperSpawnEnv(hostPid, extra) {
	const env = {
		...process.env,
		DSH_PET_HOST_PID: String(hostPid),
		...extra
	};
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}
var HelperProcess = class {
	constructor(options = {}, logger = console) {
		this.options = options;
		this.logger = logger;
		this.child = void 0;
		this.stopping = false;
		this.restartTimer = void 0;
		this.restartFailures = 0;
		this.lastStartAt = 0;
		this.stdoutBuffer = "";
	}
	start() {
		if (this.child || this.stopping) return this.child;
		this.lastStartAt = Date.now();
		const helperPath = this.options.helperPath || defaultHelperMain;
		const launch = this.options.command ? {
			command: this.options.command,
			args: this.options.args || [helperPath]
		} : defaultLaunch(this.options);
		const command = launch.command;
		const args = this.options.args || launch.args;
		const child = spawn(command, args, {
			cwd: this.options.cwd || packageRoot,
			env: helperSpawnEnv(process.pid, this.options.env),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		child.once("error", (error) => {
			this.logger.error?.(`dsh-pet desktop helper failed to start: ${error.message}`);
		});
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = void 0;
			if (!this.stopping) {
				this.logger.warn?.(`dsh-pet desktop helper exited (code=${String(code)}, signal=${String(signal)}); restarting`);
				this.scheduleRestart();
			}
		});
		child.stdout.on("data", (chunk) => {
			this.onStdoutChunk(String(chunk));
		});
		child.stderr.on("data", (chunk) => {
			const line = String(chunk).trim();
			if (line) this.logger.warn?.(`[dsh-pet desktop helper] ${line}`);
		});
		child.stdin?.on("error", () => {});
		return child;
	}
	/** stdout 按行缓冲：`dsh-pet-bridge:` 前缀整行 = 协议请求，其余 = 日志行 */
	onStdoutChunk(chunk) {
		this.stdoutBuffer += chunk;
		let nl;
		while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
			const line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (trimmed.startsWith(BRIDGE_PREFIX)) {
				this.handleBridgeLine(trimmed);
				continue;
			}
			this.logger.debug?.(`[dsh-pet desktop helper] ${trimmed}`);
		}
	}
	/** 处理一条协议请求：交给宿主 bridgeHandler，结果按 id POST 回 main.js 的回调服务器
	*  （cb 由请求行携带；不走 stdin —— Electron 主进程收不到 piped stdin） */
	async handleBridgeLine(line) {
		const child = this.child;
		if (!child?.stdin || !this.options.bridgeHandler) return;
		let req;
		try {
			req = JSON.parse(line.slice(BRIDGE_PREFIX.length));
		} catch {
			this.logger.warn?.("[dsh-pet desktop helper] bridge 协议行非法，已忽略");
			return;
		}
		if (typeof req.id !== "number") return;
		try {
			const resp = await this.options.bridgeHandler(req);
			this.sendBridgeResponse(req, resp);
		} catch (e) {
			this.sendBridgeResponse(req, {
				id: req.id,
				status: 500,
				contentType: "application/json; charset=utf-8",
				body: JSON.stringify({ error: `bridge handler error: ${e instanceof Error ? e.message : String(e)}` })
			});
		}
	}
	/** 把应答发回 main.js：优先 POST 到请求行携带的 cb（本地回调服务器）；无 cb 时回写 stdin（低版本兼容） */
	sendBridgeResponse(req, resp) {
		const cb = typeof req.cb === "string" && /^https?:[/][/]/.test(req.cb) ? req.cb : "";
		if (cb) {
			fetch(cb, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(resp)
			}).catch(() => {});
			return;
		}
		const child = this.child;
		if (!child?.stdin || child.stdin.destroyed) return;
		try {
			child.stdin.write(BRIDGE_PREFIX + JSON.stringify(resp) + "\n");
		} catch {}
	}
	/** 停止 helper：发 SIGTERM 即返回，**不等它退出**。宿主退出/插件卸载路径用它——
	*  宿主马上就没了（Windows 有 job 对象、POSIX 有 helper 自己的 host-liveness 兜底，见 issue #56）。
	*  **停止后要立刻重启的场景必须用 stopAndWait()**，否则新旧进程会短暂重叠（issue #64）。 */
	stop(reason = "plugin-disposed") {
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = void 0;
		this.logger.debug?.(`dsh-pet desktop helper stopping (${reason})`);
		const child = this.child;
		if (!child) return;
		child.kill();
	}
	/**
	* 停止 helper 并**等它真正退出**（issue #64）：原实现只发一次 SIGTERM 就返回、紧接着 spawn 新进程，
	* 而 Electron 收到 SIGTERM 后关窗、销毁 GPU/动画合成器是异步的（几百 ms 起）——旧窗口（旧大小）
	* 还没消失、新窗口（新大小）已经画出来，桌面上就短暂出现"两只宠物"。
	*   ① 先置 `stopping`（由 stop() 完成）：守护逻辑不得把这次主动停止误判成崩溃去自动重启；
	*   ② 只等 `exit`，**不等 `close`**：stdio 管道关闭远早于进程真正退出（实测 SIGTERM 后 ~10ms 就触发）；
	*   ③ 超时（默认 3s）升级 SIGKILL；SIGKILL 后再给 1s 宽限，仍未退出就放弃等待——
	*      配置保存绝不能因为一个退不掉的子进程而被无限挂住。
	*/
	async stopAndWait(reason = "plugin-disposed", timeoutMs = HELPER_STOP_TIMEOUT_MS) {
		this.stop(reason);
		const child = this.child;
		if (!child) return;
		await waitForChildExit(child, timeoutMs, () => {
			this.logger.warn?.(`dsh-pet desktop helper 未在 ${timeoutMs}ms 内退出，升级 SIGKILL（${reason}）`);
			try {
				child.kill("SIGKILL");
			} catch {}
		});
	}
	scheduleRestart() {
		if (this.restartTimer || this.stopping) return;
		if (helperRunIsStable(Date.now() - this.lastStartAt)) this.restartFailures = 0;
		else this.restartFailures += 1;
		if (shouldCircuitBreak(this.restartFailures, this.resolveMaxFailures())) {
			this.logger.error?.(`dsh-pet desktop helper crashed ${this.restartFailures} consecutive times; circuit breaker tripped, no more restarts. Fix the environment (e.g. DISPLAY/headless) or set DSH_PET_RESTART_MAX_FAILURES to raise the limit.`);
			return;
		}
		const base = this.resolveRestartBaseMs();
		const delay = restartBackoffDelayMs(this.restartFailures - 1, base);
		this.logger.warn?.(`dsh-pet desktop helper exited; restarting in ${Math.round(delay)}ms (attempt ${this.restartFailures}, consecutive-crash limit ${this.resolveMaxFailures()})`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = void 0;
			this.start();
		}, delay);
		this.restartTimer.unref?.();
	}
	/** 退避基值：DSH_PET_RESTART_BASE_MS（ms，>0）可调，默认 750。 */
	resolveRestartBaseMs() {
		return envPositiveInt(process.env.DSH_PET_RESTART_BASE_MS, RESTART_BASE_MS_DEFAULT);
	}
	/** 熔断阈值：DSH_PET_RESTART_MAX_FAILURES（次，>0）可调，默认 12。 */
	resolveMaxFailures() {
		return envPositiveInt(process.env.DSH_PET_RESTART_MAX_FAILURES, RESTART_MAX_FAILURES_DEFAULT);
	}
};
/**
* 等子进程真正退出（issue #64 的"停止要等干净"那一步）：
*   - 已经退出（exitCode/signalCode 有值）→ 立即 resolve，不挂监听；
*   - 只等 `exit`：`close` 只代表 stdio 管道关闭，远早于进程真正退出；
*   - 到 timeoutMs 调 onTimeout()（调用方升级 SIGKILL），再给 HELPER_STOP_GRACE_MS 宽限；
*   - 宽限到点仍未退出就 resolve——调用方（配置保存触发的重启）绝不能被无限挂住。
*/
function waitForChildExit(child, timeoutMs, onTimeout) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve$1) => {
		let giveUpTimer;
		const done = () => {
			clearTimeout(killTimer);
			if (giveUpTimer) clearTimeout(giveUpTimer);
			child.removeListener("exit", done);
			resolve$1();
		};
		const killTimer = setTimeout(() => {
			onTimeout();
			giveUpTimer = setTimeout(done, HELPER_STOP_GRACE_MS);
			giveUpTimer.unref?.();
		}, timeoutMs);
		killTimer.unref?.();
		child.once("exit", done);
	});
}
const HELPER_STABLE_MS = 3 * 60 * 1e3;
function restartBackoffDelayMs(consecutiveFailures, baseMs = 750) {
	const MAX = 3e4;
	const raw = baseMs * 2 ** Math.max(0, consecutiveFailures);
	return Math.min(raw, MAX);
}
function shouldCircuitBreak(consecutiveFailures, limit = 12) {
	return consecutiveFailures >= limit;
}
function helperRunIsStable(elapsedMs) {
	return elapsedMs >= HELPER_STABLE_MS;
}
/** 退避基值（ms）：默认 750 与旧版首延一致，DSH_PET_RESTART_BASE_MS 可调。 */
const RESTART_BASE_MS_DEFAULT = 750;
/** 熔断阈值（连续崩溃次数）：默认 12，DSH_PET_RESTART_MAX_FAILURES 可调。 */
const RESTART_MAX_FAILURES_DEFAULT = 12;
/** 非负整数 env 解析（非法/未设回落默认），供重启参数读取共用。 */
function envPositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

//#endregion
//#region src/host/index.ts
const name = "pet";
const inject = [
	"webServer",
	"agentDefaultModel",
	"credentials",
	"llm",
	"commands"
];
/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** 包内 assets 根 */
const PACKAGE_ROOT_ASSETS = join(PACKAGE_ROOT, "assets");
/** 包内表情包目录（表情包池的最后一环：assets/memes/<名称>.png） */
const PACKAGE_MEMES_DIR = join(PACKAGE_ROOT_ASSETS, "memes");
/** 路由前缀 */
const ROUTE_PREFIX = "/dsh-pet-7340";
/** 不同扩展名对应的 Content-Type 映射 */
const MIME = {
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mp4": "video/mp4",
	".png": "image/png",
	".json": "application/json; charset=utf-8",
	".jsonc": "application/json; charset=utf-8",
	".ttf": "font/ttf",
	".woff": "font/woff",
	".woff2": "font/woff2"
};
/**
* 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
* @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
*/
function resolveAsset(root, rel) {
	if (rel.length === 0) return void 0;
	const candidate = normalize(join(root, rel));
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	if (candidate !== root && !candidate.startsWith(rootWithSep)) return void 0;
	return candidate;
}
/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root, rel) {
	const candidate = resolveAsset(root, rel);
	return candidate && existsSync(candidate) ? candidate : void 0;
}
/**
* 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。
*
* Content-Length 必须取自**正在读的那个 fd**（open 事件里 fstat），不能先 stat 再另开流：用户往
* $DSH_HOME/dsh-pet/main-animation/webm/ 复制或同名覆盖素材时，stat 与真正开始读之间文件会被截断/
* 改写，一旦实际字节数少于声明的长度，这个响应就**永远不结束、也不报错**（浏览器表现为 stalled、
* 视频 loadeddata 永不触发且无 error）——正是 issue #62 现场"数据断供"的一种成因。同一个 fd 的
* fstat 拿到的大小与随后读出的字节天然一致。
*/
function sendFile(res, file, contentType) {
	const stream = createReadStream(file);
	stream.once("open", (fd) => {
		if (res.destroyed || res.writableEnded) {
			stream.destroy();
			return;
		}
		try {
			res.writeHead(200, {
				"content-type": contentType,
				"content-length": fstatSync(fd).size,
				"cache-control": "public, max-age=3600"
			});
		} catch {
			res.writeHead(200, {
				"content-type": contentType,
				"cache-control": "public, max-age=3600"
			});
		}
		stream.pipe(res);
	});
	stream.on("error", () => res.destroy());
	res.on("close", () => stream.destroy());
}
/** 该宠物是否参与桌面模式（Electron 透明窗） */
const isDesktopVisible = (display) => display === "desktop" || display === "both";
/** 发送 JSON 响应（headers 可选：如 no-cache 触发计数） */
function sendJson(res, status, obj$1, headers = {}) {
	const body = JSON.stringify(obj$1);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		...headers
	});
	res.end(body);
}
/** 发送纯文本响应（素材 404/400 等显式错误文案） */
function sendText(res, status, body) {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(body);
}
/** 收集请求体（文本） */
function readBody(req) {
	return new Promise((resolve2, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
//#region src/host/feed.ts
/**
 * 养成系统一期（host 侧纯逻辑 + 状态机）：鲸贝 🐚 / 饱食度 / 轻量心情 / 经验等级 / 手动喂食。
 *
 * 设计依据（已拍板，数值勿在此处自作主张改）：
 *   · 汇率：500,000 token（口径 inputTokens + outputTokens）= 1 鲸贝
 *   · 四档食物（价格/经验/饱食度/冷却）：零食 1/5/8/30s · 正餐 4/25/25/3min ·
 *     大餐 15/90/50/10min（Lv4 解锁）· 招牌「吃Token」30/120/80/30min（Lv8 解锁）
 *   · 饱食度：上限 100；活跃 12h 满→空；空闲（30min 无活动）与免打扰时段各降到 10%（取较小者）；
 *     工作加速：每 2 鲸贝（= 1,000,000 token）−1；≥ 95 拒绝喂食
 *   · 心情：基线下限 40、零惩罚；喂食 +3、任务成功（turn/end completed）+2（默认开）、
 *     12h 无互动后 −1.5/h（到基线即停，免打扰/空闲 ×0.1）
 *   · 经验：need(L) = 40 × L^1.4
 *   · 四层限流：① 鲸贝余额 ② 饱食度 ≥95 拒绝 ③ 整体 10s 防连点 + 每食物独立冷却
 *     ④ 每日 8 次软上限（超出仍可喂，经验 ×0.5；同类食物当日第 N 次系数 [1, 0.8, 0.6, 0.4]）
 *
 * 状态文件：%DSH_HOME%/dsh-pet/pet-state.json（原子写 + 备份轮换；写盘合并降频 ≤1 次/分钟）
 * 反回拨：lastTickAt（墙钟）+ lastTickMono（单调）双记；墙钟回拨 > 60s 时跳过本轮结算。
 */
const FEED_STATE_FILE = "pet-state.json";
const FEED_STATE_KEEP_BAK = 5;
const FEED_SAVE_MIN_INTERVAL_MS = 60 * 1e3;
const FEED_TAP_GUARD_MS = 10 * 1e3;
const FEED_START_SATIETY = 60;
const FEED_START_MOOD = 60;
const FEED_MAX_LEVEL = 99;
/** 拒绝喂食时播的表现（「宠物对过量操作应表达拒绝，而不是静默失败」） */
const FEED_REFUSE_ANIM = "点击回应-傲娇生气";
/** 四档规格：价格 / 经验 / 饱食度 / 冷却 / 解锁等级。改这里即改全档默认值 */
const FEED_TIER_SPEC = {
	snack: { label: "零食", emoji: "🍬", price: 1, exp: 5, satiety: 8, cooldownSec: 30, unlockLevel: 1 },
	meal: { label: "正餐", emoji: "🍱", price: 4, exp: 25, satiety: 25, cooldownSec: 180, unlockLevel: 1 },
	feast: { label: "大餐", emoji: "🍲", price: 15, exp: 90, satiety: 50, cooldownSec: 600, unlockLevel: 4 },
	signature: { label: "招牌", emoji: "🐟", price: 30, exp: 120, satiety: 80, cooldownSec: 1800, unlockLevel: 8 }
};
const FEED_TIER_ORDER = [
	"snack",
	"meal",
	"feast",
	"signature"
];
/** 四档食物用**现成进食动画**（assets/webm 里 20 个，名字必须逐字一致，否则点播 404） */
const FEED_TIER_FOODS = {
	snack: [
		"大口吃零食",
		"偷吃零食被抓住",
		"吃糖葫芦",
		"吃冰淇淋融化"
	],
	meal: [
		"吃早餐",
		"吃午餐",
		"吃晚餐",
		"吃白饭",
		"吃西瓜",
		"吃饺子",
		"吃汤圆",
		"吃年糕",
		"吃青团"
	],
	feast: [
		"吃大闸蟹",
		"涮火锅",
		"吃长寿面",
		"吃腊八粥",
		"吃重阳糕",
		"吃粽子"
	],
	signature: ["吃Token"]
};
/** 默认食物清单（配置里 foods 整段缺失/非法时用它）：20 项全量，数值取自 FEED_TIER_SPEC */
function feedDefaultFoods() {
	const out = [];
	for (const tier of FEED_TIER_ORDER) {
		const spec = FEED_TIER_SPEC[tier];
		for (const name$1 of FEED_TIER_FOODS[tier]) out.push({
			name: name$1,
			tier,
			price: spec.price,
			exp: spec.exp,
			satiety: spec.satiety,
			cooldownSec: spec.cooldownSec
		});
	}
	return out;
}
/** feed 段内置默认（assets/config.jsonc 的 feed 段是同一份，用户层可整段覆盖） */
function feedDefaults() {
	return {
		enabled: true,
		usageMetric: "workload",
		coin: {
			name: "鲸贝",
			emoji: "🐚",
			rate: 5e5,
			max: 999999999
		},
		quota: {
			mode: "accumulate",
			dailyFeedLimit: 8,
			overLimitExpRatio: 0.5,
			repeatDecay: [
				1,
				0.8,
				0.6,
				0.4
			],
			starterSnacks: 3
		},
		foods: feedDefaultFoods(),
		satiety: {
			max: 100,
			hoursToEmptyActive: 12,
			idleAfterMin: 30,
			idleRatio: 0.1,
			workCostPerCoin: 2,
			refuseAbove: 95
		},
		gift: {
			enabled: true,
			judgeEveryMin: 30,
			chance: 0.06,
			hungryBelow: 40,
			hungryChance: 0.3,
			starvingBelow: 15,
			starvingChance: 0.6,
			dailyLimit: 3,
			autoEatBelow: 30,
			tierWeights: {
				snack: 50,
				meal: 40,
				feast: 10
			}
		},
		preference: {
			rotate: "daily",
			lovedExpRatio: 1.5,
			dislikedExpRatio: 0.5
		},
		mood: {
			enabled: true,
			max: 100,
			baseline: 40,
			feedGain: 3,
			lovedFoodGain: 6,
			dislikedFoodGain: 1,
			petGain: 1,
			petDailyLimit: 20,
			taskSuccessGain: 2,
			giftGain: 3,
			decayAfterHours: 12,
			decayPerHour: 1.5,
			dndRatio: 0.1
		},
		level: {
			baseNeed: 40,
			exponent: 1.4,
			unlocks: {
				4: "feast",
				8: "signature"
			},
			workEventsExp: {
				enabled: false,
				turnEndSuccess: 2,
				todoWrite: 1
			}
		},
		dnd: {
			windows: [["21:30", "08:00"], ["12:00", "13:00"]],
			decayRatio: 0.1,
			giftSuppressed: true,
			useSystemState: true
		}
	};
}
/** 台词库（随机抽一句；不写进配置——它是表现层文案，改了不影响数值） */
const FEED_LINES = {
	snack: [
		"咔嚓咔嚓～",
		"小口小口，好好吃！",
		"零食是最棒的发明！"
	],
	meal: [
		"谢谢主人～",
		"这顿饭吃得好满足呢",
		"正餐就是踏实呀"
	],
	feast: [
		"哇——这也太丰盛了吧！",
		"今天过节吗？好开心！",
		"大餐！我要慢慢享用～"
	],
	signature: [
		"这口 token 真香！",
		"吃 Token 啦，主人也辛苦了～",
		"token 的味道，我最懂了！"
	]
};
const FEED_TOO_FULL_LINES = [
	"吃不下啦～",
	"肚子圆滚滚的，先歇一会儿",
	"再吃要撑坏啦…"
];
const FEED_BUSY_LINES = [
	"慢一点啦…",
	"还在嚼呢",
	"让我咽下去再说嘛"
];
const FEED_GIFT_LINES = [
	"谢谢你留给我～",
	"礼物我收下啦！",
	"是给我的吗？好开心！"
];
const FEED_LEVELUP_LINES = [
	"我升级啦！",
	"又长大一点点～",
	"等级提升！要继续陪我哦"
];
/** 今日「特别爱吃」的专属台词（经验 ×1.5、心情 +6） */
const FEED_LOVED_LINES = [
	"这个我最喜欢啦！",
	"哇——是今天最爱的那份！",
	"嘿嘿，就等你喂这个呢～"
];
/** 今日「不太爱吃」的委屈台词（经验 ×0.5、心情 +1 —— 但它**照样吃、绝不闹脾气**） */
const FEED_DISLIKED_LINES = [
	"…也、也不是不能吃",
	"这个嘛…我努力吃下去",
	"唔，今天不太想吃这个呢（但还是吃掉啦）"
];
/**
 * 随机送食物的叙事池（设计 §4.3）：from = 待喂区里显示的来源，
 * bubble = 气泡文案（{food} 会被替换成食物名），anim = 可复用的现成动画名。
 */
const FEED_GIFT_SOURCES = [
	{
		from: "隔壁的小猫",
		bubble: "隔壁的小猫叼来一份{food}，放下就跑了",
		anim: "拆礼物"
	},
	{
		from: "朋友送的",
		bubble: "朋友送来一份{food}，说是给你的",
		anim: "收红包"
	},
	{
		from: "天上掉的",
		bubble: "天上掉下来一份{food}？！接住了！",
		anim: "凭空生花"
	},
	{
		from: "送错门的",
		bubble: "外卖小哥送错门了…那我就收下啦",
		anim: "动物环绕"
	},
	{
		from: "柜子角落",
		bubble: "在柜子角落翻出来一份{food}",
		anim: "轻快记录"
	}
];
/** 自己吃掉（饱食度 < autoEatBelow 时的保底）时的台词 */
const FEED_SELF_EAT_LINES = [
	"我自己先吃啦～",
	"等不及了，先垫一口",
	"太饿啦，我开动咯"
];
/** 升级动画（设计 §14.2：升级瞬间的表现；两个动画名都随包发布）。
*  Lv4 起（解锁大餐那一级）用更热闹的「原地跳跃抓碎头顶物品」，其余升级用「凭空生花」。 */
const FEED_UPGRADE_ANIMS = {
	feast: "原地跳跃抓碎头顶物品",
	normal: "凭空生花"
};
/** 饿了的念叨（设计 §3.2/§14.4 的表现层）。
*  ⚠️ **低频**是硬要求：调研红线明确"状态低就一直提醒"是 VPet 最招人烦的一条。 */
const FEED_HUNGRY_LINES = {
	hungry: [
		"有点饿了呢…",
		"肚子好像空了",
		"是不是该吃饭啦？"
	],
	starving: [
		"好饿呀…",
		"肚子咕咕叫了",
		"能给我一点点吃的吗…"
	]
};
/** 普通饿：最多 25 分钟念叨一次；很饿：15 分钟一次（依然远低于"催"的程度） */
const FEED_HUNGRY_COOLDOWN_MS = 25 * 6e4;
const FEED_STARVING_COOLDOWN_MS = 15 * 6e4;
/** 吃到"今天爱吃"的食物后的兴奋期（设计 §6："心情表现更活跃"） */
const FEED_LOVED_BOOST_MS = 10 * 6e4;
/** Lv2 解锁的台词组「吃饭相关」（与基础台词混合抽取，避免老台词消失） */
const FEED_LINES_LV2 = {
	snack: [
		"边吃边聊两句好不好～",
		"这点心配茶刚好呢",
		"啊，嘴角沾到了吗？"
	],
	meal: [
		"今天的饭也好吃！",
		"吃饭的时候最放松啦",
		"你也要好好吃饭哦～"
	],
	feast: [
		"这么丰盛…我开动啦！",
		"这桌菜我得慢慢品～",
		"好香的味道，谢谢你！"
	],
	signature: ["这口 token 真香！", "吃饱了才有力气陪你呀"]
};
/** Lv5 解锁的台词组「关心你吃饭」+ 称呼变化（"我最好的人"） */
const FEED_LINES_LV5 = {
	snack: ["我最好的人，也来一口吗～", "偷偷分你一半好不好"],
	meal: [
		"你今天吃饭了吗？我陪你一起～",
		"我最好的人也要按时吃饭哦",
		"这顿吃完，我继续陪你干活～"
	],
	feast: ["我最好的人真舍得～那我不客气啦", "这么好的菜，想和你一起吃"],
	signature: ["吃 Token 啦，我最好的人也辛苦了～", "这一口下去，我又能陪你久一点"]
};
/**
 * 按等级取喂食台词池（设计 §7.3 的等级解锁）：
 *   Lv1 基础池 · Lv2+ 混入「吃饭相关」· Lv5+ 以「关心你吃饭」为主（留 1/4 概率用老台词）。
 * 偏好台词（❤️/🙂）与礼物台词优先级更高，不走这里。
 */
function feedLinePool(tier, level, useGift) {
	if (useGift) return FEED_GIFT_LINES;
	const base = FEED_LINES[tier] ?? FEED_LINES.snack;
	if (level >= 5 && Array.isArray(FEED_LINES_LV5[tier])) return Math.random() < 0.25 ? base : FEED_LINES_LV5[tier];
	if (level >= 2 && Array.isArray(FEED_LINES_LV2[tier])) return Math.random() < 0.5 ? FEED_LINES_LV2[tier] : base;
	return base;
}
function feedPick(arr) {
	return Array.isArray(arr) && arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : "";
}
function feedClamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}
function feedErrText(e) {
	return e instanceof Error ? e.message : String(e);
}
/** 数值兜底：有限且 ≥ min（≤ max 时）才用，否则默认 */
function feedNum(v, def, min, max) {
	const n = Number(v);
	if (!Number.isFinite(n) || n < min) return def;
	if (max !== void 0 && n > max) return def;
	return n;
}
function feedBool(v, def) {
	return typeof v === "boolean" ? v : def;
}
function feedStr(v, def) {
	return typeof v === "string" && v.length > 0 ? v : def;
}
function feedObj(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
}
/** 单项食物归一化：name 非空 + tier 合法是硬条件，其余数值按档位默认兜底 */
function feedNormalizeFood(raw) {
	const f = feedObj(raw);
	const name$1 = typeof f.name === "string" ? f.name.trim() : "";
	if (!name$1) return void 0;
	const tier = FEED_TIER_ORDER.includes(String(f.tier)) ? String(f.tier) : "snack";
	const spec = FEED_TIER_SPEC[tier];
	return {
		name: name$1,
		tier,
		price: feedNum(f.price, spec.price, 0),
		exp: feedNum(f.exp, spec.exp, 0),
		satiety: feedNum(f.satiety, spec.satiety, 0),
		cooldownSec: feedNum(f.cooldownSec, spec.cooldownSec, 0)
	};
}
/** 配置归一化：整段替换语义 ⇒ 每个子键都必须自己兜底（缺键绝不从内置默认补回） */
function feedNormalizeConfig(raw) {
	const d = feedDefaults();
	const o = feedObj(raw);
	const coin = feedObj(o.coin);
	const quota = feedObj(o.quota);
	const sat = feedObj(o.satiety);
	const gift = feedObj(o.gift);
	const pref = feedObj(o.preference);
	const mood = feedObj(o.mood);
	const level = feedObj(o.level);
	const dnd = feedObj(o.dnd);
	const foods = [];
	if (Array.isArray(o.foods)) for (const item of o.foods) {
		const f = feedNormalizeFood(item);
		if (f && !foods.some((x) => x.name === f.name)) foods.push(f);
	}
	const decay = Array.isArray(quota.repeatDecay) ? quota.repeatDecay.map((v) => feedNum(v, 1, 0)).filter((v) => v >= 0) : [];
	const windows = [];
	if (Array.isArray(dnd.windows)) for (const w of dnd.windows) {
		if (!Array.isArray(w) || w.length < 2) continue;
		const s = feedParseHm(w[0]);
		const e = feedParseHm(w[1]);
		if (s === null || e === null) continue;
		windows.push([s, e]);
	}
	return {
		enabled: feedBool(o.enabled, d.enabled),
		usageMetric: o.usageMetric === "total" ? "total" : "workload",
		coin: {
			name: feedStr(coin.name, d.coin.name),
			emoji: feedStr(coin.emoji, d.coin.emoji),
			rate: feedNum(coin.rate, d.coin.rate, 1),
			max: feedNum(coin.max, d.coin.max, 1)
		},
		quota: {
			mode: feedStr(quota.mode, d.quota.mode),
			dailyFeedLimit: feedNum(quota.dailyFeedLimit, d.quota.dailyFeedLimit, 0),
			overLimitExpRatio: feedNum(quota.overLimitExpRatio, d.quota.overLimitExpRatio, 0, 1),
			repeatDecay: decay.length > 0 ? decay : d.quota.repeatDecay,
			starterSnacks: feedNum(quota.starterSnacks, d.quota.starterSnacks, 0)
		},
		foods: foods.length > 0 ? foods : d.foods,
		satiety: {
			max: feedNum(sat.max, d.satiety.max, 1),
			hoursToEmptyActive: feedNum(sat.hoursToEmptyActive, d.satiety.hoursToEmptyActive, 0.001),
			idleAfterMin: feedNum(sat.idleAfterMin, d.satiety.idleAfterMin, 0),
			idleRatio: feedNum(sat.idleRatio, d.satiety.idleRatio, 0, 1),
			workCostPerCoin: feedNum(sat.workCostPerCoin, d.satiety.workCostPerCoin, 0),
			refuseAbove: feedNum(sat.refuseAbove, d.satiety.refuseAbove, 0)
		},
		gift: {
			enabled: feedBool(gift.enabled, d.gift.enabled),
			judgeEveryMin: feedNum(gift.judgeEveryMin, d.gift.judgeEveryMin, 1),
			chance: feedNum(gift.chance, d.gift.chance, 0, 1),
			hungryBelow: feedNum(gift.hungryBelow, d.gift.hungryBelow, 0),
			hungryChance: feedNum(gift.hungryChance, d.gift.hungryChance, 0, 1),
			starvingBelow: feedNum(gift.starvingBelow, d.gift.starvingBelow, 0),
			starvingChance: feedNum(gift.starvingChance, d.gift.starvingChance, 0, 1),
			dailyLimit: feedNum(gift.dailyLimit, d.gift.dailyLimit, 0),
			autoEatBelow: feedNum(gift.autoEatBelow, d.gift.autoEatBelow, 0),
			tierWeights: feedObj(gift.tierWeights)
		},
		preference: {
			rotate: feedStr(pref.rotate, d.preference.rotate),
			lovedExpRatio: feedNum(pref.lovedExpRatio, d.preference.lovedExpRatio, 0),
			dislikedExpRatio: feedNum(pref.dislikedExpRatio, d.preference.dislikedExpRatio, 0)
		},
		mood: {
			enabled: feedBool(mood.enabled, d.mood.enabled),
			max: feedNum(mood.max, d.mood.max, 1),
			baseline: feedNum(mood.baseline, d.mood.baseline, 0),
			feedGain: feedNum(mood.feedGain, d.mood.feedGain, 0),
			lovedFoodGain: feedNum(mood.lovedFoodGain, d.mood.lovedFoodGain, 0),
			dislikedFoodGain: feedNum(mood.dislikedFoodGain, d.mood.dislikedFoodGain, 0),
			petGain: feedNum(mood.petGain, d.mood.petGain, 0),
			petDailyLimit: feedNum(mood.petDailyLimit, d.mood.petDailyLimit, 0),
			taskSuccessGain: feedNum(mood.taskSuccessGain, d.mood.taskSuccessGain, 0),
			giftGain: feedNum(mood.giftGain, d.mood.giftGain, 0),
			decayAfterHours: feedNum(mood.decayAfterHours, d.mood.decayAfterHours, 0),
			decayPerHour: feedNum(mood.decayPerHour, d.mood.decayPerHour, 0),
			dndRatio: feedNum(mood.dndRatio, d.mood.dndRatio, 0, 1)
		},
		level: {
			baseNeed: feedNum(level.baseNeed, d.level.baseNeed, 0.001),
			exponent: feedNum(level.exponent, d.level.exponent, 0.001),
			unlocks: feedObj(level.unlocks),
			workEventsExp: {
				enabled: feedBool(feedObj(level.workEventsExp).enabled, d.level.workEventsExp.enabled),
				turnEndSuccess: feedNum(feedObj(level.workEventsExp).turnEndSuccess, d.level.workEventsExp.turnEndSuccess, 0),
				todoWrite: feedNum(feedObj(level.workEventsExp).todoWrite, d.level.workEventsExp.todoWrite, 0)
			}
		},
		dnd: {
			windows: windows.length > 0 ? windows : d.dnd.windows.map((w) => [feedParseHm(w[0]), feedParseHm(w[1])]),
			decayRatio: feedNum(dnd.decayRatio, d.dnd.decayRatio, 0, 1),
			giftSuppressed: feedBool(dnd.giftSuppressed, d.dnd.giftSuppressed),
			useSystemState: feedBool(dnd.useSystemState, d.dnd.useSystemState)
		}
	};
}
/** 升到下一级所需经验：need(L) = baseNeed × L^exponent（Math.round 与设计表逐项吻合：40/106/186/279/381/491/735） */
function feedNeed(level, cfg) {
	const L = Math.max(1, Math.floor(Number(level) || 1));
	return Math.max(1, Math.round(cfg.level.baseNeed * Math.pow(L, cfg.level.exponent)));
}
/** 本地日期键 YYYY-MM-DD（跨日重置用，按本地时区——用户感知的"今天"） */
function feedLocalDayKey(ms) {
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** "21:30" → 1290（当日分钟数）；非法 → null */
function feedParseHm(v) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
	if (!m) return null;
	const h = Number(m[1]);
	const mi = Number(m[2]);
	if (h > 23 || mi > 59) return null;
	return h * 60 + mi;
}
/** 免打扰窗口（分钟对；start > end 表示跨夜）已由归一化解析成数字，这里只做守卫 */
function feedDndWindows(cfg) {
	const out = [];
	for (const w of cfg.dnd.windows) {
		if (!Array.isArray(w) || w.length < 2) continue;
		const s = feedNum(w[0], -1, 0, 1439);
		const e = feedNum(w[1], -1, 0, 1439);
		if (s < 0 || e < 0 || s === e) continue;
		out.push([s, e]);
	}
	return out;
}
/** 某时刻是否落在免打扰时段（夜间 21:30–08:00 + 午休 12:00–13:00） */
function feedIsDndAt(ms, windows) {
	if (windows.length === 0) return false;
	const d = new Date(ms);
	const min = d.getHours() * 60 + d.getMinutes();
	for (const [s, e] of windows) if (s < e) {
		if (min >= s && min < e) return true;
	} else if (min >= s || min < e) return true;
	return false;
}
/** 区间内的免打扰边界（进入/退出时刻），供分段积分用；跨夜窗口按天展开（-1 天起，覆盖跨夜那一段） */
function feedDndBoundaries(fromMs, toMs, windows) {
	if (windows.length === 0) return [];
	const out = [];
	const day = /* @__PURE__ */ new Date(fromMs);
	day.setHours(0, 0, 0, 0);
	const base0 = day.getTime();
	const dayMs = 864e5;
	const days = Math.min(64, Math.ceil((toMs - base0) / dayMs) + 1);
	for (let i = -1; i <= days; i++) {
		const base = base0 + i * dayMs;
		for (const [s, e] of windows) {
			const st = base + s * 6e4;
			let en = base + e * 6e4;
			if (en <= st) en += dayMs;
			if (st > fromMs && st < toMs) out.push(st);
			if (en > fromMs && en < toMs) out.push(en);
		}
	}
	return out.sort((a, b) => a - b);
}
/** 系数：空闲（距上次活动超过 idleAfterMin）与免打扰各把速率降到 idleRatio / dndRatio，**取较小者** */
function feedSlowRatio(midMs, idleFromMs, cfg, windows) {
	const idle = midMs >= idleFromMs ? cfg.satiety.idleRatio : 1;
	const dnd = feedIsDndAt(midMs, windows) ? cfg.dnd.decayRatio : 1;
	return Math.min(idle, dnd);
}
/** 心情衰减的区间边界（空闲起点 + 免打扰边界），与饱食度同一套分段 */
function feedSegments(fromMs, toMs, extraCut, windows) {
	const cuts = [fromMs, toMs];
	for (const b of feedDndBoundaries(fromMs, toMs, windows)) cuts.push(b);
	if (Number.isFinite(extraCut) && extraCut > fromMs && extraCut < toMs) cuts.push(extraCut);
	cuts.sort((a, b) => a - b);
	const out = [];
	for (let i = 0; i + 1 < cuts.length; i++) {
		const a = cuts[i];
		const b = cuts[i + 1];
		if (b > a) out.push([a, b]);
	}
	return out;
}
/** 时间衰减积分：活跃 12h 满→空（≈8.33/h）；空闲/免打扰分段取 10%。分段积分保证"跨夜/跨空闲"也算得准 */
function feedSatietyDecay(fromMs, toMs, lastActiveMs, cfg, windows) {
	if (!(toMs > fromMs)) return 0;
	const perMs = cfg.satiety.max / (cfg.satiety.hoursToEmptyActive * 36e5);
	const idleFrom = lastActiveMs > 0 ? lastActiveMs + cfg.satiety.idleAfterMin * 6e4 : Number.POSITIVE_INFINITY;
	let out = 0;
	for (const [a, b] of feedSegments(fromMs, toMs, idleFrom, windows)) out += (b - a) * perMs * feedSlowRatio((a + b) / 2, idleFrom, cfg, windows);
	return out;
}
/** 心情衰减积分：距上次互动 decayAfterHours 之后才开始 −decayPerHour，**降到基线即停**（由调用方 clamp） */
function feedMoodDecay(fromMs, toMs, lastInteractMs, cfg, windows) {
	if (!cfg.mood.enabled || !(toMs > fromMs)) return 0;
	const quietFrom = (lastInteractMs > 0 ? lastInteractMs : fromMs) + cfg.mood.decayAfterHours * 36e5;
	if (toMs <= quietFrom) return 0;
	const start = Math.max(fromMs, quietFrom);
	const perMs = cfg.mood.decayPerHour / 36e5;
	const idleFrom = Number.POSITIVE_INFINITY;
	const dndOnly = (mid) => feedIsDndAt(mid, windows) ? cfg.mood.dndRatio : 1;
	let out = 0;
	for (const [a, b] of feedSegments(start, toMs, Number.POSITIVE_INFINITY, windows)) out += (b - a) * perMs * dndOnly((a + b) / 2);
	return out;
}
function feedFmtSec(ms) {
	const sec = Math.max(0, Math.ceil(ms / 1e3));
	if (sec < 60) return sec + " 秒";
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	return s > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${m} 分钟`;
}
function feedFmtNum(v) {
	const n = Number(v) || 0;
	return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}
/** 一只宠物的初始状态（新宠物入库时用） */
function feedBlankPet(nowMs) {
	const key = feedLocalDayKey(nowMs);
	return {
		satiety: FEED_START_SATIETY,
		mood: FEED_START_MOOD,
		exp: 0,
		expLifetime: 0,
		level: 1,
		lastTickAt: 0,
		lastTickMono: 0,
		lastActiveAt: nowMs,
		lastInteractAt: nowMs,
		lastFeedAt: 0,
		petCountToday: 0,
		today: {
			date: key,
			fedCount: 0,
			foodCounts: {}
		},
		cooldowns: {},
		pendingGifts: [],
		preference: {
			date: key,
			loved: "",
			disliked: ""
		},
		giftCountToday: 0,
		lastGiftAt: 0,
		/** 上次"饿了念叨"的时刻（低频提醒用） */
		lastHungryAt: 0,
		/** 吃到今日最爱的"兴奋期"截止时刻（设计 §6：表现更活跃） */
		lovedBoostUntil: 0
	};
}
/** 既有状态就地补齐/夹取（手改过、旧版本、写入中断都可能让字段缺失或越界） */
function feedNormalizePet(p, nowMs) {
	const q = p;
	const key = feedLocalDayKey(nowMs);
	q.satiety = feedClamp(feedNum(q.satiety, FEED_START_SATIETY, 0), 0, 1e9);
	q.mood = feedNum(q.mood, FEED_START_MOOD, 0);
	q.exp = feedNum(q.exp, 0, 0);
	q.expLifetime = feedNum(q.expLifetime, 0, 0);
	q.level = Math.max(1, Math.min(FEED_MAX_LEVEL, Math.floor(feedNum(q.level, 1, 1))));
	q.lastTickAt = feedNum(q.lastTickAt, 0, 0);
	q.lastTickMono = feedNum(q.lastTickMono, 0, 0);
	q.lastActiveAt = feedNum(q.lastActiveAt, nowMs, 0);
	q.lastInteractAt = feedNum(q.lastInteractAt, nowMs, 0);
	q.lastFeedAt = feedNum(q.lastFeedAt, 0, 0);
	q.petCountToday = feedNum(q.petCountToday, 0, 0);
	q.giftCountToday = feedNum(q.giftCountToday, 0, 0);
	q.lastGiftAt = feedNum(q.lastGiftAt, 0, 0);
	q.lastHungryAt = feedNum(q.lastHungryAt, 0, 0);
	q.lovedBoostUntil = feedNum(q.lovedBoostUntil, 0, 0);
	const today = feedObj(q.today);
	q.today = {
		date: feedStr(today.date, key),
		fedCount: feedNum(today.fedCount, 0, 0),
		foodCounts: feedObj(today.foodCounts)
	};
	q.cooldowns = feedObj(q.cooldowns);
	q.pendingGifts = Array.isArray(q.pendingGifts) ? q.pendingGifts.filter((g) => g && typeof g === "object" && typeof g.food === "string") : [];
	const pref = feedObj(q.preference);
	q.preference = {
		date: feedStr(pref.date, key),
		loved: typeof pref.loved === "string" ? pref.loved : "",
		disliked: typeof pref.disliked === "string" ? pref.disliked : ""
	};
	return q;
}
/** 分钟数 → "HH:MM"（配置回显用） */
function feedHmText(min) {
	const m = feedClamp(Math.floor(Number(min) || 0), 0, 1439);
	return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}
/**
 * 养成系统状态机（与 DSH ctx 解耦：所有外部依赖都从 deps 注入）。
 *
 * 这样做的两个理由：
 *   1. host 集成层只负责接线（事件 → handleSessionEvent、定时器 → tick、路由 → tryFeed/status）；
 *   2. **同一份逻辑能被离线影子服务驱动** —— 改完不必重启 DSH 就能 curl 出真实数值变化
 *      （见 F:\Harness\test\dsh-pet-feed-harness.mjs），最后再重启一次做真机端到端确认。
 *
 * deps: { dir, readConfig(), log?, nowWall?, nowMono? }
 */
function createFeedSystem(deps) {
	const dir = deps.dir;
	const readConfig = deps.readConfig;
	const log = typeof deps.log === "function" ? deps.log : () => {};
	const onFed = typeof deps.onFed === "function" ? deps.onFed : null;
	/** 收到礼物/自主进食时通知宿主层（写气泡 + 点播礼物动画） */
	const onGift = typeof deps.onGift === "function" ? deps.onGift : null;
	/** 数值变化后把一份摘要写给宿主层（落进 /state 的 pets.<id>.feed 叶子，前端 1s 轮询即可拿到，
	*  HUD / 角标 / 心情权重都靠它，不必各自再发请求） */
	const onState = typeof deps.onState === "function" ? deps.onState : null;
	/** 飘字：喂食 / 升级 / 收礼 / 进鲸贝的瞬间，把"这次变了多少"推给宿主层（前端飘 2~3 秒淡出） */
	const onFloat = typeof deps.onFloat === "function" ? deps.onFloat : null;
	/** 说一句（饿了的低频念叨等）——复用气泡槽 */
	const onSay = typeof deps.onSay === "function" ? deps.onSay : null;
	const nowWall = typeof deps.nowWall === "function" ? deps.nowWall : () => Date.now();
	const nowMono = typeof deps.nowMono === "function" ? deps.nowMono : () => performance.now();
	const statePath = join(dir, FEED_STATE_FILE);
	let state = null;
	let dirty = false;
	let lastSaveAt = 0;
	let lastTickLogAt = 0;
	/** 每轮都重读配置（坑 6：开关判定必须在**每轮执行时**，不能只看注册定时器那一刻） */
	const cfg = () => {
		try {
			return feedNormalizeConfig(feedObj(readConfig())?.main?.feed);
		} catch (e) {
			log("配置读取失败，已按内置默认处理：" + feedErrText(e));
			return feedNormalizeConfig(void 0);
		}
	};
	/** 当前生效宠物（合并器保证 id 全局唯一）；name 缺失按 id 兜底 */
	const petEntries = () => {
		try {
			const out = [];
			for (const conf of Object.values(readConfig())) {
				if (!Array.isArray(conf?.pets)) continue;
				for (const p of conf.pets) if (p && typeof p.id === "string" && p.id) out.push({
					id: String(p.id),
					name: String(p.name || p.id)
				});
			}
			return out;
		} catch {
			return [];
		}
	};
	const petIds = () => petEntries().map((e) => e.id);
	const petName = (id) => petEntries().find((e) => e.id === id)?.name ?? id;
	const hasPet = (id) => petIds().includes(id);
	const defaultPetId = () => petIds()[0] ?? "main";
	const blankState = () => ({
		version: 1,
		shared: {
			coin: 0,
			coinLifetime: 0,
			tokenCarry: 0,
			workTokenCarry: 0,
			tokensTotal: 0,
			startedAt: 0,
			starterGiven: false,
			/** 上次"随机送食物"判定时刻（单调，判定频率 = gift.judgeEveryMin） */
			lastGiftJudgeAt: 0
		},
		pets: {}
	});
	/** 状态归一化：手改过 / 旧版本 / 写盘中断都可能让字段缺失或越界，逐字段兜底后再用 */
	const normalizeState = (raw) => {
		const st = blankState();
		const o = feedObj(raw);
		const sh = feedObj(o.shared);
		st.shared.coin = feedNum(sh.coin, 0, 0);
		st.shared.coinLifetime = feedNum(sh.coinLifetime, 0, 0);
		st.shared.tokenCarry = feedNum(sh.tokenCarry, 0, 0);
		st.shared.workTokenCarry = feedNum(sh.workTokenCarry, 0, 0);
		st.shared.tokensTotal = feedNum(sh.tokensTotal, 0, 0);
		st.shared.startedAt = feedNum(sh.startedAt, 0, 0);
		st.shared.starterGiven = feedBool(sh.starterGiven, false);
		st.shared.lastGiftJudgeAt = feedNum(sh.lastGiftJudgeAt, 0, 0);
		for (const [id, p] of Object.entries(feedObj(o.pets))) if (p && typeof p === "object" && !Array.isArray(p)) st.pets[id] = feedNormalizePet(p, nowWall());
		return st;
	};
	const load = () => {
		if (state) return state;
		let raw = "";
		try {
			raw = readFileSync(statePath, "utf8");
		} catch {
			raw = "";
		}
		if (raw) try {
			state = normalizeState(JSON.parse(raw));
		} catch (e) {
			log(`状态文件损坏已备份，将从空状态重建：${statePath}（${feedErrText(e)}）`);
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(`${statePath}.corrupt-${nowWall()}`, raw, "utf8");
			} catch {}
			state = blankState();
			dirty = true;
		}
		else state = blankState();
		if (!state.shared.startedAt) state.shared.startedAt = nowWall();
		return state;
	};
	/** 备份轮换：只保留最近 FEED_STATE_KEEP_BAK 份 .bak-*（文件名时间戳等长 ⇒ 字典序即时间序） */
	const rotateBackups = () => {
		try {
			const prefix = FEED_STATE_FILE + ".bak-";
			const files = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
			for (let i = 0; i < files.length - FEED_STATE_KEEP_BAK; i++) try {
				unlinkSync(join(dir, files[i]));
			} catch {}
		} catch {}
	};
	/** 原子写：先 copy 旧档为备份 → 写 .tmp → rename 覆盖（rename 在 Windows 上可原子替换既有文件） */
	const save = (force) => {
		const now = nowWall();
		if (!force && (!dirty || now - lastSaveAt < FEED_SAVE_MIN_INTERVAL_MS)) return false;
		const st = load();
		try {
			mkdirSync(dir, { recursive: true });
			if (existsSync(statePath)) try {
				copyFileSync(statePath, `${statePath}.bak-${now}`);
			} catch {}
			const tmp = `${statePath}.tmp`;
			writeFileSync(tmp, JSON.stringify(st, null, 2), "utf8");
			renameSync(tmp, statePath);
			rotateBackups();
			dirty = false;
			lastSaveAt = now;
			return true;
		} catch (e) {
			log("状态写盘失败：" + feedErrText(e));
			return false;
		}
	};
	/** 新手保底：首次建立状态时送 N 份零食进「待喂」区（鲸贝起步为 0，第一天也有东西可喂） */
	const grantStarter = (p) => {
		const c = cfg();
		const n = Math.max(0, Math.floor(c.quota.starterSnacks));
		if (n <= 0) return;
		const pool = c.foods.filter((f) => f.tier === "snack");
		const list = pool.length > 0 ? pool : c.foods;
		for (let i = 0; i < n && list.length > 0; i++) p.pendingGifts.push({
			food: feedPick(list).name,
			from: "新手礼包",
			at: nowWall()
		});
	};
	const ensurePet = (petId, nowMs) => {
		const st = load();
		const now = nowMs ?? nowWall();
		let p = st.pets[petId];
		if (!p) {
			p = feedBlankPet(now);
			st.pets[petId] = p;
			dirty = true;
			if (!st.shared.starterGiven) {
				grantStarter(p);
				st.shared.starterGiven = true;
			}
		} else feedNormalizePet(p, now);
		return p;
	};
	/** 只读预览（不建条目、不标脏）：状态查询与"能否喂"判定都用它，避免查询产生副作用 */
	const peekPet = (petId, nowMs) => {
		const p = load().pets[petId];
		return p ? feedNormalizePet(p, nowMs ?? nowWall()) : feedBlankPet(nowMs ?? nowWall());
	};
	const markActive = (nowMs) => {
		const now = nowMs ?? nowWall();
		for (const id of petIds()) ensurePet(id, now).lastActiveAt = now;
		dirty = true;
	};
	const addMoodAll = (gain, nowMs) => {
		const c = cfg();
		if (!c.mood.enabled || !(gain > 0)) return false;
		const now = nowMs ?? nowWall();
		for (const id of petIds()) {
			const p = ensurePet(id, now);
			p.mood = feedClamp(p.mood + gain, c.mood.baseline, c.mood.max);
		}
		dirty = true;
		return true;
	};
	/** 今日偏好（设计 §6）：每天从**已解锁**食物里随机各抽 1 个「特别爱吃 / 不太爱吃」。
	*  只影响经验（×1.5 / ×0.5）与心情（+6 / +1），**饱食度照加**——它照样吃、绝不闹脾气。 */
	const ensurePreference = (petId, p, c, now) => {
		const key = feedLocalDayKey(now);
		const pref = p.preference ?? {};
		if (pref.date === key && (pref.loved || pref.disliked)) return pref;
		const pool = c.foods.filter((f) => p.level >= (FEED_TIER_SPEC[f.tier]?.unlockLevel ?? 1));
		const pick1 = () => pool.length > 0 ? feedPick(pool).name : "";
		let loved = pick1();
		let disliked = pick1();
		for (let i = 0; i < 20 && pool.length > 1 && disliked === loved; i++) disliked = pick1();
		p.preference = {
			date: key,
			loved,
			disliked
		};
		dirty = true;
		return p.preference;
	};
	/** 偏好 → 经验系数 / 心情增益 / 专属台词（三处共用，避免各算一份） */
	const preferenceEffect = (p, foodName, c) => {
		const pref = p.preference ?? {};
		const loved = pref.loved === foodName;
		const disliked = pref.disliked === foodName;
		return {
			loved,
			disliked,
			expRatio: loved ? c.preference.lovedExpRatio : disliked ? c.preference.dislikedExpRatio : 1,
			moodGain: !c.mood.enabled ? 0 : loved ? c.mood.lovedFoodGain : disliked ? c.mood.dislikedFoodGain : c.mood.feedGain,
			line: loved ? feedPick(FEED_LOVED_LINES) : disliked ? feedPick(FEED_DISLIKED_LINES) : ""
		};
	};
	/** 档位权重抽一个档（随机送食物用） */
	const pickTierByWeight = (weights) => {
		const pairs = [];
		let total = 0;
		for (const tier of FEED_TIER_ORDER) {
			const w = feedNum(weights?.[tier], 0, 0);
			if (w > 0) {
				pairs.push([tier, w]);
				total += w;
			}
		}
		if (total <= 0) return "snack";
		let roll = Math.random() * total;
		for (const [tier, w] of pairs) {
			roll -= w;
			if (roll < 0) return tier;
		}
		return pairs[pairs.length - 1][0];
	};
	/**
	 * 随机送食物（设计 §4，保底机制）：每 gift.judgeEveryMin 分钟判定一次；
	 * 概率随饱食度提高（6% / <40 → 30% / <15 → 60%）；日限 3 次；免打扰时段不判定。
	 * 送达后：饱食度 ≥ autoEatBelow → 进「待喂」区等手动喂；< autoEatBelow → **它自己吃掉**（保底）。
	 * 返回本轮发生的事件数组（供日志/测试/气泡）。
	 */
	const maybeGift = (c, st, now) => {
		if (!c.gift.enabled) return [];
		const judgeMs = Math.max(1, c.gift.judgeEveryMin) * 6e4;
		const last = feedNum(st.shared.lastGiftJudgeAt, 0, 0);
		if (last > 0 && now - last < judgeMs) return [];
		st.shared.lastGiftJudgeAt = now;
		dirty = true;
		/** 免打扰时段不敲门（设计 §4.2）——开关在 **dnd** 段（dnd.giftSuppressed），不是 gift 段 */
		if (c.dnd.giftSuppressed && feedIsDndAt(now, feedDndWindows(c))) {
			dirty = true;
			return [];
		}
		const out = [];
		for (const petId of petIds()) {
			const p = ensurePet(petId, now);
			if (p.giftCountToday >= c.gift.dailyLimit) continue;
			const chance = p.satiety < c.gift.starvingBelow ? c.gift.starvingChance : p.satiety < c.gift.hungryBelow ? c.gift.hungryChance : c.gift.chance;
			if (!(Math.random() < chance)) continue;
			const tier = pickTierByWeight(c.gift.tierWeights);
			const pool = c.foods.filter((f) => f.tier === tier);
			if (pool.length === 0) continue;
			const food = feedPick(pool);
			const src = feedPick(FEED_GIFT_SOURCES) ?? {
				from: "邻居",
				bubble: "有人送来一份{food}",
				anim: "拆礼物"
			};
			p.giftCountToday += 1;
			p.lastGiftAt = now;
			const autoEat = p.satiety < c.gift.autoEatBelow;
			const base = {
				petId,
				food: food.name,
				tier: food.tier,
				from: src.from,
				anim: src.anim,
				bubble: String(src.bubble).replace("{food}", food.name),
				autoEat
			};
			if (!autoEat) {
				p.pendingGifts.push({
					food: food.name,
					from: src.from,
					at: now
				});
				out.push(base);
				/** 飘字：礼物进"待喂"区（数值未变，只飘一份礼物提示） */
				if (onFloat) try {
					onFloat(petId, {
						kind: "gift",
						items: [`🎁 ${food.name}`],
						anim: src.anim
					});
				} catch (e) {
					log("飘字回调异常：" + feedErrText(e));
				}
				continue;
			}
			/** 自主进食（保底）：免鲸贝、免冷却，按档位基准值给收益（不乘偏好/递减——保底要稳） */
			const before = p.satiety;
			p.satiety = feedClamp(p.satiety + food.satiety, 0, c.satiety.max);
			p.exp += food.exp;
			p.expLifetime += food.exp;
			const levelUps = [];
			while (p.level < FEED_MAX_LEVEL && p.exp >= feedNeed(p.level, c)) {
				p.exp -= feedNeed(p.level, c);
				p.level += 1;
				levelUps.push(p.level);
			}
			if (c.mood.enabled) p.mood = feedClamp(p.mood + c.mood.giftGain, c.mood.baseline, c.mood.max);
			p.lastInteractAt = now;
			out.push({
				...base,
				satietyGain: food.satiety,
				satiety: p.satiety,
				satietyBefore: before,
				expGain: food.exp,
				level: p.level,
				levelUp: levelUps.length > 0,
				line: feedPick(FEED_SELF_EAT_LINES)
			});
			/** 飘字：它自己吃掉（保底）也要看得见收益 */
			if (onFloat) try {
				const items = [`🍚+${food.satiety}`, `⭐+${food.exp}`, `😊+${c.mood.giftGain}`];
				if (levelUps.length > 0) items.push(`Lv${p.level} ↑`);
				onFloat(petId, {
					kind: "gift",
					items,
					anim: src.anim
				});
			} catch (e) {
				log("飘字回调异常：" + feedErrText(e));
			}
		}
		return out;
	};
	/**
	 * 把一份**数值摘要**写给宿主层 → 落进 `/state` 的 `pets.<id>.feed` 叶子。
	 * 悬停 HUD、角标、心情→动画权重都从这一份读（前端本来就 1s 轮询 /state，不必再各发请求）。
	 */
	const publishState = (c, st) => {
		if (!onState) return;
		const now = nowWall();
		for (const petId of petIds()) {
			const p = ensurePet(petId, now);
			const key = feedLocalDayKey(now);
			onState(petId, {
				coin: st.shared.coin,
				coinName: c.coin.name,
				coinEmoji: c.coin.emoji,
				coinLifetime: st.shared.coinLifetime,
				tokenCarry: st.shared.tokenCarry,
				tokensPerCoin: Math.max(1, Math.round(c.coin.rate)),
				satiety: Math.round(p.satiety * 10) / 10,
				satietyMax: c.satiety.max,
				mood: Math.round(p.mood * 10) / 10,
				moodMax: c.mood.max,
				moodBaseline: c.mood.baseline,
				level: p.level,
				exp: p.exp,
				expNeed: feedNeed(p.level, c),
				todayFed: p.today.date === key ? p.today.fedCount : 0,
				dailyLimit: c.quota.dailyFeedLimit,
				gifts: (p.pendingGifts ?? []).length,
				refuseNow: p.satiety >= c.satiety.refuseAbove,
				hungry: p.satiety < 30,
				/** 0~15：更饿（角标更明显、念叨更勤、动作更安静） */
				starving: p.satiety < 15,
				/** 吃到今日最爱的兴奋期内（前端抬"玩耍"权重 = 表现更活跃） */
				lovedBoost: now < (Number(p.lovedBoostUntil) || 0),
				lovedBoostUntil: Number(p.lovedBoostUntil) || 0,
				preference: p.preference ?? {},
				at: now
			});
		}
	};
	/** 鲸贝累加：零头（tokenCarry）**必须持久化** —— 一条 assistant/message 可能只有一万 token，
	*  每次取整就等于永久丢掉它（在系统眼里等于没干活）。工作加速池（workTokenCarry）同源同理由。 */
	const accrueTokens = (tokens) => {
		const c = cfg();
		if (!c.enabled || !(tokens > 0)) return null;
		const st = load();
		const sh = st.shared;
		sh.tokensTotal += tokens;
		sh.tokenCarry += tokens;
		sh.workTokenCarry += tokens;
		const per = Math.max(1, Math.round(c.coin.rate));
		const gain = Math.floor(sh.tokenCarry / per);
		if (gain > 0) {
			sh.tokenCarry -= gain * per;
			sh.coin = Math.min(c.coin.max, sh.coin + gain);
			sh.coinLifetime = Math.min(c.coin.max, sh.coinLifetime + gain);
		}
		for (const id of petIds()) ensurePet(id);
		/** 飘字：赚到鲸贝的瞬间（🐚+N）——"干活 → 有回报"最直接的反馈，也让零头进位看得见 */
		if (gain > 0 && onFloat) try {
			for (const id of petIds()) onFloat(id, {
				kind: "coin",
				items: [`${c.coin.emoji}+${gain}`]
			});
		} catch (e) {
			log("飘字回调异常（数值已生效）：" + feedErrText(e));
		}
		dirty = true;
		return {
			tokens,
			gain,
			coin: sh.coin,
			carry: sh.tokenCarry,
			tokensTotal: sh.tokensTotal
		};
	};
	/** DSH 会话事件 → 数值（usage 口径、活跃度、任务成功心情）。整段包在 try 里由调用方兜底 */
	const handleSessionEvent = (session, event) => {
		const type = event?.type;
		if (!type) return;
		const c = cfg();
		if (!c.enabled) return;
		const now = nowWall();
		if (type === "assistant/message") {
			const u = feedObj(feedObj(event?.data).usage);
			const inTok = feedNum(u.inputTokens, 0, 0);
			const outTok = feedNum(u.outputTokens, 0, 0);
			const totTok = feedNum(u.totalTokens, 0, 0);
			const n = c.usageMetric === "total" ? totTok > 0 ? totTok : inTok + outTok : inTok + outTok;
			if (n > 0) {
				const r = accrueTokens(n);
				if (r && r.gain > 0) log(`token +${n} → ${c.coin.name} +${r.gain}（余额 ${r.coin}，零头 ${r.carry}）`);
			}
			markActive(now);
			return;
		}
		if (type === "turn/start" || type === "tool/call" || type === "tool/result" || type === "user/message" || type === "step/start") {
			markActive(now);
			return;
		}
		if (type === "turn/end") {
			markActive(now);
			/** 任务成功 +2（默认开 ——「你干活，它高兴」）；失败/报错**绝不扣任何数值** */
			if (String(feedObj(feedObj(event?.data).reason).kind ?? "") === "completed") addMoodAll(c.mood.taskSuccessGain, now);
		}
	};
	/** 一轮结算：时间衰减（分段积分）+ 工作加速 + 心情衰减 + 跨日重置 + 合并写盘。60s 一次 */
	const tick = () => {
		const c = cfg();
		const st = load();
		if (!c.enabled) {
			save(false);
			return {
				ok: true,
				enabled: false
			};
		}
		const wallNow = nowWall();
		const monoNow = nowMono();
		const windows = feedDndWindows(c);
		const ids = petIds();
		for (const id of ids) ensurePet(id, wallNow);
		/** 工作加速：每 workCostPerCoin 鲸贝（= rate × N token）−1 饱食度；余数留在池里下轮继续 */
		const perWork = Math.max(1, Math.round(c.coin.rate * Math.max(0, c.satiety.workCostPerCoin)));
		const workCost = c.satiety.workCostPerCoin > 0 ? Math.floor(st.shared.workTokenCarry / perWork) : 0;
		if (workCost > 0) st.shared.workTokenCarry -= workCost * perWork;
		const report = [];
		for (const id of ids) {
			const p = ensurePet(id, wallNow);
			const key = feedLocalDayKey(wallNow);
			if (p.today.date !== key) {
				p.today = {
					date: key,
					fedCount: 0,
					foodCounts: {}
				};
				p.petCountToday = 0;
				p.giftCountToday = 0;
			}
			let elapsedMs = 0;
			let rolledBack = false;
			if (p.lastTickAt > 0) {
				const wallDelta = wallNow - p.lastTickAt;
				if (wallDelta < -6e4) rolledBack = true;
				else if (p.lastTickMono > 0 && monoNow >= p.lastTickMono) elapsedMs = monoNow - p.lastTickMono;
				else elapsedMs = Math.max(0, wallDelta);
				elapsedMs = Math.min(elapsedMs, 7 * 864e5);
			}
			const beforeSatiety = p.satiety;
			const beforeMood = p.mood;
			if (!rolledBack && elapsedMs > 0) {
				p.satiety = feedClamp(p.satiety - feedSatietyDecay(p.lastTickAt, wallNow, p.lastActiveAt, c, windows), 0, c.satiety.max);
				if (c.mood.enabled) p.mood = feedClamp(p.mood - feedMoodDecay(p.lastTickAt, wallNow, p.lastInteractAt, c, windows), c.mood.baseline, c.mood.max);
				if (workCost > 0) p.satiety = feedClamp(p.satiety - workCost, 0, c.satiety.max);
			}
			p.lastTickAt = wallNow;
			p.lastTickMono = monoNow;
			dirty = true;
			report.push({
				id,
				elapsedMs,
				rolledBack,
				satiety: p.satiety,
				satietyDelta: p.satiety - beforeSatiety,
				mood: p.mood,
				moodDelta: p.mood - beforeMood,
				workCost
			});
		}
		/**
		 * 饿了的念叨（设计 §3.2 的"表现层"）：**必须低频** —— 普通饿 25 分钟一次、
		 * 很饿（<15）15 分钟一次。调研红线明确"状态低就一直提醒"是 VPet 最招人烦的一条。
		 */
		for (const id of petIds()) {
			const p = ensurePet(id, wallNow);
			if (p.satiety >= 30) continue;
			const starving = p.satiety < 15;
			const cd = starving ? FEED_STARVING_COOLDOWN_MS : FEED_HUNGRY_COOLDOWN_MS;
			if (wallNow - (Number(p.lastHungryAt) || 0) < cd) continue;
			p.lastHungryAt = wallNow;
			dirty = true;
			if (onSay) try {
				onSay(id, feedPick(starving ? FEED_HUNGRY_LINES.starving : FEED_HUNGRY_LINES.hungry));
			} catch (e) {
				log("念叨回调异常（数值已生效）：" + feedErrText(e));
			}
		}
		/** 随机送食物（保底）：与主 tick 解耦地按 gift.judgeEveryMin 判定，但搭同一班车执行 */
		const gifts = maybeGift(c, st, wallNow);
		save(false);
		publishState(c, st);
		for (const g of gifts) if (onGift) try {
			onGift(g.petId, g);
		} catch (e) {
			log("礼物回调异常（数值已生效）：" + feedErrText(e));
		}
		if (wallNow - lastTickLogAt >= 10 * 6e4) {
			lastTickLogAt = wallNow;
			log(`tick：${c.coin.name} ${st.shared.coin}（零头 ${st.shared.tokenCarry}）· ` + report.map((r) => `${r.id} 饱食度 ${feedFmtNum(r.satiety)} 心情 ${feedFmtNum(r.mood)}`).join(" · ") + (gifts.length > 0 ? ` · 送礼 ${gifts.map((g) => `${g.food}${g.autoEat ? "(自吃)" : ""}`).join("、")}` : ""));
		}
		return {
			ok: true,
			enabled: true,
			workCost,
			coin: st.shared.coin,
			tokenCarry: st.shared.tokenCarry,
			pets: report,
			gifts
		};
	};
	/** 四层限流的**唯一判定入口**（无副作用）：GET 的 canFeed 与 POST 的执行共用它，两处永不失配 */
	const evaluate = (petId, foodName, nowMs) => {
		const c = cfg();
		const now = nowMs ?? nowWall();
		if (!c.enabled) return {
			ok: false,
			reason: "disabled",
			message: "养成系统已关闭（feed.enabled = false）"
		};
		if (!hasPet(petId)) return {
			ok: false,
			reason: "unknown-pet",
			message: `没有这只桌宠：${petId || "(空)"}`
		};
		const food = c.foods.find((f) => f.name === foodName);
		if (!food) return {
			ok: false,
			reason: "unknown-food",
			message: `食物袋里没有「${foodName}」`
		};
		const spec = FEED_TIER_SPEC[food.tier] ?? FEED_TIER_SPEC.snack;
		const st = load();
		const p = peekPet(petId, now);
		const giftIndex = p.pendingGifts.findIndex((g) => String(g?.food) === foodName);
		/** ② 饱食度上限：≥ refuseAbove 拒绝喂食，并**给出拒绝表现**（不是静默失败） */
		if (p.satiety >= c.satiety.refuseAbove) return {
			ok: false,
			reason: "too-full",
			anim: FEED_REFUSE_ANIM,
			line: feedPick(FEED_TOO_FULL_LINES),
			message: `吃不下啦～（饱食度 ${feedFmtNum(p.satiety)}/${c.satiety.max}，${c.satiety.refuseAbove} 以上拒绝喂食）`,
			satiety: p.satiety,
			food: food.name,
			tier: food.tier
		};
		/** ③ 整体 10 秒防连点 */
		const busyLeft = FEED_TAP_GUARD_MS - (now - (Number(p.lastFeedAt) || 0));
		if (busyLeft > 0) return {
			ok: false,
			reason: "busy",
			line: feedPick(FEED_BUSY_LINES),
			message: `${feedPick(FEED_BUSY_LINES)}（还要等 ${Math.ceil(busyLeft / 1e3)} 秒）`,
			retryAfterSec: Math.ceil(busyLeft / 1e3),
			food: food.name
		};
		/** ③ 该食物独立消化冷却 */
		const cdLeft = (Number(p.cooldowns?.[foodName]) || 0) - now;
		if (cdLeft > 0) return {
			ok: false,
			reason: "cooldown",
			line: feedPick(FEED_BUSY_LINES),
			message: `「${foodName}」还在消化中（剩 ${feedFmtSec(cdLeft)}）`,
			cooldownLeftSec: Math.ceil(cdLeft / 1e3),
			food: food.name
		};
		/** 等级解锁：Lv4 大餐、Lv8 招牌 */
		if (p.level < spec.unlockLevel) return {
			ok: false,
			reason: "locked",
			message: `${spec.label}需 Lv${spec.unlockLevel} 解锁（当前 Lv${p.level}）`,
			unlockLevel: spec.unlockLevel,
			food: food.name
		};
		/** ① 鲸贝余额（待喂礼物同名时免费，不查钱包） */
		const useGift = giftIndex >= 0;
		if (!useGift && st.shared.coin < food.price) {
			const lack = Math.ceil(food.price - st.shared.coin);
			return {
				ok: false,
				reason: "no-coin",
				message: `还差 ${lack} ${c.coin.name}（余额 ${st.shared.coin}，这份要 ${food.price}）`,
				lackCoin: lack,
				price: food.price,
				food: food.name
			};
		}
		/** ④ 每日 8 次软上限（超出仍可喂，只是经验 ×0.5）+ 同类当日递减 [1, 0.8, 0.6, 0.4] */
		const dayKey = feedLocalDayKey(now);
		const todayFed = p.today.date === dayKey ? p.today.fedCount : 0;
		const sameCount = p.today.date === dayKey ? Number(p.today.foodCounts?.[foodName]) || 0 : 0;
		const decay = c.quota.repeatDecay[Math.min(sameCount, c.quota.repeatDecay.length - 1)] ?? 1;
		const overRatio = todayFed >= c.quota.dailyFeedLimit ? c.quota.overLimitExpRatio : 1;
		/** 今日偏好（设计 §6）：**只调经验**（×1.5 / ×0.5），饱食度照加 —— 它照样吃、不闹脾气 */
		const pref = preferenceEffect({ preference: ensurePreference(petId, p, c, now) }, foodName, c);
		const expRatio = decay * overRatio * pref.expRatio;
		return {
			ok: true,
			cfg: c,
			food,
			spec,
			pet: p,
			giftIndex,
			useGift,
			pref,
			expRatio,
			/** 不含偏好与递减的"基准系数"（面板要分开展示"为什么这次只有 +10"） */
			expBaseRatio: decay * overRatio,
			expGain: Math.max(0, Math.round(food.exp * expRatio)),
			todayFed,
			sameCount,
			decay,
			overRatio,
			coinAfter: useGift ? st.shared.coin : st.shared.coin - food.price
		};
	};
	/** 执行喂食：先走 evaluate（四层限流），通过后结算数值 + 立即落盘（用户可见性优先于降频） */
	const tryFeed = (petId, foodName, nowMs) => {
		const now = nowMs ?? nowWall();
		const ev = evaluate(petId, foodName, now);
		if (!ev.ok) {
			const st = load();
			const p = peekPet(petId, now);
			const fail = {
				ok: false,
				petId,
				food: foodName,
				...ev,
				coin: st.shared.coin,
				satiety: p.satiety,
				mood: p.mood,
				level: p.level
			};
			/** 拒绝也要有表现（设计 §5：不是静默失败）——交给宿主层写气泡/播动画 */
			if (onFed) try {
				onFed(petId, fail);
			} catch (e) {
				log("喂食回调异常：" + feedErrText(e));
			}
			return fail;
		}
		const c = ev.cfg;
		const st = load();
		const p = ensurePet(petId, now);
		/** 心情增益走今日偏好：爱吃 +6 / 不爱吃 +1 / 普通 +3（**永不扣**） */
		const moodGain = ev.pref ? ev.pref.moodGain : c.mood.enabled ? c.mood.feedGain : 0;
		if (ev.useGift) p.pendingGifts.splice(ev.giftIndex, 1);
		else st.shared.coin = Math.max(0, st.shared.coin - ev.food.price);
		p.satiety = feedClamp(p.satiety + ev.food.satiety, 0, c.satiety.max);
		if (c.mood.enabled) p.mood = feedClamp(p.mood + moodGain, c.mood.baseline, c.mood.max);
		p.exp += ev.expGain;
		p.expLifetime += ev.expGain;
		const levelUps = [];
		while (p.level < FEED_MAX_LEVEL && p.exp >= feedNeed(p.level, c)) {
			p.exp -= feedNeed(p.level, c);
			p.level += 1;
			levelUps.push(p.level);
		}
		const dayKey = feedLocalDayKey(now);
		if (p.today.date !== dayKey) {
			p.today = {
				date: dayKey,
				fedCount: 0,
				foodCounts: {}
			};
			p.petCountToday = 0;
		}
		p.today.fedCount += 1;
		p.today.foodCounts[foodName] = (Number(p.today.foodCounts[foodName]) || 0) + 1;
		p.cooldowns[foodName] = now + ev.food.cooldownSec * 1e3;
		p.lastFeedAt = now;
		p.lastInteractAt = now;
		/** 吃到"今天最爱"→ 开一段兴奋期（设计 §6：表现更活跃，前端据 lovedBoost 抬"玩耍"权重） */
		if (ev.pref?.loved) p.lovedBoostUntil = now + FEED_LOVED_BOOST_MS;
		dirty = true;
		save(true);
		const line = ev.pref?.line || feedPick(feedLinePool(ev.food.tier, p.level, ev.useGift));
		/** 升级动画：Lv4 起用「原地跳跃抓碎头顶物品」，其余升级用「凭空生花」（设计 §14.2） */
		const upgradeAnim = levelUps.length > 0 ? levelUps.some((lv) => lv >= 4) ? FEED_UPGRADE_ANIMS.feast : FEED_UPGRADE_ANIMS.normal : "";
		const result = {
			ok: true,
			petId,
			pet: petName(petId),
			food: ev.food.name,
			tier: ev.food.tier,
			tierLabel: ev.spec.label,
			emoji: ev.spec.emoji,
			gift: ev.useGift,
			/** 今日偏好：loved / disliked / ""（面板标 ❤️/🙂、气泡与台词都据此） */
			preference: ev.pref?.loved ? "loved" : ev.pref?.disliked ? "disliked" : "",
			spent: ev.useGift ? 0 : ev.food.price,
			coin: st.shared.coin,
			coinName: c.coin.name,
			coinEmoji: c.coin.emoji,
			satiety: p.satiety,
			satietyGain: ev.food.satiety,
			satietyMax: c.satiety.max,
			mood: p.mood,
			moodGain,
			moodBaseline: c.mood.baseline,
			exp: p.exp,
			expGain: ev.expGain,
			expRatio: ev.expRatio,
			expBaseRatio: ev.expBaseRatio,
			expNeed: feedNeed(p.level, c),
			expLifetime: p.expLifetime,
			level: p.level,
			levelUp: levelUps.length > 0,
			levelUps,
			levelLine: levelUps.length > 0 ? feedPick(FEED_LEVELUP_LINES) : "",
			todayFed: p.today.fedCount,
			dailyLimit: c.quota.dailyFeedLimit,
			cooldownLeftSec: ev.food.cooldownSec,
			anim: ev.food.name,
			/** 升级动画名（非空 = 这次升级了；前端/宿主优先播它，手感比"进食"更值） */
			upgradeAnim,
			line,
			refuseAbove: c.satiety.refuseAbove
		};
		/** 喂食结果推给宿主层（写气泡等）——回调失败绝不能影响喂食本身已经落盘的数值 */
		if (onFed) try {
			onFed(petId, result);
		} catch (e) {
			log("喂食回调异常（数值已生效）：" + feedErrText(e));
		}
		/** 飘字：把"这一次变了多少"单独推一份（前端飘 2~3 秒淡出，常驻层依然 0 个数字） */
		if (onFloat) try {
			const items = [`🍚+${ev.food.satiety}`, `⭐+${ev.expGain}`];
			if (moodGain > 0) items.push(`😊+${moodGain}`);
			if (!ev.useGift) items.push(`${c.coin.emoji}−${ev.food.price}`);
			if (levelUps.length > 0) items.push(`Lv${p.level} ↑`);
			onFloat(petId, {
				kind: levelUps.length > 0 ? "levelup" : "feed",
				items,
				anim: result.anim,
				upgradeAnim
			});
		} catch (e) {
			log("飘字回调异常（数值已生效）：" + feedErrText(e));
		}
		publishState(c, st);
		return result;
	};
	/** GET /feed 的响应体：状态 + 全部食物的「能否喂 + 为什么不能」 */
	const status = (petIdArg) => {
		const c = cfg();
		const st = load();
		const now = nowWall();
		const wanted = String(petIdArg ?? "").trim();
		const petId = wanted && hasPet(wanted) ? wanted : defaultPetId();
		if (!hasPet(petId)) return {
			ok: false,
			reason: "unknown-pet",
			message: `没有这只桌宠：${wanted || "(空)"}`,
			pets: petIds()
		};
		const p = peekPet(petId, now);
		const key = feedLocalDayKey(now);
		const todayFed = p.today.date === key ? p.today.fedCount : 0;
		const todayCounts = p.today.date === key ? p.today.foodCounts : {};
		const windows = feedDndWindows(c);
		/** 今日偏好：懒初始化（每天第一次查询时抽，跨日自动重抽） */
		const pref = ensurePreference(petId, p, c, now);
		const foods = c.foods.map((f) => {
			const spec = FEED_TIER_SPEC[f.tier] ?? FEED_TIER_SPEC.snack;
			const ev = evaluate(petId, f.name, now);
			const sameCount = Number(todayCounts?.[f.name]) || 0;
			const decay = c.quota.repeatDecay[Math.min(sameCount, c.quota.repeatDecay.length - 1)] ?? 1;
			const overRatio = todayFed >= c.quota.dailyFeedLimit ? c.quota.overLimitExpRatio : 1;
			const cdLeft = Math.max(0, (Number(p.cooldowns?.[f.name]) || 0) - now);
			const eff = preferenceEffect({ preference: pref }, f.name, c);
			return {
				name: f.name,
				tier: f.tier,
				tierLabel: spec.label,
				emoji: spec.emoji,
				price: f.price,
				exp: f.exp,
				satiety: f.satiety,
				cooldownSec: f.cooldownSec,
				unlockLevel: spec.unlockLevel,
				locked: p.level < spec.unlockLevel,
				canFeed: ev.ok === true,
				reason: ev.ok === true ? "" : ev.message,
				cooldownLeftSec: Math.max(0, Math.ceil(cdLeft / 1e3)),
				todayCount: sameCount,
				/** 面板显示"这次能拿多少"：含同类递减、日上限、**今日偏好**三层系数 */
				expGain: ev.ok === true ? ev.expGain : Math.max(0, Math.round(f.exp * decay * overRatio * eff.expRatio)),
				/** 今日偏好标注：loved（❤️）/ disliked（🙂）/ ""（面板按图标显示，不写数值） */
				preference: eff.loved ? "loved" : eff.disliked ? "disliked" : "",
				gift: p.pendingGifts.some((g) => String(g?.food) === f.name)
			};
		});
		return {
			ok: true,
			petId,
			pet: petName(petId),
			pets: petIds(),
			coin: st.shared.coin,
			coinName: c.coin.name,
			coinEmoji: c.coin.emoji,
			coinLifetime: st.shared.coinLifetime,
			coinMax: c.coin.max,
			tokensTotal: st.shared.tokensTotal,
			tokenCarry: st.shared.tokenCarry,
			tokensPerCoin: Math.max(1, Math.round(c.coin.rate)),
			tokenToNextCoin: Math.max(0, Math.max(1, Math.round(c.coin.rate)) - st.shared.tokenCarry),
			usageMetric: c.usageMetric,
			workTokenCarry: st.shared.workTokenCarry,
			satiety: p.satiety,
			satietyMax: c.satiety.max,
			satietyDecayPerHour: Math.round(c.satiety.max / c.satiety.hoursToEmptyActive * 100) / 100,
			idleAfterMin: c.satiety.idleAfterMin,
			idleRatio: c.satiety.idleRatio,
			refuseAbove: c.satiety.refuseAbove,
			refuseNow: p.satiety >= c.satiety.refuseAbove,
			mood: p.mood,
			moodMax: c.mood.max,
			moodBaseline: c.mood.baseline,
			level: p.level,
			exp: p.exp,
			expNeed: feedNeed(p.level, c),
			expLifetime: p.expLifetime,
			today: {
				date: key,
				fedCount: todayFed,
				limit: c.quota.dailyFeedLimit,
				over: todayFed >= c.quota.dailyFeedLimit
			},
			/** 与 /state 的 feed 叶子**同名**的别名（叶子叫 todayFed/dailyLimit/gifts）——
			*  前端两条数据路径（叶子 / 自愈拉 /feed）读同一套字段名，不会再出现"今日已喂读成 0"。 */
			todayFed,
			dailyLimit: c.quota.dailyFeedLimit,
			gifts: p.pendingGifts.length,
			foods,
			pendingGifts: p.pendingGifts.slice(),
			/** 今日偏好（设计 §6）：面板顶部显示"今天爱吃 X · 不太爱吃 Y"；食物行上只标 ❤️/🙂 */
			preference: {
				date: pref.date,
				loved: pref.loved,
				disliked: pref.disliked,
				lovedExpRatio: c.preference.lovedExpRatio,
				dislikedExpRatio: c.preference.dislikedExpRatio
			},
			giftConfig: {
				enabled: c.gift.enabled,
				judgeEveryMin: c.gift.judgeEveryMin,
				chance: c.gift.chance,
				hungryBelow: c.gift.hungryBelow,
				hungryChance: c.gift.hungryChance,
				starvingBelow: c.gift.starvingBelow,
				starvingChance: c.gift.starvingChance,
				dailyLimit: c.gift.dailyLimit,
				autoEatBelow: c.gift.autoEatBelow
			},
			dnd: {
				windows: windows.map((w) => [feedHmText(w[0]), feedHmText(w[1])]),
				decayRatio: c.dnd.decayRatio,
				now: feedIsDndAt(now, windows)
			},
			statePath,
			savedAt: lastSaveAt
		};
	};
	return {
		cfg,
		petIds,
		defaultPetId,
		status,
		tryFeed,
		tick,
		maybeGift,
		publishState,
		ensurePreference,
		accrueTokens,
		markActive,
		addMoodAll,
		handleSessionEvent,
		save,
		load,
		peekPet,
		ensurePet,
		statePath
	};
}
/** `/dsh-pet-7340/feed` 的路由结果（host 的 handlePetRoute 与离线影子服务共用同一份） */
function feedRouteResult(feed, args) {
	const method = String(args?.method ?? "GET").toUpperCase();
	const url = /* @__PURE__ */ new URL(String(args?.rawUrl ?? "/"), "http://localhost");
	const petArg = String(url.searchParams.get("pet") ?? url.searchParams.get("petId") ?? "").trim();
	if (method === "GET") {
		const r = feed.status(petArg);
		return {
			kind: "json",
			status: r.ok ? 200 : 404,
			obj: r,
			headers: { "cache-control": "no-cache, no-store" }
		};
	}
	if (method !== "POST") return {
		kind: "json",
		status: 405,
		obj: { error: "method not allowed" }
	};
	let parsed;
	try {
		parsed = JSON.parse(args?.body ?? "");
	} catch {
		return {
			kind: "json",
			status: 400,
			obj: { error: "invalid JSON body" }
		};
	}
	const petId = String(parsed?.petId ?? parsed?.pet ?? petArg ?? "").trim();
	const food = String(parsed?.food ?? parsed?.name ?? "").trim();
	if (!food) return {
		kind: "json",
		status: 400,
		obj: { error: "expect { petId, food }（food = 食物袋里的动画名，如「吃早餐」）" }
	};
	const r = feed.tryFeed(petId, food);
	const status = r.ok ? 200 : r.reason === "unknown-pet" ? 404 : r.reason === "unknown-food" || r.reason === "disabled" ? 400 : 409;
	return {
		kind: "json",
		status,
		obj: r
	};
}
/** `/feed` 命令的状态文本（多行，直接显示在 DSH 输入框上方） */
function feedStatusText(s) {
	const coin = `${s.coinEmoji} ${s.coin} ${s.coinName}`;
	const lines = [`Lv${s.level}（还需 ${Math.max(0, s.expNeed - s.exp)}⭐） · 🍚 饱食度 ${feedFmtNum(s.satiety)}/${s.satietyMax} · 😊 心情 ${feedFmtNum(s.mood)}/${s.moodMax} · ${coin} · 今日 ${s.today.fedCount}/${s.today.limit}`];
	if (s.pendingGifts.length > 0) lines.push(`🎁 待喂礼物：${s.pendingGifts.map((g) => g.food).join("、")}`);
	const ready = s.foods.filter((f) => f.canFeed);
	if (ready.length > 0) lines.push(`可喂：${ready.slice(0, 8).map((f) => `${f.emoji}${f.name}（${f.price}${s.coinName} / +${f.expGain}⭐）`).join(" / ")}${ready.length > 8 ? ` …共 ${ready.length} 种` : ""}`);
	else lines.push("现在没有可喂的食物");
	const blocked = s.foods.filter((f) => !f.canFeed && !f.locked);
	if (blocked.length > 0) lines.push(`暂不可喂：${blocked.slice(0, 4).map((f) => `${f.name}（${f.reason}）`).join(" / ")}${blocked.length > 4 ? " …" : ""}`);
	const example = ready[0]?.name ?? "吃早餐";
	lines.push(`用法：/feed <食物名>，例如 /feed ${example}`);
	return lines.join("\n");
}
/** `/feed <食物名>` 与 POST /feed 的结果文本 */
function feedResultText(r) {
	if (!r.ok) return `喂食失败：${r.message}`;
	const bits = [
		`${r.emoji}「${r.food}」` + (r.gift ? "（待喂礼物，不花鲸贝）" : ` −${r.spent}${r.coinEmoji ?? "🐚"}`),
		`🍚 +${r.satietyGain} → ${feedFmtNum(r.satiety)}/${r.satietyMax}`,
		`⭐ +${r.expGain}` + (r.expRatio < 1 ? `（系数 ${r.expRatio}）` : "") + ` → Lv${r.level}${r.levelUp ? "" : `（还需 ${Math.max(0, r.expNeed - r.exp)}）`}`,
		`😊 +${r.moodGain} → ${feedFmtNum(r.mood)}`,
		`${r.coinEmoji ?? "🐚"} ${r.coin}`,
		`今日 ${r.todayFed}/${r.dailyLimit}`
	];
	if (r.levelLine) bits.push(`✨ ${r.levelLine}`);
	if (r.line) bits.push(`💬 ${r.line}`);
	return bits.join("\n");
}
/** 喂食结果 → 气泡文案（**单行**：气泡槽与碎碎念共用、10s 后自动消失）。
*  设计 §9 指定"喂食台词/礼物台词/升级台词复用 whisper 展示通道"——面板被收起或没看面板时，
*  靠它也能立刻看到"喂了什么、涨了多少、说了什么"。 */
function feedBubbleText(r) {
	const bits = [
		`${r.emoji ?? ""}${r.food}` + (r.preference === "loved" ? " ❤️" : r.preference === "disliked" ? " 🙂" : "") + (r.gift ? "（礼物）" : ` −${r.spent}${r.coinEmoji ?? "🐚"}`),
		`🍚+${r.satietyGain}`,
		`⭐+${r.expGain}${r.expRatio < 1 ? `(×${r.expRatio})` : ""}`,
		`😊+${r.moodGain}`
	];
	if (r.levelUp) bits.push(`Lv${r.level} ↑`);
	if (r.line) bits.push(r.line);
	return bits.join(" · ");
}
/** 随机送食物 / 自主进食 → 气泡文案（单行；与喂食共用同一个 say 槽） */
function feedGiftBubbleText(g) {
	const bits = [`🎁 ${g.bubble}`];
	if (g.autoEat) bits.push(`（它自己吃掉啦：🍚+${g.satietyGain} ⭐+${g.expGain}${g.levelUp ? ` Lv${g.level} ↑` : ""}）`);
	if (g.line) bits.push(g.line);
	return bits.join(" ");
}
/** 仅供本机离线自测（影子服务）使用：同一份逻辑喂给伪 ctx，不必重启 DSH 就能 curl 出真实数值 */
const __feedInternals = {
	createFeedSystem,
	feedRouteResult,
	feedStatusText,
	feedResultText,
	feedBubbleText,
	feedGiftBubbleText,
	feedLinePool,
	feedDefaults,
	feedDefaultFoods,
	feedNormalizeConfig,
	feedNeed,
	feedSatietyDecay,
	feedMoodDecay,
	feedIsDndAt,
	FEED_TIER_SPEC,
	FEED_STATE_FILE
};
//#endregion
function apply(ctx) {
	const dshHome = resolveDshHome();
	const userRoot = join(dshHome, "dsh-pet");
	const userConfigPath = join(userRoot, "main-config.jsonc");
	const legacyUserConfigPath = join(userRoot, "main-config.json");
	const petConfigDir = join(userRoot, "pet");
	const configPaths = {
		defaultFile: join(PACKAGE_ROOT, "assets", "config.jsonc"),
		userFile: userConfigPath,
		legacyUserFile: legacyUserConfigPath,
		petDir: petConfigDir
	};
	migrateUserConfig(configPaths, (msg) => console.log("[dsh-pet] " + msg));
	/** 养成系统一期状态机：状态文件与 memory.json 同目录（%DSH_HOME%/dsh-pet/pet-state.json）。
	*  与 ctx 解耦（依赖注入）——同一份逻辑可被离线影子服务驱动，改完不必重启 DSH 就能 curl 验证。 */
	const feed = createFeedSystem({
		dir: userRoot,
		readConfig: () => readAllConfig(configPaths),
		log: (m) => console.log("[dsh-pet] " + m),
		/** 喂食（成功，或「吃不下」被拒）→ 气泡 + 动画：复用 whisper 气泡槽与 anim 点播通道（设计 §9）。
		*  面板被收起、或用户根本没看面板时，靠它立刻看到"喂了什么、涨了多少、说了什么 / 拒绝表现"。
		*  state 在本函数后面才创建——这些回调只在喂食/送礼那一刻执行，那时早已初始化完毕。 */
		onFed: (petId, r) => {
			if (r.ok) state.writePet(petId, "say", { text: feedBubbleText(r) });
			else if (r.reason === "too-full") state.writePet(petId, "say", { text: r.message || r.line || "吃不下啦～" });
			/** 升级时优先播**升级动画**（设计 §14.2：升级比"进食"更值得表现）；否则播该食物的进食动画 */
			const animName = r.ok && r.upgradeAnim ? r.upgradeAnim : r.anim;
			if (animName) state.writePet(petId, "anim", { name: animName });
		},
		/** 随机送食物 / 自主进食 → 气泡 + 礼物动画（拆礼物/收红包/凭空生花/动物环绕/轻快记录） */
		onGift: (petId, g) => {
			state.writePet(petId, "say", { text: feedGiftBubbleText(g) });
			if (g.anim) state.writePet(petId, "anim", { name: g.anim });
		},
		/** 数值摘要 → `/state` 的 `pets.<id>.feed` 叶子：悬停 HUD、角标、心情/饿/兴奋期权重共用这一份 */
		onState: (petId, s) => state.writePet(petId, "feed", s),
		/** 飘字 → `pets.<id>.float` 叶子：前端飘 2~3 秒淡出（喂食 / 升级 / 礼物 / 进鲸贝） */
		onFloat: (petId, f) => state.writePet(petId, "float", f),
		/** 说一句（饿了的低频念叨）：复用气泡槽 */
		onSay: (petId, text) => state.writePet(petId, "say", { text })
	});
	const thumbUserRoot = join(userRoot, "main-animation");
	const memesUserRoot = join(userRoot, "memes");
	/**
	* 表情包目录链 —— 与动画素材（/thumb）**同一套素材归属语义**：
	*   - `pet/<素材根>-memes/` 存在（种类自带表情包）：**只查它**，池与路由都不回落——
	*     查不到即 404 / 该条目剔除（与 `pet/<素材根>-animation/` 的独占规则逐字一致）；
	*   - 否则：用户目录 `$DSH_HOME/dsh-pet/memes/` 优先，其次包内 `assets/memes/`（逐文件合并，
	*     与「main-animation/<ext> → 包内 assets/<ext>」的主素材链同构）。
	* 池（readMemePool）与路由（/pic/memes）必须走**同一个函数**：池里能选的名字，
	* 路由必须取得到，否则气泡配图会图裂。
	* 素材根一律先过 resolveAsset：它来自 URL 段，Windows 上 %5C 解出的反斜杠不会被
	* rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘（与 /thumb 同一道防线）。
	*/
	const memeDirsFor = (assetRoot) => {
		const own = resolveAsset(petConfigDir, assetRoot + "-memes");
		if (own !== void 0 && existsSync(own)) return [own];
		return [memesUserRoot, PACKAGE_MEMES_DIR];
	};
	const state = new PollStateStore();
	const workStatus = new WorkStatusStore();
	let publishedWork = "\0";
	const publishWorkStatus = () => {
		const snap = workStatus.snapshot();
		const key = String(snap.state) + "\0" + String(snap.task);
		if (key === publishedWork) return;
		publishedWork = key;
		state.writeSection("workStatus", {
			state: snap.state,
			task: snap.task
		});
	};
	const pushNotifyFrame = (frame) => {
		state.writeSection("notify", frame);
	};
	/** 桌面宠物窗口可见性：右键「隐藏桌宠」与「工具」菜单写同一份状态，helper 经 /state 轮询取用。
	*  内存态（不落盘）：host 重启后 helper 重建窗口即回到可见——"重新开始"的合理默认。 */
	let desktopVisible = true;
	const setDesktopVisible = (visible) => {
		// ⚠️ 绝不能在这里「值没变就 return」：自动隐藏是 helper 自己 win.hide() 的，host 并不知情
		//    （desktopVisible 仍是 true）。此时用户点「打开桌宠」走的正是 visible===true 这条路径，
		//    一去重就永远不写 state，渲染端收不到指令，桌宠就再也叫不回来了——已实测踩到。
		//    写 state 是幂等的，多写一次只是一次 1s 轮询里多一个 IPC，远比叫不回来轻。
		desktopVisible = visible;
		state.writeSection("desktop", { visible });
	};
	const turnFlags = new Map();
	/** 终态（success/error）展示窗口定时器：约 60s 后清掉该会话条目，陈旧完成态不再浮上来（Bug 2/3） */
	const terminalTimers = new Map();
	const TERMINAL_KEEP_MS = 60 * 1e3;
	/** 取消某会话待执行的终态清理：会话已回到非终态，那次清理到点后既不清理也不重排，留着只会误导 */
	const cancelTerminalCleanup = (sessionId) => {
		const t = terminalTimers.get(sessionId);
		if (t === void 0) return;
		clearTimeout(t);
		terminalTimers.delete(sessionId);
	};
	/** 排一个终态清理定时器（每会话一个，已排则跳过） */
	const scheduleTerminalCleanup = (sessionId) => {
		if (terminalTimers.has(sessionId)) return;
		const t = setTimeout(() => {
			terminalTimers.delete(sessionId);
			const sessionState = workStatus.stateOf(sessionId);
			if (sessionState === "success" || sessionState === "error") {
				workStatus.clear(sessionId);
				turnFlags.delete(sessionId);
				publishWorkStatus();
			}
		}, TERMINAL_KEEP_MS);
		terminalTimers.set(sessionId, t);
	};
	let activePetId = "";
	const lastWhisperAt = new Map();
	const memoryPath = join(userRoot, "memory.json");
	let chatQueue = Promise.resolve();
	/** 读记忆文件：不存在 → 空；损坏 → 显式报错 + 备份原始文件（绝不静默丢数据）+ 重建空记忆 */
	const readMemory = async () => {
		let raw;
		try {
			raw = await readFile(memoryPath, "utf8");
		} catch {
			return {};
		}
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object") throw new Error("not an object");
			return parsed;
		} catch (e) {
			console.error(`dsh-pet: 记忆文件损坏已备份（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`);
			try {
				await mkdir(userRoot, { recursive: true });
				await writeFile(`${memoryPath}.bak-${Date.now()}`, raw, "utf8");
			} catch {}
			return {};
		}
	};
	const writeMemory = async (mem) => {
		await mkdir(userRoot, { recursive: true });
		await writeFile(memoryPath, JSON.stringify(mem, null, 2), "utf8");
	};
	/** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
	const withMemoryLock = (fn) => {
		const run = chatQueue.then(fn, fn);
		chatQueue = run.then(() => void 0, () => void 0);
		return run;
	};
	/** 某宠物的最终人设 system：所属条目（非文件宠物 → main 条目）的 whisperPrompt（合并器已填默认）
	*  + 无条件追加一句名字声明（name，缺失已按 id）——碎碎念与对话共用同一拼装。 */
	const petSystemPrompt = (petId, cfg) => {
		const found = findPetInstance(cfg, petId);
		const conf = found ? found.conf : cfg.main ?? {};
		const prompt = typeof conf.whisperPrompt === "string" ? conf.whisperPrompt : "";
		const name$1 = found ? String(found.pet.name || found.pet.id || petId) : petId;
		const nameLine = "你的名字是“" + name$1 + "”。";
		return prompt ? prompt + "\n" + nameLine : nameLine;
	};
	/** 对话记忆轮数（1 轮 = 1 问 1 答）：所属条目/主条目的 chatMemoryRounds（合并器已填默认非负数字） */
	const memoryRounds = (petId, cfg) => {
		const found = findPetInstance(cfg, petId);
		const v = Number(found?.conf.chatMemoryRounds ?? cfg.main?.chatMemoryRounds);
		return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
	};
	/** 生成/返回某宠物的一句碎碎念（周期 GET 与菜单手动触发共用的同一逻辑）：
	*  每只宠物独立生成（所属条目的人设）。生成成功就写进 S 的 pets.<id>.say——
	*  碎碎念 / 命令气泡 / 对话回复在前端本来就是**同一条展示链路**（同一个 triggerWhisper、
	*  同一个气泡槽、同一批 events.whisper 动画），所以合并成同一个叶子；"周期内不重复"由
	*  调度侧的 lastWhisperAt 保证，不再需要一份 whisperCache（多端共享也由 S 天然保证）。
	*  配图（whisperImageEnabled 开启时）：从表情包池**随机抽 1 张**，把描述注入指令并随文本一起写。 */
	const publishWhisper = async (petId) => {
		const cfg = readAllConfig(configPaths);
		const found = findPetInstance(cfg, petId);
		const conf = found ? found.conf : cfg.main ?? {};
		const entry = found ? found.entry : "main";
		const system = petSystemPrompt(petId, cfg);
		const meme = conf.whisperImageEnabled === true ? pickMeme(readMemePool(conf.memes, memeDirsFor(entry))) : void 0;
		const result = await generateWhisper(ctx, system, meme, configuredModel(conf, "whisperModel"));
		if (!result.ok) {
			console.warn("[dsh-pet] 碎碎念生成失败 pet=" + petId + " reason=" + result.reason + (result.message ? " " + result.message : ""));
			return false;
		}
		state.writePet(petId, "say", result.image ? {
			text: result.text,
			image: result.image
		} : { text: result.text });
		return true;
	};
	/** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 把回复写进 S 的 pets.<id>.say。
	*  供 POST /chat（动作端点）与 /chat 命令共用同一条路径（锁内读写，防两端交错写盘）。
	*  配图（chatImageEnabled 开启时）：把表情包清单交给模型按语境选一张，命中池内才随回复写回。 */
	const chatWithPet = async (petId, text) => withMemoryLock(async () => {
		const cfg = readAllConfig(configPaths);
		const rounds = memoryRounds(petId, cfg);
		const found = findPetInstance(cfg, petId);
		const conf = (found ?? { conf: cfg.main ?? {} }).conf;
		const system = petSystemPrompt(petId, cfg);
		const pool = conf.chatImageEnabled === true ? limitPool(readMemePool(conf.memes, memeDirsFor(found?.entry ?? "main")), Number(conf.chatImageLimit)) : [];
		const mem = await readMemory();
		const bucketKey = found?.entry ?? petId;
		const bucket = mem[bucketKey] ?? (mem[bucketKey] = {});
		const entry = bucket[petId] ?? (bucket[petId] = { messages: [] });
		const list = sliceMemoryRounds(entry.messages, rounds);
		const generated = await generateChat(ctx, system, list, text, pool, configuredModel(conf, "chatModel"));
		if (!generated.ok) return generated;
		const now = Date.now();
		entry.messages.push({
			role: "user",
			content: text,
			ts: now
		});
		entry.messages.push({
			role: "assistant",
			content: generated.text,
			ts: now
		});
		await writeMemory(mem);
		state.writePet(petId, "say", generated.image ? {
			text: generated.text,
			image: generated.image
		} : { text: generated.text });
		return { ok: true };
	});
	/**
	* 当前生效宠物列表 = readAllConfig 成品拍平（main + 文件宠物全部条目；合并器已保证 id 唯一、
	* 字段填满），命令与桌面模式都从这里取。
	*/
	const effectivePetList = () => flattenPetList(readAllConfig(configPaths));
	/** 余额刷新周期（秒）：成品 main 条目的 eventsRefreshSec.balance（合并器已填默认；非法兜底 1800） */
	const balancePeriodSec = (cfg) => {
		const ers = cfg.main?.eventsRefreshSec;
		const n = Number(ers?.balance);
		return Number.isFinite(n) && n > 0 ? n : 1800;
	};
	/** 碎碎念周期（秒）：该宠物**所属条目**的 eventsRefreshSec.whisper（合并器已填默认；非法兜底 300） */
	const whisperPeriodSec = (cfg, petId) => {
		const conf = (findPetInstance(cfg, petId) ?? { conf: cfg.main ?? {} }).conf;
		const ers = conf.eventsRefreshSec;
		const n = Number(ers?.whisper);
		return Number.isFinite(n) && n > 0 ? n : 300;
	};
	/**
	* 刷新余额并写入 S —— host 侧**唯一**的余额查询点。
	*
	* 改造前是每个客户端各自按自己的定时器去查（浏览器一个 + 桌面每窗口一个）：同一份外部 API
	* 被重复请求、两端还可能看到新旧不一致的数据。现在只有这里查，两端都从 /state 读同一份结果。
	*
	* 失败也写进 S（reason 区分 unsupported / credential-missing / fetch-error）——余额不可用要弹
	* 文字说明气泡，不能静默；意外异常同样落成 fetch-error，不吞。
	*
	* @param manual 这次刷新是不是"用户要的"（/balance 命令、桌面「查看余额」菜单）。
	*   标记随数据一起写进叶子：只有 host 知道是谁要的，前端据此决定余额不可用时要不要**必弹**
	*   文字说明（decideBalanceNotice 的 explicit；周期刷新则只在原因变化时弹一次，免得反复刷屏）。
	*/
	/**
	* 账号服务要求的调用方身份（`AccountClientMetadata`）：Platform 用它派生五个客户端头，
	* 只影响**请求来源标识**与**服务端本地化文案**，不参与余额数值与币种。
	*
	* - version：本插件版本（读自身 package.json；读不到回落 '0.0.0'——该字段只是标识）
	* - locale：本插件是中文产品，固定 `zh-CN`（Platform 侧归一到 zh_CN）
	* - timezoneOffsetSeconds：本机 UTC 偏移（东八区为 +28800）
	*/
	const accountClientMetadata = () => {
		let version = "0.0.0";
		try {
			const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
			if (typeof raw.version === "string" && raw.version.length > 0) version = raw.version;
		} catch {}
		return {
			version,
			locale: "zh-CN",
			timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
		};
	};
	const refreshBalance = async (manual = false) => {
		const mark = (v) => manual ? {
			...v,
			manual: true
		} : v;
		try {
			const sel = ctx.agentDefaultModel.currentSelection();
			const result = await queryBalance(
				sel.provider,
				async (ref) => {
					const rc = await ctx.credentials.resolve(credentialRef(ref));
					return rc?.value;
				},
				// `deepseek-account`（免费额度 / 平台登录）没有 API Key：它的凭证是 DSH 账号服务
				// 持有的授权记录，只能经 getBalance 查询。账号服务是**可选**服务（软取，不放进
				// inject）——没装账号插件时它不在场，此时该路由报 credential-missing 而不是崩。
				async () => {
					const account = ctx.get("deepseekAccount", false);
					if (!account) return void 0;
					return account.getBalance(accountClientMetadata());
				}
);
			state.writeSection("balance", mark(result));
		} catch (e) {
			state.writeSection("balance", mark({
				ok: false,
				provider: "unknown",
				reason: "fetch-error",
				message: e instanceof Error ? e.message : String(e)
			}));
		}
	};
	/** 当前交互桌宠 id：/pet 已选且仍存在 → 该宠物；未选/已失效 → 有效宠物列表第一只（进程内，重启回默认） */
	const resolveActivePetId = () => {
		try {
			const eff = effectivePetList();
			if (eff.length === 0) return "";
			if (activePetId && eff.some((p) => String(p.id) === activePetId)) return activePetId;
			return String(eff[0].id);
		} catch {
			return activePetId;
		}
	};
	/** 宠物的显示名（name，缺失回落 id）——命令文案用 */
	const petDisplayName = (pet) => {
		const n = String(pet.name ?? "").trim();
		return n || String(pet.id ?? "");
	};
	let hasDesktopPet = false;
	const refreshDesktop = () => {
		hasDesktopPet = false;
		try {
			hasDesktopPet = effectivePetList().some((p) => isDesktopVisible(p.display));
		} catch (e) {
			ctx.logger?.warn?.(`[dsh-pet] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
		}
	};
	refreshDesktop();
	/** 桌面可见宠物列表（[{id,size}]）：透传 Helper 决定创建几个局部窗口（每宠物一个）。 */
	const desktopPetList = () => {
		try {
			return effectivePetList().filter((p) => isDesktopVisible(p.display)).map((p) => ({
				id: String(p.id),
				size: Number(p.size)
			}));
		} catch {
			return [];
		}
	};
	let helper;
	let startRetryTimer;
	let electronEnsure;
	let disposed = false;
	/** 「无图形环境」提示只在进程生命周期内打一次，避免守护循环刷屏 */
	let displayWarned = false;
	/** 用已确认存在的 Electron 路径拉起桌面 Helper（每只桌面宠物一个局部小窗口）。 */
	const launchHelper = (electronPath) => {
		if (helper || disposed) return;
		if (!hasDesktopPet) return;
		const port = typeof ctx.webServer?.port === "number" ? ctx.webServer.port : 0;
		if (!port || port <= 0) {
			if (!startRetryTimer) {
				startRetryTimer = setTimeout(() => {
					startRetryTimer = void 0;
					launchHelper(electronPath);
				}, 500);
				startRetryTimer.unref?.();
			}
			return;
		}
		const origin = `http://127.0.0.1:${port}`;
		const configUrl = `${origin}${ROUTE_PREFIX}/config`;
		helper = new HelperProcess({
			electronPath,
			env: {
				DSH_PET_CONFIG_URL: configUrl,
				DSH_PET_SCALE: "1",
				DSH_PET_BRIDGE: "1",
				DSH_PET_PETS: JSON.stringify(desktopPetList())
			},
			bridgeHandler: async (req) => {
				const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", req.body);
				if (result.kind === "file") return {
					id: req.id,
					status: 200,
					contentType: result.contentType,
					file: result.file
				};
				if (result.kind === "text") return {
					id: req.id,
					status: result.status,
					contentType: "text/plain; charset=utf-8",
					body: result.body
				};
				return {
					id: req.id,
					status: result.status,
					contentType: "application/json; charset=utf-8",
					body: JSON.stringify(result.obj)
				};
			}
		}, ctx.logger ?? console);
		try {
			helper.start();
			ctx.logger?.info?.(`dsh-pet desktop helper started (config: ${configUrl})`);
		} catch (e) {
			ctx.logger?.warn?.(`dsh-pet desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
			helper = void 0;
		}
	};
	/** 拉起桌面 Helper：先探测本机 Electron；缺失时进程内异步下载
	*  （不 spawn 子进程，CLI node 与 DSH Desktop 均适用），下载完成后自动拉起。 */
	const startHelper = () => {
		if (helper || electronEnsure || disposed) return;
		if (!hasDesktopPet) return;
		if (!hasGraphicalDisplay()) {
			if (!displayWarned) {
				displayWarned = true;
				ctx.logger?.warn?.("[dsh-pet] 未检测到图形显示环境（DISPLAY/WAYLAND_DISPLAY 均为空），已跳过桌面宠物。浏览器内宠物不受影响；如需在服务器上启用桌面模式，请配置 Xvfb 后设置 DSH_PET_DESKTOP_FORCE=1。");
			}
			return;
		}
		const found = resolveElectronPath();
		if (found) {
			launchHelper(found);
			return;
		}
		console.warn(`[dsh-pet] Electron not found, downloading to ${defaultElectronExe()} ...`);
		electronEnsure = ensureElectronDownload().then((path) => {
			if (path) launchHelper(path);
			else console.warn("[dsh-pet] Electron download failed; desktop pet unavailable. Set DSH_PET_ELECTRON_PATH and restart, or retry later.");
		}).finally(() => {
			electronEnsure = void 0;
		});
	};
	/** 停止桌面 Helper（保留配置，可再次拉起）。宿主退出/插件卸载路径：不等它退干净（见 stopAndWait）。 */
	const stopHelper = (reason = "settings-change") => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		helper?.stop(reason);
		helper = void 0;
	};
	/** 停止并**等旧 helper 真正退出**：配置变更触发的"停旧起新"专用（issue #64）。 */
	const stopHelperAndWait = async (reason) => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		const old = helper;
		helper = void 0;
		await old?.stopAndWait(reason);
	};
	/**
	* 宠物配置（display / size 等）变更后：重解析桌面宠物，**等旧 helper 退出**再拉起新的。
	*
	* 为什么要等（issue #64）：Electron 收到 SIGTERM 后关窗是异步的（几百 ms 起），"发完 kill 就 spawn
	* 新进程"会让旧窗口（旧大小）与新窗口（新大小）短暂共存——用户看到的就是"改完大小冒出来第二只宠物"。
	* 为什么要串行：连续保存会触发多次重启，两次重启交错同样会同时拉起两个 helper，所以用队列串起来。
	* 队列自身绝不留下 rejected 状态，否则后续保存再也不会重启 helper。
	*/
	let desktopSyncQueue = Promise.resolve();
	const syncDesktop = () => {
		desktopSyncQueue = desktopSyncQueue.then(async () => {
			refreshDesktop();
			await stopHelperAndWait("desktop-config-change");
			startHelper();
		}).catch((e) => {
			ctx.logger?.warn?.(`[dsh-pet] 重启桌面 Helper 失败：${e instanceof Error ? e.message : String(e)}`);
		});
		return desktopSyncQueue;
	};
	/** 扩展名 → 素材子目录名（webm → webm/，mov → mov/；其余落在动画目录平级放行） */
	const animSubdirFor = (ext) => ext === ".mov" ? "mov" : "webm";
	/** 包内动画素材根：按扩展名取子目录（webm/ 随包发布；mov/ 不存在时为 404 兜底，仅 macOS 自维护）。 */
	const assetRootFor = (ext) => join(PACKAGE_ROOT, "assets", animSubdirFor(ext));
	/** 用户动画根：按扩展名取子目录（main-animation/webm 或 main-animation/mov）。 */
	const userRootFor = (ext) => join(thumbUserRoot, animSubdirFor(ext));
	/** 单次业务路由(WebServer 注册 → HTTP 落盘 / 桌面 Helper 管道 → scheme 应答,共用同一份实现):
	*  输入只需 rawUrl(/dsh-pet-7340/... + 查询) + method + body 文本;返回 RouteResult(JSON/文本/文件),
	*  消费方各自落盘——业务逻辑只有一份,两端天然一致(硬契约:浏览器/桌面行为严格对齐)。 */
	const handlePetRoute = async (rawUrl, method, body) => {
		const url = new URL(rawUrl, "http://localhost");
		const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));
		if (rest === "config") {
			if (method === "GET") try {
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths)
				};
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
			if (method === "PUT") try {
				const parsed = JSON.parse(body ?? "");
				const existing = readUserConfig(configPaths);
				const clean = saveUserConfig(parsed, existing);
				if (!clean) return {
					kind: "json",
					status: 400,
					obj: { error: "invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled / whisperImageEnabled / chatImageEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）" }
				};
				if (url.searchParams.get("force") !== "1" && userConfigUnparsable(configPaths)) return {
					kind: "json",
					status: 409,
					obj: {
						error: "user config is unparsable",
						needConfirm: true,
						userFile: userConfigPath
					}
				};
				await mkdir(userRoot, { recursive: true });
				await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
				syncDesktop();
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths)
				};
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			if (method === "POST") {
				try {
					syncUserConfigFromDefault(configPaths);
				} catch (e) {
					return {
						kind: "json",
						status: 500,
						obj: { error: e instanceof Error ? e.message : String(e) }
					};
				}
				syncDesktop();
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths)
				};
			}
			return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
		}
		if (rest === "reload") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			syncDesktop();
			return {
				kind: "json",
				status: 200,
				obj: { reloading: true }
			};
		}
		/** 桌面宠物可见性：GET 查询、POST /hide 与 /show 写入。
		*  写入只改 state 叶子，真正的窗口 hide/show 由 helper 轮询 /state 后自行执行——
		*  宿主不需要（也无法）直接操纵 helper 的窗口。 */
		if (rest === "desktop") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			return {
				kind: "json",
				status: 200,
				obj: { visible: desktopVisible }
			};
		}
		if (rest === "hide" || rest === "show") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			setDesktopVisible(rest === "show");
			return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					visible: desktopVisible
				}
			};
		}
		/** 滚轮缩放的持久化：只改配置文件里该宠物的 size，**不重启 helper**。
		*  与 PUT /config 的区别正在这里——那个是设置页保存，会 syncDesktop() 重建窗口；
		*  而滚轮缩放时窗口已经由渲染端就地改好了（窗口尺寸是渲染端推出去的），
		*  再重建一次只会白闪一下并丢掉当前拖拽落点。 */
		if (rest === "size") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const petId = String(parsed?.id ?? "");
			const size = Math.round(Number(parsed?.size));
			if (!petId || !Number.isFinite(size) || size <= 0) return {
				kind: "json",
				status: 400,
				obj: { error: "expect { id, size }" }
			};
			const merged = readAllConfig(configPaths);
			const hit = findPetInstance(merged, petId);
			if (!hit) return {
				kind: "json",
				status: 404,
				obj: { error: "pet not found: " + petId }
			};
			// 只写目标那一只：其余保持用户层原样，绝不把内置默认整份固化进用户层
			const existing = readUserConfig(configPaths) ?? {};
			const current = Array.isArray(existing.pets) ? existing.pets.slice() : [];
			const at = current.findIndex((p) => String(p?.id) === petId);
			// 底稿取**成品配置**里那只（字段齐全，mergeEntry 已填满），只覆盖 size；
			// saveUserConfig 会按白名单重建，多带的字段自然被丢掉
			const nextPet = {
				...hit.pet,
				size
			};
			if (at >= 0) current[at] = nextPet;
			else current.push(nextPet);
			const clean = saveUserConfig({
				...existing,
				pets: current
			}, existing);
			if (!clean) return {
				kind: "json",
				status: 400,
				obj: { error: "invalid pet config" }
			};
			await mkdir(userRoot, { recursive: true });
			await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
			return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					id: petId,
					size
				}
			};
		}
		/** 自动隐藏开关（「工具」菜单 / 右键菜单点出来的）：只改 autoHide 段里的指定键，
		*  其余字段原样保留。autoHide 不在 saveUserConfig 的白名单里，是靠它末尾"按原样带回 prev"那几行
		*  存住的——所以这里必须把改后的 autoHide 同时作为 priors 传给 saveUserConfig，否则会被丢掉。
		*  GET  读当前状态（菜单要显示「开/关」）
		*  POST { enabled?, autoRestore? } 改其中一个或两个 */
		if (rest === "autohide") {
			// ⚠️ readAllConfig 返回的是**按宠物 id 分组**的结构：{main:{pets:[...], autoHide:{...}}}
			// 配置在 .main 下，不是顶层。直接取 .autoHide 会永远拿到 undefined
			// （表现成"读到的全是默认值 —— windowTitlePatterns 空数组"）。
			const readAutoHide = () => {
				let a = {};
				try {
					const merged = readAllConfig(configPaths);
					const first = merged && typeof merged === "object" ? merged[Object.keys(merged)[0]] : null;
					if (first && typeof first.autoHide === "object" && first.autoHide) a = first.autoHide;
				} catch {
					/* 读不到就回落到全默认值 */
				}
				return {
					enabled: a.enabled !== false,
					fullscreen: a.fullscreen !== false,
					autoRestore: a.autoRestore === true,
					windowTitlePatterns: Array.isArray(a.windowTitlePatterns) ? a.windowTitlePatterns.filter((p) => typeof p === "string") : []
				};
			};
			if (method === "GET") return {
				kind: "json",
				status: 200,
				obj: readAutoHide()
			};
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				let parsed;
				try {
					parsed = JSON.parse(body ?? "null");
				} catch {
					return {
						kind: "json",
						status: 400,
						obj: { error: "invalid JSON body" }
					};
				}
				const o = parsed && typeof parsed === "object" ? parsed : {};
				const patch = {};
				if (typeof o.enabled === "boolean") patch.enabled = o.enabled;
				if (typeof o.autoRestore === "boolean") patch.autoRestore = o.autoRestore;
				if (Object.keys(patch).length === 0) return {
					kind: "json",
					status: 400,
					obj: { error: "expect { enabled?: boolean, autoRestore?: boolean }" }
				};
				const existing = readUserConfig(configPaths) ?? {};
				const nextAutoHide = {
					...existing.autoHide && typeof existing.autoHide === "object" ? existing.autoHide : {},
					...patch
				};
				const draft = {
					...existing,
					autoHide: nextAutoHide
				};
				const clean = saveUserConfig(draft, draft);
				if (!clean) return {
					kind: "json",
					status: 400,
					obj: { error: "saveUserConfig 拒绝了这份配置（校验没过）" }
				};
				await mkdir(userRoot, { recursive: true });
				await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						...readAutoHide()
					}
				};
			} catch (e) {
				// 别把异常吞成 500 空响应：把真实原因带回去，否则前端只能"点了没反应"
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
		}
		/** 透明度的持久化：与 /size 完全同一套路子（只写盘、不重启 helper）。
		*  取值 0 < opacity ≤ 1；saveUserConfig 负责校验并只保留白名单字段。 */
		if (rest === "opacity") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const petId = String(parsed?.id ?? "");
			const opacity = Number(parsed?.opacity);
			if (!petId || !Number.isFinite(opacity) || opacity <= 0 || opacity > 1) return {
				kind: "json",
				status: 400,
				obj: { error: "expect { id, opacity } with 0 < opacity <= 1" }
			};
			const merged = readAllConfig(configPaths);
			const hit = findPetInstance(merged, petId);
			if (!hit) return {
				kind: "json",
				status: 404,
				obj: { error: "pet not found: " + petId }
			};
			// 只写目标那一只：其余保持用户层原样
			const existing = readUserConfig(configPaths) ?? {};
			const current = Array.isArray(existing.pets) ? existing.pets.slice() : [];
			const at = current.findIndex((p) => String(p?.id) === petId);
			const nextPet = {
				...hit.pet,
				opacity
			};
			if (at >= 0) current[at] = nextPet;
			else current.push(nextPet);
			const clean = saveUserConfig({
				...existing,
				pets: current
			}, existing);
			if (!clean) return {
				kind: "json",
				status: 400,
				obj: { error: "invalid pet config" }
			};
			await mkdir(userRoot, { recursive: true });
			await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
			return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					id: petId,
					opacity
				}
			};
		}
		if (rest === "config/meta") return {
			kind: "json",
			status: 200,
			obj: {
				user: userConfigPath,
				default: join(PACKAGE_ROOT, "assets", "config.jsonc"),
				animations: thumbUserRoot,
				memes: memesUserRoot,
				storage: storageEntries({
					userDataRoot: userRoot,
					electronDir: electronLandingDir(),
					home: homedir(),
					packageRoot: PACKAGE_ROOT
				}),
				profile: profileNameFrom(PACKAGE_ROOT) ?? ""
			}
		};
		if (rest === "models") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const llm = ctx.llm;
				const named = (id, name$1) => {
					const pid = String(id ?? "");
					return {
						id: pid,
						name: String(name$1 ?? "") || pid
					};
				};
				let providers = (typeof llm?.listProviders === "function" ? llm.listProviders() : []).map((p) => named(p?.id, p?.name));
				if (providers.length === 0 && typeof llm?.listConfigurableProviders === "function") providers = llm.listConfigurableProviders().map((p) => named(p?.provider, p?.displayName));
				providers = providers.filter((p) => p.id);
				const catalog = await Promise.all(providers.map(async (p) => {
					let models = [];
					try {
						const list = await llm?.listModels?.(p.id);
						models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id);
					} catch {}
					return {
						...p,
						models
					};
				}));
				return {
					kind: "json",
					status: 200,
					obj: { providers: catalog }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
		}
		/** 养成系统：GET = 状态（鲸贝 / 饱食度 / 心情 / 经验等级 / 每种食物能否喂 + 原因）；
		*  POST = 喂食 { petId, food }，走四层限流，失败返回 409 + 明确原因（绝不静默失败）。
		*  路由实现与离线影子服务共用 feedRouteResult，保证"本机验证的"就是"真机跑的"。 */
		if (rest === "feed") return feedRouteResult(feed, {
			method,
			rawUrl,
			body
		});
		if (rest === "state") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			return {
				kind: "json",
				status: 200,
				obj: state.read(),
				headers: { "cache-control": "no-cache, no-store" }
			};
		}
		if (rest === "balance") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			await refreshBalance(true);
			return {
				kind: "json",
				status: 200,
				obj: { ok: true }
			};
		}
		if (rest === "whisper") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const petId$1 = String(url.searchParams.get("pet") ?? "");
			try {
				const ok = await publishWhisper(petId$1);
				return {
					kind: "json",
					status: 200,
					obj: ok ? { ok: true } : {
						ok: false,
						reason: "generate-error"
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "broadcast") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			if (!normalizeBroadcastText(o.text)) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "bad-request",
					message: "text 为空"
				}
			};
			try {
				const cfg = readAllConfig(configPaths);
				const d = decideBroadcast({
					cfg,
					requested: String(url.searchParams.get("pet") ?? ""),
					active: resolveActivePetId(),
					text: o.text,
					image: o.image,
					memeDirs: memeDirsFor
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				state.writePet(d.petId, "say", d.image ? {
					text: d.text,
					image: d.image
				} : { text: d.text });
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "anim") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			try {
				const cfg = readAllConfig(configPaths);
				const d = decideAnim({
					cfg,
					requested: String(url.searchParams.get("pet") ?? ""),
					active: resolveActivePetId(),
					name: o.name
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				state.writePet(d.petId, "anim", { name: d.name });
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "chat") {
			const petId$1 = String(url.searchParams.get("pet") ?? "");
			try {
				if (method === "GET") {
					const cfg = readAllConfig(configPaths);
					const mem = await readMemory();
					const bucket = mem[findPetInstance(cfg, petId$1)?.entry ?? petId$1] ?? {};
					const list = (bucket[petId$1]?.messages ?? []).slice();
					const rounds = memoryRounds(petId$1, cfg);
					const messages = sliceMemoryRounds(list, rounds);
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							messages,
							rounds
						}
					};
				}
				if (method === "POST") {
					const parsed = JSON.parse(body ?? "null") ?? {};
					const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
					if (!text) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "消息为空"
						}
					};
					if (text.length > 2e3) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "消息过长（限 2000 字）"
						}
					};
					const result = await chatWithPet(petId$1, text);
					return {
						kind: "json",
						status: 200,
						obj: result
					};
				}
				return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		const [scope, ...restParts] = rest.split("/");
		if (scope === "font") {
			const fontRoot = join(PACKAGE_ROOT, "assets", "fonts");
			const fontFile = resolveExisting(fontRoot, restParts.join("/"));
			if (fontFile === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-pet: font not found"
			};
			const ext$1 = fontFile.slice(fontFile.lastIndexOf(".")).toLowerCase();
			return {
				kind: "file",
				file: fontFile,
				contentType: MIME[ext$1] ?? "application/octet-stream"
			};
		}
		if (scope === "pic") {
			if (restParts[0] === "memes") {
				const segs = restParts.slice(1);
				const scoped = segs.length >= 2;
				const assetRoot = scoped ? segs[0] : "main";
				if (scoped && (assetRoot.length > 64 || ID_FORBIDDEN.test(assetRoot))) return {
					kind: "text",
					status: 400,
					body: "dsh-pet: invalid asset root"
				};
				const rel = (scoped ? segs.slice(1) : segs).join("/");
				let picFile$1;
				for (const dir of memeDirsFor(assetRoot)) {
					picFile$1 = resolveExisting(dir, rel);
					if (picFile$1 !== void 0) break;
				}
				if (picFile$1 === void 0) return {
					kind: "text",
					status: 404,
					body: "dsh-pet: pic not found"
				};
				const ext$2 = picFile$1.slice(picFile$1.lastIndexOf(".")).toLowerCase();
				return {
					kind: "file",
					file: picFile$1,
					contentType: MIME[ext$2] ?? "application/octet-stream"
				};
			}
			const picRoot = join(PACKAGE_ROOT, "assets", "pic");
			const picFile = resolveExisting(picRoot, restParts.join("/"));
			if (picFile === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-pet: pic not found"
			};
			const ext$1 = picFile.slice(picFile.lastIndexOf(".")).toLowerCase();
			return {
				kind: "file",
				file: picFile,
				contentType: MIME[ext$1] ?? "application/octet-stream"
			};
		}
		if (scope !== "thumb") return {
			kind: "text",
			status: 400,
			body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>"
		};
		const [petId, ...nameParts] = restParts;
		if (!petId || nameParts.length === 0) return {
			kind: "text",
			status: 400,
			body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>"
		};
		if (ID_FORBIDDEN.test(petId)) return {
			kind: "text",
			status: 400,
			body: "dsh-pet: invalid pet id"
		};
		const fileName = nameParts.join("/");
		const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
		if (ext !== ".webm" && ext !== ".mov") return {
			kind: "text",
			status: 400,
			body: "dsh-pet: unsupported animation format (expected .webm or .mov)"
		};
		const extraAnimDir = resolveAsset(petConfigDir, petId + "-animation");
		const file = extraAnimDir !== void 0 && existsSync(extraAnimDir) ? resolveExisting(extraAnimDir, fileName) : resolveExisting(userRootFor(ext), fileName) ?? resolveExisting(assetRootFor(ext), fileName);
		if (file === void 0) return {
			kind: "text",
			status: 404,
			body: "dsh-pet: asset not found"
		};
		return {
			kind: "file",
			file,
			contentType: MIME[ext] ?? "application/octet-stream"
		};
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			try {
				const body = req.method === "PUT" || req.method === "POST" ? await readBody(req) : void 0;
				const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", body);
				if (result.kind === "json") sendJson(res, result.status, result.obj, result.headers);
				else if (result.kind === "text") sendText(res, result.status, result.body);
				else sendFile(res, result.file, result.contentType);
			} catch (e) {
				sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
			}
		}
	}), "dsh-pet: /dsh-pet-7340 asset route");
	ctx.effect(() => {
		const dispose = ctx.on("session/event", (session, event) => {
			const type = event?.type;
			if (!type) return;
			const sessionId = String(session?.header?.id ?? session?.id ?? "unknown");
			if (type === "todo/write") {
				if (workStatus.has(sessionId)) {
					workStatus.setTask(sessionId, currentTaskFromTodo(event));
					publishWorkStatus();
				}
				return;
			}
			if (type === "user/message") {
				const source = event?.data?.source;
				if (source?.kind === "goal") {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.goalRound = true;
					turnFlags.set(sessionId, flags);
				}
				return;
			}
			if (type === "turn/start") {
				turnFlags.set(sessionId, {
					goalRound: false,
					closing: null
				});
				workStatus.setTask(sessionId, null);
				publishWorkStatus();
			}
			if (type === "tool/call" && String(event?.data?.name ?? "") === GOAL_UPDATE_TOOL) {
				const action = goalUpdateAction(String(event?.data?.arguments ?? ""));
				if (action) {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.closing = action;
					turnFlags.set(sessionId, flags);
				}
			}
			const next = reduceWorkStatus(event, turnFlags.get(sessionId));
			if (!next) {
				if (type === "turn/end") {
					turnFlags.delete(sessionId);
					cancelTerminalCleanup(sessionId);
					workStatus.clear(sessionId);
					publishWorkStatus();
				}
				return;
			}
			const seq = Number(event.seq ?? 0);
			if (!workStatus.setState(sessionId, next, seq)) return;
			publishWorkStatus();
			if (next === "success" || next === "error") scheduleTerminalCleanup(sessionId);
			else cancelTerminalCleanup(sessionId);
		});
		return () => {
			dispose();
			for (const t of terminalTimers.values()) clearTimeout(t);
			terminalTimers.clear();
		};
	}, "dsh-pet: work-status session events");
	/** 养成系统数据源：**独立监听**（不碰上面「工作状态」「通知」两处已有的 session/event 处理器，
	*  职责隔离、互不影响）。assistant/message 的 usage（input+output）→ 鲸贝累加；
	*  turn/start|tool/call|user/message → 活跃度（供空闲判定）；turn/end completed → 心情 +2。 */
	ctx.effect(() => {
		const dispose = ctx.on("session/event", (session, event) => {
			try {
				feed.handleSessionEvent(session, event);
			} catch (e) {
				console.warn("[dsh-pet] 养成事件处理异常：" + (e instanceof Error ? e.message : String(e)));
			}
		});
		return () => dispose();
	}, "dsh-pet: feed session events");
	ctx.effect(() => {
		const sessionDispose = ctx.on(
			"session/event",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(session, event) => {
				if (!shouldNotifySession(session)) return;
				const frame = reduceNotifyFrame(event);
				if (frame) pushNotifyFrame(frame);
			}
);
		const errorDispose = ctx.on(
			"agent/error",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(payload) => {
				pushNotifyFrame(agentErrorFrame(payload?.error));
			}
);
		return () => {
			sessionDispose();
			errorDispose();
		};
	}, "dsh-pet: notify frames");
	ctx.effect(() => ctx.commands.register({
		name: "balance",
		description: "手动触发桌宠余额显示（立即弹出余额气泡）",
		handler: () => {
			refreshBalance(true);
			return {
				kind: "success",
				text: "已触发桌宠余额显示"
			};
		}
	}), "dsh-pet: /balance command");
	/** 斜杠命令 /feed：留空看状态，带食物名直接喂（键盘党入口；与 HTTP 端点共用同一条 tryFeed） */
	ctx.effect(() => ctx.commands.register({
		name: "feed",
		description: "喂食 / 查看养成状态（等级 · 饱食度 · 心情 · 鲸贝 · 今日已喂）",
		input: { hint: "[食物名]（留空 = 查看状态）" },
		handler: ({ rawInput }) => {
			const arg = rawInput.trim();
			const petId = resolveActivePetId() || feed.defaultPetId();
			if (!arg) {
				const s = feed.status(petId);
				if (!s.ok) return {
					kind: "error",
					text: s.message
				};
				return {
					kind: "success",
					text: feedStatusText(s)
				};
			}
			const r = feed.tryFeed(petId, arg);
			return {
				kind: r.ok ? "success" : "error",
				text: feedResultText(r)
			};
		}
	}), "dsh-pet: /feed command");
	ctx.effect(() => {
		let disposed$1 = false;
		let timer = null;
		function arm(sec) {
			if (disposed$1) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		async function tick() {
			let sec;
			try {
				const cfg = readAllConfig(configPaths);
				sec = balancePeriodSec(cfg);
				if (flattenPetList(cfg).some((p) => p.balanceEnabled === true)) await refreshBalance();
			} catch {
				return;
			}
			arm(sec);
		}
		tick();
		return () => {
			disposed$1 = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: balance poll");
	ctx.effect(() => {
		let disposed$1 = false;
		let timer = null;
		function arm(sec) {
			if (disposed$1) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		function tick() {
			let next = 300;
			try {
				const cfg = readAllConfig(configPaths);
				const now = Date.now();
				let min = Infinity;
				for (const pet of flattenPetList(cfg)) {
					const petId = String(pet.id ?? "");
					if (!petId || pet.whisperEnabled !== true) continue;
					const sec = whisperPeriodSec(cfg, petId);
					min = Math.min(min, sec);
					if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1e3) continue;
					lastWhisperAt.set(petId, now);
					publishWhisper(petId).catch(() => {});
				}
				if (Number.isFinite(min)) next = min;
			} catch {
				return;
			}
			arm(next);
		}
		tick();
		return () => {
			disposed$1 = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: whisper poll");
	/** 养成系统主 tick：60 秒一轮，**每轮重读配置**（坑 6：动态开关必须在每轮执行时判定，
	*  否则 feed.enabled 会退化成"只在启动那一刻有效"）。一轮做：时间衰减（分段积分）→
	*  工作加速 → 心情衰减 → 跨日重置 → 合并写盘（≤1 次/分钟，喂食除外）。 */
	ctx.effect(() => {
		let disposed = false;
		let timer = null;
		function arm(sec) {
			if (disposed) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		function tick() {
			try {
				feed.tick();
			} catch (e) {
				console.warn("[dsh-pet] 养成 tick 异常：" + (e instanceof Error ? e.message : String(e)));
			}
			arm(60);
		}
		tick();
		return () => {
			disposed = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: feed tick");
	ctx.effect(() => ctx.commands.register({
		name: "pet",
		description: "选择桌宠（/chat 对话的目标；支持选择框或手输 id/名字）",
		input: { hint: "[宠物 id 或名字]（留空查看当前）" },
		handler: ({ rawInput }) => {
			const arg = rawInput.trim();
			let eff;
			try {
				eff = effectivePetList();
			} catch {
				eff = [];
			}
			if (!arg) {
				const cur = resolveActivePetId();
				const found = eff.find((p) => String(p.id) === cur);
				return {
					kind: "success",
					text: "当前桌宠：" + (found ? petDisplayName(found) : cur || "（无可交互桌宠）")
				};
			}
			const byId = eff.find((p) => String(p.id) === arg);
			if (byId) {
				activePetId = String(byId.id);
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byId)
				};
			}
			const byName = eff.filter((p) => petDisplayName(p) === arg);
			if (byName.length === 1) {
				activePetId = String(byName[0].id);
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byName[0])
				};
			}
			if (byName.length > 1) return {
				kind: "error",
				text: "「" + arg + "」有 " + byName.length + " 只桌宠（id：" + byName.map((p) => String(p.id)).join("、") + "），请用 id 指定"
			};
			return {
				kind: "error",
				text: "找不到桌宠「" + arg + "」（id 或名字都行；/pet 回车可打开选择框）"
			};
		}
	}), "dsh-pet: /pet command");
	ctx.effect(() => ctx.commands.register({
		name: "chat",
		description: "与桌宠对话：留空 = 碎碎念一句；输入消息 = 正常对话",
		input: { hint: "[消息]（留空 = 碎碎念）" },
		handler: ({ rawInput }) => {
			const petId = resolveActivePetId();
			if (!petId) return {
				kind: "error",
				text: "没有可交互的桌宠"
			};
			const text = rawInput.trim();
			if (!text) {
				publishWhisper(petId).catch((e) => console.warn("[dsh-pet] 碎碎念异常：" + (e instanceof Error ? e.message : String(e))));
				return {
					kind: "success",
					text: "已让桌宠碎碎念一句"
				};
			}
			if (text.length > 2e3) return {
				kind: "error",
				text: "消息过长（限 2000 字）"
			};
			chatWithPet(petId, text).then((r) => {
				if (!r.ok) console.warn("[dsh-pet] 对话失败 reason=" + r.reason + (r.message ? " " + r.message : ""));
			});
			return {
				kind: "success",
				text: "已发送，桌宠马上回应"
			};
		}
	}), "dsh-pet: /chat command");
	ctx.effect(() => () => {
		disposed = true;
		stopHelper("dsh-host-stop");
	});
	startHelper();
}

//#endregion
export { __feedInternals, apply, inject, name };