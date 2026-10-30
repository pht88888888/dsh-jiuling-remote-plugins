/**
 * 「同步会话被写坏 → 从侧边栏消失」的静态契约测试。
 *
 * ## 为什么有这个文件（2026-10-30 真实用户报告）
 *
 * 两条反馈都指向同一个 bug：
 *
 *   · 20261030-111618-3d1620（2398204646@qq.com）—— 310 行报告，
 *     带真机日志和 1.2.97 精确行号；
 *   · 20261029-030943-8a4b33（1363839586@163.com）—— 同一个报错。
 *
 * 用户原话：
 *
 *   「SessionFormatError: delivery throughSeq must precede its marker
 *     同一个会话在 PC 端校验完整（10838 条、seq 严格递增），
 *     手机端那份 session.v4.jsonl.zstd 却报损坏」
 *   「同步 → 打开后约 40 分钟消失，自愈重建失败，永久消失」
 *
 * ## 三个独立缺陷（缺一个都还会复发）
 *
 * ① `pollCatchUp` 对所有本地会话补洞，同步会话的**占位壳**也被写入
 *    mid-turn 事件（从对话中段开始，缺 `turn/start`/`step/start`）⇒
 *    引擎判日志损坏 ⇒ 会话不渲染 ⇒ 用户看到「消失」。
 *
 * ② `followSynced` 同样逐条写；用户一「打开」同步会话就开始写坏。
 *
 * ③ `ensureLocalMirror` 的损坏自愈分支 `create(request)` 里 `request`
 *    是外层 `try` 的块内变量，`catch` 看不见 ⇒ 每次重建必抛
 *    `request is not defined` ⇒ 壳被删了又建不回来 ⇒ **永久消失**。
 *
 * 这个文件把这些契约钉死，防止以后又改回去。
 */
import fs from 'node:fs';

let pass = 0, fail = 0;
const T = (n, c, e) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n + (e ? '  ' + e : ''))); };

const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
/** 去掉注释，避免把注释里的说明当成代码。 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n══ ① 轮询补洞：同步会话不落盘 ══');

T(
	'轮询写盘前判断 `syncedSessions`',
	/syncedSessions\.has\(sessionId\)[\s\S]{0,80}?\?\s*false[\s\S]{0,120}?:[\s\S]{0,80}?mirrorEvent\(/.test(code),
);

T(
	'**同步会话仍然 broadcast（只跳过落盘，不跳过显示）**',
	/mirrorEvent\(session, event, mirrorStateOf\(sessionId\)\)[\s\S]{0,400}?broadcast\('event', \{ sessionId, event \}\)/.test(code),
);

console.log('\n══ ② 实时流：同步会话不落盘 ══');

T(
	'`followSynced` 写盘包在 `!syncedSessions.has()` 里',
	/if \(!syncedSessions\.has\(sessionId\)\) \{\s*const local = await ensureLocalMirror\(sessionId\);/.test(code),
);

T(
	'两处都已修（轮询 + 实时流）',
	(code.match(/syncedSessions\.has\(sessionId\)/g) ?? []).length >= 3,
	'出现次数=' + (code.match(/syncedSessions\.has\(sessionId\)/g) ?? []).length,
);

console.log('\n══ ③ 自愈重建：不得引用外层块变量 ══');

T(
	'**重建处重新构造 `rebuildRequest`**（原来引用外层 `request` ⇒ ReferenceError）',
	/const rebuildRequest = \{ sessionId \}/.test(code),
);

T(
	'重建调用用的是新构造的 request（不是外层那个）',
	/await ctx\.sessionController\.create\(rebuildRequest\)/.test(code),
);

T(
	'重建成功后补 `markSessionNonBlank`（否则新壳仍被 blank 规则隐藏）',
	/create\(rebuildRequest\)[\s\S]{0,800}?markSessionNonBlank\(ctx, sessionId/.test(code),
);

console.log('\n══ ④ 「缺口过大」日志不再为同步会话刷屏 ══');

T(
	'该日志对同步会话静默',
	/if \(!syncedSessions\.has\(sessionId\)\) \{\s*void debugLog\(`轮询补洞跳过/.test(code),
);

console.log('\n════════ ' + pass + ' 通过, ' + fail + ' 失败 ════════');
process.exit(fail === 0 ? 0 : 1);
