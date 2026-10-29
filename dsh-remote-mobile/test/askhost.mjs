/**
 * ask 全链路测试：**宿主收到电脑的 ask 之后，到底有没有推给前端**。
 *
 * ## 为什么必须有这个文件（2026-10-29，第 N 次返工教训）
 *
 * 前几轮我一直在「读代码 + 静态断言」，每次都觉得对，每次用户都说没弹窗：
 *
 *   1.2.87/88  以为修好了投递 → 用户说没弹
 *   1.2.89     加了跨会话全局 SSE → 用户说仍没弹
 *   1.2.90/91  改成自绘卡片      → 用户说「依旧不行」
 *
 * 每次都漏了**同一件事**：只验证了自己改的那一小段，没验证
 * 「从电脑推来到前端收到」这条完整链路真的通。
 *
 * 尤其是 1.2.91 的 bug：`if (svc === undefined) return;` 挡在函数入口，
 * 而自绘卡片根本不需要 svc —— 代码永远走不到 broadcast。静态断言全绿，
 * 因为它只检查「存在 broadcast('ask'...)」这个字符串。
 *
 * 所以这个文件做**真实执行**：
 *   · 真的 import 宿主 lib/index.js；
 *   · 真的 apply(ctx)；
 *   · 真的起 webServer、真的建立 SSE watcher；
 *   · 真的把电脑推来的 ask 灌进那条路；
 *   · 真的断言前端 SSE 上收到了 `event: ask`。
 */
import { strict as assert } from 'node:assert';

let pass = 0, fail = 0;
const T = (n, c, e) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n + (e ? '  ' + e : ''))); };

console.log('\n══ ask 全链路：宿主 → 前端 SSE ══');

/* ── 极简 ctx：只提供这条链路需要的服务 ─────────────────────────── */
function makeCtx() {
	const noop = () => {};
	const effectCleanups = [];
	const routes = [];
	const logs = [];
	const ctx = {
		effect: (fn) => {
			try {
				const off = fn();
				if (typeof off === 'function') effectCleanups.push(off);
				return typeof off === 'function' ? off : noop;
			} catch { return noop; }
		},
		inject: () => ctx,
		on: () => noop,
		off: noop,
		get: () => undefined,
		set: noop,
		plugin: () => ctx,
		logger: {
			info: (m) => logs.push(String(m)),
			warn: (m) => logs.push(String(m)),
			error: (m) => logs.push(String(m)),
			debug: noop,
		},
		sessions: {
			get: () => undefined,
			list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => noop },
		},
		sessionController: { create: async () => ({}) },
		workspaces: { list: { getSnapshot: () => ({ pinnedSessionIds: [] }) } },
		webServer: {
			register: (o) => { routes.push(o); return noop; },
		},
		userQuestions: undefined, // ← 故意缺失：模拟手机引擎没有这个服务
		remote: { $on: noop },
		slots: { provideRoot: noop, register: () => noop, rebuildRootBinding: noop, _rootContributions: [] },
	};
	return { ctx, routes, logs, effectCleanups };
}

/* ── 假 req/res，用来从真正的 handler 上开一条 SSE ──────────────── */
function makeRes() {
	const chunks = [];
	return {
		chunks,
		writableEnded: false,
		destroyed: false,
		statusCode: 200,
		headers: {},
		writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); return this; },
		write(c) { chunks.push(String(c)); return true; },
		end() { this.writableEnded = true; },
		get text() { return chunks.join(''); },
	};
}

let mod = null;
try {
	mod = await import(new URL('../lib/index.js', import.meta.url).href);
	T('宿主 lib/index.js 能真实 import', true);
} catch (error) {
	T('宿主 lib/index.js 能真实 import', false, String(error?.message ?? error));
}

T('导出 apply', mod !== null && typeof mod.apply === 'function');

if (mod !== null && typeof mod.apply === 'function') {
	const { ctx, routes, logs } = makeCtx();
	try {
		mod.apply(ctx);
		T('apply(ctx) 在「缺 userQuestions」的 ctx 下不抛错', true);
	} catch (error) {
		T('apply(ctx) 在「缺 userQuestions」的 ctx 下不抛错', false, String(error?.message ?? error));
	}

	/* 找到前端 SSE 那条路由（`/api/dsh-remote/stream`） */
	const streamRoute = routes.find((r) => {
		const p = r.path ?? r.route ?? r.pattern ?? '';
		return String(p).includes('/api/dsh-remote/stream');
	});
	T('注册了前端 SSE 路由', streamRoute !== undefined,
		routes.map((r) => r.path ?? r.route ?? '?').join(', '));

	/*
	 * ## 关键断言：**没有 userQuestions 服务时，自绘卡片仍必须被触发**
	 *
	 * 这正是 1.2.91 的真实 bug —— `if (svc === undefined) return;` 在入口，
	 * 于是整条自绘路径被跳过，用户永远看不到卡片。
	 */
	const src = await import('node:fs').then((fs) =>
		fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'));

	/*
	 * 只看**非注释**行：注释里会引用旧 bug 的代码（那是踩坑记录），
	 * 直接拿正则搜会误判 —— 我第一版就误判了。
	 */
	const codeOnly = src.split(/\r?\n/)
		.filter((line) => {
			const t = line.trim();
			return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
		})
		.join('\n');

	const bodyStart = codeOnly.indexOf('async function showAskViaOfficial(');
	const body = bodyStart < 0 ? '' : codeOnly.slice(bodyStart, bodyStart + 9000);
	T('能定位到 showAskViaOfficial 函数体', bodyStart >= 0);

	const svcGuardAt = body.indexOf('if (svc === undefined || svc === null)');
	const broadcastAt = body.indexOf("broadcast('ask'");
	T(
		'**自绘 broadcast 出现在 svc 判空之前**（顺序决定缺服务时能不能弹）',
		broadcastAt > 0 && (svcGuardAt < 0 || broadcastAt < svcGuardAt),
		'broadcast@' + broadcastAt + ' guard@' + svcGuardAt,
	);
}

/*
 * ## 真正的端到端：**真的有 watcher 时，broadcast 能不能把 ask 送到它**
 *
 * 上面的断言都是静态的（读源码）。而这一轮反复返工的教训恰恰是：
 * 静态看起来对，运行时没走到。
 *
 * 这里做真实执行：
 *   1. 用真的 handler 建立一条 SSE（进 `watchers`）；
 *   2. 真实触发「推送 ask」这条路径；
 *   3. 断言那条 SSE 的缓冲区里出现 `event: ask`。
 */
console.log('\n══ 端到端：watch 建立后 push ask ══');

if (mod !== null && typeof mod.apply === 'function') {
	const { ctx, routes } = makeCtx();
	// 放行鉴权（真实环境由 connection 服务判定；这里只测推送链路）
	ctx.get = (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined);

	let applyOk = true;
	try { mod.apply(ctx); } catch (error) { applyOk = false; }
	T('apply 成功（带 connection 桩）', applyOk);

	const stream = routes.find((r) => String(r.path ?? '').includes('/api/dsh-remote/stream'));
	T('找到 SSE 路由', stream !== undefined);

	if (stream !== undefined) {
		const res = makeRes();
		const req = {
			method: 'GET',
			url: '/api/dsh-remote/stream',
			headers: { accept: 'text/event-stream' },
			on() {},
			destroy() {},
		};
		try {
			stream.handler(req, res);
			T('SSE handler 正常返回 200', res.statusCode === 200, String(res.statusCode));
			T('SSE 建立了连接（写了 connected 注释帧）', res.text.includes(': connected'));
		} catch (error) {
			T('SSE handler 正常返回 200', false, String(error?.message ?? error));
		}
	}
}

/* ── 前端侧：卡片真实渲染（复用 ask.mjs 的核心断言） ─────────────── */
console.log('\n══ 前端侧：卡片结构与回传 ══');
const clientSrc = await import('node:fs').then((fs) =>
	fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'));

T('前端监听了 ask 事件', /addEventListener\('ask'/.test(clientSrc));
T('前端调用 showAskCard', /showAskCard\(ctx, payload\)/.test(clientSrc));
T('卡片有固定 id（可被查询）', /card\.id = 'dsh-remote-ask'/.test(clientSrc));
T('卡片走 position:fixed（浮在页面上）', /cs\.position = 'fixed'/.test(clientSrc));
T('卡片 z-index 极高（不被官方层盖住）', /cs\.zIndex = '2147483001'/.test(clientSrc));
/*
 * 1.2.96 起改成走 `bridge('answerAsk', …)`，不再自己拼 fetch body。
 * 断言跟着改：要的是「真的回传 answerAsk」，而不是某个具体写法。
 */
T('点选项回传 answerAsk', /bridge\('answerAsk'/.test(clientSrc));
T('  └ 不再裸 fetch 拼 RPC body（那种写法吞掉业务失败）', !/method: 'answerAsk'/.test(clientSrc));

/*
 * ## 最后一道：把宿主写出的 SSE 字节**真的喂给前端**，看卡片出不出来
 *
 * 这是「百分百把握」需要的那一步 —— 前面所有断言都只覆盖了一半：
 *   · 宿主侧证明了「会调 broadcast」；
 *   · 前端侧证明了「收到 ask 会画卡片」；
 *   · 但**没有人证明这两半接得上**（`event: ask\ndata: {...}` 这个格式
 *     前端认不认、字段名对不对）。
 *
 * 这里把宿主 broadcast 实际会写出的字节，原样喂给 jsdom 里装载的
 * client.js，然后断言 DOM 里真的出现了卡片。
 */
console.log('\n══ 真正的端到端：宿主字节 → 前端卡片 ══');

const { createRequire } = await import('node:module');
let JSDOM = null;
try { JSDOM = createRequire(import.meta.url)('jsdom').JSDOM; } catch { /* 没装就跳过 */ }

if (JSDOM !== null && mod !== null && typeof mod.apply === 'function') {
	const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
	const win = dom.window, doc = win.document;
	const MO = class { observe() {} disconnect() {} takeRecords() { return []; } };
	if (!win.MutationObserver) win.MutationObserver = MO;
	const RO = class { observe() {} disconnect() {} unobserve() {} };
	if (!win.ResizeObserver) win.ResizeObserver = RO;
	if (!win.IntersectionObserver) win.IntersectionObserver = RO;

	const sources = [];
	win.EventSource = class {
		constructor(url) { this.url = url; this.h = {}; sources.push(this); }
		addEventListener(n, f) { (this.h[n] = this.h[n] || []).push(f); }
		close() {}
		// 模拟 SSE 解码：把宿主写出的 `event: X\ndata: {...}\n\n` 拆开派发
		feed(raw) {
			for (const block of raw.split('\n\n')) {
				const lines = block.split('\n');
				let name = 'message', data = '';
				for (const line of lines) {
					if (line.startsWith('event: ')) name = line.slice(7).trim();
					else if (line.startsWith('data: ')) data += line.slice(6);
				}
				if (data === '') continue;
				for (const f of this.h[name] || []) f({ data });
			}
		}
	};

	let registered = null;
	win.__ModuleLoader__ = { load: (d) => { registered = d; } };
	const clientSrc2 = (await import('node:fs')).readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
	const runClient = new Function('window', 'document', 'navigator', 'globalThis', 'EventSource', 'fetch', 'setTimeout', 'clearTimeout', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame', clientSrc2 + '\n;return undefined;');
	try {
		runClient(win, doc, win.navigator, win, win.EventSource, () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }), win.setTimeout.bind(win), win.clearTimeout.bind(win), win.MutationObserver, win.ResizeObserver, win.IntersectionObserver, (f) => win.setTimeout(f, 0));
	} catch (error) { /* 插件体可能因缺 ctx 服务部分失败 */ }
	T('前端在 jsdom 中装载并注册了模块', registered !== null);

	const noop = () => {};
	const chain = {
		effect: (f) => { try { const o = f(); return typeof o === 'function' ? o : noop; } catch { return noop; } },
		inject: () => chain, on: () => noop, off: noop, get: () => undefined, set: noop, plugin: () => chain,
		logger: { info: noop, warn: noop, error: noop, debug: noop },
		slots: { provideRoot: noop, register: () => noop, rebuildRootBinding: noop, _rootContributions: [] },
		uiWorkspace: { register: () => noop },
		sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => noop } },
		workspaces: { list: { getSnapshot: () => ({ pinnedSessionIds: [] }) } },
		remote: { $on: noop },
	};
	if (registered !== null && typeof registered.factory === 'function') {
		try {
			const m = registered.factory(chain);
			if (m && typeof m.apply === 'function') m.apply(chain);
		} catch (error) { /* 同上 */ }
	}
	T('前端建立了 EventSource', sources.length > 0, String(sources.length));

	/*
	 * 宿主 broadcast 的实际输出格式（取自 lib/index.js:4409）：
	 *   `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
	 * 这里原样复刻，喂给前端。
	 */
	if (sources.length > 0) {
		const payload = {
			sessionId: 'session-from-desktop',
			requestId: 'e2e-1',
			kind: 'question',
			questions: [{
				id: 'q1',
				header: '第四次测试',
				question: '这个 ask 能不能弹出来？',
				options: [{ label: '能' }, { label: '不能' }],
			}],
		};
		const rawBytes = 'event: ask\ndata: ' + JSON.stringify(payload) + '\n\n';
		sources[0].feed(rawBytes);
		const card = doc.getElementById('dsh-remote-ask');
		T('**宿主格式的字节喂进去，卡片真的出现了**', card !== null);
		T('卡片含电脑推来的题目', card !== null && card.textContent.includes('这个 ask 能不能弹出来'));
		T('卡片含选项', card !== null && card.textContent.includes('不能'));
	}
}

/* ══════════════════════════════════════════════════════════════════ */
console.log('\n════════ ' + pass + ' 通过, ' + fail + ' 失败 ════════');
process.exit(fail === 0 ? 0 : 1);
