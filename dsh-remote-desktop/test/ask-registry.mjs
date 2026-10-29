/**
 * 电脑端 ask 登记行为的静态契约测试。
 *
 * ## 为什么需要（2026-10-29 用户实测推翻了我的假设）
 *
 * 我原来在 `askPhone` 里写：手机不在线 ⇒ **立刻 `return fallback`**，
 * 并把请求塞进 `ghostAsks`（幽灵记录），理由是"用户就坐在电脑前，
 * 不该等 5 分钟"。
 *
 * 这个推理有一个**致命的错误假设** —— 我以为 `return fallback` 之后
 * 电脑 GUI 会"接管并结束"这一轮。用户实测当场推翻：
 *
 *   「我刚实测了一下 根本不存在你说的电脑自动提交，
 *     我看电脑那边一直是等待回答」
 *
 * 事实：`fallback` 就是 `NO_TAKEOVER`，只告诉官方「手机没接手」，
 * GUI 照常弹窗、照常等着。而请求进了 `ghostAsks` ⇒ `answerAsk` 只查
 * `pendingAsks` ⇒ 手机后来点它拿到 `expired` ⇒ **点了没反应**。
 *
 * 这个文件把「以后不许再退回去」钉成断言。
 */
import fs from 'node:fs';

let pass = 0, fail = 0;
const T = (n, c, e) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n + (e ? '  ' + e : ''))); };

const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
/** 去掉注释，避免把注释里的说明当成代码（这个坑踩过不止一次）。 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n══ 电脑端：手机离线时也必须登记等待 ══');

T(
	'**`ghostAsks` 已彻底移除**（它只解决可见性、不解决决定权）',
	!/ghostAsks\s*=\s*new Map/.test(code) && !/ghostAsks\.set\(/.test(code),
	'还残留 ghostAsks 写入点',
);

T(
	'**`askPhone` 不再「离线就立刻 return fallback」**',
	!/askPhone 无手机在线[\s\S]{0,200}?return fallback/.test(code),
	'仍然在离线时直接返回 fallback —— 那条 ask 之后就无法作答了',
);

T(
	'离线分支仍然让流程走到 `settled.promise`（登记等待）',
	/askPhone 手机此刻不在线，仍登记等待/.test(src),
);

T(
	'请求无论在线离线都登记进 `pendingAsks`',
	/pendingAsks\.set\(requestId, \{/.test(code),
);

console.log('\n══ 电脑端：手机答案的形状校验 ══');

T(
	'**校验每条答案的 `id` 是字符串**（官方会读 `answer.id`）',
	/typeof item\.id === 'string'/.test(code),
);

T(
	'**校验 `selected` 是数组**（官方会 `[...answer.selected]` 展开）',
	/Array\.isArray\(item\.selected\)/.test(code),
);

T(
	'校验不通过时退回电脑那条（不把坏答案塞进工具输出）',
	/wellFormed[\s\S]{0,400}?return desktop;/.test(code),
);

T(
	'`answerAsk` 仍是唯一作答入口，且能找到挂起项就 resolve',
	/pendingAsks\.get\(requestId\)[\s\S]{0,300}?entry\.resolve\(answer\)/.test(code),
);

console.log('\n════════ ' + pass + ' 通过, ' + fail + ' 失败 ════════');
process.exit(fail === 0 ? 0 : 1);
