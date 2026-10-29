/**
 * 轮询补齐端到端测试：**长连接死了，手机上还能不能看到新内容**。
 *
 * ## 为什么必须有这个文件（2026-10-29）
 *
 * 用户原话：
 *
 *   「我就是有一点搞不懂，既然我们点添加工作群的时候会触发刷新，
 *     那我们为什么不能实时刷新呢？」
 *
 * 这句话指出了正确方向：**短连接（HTTP RPC）是通的，死的是长连接（SSE）**。
 * 而我们把全部实时性押在了那条会死的长连接上。
 *
 * 修法是每 3 秒用短连接问一次「电脑末尾 seq 是多少」，落后就补拉。
 *
 * ## 这个测试为什么是真端到端
 *
 * 它**真的**：
 *   · 起一个本地 HTTP 服务器冒充电脑（真监听端口、真应答）；
 *   · 用 `DSH_HOME` 指向临时目录，写入真实配对配置；
 *   · 真 import 插件、真 `apply(ctx)`；
 *   · 真建立 SSE watcher（走插件自己的 handler）；
 *   · 真等 3 秒定时器触发轮询；
 *   · 真断言前端 SSE 上收到了 `event:` 帧，且本地会话日志真的多了一条。
 *
 * 之前的教训是：静态断言 + 只测自己改的那一小段，会一直"全绿但没用"。
 */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const T = (n, c, e) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n + (e ? '  ' + e : ''))); };

console.log('\n══ 轮询补齐：短连接如何救回长连接 ══');

/* ── ① 假电脑：只应答这个测试需要的三个方法 ─────────────────────── */
const SESSION_ID = 'session-poll-test';
/** 是否返回一个待回答的 ask（在测试后段打开，验证弹窗也能补出来）。 */
let requestAnswer = false;
let rpcMethods = [];

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', (c) => chunks.push(c));
	req.on('end', () => {
		let body = {};
		try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
		const method = body.method;
		rpcMethods.push(method);

		/*
		 * ⚠️ 真实电脑端的响应形状是 `{ ok: true, ...result }` ——
		 * `callRemote` 里有一行 `if (payload.ok !== true) throw`。
		 * 我第一版直接回裸对象，于是每次轮询都在这里抛「远程请求失败」，
		 * 测试因此红了一片 —— 这也正说明这个测试确实在真跑链路。
		 */
		const reply = (payload) => {
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ ok: true, result: payload }));
		};

		if (method === 'sessionCursors') {
			// 电脑上这个会话已经推进到 seq 2（本地一开始只有 1 条）
			console.log('    [srv] sessionCursors 被调用，返回 seq=2');
			reply({ cursors: { [SESSION_ID]: 2 } });
			return;
		}
		if (method === 'pendingAsks') {
			/*
			 * 模拟「用户不在线时电脑发起了一个 ask」——
			 * 它不落盘，只能靠这个接口取回来（见 1.2.95 的注释）。
			 */
			reply({ requests: requestAnswer ? [{
				requestId: 'req-poll-1',
				kind: 'question',
				sessionId: SESSION_ID,
				payload: { questions: [{ id: 'q1', title: '轮询能补出弹窗吗？', options: [{ id: 'a', label: '能' }] }] },
				at: Date.now(),
				ageMs: 1000,
			}] : [] });
			return;
		}
		if (method === 'readEventRange') {
			const from = body.params?.fromSeq ?? 0;
			const to = body.params?.toSeq ?? 0;
			const events = [];
			for (let seq = from; seq <= to; seq += 1) {
				events.push({
					seq,
					time: Date.now(),
					type: 'assistant/message',
					data: { turn: 2, step: 1, text: '这是轮询补回来的第 ' + seq + ' 条' },
				});
			}
			reply({ events });
			return;
		}
		// 其它方法一律给个安全空响应，避免轮询路径上意外抛错
		reply({ ok: true });
	});
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
T('假电脑服务器已启动', typeof port === 'number' && port > 0, String(port));

/* ── ② 真实配对配置 + 临时 DSH_HOME ─────────────────────────────── */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-poll-'));
const stateDir = path.join(home, 'dsh-remote');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'mobile.json'), JSON.stringify({
	token: 'test-token-1234567890',
	endpoint: `http://127.0.0.1:${port}`,
}), 'utf8');
process.env.DSH_HOME = home;

/* ── ③ 极简 ctx ─────────────────────────────────────────────────── */
function makeCtx() {
	const noop = () => {};
	const routes = [];
	const logs = [];
	/** 本地会话：一开始有 1 条事件（seq 0）。 */
	const appended = [];
	const session = {
		id: SESSION_ID,
		seq: 0,
		log: [{ seq: 0, type: 'turn/end', data: { turn: 1 } }],
		append(event) { appended.push(event); this.log.push(event); this.seq = event.seq + 1; },
		header: { cwd: '/tmp/demo' },
	};
	const ctx = {
		effect: (fn) => { try { const off = fn(); return typeof off === 'function' ? off : noop; } catch { return noop; } },
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
			get: (id) => (id === SESSION_ID ? session : undefined),
			list: { getSnapshot: () => ({ ids: [SESSION_ID], byId: { [SESSION_ID]: session } }), subscribe: () => noop },
		},
		sessionController: { create: async () => ({}) },
		workspaces: { list: { getSnapshot: () => ({ pinnedSessionIds: [] }) } },
		webServer: {
			register: (o) => { routes.push(o); return noop; },
			// 插件可能用别的注册形态，一并兜住
		},
		remote: { $on: noop },
		slots: { provideRoot: noop, register: () => noop, rebuildRootBinding: noop, _rootContributions: [] },
	};
	return { ctx, routes, logs, session, appended };
}

function makeRes() {
	const chunks = [];
	return {
		writableEnded: false,
		destroyed: false,
		statusCode: 200,
		writeHead(code) { this.statusCode = code; return this; },
		write(c) { chunks.push(String(c)); return true; },
		end() { this.writableEnded = true; },
		get text() { return chunks.join(''); },
	};
}

/* ── ④ 真加载插件 ───────────────────────────────────────────────── */
let mod = null;
try {
	mod = await import(new URL('../lib/index.js', import.meta.url).href);
	T('插件能真实 import', true);
} catch (error) {
	T('插件能真实 import', false, String(error?.message ?? error));
}

const { ctx, routes, logs, session } = makeCtx();
if (mod !== null && typeof mod.apply === 'function') {
	// 放行鉴权
	ctx.get = (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined);
	try {
		mod.apply(ctx);
		T('apply(ctx) 不抛错', true);
	} catch (error) {
		T('apply(ctx) 不抛错', false, String(error?.message ?? error));
	}
}

/* ── ⑤ 建立真实 SSE watcher（走插件自己的 handler） ─────────────── */
const stream = routes.find((r) => String(r.path ?? '').includes('/api/dsh-remote/stream'));
T('找到前端 SSE 路由', stream !== undefined, routes.map((r) => r.path ?? '?').join(', '));

let res = null;
if (stream !== undefined) {
	res = makeRes();
	const req = {
		method: 'GET',
		url: '/api/dsh-remote/stream',
		headers: { accept: 'text/event-stream' },
		on() {},
		destroy() {},
	};
	try {
		stream.handler(req, res);
		T('SSE watcher 建立成功', res.text.includes(': connected'));
	} catch (error) {
		T('SSE watcher 建立成功', false, String(error?.message ?? error));
	}
}

/* ── ⑥ 等 3 秒轮询真的跑一轮 ────────────────────────────────────── */
console.log('  … 等待轮询定时器（约 4 秒）');
await new Promise((resolve) => setTimeout(resolve, 4200));

T('轮询确实调了 sessionCursors（短连接探测）', rpcMethods.includes('sessionCursors'),
	rpcMethods.join(','));
T('发现落后后调了 readEventRange（补拉）', rpcMethods.includes('readEventRange'),
	rpcMethods.join(','));

// 把宿主自己的诊断日志读出来，看轮询到底走到哪一步
try {
	const dbg = fs.readFileSync(path.join(stateDir, 'mobile-debug.log'), 'utf8');
	const lines = dbg.split('\n').filter((l) => l.includes('轮询') || l.includes('seq'));
	console.log('    [dbg] ' + (lines.slice(-6).join('\n    [dbg] ') || '(无轮询相关日志)'));
} catch (e) { console.log('    [dbg] 无日志文件'); }

const sseText = res === null ? '' : res.text;
T('**前端 SSE 上真的收到了补回来的事件**', sseText.includes('event: event'),
	sseText.slice(0, 200));
T('补回来的内容确实是那条消息', sseText.includes('轮询补回来的'), '');
T('本地会话日志真的多了一条（落盘）', session.log.length > 1, 'log=' + session.log.length);

/* ── ⑥b 弹窗：文字之外，ask 也必须靠轮询补出来 ─────────────── */
/*
 * 用户报障原话：「手动去添加工作区刷新了才显示，但是它也只显示文字，
 * 没有显示弹窗。」
 *
 * 文字和弹窗是两条路：文字 = `session/event`（落盘，能补）；
 * 弹窗 = ask（不落盘，只活在电脑端 `pendingAsks`，必须显式问）。
 * 这一段就是验证「显式问」这条路真的通了。
 */
const askCountBefore = (res === null ? '' : res.text).split('event: ask').length - 1;
requestAnswer = true;
await new Promise((resolve) => setTimeout(resolve, 4000));
const afterAskText = res === null ? '' : res.text;
const askCountAfter = afterAskText.split('event: ask').length - 1;
T('**轮询真的把待回答的 ask 推给了前端**（弹窗靠这个）', askCountAfter > askCountBefore,
	`ask 帧 ${askCountBefore} → ${askCountAfter}`);
T('推的是正确的 requestId', afterAskText.includes('req-poll-1'), '');

// 再等一轮，确认同一个 ask 不会被重复推（否则卡片会闪）
await new Promise((resolve) => setTimeout(resolve, 3500));
const askCountStable = (res === null ? '' : res.text).split('event: ask').length - 1;
T('同一个 ask 不重复推送（避免卡片闪烁）', askCountStable === askCountAfter,
	`${askCountAfter} → ${askCountStable}`);

/* ── ⑦ 回归验证：轮询速率不能失控 ──────────────────────── */
/*
 * 这里**不再**断言「watcher 断开就停」——
 * 1.2.95 起轮询故意不依赖 `watchers`（那正是它之前一次都没跑的原因：
 * 长连接死了 watchers 就归零，而轮询存在的意义就是覆盖那种情况）。
 *
 * 改成断言「3 秒内只跑了几轮」：防止 `progressed` 判错导致 0 延迟死循环。
 * 写这一条时真的抓到过 —— 3 秒内打了 1195 次 RPC，手机直接烤肉。
 */
const beforeCount = rpcMethods.length;
if (res !== null) { res.writableEnded = true; res.destroyed = true; }
await new Promise((resolve) => setTimeout(resolve, 3500));
const burst = rpcMethods.length - beforeCount;
T('watcher 断开后仍在轮询（这是刻意的，修的就是这种情况）', burst > 0, `3.5 秒内 ${burst} 次`);
T('**轮询速率没失控**（3.5 秒内 ≤ 4 轮 × 2 个方法）', burst <= 8, `实际 ${burst} 次，疑似死循环`);

/* ── 清理 ───────────────────────────────────────────────────────── */
server.close();
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n════════ ' + pass + ' 通过, ' + fail + ' 失败 ════════');
process.exit(fail === 0 ? 0 : 1);
