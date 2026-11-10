import assert from 'node:assert/strict';
import { createSessionIndex } from '../lib/session-index.js';
import { createOutbox } from '../lib/outbox.js';
import { createReconnect } from '../lib/reconnect.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, appendFileSync } from 'node:fs';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const previousHome = process.env.DSH_HOME;
const testHome = mkdtempSync(join(tmpdir(), 'remote-ownership-'));
process.env.DSH_HOME = testHome;
const { handleBridge, mapWorkspacePath } = await import('../lib/index.js');
process.on('exit', () => {
	// testHome 是本测试刚创建的绝对临时目录。
	rmSync(testHome, { recursive: true, force: true });
	if (previousHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previousHome;
});

let pass = 0;
async function test(name, fn) { await fn(); pass++; console.log('  ✓', name); }
function makeIndex() {
	let persisted;
	const index = createSessionIndex({
		load: Object.fromEntries(['remote', 'synced', 'paths', 'models', 'titles', 'times', 'pins', 'syncedAt', 'offsets', 'workspaces']
			.map((key) => [key, () => key === 'remote' || key === 'synced' ? new Set() : {}])),
		saveSessions: (...values) => { persisted = structuredClone(values); },
		saveMeta() {}, saveWorkspaces() {}, now: () => 100,
	});
	return { index, persisted: () => persisted };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const fixture = () => {
	const calls = [], accepted = [], failed = [];
	const outbox = createOutbox({
		send: (body) => { const result = deferred(); calls.push({ body, ...result }); return result.promise; },
		onAccepted: (id) => accepted.push(id), onFailed: (body, error) => failed.push({ body, error }), requestId: () => 'generated',
	});
	return { outbox, calls, accepted, failed };
};
await test('索引登记、持久路径及桥快照保留真实会话归属', async () => {
	const { index, persisted } = makeIndex();
	index.registerListed('s', '/desktop', '标题'); index.persist();
	assert.deepEqual(await handleBridge({}, {}, { sessionIndex: index, body: { method: 'remoteSessions' } }), { ids: ['s'] });
	assert.deepEqual(await handleBridge({}, {}, { sessionIndex: index, body: { method: 'syncedSessions' } }), { ids: ['s'] });
	assert.equal(persisted()[2].s, '/desktop');
	assert.equal(index.registerListed('s', '/wrong', '覆盖'), false);
	assert.equal(index.pathOf('s'), '/desktop');
});
await test('当前模型桥读取索引快照且保留按会话持久化模型', async () => {
	const { index, persisted } = makeIndex();
	index.rememberModel('s', { provider: 'p', model: 'm' });
	const result = await handleBridge({}, {}, { sessionIndex: index, body: { method: 'remoteModels' } });
	assert.deepEqual(result, { models: { s: { provider: 'p', model: 'm' } } });
	assert.deepEqual(persisted()[5].s, result.models.s);
	delete result.models.s;
	assert.deepEqual(index.modelOf('s'), { provider: 'p', model: 'm' });
});
await test('真实创建桥登记工作区映射与待发送计划，全程保留电脑路径', async () => {
	const { index, persisted } = makeIndex(); const f = fixture(); const created = [], attached = [];
	const workspace = { id: 'ws', path: '/local-mirror', attachSession: (id) => attached.push(id) };
	const registry = { create: async () => workspace };
	const ctx = { get: (name) => name === 'workspaceRegistry' ? registry : undefined,
		sessionController: { create: async (request) => created.push(request) } };
	const result = await handleBridge(ctx, { token: 'paired' }, {
		sessionIndex: index, outbox: f.outbox, body: { method: 'createSession', params: { path: '/desktop/project' } },
	});
	assert.equal(created[0].cwd, '/local-mirror'); assert.deepEqual(attached, [result.sessionId]);
	assert.equal(index.has(result.sessionId), true); assert.equal(persisted()[2][result.sessionId], '/desktop/project');
	assert.equal(f.outbox.planOf(result.sessionId).desktopPath, '/desktop/project');
	assert.deepEqual(Object.values(index.workspaceSnapshot()), ['/desktop/project']);
	assert.equal(f.calls.length, 0);
});
await test('索引删除移除归属与路径，不删本地用户数据', () => {
	const { index, persisted } = makeIndex(); index.registerListed('s', '/desktop', '标题'); index.remove('s');
	assert.equal(index.has('s'), false); assert.equal(index.isSynced('s'), false); assert.equal(index.pathOf('s'), undefined);
	assert.equal(persisted()[2].s, undefined);
});
await test('发送失败保留计划，重试使用同一 requestId，确认后清计划并跟随', async () => {
	const f = fixture(); f.outbox.setPlan('s', { desktopPath: '/desktop' });
	const plan = f.outbox.planOf('s'); const body = f.outbox.createBody({ sessionId: 's', requestId: 'r', content: [{ type: 'text', text: '你好' }] });
	const first = f.outbox.submit(body, plan); await Promise.resolve(); f.calls[0].reject(new Error('offline')); await first;
	assert.equal(f.outbox.planOf('s'), plan); assert.equal(f.failed[0].body.requestId, 'r'); assert.deepEqual(f.accepted, []);
	const retry = f.outbox.submit(body, plan); await Promise.resolve(); f.calls[1].resolve({ accepted: true }); await retry;
	assert.equal(f.calls[1].body.requestId, 'r'); assert.deepEqual(f.calls[1].body.content, body.content);
	assert.equal(f.outbox.planOf('s'), undefined); assert.deepEqual(f.accepted, ['s']);
});
await test('旧提交 ack 不会删除替换的新计划或模型', async () => {
	const f = fixture(); f.outbox.setPlan('s', { desktopPath: '/first' }); const old = f.outbox.planOf('s');
	const pending = f.outbox.submit({ sessionId: 's', requestId: 'r' }, old); await Promise.resolve();
	f.outbox.setPlan('s', { desktopPath: '/second' }); f.outbox.selectModel('s', { provider: 'p', model: 'm' });
	f.calls[0].resolve(); await pending;
	assert.deepEqual(f.outbox.planOf('s'), { desktopPath: '/second', model: { provider: 'p', model: 'm' } });
});
await test('同 requestId 重试被替换时，旧回执不结算新提交', async () => {
	const f = fixture(); const body = { sessionId: 's', requestId: 'r' };
	const first = f.outbox.submit(body); const second = f.outbox.submit(body); await Promise.resolve();
	f.calls[0].resolve(); await first; assert.deepEqual(f.accepted, []);
	f.calls[1].resolve(); await second; assert.deepEqual(f.accepted, ['s']);
});
await test('清理会话后迟到的 ack 不重开连接，缺省 requestId 稳定进入 body', async () => {
	const f = fixture(); const body = f.outbox.createBody({ sessionId: 's' }); assert.equal(body.requestId, 'generated');
	const pending = f.outbox.submit(body); await Promise.resolve(); f.outbox.remove('s'); f.calls[0].resolve(); await pending;
	assert.deepEqual(f.accepted, []);
});
const timers = new Map(); let timerId = 0;
let range = [], rangeCalls = 0;
const reconnect = createReconnect({
	readRange: async () => { rangeCalls++; return { events: range }; }, isWireEvent: (e) => Number.isInteger(e.seq), warn() {},
	setTimer: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimer: (id) => timers.delete(id),
});
await test('退避可前台唤醒，唤醒清理定时器且幂等', async () => {
	const sleep = reconnect.sleep(15000); assert.equal(timers.size, 1);
	assert.equal(reconnect.wakeAll(), 1); await sleep; assert.equal(timers.size, 0); assert.equal(reconnect.wakeAll(), 0);
});
await test('follow 替换后旧 finally 不删除新连接，stop 确实中止', () => {
	const first = reconnect.start('s'); assert.equal(reconnect.start('s'), undefined);
	reconnect.stop('s'); assert.equal(first.signal.aborted, true);
	const second = reconnect.start('s'); reconnect.finish('s', first); assert.equal(reconnect.has('s'), true);
	reconnect.stopAll(); assert.equal(second.signal.aborted, true); assert.equal(reconnect.size, 0);
});
await test('重连保留已消费游标和 revision，健康连接重置退避', () => {
	const stream = reconnect.createStream('s', 9); const first = stream.connect(); stream.advance(10);
	assert.equal(stream.nextRevision(), 1); stream.disconnect(); assert.equal(first.signal.aborted, true);
	const second = stream.connect(); assert.equal(stream.cursor, 10); assert.equal(stream.nextRevision(), 2);
	stream.backoff(0, 5000); assert.equal(stream.wait, 2000); stream.backoff(6000, 5000); assert.equal(stream.wait, 1000);
	reconnect.stopAll(); assert.equal(second.signal.aborted, true); assert.equal(stream.signal.aborted, true); stream.close();
});
await test('外部取消中止当前连接和生命周期', () => {
	const parent = new AbortController(); const stream = reconnect.createStream('s', 0, parent.signal); const controller = stream.connect();
	parent.abort(); assert.equal(controller.signal.aborted, true); assert.equal(stream.signal.aborted, true); stream.close();
});
await test('补洞只接受完整连续事件并保留 splice 正文', async () => {
	range = [{ seq: 3, type: 'agent/inbox/spliced', data: { removedCount: 1 } }, { seq: 2, type: 'agent/inbox/spliced', data: { inserted: [{ id: 'm' }] } }];
	const filled = await reconnect.fillGap({}, 's', 1, 3);
	assert.deepEqual(filled.map((e) => e.seq), [2, 3]); assert.deepEqual(filled[0].data.inserted, [{ id: 'm' }]);
	range = [{ seq: 3 }]; assert.equal(await reconnect.fillGap({}, 's', 1, 3), null);
	range = [{ seq: 2 }, { seq: 2 }, { seq: 3 }]; assert.equal(await reconnect.fillGap({}, 's', 1, 3), null);
	const before = rangeCalls; assert.equal(await reconnect.fillGap({}, 's', 1, 300), null); assert.equal(rangeCalls, before);
});
await test('会话删除会停止同步流并取消退避定时器', async () => {
	const stream = reconnect.createStream('removed'); const controller = stream.connect();
	const pending = reconnect.sleep(15000, stream.signal); assert.equal(timers.size, 1);
	reconnect.stop('removed'); await pending;
	assert.equal(controller.signal.aborted, true); assert.equal(timers.size, 0); stream.close();
});
await test('105 文件回读归一化兼容手机路径和 Windows 大小写，不泄漏工作区前缀', () => {
	const { index } = makeIndex(); index.rememberWorkspace('project', 'C:\\Users\\Dev\\项目');
	const scope = { workspaceRoot: '/data/user/0/dsh-remote/workspaces/project' };
	assert.deepEqual(mapWorkspacePath(index, scope, scope.workspaceRoot + '/文档/a.md'), { path: '文档/a.md' });
	assert.deepEqual(mapWorkspacePath(index, scope, 'c:/users/dev/项目/文档/a.md'), { path: '文档/a.md' });
	assert.deepEqual(mapWorkspacePath(index, scope, 'C:\\Users\\Dev\\项目'), { path: '' });
	assert.equal(mapWorkspacePath(index, { workspaceRoot: '/local' }, '/local/a.md'), undefined);
});
await test('105 forgetSession 清除全部会话账本并停止流及未确认提交，重复调用不误报成功', async () => {
	const { index, persisted } = makeIndex(); const f = fixture();
	index.registerListed('forgotten', '/desktop', '标题'); index.rememberModel('forgotten', { provider: 'p', model: 'm' });
	index.rememberTurnOffset('forgotten', 1); f.outbox.setPlan('forgotten', { desktopPath: '/desktop' });
	const controller = reconnect.start('forgotten');
	const io = { sessionIndex: index, outbox: f.outbox, reconnect, body: { method: 'forgetSession', params: { sessionId: 'forgotten' } } };
	assert.deepEqual(await handleBridge({}, {}, io), { ok: true });
	assert.equal(controller.signal.aborted, true); assert.equal(f.outbox.planOf('forgotten'), undefined);
	assert.equal(index.modelOf('forgotten'), undefined); assert.equal(index.offsetOf('forgotten'), undefined);
	assert.equal(persisted()[4].forgotten, undefined); assert.equal(persisted()[5].forgotten, undefined);
	assert.deepEqual(await handleBridge({}, {}, io), { ok: false, reason: 'not-managed' });
});
await test('105 插队标记随发送确认传递，失败不发成功回执', async () => {
	const calls = []; const accepted = [];
	const box = createOutbox({ send: async () => calls.push('send'), onAccepted: (id, metadata) => accepted.push({ id, ...metadata }), onFailed() {} });
	await box.submit({ sessionId: 'queued', requestId: 'r' }, undefined, { wasRunning: true });
	assert.deepEqual(calls, ['send']); assert.deepEqual(accepted, [{ id: 'queued', wasRunning: true }]);
});
await test('105 前台唤醒保留健康流，空闲流由连接 owner 终止重建', () => {
	const controller = reconnect.start('idle'); reconnect.touch('idle', controller);
	assert.equal(reconnect.restartStale('idle', 45000), false);
	assert.equal(reconnect.restartStale('idle', 45000, Date.now() + 45001), true);
	assert.equal(controller.signal.aborted, true); assert.equal(reconnect.has('idle'), false);
});
await test('105 开场缓存批量落盘并连续回放，遇缺口停止，不向引擎日志写入', async () => {
	const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	const cacheCode = source.slice(source.indexOf('\tconst SYNC_CACHE_MAX_BYTES'), source.indexOf('\n\tasync function* followSynced'));
	const replayCode = source.slice(source.indexOf('\t\t\tconst cachedEvents = readSyncCache'), source.indexOf('\n\t\t\twhile (!stream.signal.aborted)', source.indexOf('\tasync function* followSynced')));
	const state = vm.createContext({ process: { env: { DSH_HOME: testHome } }, join, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, appendFileSync, rmSync,
		Map, setTimeout, ctx: {}, debugLog() {}, deriveRunning() {}, reconcileStateOf() {}, isWireEvent: (event) => Number.isSafeInteger(event.seq) });
	vm.runInContext(cacheCode + '\nglobalThis.cache = { appendSyncCache, flushSyncCache, readSyncCache };', state);
	state.cache.appendSyncCache('cached', 1, { seq: 1, type: 'turn/start' });
	state.cache.appendSyncCache('cached', 2, { seq: 2, type: 'turn/end' });
	state.cache.appendSyncCache('cached', 4, { seq: 4, type: 'turn/start' });
	state.cache.flushSyncCache('cached'); assert.equal(state.cache.readSyncCache('cached').length, 3);
	assert.equal(existsSync(join(testHome, 'sessions')), false);
	state.stream = { cursor: 0, advance(seq) { this.cursor = seq; } }; state.sessionId = 'cached'; state.fromSeq = 0;
	const replay = vm.runInContext('(async function* () {' + replayCode + '\n})', state);
	const seqs = []; for await (const item of replay()) seqs.push(item.event.seq);
	assert.deepEqual(seqs, [1, 2]); assert.equal(state.stream.cursor, 2);
});
console.log(`\n════════ ownership ${pass} 通过, 0 失败, 0 跳过 ════════`);
