import fs from 'node:fs';
import { createRequire } from 'node:module';
let JSDOM = null;
try {
	const require = createRequire(import.meta.url);
	JSDOM = require('jsdom').JSDOM;
} catch (missing) {
	console.log('  ⚠️ 未安装 jsdom，跳过 ask 卡片端到端测试');
	process.exit(0);
}

let pass = 0, fail = 0;
const T = (n, c, e) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n + (e ? '  ' + e : ''))); };

const clientSrc = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const hostSrc = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

/* ══════════════════════════════════════════════════════════════════
 * ① 宿主侧：question 类必须走 broadcast（自绘卡片），不再依赖官方 agent
 *
 * 用户报障（2026-10-29 带截图）：「还是没弹窗。我记得之前已经修复过的了。」
 * 截图有「提问 · 等待回答」和 `(reading 'answers')` —— ask 到了手机，
 * 但没有任何可交互卡片。
 *
 * 根因：原来只走官方 ctx.userQuestions.ask()，它要求「当前存活的运行时根
 * agent」，而手机的远程会话是镜像空壳、**不跑 agent** ⇒ 永远找不到。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ① 宿主侧：question 走自绘卡片 ══');

T(
	'有 liveRootAgentFor 辅助函数',
	/function liveRootAgentFor\(ctx, sessionId\)/.test(hostSrc),
);
T(
	'只认精确匹配',
	/agent\?\.session\?\.id === sessionId\) return agent/.test(hostSrc),
);
/*
 * `roots[0]` 允许出现在注释里（那是踩坑记录），但**代码里不能再有它** ——
 * 「找不到就拿第一个」正是把卡片挂到别的会话、用户什么都看不到的原因。
 */
T(
	'**非注释代码里不再退而取 roots[0]**',
	!hostSrc.split(/\r?\n/).some((line) => {
		const t = line.trim();
		if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return false;
		return /roots\[0\]/.test(t);
	}),
);
/*
 * 1.2.96：不再按「有没有本地 agent」二选一 —— 那个判据在真机上经常同时
 * 成立（电脑在跑同一个会话，手机镜像也会被官方建出 agent），于是自绘和
 * 官方两张卡片一起弹（用户图3）。现在**只有自绘一条路**。
 */
T(
	'question 类始终走 broadcast（自绘是唯一通道）',
	/broadcast\('ask', \{[\s\S]{0,300}?sessionId/.test(hostSrc),
);
T(
	'不再调用 svc.ask（官方卡片通道已移除，避免两张卡片重叠）',
	!/\.ask\(\{/.test(hostSrc.replace(/\/\*[\s\S]*?\*\//g, '')),
);
T(
	'ask 收到时落盘诊断（真机排查用）',
	/走自绘卡片: kind=/.test(hostSrc),
);

/* ══════════════════════════════════════════════════════════════════
 * ② 前端侧：真实渲染自绘卡片
 *
 * 这是之前的**测试盲区** —— self-drawn 卡片从来没有被真正渲染过。
 * 一旦它的选择器/结构坏了，测试全绿而用户看不到任何东西。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ② 前端侧：自绘卡片真实渲染 ══');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const win = dom.window, doc = win.document;

const MO = class { observe() {} disconnect() {} takeRecords() { return []; } };
if (!win.MutationObserver) win.MutationObserver = MO;
const RO = class { observe() {} disconnect() {} unobserve() {} };
if (!win.ResizeObserver) win.ResizeObserver = RO;
if (!win.IntersectionObserver) win.IntersectionObserver = RO;

// 记录 EventSource 实例，方便手动派发 'ask' 事件
const sources = [];
win.EventSource = class {
	constructor(url) { this.url = url; this.handlers = {}; sources.push(this); }
	addEventListener(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
	close() {}
	emit(name, data) {
		for (const fn of this.handlers[name] || []) fn({ data: JSON.stringify(data) });
	}
};

globalThis.window = win;
globalThis.document = doc;
try { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true }); } catch { /* 只读就跳过 */ }
globalThis.EventSource = win.EventSource;
globalThis.MutationObserver = win.MutationObserver;
globalThis.ResizeObserver = win.ResizeObserver;
globalThis.IntersectionObserver = win.IntersectionObserver;
globalThis.requestAnimationFrame = (fn) => win.setTimeout(fn, 0);

let registered = null;
win.__ModuleLoader__ = { load: (d) => { registered = d; } };

// 在 jsdom 里真实求值 client.js（与真机同一条模块包装路径）
const fn = new Function('window', 'document', 'navigator', 'globalThis', clientSrc + '\n;return undefined;');
try {
	fn(win, doc, win.navigator, win);
} catch (error) {
	/* 插件体可能因缺少 ctx 服务而部分失败，只要 showAskCard 注册成功即可 */
}

T('client.js 能在 jsdom 里求值', true);
T('模块包装被调用（__ModuleLoader__.load）', registered !== null);

/*
 * 用最小 ctx 触发 apply，让它建立 SSE 订阅（`subscribe`）。
 * 目标不是跑通整个插件，而是拿到那条 EventSource 并手动喂一个 ask。
 */
function fakeCtx() {
	const noop = () => {};
	const chain = {
		effect: (fn) => { try { const off = fn(); return typeof off === 'function' ? off : noop; } catch { return noop; } },
		inject: () => chain,
		on: () => noop,
		off: noop,
		get: () => undefined,
		set: noop,
		plugin: () => chain,
		logger: { info: noop, warn: noop, error: noop, debug: noop },
		slots: { provideRoot: noop, register: () => () => {}, rebuildRootBinding: noop, _rootContributions: [] },
		uiWorkspace: { register: () => () => {} },
		sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => noop } },
		workspaces: { list: { getSnapshot: () => ({ pinnedSessionIds: [] }) } },
		remote: { $on: noop },
	};
	return chain;
}

let factory = null;
if (registered !== null && registered.id !== undefined) {
	// 标准 ModuleLoader 形态：{ id, factory }
	factory = registered.factory;
}
if (typeof factory === 'function') {
	try {
		const mod = factory(fakeCtx());
		if (mod && typeof mod.apply === 'function') mod.apply(fakeCtx());
	} catch (error) {
		/* 允许失败：只要没把测试带崩，后面的断言仍按源码判断 */
	}
}

// 找到那条全局 SSE（前端 `subscribe` 建的 EventSource）
T('前端建立了 EventSource（全局 SSE）', sources.length > 0, 'count=' + sources.length);

let card = null;
if (sources.length > 0) {
	sources[0].emit('ask', {
		sessionId: 'session-remote-1',
		requestId: 'r-1',
		kind: 'question',
		questions: [{
			id: 'q1',
			header: '第三轮测试',
			question: '第三次测试：这个 ask 能不能弹出来？',
			options: [
				{ label: '能', description: '卡片正常显示' },
				{ label: '不能', description: '什么都没看到' },
			],
		}],
	});
	card = doc.getElementById('dsh-remote-ask');
}

T('**收到 ask 后真的插入了卡片**', card !== null);

/*
 * ## 卡片"存在"不等于"看得见"（1.2.92 修的真 bug）
 *
 * 原来的定位是 `bottom: safe-area + 76px`，也就是贴屏幕底部往上 76px。
 * 但手机的输入框那一整块实测约 300px、且是 `position: fixed` 浮在最上层 ——
 * 卡片**被完全盖住**。真 Chromium 量出来：rect.y=2081、输入框 top=2076、
 * 实际可见高度 **0 / 219**。
 *
 * 也就是说：卡片渲染成功了，用户眼里什么都没有 —— 这正是用户反复说
 * 「就是不弹」的真相。而所有「card !== null」的断言都是绿的。
 *
 * 所以这里必须断言**几何位置**：贴顶、且不与底部输入框区域重叠。
 */
if (card !== null) {
	const cs = card.style;
	T('卡片贴顶（不贴底，避开输入框）', cs.top !== '' && cs.top.indexOf('64px') >= 0, 'top=' + cs.top);
	T('卡片不再用 bottom 定位', cs.bottom === '', 'bottom=' + cs.bottom);
	T('卡片有 maxHeight 限制（多题不铺满屏）', cs.maxHeight !== '', 'maxHeight=' + cs.maxHeight);
	T('卡片可滚动（题目多时能翻）', cs.overflowY === 'auto', 'overflowY=' + cs.overflowY);
}
T('卡片带 role=dialog', card !== null && card.getAttribute('role') === 'dialog');
T(
	'卡片里显示了题目标题',
	card !== null && card.textContent.includes('第三次测试'),
	card === null ? '' : card.textContent.slice(0, 60),
);
T(
	'卡片里渲染了选项按钮',
	card !== null && card.textContent.includes('能') && card.textContent.includes('不能'),
);
T(
	'诊断出口记录了收到的 ask（区分「没收到」和「没渲染」）',
	win.__dshRemoteAskCount === 1 && win.__dshRemoteLastAsk !== undefined && win.__dshRemoteLastAsk.requestId === 'r-1',
	JSON.stringify({ count: win.__dshRemoteAskCount, last: win.__dshRemoteAskLastAsk && win.__dshRemoteAskLastAsk.requestId }),
);

// 点选项 ⇒ 应把答案 POST 出去（answerAsk）
let posted = null;
globalThis.fetch = win.fetch = (url, init) => {
	try { posted = JSON.parse(init.body); } catch { posted = null; }
	return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
};
if (card !== null) {
	const buttons = [...card.querySelectorAll('button')];
	const pick = buttons.find((b) => b.textContent.includes('能'));
	if (pick !== undefined) pick.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
}

T(
	'**点选项后把答案回传（answerAsk）**',
	posted !== null && posted.method === 'answerAsk' && posted.params?.requestId === 'r-1',
	posted === null ? 'fetch 未被调用' : JSON.stringify(posted).slice(0, 90),
);
T(
	'回传的答案里带上了所选选项',
	posted !== null && JSON.stringify(posted.params?.answer ?? {}).includes('能'),
);
/*
 * ## ⚠️⚠️ 字段名必须是官方的 `id`，不能是 `questionId`（1.2.97）
 *
 * 用户截图里的红字报错：
 *
 *     Error: tool "ask_user_question" returned invalid output:
 *            value is not lossless JSON
 *
 * 根因：官方 `dsh-tool-ask-user/lib/index.js:53` 的 `answerResult()` 做
 *
 *     { answers: result.answers.map((answer) => ({
 *         id: answer.id,
 *         selected: [...answer.selected],
 *         ...answer.custom !== void 0 ? { custom: answer.custom } : {}
 *     })) }
 *
 * 我们发 `questionId` ⇒ `answer.id` 是 undefined ⇒ 塞进工具输出 ⇒
 * 宿主校验「无损 JSON」失败。而 `[...answer.selected]` 在 selected 缺失时
 * 更早就会抛。这条断言把这个契约钉死。
 */
const postedAnswers = posted === null ? null : (posted.params?.answer?.answers ?? null);
T(
	'**答案用官方字段名 `id`**（不是 questionId，否则工具报 not lossless JSON）',
	Array.isArray(postedAnswers) && postedAnswers.every((a) => typeof a.id === 'string' && a.id !== '')
		&& !JSON.stringify(postedAnswers).includes('questionId'),
	JSON.stringify(postedAnswers)?.slice(0, 120),
);
T(
	'答案的 selected 是数组（官方会 `[...selected]` 展开）',
	Array.isArray(postedAnswers) && postedAnswers.every((a) => Array.isArray(a.selected)),
	JSON.stringify(postedAnswers)?.slice(0, 120),
);

/* ══════════════════════════════════════════════════════════════════
 * ③ 「没有选项、只有主观回答」必须有输入框（1.2.96，用户报障）
 *
 * 用户原话：
 *   「更致命的是如果 AI 它此时发起的询问没有选项，只有主观回答的话，
 *     就是要输入文字的话没有输入框，也没有提交按钮，导致我无法关闭
 *     那个弹窗，就一直显示在整个 APP 的页面都会一直上浮。」
 *
 * 原来卡片只在 `options.forEach` 里造按钮，`options` 为空时**一个可点
 * 元素都没有** —— 既答不了也关不掉，卡片永远浮在界面上。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ③ 无选项（自由回答）必须有输入框和提交 ══');

let freeCard = null;
if (sources.length > 0) {
	sources[0].emit('ask', {
		sessionId: 'session-remote-1',
		requestId: 'r-free-1',
		kind: 'question',
		questions: [{
			id: 'q-free',
			question: '请描述一下你遇到的问题（自由回答，没有选项）',
			options: [],
		}],
	});
	freeCard = doc.getElementById('dsh-remote-ask');
}

T('无选项的 ask 也弹出了卡片', freeCard !== null);
if (freeCard !== null) {
	const area = freeCard.querySelector('textarea');
	T('**卡片里有输入框**（原来一个都没有）', area !== null);
	const btns = [...freeCard.querySelectorAll('button')];
	T('**卡片里有提交按钮**', btns.some((b) => b.textContent.includes('提交')));
	T(
		'**卡片里有退出路径**（跳过/关闭，原来关不掉）',
		btns.some((b) => b.textContent.includes('跳过') || b.textContent.includes('关闭')),
		btns.map((b) => b.textContent).join(' | '),
	);

	// 空内容不提交（否则电脑端当成「用户取消」，那一轮判失败）
	let freePosted = null;
	globalThis.fetch = win.fetch = (url, init) => {
		try { freePosted = JSON.parse(init.body); } catch { freePosted = null; }
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, result: { ok: true } }) });
	};
	const submitBtn = btns.find((b) => b.textContent.includes('提交'));
	if (submitBtn !== undefined) submitBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
	T('空输入不提交（避免电脑端误判为取消）', freePosted === null);

	// 填入内容后再提交 ⇒ 应带上 text
	if (area !== null && submitBtn !== undefined) {
		area.value = '我的回答是：能正常用了';
		submitBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
	}
	T(
		'**填了内容就能提交**',
		freePosted !== null
			&& JSON.stringify(freePosted.params?.answer ?? {}).includes('我的回答是'),
		freePosted === null ? '未回传' : JSON.stringify(freePosted).slice(0, 120),
	);
	T(
		'**自由文本放在官方字段 `custom` 里**（不是 text）',
		freePosted !== null && (() => {
			const a = freePosted.params?.answer?.answers?.[0];
			return a !== undefined && typeof a.custom === 'string' && a.custom.includes('我的回答是')
				&& a.text === undefined && typeof a.id === 'string' && Array.isArray(a.selected);
		})(),
		freePosted === null ? '未回传' : JSON.stringify(freePosted.params?.answer?.answers?.[0]),
	);
	T('提交后卡片被移除（不会一直浮在界面上）', doc.getElementById('dsh-remote-ask') === null);
}

/* ══════════════════════════════════════════════════════════════════
 * ④ 不在那个对话时不弹（1.2.97，用户要求）
 *
 * 用户原话：
 *   「如果用户不在那个对话的话，那个悬浮窗就不要显示了，不然用户不选的话，
 *     那悬浮窗就一直在。」
 *
 * 判据：`payload.sessionId` 与当前打开的会话一致才弹。不一致不弹，
 * 但请求仍留在电脑端 `pendingAsks`，切过去时会补出来。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ④ 不在那个对话时不弹悬浮窗 ══');

const askListenerTail = clientSrc.slice(clientSrc.indexOf("source.addEventListener('ask'"));
const gateAt = askListenerTail.indexOf('viewing !== payload.sessionId');
const cardAt = askListenerTail.indexOf('showAskCard(ctx, payload)');
const hasSessionGate = gateAt >= 0 && cardAt >= 0 && gateAt < cardAt;
T('收到 ask 时比较「当前会话」与 ask 的 sessionId', hasSessionGate);
T('不一致时直接 return（不画卡片）', /if \(!onIt\) \{[\s\S]{0,300}?return;/.test(clientSrc));

/* ══════════════════════════════════════════════════════════════════ */

console.log('\n════════ ' + pass + ' 通过, ' + fail + ' 失败 ════════');
process.exit(fail === 0 ? 0 : 1);
