/**
 * 真实浏览器验证：**卡片到底看不看得见**。
 *
 * ## 为什么必须有这个文件（2026-10-29 血泪教训）
 *
 * 用户连续三轮说「没弹窗」，而每一轮我的静态断言全绿。真相是：
 *
 *   · 卡片确实被创建了（`card !== null` ✓）
 *   · 卡片确实有内容（文本断言 ✓）
 *   · **但它被底部输入框完全盖住** —— 实际可见高度 0 / 219
 *
 * 这类问题**只可能**在真实浏览器里量出来：jsdom 没有布局、没有层叠、
 * `getBoundingClientRect()` 全返回 0。所以必须有真 Chromium 的几何断言。
 *
 * 复刻的是真机竖屏 1080x2376，并铺一个 ~300px 高的仿真输入框
 * （`position: fixed` 在最上层，和 DSH 的 composer 结构一致）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

// playwright 不在本包依赖里（只为测试用），从常见位置解析
const CANDIDATES = [
	'/root/.npm/_npx/705bc6b22212b352/node_modules/',
	process.cwd() + '/node_modules/',
];
let require = null;
let chromium = null;
for (const base of CANDIDATES) {
	try {
		const r = createRequire(base);
		chromium = r('playwright').chromium;
		require = r;
		break;
	} catch { /* 试下一个 */ }
}
if (chromium === null) {
	console.log('  ⚠️ 未找到 playwright，跳过真实浏览器测试');
	process.exit(0);
}

let pass = 0, fail = 0;
const T = (n, c, e) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n + (e ? '  ' + e : ''))); };

const clientSrc = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const browser = await chromium.launch();
// 模拟手机竖屏（与用户截图同尺寸比例）
const page = await browser.newPage({ viewport: { width: 1080, height: 2376 }, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// 先铺一个模拟的官方会话页，让卡片有地方挂
await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font-family:-apple-system,sans-serif;background:#fff}
.msg{padding:16px;border-bottom:1px solid #eee}</style></head>
<body><div id="root"><div class="msg">历史消息…</div></div>
<div id="fake-composer" style="position:fixed;left:0;right:0;bottom:0;height:300px;background:#fff;border-top:1px solid #ddd;z-index:2147483000">
  <div style="padding:20px;color:#888">发消息或创建任务…（真机输入框占位）</div>
</div></body></html>`);

// 收集 EventSource，并伪装成真机环境
await page.evaluate(() => {
  window.__sent = [];
  window.__sources = [];
  window.fetch = (url, init) => { window.__sent.push({ url, body: init && init.body }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); };
  const RealES = window.EventSource;
  window.EventSource = function (url) {
    const h = {}; const self = { url, h, addEventListener(n, f) { (h[n] = h[n] || []).push(f); }, close() {} };
    window.__sources.push(self); return self;
  };
  window.__ModuleLoader__ = { load: (d) => { window.__mod = d; } };
});

await page.addScriptTag({ content: clientSrc });

const loaded = await page.evaluate(() => window.__mod !== null && window.__mod !== undefined);

// 用一个最小 ctx 触发 apply（真机也是这条路）
await page.evaluate(() => {
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
  try {
    if (window.__mod && typeof window.__mod.factory === 'function') {
      const m = window.__mod.factory(chain);
      if (m && typeof m.apply === 'function') m.apply(chain);
    }
  } catch (e) { window.__applyErr = String(e); }
});

const srcCount = await page.evaluate(() => (window.__sources || []).length);

// 用宿主真实格式派发 ask
await page.evaluate(() => {
  const s = (window.__sources || [])[0];
  if (!s) return;
  const payload = {
    sessionId: 'session-x', requestId: 'real-1', kind: 'question',
    questions: [{ id: 'q1', header: '第四次测试', question: '这个 ask 能不能弹出来？',
      options: [{ label: '能', description: '卡片正常显示' }, { label: '不能' }] }],
  };
  const data = JSON.stringify(payload);
  for (const f of (s.h['ask'] || [])) f({ data });
});

await page.waitForTimeout(400);

const result = await page.evaluate(() => {
  const card = document.getElementById('dsh-remote-ask');
  if (!card) return { found: false };
  const r = card.getBoundingClientRect();
  const cs = getComputedStyle(card);
  return {
    found: true,
    visible: r.width > 0 && r.height > 0,
    inViewport: r.top < window.innerHeight && r.bottom > 0,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    position: cs.position,
    zIndex: cs.zIndex,
    text: card.innerText.slice(0, 200),
    btnCount: card.querySelectorAll('button').length,
    overlapsComposer: (function () {
      var fc = document.getElementById('fake-composer');
      if (!fc) return null;
      var f = fc.getBoundingClientRect();
      return !(r.bottom <= f.top || r.top >= f.bottom);
    })(),
    visiblePx: (function () {
      var fc = document.getElementById('fake-composer');
      var coverTop = fc ? fc.getBoundingClientRect().top : window.innerHeight;
      return Math.max(0, Math.min(r.bottom, coverTop) - r.top);
    })(),
  };
});

await page.screenshot({ path: '/tmp/ask-card-before-click.png', fullPage: false });

// 点一下「能」，看有没有回传
await page.evaluate(() => {
  const card = document.getElementById('dsh-remote-ask');
  if (!card) return;
  const b = [...card.querySelectorAll('button')].find((x) => x.innerText.includes('能'));
  if (b) b.click();
});
await page.waitForTimeout(300);
const sent = await page.evaluate(() => window.__sent || []);

await page.screenshot({ path: '/tmp/ask-card-after-click.png', fullPage: false });

/* ══════════════════════════════════════════════════════════════════
 * 无选项（自由回答）形态：输入框必须**真的可见、可点**（1.2.96）
 *
 * jsdom 里「有 textarea 元素」很容易通过，但它在真机上可能被挤到
 * 视口外、或被输入框盖住 —— 那就等于没有。这里量真实几何。
 * ══════════════════════════════════════════════════════════════════ */
await page.evaluate(() => {
  const old = document.getElementById('dsh-remote-ask');
  if (old) old.remove();
  const s = (window.__sources || [])[0];
  if (!s) return;
  const data = JSON.stringify({
    sessionId: 'session-x', requestId: 'real-free-1', kind: 'question',
    questions: [{ id: 'q-free', question: '请描述一下你遇到的问题（没有选项，自由回答）', options: [] }],
  });
  for (const f of (s.h['ask'] || [])) f({ data });
});
await page.waitForTimeout(400);

const freeInfo = await page.evaluate(() => {
  const card = document.getElementById('dsh-remote-ask');
  if (!card) return { found: false };
  const area = card.querySelector('textarea');
  const btn = [...card.querySelectorAll('button')].find((b) => b.innerText.includes('提交'));
  const skip = [...card.querySelectorAll('button')].find((b) => b.innerText.includes('跳过'));
  const geo = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width), display: cs.display, visible: r.width > 0 && r.height > 0 };
  };
  return {
    found: true,
    textarea: geo(area),
    submit: geo(btn),
    skip: geo(skip),
    viewportH: window.innerHeight,
  };
});

T('无选项形态能弹出卡片', freeInfo.found === true);
T('**输入框真实可见（有宽高、在视口内）**',
	freeInfo.textarea !== null && freeInfo.textarea.visible === true
		&& freeInfo.textarea.y > 0 && freeInfo.textarea.y < freeInfo.viewportH,
	freeInfo.textarea === null ? '不存在' : JSON.stringify(freeInfo.textarea));
T('**提交按钮真实可见**',
	freeInfo.submit !== null && freeInfo.submit.visible === true,
	freeInfo.submit === null ? '不存在' : JSON.stringify(freeInfo.submit));
T('**有关闭路径（跳过按钮可见）**',
	freeInfo.skip !== null && freeInfo.skip.visible === true,
	freeInfo.skip === null ? '不存在 —— 用户会关不掉' : JSON.stringify(freeInfo.skip));

// 外观留证：**提交之前**截一张（提交后卡片就没了，那时候截什么都看不到）
await page.screenshot({ path: '/tmp/ask-card-free-before.png', fullPage: false });

// 真的在浏览器里打字并提交，确认能回传
const freeSentBefore = await page.evaluate(() => (window.__sent || []).length);
await page.fill('#dsh-remote-ask textarea', '真浏览器里输入的回答');
await page.evaluate(() => {
  const card = document.getElementById('dsh-remote-ask');
  const btn = [...card.querySelectorAll('button')].find((b) => b.innerText.includes('提交'));
  if (btn) btn.click();
});
await page.waitForTimeout(300);
const allSent = await page.evaluate(() => window.__sent || []);
T('**真浏览器里填内容后能提交回传**',
	allSent.length > freeSentBefore && allSent.some((x) => {
		try { return JSON.stringify(JSON.parse(x.body)).includes('真浏览器里输入的回答'); } catch { return false; }
	}),
	'sent=' + allSent.length);
T('**提交后卡片消失（不会一直浮在页面上）**',
	await page.evaluate(() => document.getElementById('dsh-remote-ask') === null));

await page.screenshot({ path: '/tmp/ask-card-free.png', fullPage: false });

await browser.close();

/* ══ 断言 ══ */
T('client.js 在真 Chromium 里加载成功', loaded === true);
T('建立了 EventSource', srcCount === 1);
T('卡片被创建', result.found === true);
T('卡片有尺寸（不是 0×0）', result.visible === true);
T('**卡片在视口内**', result.inViewport === true);
T('**卡片不被底部输入框遮挡**', result.overlapsComposer === false,
	'overlaps=' + result.overlapsComposer);
T('**卡片实际可见高度 ≈ 完整高度**',
	result.visiblePx > result.rect.h * 0.9,
	result.visiblePx + ' / ' + result.rect.h);
T('卡片是 fixed 定位且层级够高', result.position === 'fixed' && Number(result.zIndex) > 2147483000, result.zIndex);
T('卡片显示了题目标题', String(result.text).includes('第四次测试'));
T('卡片渲染了选项按钮', result.btnCount >= 2, String(result.btnCount));
T('点选项后回传 answerAsk',
	sent.some((x) => { try { return JSON.parse(x.body).method === 'answerAsk'; } catch { return false; } }));
T('答回传里带上所选选项',
	sent.some((x) => { try { return JSON.stringify(JSON.parse(x.body)).includes('能'); } catch { return false; } }));
T('页面无 JS 错误', errors.length === 0, errors.join(' | '));

console.log('\n════════ ' + pass + ' 通过, ' + fail + ' 失败 ════════');
process.exit(fail === 0 ? 0 : 1);
