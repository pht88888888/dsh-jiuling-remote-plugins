import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/root/.npm/_npx/705bc6b22212b352/node_modules/');
const { chromium } = require('playwright');

/**
 * 后台恢复测试：**App 退到后台再回来，能不能重新收到推送**。
 *
 * ## 为什么必须有这个文件（2026-10-29 用户第三次返工）
 *
 * 用户原话：
 *
 *   「我在手机上主动发消息的时候是可以收到的，但必须一直在线才行。
 *     比如我在电脑上面让他发起询问，然后我 APP 是退出后台的，重新打开
 *     APP 无法收到新消息、也收不到弹窗。我必须去主页点『添加工作区』
 *     触发一次刷新，再回到刚才的对话才能看到文字刷新过来了 ——
 *     但弹窗还是没有。」
 *
 * ## 根因
 *
 * 代码注释里写着「EventSource 自带断线重连，所以这里不做退避」——
 * 这个假设在**桌面浏览器**成立，在 Android WebView 上不成立：
 * App 退后台时系统冻结 WebView，回到前台那条 EventSource 停在 CLOSED，
 * **浏览器不会为一个已经死掉的连接重新拨号**。
 *
 * 于是 Node 侧 watcher 归零 → 电脑推来的 ask 进真空 → 用户什么都收不到。
 * 而「添加工作区」能刷新文字，是因为那是一次**新的 HTTP RPC**，
 * 不需要长连接；但它也救不回弹窗（ask 只活在 `pendingAsks` 里，没人拉就没有）。
 *
 * 这个测试用真实 Chromium 模拟「连接被冻结 → 回到前台」，
 * 断言：旧连接被关、新连接建立、并且真的去补拉了 ask。
 */
const clientSrc = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 2376 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');

await page.evaluate(() => {
  window.__sent = [];
  window.__sources = [];
  window.fetch = (url, init) => {
    window.__sent.push({ url, body: init && init.body });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  };
  // 模拟 EventSource：可查询 readyState、可被 close
  window.EventSource = function (url) {
    const h = {};
    const self = {
      url, h, readyState: 1, closed: false,
      addEventListener(n, f) { (h[n] = h[n] || []).push(f); },
      close() { self.readyState = 2; self.closed = true; },
      // 模拟"被系统冻结"：连接直接死掉
      freeze() { self.readyState = 2; },
    };
    window.__sources.push(self);
    return self;
  };
  window.__ModuleLoader__ = { load: (d) => { window.__mod = d; } };
});

await page.addScriptTag({ content: clientSrc });

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

const before = await page.evaluate(() => window.__sources.length);

// 模拟：退到后台 → 连接被冻结（readyState=2，不会自己活）
await page.evaluate(() => {
  const s = window.__sources[0];
  if (s) s.freeze();
  document.dispatchEvent(new Event('visibilitychange'));
});

await page.waitForTimeout(150);
const afterVisible = await page.evaluate(() => ({
  count: window.__sources.length,
  firstClosed: window.__sources[0] ? window.__sources[0].closed : null,
  secondOpen: window.__sources[1] ? window.__sources[1].readyState : null,
  askedPull: window.__sent.some(s => String(s.body).includes('pullAsks')),
}));

// 场景 B：连接还活着（readyState=1），不应重建
await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(100);
const afterHealthy = await page.evaluate(() => window.__sources.length);

const applyErr = await page.evaluate(() => window.__applyErr || null);
await browser.close();

let pass = 0, fail = 0;
const T = (n, c, e) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n + (e ? '  ' + e : ''))); };

T('client.js 装载无异常', applyErr === null, String(applyErr));
T('初始建立了一条 SSE', before === 1, String(before));
T('**连接冻结后，回到前台会重建**', afterVisible.count === 2, 'count=' + afterVisible.count);
T('**旧连接被关闭**（不残留半死连接）', afterVisible.firstClosed === true);
T('**新连接是打开的**（重连成功）', afterVisible.secondOpen === 1, String(afterVisible.secondOpen));
T('**重建后补拉了 ask**（弹窗靠这个补回来）', afterVisible.askedPull === true);
T('连接健康时不重建（避免白丢连接）', afterHealthy === 2, String(afterHealthy));
T('全过程无 JS 错误', errors.length === 0, errors.join(' | '));

console.log('\n════════ ' + pass + ' 通过, ' + fail + ' 失败 ════════');
process.exit(fail === 0 ? 0 : 1);
