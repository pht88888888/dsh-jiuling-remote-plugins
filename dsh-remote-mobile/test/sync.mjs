/**
 * 三个「同步类」bug 的回归测试。
 *
 * 这三条都是用户 2026-10-29 报的，而且都属于**「改了十几版都没修好」**的
 * 类型 —— 因为它们都不是「某个函数没调」，而是**判据/类型/数据源本身错了**：
 *
 *   ① 模型列表不同步：模型与预设用了两套不一致的判据
 *      （`isRemoteSession` 缺路径形态兜底，`currentIsRemote` 有）。
 *   ② 同步来的对话没按时间排序：电脑侧把 `updatedAt`（number）
 *      按 string 判断 ⇒ 恒 null ⇒ 排序永远不生效。
 *   ③ 电脑上置顶的对话没同步置顶：宿主根本没把 pin 信息下发。
 *
 * 所以这里的测试全部针对**根因**，而不是「某个函数被调用了」：
 *
 *   · ① 造一个**空** `mirrorSlugs`（刚启动时的真实状态），断言
 *        「路径在 remote/workspaces/ 下」的会话仍被判成电脑会话；
 *   · ② 断言电脑侧 `updatedAt` 原样是 **number**，且排序按数字降序；
 *   · ③ 断言宿主 `listWorkspaces` 的每条会话都带 `pinned` 字段。
 *
 * 运行：node test/sync.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

let pass = 0;
let fail = 0;
const T = (name, cond, extra) => {
	if (cond) {
		pass += 1;
		console.log('  ✓', name);
	} else {
		fail += 1;
		console.log('  ✗', name + (extra ? '  ' + extra : ''));
	}
};

const here = new URL('.', import.meta.url);
const clientPath = new URL('../lib/client.js', here);
/*
 * 电脑端包的位置在两种布局下不同：
 *   · 发布仓库（本仓库）    dsh-remote-mobile/test → ../dsh-remote-desktop
 *   · 本地开发仓库          work/mobile/test       → ../../desktop
 * 这里依次尝试，取第一个存在的，免得换个布局测试就整片报 ENOENT。
 */
function resolveDesktopLib() {
	const candidates = [
		'../../dsh-remote-desktop/lib/index.js',
		'../../desktop/lib/index.js',
	];
	for (const candidate of candidates) {
		const url = new URL(candidate, here);
		if (fs.existsSync(url)) return url;
	}
	throw new Error('找不到电脑端 lib/index.js，试过：' + candidates.join(' , '));
}
const desktopPath = resolveDesktopLib();

const clientSrc = fs.readFileSync(clientPath, 'utf8');
const desktopSrc = fs.readFileSync(desktopPath, 'utf8');

/* ══════════════════════════════════════════════════════════════════
 * ① 模型列表同步：两条判据必须一致
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ① 模型列表同步判据 ══');

/*
 * 静态检查第一层：`isRemoteSession` 内部必须调用 `isMirrorPath`。
 *
 * 为什么静态检查有效：这个 bug 的本质就是「函数体里少了那条兜底」。
 * 只要它回到「直接读 mirrorSlugs」的写法，用户那个 bug 就回来了，
 * 而动态测试很难覆盖「冷启动 + 空快照 + 新建对话页」这套组合。
 */
T('client.js 定义了统一判据 isMirrorPath', /function isMirrorPath\s*\(/.test(clientSrc));
T(
	'isRemoteSession 走统一判据（不再自己读 mirrorSlugs）',
	/function isRemoteSession[\s\S]{0,600}?return isMirrorPath\(cwd\)/.test(clientSrc),
);
T(
	'isRemoteSession 的 pending 分支也走统一判据',
	/function isRemoteSession[\s\S]{0,900}?return isMirrorPath\(pending\)/.test(clientSrc),
);
T(
	'currentIsRemote（预设侧）也走统一判据',
	/return isMirrorPath\(path\)/.test(clientSrc) &&
		/return isMirrorPath\(pendingPath\)/.test(clientSrc),
);

/*
 * 静态检查第二层：`isMirrorPath` 里必须有**路径形态兜底**。
 *
 * 这是「空快照」那一半的修复。原来的 `isRemoteSession` 只有
 * `mirrorSlugs[slug] === true`，空快照时恒 false。
 */
const mirrorPathBody = (() => {
	const at = clientSrc.indexOf('function isMirrorPath');
	if (at < 0) return '';
	return clientSrc.slice(at, at + 2000);
})();
T(
	'isMirrorPath 有 remote/workspaces/ 路径形态兜底',
	mirrorPathBody.includes("path.indexOf('remote/workspaces/') !== -1"),
);
T(
	'isMirrorPath 兼容 Windows 反斜杠',
	mirrorPathBody.includes("path.indexOf('remote\\\\workspaces\\\\') !== -1"),
);

/*
 * 动态检查：把 `isMirrorPath` 的两条判据抽出来跑真实用例。
 *
 * 这里不装载整个 client.js（它依赖 jsdom 和大量官方服务），
 * 而是**按同一份判据**验证行为，并且用「空 mirrorSlugs」这个
 * 用户真机上一定会遇到的初始状态。
 */
const mirrorSlugs = {}; // ⚠️ 空快照 —— 模拟 loadMirrorSlugs() 还没回来
const mirrorSlugOf = (p) => {
	const at = p.search(/[\\/]workspaces[\\/]/);
	if (at < 0) return undefined;
	return p.slice(at).split(/[\\/]/)[2];
};
const isMirrorPath = (p) => {
	if (typeof p !== 'string' || p === '') return false;
	const slug = mirrorSlugOf(p);
	if (slug !== undefined && mirrorSlugs[slug] === true) return true;
	if (p.indexOf('remote/workspaces/') !== -1) return true;
	if (p.indexOf('remote\\workspaces\\') !== -1) return true;
	return false;
};

T(
	'**空 mirrorSlugs 时，镜像目录仍判成电脑工作区**（这就是那个老 bug）',
	isMirrorPath('/data/user/0/com.dsh/files/home/.dsh/remote/workspaces/a1b2c3d4') === true,
);
T(
	'手机本地目录仍判成本地',
	isMirrorPath('/storage/emulated/0/Documents/proj') === false,
);
T(
	'Windows 镜像目录也判对',
	isMirrorPath('C:\\Users\\me\\.dsh\\remote\\workspaces\\a1b2c3d4') === true,
);
T('空串 / 非字符串安全', isMirrorPath('') === false && isMirrorPath(undefined) === false);
T(
	'⚠️ 状态目录 dsh-remote/ 不会被误判成镜像工作区',
	isMirrorPath('/data/user/0/com.dsh/files/home/.dsh/dsh-remote') === false,
);

/* ══════════════════════════════════════════════════════════════════
 * ② 排序：updatedAt 必须是数字，且按数字降序
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ② 会话按时间排序 ══');

/*
 * ⚠️ 断言前**必须剥掉注释**：本版修复的注释里正引用了那句错误写法
 * 作为「原来的样子」的说明。不剥注释的话，测试会把讲解文字当成代码，
 * 于是「修好了却报失败」—— 这种假失败会让人去改产品代码，比没测试更糟。
 */
const stripComments = (src) =>
	src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const desktopCode = stripComments(desktopSrc);

T(
	'桌面插件不再用 typeof === string 判断 updatedAt',
	!/typeof item\.updatedAt === 'string'/.test(desktopCode),
);
T(
	'桌面插件按 number 判断 updatedAt',
	/typeof item\.updatedAt === 'number'/.test(desktopCode),
);
T(
	'排序不再用 localeCompare 比时间戳',
	!/localeCompare\(String\(a\.updatedAt/.test(desktopCode) &&
		!/localeCompare\(String\(b\.updatedAt/.test(desktopCode),
);
T(
	'排序改成数字相减',
	/return right - left/.test(desktopCode),
);

/*
 * 动态：用官方 `updatedAt` 的真实取值方式造数据，验证排序结果。
 *
 * 官方 `updatedAt(header, metadata) = Math.max(header.createdAt, metadata.lastPromptAt ?? 0)`。
 */
const updatedAtOf = (createdAt, lastPromptAt) => Math.max(createdAt, lastPromptAt ?? 0);
const rows = [
	{ sessionId: 'old', updatedAt: updatedAtOf(1000, 5000) },
	{ sessionId: 'newest', updatedAt: updatedAtOf(2000, 900000) },
	{ sessionId: 'mid', updatedAt: updatedAtOf(3000, 50000) },
];
const sorted = [...rows].sort((a, b) => {
	const left = typeof a.updatedAt === 'number' ? a.updatedAt : -1;
	const right = typeof b.updatedAt === 'number' ? b.updatedAt : -1;
	return right - left;
});
T(
	'**数字排序得到正确的时间降序**',
	JSON.stringify(sorted.map((r) => r.sessionId)) === JSON.stringify(['newest', 'mid', 'old']),
	JSON.stringify(sorted.map((r) => r.sessionId)),
);

/*
 * 老代码为什么必然排错 —— 把那个 bug 复现一遍，证明测试有效。
 */
const legacySort = (items) =>
	[...items].sort((a, b) =>
		String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
	);
const legacyRows = rows.map((r) => ({
	sessionId: r.sessionId,
	// 老代码的取值方式：非字符串一律 null
	updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
}));
const legacySorted = legacySort(legacyRows).map((r) => r.sessionId);
T(
	'（复现）老代码把数字全变 null ⇒ 排序结果错乱',
	JSON.stringify(legacySorted) !== JSON.stringify(['newest', 'mid', 'old']),
	JSON.stringify(legacySorted),
);

/*
 * ②b 时间覆盖逻辑的行为验证（从**真实源码**里抽函数跑，不是另写一份实现）。
 *
 * 这一组是本轮修复里最容易写错的部分：判据必须是
 * 「本地时间戳 ≈ 建壳时刻 ⇒ 假值 ⇒ 用电脑时间」，而不能是「取 max」——
 * 后者在所有同步会话上都是空操作（假值必然比电脑时间大），
 * 代码看起来完全正确，用户看到的却还是「没修」。
 */
console.log('\n══ ②b 时间覆盖的真实行为 ══');

{
	const lines = clientSrc.split('\n');
	const grab = (marker) => {
		const at = lines.findIndex((l) => l.includes(marker));
		if (at < 0) throw new Error('找不到 ' + marker);
		let depth = 0;
		let started = false;
		const out = [];
		for (let i = at; i < lines.length; i += 1) {
			out.push(lines[i]);
			for (const ch of lines[i]) {
				if (ch === '{') {
					depth += 1;
					started = true;
				} else if (ch === '}') {
					depth -= 1;
				}
			}
			if (started && depth === 0) break;
		}
		return out.join('\n');
	};
	const clockSrc = grab('var applyDesktopClock = function');
	const wrapSrc = grab('var wrapSessionListClock = function');
	const run = (times, syncedAt, ver) =>
		new Function(`
			var desktopTimes = arguments[0], desktopSyncedAt = arguments[1], metaVersion = arguments[2];
			${clockSrc}
			${wrapSrc}
			return { applyDesktopClock, wrapSessionListClock };
		`)(times, syncedAt, ver);

	const mkList = (rows) => {
		const byId = {};
		const ids = [];
		for (const r of rows) {
			byId[r.id] = { id: r.id, updatedAt: r.at };
			ids.push(r.id);
		}
		const snap = { ids, byId, phase: 'ready' };
		return {
			_snap: snap,
			getSnapshot() {
				return snap;
			},
			subscribe() {
				return () => {};
			},
			update() {},
			set() {},
		};
	};
	const rank = (s) =>
		Object.values(s.byId)
			.map((r) => ({ id: r.id, rank: r.updatedAt }))
			.sort((x, y) => y.rank - x.rank)
			.map((r) => r.id);

	// 真实的场景：同步发生在 T0，所有空壳的本地时间戳都 ≈ T0
	const T0 = 1700000000000;
	const list = mkList([
		{ id: 'a', at: T0 + 10 },
		{ id: 'b', at: T0 + 11 },
		{ id: 'c', at: T0 + 12 },
	]);
	// 电脑上的真实时间：a 最新、c 最老（都**早于** T0，这是关键）
	const w = run(
		{ a: T0 - 3600000, b: T0 - 7200000, c: T0 - 10800000 },
		{ a: T0, b: T0, c: T0 },
		1,
	).wrapSessionListClock(list);
	const got = w.getSnapshot();

	T(
		'**假值被电脑时间替换，哪怕电脑时间更小**',
		got.byId.a.updatedAt === T0 - 3600000,
		String(got.byId.a.updatedAt),
	);
	T(
		'**排序结果 = 电脑上的真实时间顺序**',
		JSON.stringify(rank(got)) === JSON.stringify(['a', 'b', 'c']),
		JSON.stringify(rank(got)),
	);

	// 真值：用户在同步之后两天真的在手机上聊过 ⇒ 不能被拉回去
	const w2 = run({ x: T0 - 3600000 }, { x: T0 }, 1).wrapSessionListClock(
		mkList([{ id: 'x', at: T0 + 172800000 }]),
	);
	T(
		'**同步后真聊过的会话不被拉回去**',
		w2.getSnapshot().byId.x.updatedAt === T0 + 172800000,
	);

	// 老版本同步的会话没有建壳时刻 ⇒ 退回取 max（不倒退）
	const w3 = run({ y: T0 - 5000 }, {}, 1).wrapSessionListClock(mkList([{ id: 'y', at: T0 }]));
	T('无建壳时刻时取 max（不倒退）', w3.getSnapshot().byId.y.updatedAt === T0);

	// 没有电脑数据 ⇒ 原样返回同一个对象（零开销、身份不变）
	const plain = mkList([{ id: 'z', at: 42 }]);
	T(
		'**没有电脑时间时返回同一对象**（不改身份，React 不会重渲染）',
		run({}, {}, 0).wrapSessionListClock(plain).getSnapshot() === plain._snap,
	);
	T('快照身份稳定（同一源 + 同版本 ⇒ 同一对象）', w.getSnapshot() === w.getSnapshot());

/*
 * ⑩ 必须**原地改写** `getSnapshot`，不能返回新对象。
 *
 * 这是 1.2.88 的根因修复，也是最容易被后人"优化"回旧写法的地方。
 *
 * 官方侧边栏读数据走 slot hook，不走 `ctx.sessions.list`：
 *   dsh-client-ui-session/lib/client.js:1106
 *     ctx.slots.provideRoot({ hooks: { sessions: ctx.sessions.list } })
 *   → dsh-client-ui-renderer/lib/client.js:1681 rebuildRootBinding()
 *     里 copyUnique() **按引用拷贝**
 *   → bindSnapshotSelector()（同文件 155 行）把对象存进闭包：
 *         const getSnapshot = () => w.getSnapshot();
 *
 * 所以 `ctx.sessions.list = 新对象` 对界面**毫无作用**（前两版都栽在这）。
 * 而 `getSnapshot` 是每次调用动态读属性的 ⇒ 在原地替换这个方法即可，
 * 既生效又不依赖任何官方私有字段。
 */
{
	T(
		'**原地替换 getSnapshot（不返回新对象、不碰 slots 私有字段）**',
		/list\.getSnapshot = function/.test(clientSrc),
	);
	/*
	 * 只判「代码里不再有它」——注释里提到旧方案是允许的（那是踩坑记录）。
	 * 判据：没有任何一行**非注释**代码碰这个字段。
	 */
	const usesRootContribs = clientSrc
		.split(/\r?\n/)
		.some((line) => {
			const t = line.trim();
			if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return false;
			return /_rootContributions/.test(t);
		});
	T('**代码里不再依赖 slots._rootContributions 这个官方私有字段**', !usesRootContribs);
	T(
		'包装后返回**同一个对象**（hook 持有的引用不变）',
		/wrapSessionListClock/.test(clientSrc) && /\t\t\treturn list;/.test(clientSrc),
	);
	T(
		'替换失败有兜底，不让整个插件报错',
		/原地替换 sessions\.list\.getSnapshot 失败/.test(clientSrc),
	);
	T(
		'防重复包装（热重载时 apply 可能被调多次）',
		/__dshClockWrapped/.test(clientSrc),
	);
}

/* ══════════════════════════════════════════════════════════════════
 * ⑪ **动态**证明原地改写能被官方 hook 看见（这是本轮修复的核心）
 *
 * 上一条只是静态断言「代码里是这么写的」。但这一整套 bug 的教训就是：
 * 「代码看起来对」和「界面真的变了」是两件事 —— 前两版都是静态看起来
 * 完美、运行时一次都没生效。
 *
 * 所以这里**照抄官方 `bindSnapshotSelector` 的闭包形态**做端到端验证：
 *
 *     dsh-client-ui-renderer/lib/client.js:155
 *       const subscribe = (fn) => w.subscribe(fn);
 *       const getSnapshot = () => w.getSnapshot();   // ← 动态读属性
 *
 * 先建 hook（模拟插件加载时 provideRoot 那一刻），**再**包装 list，
 * 断言 hook 读到的是**电脑时间**。旧写法（返回新对象）在这里必然失败。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ⑪ 原地改写能被 hook 看见（端到端）══');
{
	const T1 = 1700000000000;
	// 用一个「官方 list」：本地时间全是同步那一刻（假值）
	const officialList = (() => {
		const byId = {
			a: { id: 'a', updatedAt: T1 + 10 },
			b: { id: 'b', updatedAt: T1 + 20 },
		};
		const snap = { ids: ['a', 'b'], byId, phase: 'ready' };
		return {
			getSnapshot: () => snap,
			subscribe: () => () => {},
			update() {},
			set() {},
		};
	})();

	// ① 先按官方形态绑定 hook —— 此刻还没包装
	const w = officialList;
	const hookGetSnapshot = () => w.getSnapshot();

	// ② 再包装（模拟 apply 里的顺序）
	const env = new Function(`
		var desktopTimes = arguments[0], desktopSyncedAt = arguments[1], metaVersion = arguments[2];
		${clockSrc}
		${wrapSrc}
		return wrapSessionListClock;
	`)({ a: T1 - 5000, b: T1 - 9000 }, { a: T1, b: T1 }, 1);
	env(officialList);

	// ③ hook 必须在**没有任何重新绑定**的情况下读到电脑时间
	const seen = hookGetSnapshot();
	T(
		'**hook 绑定后包装，仍能读到电脑时间**（旧写法在这里必然失败）',
		seen.byId.a.updatedAt === T1 - 5000 && seen.byId.b.updatedAt === T1 - 9000,
		JSON.stringify([seen.byId.a.updatedAt, seen.byId.b.updatedAt]),
	);
	/*
	 * 电脑上 a 比 b 新（-5000 > -9000）⇒ a 应排在 b 前面。
	 *
	 * ⚠️ 本地时间恰好相反（a=T1+10 < b=T1+20，即 b 更新），所以这条
	 * 断言同时证明了：排序真的按电脑时间，而不是本地假值。
	 */
	T(
		'**排序随之变成电脑上的真实顺序**（本地是反的）',
		JSON.stringify(rank(seen)) === JSON.stringify(['a', 'b']),
		JSON.stringify(rank(seen)),
	);
	T(
		'包装返回的就是**同一个对象**（hook 引用天然不变）',
		officialList.__dshClockWrapped === true,
	);
	T(
		'重复包装是幂等的（热重载不会套娃）',
		(() => {
			const again = env(officialList);
			return again === officialList && again.getSnapshot().byId.a.updatedAt === T1 - 5000;
		})(),
	);
}

	/*
	 * ⑧ 本地 `updatedAt` **缺失**时也必须用电脑时间。
	 *
	 * 这是用户截图上真实可见的形态：手机侧那批会话**没有任何相对时间标签**
	 *（电脑端每条都有「3分钟」「1小时」），正是 `updatedAt` 为 undefined 的表现。
	 * 上一版代码遇到非数字就 `continue`，于是「最该被修的会话」恰好被跳过 ——
	 * 用户看到的就是「重新同步了还是没排序」。
	 */
	const missing = mkList([{ id: 'm', at: undefined }]);
	const wm = run({ m: T0 - 999 }, {}, 1).wrapSessionListClock(missing);
	T(
		'**本地没有 updatedAt 时也覆盖成电脑时间**',
		wm.getSnapshot().byId.m.updatedAt === T0 - 999,
		String(wm.getSnapshot().byId.m.updatedAt),
	);

	// 0 / null 同样属于「不可用」，必须覆盖（否则会被排到最后）
	const zero = mkList([{ id: 'z0', at: 0 }]);
	T(
		'本地 updatedAt 为 0 时也覆盖',
		run({ z0: T0 - 500 }, {}, 1).wrapSessionListClock(zero).getSnapshot().byId.z0.updatedAt === T0 - 500,
	);
}

/* ══════════════════════════════════════════════════════════════════
 * ③ 置顶：宿主必须下发 pinned，前端必须调官方 pinSession
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ③ 置顶状态同步 ══');

T(
	'桌面插件读 workspaceRegistry.pinnedSessionIds',
	/pinnedSessionIds/.test(desktopSrc),
);
T(
	'listWorkspaces 的每条会话带 pinned 字段',
	/listWorkspaces[\s\S]{0,6000}?pinned: pinnedSet\.has\(sessionId\)/.test(desktopSrc),
);
T(
	'listWorkspaceSessions 的每条会话带 pinned 字段',
	/pinned: pinnedOf\(item\.sessionId\)/.test(desktopSrc),
);
T('前端有 desktopMeta 桥的读取端', /bridge\('desktopMeta'/.test(clientSrc));
T('前端调官方 workspaces.pinSession', /workspaces\.pinSession\(target\)/.test(clientSrc));
T(
	'置顶只在会话「本地已知」后才做（byId 命中检查）',
	/if \(byId\[sessionId\] === undefined\) continue;/.test(clientSrc),
);
T(
	'置顶失败有退避，不会每帧打 RPC',
	/now - last < 10000/.test(clientSrc),
);

/*
 * ⑪ 数据到位必须**主动**重试置顶。
 *
 * 订阅只在 `sessions.list` 快照变化时触发，而置顶数据是异步拉回来的。
 * 时序：apply() 建订阅（desktopPins 还是空）→ 数据到位 → 快照没变
 * ⇒ 回调不跑 ⇒ 置顶永远不生效。所以必须有一次主动重试。
 */
T(
	'**数据到位后主动重试置顶**（不能只等快照变化）',
	/firePinRetry\(\)/.test(clientSrc) && /pinRetryHooks\.push/.test(clientSrc),
);
T(
	'重试在 adoptDesktopMeta 里被触发',
	/desktopPins = nextPins;[\s\S]{0,600}?firePinRetry\(\)/.test(clientSrc),
);
T(
	'每条重试都包 try/catch（置顶失败不能影响主流程）',
	/pinRetryHooks\[at\]\(\)[\s\S]{0,200}?catch/.test(clientSrc),
);
T(
	'时间表有版本号，数据更新时缓存会失效',
	/metaVersion \+= 1/.test(clientSrc),
);

/* ══════════════════════════════════════════════════════════════════
 * ⑬ 模型显示必须**按会话**，不能用全局单例
 *
 * 用户报障：「电脑端与手机端显示的当前模型不一致；实际选用的模型与
 * 界面显示的模型不一致。」
 *
 * 根因：真正发送用的是宿主 `remoteModels[sessionId]`（按会话、落盘），
 * 而界面显示读的是插件自己的 `modelChoiceBus.selection`（**全局一个**）。
 * 粒度不同 ⇒ 必然对不上；重启后界面还退回电脑全局默认。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ⑬ 模型按会话区分（端到端）══');
{
	const lines = clientSrc.split('\n');
	const grab = (marker) => {
		const at = lines.findIndex((l) => l.includes(marker));
		if (at < 0) throw new Error('找不到 ' + marker);
		let depth = 0;
		let started = false;
		const out = [];
		for (let i = at; i < lines.length; i += 1) {
			out.push(lines[i]);
			for (const ch of lines[i]) {
				if (ch === '{') { depth += 1; started = true; }
				else if (ch === '}') { depth -= 1; }
			}
			if (started && depth === 0) break;
		}
		return out.join('\n');
	};
	const busSrc = grab('var modelChoiceBus = {');
	const makeBus = new Function(`
		var remoteModelsBySession = {};
		${busSrc}
		return { bus: modelChoiceBus, persisted: function (m) { remoteModelsBySession = m; } };
	`);

	const { bus } = makeBus();

	// 会话 A 选 M1、会话 B 选 M2 —— 两者必须互不干扰
	bus.note({ provider: 'wk', model: 'M1' }, 'sessA');
	bus.note({ provider: 'wk', model: 'M2' }, 'sessB');

	T(
		'**A 会话查到的是 A 自己选的模型**',
		bus.forSession('sessA').model === 'M1',
		JSON.stringify(bus.forSession('sessA')),
	);
	T(
		'**B 会话查到的是 B 自己选的模型**（全局单例在此必然串）',
		bus.forSession('sessB').model === 'M2',
		JSON.stringify(bus.forSession('sessB')),
	);
	T(
		'没选过的会话返回 null（交给电脑默认值，不猜）',
		bus.forSession('sessC') === null,
	);
	T(
		'空 sessionId 不崩、返回 null',
		bus.forSession('') === null && bus.forSession(undefined) === null,
	);

	// 宿主落盘的真值必须能覆盖进来（重启后界面仍显示对的那个）
	bus.adoptPersisted({ sessC: { provider: 'wk', model: 'M3' } });
	T(
		'**宿主落盘的真值能补上**（重启后不再退回电脑默认）',
		bus.forSession('sessC').model === 'M3',
		JSON.stringify(bus.forSession('sessC')),
	);
	T(
		'录真值时忽略非法项（不污染查询）',
		(() => {
			bus.adoptPersisted({ bad: { provider: '', model: 'x' }, bad2: { provider: 'p' } });
			return bus.forSession('bad') === null && bus.forSession('bad2') === null;
		})(),
	);
}

/* ══════════════════════════════════════════════════════════════════
 * ⑫ 置顶必须在**投影层**合并，不能只靠 pinSession 这个 RPC
 *
 * 为什么：`pinSession()` 要过 `sessionKnown()`、要 RPC 成功、要快照变化，
 * 三个前提任一不成立就不显示。而置顶在界面上只是
 * `new Set(snapshot.pinnedSessionIds)` 查询 ——
 * 只要快照里那个数组有它，界面就置顶。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ⑫ 置顶合并进快照（端到端）══');
{
	const lines = clientSrc.split('\n');
	const grab = (marker) => {
		const at = lines.findIndex((l) => l.includes(marker));
		if (at < 0) throw new Error('找不到 ' + marker);
		let depth = 0;
		let started = false;
		const out = [];
		for (let i = at; i < lines.length; i += 1) {
			out.push(lines[i]);
			for (const ch of lines[i]) {
				if (ch === '{') { depth += 1; started = true; }
				else if (ch === '}') { depth -= 1; }
			}
			if (started && depth === 0) break;
		}
		return out.join('\n');
	};

	const projSrc = grab('var projectPinned = function');
	const env = new Function(`
		var desktopPins = arguments[0];
		var unpinnedByUser = arguments[1];
		var metaVersion = arguments[2];
		var clockDiag = { pins: 0, pinned: 0 };
		${projSrc}
		return projectPinned;
	`);

	// 会话快照：本地认识 s1 / s2 / s3
	const sessionsSnapshot = {
		getSnapshot: () => ({
			ids: ['s1', 's2', 's3'],
			byId: { s1: { id: 's1' }, s2: { id: 's2' }, s3: { id: 's3' } },
		}),
	};

	// 电脑说 s1 置顶；官方快照里一条置顶都没有（pinSession 从未成功过）
	const projectPinned = env({ s1: true }, {}, 1);
	const before = { pinnedSessionIds: [], archivedSessionIds: [], items: [] };
	const after = projectPinned(before, sessionsSnapshot);
	T(
		'**电脑置顶的会话被合并进快照**（不依赖 pinSession 成功）',
		Array.isArray(after.pinnedSessionIds) && after.pinnedSessionIds.indexOf('s1') >= 0,
		JSON.stringify(after && after.pinnedSessionIds),
	);
	T(
		'**本地不认识的会话不会被塞进快照**（不留幽灵 id）',
		(() => {
			const p2 = env({ ghost: true }, {}, 1);
			const r = p2({ pinnedSessionIds: [] }, sessionsSnapshot);
			return r.pinnedSessionIds.length === 0;
		})(),
	);
	T(
		'用户自己取消过的**不会再被加回**',
		(() => {
			const p3 = env({ s1: true }, { s1: true }, 1);
			const r = p3({ pinnedSessionIds: [] }, sessionsSnapshot);
			return r.pinnedSessionIds.length === 0;
		})(),
	);
	T(
		'没有电脑置顶数据时**原样返回同一个对象**（身份稳定）',
		(() => {
			const p4 = env({}, {}, 1);
			const src = { pinnedSessionIds: ['x'] };
			return p4(src, sessionsSnapshot) === src;
		})(),
	);
	T(
		'本地已有的置顶**不丢**（合并而非覆盖）',
		(() => {
			const p5 = env({ s1: true }, {}, 1);
			const r = p5({ pinnedSessionIds: ['localOne'] }, sessionsSnapshot);
			return r.pinnedSessionIds.indexOf('localOne') >= 0 && r.pinnedSessionIds.indexOf('s1') >= 0;
		})(),
	);
}

/* ══════════════════════════════════════════════════════════════════
 * ④ 宿主落盘：desktop-meta.json 的读写必须能往返
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ④ 宿主元数据落盘往返 ══');

T(
	'mobile index.js 用独立文件存元数据（不挤进 sessions.json）',
	/DESKTOP_META_PATH = join\(STATE_DIR, 'desktop-meta\.json'\)/.test(
		fs.readFileSync(new URL('../lib/index.js', here), 'utf8'),
	),
);

/*
 * 「建壳时刻」必须端到端走通：宿主记录 → 落盘 → 桥 → 前端判据。
 *
 * 少一环就是「代码看起来修了、用户看到还是没修」—— 这一批 bug
 * 反复出现的典型原因。
 */
const mobileSrc = fs.readFileSync(new URL('../lib/index.js', here), 'utf8');
T('宿主有 syncedAt 的读取器', /function loadDesktopSyncedAt\(\)/.test(mobileSrc));
T('宿主在创建空壳时记下时刻', /desktopSyncedAt\[sessionId\] = Date\.now\(\)/.test(mobileSrc));
T('宿主把 syncedAt 一并写盘', /saveDesktopMeta\(desktopTimes, desktopPins, desktopSyncedAt/.test(mobileSrc));
/*
 * ⑨ 「补记账」必须排在 `syncedSessions.has()` 的 `continue` **之前**。
 *
 * 否则老版本同步出来的会话永远走不到 `rememberDesktopMeta`
 * ⇒ 时间表恒空 ⇒ 排序与置顶对这批会话永远不生效，
 * 而且用户「重新同步」多少次都是同一个结果（这正是他报障时的感受）。
 */
{
	const fnStart = mobileSrc.indexOf("case 'autoSyncDesktop'");
	const fnEnd = mobileSrc.indexOf("case 'syncConversations'");
	const slice = mobileSrc.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 20000);
	const atMeta = slice.indexOf('io.rememberDesktopMeta?.(sessionId, item?.updatedAt, item?.pinned)');
	const atSkip = slice.indexOf('if (io.syncedSessions.has(sessionId))');
	T(
		'**补记账排在「已同步就跳过」之前**（否则老会话永远补不上）',
		atMeta >= 0 && atSkip >= 0 && atMeta < atSkip,
		`meta@${atMeta} skip@${atSkip}`,
	);
}
T('desktopMeta 桥下发 syncedAt', /syncedAt: \{ \.\.\.\(io\.desktopSyncedAt/.test(mobileSrc));
T('前端接收 syncedAt', /var nextSynced = \{\};/.test(clientSrc));
T('前端用建壳时刻判假值', /isFake = local <= syncedAt \+ 120000/.test(clientSrc));

/*
 * 动态往返：模拟 readDesktopMeta 的校验逻辑，确认脏数据进不来。
 */
const validate = (raw) => {
	const empty = { times: {}, pins: {} };
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return empty;
	}
	if (parsed === null || typeof parsed !== 'object') return empty;
	const times = {};
	const rawTimes = parsed.times;
	if (rawTimes !== null && typeof rawTimes === 'object') {
		for (const [k, v] of Object.entries(rawTimes)) {
			if (typeof k !== 'string' || k === '') continue;
			if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
			times[k] = v;
		}
	}
	const pins = {};
	const rawPins = parsed.pins;
	if (rawPins !== null && typeof rawPins === 'object') {
		for (const [k, v] of Object.entries(rawPins)) {
			if (typeof k === 'string' && k !== '' && v === true) pins[k] = true;
		}
	}
	return { times, pins };
};

const roundTrip = validate(
	JSON.stringify({ times: { a: 1700000000000, b: 'oops', c: -5, d: 1.5 }, pins: { a: true, b: 1, c: false } }),
);
T('合法时间戳保留', roundTrip.times.a === 1700000000000);
T('**字符串时间戳被丢弃**（否则排序得 NaN）', roundTrip.times.b === undefined);
T('负数时间戳被丢弃', roundTrip.times.c === undefined);
T('小数时间戳保留（不误伤合法值）', roundTrip.times.d === 1.5);
T('只有严格 true 才算置顶', roundTrip.pins.a === true && roundTrip.pins.b === undefined && roundTrip.pins.c === undefined);
T('损坏的 JSON 返回空结构', JSON.stringify(validate('{not json')) === JSON.stringify({ times: {}, pins: {} }));

/*
 * syncedAt 也要按同一套规则校验：它的用途是「和本地时间戳做比较」，
 * 混进字符串/NaN 会让 `local <= syncedAt + 120000` 恒为 false ⇒
 * 判假值永远失败 ⇒ 排序修复静默失效。
 */
const validateSynced = (raw) => {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	const out = {};
	const src = parsed?.syncedAt;
	if (src !== null && typeof src === 'object') {
		for (const [k, v] of Object.entries(src)) {
			if (typeof k !== 'string' || k === '') continue;
			if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
			out[k] = v;
		}
	}
	return out;
};
const syncedOut = validateSynced(
	JSON.stringify({ syncedAt: { ok: 1700000000000, bad: '1700', neg: -1, nan: null } }),
);
T('建壳时刻只保留合法数字', Object.keys(syncedOut).length === 1 && syncedOut.ok === 1700000000000, JSON.stringify(syncedOut));

/* ══════════════════════════════════════════════════════════════════
 * ⑭ ask 弹窗必须能到达「没打开那个会话」的手机
 *
 * 用户报障（2026-10-29）：
 *   「场景一：在手机的电脑工作区输入『发起一个ask询问』，此时电脑能正常弹出，
 *    但手机不显示。场景二：在使用电脑的过程中 AI 发起了弹窗，但此时用户不在
 *    这个对话，属于后进入对话，此时手机不仅收不到弹窗，甚至连新消息都看不到。」
 *
 * 根因：电脑端 `push()` 只发给 `followers.get(sessionId)` —— 只有**正在跟随
 * 那个会话**的连接，而手机同一时刻只跟随一个会话。ask 又是进程内 waterfall
 *（不落盘、不进 `session/event`），所以后来打开那个会话也不会重放。
 * ══════════════════════════════════════════════════════════════════ */
console.log('\n══ ⑭ ask 跨会话送达（端到端）══');
{
	T(
		'电脑端有全局订阅者集合（不带 session 的 SSE）',
		/const globals = new Set\(\)/.test(desktopSrc),
	);
	T(
		'不带 session 的连接被当作全局订阅，不再 400',
		/sessionId === null\)\s*\{[\s\S]{0,400}?globals\.add\(res\)/.test(desktopSrc),
	);
	T(
		'全局连接有心跳（隧道会掐空闲连接）',
		/const beat = setInterval/.test(desktopSrc),
	);
	T(
		'心跳定时器 unref（不阻塞 Node 退出）',
		/beat\.unref\?\.\(\)/.test(desktopSrc),
	);
	T(
		'ask 推送带 global=true',
		/push\(sessionId, 'ask', \{ requestId, kind, \.\.\.payload \}, true\)/.test(desktopSrc),
	);
	/*
	 * 最关键的一条：`live` 只看 followers 会把「手机只连着全局连接」误判成
	 * 手机不在线 ⇒ 立刻 fallback 给本地 GUI ⇒ 手机上作答不算数。
	 */
	T(
		'**全局订阅者也算「有手机在线」，否则会误 fallback**',
		/live\.length > 0 \|\| hasGlobal === true/.test(desktopSrc),
	);
	T(
		'ask 会打上 dirty 标记（没连着的手机靠 ping 发现）',
		/markDirty\('ask'\)/.test(desktopSrc),
	);
	T(
		'最后一条 ask 收尾时清掉 dirty（否则每 3 秒空转补拉）',
		/pendingAsks\.size === 0\) clearDirty\('ask'\)/.test(desktopSrc),
	);
	T(
		'手机端探测间隔改成 3 秒',
		/schedule\(3000\)/.test(clientSrc) && !/schedule\(desktopOnlineRef\.value\.ok \? 20000 : 8000\)/.test(clientSrc),
	);
	T(
		'手机端消费 dirty 里的 ask 去补拉',
		/sawAsk === true/.test(clientSrc) && /bridge\('pullAsks', \{\}\)/.test(clientSrc),
	);
	T(
		'ask 从 dirty 里剔除后再交给同步分支（避免被一起 ack）',
		/dirtyAll\[di\] === 'ask'/.test(clientSrc),
	);
}

/* ══════════════════════════════════════════════════════════════════ */

console.log('\n════════ ' + pass + ' 通过, ' + fail + ' 失败 ════════');
process.exit(fail === 0 ? 0 : 1);
