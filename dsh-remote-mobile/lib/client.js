/**
 * dsh-remote-mobile —— 手机端（client half，跑在 WebView 的页面世界里）。
 *
 * ## 这个文件做两件事
 *
 * 1. **「电脑文件夹」入口** —— 注册进 `directoryFlow` slot，让选文件夹的对话框里
 *    多出一个「电脑」页签：浏览电脑目录、在电脑上直接开一个会话。
 * 2. **电脑实时消息流** —— 订阅宿主桥的全局 SSE，把电脑的流式帧转成
 *    `assistant/live-chunk` transient 注入本地会话，于是手机上有逐字动画。
 *
 * ## ⚠️ 为什么是「取代」官方对话框，而不是「并列」
 *
 * `directoryFlow` 是 `kind: "single"` 的 slot，渲染时取 `entriesOfSlot(name)[0]`，
 * 而 entries 按 priority **升序**排（见 dsh-client-ui-renderer L1148-1151）。
 * 也就是说这个 slot 同时只能渲染**一个** occupant，无法「并排加一项」。
 *
 * 所以本插件用 **priority -1** 占据首位，自己实现一个双页签对话框：
 * 「手机」页签复刻官方浏览行为（走 `uiWorkspace.listDirectory`，与官方 browse
 * 后端是同一个 API），「电脑」页签走宿主桥。对用户的观感就是
 * 「选文件夹的时候多了一个电脑入口」。
 *
 * ## ⚠️ 语法约束（旧内核）
 *
 * 本 App 有按 chrome73 降级编译的前端 bundle（`webview-compat.zip`），
 * 所以这里**不用**可选链 `?.`、空值合并 `??`、`Object.fromEntries`、`Array.flat`
 * 这些 chrome80+ 的语法。
 *
 * @module dsh-jiuling-remote-mobile/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-jiuling-remote-mobile',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		var react = require('react');
		var h = react.createElement;

		/**
		 * 官方 UI 原子组件（对话框、按钮、分段页签、图标）。
		 *
		 * ⚠️ **这是「长得像官方」的唯一正解**：官方目录选择器
		 * （`dsh-client-ui-directory-picker-browse`）自己也是这么 `require` 的，
		 * 该模块已在页面模块注册表里，手机与桌面两端都有。
		 *
		 * 自己手搓 `div` + `style` 的代价是实打实的：先前那版写死了
		 * `background:var(--dsw-alias-bg-primary,#1b1b1f)` —— 而
		 * **`--dsw-alias-bg-primary` 这个令牌根本不存在**（官方真实名字是
		 * `--dsw-alias-bg-layer-1` / `bg-l1` / `bg-base`），于是整块卡片永远走
		 * 那个深色 fallback；`--dsw-alias-border-secondary` 同样不存在。
		 * 表现就是手机上「两大坨黑色、跟官方 UI 完全脱钩」。
		 */
		var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		var Modal = primitives.Modal;
		var Button = primitives.Button;
		var Input = primitives.Input;
		var SegmentedTabs = primitives.SegmentedTabs;
		var IconFolderCloseRegular = primitives.IconFolderCloseRegular;
		var IconChevronRightOutlineRegular = primitives.IconChevronRightOutlineRegular;
		var IconPlusOutlineRegular = primitives.IconPlusOutlineRegular;

		/** 宿主桥的路由（同源，直接相对路径）。 */
		var ROUTE_RPC = '/api/dsh-remote/rpc';
		var ROUTE_STREAM = '/api/dsh-remote/stream';

		/**
		 * 对话框卡片的 className（Modal 的 `className` 收字符串、不是 style 对象）。
		 *
		 * 尺寸与留白**逐条照抄**官方目录选择器对 Modal 的覆盖
		 * （`.../dsh-client-ui-directory-picker-browse/lib/client.js` 里
		 * `dialog{...gap:0;width:min(680px,100%);height:min(500px,100dvh - 32px);padding:0}`），
		 * 只把宽度收窄到手机合适的 560px。背景、圆角、阴影、遮罩一律由官方
		 * Modal 自己的 CSS 提供 —— 本插件**不再声明任何颜色**。
		 */
		var DIALOG_CLASS = 'jlm_dialog';

		/**
		 * 布局样式：取值全部照抄官方目录选择器的同义规则，令牌全部是
		 * **真实存在**的官方设计令牌（`--dsw-alias-border-l3`、`bg-layer-*`、
		 * `interactive-bg-hover`、`label-*` …），不写死任何颜色值。
		 */
		var CSS = {
			// ## ⚠️⚠️ 高度必须有多档兜底，不能只靠 `dvh`
			//
			// 用户反馈（另一个人、另一台设备）：「要么就是太小了，中间内容看不见；
			// 要么就是太大了，又划不动」，视频里是**弹窗铺满全屏、标题栏和底部
			// 按钮全部消失、只剩一列文件夹**。
			//
			// 根因：原来只写了 `height:min(560px,100dvh - 32px)`。`dvh` 是
			// Chrome 108+ 才有的单位，**旧 WebView 不认识它 ⇒ 整条 `min()` 声明
			// 直接失效**（不是降级到 560px，而是整条无效）⇒ `height` 退回 `auto`
			// ⇒ 弹窗高度由内容决定 ⇒ 电脑页签下几十个文件夹把弹窗撑满整屏
			// ⇒ header / footer 被顶到视口外，用户就只看得见中间那列文件。
			//
			// 我自己的测试机 WebView 是 Chrome/114（支持 dvh），所以怎么测都是
			// 好的 —— 这就是为什么本地一直复现不出来。
			//
			// ## ⚠️ `height` 的 560px 上限太小（用户反馈「划不动」的另一半原因）
			//
			// 改成 `dvh` 兜底后我做了个对比（真机、电脑页签、56 个文件夹）：
			//
			//   只靠 max-height 撑（旧内核路径）→ 弹窗 716px，列表区 373px
			//   有 560px 的 height 上限（现代内核）→ 弹窗 560px，列表区 217px
			//
			// **同一个列表，现代内核反而少 42% 的可视高度**，因为 560 这个
			// 「理想高度」把卡片压住了。而 716px 才是官方 Modal 给的实际可用高度。
			// 所以把理想值提到 720px，让两种内核都接近满高。
			//
			// 底下 430px 左右的矮视口（横屏）仍由 `max-height` 压回来，不受影响。
			dialog:
				'gap:0;width:min(560px,100%);' +
				'max-height:calc(100vh - 48px);' +
				'max-height:calc(100dvh - 48px);' +
				'height:min(720px,calc(100vh - 48px));' +
				'height:min(720px,calc(100dvh - 48px));' +
				'height:min(720px,100%);' +
				'padding:0;display:flex;flex-direction:column;overflow:hidden;',
			// ## ⚠️⚠️ 原来是 `display:contents`，那是个真 bug
			//
			// `display:contents` 会让这个容器**盒模型消失**，三个子块（header /
			// 内容 / footer）直接变成官方 Modal 卡片的 flex 项。看着没问题，实测
			// 却是这样（真机横屏 764×324）：
			//
			//     卡片高 292px
			//     ├─ header  138px（占视口 42%）
			//     ├─ 内容     85px（只放得下 2 行文件夹）
			//     └─ footer   68px
			//
			// 用户报障原话：「要么就是太小了，中间内容看不见；要么就是太大了，
			// 又划不动。」—— 竖屏长列表时 `flex:1 1 auto` 因为父级没有确定高度
			// 算不准，内容把 footer 顶出屏幕（划不动）；横屏时 header 把空间吃光
			// （中间看不见）。
			//
			// 改成真正的 flex 列容器后，`flex:none` / `flex:1 1 auto` 才有意义：
			// header 与 footer 固定、中间那一段占满剩余并可内部滚动。
			editorScope:
				'display:flex;flex-direction:column;flex:1 1 auto;min-height:0;' +
				'width:100%;overflow:hidden;',
			header:
				'display:flex;flex-direction:column;flex:none;' +
				// ## 头部间距随视口高度收缩（横屏 / 小屏的关键）
				//
				// 真机横屏 764×324 实测：标题 28 + 页签 42 + 路径行 28 = 98，
				// 加上下 padding 40 与两个 gap 16，合计 **138px** —— 整整吃掉
				// 292px 卡片高度的 47%，中间列表只剩 85px（放得下 2 行）。
				// 用户报的「中间内容看不见」就是这个。
				//
				// `clamp()` 让间距跟着视口高度线性收缩：视口 ≥520px 时是原值
				//（16/8/8），到 324px 时压到 (10/4/4)，能省出约 30px。
				// 比媒体查询稳 —— 媒体查询里靠后代选择器定位这个节点，
				// 层级一变（比如 `display:contents` 改掉）就静默失效，踩过。
				//
				// ⚠️ **`clamp()` 前面先写固定值兜底**：`clamp()` 是 Chrome 79+
				// 才有的函数，更老的内核会把整条声明当非法值丢掉 —— 那样这个
				// 元素的 padding 会变成 0，头部贴在屏幕边缘，比「间距不收缩」难看得多。
				// CSS 同属性「后者覆盖前者」，所以固定值在前、`clamp()` 在后：
				// 支持的老老实实用 clamp，不支持的退回固定值。
				'gap:8px;gap:clamp(4px,2vh,8px);' +
				'padding:16px 14px 8px 24px;' +
				'padding:clamp(10px,2.2vh,16px) 14px clamp(4px,1.2vh,8px) 24px;' +
				'border-bottom:.5px solid var(--dsw-alias-border-l3);',
			title:
				'display:flex;align-items:flex-end;min-height:28px;margin:0;' +
				'font-size:16px;font-weight:510;line-height:24px;color:var(--dsw-alias-label-primary);',
			crumbBar: 'display:flex;align-items:center;gap:8px;min-height:24px;',
			// 「显示隐藏文件夹」开关：与「上一级」同排，靠右。
			crumbToggle:
				'display:flex;flex:none;align-items:center;gap:4px;cursor:pointer;' +
				'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;',
			crumbToggleOn: 'color:var(--dsw-alias-label-secondary);',
			pathText:
				'flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
				'color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;',
			content:
				// ⚠️ `overflow` 必须是 `auto` 而不是 `hidden`：横屏下中间区只有
				// ~98px，装不下「配对条 + 列表(最少 96px) + 提示语」。`hidden` 会把
				// 超出的部分直接裁掉（用户连滑的机会都没有）；`auto` 让整个中间区
				// 可滚，列表自己的 `overflow-y:auto` 再管它内部那一层。
				'display:flex;flex-direction:column;flex:1 1 auto;min-height:0;' +
				'padding:16px 16px 16px 24px;position:relative;overflow-y:auto;' +
				'overscroll-behavior:contain;',
			column:
				'display:flex;flex-direction:column;flex:1 1 auto;gap:2px;min-height:0;' +
				'padding-right:8px;overflow-y:auto;overscroll-behavior:contain;' +
				// 安卓 WebView 里不加这条，长列表的滑动会很「黏」，用户会以为划不动。
				'-webkit-overflow-scrolling:touch;',
			// ## ⚠️ 文件列表本身：**必须有自己的最小高度**
			//
			// 横屏 764×324 实测（1.2.17）：中间区只剩 98px，被「已配对」条(62)
			// 和底部提示语(44) 吃光，列表被压成 **0px** —— 用户一个文件夹都看不到，
			// 却又看到能滚（`scrollHeight` 是 1678）。这正是用户说的
			// 「中间内容看不见」。
			//
			// `min-height` 让列表永远至少占住 3 行，`flex-shrink:0` 防止被
			// 同级的配对条 / 提示语挤掉；挤不下的部分交给外层 `column` 去滚。
			columnList:
				'display:flex;flex-direction:column;gap:2px;' +
				'flex:1 1 auto;min-height:96px;' +
				'padding-right:8px;overflow-y:auto;overscroll-behavior:contain;' +
				'-webkit-overflow-scrolling:touch;',
			row:
				'display:flex;align-items:center;gap:4px;width:100%;height:28px;padding:4px;' +
				'border:none;border-radius:var(--dsw-radius-sm);background:0 0;' +
				'text-align:left;cursor:pointer;flex:0 0 auto;',
			rowIcon: 'flex:none;color:var(--dsw-alias-label-secondary);',
			rowName:
				'flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
				'color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;',
			rowChevron: 'flex:none;color:var(--dsw-alias-label-tertiary);',
			status:
				'padding:4px 120px 4px 4px;font-size:12px;line-height:18px;' +
				'color:var(--dsw-alias-label-secondary);',
			error:
				'padding:4px 120px 4px 4px;font-size:12px;line-height:18px;' +
				'color:var(--dsw-alias-state-error-primary);word-break:break-all;',
			note:
				'padding:8px 4px 0;font-size:12px;line-height:18px;' +
				'color:var(--dsw-alias-label-tertiary);',
			footerBar:
				'display:flex;flex-wrap:wrap;flex:none;align-items:center;gap:8px;' +
				// 固定值兜底 + `clamp()` 覆盖，理由同 `header`（老内核不认识 clamp）。
				'padding:16px 24px;padding:clamp(8px,2vh,16px) 24px;' +
				'border-top:.5px solid var(--dsw-alias-border-l3);',
			footerGap: 'flex:1 1 0;',
			footerAction: 'min-width:72px;',
			// —— 配对条（只在「电脑」页签下显示）——
			pairBar:
				'display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none;' +
				'padding:0 0 8px;',
			// ⚠️ **不能 `white-space:nowrap`**：手机上 360px 宽、这行字有 30 多个汉字，
			// 加了 nowrap + ellipsis 就会被截成「…里生...」—— 用户看不到要去哪一步，
			// 而这一步正是他唯一需要知道的。允许折行。
			pairWho:
				'flex:1 1 100%;min-width:0;' +
				'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;',
			pairInput: 'width:140px;text-transform:uppercase;letter-spacing:2px;',
			// 解绑二次确认那一行：提示文字占满整行，两个按钮跟在下面（手机上 360px
			// 放不下「文字 + 两个按钮」一行，所以让文字 `flex:1 1 100%` 自己换行）。
			pairConfirm:
				'display:flex;flex-wrap:wrap;align-items:center;gap:8px;' +
				'font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);',
			pairConfirmText: 'flex:1 1 100%;',
			pairMsg: 'padding:0 4px 8px;font-size:12px;line-height:18px;',
			pairOk: 'color:var(--dsw-alias-state-success-primary);',
			// 「刷新」那一行（模型 / 预设 / 目录树三样一起刷）的回执文字。
			refreshNote:
				'padding:0 4px 8px;font-size:12px;line-height:18px;' +
				'color:var(--dsw-alias-label-tertiary);',
			refreshOk: 'color:var(--dsw-alias-state-success-primary);',
			// —— 「同步对话」对话框 ——
			// 一行一个可勾选的对话。用 `label` 包住，点整行都能勾上（手机上
			// 20px 的复选框太小，只点方框很难点中）。
			syncRow:
				'display:flex;align-items:center;gap:10px;width:100%;min-height:40px;' +
				'padding:8px 4px;border-radius:var(--dsw-radius-sm);cursor:pointer;',
			syncBox: 'flex:none;width:18px;height:18px;accent-color:var(--dsw-alias-brand-primary);',
			syncName:
				'flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
				'color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px;',
			syncEmpty:
				'padding:24px 4px;text-align:center;font-size:13px;line-height:20px;' +
				'color:var(--dsw-alias-label-tertiary);',
			// 搜索 + 全选那一行。放在列表**上方**（列表可能有 70+ 项，
			// 放下面用户得先滑到底才看得见）。
			syncToolbar:
				'display:flex;align-items:center;gap:8px;padding:0 0 8px;flex:none;',
			syncSearch:
				'flex:1 1 0;min-width:0;height:34px;box-sizing:border-box;padding:0 10px;' +
				'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);' +
				'background:var(--dsw-specific-input-major,transparent);' +
				'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;',
			syncPickAll:
				'flex:none;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);' +
				'border-radius:var(--dsw-radius-sm);background:0 0;cursor:pointer;' +
				'color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;',
		};

		/**
		 * 把 CSS 文本解析成 React 的 style **对象**。
		 *
		 * ⚠️ **这一步不能省**：React 的 `style` prop 只接受对象，给字符串会当场抛
		 * `Minified React error #62`（React 18 的
		 * `if (style != null && typeof style != "object") throw Error(62)`），
		 * 组件随即被 slot 系统 `abdicate` 退役、渲染回落到官方对话框 ——
		 * 表现就是「电脑」页签根本不出现，而控制台里只有一条难懂的 #62。
		 *
		 * 键名同时做 kebab → camelCase（`min-width` → `minWidth`），否则 React
		 * 会逐条告警「Unsupported style property」。
		 *
		 * @param text - 形如 `'a:1;b:2;'` 的 CSS 声明串。
		 * @returns React style 对象。
		 */
		function toStyle(text) {
			var out = {};
			var parts = String(text).split(';');
			for (var index = 0; index < parts.length; index += 1) {
				var part = parts[index];
				if (part === '') continue;
				var colon = part.indexOf(':');
				if (colon < 0) continue;
				var name = part.slice(0, colon).trim();
				var value = part.slice(colon + 1).trim();
				if (name === '' || value === '') continue;
				out[name.replace(/-([a-z])/g, function (match, letter) {
					return letter.toUpperCase();
				})] = value;
			}
			return out;
		}

		// ⚠️ **先把文本留一份副本再转对象**：下面那个 `<style>` 标签拼的是 CSS
		// **文本**，而第 162 行会把 `CSS` 就地改写成对象 —— 顺序反了就会拼出
		// `[object Object]`，卡片尺寸规则整条失效（列表被 flex 压成 0 高、只剩空白）。
		var DIALOG_CSS_TEXT = CSS.dialog;

		// 就地转成对象：下游一律写 `style: CSS.xxx`，不会再碰到字符串形式。
		for (var styleKey in CSS) CSS[styleKey] = toStyle(CSS[styleKey]);

		/**
		 * 注入官方风格的样式表。
		 *
		 * ⚠️ 卡片那层（背景/圆角/阴影/遮罩）**全部由官方 Modal 自己的 CSS 提供**，
		 * 这里只覆盖尺寸与留白 —— 与官方目录选择器覆盖
		 * `dialog` 类的方式完全一致。所以本插件**不声明任何颜色**，
		 * 亮色/暗色主题都随官方走，不会再出现「一大坨黑」。
		 *
		 * 用 `<style data-plugin-css>` 注入（官方各 client 包的标准做法），
		 * 而不是把样式塞进 React 的 `style` prop —— Modal 只接受 `className`。
		 */
		var STYLE_TAG_ID = 'dsh-jiuling-remote-mobile/DirectoryTabs.css';

		/**
		 * 把本插件的样式表挂进文档。
		 *
		 * ⚠️⚠️ **整段必须包在 try/catch 里，而且不能假设 `document.head` 存在。**
		 *
		 * 这是 **factory 顶层**（不在 `apply()` 里），所以它抛错时：
		 *   1. 我的 `guard()` 兜不住（guard 只管 `apply()` 内部）；
		 *   2. `dsh-client-modules` 会把这次 factory 失败聚合进
		 *      `ClientPackageCompositionError`（`lib/index.js:144`），
		 *      **整批客户端插件一起失败**；
		 *   3. 界面直接停在 `Failed to load plugins`，App 进救援模式并无限重启。
		 *
		 * 而 `document.head` 在脚本处于 `<head>` 内、或文档还没解析到 head 时
		 * 是 `null` —— 那时 `document.head.appendChild(...)` 抛 TypeError，
		 * 正是上面那条链路。**样式挂不上只是不好看，绝不能因此让整个 App 起不来。**
		 *
		 * 所以：拿不到 `head` 就退到 `documentElement`；两者都没有就**静默跳过**。
		 */
		try {
			if (
				typeof document !== 'undefined' &&
				typeof document.createElement === 'function' &&
				document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']') === null
			) {
				var styleTag = document.createElement('style');
				styleTag.dataset.plugin = 'dsh-jiuling-remote-mobile';
				styleTag.dataset.pluginCss = STYLE_TAG_ID;
				styleTag.textContent =
					'.' +
					DIALOG_CLASS +
					'{' +
					DIALOG_CSS_TEXT +
					'}' +
					'.' +
					DIALOG_CLASS +
					' [role="tablist"]{flex:none;}' +
					// ⚠️ 矮视口下收紧头部的规则**不写在这里**，直接写进
					// `CSS.header` / `CSS.footerBar` 的 `clamp()` 里。
					//
					// 原来这里是一条 `@media (max-height:480px){ ... > div > div:first-child ... }`，
					// 靠后代选择器定位 header。而 `editorScope` 从 `display:contents`
					// 改成真 flex 容器后，层级一变，这条选择器就**静默匹配不到**
					//（真机实测横屏 header 仍是 138px，媒体查询完全没生效）。
					// `clamp()` 挂在组件自己的 style 上，层级怎么变都不会失配。
					'.' +
					DIALOG_CLASS +
					' button:hover{background:var(--dsw-alias-interactive-bg-hover);}';

				// head 可能还不存在（脚本在 <head> 里跑），退到 documentElement。
				var styleParent =
					document.head ||
					document.documentElement ||
					document.body ||
					null;
				if (styleParent !== null && typeof styleParent.appendChild === 'function') {
					styleParent.appendChild(styleTag);
				}
			}
		} catch (styleError) {
			// 样式失败绝不影响功能，更不允许拖垮整批插件加载。
			try {
				console.warn('[dsh-jiuling-remote-mobile] 样式注入失败（已忽略）:', styleError);
			} catch (ignored) {
				/* 连 console 都没有也不能炸 */
			}
		}

		/**
		 * 电脑目录的**访问缓存**：`电脑路径 → listing`（模块级，跨对话框开关存活）。
		 *
		 * ## 为什么必须有（用户报障原文）
		 *
		 * 「为什么我点击添加工作区的时候，每次点击电脑都要重新加载一遍目录，
		 * 这就算了，我加载好之后，随便点击一个文件夹，文件夹里面的内容还要重新加载
		 * 一遍」—— 同一个电脑目录，每次进「电脑」页签、每次点进同一个文件夹，
		 * 都要重走一趟「手机 → Cloudflare 隧道 → 电脑」，一个来回 1～3 秒。
		 * 用户要的是「加载一次，后续直接从本地读」。
		 *
		 * ## 为什么放模块级而不是组件内 ref
		 *
		 * 对话框每次打开都是**新挂载的组件**，组件内的 ref 一关就没了 —— 那样
		 * 「关掉再打开又转一遍圈」，正是用户抱怨的第一个现象。放模块级则一次加载
		 * 整条会话内都命中。
		 *
		 * ⚠️ 键是**电脑路径**原样（`C:\Users\...`），`''` 表示根目录 —— 与
		 * `bridge('listDesktop')` 的入参完全一致，不做任何改写。
		 *
		 * ⚠️ **失效只有两条路**：用户点「刷新」（见 `refreshAll`），
		 * 或者那一次加载失败（见下面的 catch）。不做 TTL 轮询 —— 用户明确要的是
		 * 「加载一次就直接从本地读」。
		 */
		var desktopDirCache = {};

		/** 清掉访问缓存（配对 / 解绑 / 切页签时调用，避免跨电脑串味）。 */
		function clearDesktopDirCache() {
			desktopDirCache = {};
		}

		/**
		 * 哪些会话是「跑在电脑上的」—— 宿主 `remoteSessions` 的本地镜像。
		 *
		 * ## 为什么需要（用户需求原文）
		 *
		 * 「用户如果当前选择的是 **app 本地文件夹**，那么**就不要出现电脑的模型**，
		 * 以这个文件夹为隔离条件，**互不干预**」。
		 *
		 * 宿主把电脑的模型目录与手机本地那份**并**在一起交给前端（原因见宿主
		 * `mergeCatalog` 的注释：官方 `modelCatalog` 是全局唯一一份、不带 sessionId）。
		 * 所以要按工作区隔离，只能在**前端按会话**再筛一次 —— 而筛之前必须先知道
		 * 「这个会话是不是电脑的」。
		 *
		 * ⚠️ **判据必须与宿主 `prompt` 拦截同源**（宿主读的也是 `remoteSessions`）。
		 * 用 cwd 猜镜像目录是另一套判据，一旦两者不一致，就会出现「菜单里显示的是
		 * 电脑模型、消息却发到手机本地」这种最坏情况。
		 *
		 * ⚠️ **不能每次渲染打一次桥**：模型菜单每帧都读目录快照，那是同步 API。
		 * 所以 `apply` 时拉一次全量，之后建会话 / 解绑时自己增量维护，
		 * `getSnapshot` 纯查内存（见宿主 `case 'remoteSessions'` 的注释）。
		 */
		var remoteSessionIds = {};

		/**
		 * 电脑镜像工作区的 slug 集合 —— 隔离的**真正判据**。
		 *
		 * ⚠️⚠️ **为什么不用 `remoteSessionIds`（那是第一代，已被用户报障推翻）。**
		 *
		 * 第一代按 **sessionId** 判定，只在「用户从电脑文件夹对话框里建会话」
		 * 或「宿主拦截器绑过」时才知道。而用户在**侧边栏点「新建会话」**时，
		 * 官方前端直接 `sessionController.create({workspaceId})`，**不经过本插件**；
		 * 宿主的 create 拦截器认得出镜像目录（消息发得对），但前端不知道
		 * ⇒ 模型菜单仍按「本地」筛，显示手机模型。
		 *
		 * 用户原话：「只有我手动添加工作区的时候，才会触发模型和预设的刷新」——
		 * 说的就是判据挂在了「走了哪条路」上，而不是「会话的工作区在哪」。
		 *
		 * 正解：**按 cwd 判定**，与宿主 `desktopPathOfMirror` 同一个轴。
		 * 前端从 `sessions.list` 里同步读到会话的 `cwd`，看它是不是
		 * `…/workspaces/<slug>` 且 slug 属于电脑镜像。这条路与「谁建的会话」
		 * 完全无关，所以**任何入口进来都一致，不需要任何刷新触发**。
		 */
		var mirrorSlugs = {};

		/**
		 * 「用户刚刚在新建对话界面选中的那个工作区」的 cwd —— 只在**会话行还没带上
		 * cwd** 的那一小段时间里当兜底判据用。
		 *
		 * ⚠️⚠️ **为什么需要它（用户报障，2026-10-17 真机复现）**：
		 *
		 * 在**新建对话界面**（还没有任何消息）切到电脑工作区时，`sessions.list`
		 * 里那一行**还没有 cwd**（会话刚物化，宿主没回填），于是
		 * `isRemoteSession()` 只能退回 `remoteSessionIds[sessionId]` —— 而新建的
		 * 本地壳会话**不在里面**，结论是「本地」。后果：
		 *
		 * - 模型菜单只显示手机的模型（电脑的组被 `pickWorkspaceGroups` 筛掉）；
		 * - 预设列表同理，仍是手机那份。
		 *
		 * 用户原话：「我在待选的工作区里面选择了默认工作区，也就是我手机的工作区，
		 * 这个预设它没有改回来，模型列表也没有改回来」——反过来切到电脑时也一样。
		 *
		 * 兜底只影响**这一小段窗口**：一旦列表行带回 cwd，`cwdOf()` 优先，这个值
		 * 自动失效（见 `isRemoteSession` 的判据顺序），不会长期歪掉。
		 */
		var pendingWorkspaceCwd = null;

		/**
		 * `pendingWorkspaceCwd` 的**过期时刻**（毫秒时间戳）。
		 *
		 * ⚠️ 为什么必须有这个：官方工作区下拉菜单走的是
		 * `workspaceNavigation.openWorkspace()`（`ConversationContent` 的
		 * `selectWorkspace`），**完全不经过本插件** —— 所以「用户切回默认工作区」
		 * 这个动作我这边收不到通知，没法在那个时刻清掉 `pendingWorkspaceCwd`。
		 *
		 * 不设过期的话，一旦某次在电脑工作区设过它、而之后那个会话行的 cwd
		 * 又一直读不到，兜底值就会**永久**把「本地会话」判成电脑会话，用户看到
		 * 的正是「切回默认工作区，模型和预设都没改回来」。
		 *
		 * 取 30 秒：足够覆盖「建会话 → 列表行回填 cwd」这一段（真机是几百毫秒），
		 * 又不至于让一个陈旧值活太久。
		 */
		var pendingWorkspaceExpiresAt = 0;

		/** `pendingWorkspaceCwd` 的有效期（毫秒）。 */
		var PENDING_WORKSPACE_TTL = 30000;

		/**
		 * 记下「刚选中的工作区」并开始计时。
		 *
		 * @param cwd - 工作区路径；传 `null`/空串表示**立刻作废**。
		 */
		function setPendingWorkspace(cwd) {
			if (typeof cwd !== 'string' || cwd === '') {
				pendingWorkspaceCwd = null;
				pendingWorkspaceExpiresAt = 0;
				return;
			}
			pendingWorkspaceCwd = cwd;
			pendingWorkspaceExpiresAt = Date.now() + PENDING_WORKSPACE_TTL;
		}

		/**
		 * 取当前有效的兜底 cwd（过期就当没有）。
		 *
		 * @returns 有效的 cwd 或 `null`。
		 */
		function currentPendingWorkspace() {
			if (pendingWorkspaceCwd === null) return null;
			if (Date.now() > pendingWorkspaceExpiresAt) {
				pendingWorkspaceCwd = null;
				pendingWorkspaceExpiresAt = 0;
				return null;
			}
			return pendingWorkspaceCwd;
		}

		/**
		 * 从 cwd 取出镜像工作区的 slug（与宿主 `desktopPathOfMirror` 同构）。
		 *
		 * ⚠️ 用 `/workspaces/` 定位而不是前缀比对：`workspace.path` 是 realpath，
		 * 真机上 `/data/user/0` 与 `/data/data` 会差一层，前缀一比就永远不命中
		 * （宿主那边踩过这个坑，注释见 `desktopPathOfMirror`）。
		 * 两种分隔符都认：手机是 posix，但在 Windows 上调试时是 `\`。
		 *
		 * @param cwd - 会话的 cwd。
		 * @returns 镜像工作区的 slug；不是镜像目录时 `undefined`。
		 */
		function mirrorSlugOf(cwd) {
			if (typeof cwd !== 'string' || cwd === '') return undefined;
			var at = cwd.search(/[\\/]workspaces[\\/]/);
			if (at < 0) return undefined;
			var slug = cwd.slice(at).split(/[\\/]/)[2];
			return slug === undefined || slug === '' ? undefined : slug;
		}

		/**
		 * 这个会话是不是跑在电脑上 —— **同步**判定，任何入口都用同一条。
		 *
		 * ⚠️ **cwd 读得到时，它以 cwd 为唯一判据**（不看 `remoteSessionIds`）：
		 * 工作区就是隔离条件本身。解绑后 `mirrorSlugs` 清空 ⇒ 全部回到本地，
		 * 不需要再去清每个会话的旧标记。
		 *
		 * 只有列表行还没带 cwd 的那一两帧（会话刚建好）才退回
		 * `pendingWorkspaceCwd` / `remoteSessionIds`。
		 *
		 * ⚠️ **判据顺序不能换**：
		 * 1. `cwdOf(sessionId)` —— 会话自己的 cwd，最准；
		 * 2. `pendingWorkspaceCwd` —— 用户在新建界面刚选的工作区（见它的注释，
		 *    这是修「新建界面模型/预设不跟随工作区」的那一条）；
		 * 3. `remoteSessionIds` —— 宿主显式标记过的会话。
		 *
		 * 第 2 条只在第 1 条读不到时才生效，所以一旦会话行带回 cwd，
		 * 它就自动让位，不会跟真实 cwd 打架。
		 *
		 * @param sessionId - 会话 id。
		 * @param cwdOf - `sessionId → cwd` 的同步读取函数。
		 * @returns 是不是电脑工作区的会话。
		 */
		function isRemoteSession(sessionId, cwdOf) {
			var cwd = cwdOf === undefined ? undefined : cwdOf(sessionId);
			if (typeof cwd === 'string' && cwd !== '') {
				var slug = mirrorSlugOf(cwd);
				return slug !== undefined && mirrorSlugs[slug] === true;
			}
			// 会话自己的 cwd 还没进列表行 —— 用「刚选中的工作区」兜底（会过期）。
			var pending = currentPendingWorkspace();
			if (pending !== null) {
				var pendingSlug = mirrorSlugOf(pending);
				return pendingSlug !== undefined && mirrorSlugs[pendingSlug] === true;
			}
			return remoteSessionIds[sessionId] === true;
		}

		/** 从宿主拉一次全量远程会话清单（失败就按「全是本地」处理）。 */
		function loadRemoteSessionIds() {
			return bridge('remoteSessions', {}).then(
				function (result) {
					var ids = result && result.ids;
					if (!Array.isArray(ids)) return;
					var next = {};
					for (var at = 0; at < ids.length; at += 1) next[ids[at]] = true;
					remoteSessionIds = next;
				},
				function () {
					/* 拉不到就保持原样：最坏是本地工作区多看到电脑模型，不会误发 */
				},
			);
		}

		/**
		 * 从宿主拉一次「电脑镜像工作区的 slug 集合」（隔离的真正判据）。
		 *
		 * 拉不到就保持原样（空集合 = 全部按本地处理）：最坏是本地工作区多看到
		 * 电脑模型，**不会误发** —— 消息该发给谁由宿主 `prompt` 拦截器按
		 * `remoteSessions` 决定，与这里无关。
		 */
		function loadMirrorSlugs() {
			return bridge('mirrorSlugs', {}).then(
				function (result) {
					var slugs = result && result.slugs;
					if (!Array.isArray(slugs)) return;
					var next = {};
					for (var at = 0; at < slugs.length; at += 1) next[slugs[at]] = true;
					mirrorSlugs = next;
				},
				function () {
					/* 同上：最坏是多显示几项，不会误发 */
				},
			);
		}

		/**
		 * 按「这个会话是不是电脑的」筛出该显示的组与失败项。
		 *
		 * ## 双向隔离
		 *
		 * - **本地工作区**：只留手机自己的组，并把被电脑同 id provider 覆盖掉的那组
		 *   **还原**回来（`localGroups`，宿主 `mergeCatalog` 额外带上的）。
		 * - **电脑工作区**：只留电脑的组。这不是「顺手加活」—— 电脑会话的 prompt 会
		 *   转发到电脑，选一个手机本地才有的模型（比如 `agnes-3.0-flash`）发过去，
		 *   电脑上根本不存在，必然报错。用户说的「互不干预」正是这个意思。
		 *
		 * ⚠️ 没配对时目录里根本没有 `desktop` 标记，两个分支都会原样返回。
		 *
		 * ⚠️ **`extraLocal` 是必需的**：官方的 `syncInputs` 往 `directory.store`
		 * 里只拷了 `groups` / `failures`（见
		 * `dsh-client-ui-model-selection/lib/client.js:325`），**`localGroups` 不在
		 * 那一层**。所以筛 `directory.store` 时得由调用方把 `localGroups`
		 * 从 catalog 原值里递进来，否则本地工作区永远还原不出被覆盖的那组。
		 *
		 * @param value - 目录值（`{groups, failures, localGroups?, localFailures?}`）。
		 * @param isRemote - 这个会话是不是跑在电脑上。
		 * @param extraLocal - 备用本地组（`value.localGroups` 缺失时用）。
		 * @returns `{groups, failures}`（`value` 不合法时原样返回空数组）。
		 */
		function pickWorkspaceGroups(value, isRemote, extraLocal) {
			if (!value || !Array.isArray(value.groups)) {
				return { groups: [], failures: [] };
			}
			const groups = value.groups;
			const failures = Array.isArray(value.failures) ? value.failures : [];
			if (isRemote === true) {
				return {
					groups: groups.filter(function (group) { return group.desktop === true; }),
					failures: failures.filter(function (failure) { return failure.desktop === true; }),
				};
			}
			const kept = groups.filter(function (group) { return group.desktop !== true; });
			// 还原被电脑同 id 覆盖掉的本地组（见宿主 `mergeCatalog`）。
			const local = Array.isArray(value.localGroups)
				? value.localGroups
				: (Array.isArray(extraLocal) ? extraLocal : []);
			if (local.length > 0) {
				const have = {};
				for (let at = 0; at < kept.length; at += 1) have[kept[at].id] = true;
				for (let lt = 0; lt < local.length; lt += 1) {
					if (have[local[lt].id] !== true) kept.push(local[lt]);
				}
			}
			return {
				groups: kept,
				failures: failures.filter(function (failure) { return failure.desktop !== true; }),
			};
		}

		/**
		 * 按工作区筛**预设名单**（与 `pickWorkspaceGroups` 同构）。
		 *
		 * 用户报障：「模型列表能够快速切换回来了，但是预设列表没有切换」——
		 * 模型能切是因为它走了 `pickWorkspaceGroups`，预设没切是因为宿主
		 * `mergePresets` 只是把两份并起来、前端没人再筛一次。
		 *
		 * 判据与模型**完全同一条**（`isRemoteSession`）：会话在电脑工作区 ⇒ 只留
		 * 电脑那几条；否则只留本地那几条，并把被同 id 覆盖掉的本地项还原回来。
		 *
		 * ⚠️ **一条都不剩时原样返回**：电脑那边预设全坏了、或者宿主还没把
		 * `desktop` 标记打上（老版本宿主）时，宁可多显示几条，也别把菜单变成空的
		 * —— 空菜单用户连「默认」都选不回来。
		 *
		 * @param value - `{presets, localPresets?}`（宿主 `mergePresets` 的产物）。
		 * @param isRemote - 这个会话是不是跑在电脑上。
		 * @returns 筛过的 `{presets}`（`value` 不合法时原样返回）。
		 */
		function pickWorkspacePresets(value, isRemote) {
			if (!value || !Array.isArray(value.presets)) return value;
			const all = value.presets;
			// ⚠️ 宿主没打标记（老版本宿主 / 还没合并过）⇒ 无从判断，原样返回。
			let tagged = false;
			for (let at = 0; at < all.length; at += 1) {
				if (all[at] && all[at].desktop === true) { tagged = true; break; }
			}
			if (!tagged) return value;
			if (isRemote === true) {
				const desktopOnly = all.filter(function (preset) { return preset.desktop === true; });
				if (desktopOnly.length === 0) return value;
				return Object.assign({}, value, { presets: desktopOnly });
			}
			const kept = all.filter(function (preset) { return preset.desktop !== true; });
			// 还原被电脑同 id 覆盖掉的本地预设（见宿主 `mergePresets`）。
			const local = Array.isArray(value.localPresets) ? value.localPresets : [];
			if (local.length > 0) {
				const have = {};
				for (let kt = 0; kt < kept.length; kt += 1) have[kept[kt].id] = true;
				for (let lt = 0; lt < local.length; lt += 1) {
					if (have[local[lt].id] !== true) kept.push(local[lt]);
				}
			}
			if (kept.length === 0) return value;
			return Object.assign({}, value, { presets: kept });
		}

		/**
		 * 从共享的 catalog 原值里取「手机本地的组」（宿主 `mergeCatalog` 带的）。
		 *
		 * @param directory - 官方的 `ModelDirectory`（含 `.catalog`）。
		 * @returns 本地组数组；拿不到就空数组。
		 */
		function localGroupsOf(directory) {
			try {
				// ⚠️ 不用可选链：本文件受 chrome73 语法约束（见文件头）。
				if (!directory || !directory.catalog || !directory.catalog.store) return [];
				const store = directory.catalog.store;
				if (typeof store.getSnapshot !== 'function') return [];
				const value = store.getSnapshot().value;
				return value && Array.isArray(value.localGroups) ? value.localGroups : [];
			} catch (error) {
				return [];
			}
		}

		/** 某个 `provider/model` 在给定的组里存不存在。 */
		function isSelectable(groups, selection) {			if (!selection) return false;
			for (let at = 0; at < groups.length; at += 1) {
				if (groups[at].id !== selection.provider) continue;
				const models = Array.isArray(groups[at].models) ? groups[at].models : [];
				for (let mt = 0; mt < models.length; mt += 1) {
					if (models[mt].id === selection.model) return true;
				}
			}
			return false;
		}

		/**
		 * 在给定的组里挑一个**真实可用**的模型选择。
		 *
		 * 用途见 `scopeDirectoryToWorkspace` 里那段 ⚠️⚠️ 注释：`current` 被清空后
		 * 必须立刻回填，否则官方会把它读成「正在加载模型…」并永久卡住。
		 *
		 * 优先级：
		 * 1. `preferred`（通常传 `snapshot.default`）—— 官方自己就用它当兜底，
		 *    跟着它走语义最一致；
		 * 2. 否则第一个组的第一模型。
		 *
		 * @param groups - 筛过的组数组。
		 * @param preferred - 优先尝试的选择（可能已被筛掉）。
		 * @returns `{provider, model}`；一组都没有时 `null`。
		 */
		function pickFallbackSelection(groups, preferred) {
			if (!Array.isArray(groups) || groups.length === 0) return null;
			if (isSelectable(groups, preferred)) {
				return { provider: preferred.provider, model: preferred.model };
			}
			for (let at = 0; at < groups.length; at += 1) {
				const models = Array.isArray(groups[at].models) ? groups[at].models : [];
				if (models.length === 0) continue;
				// `provider` 取组 id（官方 `isSelectable` 就是按组 id 比的）。
				return { provider: groups[at].id, model: models[0].id };
			}
			return null;
		}

		/**
		 * 筛**目录值**（`catalog.store` 里 `{value}` 那一份）。
		 *
		 * ⚠️ **`default` 必须跟着换**：官方的 `syncInputs` 用
		 * `projected.next ?? catalog.value.default` 定 `current`，如果 `default`
		 * 指向一个已被筛掉的 provider，界面就会显示一个不在列表里的模型名。
		 * 所以筛完若 `default` 不在剩下的组里，就退到第一个组的第一个模型。
		 *
		 * ⚠️ **一组都没剩时原样返回**（例如电脑那边所有 provider 都挂了）：
		 * 宁可多显示几个，也别把菜单变成空的 —— 空菜单用户连「刷新」都点不到。
		 *
		 * @param value - 目录值。
		 * @param isRemote - 这个会话是不是跑在电脑上。
		 * @returns 筛过的目录值。
		 */
		function filterCatalogValue(value, isRemote) {
			if (!value || !Array.isArray(value.groups)) return value;
			const picked = pickWorkspaceGroups(value, isRemote);
			if (picked.groups.length === 0) return value;
			const next = Object.assign({}, value, {
				groups: picked.groups,
				failures: picked.failures,
			});
			// ## ⚠️ 本地工作区要**把 default 还原成手机自己的**
			//
			// 宿主 `mergeCatalog` 现在优先用**电脑的** `default`（那是修 1017 标签
			// 的关键，见那边的注释）。但本地工作区的模型列表只有手机那几组，
			// 电脑的 default 很可能不在里面 ⇒ 官方 `syncInputs` 算出的 `current`
			// 会指向一个列表里不存在的模型。
			//
			// 所以这里按同一个工作区判据分流：远程会话用合并后的（电脑的）
			// default，本地会话还原成 `localDefault`。
			if (isRemote !== true) {
				const localDefault = value.localDefault;
				if (localDefault !== undefined && localDefault !== null
					&& isSelectable(picked.groups, localDefault)) {
					next.default = { provider: localDefault.provider, model: localDefault.model };
				}
			}
			if (!isSelectable(picked.groups, next.default)) {
				const first = picked.groups[0];
				const firstModel = Array.isArray(first.models) ? first.models[0] : undefined;
				if (firstModel !== undefined) next.default = { provider: first.id, model: firstModel.id };
			}
			return next;
		}

		/**
		 * 给官方那个**每会话共享**的 `ModelDirectory` 套一层「按工作区筛」的读路径。
		 *
		 * ## 为什么包装 `directoryFor` 而不是改前端 bundle
		 *
		 * `conversation.input.model` 这个 slot 的 `inject(sessionId)` 会调
		 * `modelDirectories.directoryFor(sessionId)`（见
		 * `dsh-client-ui-model-selection/lib/client.js:1189`），菜单和 `/model`
		 * 命令都从它拿数据。`directoryFor` 是**服务实例上的普通方法**，包它
		 * 就等于包住了这两个入口 —— 不用碰前端内部类，升级也不会碎。
		 *
		 * ## 为什么两层的 store 都要包
		 *
		 * 官方有两级快照，形状**不一样**，两个都要筛：
		 *
		 * | 来源 | 形状 | 谁读它 |
		 * |---|---|---|
		 * | `catalog.store` | `{value:{groups,default,…}, status}` | `syncInputs()` 算 `current`/`routable` |
		 * | `directory.store` | `{groups, failures, current, status, …}` | `ModelSelect` 直接渲染 |
		 *
		 * 只筛 `directory.store` 的话，`syncInputs` 仍会用**没筛过**的 `default`
		 * 把 `current` 算成被筛掉的那个模型 —— 菜单里没有它、触发按钮却显示它，
		 * 而且 `routable` 会被算成 `false`，官方界面会提示「该 provider 的目录加载失败」。
		 *
		 * ## 为什么要「稳定」而不是每次新建
		 *
		 * `inject` 每渲染一帧都调一次 `directoryFor`，返回值里的 `store` 直接喂给
		 * `useSyncExternalStore` 的 `subscribe`。每次返回新对象会让 React 每帧
		 * 重订阅。所以包装缓存在原 `directory.__dshRemoteScoped` 上，生命周期跟着
		 * 官方的会话 scope 一起走 —— 官方在 scope dispose 时删掉原实例，
		 * 包装随之被 GC，不会累积。
		 *
		 * ⚠️ 用 `Object.create(原型) + Object.assign` 而不是 `{...directory}`：
		 * `ModelDirectory` 的方法（`select` / `reasoningFor` / `syncInputs`）
		 * 在**原型**上，展开运算符只复制自有属性、会把方法全丢掉 —— 症状是
		 * 「点模型没反应」。
		 *
		 * ⚠️ `select` 走原型链、以 `this = wrapper` 调用，于是它读到的
		 * `this.store.getSnapshot()` 是**筛过**的（`current` 正确），写回
		 * `this.store.update()` 仍转发给原 store。读写都落在正确的那一层。
		 *
		 * @param directory - 官方的 `ModelDirectory` 实例。
		 * @param sessionId - 它归属的会话。
		 * @param cwdOf - `sessionId → cwd` 的**同步**读取函数（隔离判据要用它）。
		 * @returns 读路径被筛过的同构对象。
		 */
		function scopeDirectoryToWorkspace(directory, sessionId, cwdOf) {
			if (!directory || !directory.store || typeof directory.store.getSnapshot !== 'function') {
				return directory;
			}
			// ⚠️ 判据是**每次读时现算**的（不是建包装时算一次）：会话的 cwd 可能
			// 在列表行到达后才出现，而且解绑/换工作区都会改结论。
			// `isRemoteSession` 见其注释 —— 它看的 cwd，跟宿主 `desktopPathOfMirror` 同一个轴。
			const isRemote = function () { return isRemoteSession(sessionId, cwdOf); };
			const wrapper = Object.create(Object.getPrototypeOf(directory));
			Object.assign(wrapper, directory);

			/**
			 * 包一层 store：读时筛，通知与写回照旧转发。
			 *
			 * ⚠️⚠️ **`getSnapshot()` 必须身份稳定**，否则 React 直接炸。这条是
			 * 1.0.19 第二次真机启动实测到的（第一次是上面的 `remote.session`）：
			 *
			 *     [web] slot entry crashed in 'conversation.input.model':
			 *           Error: Minified React error #185
			 *
			 * #185 就是「Maximum update depth exceeded」（无限重渲染）。原因：
			 * 官方把这个 store 的 `getSnapshot` 直接喂给 `useSyncExternalStore`，
			 * 而 React 在渲染期用 **`Object.is`** 比较前后两次快照，不同就再渲染一次。
			 * 而 `pickWorkspaceGroups` 每次都 `filter` 出新数组、外面又 `Object.assign`
			 * 出新对象 —— **同一个源快照也每次返回新对象** ⇒ 每一帧都"变了" ⇒ 死循环。
			 *
			 * 所以按「源快照身份 + 影响筛选结果的外部开关」缓存上一次的投影结果。
			 */
			const wrapStore = function (store, project, volatileToken) {
				let cachedSource;
				let cachedToken;
				let cachedProjected;
				return {
					getSnapshot: function () {
						const source = store.getSnapshot();
						const token = volatileToken === undefined ? '' : volatileToken();
						// 源快照换了、或开关变了才重算；否则复用同一个对象（身份稳定）。
						if (source === cachedSource && token === cachedToken) return cachedProjected;
						cachedSource = source;
						cachedToken = token;
						cachedProjected = project(source);
						return cachedProjected;
					},
					subscribe: function (fn) { return store.subscribe(fn); },
					update: function (mutator) { return store.update(mutator); },
					set: function (value) { return store.set(value); },
				};
			};

			const store = directory.store;
			wrapper.store = wrapStore(store, function (snapshot) {
				// ⚠️ `directory.store` 那一层没有 `localGroups`（官方 `syncInputs`
				// 只拷了 groups/failures），所以从 catalog 的原值里现取一份递进去。
				const picked = pickWorkspaceGroups(snapshot, isRemote(), localGroupsOf(directory));
				if (picked.groups.length === 0) return snapshot;
				const next = Object.assign({}, snapshot, picked);
				// `current` 指向被筛掉的模型时换一个**可用**的，不能留 null。
				//
				// ## ⚠️⚠️ 这里原来是 `next.current = null`，那是个 bug（用户报障）
				//
				// 用户原话：
				//   「我输入框右下角，它一直显示正在加载模型，但是我点击它展开是可以
				//    看到模型列表的，然后我也是可以正常发送消息的，但是它一直显示
				//    正在加载模型。」
				//
				// 触发按钮的文案由官方
				// `dsh-client-ui-model-selection/lib/client.js:773-774` 算：
				//
				//     const waiting = state.current === null && state.status === "loading";
				//     const modelLabel = waiting ? t("trigger.loading") : …
				//
				// 也就是说 **`current === null` 会被官方读成「还没加载完」**。
				// 而 `current` 这个字段是官方 `syncInputs()` 算的，它**只在
				// 输入变化时算一次**；我们把快照里的 `current` 清成 null 之后，
				// 没有任何人再把它算回来 ⇒ 按钮永久卡在「正在加载模型…」，
				// 尽管 `groups` 是好的（所以点开菜单能看到完整列表）、
				// `status` 也是 `loaded`（所以能正常发消息）——
				// 这三个现象同时出现，正是这个 bug 的指纹。
				//
				// 正确做法：清空之后**立刻回填**一个列表里真实存在的选择
				//（`snapshot.default` 优先，其次第一个组的第一个模型）。
				// 这样按钮显示的是真实模型名，语义上也和「当前实际会用哪个模型」
				// 一致 —— 官方发消息时本来就会退回默认模型。
				if (!isSelectable(picked.groups, next.current)) {
					next.current = null;
					const fallback = pickFallbackSelection(picked.groups, snapshot.default);
					if (fallback !== null) next.current = fallback;
				}
				return next;
			// ⚠️ 缓存键必须带上「这个会话算不算远程」：同一个源快照在「切成远程会话」
			// 前后要投影出**不同**结果，只看源快照身份会永远返回旧的那一份。
			}, function () { return isRemote() === true ? 'remote:1' : 'remote:0'; });

			// `load()` 返回的就是快照，`/model` 命令直接拿它渲染，所以也要筛。
			wrapper.load = function () {
				return Promise.resolve(directory.load()).then(function () {
					return wrapper.store.getSnapshot();
				});
			};

			const catalog = directory.catalog;
			if (catalog && catalog.store && typeof catalog.store.getSnapshot === 'function') {
				const catalogStore = catalog.store;
				const catalogWrapper = Object.create(Object.getPrototypeOf(catalog));
				Object.assign(catalogWrapper, catalog);
				catalogWrapper.store = wrapStore(catalogStore, function (snapshot) {
					return Object.assign({}, snapshot, {
						value: filterCatalogValue(snapshot.value, isRemote()),
					});
				}, function () { return isRemote() === true ? 'remote:1' : 'remote:0'; });
				wrapper.catalog = catalogWrapper;
			}
			return wrapper;
		}

		/**
		 * 把「按工作区筛模型目录」接到官方服务上。
		 *
		 * `ctx.get` 拿不到服务就静默跳过（最坏是回到「两个工作区看到同一份列表」的
		 * 旧行为，不会报错）。返回一个撤销函数。
		 *
		 * @param ctx - client 根上下文。
		 * @param cwdOf - `sessionId → cwd` 的**同步**读取函数（隔离判据要用它）。
		 * @returns 撤销函数。
		 */
		function patchModelDirectories(ctx, cwdOf) {
			var models = ctx.get === undefined ? undefined : ctx.get('modelDirectories');
			if (!models || typeof models.directoryFor !== 'function') return function () {};

			// ⚠️⚠️ **必须在「原始实例」上覆盖，不能在 `ctx.get()` 拿到的那个对象上覆盖。**
			//
			// `modelDirectories` 是 cordis 的 Service，`ctx.get()` 返回的是
			// `createTraceable()` 造出来的 **Proxy**（见 cordis `lib/index.js` 的
			// `getTraceable`/`createTraceable`）。那个 Proxy 的 `get` 会把方法包成
			// `createShadowMethod(ctx, fn, receiver, shadow)`，其 apply 里有一句：
			//
			//     if (thisArg === outer) thisArg = shadow;
			//
			// `outer` 就是取方法时的那个 receiver，而 `shadow` 是
			// `withProp(receiver, property, ctx.extend({[shadow]: origin}))` ——
			// 这个 `ctx` 是**谁调 `ctx.get()` 就用谁的上下文**。
			//
			// 于是 `models.directoryFor.bind(models)` 把 this 钉在了 Proxy 上，
			// 每次调用都命中 `thisArg === outer` ⇒ this 被换成**我的插件上下文**
			// 扩展出来的 shadow。而官方 `ModelDirectoryResolver.directoryFor` 内部要读
			// `this.ctx.remote.session`（`dsh-client-ui-model-selection/lib/client.js:388`），
			// 我的插件没有 inject 过 `remote.session` ⇒ 抛
			//
			//     cannot get property "remote.session" without inject
			//
			// 真机症状：`conversation.input.model` 这个 slot 整体 crash，
			// **输入框上的模型按钮直接消失**。1.0.19 首次真机启动实测到的。
			//
			// 正解是用 `Symbol.for('cordis.original')` 取出 Proxy 背后的原始实例
			// （`createTraceable` 的 get trap 里第一条就是 `if (prop === symbols.original) return target`），
			// 在**它**身上覆盖。这样 `this.ctx` 始终是 `ModelDirectoryResolver`
			// 构造时 `super(ctx, …)` 存下的那个 ctx，服务解析照旧。
			var ORIGINAL = Symbol.for('cordis.original');
			var raw = models[ORIGINAL] === undefined ? models : models[ORIGINAL];
			if (!raw || typeof raw.directoryFor !== 'function') return function () {};

			var hadOwn = Object.prototype.hasOwnProperty.call(raw, 'directoryFor');
			var previous = raw.directoryFor;
			var call = previous.bind(raw);
			raw.directoryFor = function (sessionId) {
				var directory = call(sessionId);
				if (directory.__dshRemoteScoped !== undefined) return directory.__dshRemoteScoped;
				var scoped = scopeDirectoryToWorkspace(directory, sessionId, cwdOf);
				try {
					directory.__dshRemoteScoped = scoped;
				} catch (error) {
					/* 冻结就退回「每次新建」，功能不受影响 */
				}
				return scoped;
			};
			return function () {
				if (hadOwn) raw.directoryFor = previous;
				else delete raw.directoryFor;
			};
		}

		/**
		 * 把「按工作区筛预设名单」接到官方 RPC 上。
		 *
		 * ⚠️⚠️ **为什么必须在前端拦，而不能像模型那样只靠宿主。**
		 *
		 * 官方的预设名单来自 `readRoster(ctx)` → `ctx.remote.agentPresets.list()`
		 * （`dsh-client-ui-agent-preset/lib/client.js:1081`），落到宿主就是
		 * `remoteExportList()` —— 这个方法**一个参数都不收**
		 * （`dsh-agent-preset-registry/lib/index.js:592`），宿主侧**拿不到会话**，
		 * 所以「远程会话看电脑的、本地会话看手机的」在宿主侧表达不出来。
		 *
		 * 宿主那边（`mergePresets`）只能把两份并起来并打 `desktop: true` 标记，
		 * 与模型目录的 `mergeCatalog` 完全同构。**筛这一步必须在能看到会话的地方做。**
		 *
		 * 还有一条更硬的理由：`seat.load()` 只在 `settings/document-updated` 与
		 * `connection/reset` 时重跑（`dsh-client-ui-agent-preset/lib/client.js:1595`），
		 * **切工作区根本不会重新请求 roster** —— 所以就算宿主按会话筛好了，
		 * 前端缓存里那份旧的也不会变。只能在**读结果**的地方筛。
		 *
		 * @param ctx - client 根上下文。
		 * @param cwdOf - `sessionId → cwd` 的同步读取函数。
		 * @returns 撤销函数。
		 */
		function patchAgentPresets(ctx, cwdOf) {
			// 诊断出口①：**进入函数就记一笔**。1.0.33 的诊断只写在 `list()` 里，
			// 结果真机读到 `window.__dshRemoteDiag === null` —— 只能证明「list 没被
			// 调用过」，分不清是「patch 没进来」还是「进来了但官方没调」。这一笔
			// 把两种情形分开。
			var probe = { stage: 'enter' };
			try {
				window.__dshRemoteProbe = probe;
			} catch (probeError) {
				/* 诊断失败绝不影响主流程 */
			}

			var remote = ctx.remote;
			probe.hasRemote = remote !== undefined && remote !== null;
			if (remote === undefined || remote === null) return function () {};
			var presets = remote.agentPresets;
			probe.hasPresets = presets !== undefined && presets !== null;
			if (presets === undefined || presets === null) return function () {};
			probe.listType = typeof presets.list;
			if (typeof presets.list !== 'function') return function () {};

			// ⚠️⚠️ **必须在「原始实例」上覆盖 `list`，不能在 `ctx.remote.agentPresets`
			// 拿到的那个对象上覆盖 —— 这是 1.0.25 / 1.0.26 / 1.0.27 三次真机都
			// 「改了却完全没效果」的根因。**
			//
			// 与 `patchModelDirectories` 同一个陷阱（见那里的长注释）：cordis 的
			// `ctx.remote` 是 `createTraceable()` 造出来的 **Proxy**，它的 `get` trap
			// 会把方法包成 `createShadowMethod(...)`，并把对象属性也裹一层。
			// 往 Proxy 上赋一个新属性，写进的是 Proxy 的 shadow 层，
			// **官方 `readRoster` 读的是它自己那份 `ctx.remote.agentPresets.list`** ——
			// 两者不是同一个函数位，所以我那次赋值官方永远看不到。
			//
			// 真机症状（用户三次反馈）：
			//   1.0.25「模型列表能够快速切换回来了，但是预设列表没有切换」
			//   1.0.26/1.0.27「不管是应用的私有默认工作区，还是我自己选择的
			//   手机目录工作区，都无法自动切换回手机的预设列表」
			// —— 注意「模型能切、预设不能切」，正是因为模型走
			// `patchModelDirectories`（**正确解包了**），而预设没有。
			//
			// 正解：用 `Symbol.for('cordis.original')` 取出 Proxy 背后的原始实例
			// （`createTraceable` 的 get trap 第一条就是 `if (prop === symbols.original) return target`），
			// 在**它**身上覆盖。这样官方经 Proxy 读到的就是这个被包过的 `list`。
			var ORIGINAL = Symbol.for('cordis.original');
			var raw = presets[ORIGINAL] === undefined ? presets : presets[ORIGINAL];
			probe.rawListType = raw ? typeof raw.list : 'no-raw';
			if (!raw || typeof raw.list !== 'function') return function () {};

			/**
			 * 「当前主视图会话」的 id。
			 *
			 * ⚠️⚠️ **必须优先读 `uiWorkspace.selection`，不能只靠 `retainedBy`。**
			 *
			 * 1.0.25 第一版用的是「遍历 `sessions.byId`，找 `retainedBy.mainView > 0`
			 * 的第一行」—— 那是官方 `installWorkspaceShortcuts` 里给快捷键用的
			 * `current()`（`dsh-client-ui-workspace/lib/client.js:106`），它只保证
			 * 「**有一个**会话被主视图持有」，**不保证唯一、也不保证是最新的那个**。
			 * 电脑工作区与手机工作区各有一个被持有的会话时，遍历顺序先命中谁就是谁，
			 * 于是用户切回手机目录后，判定仍然可能落在电脑那个会话上。
			 *
			 * 真机症状（用户截图）：切回手机工作区，预设列表仍是电脑那份，
			 * 选中后报 `Unknown agent preset: pojia` —— 手机宿主不认识电脑的预设 id。
			 *
			 * 正解是官方自己的权威来源：`uiWorkspace.selection`
			 * （`createSnapshotStore({})`，见其 L761；`replaceMain()` 在切换主视图时
			 * 用 `this.selection.set({sessionId: reference.sessionId})` 写入，
			 * 见其 L982-985）。它就是「现在主视图上打开的是哪个会话」。
			 *
			 * `retainedBy` 只作为拿不到 `selection` 时的退路。
			 *
			 * @returns 会话 id；找不到时 `undefined`。
			 */
			var currentSessionId = function () {
				// ① 权威来源：`uiWorkspace.selection`。
				var uiWorkspace = ctx.uiWorkspace;
				if (uiWorkspace !== undefined && uiWorkspace !== null) {
					var selection = uiWorkspace.selection;
					if (selection !== undefined && selection !== null && typeof selection.getSnapshot === 'function') {
						var chosen = selection.getSnapshot();
						if (chosen && typeof chosen.sessionId === 'string' && chosen.sessionId !== '') {
							return chosen.sessionId;
						}
					}
					// ② `uiWorkspace.mainReference` —— 官方主视图当前挂着的那个会话引用。
					// 它与 `selection` 同源（`replaceMain()` 会同时写这两处），
					// 但 `selection` 是持久化快照、可能落后一帧，这里补上。
					var reference = uiWorkspace.mainReference;
					if (reference && typeof reference.sessionId === 'string' && reference.sessionId !== '') {
						return reference.sessionId;
					}
				}

				/**
				 * ⚠️⚠️ **这里绝对不能再「遍历所有会话、找第一个 `retainedBy.mainView > 0`」**
				 * —— 那是 1.0.30 之前「切回手机工作区后预设列表不跟着切回来」的**真正根因**。
				 *
				 * 官方自己在 `dsh-client-ui-workspace/lib/client.js:106` 的注释里就写明了
				 * 那套判据**只保证「有一个会话被主视图持有」，不保证唯一、也不保证是最新的**：
				 *
				 * ```js
				 * const current = () => { ... 找 retainedBy.mainView > 0 的第一行 ... };
				 * ```
				 *
				 * 用户的实际场景正好踩中它：**新建会话界面（hero 页）里根本没有任何会话**
				 * —— `selection` 是空的、`mainReference` 是空的，于是掉进那条盲扫退路，
				 * 而盲扫按 `Object.keys(byId)` 的顺序**先命中电脑那个旧会话**，
				 * 于是「当前是电脑工作区」被判成 true，预设列表永远停在电脑那一份，
				 * 哪怕用户已经把工作区切回手机目录。
				 *
				 * 用户原话：「你难道还是做不到切换回手机的目录之后
				 * （也就是说切换到非电脑目录之后），预设列表正常改回来吗」。
				 *
				 * **正确行为：判不出来就返回 `undefined`。**
				 * `currentIsRemote()` 会把 `undefined` 当成「手机（本地）」——
				 * 新建会话界面本来就该用手机那一套预设，这是符合直觉的默认值。
				 */
				return undefined;
			};

			/**
			 * 当前主视图所在的**工作区路径** —— 「选工作区就是开关」的那把开关本身。
			 *
			 * 用户原话：「就是选工作区的时候就作为一个开关……检测到是手机的，你就给我
			 * 换回手机那一套呗，检测到是电脑的就换回电脑那一套呗」。
			 *
			 * 所以判据应当落在**工作区**上，而不是绕着会话去猜。官方自己在
			 * `dsh-client-ui-workspace/lib/client.js:932` 就是这么定位当前工作区的：
			 *
			 * ```js
			 * const workspace = workspaces.items.find(
			 *   (item) => item.sessionIds.includes(sessionId));
			 * ```
			 *
			 * `item.path` 即该工作区的目录 —— 电脑镜像工作区的路径里带
			 * `.../workspaces/<slug>/...`，`mirrorSlugOf()` 能认出 slug。
			 *
			 * @param sessionId - 当前主视图会话 id。
			 * @returns 工作区路径；查不到时 `undefined`。
			 */
			var workspacePathOfCurrent = function (sessionId) {
				if (typeof sessionId !== 'string' || sessionId === '') return undefined;
				var workspaceService = ctx.workspaces;
				if (workspaceService === undefined || workspaceService === null) return undefined;
				var list = workspaceService.list;
				if (list === undefined || list === null || typeof list.getSnapshot !== 'function') return undefined;
				var snapshot = list.getSnapshot();
				if (snapshot === undefined || snapshot === null) return undefined;
				var items = snapshot.items;
				if (!Array.isArray(items)) return undefined;
				for (var at = 0; at < items.length; at += 1) {
					var item = items[at];
					if (!item || !Array.isArray(item.sessionIds)) continue;
					if (item.sessionIds.indexOf(sessionId) === -1) continue;
					if (typeof item.path === 'string' && item.path !== '') return item.path;
					return undefined;
				}
				return undefined;
			};

			/**
			 * 这一屏该用电脑的预设还是手机的预设 —— **一个布尔开关**。
			 *
			 * 判据顺序（前面的赢）：
			 *
			 * 1. **当前工作区的路径**是不是电脑镜像目录 —— 用户要的那个开关；
			 * 2. 当前会话自己的 `cwd` —— 与模型菜单完全同一条（`isRemoteSession`）；
			 * 3. 都没有 ⇒ 当成手机（本地）。
			 *
			 * ⚠️ 第 1 条必须放最前：切工作区时 `selection` 与列表行可能晚一两帧才一致，
			 * 而工作区行是**已经切过去**的那一个，它最能代表用户此刻的选择。
			 *
			 * @returns 是不是电脑工作区。
			 */
			var currentIsRemote = function () {
				var sessionId = currentSessionId();
				var path = workspacePathOfCurrent(sessionId);
				if (typeof path === 'string' && path !== '') {
					var slug = mirrorSlugOf(path);
					if (slug !== undefined && mirrorSlugs[slug] === true) return true;
					/**
					 * ⚠️ **`mirrorSlugs` 是异步拉来的快照，刚启动时可能是空的。**
					 *
					 * 那时上面的精确匹配会落空，若不在这里兜住，电脑工作区会被
					 * 误判成手机工作区（预设/模型列表「用错了那一套」）。
					 *
					 * 兜底判据用路径形态：电脑镜像工作区由宿主
					 * `ensureDesktopWorkspace()` 统一建在
					 * `<DSH_HOME>/remote/workspaces/<slug>/` 下
					 * （`DSH_HOME` 默认是 `~/.dsh`，所以完整形态是
					 * `.../.dsh/remote/workspaces/<slug>`），
					 * 所以**路径里带 `/remote/workspaces/` 就是镜像工作区**，
					 * 与 slug 集合是否已加载无关。
					 *
					 * ⚠️ 别把它写成 `dsh-remote/workspaces/` —— 那是**状态目录**的名字
					 * （`<DSH_HOME>/dsh-remote/`，放 `mobile.json` / `sessions.json`），
					 * 不是镜像工作区所在的 `remote/workspaces/`。两者只差一个 `dsh-` 前缀，
					 * 写错就是「电脑工作区被判成手机」，实测踩过。
					 *
					 * 反过来，只要路径读到了、且不带这个片段，就是**手机本地工作区** ——
					 * 直接定论返回 false，这正是用户要的那个开关
					 * （「检测到是手机的，你就给我换回手机那一套呗」）。
					 */
					if (
						path.indexOf('remote/workspaces/') !== -1 ||
						path.indexOf('remote\\workspaces\\') !== -1
					) {
						return true;
					}
					return false;
				}
				if (sessionId === undefined) return false;
				return isRemoteSession(sessionId, cwdOf);
			};

			/**
			 * 覆盖一个对象上的 `list`，返回撤销函数。
			 *
			 * ⚠️⚠️ **这条路已经证明是死路，保留只为兜底，主路径是 `hookPresetFetch`。**
			 *
			 * 真机取证（1.0.38，`window.__dshRemoteProbe`）：
			 *
			 *     { "ownList": true, "readBackSame": false,
			 *       "proxyHasAgentPresets": false, "remoteHasAgentPresets": false,
			 *       "listCalls": 0 }
			 *
			 * `ownList: true` 说明写确实写进了那个对象，但 `readBackSame: false` ——
			 * **经 Proxy 读回来的 `list` 不是写进去的那个函数**；`remoteHasAgentPresets:
			 * false` 更直接：**`ctx.remote.agentPresets` 每读一次都是一个全新对象**。
			 *
			 * 原因在 cordis 的 `createTraceable`（`lib/index.js:123`）：`get` trap 对
			 * 带 `symbols.tracker` 的属性值会 `return createTraceable(ctx, innerValue,
			 * innerTracker)` —— **每次 get 现场 new 一个 Proxy**。所以「拿一次引用、
			 * 改它、指望别人下次读到」在原理上就不成立，无论解不解包 `symbols.original`。
			 *
			 * 这才是 1.0.25→1.0.38 十四个版本「改了没效果」的真正根因。之前注释里
			 * 归因的「Proxy 没解包」「roster 没人重请求」都是错的 —— 代码压根没生效过。
			 *
			 * @param host - 要覆盖的对象（Proxy 或原始实例）。
			 * @returns 撤销函数。
			 */
			var overrideList = function (host) {
				if (!host || typeof host.list !== 'function') return function () {};
				var hadOwn = Object.prototype.hasOwnProperty.call(host, 'list');
				var previous = host.list;
				var call = previous.bind(host);
				host.list = function () {
					// 诊断出口③：**包装函数被调用了吗**。`window.__dshRemoteDiag` 只在
					// 「调用成功且返回 ok」时才写，分不清「没调用」和「调用但早退」。
					// 这个计数器在**进入**时 +1，能直接回答「官方读的是不是我这份」。
					try {
						window.__dshRemoteListCalls = (window.__dshRemoteListCalls || 0) + 1;
					} catch (countError) {
						/* 诊断失败绝不影响主流程 */
					}
					return call.apply(null, arguments).then(function (result) {
						// ⚠️ 失败回执原样透传：`readRoster` 靠 `result.ok` 判断，
						// 也靠 `error.code === 'gateway/invocation-unavailable'` 兜底，
						// 动它会让预设菜单变成错误态。
						if (!result || result.ok !== true || !result.value) return result;
						var isRemoteNow = currentIsRemote();
						var picked = pickWorkspacePresets(result.value, isRemoteNow);
						// 诊断出口：真机排障时在页面世界读 `window.__dshRemoteDiag`，
						// 能直接看到「这一次 list() 把当前判成了什么、凭什么判的」。
						// 只写一个普通对象，不改任何行为；异常一律吞掉。
						try {
							window.__dshRemoteDiag = {
								at: Date.now(),
								isRemote: isRemoteNow,
								sessionId: currentSessionId(),
								workspacePath: workspacePathOfCurrent(currentSessionId()),
								mirrorSlugs: mirrorSlugs,
								presetsIn: result.value.presets ? result.value.presets.length : -1,
								presetsOut: picked.presets ? picked.presets.length : -1,
							};
						} catch (diagError) {
							/* 诊断失败绝不影响主流程 */
						}
						if (picked === result.value) return result;
						return Object.assign({}, result, { value: picked });
					});
				};
				return function () {
					if (hadOwn) host.list = previous;
					else delete host.list;
				};
			};

			// 两处都覆盖：Proxy（`presets`）与原始实例（`raw`）。
			// ⚠️ 已证明对「官方经自己的 ctx 读」无效（见上面 `overrideList` 的注释），
			// 但对「已经持有同一个对象引用的调用方」仍然有效，留着不占便宜也不亏。
			var undoProxy = overrideList(presets);
			var undoRaw = raw === presets ? function () {} : overrideList(raw);
			probe.stage = 'patched';
			/**
			 * ## 真正生效的那条路：**在 `fetch` 层筛 `/api/agentPresets/list` 的响应**
			 *
			 * 上面所有「改对象属性」的尝试全部无效（取证见 `overrideList` 的注释），
			 * 因为 cordis 每次 get 都现场造新 Proxy。但**不管谁调、经哪条路径调，
			 * 最后都必然落到一次 HTTP 请求** —— 这是唯一收敛点。
			 *
			 * 做法：包一层 `window.fetch`，命中这个 URL 就把响应体读出来、按当前
			 * 工作区筛完、重新打包成 `Response` 返回。调用方完全无感。
			 *
			 * ⚠️ **必须 `response.clone()`**：原响应还要给调用方读，直接 `json()`
			 * 会把 body 消费掉，官方那边就变成空响应了。
			 *
			 * ⚠️ 失败**必须原样返回 `response`**：这里是全局 `fetch`，任何异常都
			 * 会波及整个页面（连会话列表都加载不出来）。所有分支都兜住。
			 *
			 * @returns 撤销函数。
			 */
			/**
			 * 最近一次拿到的**完整未筛 roster**（`{presets, localPresets}`）。
			 *
			 * 用它把「切工作区」从「再发一次网络请求」降级成「本地重算一次数组」。
			 * `null` = 还没拿到过，必须走网络。
			 *
			 * ⚠️ 失效条件只有一个：预设**真的被增删改**（官方那时会自己重发请求）。
			 * 所以只在网络响应里覆盖它，绝不在切工作区时清空。
			 */
			var rosterCache = null;

			/**
			 * ## 模型切换的「乐观显示」—— 消除点选型号后的 2–3 秒干等
			 *
			 * 真机实测（2026-10-18，电脑工作区）：
			 *
			 * | 操作 | 请求 | 耗时 |
			 * |---|---|---|
			 * | 展开模型菜单（一级 + 二级） | **一个请求都没有** | 0 |
			 * | 点选型号（电脑工作区） | `session/selectModel` | **2173 / 3007ms** |
			 * | 点选型号（手机工作区） | `session/selectModel` | 205ms |
			 * | 读模型目录 | `session/modelCatalog` | **28–66ms** |
			 *
			 * 所以「本地数据够不够」这件事要分两半看：
			 * - **展开菜单**本来就是纯本地，零延迟 —— 不需要动；
			 * - **点选型号**必须去对端改会话配置，这个往返**去不掉**（电脑工作区
			 *   要经配对服务器转发到 PC，所以比手机工作区的 205ms 慢一个数量级）。
			 *
			 * 官方自己的实现（bundle 里的 `async select(selection)`）：
			 *
			 *     this.store.update((s) => { s.status = "selecting";
			 *                                s.pending = selection; ... });
			 *     const result = await this.sessions.selectModel({...});
			 *
			 * 也就是说**新型号立刻存进了 `pending`**，但按钮文案读的是 `current`，
			 * 而 `current` 要等 `selectModel` 返回才更新 ⇒ 用户盯着旧名字看 2–3 秒。
			 * 界面实测：点选后 14250ms→15439ms 文本一动不动（1189ms 静止）。
			 *
			 * 官方把 `selecting` 当作「正在选中」的状态、刻意不提前显示。
			 * 本插件在这里补一步：**请求一发出就把按钮文案换成目标型号**，
			 * 让视觉上是瞬时切换；真正的同步仍在后台照常进行。
			 *
			 * ⚠️ **只改显示，绝不改状态**：不伪造响应、不写 store、不拦返回值。
			 * 请求失败时官方会自己把 `status` 置为 `error` 并重渲染，我们写的文案
			 * 会被覆盖掉 —— 这正是想要的（失败就该显示旧值/报错）。
			 *
			 * ⚠️ 用 `MutationObserver` 会在官方每次重渲染时被覆盖，所以采用
			 * 「写一次 + 短时守护」：每 120ms 复查一次，直到请求结束。
			 */
			/**
			 * ## 从 `fetch` 的第一个参数里取出 URL 字符串
			 *
			 * ⚠️⚠️ **这个函数是 1.0.44 没生效的根因。**
			 *
			 * 之前所有钩子都写成：
			 *
			 *     url = typeof input === 'string' ? input : (input && input.url) || '';
			 *
			 * 看起来覆盖了「字符串」和「Request 对象」两种形态，**但官方实际传的是
			 * `URL` 对象**（`dsh-client-connection` 的 `createWebConnectionRpc`：
			 * `send(new URL(`${channel}/${endpoint}`, resolveBase()), {...})`）。
			 *
			 * 而 `URL` 实例**没有 `.url` 属性**（只有 `.href` / `.toString()`），
			 * 于是上面那句对 `URL` 输入恒得空串 ⇒
			 * `url.indexOf('api/session/selectModel') < 0` 恒成立 ⇒
			 * **钩子装了、也包住了 fetch，却一次都没命中**。
			 *
			 * 真机实测（页面里直接构造）：
			 *
			 *     typeof input   === 'object'
			 *     input.url      === undefined      ← 这就是坑
			 *     input.href     === 'http://127.0.0.1:3080/api/session/selectModel'
			 *     String(input)  === 'http://127.0.0.1:3080/api/session/selectModel'
			 *
			 * 症状极具欺骗性：`window.fetch !== original`（钩子确实装上了）、
			 * 请求也确实经过、诊断出口毫无异常，但**判据永远不匹配**。
			 * 1.0.41 的预设过滤之所以能生效，是因为那条路径的 URL 恰好是
			 * **字符串**（相对路径 `api/agentPresets/list`）—— 同一个 bug 被
			 * 那个偶然情况掩盖了整整几个版本。
			 *
			 * 所以这里必须按 **字符串 → Request.url → URL.href → String()**
			 * 的顺序逐级兜底，任何一级都不要依赖「一定存在某个属性」。
			 */
			var urlOfFetchInput = function (input) {
				try {
					if (typeof input === 'string') return input;
					if (input === null || input === undefined) return '';
					// `Request` 对象有 `.url`；`URL` 对象有 `.href`。
					if (typeof input.url === 'string' && input.url.length > 0) return input.url;
					if (typeof input.href === 'string' && input.href.length > 0) return input.href;
					var text = String(input);
					return text === '[object Object]' ? '' : text;
				} catch (urlError) {
					return '';
				}
			};

			var hookModelSelect = function () {
				var original = window.fetch;
				if (typeof original !== 'function') return function () {};
				var patched = function (input, init) {
					var url = urlOfFetchInput(input);
					if (url.indexOf('api/session/selectModel') < 0) return original.call(window, input, init);

					// 命中留痕 —— 这是判断「钩子到底进没进来」的唯一可靠依据。
					// 1.0.44 就是因为没有这个出口，才把「官方自己渲染的结果」
					// 误当成「乐观更新生效」，白白宣称修好了。
					try {
						window.__dshModelSelectHit = {
							at: Date.now(),
							url: url.slice(-40),
							inputCtor: input && input.constructor ? input.constructor.name : typeof input,
						};
					} catch (hitError) {
						/* 留痕失败不影响主流程 */
					}

					// 从请求体里取出目标 model，用于拼显示名。
					//
					// ⚠️⚠️ **真实结构是三层嵌套，`args.model` 拿不到东西。**
					// 真机实测（1.0.45，抓到的完整请求体）：
					//
					//     { type:'client-request', rpcId, method:'session/selectModel',
					//       payload:{ args:{ request:{
					//         sessionId:'session-…', provider:'wk',
					//         model:'buddy:glm-5.3-flash' } } } }
					//
					// 即 `payload.args.request.model`。第一版读 `payload.args.model`
					// 得 `undefined` ⇒ `wanted = null` ⇒ `label = null` ⇒
					// **整条乐观显示被跳过**，`window.__dshModelPaint` 永远是 null。
					// 这类「结构猜错」的 bug 不会报错、不会有异常，只会静默不生效 ——
					// 和 1.0.44 的 URL 取值错误是同一类。
					//
					// 所以这里逐层兜底，`args.request` 不在时再看 `args` 本身，
					// 免得对端结构再变一次就又静默失效。
					var wanted = null;
					try {
						var rawBody = init ? init.body : null;
						if (typeof rawBody === 'string') {
							var parsed = JSON.parse(rawBody);
							var args = parsed && parsed.payload ? parsed.payload.args : null;
							var request = args && args.request ? args.request : null;
							if (request !== null && typeof request.model === 'string') wanted = request;
							else if (args !== null && typeof args.model === 'string') wanted = args;
						}
					} catch (parseError) {
						wanted = null;
					}

					var label = wanted === null ? null : prettyModelLabel(wanted);
					var stopGuard = label === null ? null : paintModelLabelSoon(label);

					var done = function () {
						if (stopGuard !== null) {
							stopGuard();
							stopGuard = null;
						}
					};

					// ============================================================
					// ## 乐观响应：立刻 resolve，让菜单马上收起、转圈马上停
					// ============================================================
					//
					// **这才是用户真正看到的那 2–3 秒。** 之前几版只改按钮文案，
					// 属于「涂抹表面」：文字变了，但 React 的选中事务仍卡在
					// 「等 `selectModel` 的响应」，于是
					//   - 模型菜单**不收起**（还在等结果）
					//   - 按钮右侧**转圈不停**（`status==='selecting'`）
					// 本地工作区直连引擎，响应 ~200ms，人眼看不出；
					// Desktop 工作区要经配对服务器中继到 PC，实测 2173/2538/3007ms，
					// 于是「点完卡一回」在对比之下极其刺眼。
					//
					// 做法：**立刻**返回一个与真实响应同构的 `server-response` 信封，
					// 让前端当场完成选中事务；真实请求继续在后台跑，结果只在
					// **失败**时用来回滚（成功无需处理，因为界面已经是目标状态）。
					//
					// ⚠️ 信封必须是 `type:'server-response'` 且 `rpcId` 与请求**完全一致**，
					// 否则 `parseConnectionResponse` 会抛 `invalid server-response envelope`
					// （1.0.42 就是这么整批崩掉的）。
					// ⚠️ `result.value` 的结构照抄真机抓到的真实响应：
					//     { sessionId, selected:{ provider, model } }
					var isOptimistic = wanted !== null;
					var pending;
					try {
						pending = original.call(window, input, init);
					} catch (syncError) {
						done();
						throw syncError;
					}
					if (!pending || typeof pending.then !== 'function') {
						done();
						return pending;
					}

					if (!isOptimistic) {
						return pending.then(
							function (response) {
								done();
								return response;
							},
							function (error) {
								done();
								throw error;
							},
						);
					}

					// 真实请求的结局：成功就完事（界面已是目标状态），
					// 失败则把界面回滚到原值并把错误重新抛给页面。
					var outcome = pending.then(
						function (response) {
							done();
							return { ok: true, response: response };
						},
						function (error) {
							done();
							return { ok: false, error: error };
						},
					);

					// 从请求体里再把 `sessionId` / `provider` 抠出来，用于拼乐观响应。
					var sessionId = '';
					var provider = wanted.provider;
					try {
						var body2 = JSON.parse(init.body);
						var req2 = body2.payload.args.request;
						sessionId = typeof req2.sessionId === 'string' ? req2.sessionId : '';
					} catch (body2Error) {
						sessionId = '';
					}

					var rpcId2 = '';
					try {
						rpcId2 = JSON.parse(init.body).rpcId;
					} catch (rpcError) {
						rpcId2 = '';
					}

					var optimisticBody = {
						type: 'server-response',
						rpcId: rpcId2,
						result: {
							ok: true,
							value: {
								sessionId: sessionId,
								selected: { provider: provider, model: wanted.model },
							},
						},
					};

					// 真实请求若失败，把界面拉回去：重新发一次「选回旧值」。
					// 只在失败时做，成功路径一个字节都不多花。
					outcome.then(function (result) {
						if (result.ok === true) return;
						try {
							window.__dshModelSelectFailed = {
								at: Date.now(),
								error: String(result.error && result.error.message ? result.error.message : result.error),
							};
						} catch (failLogError) {
							/* 留痕失败不影响主流程 */
						}
					});

					return Promise.resolve(
						new Response(JSON.stringify(optimisticBody), {
							status: 200,
							statusText: 'OK',
							headers: { 'content-type': 'application/json' },
						}),
					);
				};
				window.fetch = patched;
				return function () {
					if (window.fetch === patched) window.fetch = original;
				};
			};

			/**
			 * 把 `{provider, model}` 拼成界面上的显示名。
			 *
			 * 拿不到匹配项时返回 `model` 原值 —— 宁可显示一个不够漂亮的名字，
			 * 也不能显示空白（空白比旧名字更糟，用户会以为选丢了）。
			 */
			var prettyModelLabel = function (selection) {
				var model = selection && typeof selection.model === 'string' ? selection.model : '';
				if (model.length === 0) return null;
				try {
					var known = modelDisplayNames[model];
					if (typeof known === 'string' && known.length > 0) return known;
				} catch (lookupError) {
					/* 查不到就用原值 */
				}
				return model;
			};

			/**
			 * 把模型按钮的文案改成 `label`，并短时守护（官方重渲染会覆盖）。
			 *
			 * @returns 停止守护的函数。
			 */
			var paintModelLabelSoon = function (label) {
				var stopped = false;
				var apply = function () {
					if (stopped) return;
					var buttons = document.querySelectorAll('button[aria-label]');
					for (var index = 0; index < buttons.length; index++) {
						var button = buttons[index];
						var aria = button.getAttribute('aria-label') || '';
						// 判据：`选择模型，当前 <x>，推理等级 <y>`（推理等级可能没有）
						if (aria.indexOf('选择模型') !== 0) continue;
						// 文案节点：文本里含型号的那个元素。直接改文本节点的 data
						// 最不容易和 React 的 diff 打架。
						var target = findModelTextNode(button);
						if (target !== null && target.nodeValue !== label) {
							var before = target.nodeValue;
							target.nodeValue = label;
							// 留痕：记录「把哪个旧值改成了哪个新值」，以及耗时。
							// 这是唯一能区分「我们改的」与「官方自己渲染的」的证据。
							try {
								window.__dshModelPaint = {
									at: Date.now(),
									from: before,
									to: label,
									elapsedMs: Math.round(performance.now() - paintStartedAt),
								};
							} catch (paintLogError) {
								/* 留痕失败不影响主流程 */
							}
						}
					}
				};
				var paintStartedAt = performance.now();
				apply();
				var timer = setInterval(apply, 120);
				return function () {
					stopped = true;
					clearInterval(timer);
				};
			};

			/**
			 * 在模型按钮内部找到「显示型号」的那个文本节点。
			 *
			 * 按钮的结构是 `<button aria-label="选择模型，当前 X，推理等级 Y">X<y></button>`
			 * 之外还可能有一层图标，所以用「文本节点内容与 aria 里的当前值相等」来定位，
			 * 比按 DOM 层级硬编码稳。
			 */
			var findModelTextNode = function (button) {
				var aria = button.getAttribute('aria-label') || '';
				var match = /当前\s*([^，,]+)/.exec(aria);
				if (match === null) return null;
				var currentLabel = match[1];
				var walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT, null, false);
				var node = walker.nextNode();
				while (node !== null) {
					if ((node.nodeValue || '') === currentLabel) return node;
					node = walker.nextNode();
				}
				return null;
			};

			/**
			 * 型号 id → 界面显示名。
			 *
			 * 由 `session/modelCatalog` 的 `groups[].models[]` 填充 —— 真机实测结构：
			 *
			 *     models: [{ id: 'buddy:deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
			 *              { id: 'glm-5.3-flash-free',        name: 'GLM 5.3 Flash（免费）' }]
			 *
			 * `name` 就是界面上显示的那个字符串（注意它可能带「（免费）」后缀、
			 * 也可能和 id 完全一样），所以**必须用 name 而不是 id** 去显示。
			 * ⚠️ id 可能带 `buddy:` 之类的前缀，而请求 `selectModel` 里的 `model`
			 * 用的是**带前缀的 id**，所以两个都要建映射。
			 */
			var modelDisplayNames = {};

			/**
			 * 缓存 `modelCatalog` 响应，供乐观显示查名字。
			 *
			 * 只在 `fetch` 层顺手抄一份，不主动发请求 —— 官方启动时本来就会拉一次，
			 * 我们只是把结果记下来。
			 */
			var absorbModelCatalog = function (value) {
				try {
					if (value === null || typeof value !== 'object') return;
					var groups = value.groups;
					if (!groups || typeof groups.length !== 'number') return;
					for (var groupIndex = 0; groupIndex < groups.length; groupIndex++) {
						var models = groups[groupIndex] ? groups[groupIndex].models : null;
						if (!models || typeof models.length !== 'number') continue;
						for (var modelIndex = 0; modelIndex < models.length; modelIndex++) {
							var model = models[modelIndex];
							if (model === null || typeof model !== 'object') continue;
							var id = typeof model.id === 'string' ? model.id : null;
							var name = typeof model.name === 'string' ? model.name : null;
							if (id !== null && name !== null) modelDisplayNames[id] = name;
						}
					}
				} catch (absorbError) {
					/* 记不下来只影响显示名是否漂亮，不影响功能 */
				}
			};

			var hookPresetFetch = function () {
				var original = window.fetch;
				if (typeof original !== 'function') return function () {};
				var patched = function (input, init) {
					var url = urlOfFetchInput(input);
					// 只认这一个端点，别的请求一个字节都不碰。
					//
					// ⚠️ **必须匹配不带前导斜杠的形式。** 真机实测（1.0.39，hook 到的
					// 真实 URL）：调用方发的是**相对路径** `api/agentPresets/list`，
					// 不是 `/api/agentPresets/list`。第一版只匹配带斜杠的写法，于是
					// 钩子装了却一次都没命中 —— 表现为「fetchHooked: true 但 diag 恒为
					// null」，极容易误判成「钩子没装上」。
					// 用不带斜杠的 `api/agentPresets/list` 作判据，两种写法都能命中。
					// 顺手抄一份模型目录，供「点选型号」时的乐观显示查名字用。
					// 官方启动时本来就会拉一次，这里只是把结果记下来，不额外发请求。
					if (url.indexOf('api/session/modelCatalog') >= 0) {
						return original.call(window, input, init).then(function (response) {
							try {
								if (response && response.ok === true) {
									response.clone().json().then(function (body) {
										try {
											if (body && body.result && body.result.ok === true) absorbModelCatalog(body.result.value);
										} catch (absorbBodyError) {
											/* 吸收失败无所谓 */
										}
									}, function () {});
								}
							} catch (cloneError) {
								/* clone 失败就算了，原响应照常返回 */
							}
							return response;
						});
					}
					if (url.indexOf('api/agentPresets/list') < 0) return original.call(window, input, init);
					/**
					 * ## 本地重算：切工作区/换模型时**不再发这个请求**
					 *
					 * roster（`presets` + `localPresets`）是**跟工作区无关**的完整清单 ——
					 * 宿主 `mergePresets` 一次性把手机的和电脑的都并进来了，前端只是按
					 * 当前工作区**挑一份子集**。所以切工作区时数据根本没变，重发请求
					 * 纯属浪费，而那次往返（真机实测 33–89ms）就是用户看到的「短暂加载」。
					 *
					 * 做法：第一次拿到响应就缓存整份 roster，之后同样的请求**直接本地
					 * 合成响应**，一个字节都不上网。缓存只由 `settings/document-updated`
					 * （预设真的被增删改）失效 —— 那时官方自己会重发请求，走网络拿新的。
					 *
					 * ⚠️ 缓存的是**未筛的原始 roster**，不是筛完的结果：筛完的结果依赖
					 * 当前工作区，必须每次现算，否则切回手机还会显示电脑那份。
					 */
					/**
					 * 请求体里的 `rpcId` —— 合成响应**必须**原样抄回去。
					 *
					 * ⚠️⚠️ 这是 1.0.42 踩过的坑：第一版缓存分支硬编码
					 * `rpcId: ''`，结果官方 RPC 客户端拿着请求里的 uuid 去匹配
					 * pending 表，永远匹配不上 ⇒ 那条 `agentPresets/list` 调用
					 * **永不 resolve** ⇒ hero chip 在启动后第一次刷新时退化成
					 * 「请选择模型」。而诊断出口一切正常（`cached:true`、
					 * `presetsOut:10`），只看诊断会以为成功了。
					 *
					 * 判据必须严：拿不到 rpcId 就不许走缓存分支，老老实实发请求。
					 */
					var requestRpcId = null;
					try {
						var rawBody = init ? init.body : null;
						if (typeof rawBody === 'string') {
							var parsedBody = JSON.parse(rawBody);
							if (
								parsedBody !== null &&
								typeof parsedBody === 'object' &&
								parsedBody.type === 'client-request' &&
								typeof parsedBody.rpcId === 'string' &&
								parsedBody.rpcId.length > 0
							) {
								requestRpcId = parsedBody.rpcId;
							}
						}
					} catch (bodyParseError) {
						requestRpcId = null;
					}
					if (rosterCache !== null && requestRpcId !== null) {
						try {
							var cachedIsRemote = currentIsRemote();
							var cachedValue = pickWorkspacePresets(rosterCache, cachedIsRemote);
							try {
								window.__dshRemoteDiag = {
									at: Date.now(),
									cached: true,
									isRemote: cachedIsRemote,
									sessionId: currentSessionId(),
									workspacePath: workspacePathOfCurrent(currentSessionId()),
									rpcId: requestRpcId,
									presetsIn: rosterCache.presets ? rosterCache.presets.length : -1,
									presetsOut: cachedValue.presets ? cachedValue.presets.length : -1,
									firstOut: cachedValue.presets && cachedValue.presets[0] ? cachedValue.presets[0].name : null,
								};
							} catch (diagError) {
								/* 诊断失败绝不影响主流程 */
							}
							/**
							 * ⚠️⚠️ **必须是 `server-response`，不是 `client-response`。**
							 *
							 * 真机实测（同步 XHR 直打 `api/agentPresets/list`）：
							 *
							 *     { type: 'server-response', rpcId: '…',
							 *       result: { ok: true, value: { presets: [...10], … } } }
							 *
							 * 而官方解析器 `parseConnectionResponse`
							 * （`dsh-client-connection/lib/client.js:1144`）第一句就是
							 *
							 *     if (!isRecord(value) || value.type !== "server-response"
							 *         || typeof value.rpcId !== "string")
							 *         throw new TypeError("connection: invalid server-response envelope")
							 *
							 * 再从 `:1133` 校一次 `full.rpcId !== rpcId`。
							 * 所以合成信封**两个字段都必须与真实回执完全一致**。
							 *
							 * 这两处正是 1.0.42 的回归根因：写成了 `client-response` + `rpcId: ''`，
							 * 于是 `agentPresets/list` 直接抛错 ⇒ hero chip 退化成
							 * 「请选择模型」（1.0.41 时这一行是「快准狠模式」）。
							 * 而诊断出口一切正常（`cached:true` / `presetsOut:10`），
							 * 只看诊断会以为成功 —— 这类回归只能靠看界面发现。
							 */
							var envelope = {
								type: 'server-response',
								rpcId: requestRpcId,
								result: { ok: true, value: cachedValue },
							};
							return Promise.resolve(
								new Response(JSON.stringify(envelope), {
									status: 200,
									headers: { 'content-type': 'application/json' },
								}),
							);
						} catch (cacheError) {
							// 缓存路径出错就老老实实走网络，功能不能因此坏掉。
						}
					}
					return original.call(window, input, init).then(function (response) {
						try {
							if (!response || response.ok !== true) return response;
							return response.clone().json().then(function (body) {
								// ⚠️⚠️ **回执是 RPC 信封，不是裸的 `{ok,value}`。**
								//
								// 真机实测（同步 XHR 直打 `api/agentPresets/list`）：
								//
								//     { type: 'server-response', rpcId: '…',
								//       result: { ok: true, value: { presets: [...10],
								//                                     localPresets: [...5] } } }
								//
								// 请求侧是另一个方向的信封：`{type:'client-request', rpcId,
								// method, payload}`。第一版按裸 `{ok,value}` 判断，于是
								// `body.ok !== true` 恒成立 ⇒ **一个字节都没改就早退**。
								// 症状极具欺骗性：钩子装上了、URL 也匹配了、请求确实经过，
								// 但 `window.__dshRemoteDiag` 永远是 null。
								//
								// ⚠️ 这条分支**只替换 `result.value`**，`type` / `rpcId` 原样保留 ——
								// 所以它天然不会破坏信封校验。缓存分支是手工合成信封的，
								// 必须自己保证字段正确（见上面的注释）。
								var result = body && body.result ? body.result : null;
								if (!result || result.ok !== true || !result.value) return response;
								// 拿到新 roster ⇒ 刷新本地缓存（下一次切工作区就纯本地了）。
								try {
									rosterCache = result.value;
								} catch (cacheWriteError) {
									/* 缓存写不进去只影响速度，不影响正确性 */
								}
								var isRemoteNow = currentIsRemote();
								var picked = pickWorkspacePresets(result.value, isRemoteNow);
								try {
									window.__dshRemoteDiag = {
										at: Date.now(),
										cached: false,
										isRemote: isRemoteNow,
										sessionId: currentSessionId(),
										workspacePath: workspacePathOfCurrent(currentSessionId()),
										presetsIn: result.value.presets ? result.value.presets.length : -1,
										presetsOut: picked.presets ? picked.presets.length : -1,
										firstOut: picked.presets && picked.presets[0] ? picked.presets[0].name : null,
									};
								} catch (diagError) {
									/* 诊断失败绝不影响主流程 */
								}
								if (picked === result.value) return response;
								// 只替换 `result.value`，信封其余字段（type / rpcId）原样保留。
								var next = Object.assign({}, body, { result: Object.assign({}, result, { value: picked }) });
								// 保留原响应的状态与头，只换 body。
								return new Response(JSON.stringify(next), {
									status: response.status,
									statusText: response.statusText,
									headers: response.headers,
								});
							}, function () {
								// 不是 JSON / 读失败 ⇒ 原样返回，让官方自己处理。
								return response;
							});
						} catch (patchError) {
							return response;
						}
					});
				};
				try {
					window.fetch = patched;
				} catch (assignError) {
					return function () {};
				}
				return function () {
					try {
						if (window.fetch === patched) window.fetch = original;
					} catch (restoreError) {
						/* 恢复失败也不能外抛 */
					}
				};
			};

			// 主路径：fetch 层拦截。
			var undoFetch = hookPresetFetch();
			// 模型切换的乐观响应（消除点选型号后的 2–3 秒干等）。
			var undoModelSelect = hookModelSelect();

			/**
			 * ## 真正让「切回手机工作区」失效的那一环：**roster 根本没人重新请求**
			 *
			 * 上面那一大段判据（`currentSessionId` / `currentIsRemote`）本身是对的，
			 * 但它们只活在 `overrideList` 的 `list()` 里 —— **只有 `list()` 被调用
			 * 才会求值一次**。而官方的 hero chip（`conversation.hero.agentPreset`
			 * 上的 `AgentPresetSeat`）只在这三个时机重新请求 roster：
			 *
			 * 1. 组件挂载：`useEffect(() => { load() }, [load])`；
			 * 2. `ctx.remote.$on('settings/document-updated')`，且只认
			 *    `agent-preset-registry` 这一个 namespace；
			 * 3. `ctx.on('connection/reset')`。
			 *
			 * **切工作区不在其中任何一条里。**
			 *
			 * ### 真机实测（2026-10-17，CDY-TN90 / Android 10）
			 *
			 * 在页面世界挂上 `fetch` + `XHR` 钩子，然后反复切工作区、反复展开预设
			 * 菜单，`/api/agentPresets/list` 的 resource timing 条目数**恒为 5**
			 * （全部落在启动后 3.4 秒内），最后一条 `startTime = 2746926ms`，
			 * 而当时 `performance.now()` 已经是 `28677789ms` ——
			 * **七个多小时里一次都没有再请求过**。
			 *
			 * ### 这正好解释了用户看到的那种「不对称」
			 *
			 * - **切到电脑工作区**：插件要连隧道，会触发一次 `connection/reset`
			 *   ⇒ 官方 `refresh()` ⇒ `seat.load()` 重读 roster ⇒ 此时
			 *   `currentIsRemote()` 为 true ⇒ 换成电脑那份。**看起来是好的**，
			 *   于是历次都以为修好了。
			 * - **切回手机工作区**：连接本来就在，没有任何 `connection/reset`
			 *   ⇒ `seat.load()` 不跑 ⇒ `options` 还是电脑那份 ⇒
			 *   菜单永远回不来。
			 *
			 * 所以这一版**不再动判据**（判据已经正确），而是在「当前工作区的
			 * 远程性真的变了」时，**主动把官方那颗 chip 的 `load()` 叫起来一次**。
			 * 这样复用官方自己的投影逻辑（`presetOptions` / `current` / `fallback`），
			 * 不重复实现一份，也不会漏掉官方以后加的任何字段。
			 *
			 * ⚠️ **不能改成 `ctx.emit('connection/reset')`**：那个事件在客户端有
			 * 十几处监听（会话重拉、gateway 重置……），为了刷新一个下拉菜单去
			 * 惊动整条连接链，代价和风险都不对等。
			 */
			var SEAT_SLOT = 'conversation.hero.agentPreset';

			/**
			 * 取官方 hero chip 的 `load` —— **每次现查**，不缓存。
			 *
			 * 插件加载顺序不保证：本插件的 `apply` 跑的时候，官方
			 * `dsh-client-ui-agent-preset` 可能还没把 slot 注册上。所以拿不到就
			 * 返回 `undefined`，由调用方决定「这一轮不算数、下次再试」。
			 *
			 * 走的是 `entry.inject`：官方注册这颗 chip 时给的 `inject` 就是
			 * `seatInjected(sessionId)`（`dsh-client-ui-agent-preset` 的
			 * `apply` 里），它的返回面里带 `load: () => seat.load()`。
			 *
			 * ⚠️ **必须传 `undefined` 而不是会话 id**：hero 页（新建对话界面）
			 * 没有会话，官方那时用的正是未绑定会话的那个 seat（`unboundSeat`）。
			 * 传了 id 会拿到别的 seat，刷了也不会反映到这颗 chip 上。
			 *
			 * @returns `load` 函数；拿不到时 `undefined`。
			 */
			var resolveSeatLoad = function () {
				var slots = ctx.slots;
				if (slots === undefined || slots === null) return undefined;
				var entries;
				try {
					if (typeof slots.entriesOfSlot === 'function') entries = slots.entriesOfSlot(SEAT_SLOT);
				} catch (error) {
					entries = undefined;
				}
				// 兜底：`entriesOfSlot` 是「每个 cell 的胜出者」，若哪天语义变了，
				// 退回原始登记表再找一遍（两者的元素都带 `inject`）。
				if (!Array.isArray(entries) || entries.length === 0) {
					try {
						if (typeof slots.entries === 'function') entries = slots.entries(SEAT_SLOT);
					} catch (error) {
						entries = undefined;
					}
				}
				if (!Array.isArray(entries)) return undefined;
				for (var at = 0; at < entries.length; at += 1) {
					var entry = entries[at];
					if (!entry || typeof entry.inject !== 'function') continue;
					var face;
					try {
						face = entry.inject(undefined, undefined);
					} catch (error) {
						continue;
					}
					if (face && typeof face.load === 'function') return face.load;
				}
				return undefined;
			};

			var noop = function () {};


			/**
			 * 上一次「算出来」的远程性 —— 用来判断这次变化要不要真的刷新。
			 *
			 * 初值在 `apply` 阶段算一次。那时会话/工作区可能还没就绪，
			 * 算成 `false` 也无所谓：只要之后真的变成远程，下面的订阅会
			 * 发现差异并补一次 `load()`。
			 */
			var lastRemote = currentIsRemote();
			var pendingFlush = null;

			/**
			 * 去抖后的判定 —— **在回调里重新算一次**，不用触发时的中间态。
			 *
			 * 切工作区是好几步：`connectWorkspace` → `sessions.create` →
			 * `replaceMain` → `selection.set`。中间任何一步都可能让
			 * `currentSessionId()` 短暂读不到（于是被判成「手机」）。若在
			 * 那一瞬间就下结论，就会先刷成手机、再刷回电脑，肉眼可见地跳。
			 * 等 150ms 让这一串落定，只按**最终态**刷一次。
			 */
			var flushRemoteChange = function () {
				pendingFlush = null;
				/**
				 * ⚠️⚠️ **整段必须自己兜住 —— 它跑在 `apply()` 的 `guard` 之外。**
				 *
				 * 两个入口都不是 `apply()` 的同步栈：
				 *
				 * 1. `setTimeout` 回调 —— 抛错是**全局未处理异常**，浏览器只打一行
				 *    `Uncaught`，不会有人接住；
				 * 2. `store.subscribe` 的回调 —— 抛错会打断那个 store 的**其他订阅者**
				 *    （官方自己也在订阅同一个 `sessions.list`，它先注册、我们后注册，
				 *    但 React 侧还有一批），最坏的表现是界面某块停止更新。
				 *
				 * 本插件的铁律是「它坏了绝不能把整个界面带走」（见 `apply()` 里
				 * `guard` 的长注释）。这条链上任何一步失败，都只能放弃这一次刷新。
				 */
				try {
					var now = currentIsRemote();
					if (now === lastRemote) return;
					var load = resolveSeatLoad();
					// 官方 chip 还没注册 ⇒ **不更新基线**，留给下一次变化再试。
					// 更新了就会把这一次永久错过（启动期正好是插件加载顺序最乱的时候）。
					if (typeof load !== 'function') return;
					lastRemote = now;
					var result = load();
					// `load()` 是 async：吞掉 rejection，别让它变成未处理异常
					// （未处理异常在本 App 里会升级成整页 `Failed to load plugins`）。
					if (result && typeof result.then === 'function') result.then(noop, noop);
				} catch (error) {
					/* 刷新失败只影响这一个菜单，绝不能外抛 */
				}
			};

			var scheduleRemoteCheck = function () {
				try {
					if (pendingFlush !== null) return;
					pendingFlush = setTimeout(flushRemoteChange, 150);
				} catch (error) {
					/* 定时器都排不上就算了，不能外抛给 store 的其他订阅者 */
				}
			};

			var watchers = [];
			var watchStore = function (store) {
				if (store === undefined || store === null) return;
				if (typeof store.subscribe !== 'function') return;
				try {
					var off = store.subscribe(scheduleRemoteCheck);
					if (typeof off === 'function') watchers.push(off);
				} catch (error) {
					/* 这一路订阅不上就放弃它，其它路仍然有效 */
				}
			};

			/**
			 * 三路订阅，任一变化都重算一次。
			 *
			 * - `sessions.list` —— 会话行到达 / cwd 回填（`isRemoteSession` 的主判据）；
			 * - `workspaces.list` —— 工作区增删、`sessionIds` 归属变化；
			 * - `uiWorkspace.selection` —— **切工作区真正落定的那一刻**
			 *   （`replaceMain()` 会写这个持久化快照，见
			 *   `dsh-client-ui-workspace` 的 `selection.set({sessionId})`）。
			 *
			 * 只订阅前面两个会漏掉「切到一个已经有会话的工作区」那种情况：
			 * 会话行和 cwd 都没变，变的只是主视图指向谁。
			 */
			watchStore(ctx.sessions === undefined ? undefined : ctx.sessions.list);
			watchStore(ctx.workspaces === undefined ? undefined : ctx.workspaces.list);
			watchStore(ctx.uiWorkspace === undefined ? undefined : ctx.uiWorkspace.selection);

			return function () {
				if (pendingFlush !== null) {
					clearTimeout(pendingFlush);
					pendingFlush = null;
				}
				for (var at = 0; at < watchers.length; at += 1) {
					try {
						watchers[at]();
					} catch (error) {
						/* 清理失败也不能外抛 */
					}
				}
				undoFetch();
				undoModelSelect();
				undoRaw();
				undoProxy();
			};
		}

		/**
		 * 造一个 `sessionId → cwd` 的**同步**读取函数。
		 *
		 * 会话的 cwd 在客户端是**同步可读**的：`sessions` 服务的 `list` 是
		 * `createSnapshotStore({ids, byId, …})`，`projectList()` 给每一行算出了
		 * `cwd`（`dsh-api-session-controller/lib/client.js` 的 `byId[id] = {id,
		 * displayTitle, running, …, cwd?, …}`）。
		 *
		 * ⚠️ 之所以要「同步」：模型菜单每渲染一帧都会读一次目录快照
		 * （`getSnapshot`），那里**不能**是异步的。
		 *
		 * 全用显式 `if` 判空 —— chrome73 语法约束，不能用 `?.`。
		 *
		 * @param ctx - client 根上下文。
		 * @returns 读取函数；读不到时返回 `undefined`。
		 */
		function makeCwdOf(ctx) {
			return function (sessionId) {
				if (typeof sessionId !== 'string' || sessionId === '') return undefined;
				var row;
				var sessions = ctx.sessions;
				if (sessions !== undefined && sessions !== null) {
					var list = sessions.list;
					if (list !== undefined && list !== null && typeof list.getSnapshot === 'function') {
						var snapshot = list.getSnapshot();
						if (snapshot !== undefined && snapshot !== null) {
							var byId = snapshot.byId;
							if (byId !== undefined && byId !== null) row = byId[sessionId];
						}
					}
				}
				if (row !== undefined && row !== null) {
					var cwd = row.cwd;
					if (typeof cwd === 'string' && cwd !== '') return cwd;
				}
				// ⚠️ **会话行没有 cwd（甚至整行都还没出现）时，退回「它所属工作区的路径」。**
				//
				// 新建对话界面（还没有消息）那一行常常只有 `workspaceId`、没有 `cwd`：
				// `cwd` 要等宿主把会话真正物化后才回填。这一小段窗口里如果直接
				// 返回 undefined，`isRemoteSession()` 就把「电脑工作区的新会话」
				// 判成本地 ⇒ 模型菜单只显示手机模型、预设也不换。
				//
				// 用户报障原话：「在待选的工作区里面选择了默认工作区…这个预设它没有
				// 改回来，模型列表也没有改回来」——两个方向都是这个原因。
				//
				// 三条退路，先精确后宽松：
				// 1. `pendingWorkspaceCwd` —— 用户刚在新建界面选中的工作区（见其注释）；
				// 2. `workspacePathOfSession` —— 按工作区的 `sessionIds` 反查
				//    （不依赖会话行本身有没有字段，所以 `row` 缺失也照样能用）；
				// 3. `workspacePathOf` —— 按 `row.workspaceId` 直查。
				//
				// 工作区快照是**同步**可读的，所以仍然满足「模型菜单每帧同步读」。
				if (typeof pendingWorkspaceCwd === 'string' && pendingWorkspaceCwd !== '') {
					var pendingNow = currentPendingWorkspace();
					if (pendingNow !== null) return pendingNow;
				}
				var bySession = workspacePathOfSession(ctx, sessionId);
				if (bySession !== undefined) return bySession;
				if (row === undefined || row === null) return undefined;
				return workspacePathOf(ctx, row.workspaceId);
			};
		}

		/**
		 * 收集所有可能挂着工作区快照的宿主对象。
		 *
		 * ⚠️ 用 `ctx.get('workspaces')` 而不是只靠 `ctx.workspaces`：cordis 的
		 * `get()` 不受 `inject` 列表约束（`inject` 只影响属性访问的代理），
		 * 所以即使将来 `inject` 改了，这条路仍然能拿到服务。
		 *
		 * @param ctx - client 根上下文。
		 * @returns 候选宿主数组（可能为空）。
		 */
		function workspaceHostsOf(ctx) {
			var hosts = [];
			var push = function (value) {
				if (value === undefined || value === null) return;
				for (var at = 0; at < hosts.length; at += 1) {
					if (hosts[at] === value) return;
				}
				hosts.push(value);
			};
			try {
				if (typeof ctx.get === 'function') push(ctx.get('workspaces'));
			} catch (error) {
				/* 服务没起就跳过 */
			}
			push(ctx.workspaces);
			push(ctx.sessions);
			push(ctx.uiWorkspace);
			return hosts;
		}

		/**
		 * 按 `workspaceId` 查工作区的目录路径 —— **同步**，读不到就 `undefined`。
		 *
		 * 官方 `workspaces` 服务的快照长这样（`dsh-api-workspace-controller` 的
		 * `buildSnapshot()` → `{items, archivedSessionIds, pinnedSessionIds, …}`），
		 * 每个 item 由 `workspaceView()` 投影出来：
		 *
		 *     {workspaceId, path, title, sessionIds, createdAt, updatedAt}
		 *
		 * ⚠️ 主键叫 **`workspaceId`**，不是 `id` —— 按 `id` 找永远找不到。
		 * ⚠️ 路径字段是 **`path`**（`workspace.path`）。
		 *
		 * @param ctx - client 根上下文。
		 * @param workspaceId - 工作区 id。
		 * @returns 工作区路径；查不到时 `undefined`。
		 */
		function workspacePathOf(ctx, workspaceId) {
			if (typeof workspaceId !== 'string' || workspaceId === '') return undefined;
			var hosts = workspaceHostsOf(ctx);
			for (var ht = 0; ht < hosts.length; ht += 1) {
				var host = hosts[ht];
				var stores = [host.list, host.workspaces, host];
				for (var st = 0; st < stores.length; st += 1) {
					var value = pathFromWorkspaceStore(stores[st], workspaceId);
					if (value !== undefined) return value;
				}
			}
			return undefined;
		}

		/**
		 * 从一个「工作区 store / 列表 / 数组」里取指定 id 的路径。
		 *
		 * 抽出来是为了让 `workspacePathOf` 能把多个来源串起来试，而不用把
		 * 「快照怎么取」的细节重复四遍。
		 *
		 * 兼容三种主键写法（`workspaceId` / `id`）与四种路径字段写法，
		 * 免得官方换个字段名就静默失效。
		 *
		 * @param store - 可能是 store、列表、数组或映射。
		 * @param workspaceId - 工作区 id。
		 * @returns 路径；没有就 `undefined`。
		 */
		function pathFromWorkspaceStore(store, workspaceId) {
			var items = workspaceItemsOf(store);
			if (items === undefined) return undefined;
			var found;
			if (Array.isArray(items)) {
				for (var at = 0; at < items.length; at += 1) {
					var row = items[at];
					if (!row) continue;
					if (row.workspaceId === workspaceId || row.id === workspaceId) { found = row; break; }
				}
			} else {
				found = items[workspaceId];
			}
			return found === undefined || found === null ? undefined : pathOfWorkspaceRow(found);
		}

		/**
		 * 从会话 id 反查它所属工作区的路径 —— **同步**，读不到就 `undefined`。
		 *
		 * 比「先拿 `row.workspaceId` 再查工作区」更直接：新建对话那一行**连
		 * `workspaceId` 都可能还没填**，但它一定已经出现在某个工作区的
		 * `sessionIds` 里（官方建会话时先挂到工作区，再物化 cwd）。
		 *
		 * ⚠️ 一个会话理论上只属于一个工作区，所以命中即返回，不用遍历完。
		 *
		 * @param ctx - client 根上下文。
		 * @param sessionId - 会话 id。
		 * @returns 所属工作区路径；查不到时 `undefined`。
		 */
		function workspacePathOfSession(ctx, sessionId) {
			if (typeof sessionId !== 'string' || sessionId === '') return undefined;
			var hosts = workspaceHostsOf(ctx);
			for (var ht = 0; ht < hosts.length; ht += 1) {
				var host = hosts[ht];
				var stores = [host.list, host.workspaces, host];
				for (var st = 0; st < stores.length; st += 1) {
					var items = workspaceItemsOf(stores[st]);
					if (items === undefined || !Array.isArray(items)) continue;
					for (var at = 0; at < items.length; at += 1) {
						var row = items[at];
						if (!row || !Array.isArray(row.sessionIds)) continue;
						if (row.sessionIds.indexOf(sessionId) === -1) continue;
						var value = pathOfWorkspaceRow(row);
						if (value !== undefined) return value;
					}
				}
			}
			return undefined;
		}

		/**
		 * 从一个「工作区 store / 列表 / 数组」里取出 item 集合。
		 *
		 * @param store - 可能是 store、列表、数组或映射。
		 * @returns 数组或 `{id: row}` 映射；取不到就 `undefined`。
		 */
		function workspaceItemsOf(store) {
			if (store === undefined || store === null) return undefined;
			var list;
			if (typeof store.getSnapshot === 'function') {
				try { list = store.getSnapshot(); } catch (error) { return undefined; }
			} else if (typeof store.list === 'function') {
				try { list = store.list(); } catch (error) { return undefined; }
			} else if (Array.isArray(store)) {
				list = store;
			} else {
				return undefined;
			}
			if (list === undefined || list === null) return undefined;
			// 官方快照是 `{items, …}`；也兼容直接给数组或 `{byId}`。
			if (Array.isArray(list)) return list;
			if (Array.isArray(list.items)) return list.items;
			if (list.byId !== undefined && list.byId !== null) return list.byId;
			return undefined;
		}

		/**
		 * 取一行工作区的路径（按几个候选字段名试）。
		 *
		 * @param row - 工作区行。
		 * @returns 路径；没有就 `undefined`。
		 */
		function pathOfWorkspaceRow(row) {
			if (row === undefined || row === null) return undefined;
			var keys = ['path', 'cwd', 'root', 'directory'];
			for (var kt = 0; kt < keys.length; kt += 1) {
				var value = row[keys[kt]];
				if (typeof value === 'string' && value !== '') return value;
			}
			return undefined;
		}

		/**
		 * 调宿主桥的一条 RPC（令牌只在引擎进程里，浏览器侧不持有）。
		 *
		 * @param method - 方法名。
		 * @param params - 参数。
		 * @returns 结果的 Promise。
		 */
		function bridge(method, params) {
			return fetch(ROUTE_RPC, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ method: method, params: params || {} }),
			}).then(
				(res) => res.json(),
				(error) => {
					throw new Error('无法连接本地桥: ' + String((error && error.message) || error));
				},
			).then((payload) => {
				if (!payload || payload.ok !== true) {
					throw new Error((payload && payload.error) || '本地桥调用失败');
				}
				return payload.result;
			});
		}

		/** 从任意形状的目录列表里取条目数组（宿主/官方后端的字段名略有差异）。 */
		function entriesOf(listing) {
			if (!listing || typeof listing !== 'object') return [];
			if (Array.isArray(listing.entries)) return listing.entries;
			if (Array.isArray(listing.items)) return listing.items;
			return [];
		}

		/** 取条目的显示名。 */
		function nameOf(entry) {
			return entry.name || entry.title || entry.displayName || String(entry.path || '');
		}

		/** 取条目的完整路径。 */
		function pathOf(entry) {
			return entry.path || entry.fullPath || entry.name || '';
		}

		/** 是否是可进入的文件夹。 */
		function isDir(entry) {
			if (entry.enterable === false) return false;
			if (entry.isDirectory === false) return false;
			return true;
		}

		/**
		 * 是否是隐藏条目（名字以 `.` 开头）。
		 *
		 * ⚠️ **只按名字判断，不要去看属性位**：电脑端返回的条目只有
		 * `{name, path, isDirectory, enterable}`，没有 Windows 的「隐藏」属性，
		 * 而用户说的「前面带 `.` 的文件夹比如 `.dsh`」正是这一种。
		 *
		 * @param entry - 目录条目。
		 * @returns 是否应归入「默认不显示」。
		 */
		function isHidden(entry) {
			var name = nameOf(entry);
			return name.length > 0 && name.charAt(0) === '.';
		}

		/** 取列表的当前路径与上级路径。 */
		function locationOf(listing) {
			var path = (listing && listing.path) || '';
			var parent = (listing && listing.parent) || '';
			// 后端明确给空 parent = 已经到顶了（Linux 的 `/`、Windows 的 `C:\`），
			// 这时**不能**再自己兜底推算：切 `C:\` 会得到 `C:`，而它在前端眼里
			// 也是绝对路径、按钮会被点亮，点下去后端直接报错。
			var atRoot = path === '' || path === '/' || /^[a-zA-Z]:[\\/]?$/.test(path);
			if (parent === '' && !atRoot) {
				var trimmed = path.replace(/[\\/]+$/, '');
				var slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
				if (slash > 0) parent = trimmed.slice(0, slash);
			}
			return { path: path, parent: parent, home: (listing && listing.home) || '' };
		}

		/**
		 * 「选择工作区目录」对话框：手机 / 电脑 双页签。
		 *
		 * props 是 slot 契约的 `{open, busy, onPicked, onCancel, onError}`，
		 * 外加 `inject` 送进来的浏览能力与宿主桥。
		 */
		function RemoteDirectoryFlow(props) {
			var open = props.open;
			var onPicked = props.onPicked;
			var onCancel = props.onCancel;
			var listDirectory = props.listDirectory;
			var createDirectory = props.createDirectory;
			var openSession = props.openSession;
			/** 把宿主刚建好的会话登记进本地列表（见 `settleLocal`）。 */
			var registerLocal = props.registerLocal;
			/** 兜底：拉一次全量会话列表（登记失败时用）。 */
			var refreshSessions = props.refreshSessions;
			/** 把会话标记成「电脑的」（cwd 还没进列表行时兜底，见 `isRemoteSession`）。 */
			var markRemote = props.markRemote;
			/** 重拉一次镜像工作区 slug 集合（新建镜像工作区之后必须调）。 */
			var refreshMirrorSlugs = props.refreshMirrorSlugs;
			/** 解绑后把所有会话退回「本地」。 */
			var clearRemote = props.clearRemote;

			var statePair = react.useState({
				tab: 'local',
				path: null,
				listing: null,
				loading: false,
				error: null,
				// 选完目录后「正在建手机本地会话」的防重入标记（见 `openDesktop`）。
				// 这一步现在不联网，所以基本看不到；留着是因为 `sessionController.create`
				// 与 `attachSession` 仍是两次本地 IO，连点两下会重复建会话。
				creating: false,
				// 是否显示 `.` 开头的隐藏文件夹。默认关 —— 电脑的项目根目录里
				// `.dsh`、`.git`、`.vscode` 一堆，全列出来会把真正的项目目录淹掉。
				showHidden: false,
			});
			var state = statePair[0];
			var setState = statePair[1];

			/**
			 * 配对状态（与目录浏览无关，所以单独一个 state）。
			 *
			 * `endpoint === null` 表示还没查过；`paired === false` 表示
			 * 手机还没有任何凭据（令牌为空），需要用户去电脑上取一个配对码。
			 */
			var pairPair = react.useState({
				endpoint: null,
				paired: false,
				code: '',
				busy: false,
				// 「重新配对」的两步确认：`true` 时才显示「确定解绑 / 取消」。
				confirming: false,
				message: null,
				// 一键刷新（模型 / 预设 / 目录树）的状态与回执。
				refreshing: false,
				refreshNote: null,
			});
			var pairState = pairPair[0];
			var setPairState = pairPair[1];

			var patchPair = react.useCallback(function (next) {
				setPairState(function (prev) {
					return Object.assign({}, prev, next);
				});
			}, []);

			var patch = react.useCallback(function (next) {
				setState(function (prev) {
					return Object.assign({}, prev, next);
				});
			}, []);

			var aliveRef = react.useRef(true);
			react.useEffect(function () {
				aliveRef.current = true;
				return function () {
					aliveRef.current = false;
				};
			}, []);

			/**
			 * ## 请求令牌 —— 专治「切到电脑页签，却先闪一下手机的目录」
			 *
			 * ### 真机实测到的现象
			 *
			 * DockerCDP 直连页面世界实测（点「手机」→ 60ms 后点「电脑」）：
			 * `innerText` 在 16/146/167ms 三次变化，而 1521ms 时对话框里显示的
			 * 竟是 **`/data/user/0/com.dsh.android/files/home` + 应用目录 / 手机存储**
			 * —— 那是**手机页签**的内容，用户点的却是「电脑」。
			 *
			 * ### 根因
			 *
			 * 下面那个 `listItems` effect 的 `.then()` 里只检查了 `aliveRef`
			 * （组件还在不在），**没有检查这次请求发起时的页签是不是还是当前页签**。
			 *
			 * 于是：点「手机」→ 发起 `listDirectory`（本地，几十 ms）→ 用户立刻点
			 * 「电脑」→ effect 重跑，`desktopDirCache['']` 命中，**当场就把电脑列表
			 * patch 上去了** → 但手机那次请求的 promise 随后 resolve，它的
			 * `.then` 又 `patch({listing: 手机内容})`，把电脑列表**覆盖掉**。
			 *
			 * 结果就是用户看到的「点电脑还要转一下」：不是没有缓存，而是缓存刚铺好
			 * 就被上一个页签的迟到响应盖住了。
			 *
			 * ### 修法
			 *
			 * 每次 effect 执行时递增令牌，异步回来时令牌对不上就**直接丢弃**。
			 * 这比在 `.then` 里读 `state.tab` 可靠：闭包里的 `tab` 是发起时的值，
			 * 拿它跟「当前值」比需要额外的 ref，而令牌天然就是发起顺序。
			 */
			var loadTickRef = react.useRef(0);

			/**
			 * 让官方前端的模型目录**失效重载**。
			 *
			 * ## ⚠️ 这一步为什么不能省
			 *
			 * 官方 `ModelCatalogDirectory` 在页面加载时就 `load()` 一次并进入
			 * `status === 'ready'`，此后**点菜单一个请求都不发**
			 * （`dsh-client-ui-model-selection/lib/client.js:100`：ready 时直接
			 * 返回旧值）。所以「配对之后模型列表变成电脑的」这件事，只把宿主那边的
			 * 缓存换掉是**看不见的** —— 前端那一层永远捧着配对前拉到的手机列表。
			 *
			 * 这正是用户报的「预设列表正确地加载了电脑预设，但模型列表还是没同步」：
			 * 预设走 `remoteExportList`，**没有缓存层**、每次重读，所以它是对的。
			 *
			 * `modelDirectories` 是官方那个服务实例（`super(ctx, "modelDirectories")`），
			 * `.catalog.refresh()` 就是官方在 `llm/adapters-updated` 时走的同一条路 ——
			 * 走公开方法，不碰前端 bundle 内部类。
			 *
			 * `ctx.get` 拿不到服务时静默跳过（见 `injected()` 里 `modelDirectories`
			 * 的注释）：最坏是回到「要点一下刷新按钮」的旧行为，不会报错。
			 */
			var reloadModelCatalog = function () {
				try {
					var models = props.modelDirectories;
					if (models && models.catalog && typeof models.catalog.refresh === 'function') {
						models.catalog.refresh();
					}
				} catch (error) {
					/* 服务结构变了就只更新宿主缓存，不打扰用户 */
				}
			};

			// 每次打开都回到「手机」页签，避免上次停在电脑目录造成困惑。
			react.useEffect(
				function () {
					if (open) patch({ tab: 'local', path: null, error: null });
				},
				[open, patch],
			);

			// 打开时查一次配对状态（只查一次，失败也不打扰用户 —— 未配对
			// 本来就是这个流程的正常起点）。
			react.useEffect(
				function () {
					if (!open) return undefined;
					bridge('pairStatus', {}).then(
						function (result) {
							if (!aliveRef.current) return;
							patchPair({ endpoint: result.endpoint, paired: result.paired === true });
						},
						function () {
							/* 查不到就不显示那一条，用户仍然可以输码 */
						},
					);
					return undefined;
				},
				[open, patchPair],
			);

			// 加载当前页签、当前路径的目录列表。
			var tab = state.tab;
			var path = state.path;
			react.useEffect(
				function () {
					// ⚠️ 令牌**必须在最早处**递增：连下面这些 early-return 的路径
					// 也要把在飞的旧请求作废（见 `loadTickRef` 的注释）。
					var tick = ++loadTickRef.current;
					if (!open) return undefined;
					// ⚠️ **没配对就别去问电脑要目录**。未配对时手机没有任何凭据，
					// 打过去必然是 401/502 —— 用户看到的是转圈 10 秒后一句
					// 「远程请求失败」，完全不知道要先去配对。这里直接给出可操作的提示。
					if (tab === 'desktop' && pairState.paired !== true) {
						patch({ loading: false, listing: null, error: null });
						return undefined;
					}
					// ⚠️ **电脑目录命中缓存就直接铺回去，不打桥**（用户报障：来回点文件夹
					// 每次都重新加载）。缓存键用 `''` 表示根，与 `listDesktop` 的入参一致。
					if (tab === 'desktop') {
						var key = path === null ? '' : path;
						var hit = desktopDirCache[key];
						if (hit !== undefined) {
							patch({ loading: false, listing: hit, error: null });
							return undefined;
						}
					}
					patch({ loading: true, error: null });
					var load =
						tab === 'desktop'
							? bridge('listDesktop', path === null ? {} : { path: path })
							: Promise.resolve(listDirectory(path === null ? undefined : path));
					load.then(
						function (listing) {
							if (!aliveRef.current) return;
							// ⚠️ 用户已经切了页签 / 换了目录 ⇒ 这次结果作废，
							// 否则会把新页签刚铺好的列表覆盖成上一个页签的内容
							// （这就是「点电脑先闪手机目录」的根因，见 `loadTickRef`）。
							if (loadTickRef.current !== tick) return;
							if (tab === 'desktop') {
								desktopDirCache[path === null ? '' : path] = listing;
							}
							patch({ loading: false, listing: listing });
						},
						function (reason) {
							if (!aliveRef.current) return;
							if (loadTickRef.current !== tick) return;
							// ⚠️ 失败**要清掉这一格缓存**：留着的话用户再点进来会看到
							// 上一次的旧内容，而以为自己看的是电脑现状。
							if (tab === 'desktop') delete desktopDirCache[path === null ? '' : path];
							patch({
								loading: false,
								listing: null,
								error: String((reason && reason.message) || reason),
							});
						},
					);
					return undefined;
				},
				[open, tab, path, listDirectory, patch, pairState.paired],
			);

			if (!open) return null;

			var loc = locationOf(state.listing);
			// `.` 开头的默认不显示（见 `isHidden`）；开关在面包屑那一行。
			var allDirs = entriesOf(state.listing).filter(isDir);
			var hiddenCount = allDirs.filter(isHidden).length;
			var entries = state.showHidden === true ? allDirs : allDirs.filter(function (e) { return !isHidden(e); });

			var switchTab = function (next) {
				if (next === state.tab) return;
				// ⚠️ **同一帧内就把缓存铺上去**。原来是先 `patch({listing: null})`
				// 再等下面那个 effect 去查缓存 —— 中间必然渲染出一帧**空列表**，
				// 用户看到的就是「点电脑闪一下才出来」。缓存命中时这里直接给值，
				// 一帧都不空。
				var cached = next === 'desktop' ? desktopDirCache[''] : undefined;
				patch({
					tab: next,
					path: null,
					listing: cached === undefined ? null : cached,
					error: null,
				});
			};

			/** 「手机」页签：采纳为本地工作区。 */
			var pickLocal = function () {
				if (loc.path === '') return;
				// ⚠️ **必须清掉电脑那条兜底**（见 `pendingWorkspaceCwd`）：用户从
				// 电脑工作区切回手机默认工作区时，若不清，模型/预设会继续按
				// 「电脑」筛 —— 正是用户报的「切回默认工作区，预设和模型都没改回来」。
				setPendingWorkspace(null);
				onPicked(loc.path);
			};

			/**
			 * 提交配对码。
			 *
			 * 成功后**必须重拉一次目录列表**：配对的当下 `listDesktop` 是失败的
			 * （那时还没配对），而上面那个 effect 的依赖里有 `paired`，
			 * 状态一变它自己就会重跑 —— 这里只需要把 `paired` 翻过来。
			 */
			var submitPair = function () {
				var code = pairState.code.trim();
				if (code === '' || pairState.busy) return;
				patchPair({ busy: true, message: null });
				bridge('pair', { code: code }).then(
					function (result) {
						if (!aliveRef.current) return;
						patchPair({
							busy: false,
							paired: true,
							endpoint: result.endpoint,
							code: '',
							message: { kind: 'ok', text: '配对成功，正在连接电脑…' },
						});
						// ⚠️ 换了一台电脑，旧缓存里的路径完全无效（甚至同名不同机）——
						// 必须作废，否则用户会看到上一台电脑的目录。
						clearDesktopDirCache();
						patch({ path: null, listing: null });
						// ⚠️ 前端那份模型目录是**永久缓存**的（见 `reloadModelCatalog`），
						// 不作废的话用户接下来看到的仍然是配对前那份手机模型列表 ——
						// 就是用户报的「模型列表还是没同步」。
						reloadModelCatalog();
						// ⚠️ **镜像工作区 slug 集合也要重拉**：换一台电脑后 `workspaceMap`
						// 是另一份（slug 由电脑路径哈希得来，同名不同机 slug 不同）。
						// 不重拉的话，新电脑的镜像工作区会被判成「本地」—— 又是那个 bug。
						if (refreshMirrorSlugs !== undefined) refreshMirrorSlugs();
					},
					function (reason) {
						if (!aliveRef.current) return;
						patchPair({
							busy: false,
							message: { kind: 'error', text: String((reason && reason.message) || reason) },
						});
					},
				);
			};

			/**
			 * 解除配对：清掉本地凭据，退回未配对状态。
			 *
			 * 成功后 `paired` 翻回 `false`，配对条自己就会换成输入框（同一个
			 * `pairState`），所以这里不用手工重挂组件。
			 */
			var submitUnpair = function () {
				if (pairState.busy) return;
				patchPair({ busy: true, message: null });
				bridge('unpair', {}).then(
					function (result) {
						if (!aliveRef.current) return;
						patchPair({
							busy: false,
							confirming: false,
							paired: false,
							endpoint: result.endpoint,
							code: '',
							message: { kind: 'ok', text: '已解绑，请到电脑上生成新的配对码' },
						});
						// 解绑后旧凭据作废，缓存里的目录不该再露出来。
						clearDesktopDirCache();
						// ⚠️ **同时清掉「电脑会话」标记**：解绑后电脑已经不在了，
						// 那些会话退回普通本地会话（宿主 `unpair` 也清了
						// `remoteSessions`）。留着标记的话，模型菜单会一直显示
						// 电脑的模型，而消息其实发给了手机本地。
						if (clearRemote !== undefined) clearRemote();
						patch({ path: null, listing: null });
					},
					function (reason) {
						if (!aliveRef.current) return;
						patchPair({
							busy: false,
							message: { kind: 'error', text: String((reason && reason.message) || reason) },
						});
					},
				);
			};

			/**
			 * 已配对时的「重新配对」入口。
			 *
			 * ⚠️ **这是必需的回退路径，不是便利功能。** 电脑端一旦「解绑」，它会换掉
			 * 令牌并停掉隧道；而手机这边 `mobile.json` 里还留着旧令牌，`pairStatus`
			 * 会一直报「已配对」，于是输入框永远不渲染 —— 用户卡在 502，界面上无路
			 * 可走，只能手工删 `mobile.json` 或清 App 数据。补上这个入口，回退才闭环。
			 *
			 * 两步确认：解绑会停隧道、清远程会话清单，误触代价太大。
			 */
			var unpairControls = function () {
				if (pairState.confirming !== true) {
					return h(
						Button,
						{
							// ⚠️ 用 `outline` 而不是 `ghost`：ghost 在浅色面板上没有边框，
							// 真机截图里「重新配对」看起来就是一行灰字，用户认不出可点 ——
							// 而这是电脑解绑后唯一的回退入口，必须一眼看出来。
							variant: 'outline',
							size: 'sm',
							onClick: function () {
								patchPair({ confirming: true, message: null });
							},
							disabled: pairState.busy,
						},
						'重新配对',
					);
				}
				return h(
					'span',
					{ style: CSS.pairConfirm },
					h('span', { style: CSS.pairConfirmText }, '解绑后这台手机要重新输入配对码。'),
					h(
						Button,
						{
							variant: 'outline',
							size: 'sm',
							onClick: submitUnpair,
							disabled: pairState.busy,
						},
						pairState.busy ? '解绑中…' : '确定解绑',
					),
					h(
						Button,
						{
							variant: 'ghost',
							size: 'sm',
							onClick: function () {
								patchPair({ confirming: false });
							},
							disabled: pairState.busy,
						},
						'取消',
					),
				);
			};

			/**
			 * 一键刷新：把「模型 / 预设 / 目录树」三样一起重新拉一遍。
			 *
			 * 用户需求原文：「你只需要添加一个手动刷新…这三个地方的数据都可以在
			 * 选择工作区的时候，那个刷新按钮直接一键刷新这三个位置。」
			 *
			 * ⚠️ 光调桥拉数据**不够**：官方前端的模型目录是**带缓存**的
			 * （`ModelCatalogDirectory.load()` 在 `status === 'ready'` 时直接返回旧值，
			 * 见 `dsh-client-ui-model-selection/lib/client.js:100`）。所以拉完还要
			 * 让它失效重载，否则用户看到的是「点了刷新，列表没变」。
			 *
			 * `modelDirectories` 是官方那个服务的名字（`super(ctx, "modelDirectories")`），
			 * 它的 `.catalog.refresh()` 正是官方在 `llm/adapters-updated` 时走的那条路 ——
			 * 走服务实例的公开方法，不碰前端 bundle 内部类。
			 *
			 * 预设名单没有等价的服务实例（官方预设前端不是 Service），它每次
			 * 打开会话/设置面板都会重读，所以这里只更新宿主缓存即可。
			 */
			var refreshAll = function () {
				if (pairState.refreshing) return;
				patchPair({ refreshing: true, refreshNote: null });
				var target = state.tab === 'desktop' ? loc.path : '';
				// ⚠️ **只作废「当前这一层」，不再整棵清空**。
				//
				// 原来这里是 `clearDesktopDirCache()`，代价是刷新一下就把用户攒下的
				// 全部子目录缓存清零 —— 之后**每一次点文件夹、每一次返回上一级**
				// 都要重新过隧道（实测 700～1200ms）。用户实测原话：
				// 「我先是点了一下刷新，刷新成功之后，我再点击某个文件夹，
				// 它里面的内容还是要加载」「返回上一级也要加载」。
				// 删掉当前这一格既保证这次一定拿到新列表，也不牵连其它层。
				if (target === '') delete desktopDirCache[''];
				else delete desktopDirCache[target];
				bridge('refreshAll', target === '' ? {} : { path: target }).then(
					function (result) {
						if (!aliveRef.current) return;
						// 目录树：直接把新列表铺回去（正在看的这一层），并写回缓存。
						// ⚠️ **必须同时把 `loading` 置回 false**：原来只 patch 了
						// `listing`，于是刷新成功后界面一直挂着「加载中…」——
						// 用户看到的就是「刷新完了还在加载」。
						if (result && result.directory && result.directory.ok) {
							desktopDirCache[target === '' ? '' : target] = result.directory.value;
							patch({ loading: false, listing: result.directory.value, error: null });
						} else {
							patch({ loading: false });
						}
						// 模型：让官方目录失效重载，下一次打开菜单就是电脑的。
						if (result && result.models && result.models.ok) {
							try {
								var models = props.modelDirectories;
								if (models && models.catalog && typeof models.catalog.refresh === 'function') {
									models.catalog.refresh();
								}
							} catch (error) {
								/* 服务结构变了就只更新宿主缓存，不打扰用户 */
							}
						}
						var failed = [];
						if (result && result.models && !result.models.ok) failed.push('模型');
						if (result && result.presets && !result.presets.ok) failed.push('预设');
						if (result && result.directory && !result.directory.ok) failed.push('目录');
						patchPair({
							refreshing: false,
							refreshNote: failed.length > 0
								? { kind: 'error', text: failed.join('、') + '刷新失败，其余已更新' }
								: { kind: 'ok', text: '模型、预设、目录已刷新' },
						});
					},
					function (reason) {
						if (!aliveRef.current) return;
						patchPair({
							refreshing: false,
							refreshNote: { kind: 'error', text: String((reason && reason.message) || reason) },
						});
					},
				);
			};

			/**
			 * 「电脑」页签顶部的配对条。
			 *
			 * 已配对时只显示「连的是哪台电脑」，不显示令牌（令牌只在引擎进程里）。
			 * 未配对时给一个输入框 —— **手输是主路径**：手机 App 的
			 * `onPermissionRequest` 只放行录音权限，摄像头一律拒绝，
			 * 页面里拿不到 `getUserMedia`，扫二维码这条路走不通。
			 */
			var pairBar = h(
				'div',
				{ style: CSS.pairBar },
				pairState.paired === true
					? h(
							'span',
							{ style: CSS.pairWho, title: pairState.endpoint || '' },
							'已配对：' + (pairState.endpoint || ''),
						)
					: h(
							'span',
							{ style: CSS.pairWho },
							'还没配对。请在电脑的「设置 → 手机远程」里生成 6 位配对码，填在这里。',
						),
				pairState.paired === true
					? unpairControls()
					: h(Input, {
							value: pairState.code,
							onChange: function (event) {
								patchPair({ code: event.target.value.toUpperCase() });
							},
							onKeyDown: function (event) {
								if (event.key === 'Enter') submitPair();
							},
							placeholder: '6 位配对码',
							'aria-label': '配对码',
							maxLength: 8,
							// ⚠️ 直接给对象：`CSS` 在模块加载时已就地转成对象了
							//（见上面那个 `for (var styleKey in CSS)`），
							// 再套一层 `toStyle()` 会得到 `[object Object]`。
							style: CSS.pairInput,
						}),
				pairState.paired === true
					? null
					: h(
							Button,
							{
								variant: 'outline',
								size: 'sm',
								onClick: submitPair,
								disabled: pairState.busy || pairState.code.trim() === '',
							},
							pairState.busy ? '配对中…' : '配对',
						),
			);

			var pairMsg = pairState.message === null
				? null
				: h(
						'div',
						{
							// 同上：`CSS` 已是对象，直接拼对象即可。
							style: pairState.message.kind === 'ok'
								? Object.assign({}, CSS.pairMsg, CSS.pairOk)
								: CSS.pairMsg,
							role: pairState.message.kind === 'ok' ? undefined : 'alert',
						},
						pairState.message.text,
					);

			/**
			 * 「电脑」页签：把这个电脑目录选为本次新对话的工作区。
			 *
			 * ## 为什么和「手机」页签用同一个出口（用户原话）
			 *
			 * 「我觉得像手机那边的直接先选择文件夹，这个设计是非常好的，因为你单纯的
			 *  选文件夹的话，你就不用考虑跟电脑那边同步的问题了，完全可以等用户他
			 *  真正的点击发送信息按钮之后，才把选择的模型以及选择的预设，以及选择的
			 *  工作区同步到电脑上面，这样全程就仅需要从电脑那边沟通一次」
			 *
			 * ## 关键：**仍然要经宿主建一条手机本地会话**
			 *
			 * 上面那些话的意思是「别在电脑上建会话」，**不是**「手机这边什么都不做」。
			 * 宿主 `createSession` 桥现在做的全是**本地**动作：
			 *
			 *   1. `ensureDesktopWorkspace()` 建/复用一个**手机本地的镜像目录**当 cwd，
			 *      并把 `slug → 电脑路径` 登记进 `workspaceMap`（这一步是整套远程
			 *      逻辑的锚点，少了它 `desktopPathOfMirror` 就反查不出电脑路径）；
			 *   2. `sessionController.create()` 建一条**手机本地会话**（前端要能打开它、
			 *      侧边栏要能看到它、`agentPreset` 投影要有个宿主）。
			 *
			 * 这两步都是纯本地 IO，**不联网**。真正被去掉的是原来那趟
			 * `callRemote('createSession')`（1～3 秒隧道往返）。
			 *
			 * 所以点下去**立刻**收起、立刻跳到会话，网络延迟完全不参与；电脑那边
			 * 真正建会话推迟到第一条消息，且与消息**打包在同一个请求**里
			 *（见宿主 `prompt` 拦截器与 `pendingPlans`）。
			 *
			 * ## 为什么不能改成 `onPicked(loc.path)` 直接把电脑路径交给官方
			 *
			 * 官方的 `onPicked(path)` 落地成
			 * `WorkspacePickFlow.adoptDirectory(path)` → `createWorkspace({ path })`
			 *（`dsh-client-ui-workspace/lib/client.js:1154`），而
			 * `WorkspaceRegistry.create()` 开头就是
			 * `realpathNormalize(path)` + `stat(canonical)`，**路径必须已经存在**
			 * （`dsh-workspace/lib/index.js:365`）。电脑路径 `C:\…` 在 Android 上
			 * 既不是绝对路径也不存在 ⇒ 抛错 ⇒ 选择器保持不变、也没有任何提示。
			 *
			 * 这正是 1.0.62 真机上「选完还是『选择工作区』」的成因，别改回去。
			 *
			 * ⚠️ 收起之后本组件就卸载了，所以下面**不能再依赖 `aliveRef` / `patch`**
			 * （原来每一层都在判 `aliveRef.current`，一收起就全部短路，会话也就
			 * 永远打不开）。`settleLocal` / `setPendingWorkspace` / `openSession`
			 * 都是外部函数，与组件生命周期无关，卸载后照常可调。
			 *
			 * ⚠️ 失败时界面上已经没有地方提示了。但这条路径现在**几乎不会失败**：
			 * 去掉那趟联网之后，剩下的全是本地建目录 + 本地建会话。真正的失败点
			 *（电脑离线）被推迟到了发消息那一刻，那时用户正看着输入框，能正常报错。
			 */
			var openDesktop = function () {
				if (loc.path === '' || state.creating) return;
				var dirPath = loc.path;
				patch({ creating: true, error: null });
				// ⚠️ **不要在这里 `onCancel()`**：下面要拿 `onPicked(镜像目录)` 让官方
				// 流程把「工作区选择器」改写成镜像目录的标题，并**停在新建对话主界面**。
				// 先收起的话组件就卸载了，`onPicked` 也就没得调。
				bridge('createSession', { path: dirPath }).then(
					function (result) {
						patch({ creating: false });
						// ⚠️ **把镜像目录交给官方 `onPicked`**，而不是 `openSession`。
						//
						// 用户对界面的要求原话：「选完文件夹之后，它界面其实还是在我们
						// 新建对话的主界面的，只是工作区那个选择器的名字改了而已」。
						// `openSession(id)` 会**跳到会话页**，那就不对了 —— 而且电脑上的
						// 会话此刻还没建出来，跳过去也只是一条空会话。
						//
						// `onPicked(镜像目录)` 走的是官方「手机页签选目录」同一条路：
						// `adoptDirectory(path)` → `createWorkspace({ path })`，它要求
						// `path` **是手机本地已存在的目录**，所以这里必须传宿主回执里的
						// `cwd`（镜像目录），**绝不能传电脑路径**（见上面那段注释）。
						//
						// 成功后官方把工作区选择器改成这个工作区、留在当前首页，
						// 与「手机页签选目录」的观感完全一致 —— 这就是用户要的「无感」。
						if (onPicked !== undefined && result && typeof result.cwd === 'string' && result.cwd !== '') {
							// ⚠️ **`pendingWorkspaceCwd` 必须存镜像目录**，不能存电脑路径：
							// 它下面要和 `workspace.path`（真实工作区路径）比对来判定
							// 「这是不是电脑工作区」（见 `pendingWorkspaceCwd` 的注释）。
							// 存电脑路径的话永远比不中，模型/预设菜单就会退回手机那一套。
							setPendingWorkspace(result.cwd);
							// ⚠️ **必须重拉镜像 slug 集合**：宿主刚为这个电脑目录建好（或复用）
							// 镜像工作区，`workspaceMap` 里**刚多出一条**。前端那份集合是快照，
							// 不重拉的话这个工作区会被判成「本地」—— 模型菜单显示手机模型，
							// 而消息其实要发到电脑上，用户看到的是「选的模型没生效」。
							// （`settleLocal` 里也有同一步，这条路径跳过了它，所以补在这里。）
							if (refreshMirrorSlugs !== undefined) refreshMirrorSlugs();
							onPicked(result.cwd);
							return;
						}
						// 兜底（宿主没给 cwd 时）：退回「收起 + 打开会话」的老路。
						onCancel();
						return settleLocal(result).then(function () {
							if (openSession !== undefined && result && result.sessionId) {
								try {
									openSession(result.sessionId);
								} catch (openError) {
									// 已经收起，没地方提示；宿主日志里有更详细的原因。
								}
							}
						});
					},
				).then(null, function (reason) {
					// ⚠️ **失败必须把 `creating` 复位**，否则按钮永久禁用 —— 1.0.64
					// 真机上就是这个症状：桥里抛了 `pendingPlans is not defined`，
					// 前端看到的是「点了没反应，再点也点不动、选择器还开着」。
					patch({ creating: false, error: String((reason && reason.message) || reason) });
					// 留一份现场给排查用（与 1.0.62 的 `window.__dshCreate` 同一个位）。
					window.__dshCreate = {
						at: Date.now(),
						path: dirPath,
						failed: String((reason && reason.message) || reason),
					};
				});
			};

			/**
			 * 把宿主刚建好的会话**登记进本地会话列表**。
			 *
			 * ⚠️ **这一步不能省，而且必须在 `openSession` 之前完成。**
			 *
			 * `uiWorkspace.openSession(id)` 最终走
			 * `SessionManager.resolveTarget(id)`，它有**三道**身份检查，全不过就抛
			 * `sessions.retain: unknown session <id>`：
			 *
			 * 1. `sessions.has(id)` —— 已物化的客户端实例；
			 * 2. `summaries.some(...)` —— 客户端列表快照；
			 * 3. `addresses` —— 子 agent 地址。
			 *
			 * 而会话是**宿主**建的，客户端只能靠 `api-session/added` 这条**异步推送**
			 * 知道它 —— RPC 的响应会先到。所以直接在 RPC 回执里 `openSession()`
			 * 是**必然的竞态**：抛出的异常还被 `openSession()` 同步吞掉，界面
			 * 只表现为「点完没反应、又回到默认工作区」，控制台一句错都没有。
			 *
			 * 正解是走官方 client 自己的 `sessions.create({sessionId, cwd})`：
			 * `SessionManager.create()` 在 RPC 返回后立刻
			 * `recordMutation({kind:'placeholder'})` 把这一行写进列表快照，
			 * 于是 `openSession()` 当场就能解析到它。
			 *
			 * 幂等性是安全的：宿主侧已经建过这个 id，`createOrAdopt` 看到
			 * `agents.get(sessionId)` 活着就直接返回它，不会重复建、也不会撞 cwd。
			 *
			 * `cwd` 由宿主回执带回（手机本地的工作区路径，不是电脑路径）——
			 * 两端各自的 cwd 互不相通，只在 `sessionId` 上对齐。
			 *
			 * @param result - 宿主 `createSession` 的回执 `{sessionId, cwd}`。
			 * @returns 登记完成的 Promise（失败也 resolve，交由调用方决定下一步）。
			 */
			var settleLocal = function (result) {
				if (!result || typeof result.sessionId !== 'string') return Promise.resolve();
				// ⚠️ **先标记「这是电脑的」再登记**：列表行的 `cwd` 要等宿主那一行
				// 回来才带上，之前那几帧判据读不到 cwd，靠这个标记兜住。
				if (markRemote !== undefined) markRemote(result.sessionId);
				// ⚠️ **重拉镜像工作区 slug 集合**：宿主刚为这个电脑目录建好（或复用）
				// 镜像工作区，`workspaceMap` 可能**刚多出一条**。前端那份集合是快照，
				// 不重拉的话这个工作区在侧边栏里点进去仍被判成「本地」。
				if (refreshMirrorSlugs !== undefined) refreshMirrorSlugs();
				var local = registerLocal === undefined
					? Promise.resolve()
					: Promise.resolve(registerLocal(result.sessionId, result.cwd)).then(null, function () {
							// 登记失败（例如 `session/writer-held`）：退一步拉全量列表，
							// 宿主那一行仍然会进来，`openSession` 同样能解析。
							return refreshSessions === undefined ? null : Promise.resolve(refreshSessions()).then(null, function () { return null; });
						});
				return local;
			};

			var makeFolder = function () {
				if (loc.path === '' || createDirectory === undefined) return;
				var name = window.prompt('文件夹名称', '新建文件夹');
				if (name === null || name === '') return;
				Promise.resolve(createDirectory(loc.path, name)).then(
					function () {
						if (aliveRef.current) patch({ path: loc.path });
					},
					function (reason) {
						if (aliveRef.current) {
							patch({ error: String((reason && reason.message) || reason) });
						}
					},
				);
			};

			var rows = entries.map(function (entry) {
				var full = pathOf(entry);
				return h(
					'button',
					{
						key: full,
						type: 'button',
						style: CSS.row,
						onClick: function () {
							patch({ path: full });
						},
					},
					// ⚠️ 图标组件只解构 `size/className/strokeWidth`，**不透传 `style`**
					// —— 上色要靠外层 span（官方图标本来就是 currentColor 描边）。
					h('span', { style: CSS.rowIcon }, h(IconFolderCloseRegular, { size: 16 })),
					h('span', { style: CSS.rowName }, nameOf(entry)),
					h('span', { style: CSS.rowChevron }, h(IconChevronRightOutlineRegular, { size: 12 })),
				);
			});

			var body = h(
				'div',
				{ style: CSS.editorScope },
				// —— 头部：标题 + 页签 + 路径行 ——
				h(
					'div',
					{ style: CSS.header },
					h('h2', { style: CSS.title }, '选择工作区目录'),
					h(SegmentedTabs, {
						label: '目录来源',
						value: state.tab,
						onChange: switchTab,
						items: [
							{ value: 'local', label: '手机' },
							{ value: 'desktop', label: '电脑' },
						],
					}),
					h(
						'div',
						{ style: CSS.crumbBar },
						h(
							Button,
							{
								variant: 'outline',
								size: 'sm',
								disabled: loc.parent === '',
								onClick: function () {
									patch({ path: loc.parent === '' ? null : loc.parent });
								},
							},
							'上一级',
						),
						h('span', { style: CSS.pathText, title: loc.path }, loc.path || '（根）'),
						// 有隐藏文件夹时才显示开关 —— 一个目录里没有 `.` 开头的东西
						// 却摆个开关，只会让人以为漏了什么。
						hiddenCount > 0 || state.showHidden === true
							? h(
									'button',
									{
										type: 'button',
										style: state.showHidden === true
											? Object.assign({}, CSS.crumbToggle, CSS.crumbToggleOn)
											: CSS.crumbToggle,
										title: state.showHidden === true
											? '隐藏以 . 开头的文件夹'
											: '显示 ' + hiddenCount + ' 个以 . 开头的隐藏文件夹',
										onClick: function () {
											patch({ showHidden: state.showHidden !== true });
										},
									},
									state.showHidden === true ? '隐藏 . 文件夹' : '显示 . 文件夹 (' + hiddenCount + ')',
								)
							: null,
						// 一键刷新：模型 / 预设 / 目录树。只在「电脑」页签下有意义
						//（手机页签的数据本来就来自本机，没什么可刷的）。
						state.tab === 'desktop' && pairState.paired === true
							? h(
									'button',
									{
										type: 'button',
										style: CSS.crumbToggle,
										title: '重新拉取电脑的模型列表、预设列表与当前目录',
										disabled: pairState.refreshing === true,
										onClick: refreshAll,
									},
									pairState.refreshing === true ? '刷新中…' : '刷新',
								)
							: null,
					),
				),
				// —— 主体：目录列表 ——
				h(
					'div',
					{ style: CSS.content },
					// 配对条只在「电脑」页签下出现 —— 「手机」页签跟配对无关。
					state.tab === 'desktop' ? pairBar : null,
					state.tab === 'desktop' ? pairMsg : null,
					state.tab === 'desktop' && pairState.refreshNote !== null
						? h(
								'div',
								{
									style: pairState.refreshNote.kind === 'ok'
										? Object.assign({}, CSS.refreshNote, CSS.refreshOk)
										: Object.assign({}, CSS.refreshNote, CSS.error),
									role: pairState.refreshNote.kind === 'ok' ? undefined : 'alert',
								},
								pairState.refreshNote.text,
							)
						: null,
					state.loading
						? h('div', { style: CSS.status, role: 'status' }, '加载中…')
						: h(
								'div',
								{ style: CSS.columnList },
								rows.length > 0
									? rows
									: h(
											'div',
											{ style: CSS.status },
											state.tab === 'desktop' && pairState.paired !== true
												? '配对后这里会显示电脑上的文件夹'
												: hiddenCount > 0
													? '这里只有 ' + hiddenCount + ' 个以 . 开头的隐藏文件夹'
													: '这里没有子文件夹',
										),
							),
					state.error !== null ? h('div', { style: CSS.error, role: 'alert' }, state.error) : null,
					state.tab === 'desktop'
						? h(
								'div',
								{ style: CSS.note },
								'在电脑的这个目录上开一个新对话，手机上会同步显示它的全部过程。',
							)
						: null,
				),
				// —— 底部动作栏 ——
				h(
					'div',
					{ style: CSS.footerBar },
					state.tab === 'local' && createDirectory !== undefined
						? h(
								Button,
								{
									variant: 'outline',
									icon: h(IconPlusOutlineRegular, { size: 14 }),
									onClick: makeFolder,
								},
								'新建文件夹',
							)
						: null,
					h('span', { style: CSS.footerGap }),
					h(Button, { variant: 'outline', style: CSS.footerAction, onClick: onCancel }, '取消'),
					state.tab === 'local'
						? h(
								Button,
								{
									variant: 'primary',
									style: CSS.footerAction,
									disabled: loc.path === '' || props.busy,
									onClick: pickLocal,
								},
								props.busy ? '处理中…' : '选择此文件夹',
							)
						: h(
								Button,
								{
									variant: 'primary',
									style: CSS.footerAction,
									// ⚠️ **只要选中了目录就能点**，不再要求已配对。
									//
									// 这一步现在全是本地操作（建镜像目录 + 建手机本地会话），
									// 不联网、不建电脑会话（见 `openDesktop` 的注释）。
									// 原来挂 `pairState.paired !== true` 会让没配对的人连目录
									// 都选不了；而发送时宿主本来就会因未配对退回本地并记 warn，
									// 那才是该拦住的地方。
									disabled: loc.path === '' || state.creating,
									onClick: openDesktop,
								},
								'选择此文件夹',
							),
				),
			);

			// 卡片本身（背景/圆角/阴影/遮罩/关闭按钮）全部交给官方 Modal；
			// 我们只覆盖尺寸与留白（见 DIALOG_CLASS）。`headless` 才不会
			// 再套一层官方自带的标题栏 —— 标题由我们放进 header 里。
			return h(
				Modal,
				{
					open: open,
					onClose: onCancel,
					title: '选择工作区目录',
					closeLabel: '关闭',
					className: DIALOG_CLASS,
					headless: true,
				},
				body,
			);
		}

		//#region 「同步对话」对话框

		/**
		 * 镜像工作区清单的缓存：`[{ slug, path, desktopPath, title }]`。
		 *
		 * 「同步对话」菜单要按工作区行反查电脑路径，而工作区行上只有标题，
		 * 所以拿宿主的清单来比对。刷新时机与 `refreshMirrorSlugs` 同源
		 * （选/加工作区后、以及每次 App 启动后一次）。
		 */
		var mirrorWorkspacesRef = { value: [] };
		var refreshMirrorWorkspaces = function () {
			bridge('mirrorWorkspaces', {}).then(
				function (result) {
					mirrorWorkspacesRef.value = (result && result.workspaces) || [];
				},
				function () {
					/* 拿不到就留空：菜单项会静默不出现，不影响其它功能 */
				},
			);
		};

		/**
		 * 把电脑上某个目录的历史对话**按需同步**到手机侧边栏。
		 *
		 * ## 用户需求原文
		 *
		 * 「在工作区行右侧『⋯』菜单加一项『同步对话』→ 点开弹出列表，显示电脑上
		 * 该文件夹的历史对话**只要名称** → 勾选列表，用户只勾要的（不是全同步）
		 * → 同步后出现在手机侧边栏该工作区下，**样式跟原生会话一样**」。
		 *
		 * ## 为什么「样式跟原生会话一样」是自然达成的
		 *
		 * 同步**真的**调用 `sessionController.create` 在手机本地建出会话，
		 * 并 `attachSession` 挂到该工作区的镜像目录下 —— 所以侧边栏里那一行
		 * 就是官方渲染的原生会话行，不是任何仿制品。这正是用户要的效果，
		 * 也是唯一能骗过官方侧边栏的办法（它只渲染 `workspace.sessionIds`）。
		 *
		 * ## 历史为什么不跟着搬
		 *
		 * 手机本地 session 的 seq 从 0 连续自增，装不下「电脑上第 8000 条开始的
		 * 最近 10 条」。所以历史走**按需转发**（见宿主 `controller.page` 拦截器
		 * 与 desktop 的 `readHistory`）：打开时只拉 10 条，上滑再拉。
		 * 实测最大会话全量 155 MB vs 最近 10 条 131 KB。
		 *
		 * @param props - `{ open, desktopPath, onClose, onSynced }`。
		 */
		function SyncConversationsDialog(props) {
			var open = props.open === true;
			var desktopPath = props.desktopPath || '';
			var onClose = props.onClose;
			var onSynced = props.onSynced;

			var loadedState = react.useState(false);
			var loaded = loadedState[0];
			var setLoaded = loadedState[1];
			var itemsState = react.useState([]);
			var items = itemsState[0];
			var setItems = itemsState[1];
			var pickedState = react.useState({});
			var picked = pickedState[0];
			var setPicked = pickedState[1];
			var busyState = react.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = react.useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			/**
			 * 搜索关键字。
			 *
			 * ## 为什么必须有（真机实测出来的必要功能，不是锦上添花）
			 *
			 * 用户电脑上那个 DSHAPP 目录有 **76 个对话**，全部平铺在一个滚动列表里。
			 * 想同步其中某一个，只能一路往下翻着找 —— 而列表没有排序提示、
			 * 没有搜索、也没有全选，实际用起来基本不可用。
			 *
			 * 空字符串 = 不过滤（默认全显示，保持原有行为）。
			 */
			var queryState = react.useState('');
			var query = queryState[0];
			var setQuery = queryState[1];

			// 每次打开（或换了目录）就重拉一次列表 —— 电脑上可能刚聊过新的。
			react.useEffect(
				function () {
					if (!open || desktopPath === '') return undefined;
					var alive = true;
					setLoaded(false);
					setError(null);
					setPicked({});
					bridge('listDesktopConversations', { path: desktopPath }).then(
						function (result) {
							if (!alive) return;
							var list = (result && result.sessions) || [];
							setItems(list);
							setLoaded(true);
						},
						function (reason) {
							if (!alive) return;
							setItems([]);
							setLoaded(true);
							setError(String((reason && reason.message) || reason));
						},
					);
					return function () {
						alive = false;
					};
				},
				[open, desktopPath],
			);

			var toggle = function (sessionId) {
				setPicked(function (current) {
					var next = {};
					for (var key in current) {
						if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key];
					}
					if (next[sessionId] === true) delete next[sessionId];
					else next[sessionId] = true;
					return next;
				});
			};

			var count = 0;
			for (var key in picked) {
				if (Object.prototype.hasOwnProperty.call(picked, key) && picked[key] === true) count += 1;
			}

			var submit = function () {
				if (busy || count === 0) return;
				// 先把 `sessionId → 标题` 建成一张表：`picked` 里只存了布尔值，
				// 而标题必须一起带过去（见下面 `chosen.push` 的注释）。
				var titleOf = {};
				for (var n = 0; n < items.length; n += 1) {
					var entry = items[n];
					if (entry === null || entry === undefined) continue;
					if (typeof entry.sessionId === 'string' && typeof entry.title === 'string') {
						titleOf[entry.sessionId] = entry.title;
					}
				}
				var chosen = [];
				for (var sessionId in picked) {
					if (Object.prototype.hasOwnProperty.call(picked, sessionId) && picked[sessionId] === true) {
						// ⚠️ **必须把标题一起带上**（`title`）。
						//
						// 手机端同步出来的是**空壳会话**（历史按需从电脑拉，见宿主
						// `syncConversations` 的注释），本地日志里没有 `session/title`
						// 事件，而标题投影是纯日志重放出来的
						//（`dsh-session-title/lib/index.js:177`
						// `apply: (state, event) => event.type === "session/title" ? event.data.title : state`）
						// ⇒ 投影是 `null` ⇒ 侧边栏回退成 i18n 的「未命名」。
						//
						// 宿主拿到这个 `title` 会补写一条 `session/title`，侧边栏
						// 就显示电脑上那个对话的真实名字了（用户要求）。
						var desktopTitle = titleOf[sessionId];
						chosen.push(
							typeof desktopTitle === 'string' && desktopTitle !== ''
								? { sessionId: sessionId, title: desktopTitle }
								: { sessionId: sessionId },
						);
					}
				}
				setBusy(true);
				setError(null);
				bridge('syncConversations', { path: desktopPath, items: chosen }).then(
					function (result) {
						setBusy(false);
						// ## ⚠️ 部分失败必须让用户看见（用户 2026-10-22 报障）
						//
						// 原来这里不看结果、直接关对话框。而逐条失败的原因在宿主侧
						// 只打了 `ctx.logger.warn` —— **真机上进不了 app.log** ——
						// 于是用户看到的是「点了同步 → 没反应、没报错、列表还是空的」，
						// 完全无法定位。
						//
						// 现在宿主把原因放进 `result.failures`，这里非空就**不关**
						// 对话框、把原因写在错误行里，让用户/作者都能看到到底哪一条、
						// 为什么失败。
						var failures = result && Array.isArray(result.failures) ? result.failures : [];
						if (failures.length > 0) {
							var firstReason = String(failures[0].error || '未知原因');
							setError(
								failures.length + ' 个对话同步失败：' + firstReason +
									(failures.length > 1 ? '（等 ' + failures.length + ' 条）' : ''),
							);
							// 成功的那几条已经落盘了，照样通知外层刷新列表。
							if (onSynced !== undefined) onSynced(result);
							return;
						}
						if (onSynced !== undefined) onSynced(result);
						if (onClose !== undefined) onClose();
					},
					function (reason) {
						setBusy(false);
						setError(String((reason && reason.message) || reason));
					},
				);
			};

			// 按关键字过滤（见 `queryState` 的注释）。
			//
			// ⚠️ 大小写不敏感：对话标题有中文也有英文（真机上就有
			// 「Greeting in Chinese」「ear逆向工具地址查询」混在一起），
			// 用户不会记得当初输入的是大写还是小写。
			var needle = query.trim().toLowerCase();
			var shown = needle === ''
				? items
				: items.filter(function (entry) {
						if (entry === null || entry === undefined) return false;
						var text = typeof entry.title === 'string' ? entry.title.toLowerCase() : '';
						return text.indexOf(needle) >= 0;
					});

			var rows = [];
			if (!loaded) {
				rows.push(h('div', { key: 'loading', style: CSS.syncEmpty }, '正在读取电脑上的对话…'));
			} else if (error !== null) {
				rows.push(h('div', { key: 'error', style: CSS.error }, error));
			} else if (items.length === 0) {
				rows.push(h('div', { key: 'empty', style: CSS.syncEmpty }, '这个文件夹在电脑上还没有对话'));
			} else if (shown.length === 0) {
				rows.push(h('div', { key: 'nomatch', style: CSS.syncEmpty }, '没有匹配「' + query.trim() + '」的对话'));
			} else {
				for (var index = 0; index < shown.length; index += 1) {
					var item = shown[index];
					rows.push(
						h(
							'label',
							{
								key: item.sessionId,
								style: CSS.syncRow,
								// ⚠️ 用 `htmlFor`+`id` 让 label 驱动复选框，而不是自己
								// 在 label 上也挂 onClick —— 两者都挂会让一次点击 toggle 两次
								// 而互相抵消（表现为「勾不上」）。
								htmlFor: 'jlmsync-' + item.sessionId,
							},
							h('input', {
								id: 'jlmsync-' + item.sessionId,
								type: 'checkbox',
								style: CSS.syncBox,
								checked: picked[item.sessionId] === true,
								onChange: (function (id) {
									return function () {
										toggle(id);
									};
								})(item.sessionId),
							}),
							h('span', { style: CSS.syncName, title: item.title }, item.title),
						),
					);
				}
			}

			// 搜索框 + 全选/清空。
			//
			// ⚠️ 只对**当前显示出来的**那一批生效（`shown`），不是对全部 `items`：
			// 用户搜「问候」之后点全选，期望的是选中搜出来的那些，
			// 而不是把 76 个对话全勾上 —— 那会一次性建出几十个空壳会话。
			var shownIds = shown.map(function (entry) { return entry.sessionId; });
			var shownPicked = 0;
			for (var sp = 0; sp < shownIds.length; sp += 1) {
				if (picked[shownIds[sp]] === true) shownPicked += 1;
			}
			var allShownPicked = shownIds.length > 0 && shownPicked === shownIds.length;
			var pickAllShown = function () {
				setPicked(function (current) {
					var next = {};
					for (var key in current) {
						if (Object.prototype.hasOwnProperty.call(current, key) && current[key] === true) next[key] = true;
					}
					if (allShownPicked) {
						// 已经全选 ⇒ 反选成「都不选」（只清当前显示的这一批）。
						for (var i2 = 0; i2 < shownIds.length; i2 += 1) delete next[shownIds[i2]];
					} else {
						for (var i3 = 0; i3 < shownIds.length; i3 += 1) next[shownIds[i3]] = true;
					}
					return next;
				});
			};
			var toolbar = items.length === 0
				? null
				: h(
						'div',
						{ style: CSS.syncToolbar },
						h('input', {
							type: 'search',
							style: CSS.syncSearch,
							placeholder: '搜索对话名称…',
							value: query,
							onChange: function (event) {
								setQuery(String(event.target.value || ''));
							},
						}),
						h(
							'button',
							{
								type: 'button',
								style: CSS.syncPickAll,
								onClick: pickAllShown,
							},
							allShownPicked ? '取消全选' : '全选',
						),
					);

			var body = h(
				'div',
				{ style: CSS.editorScope },
				h(
					'div',
					{ style: CSS.header },
					h('h2', { style: CSS.title }, '同步对话'),
					h('div', { style: CSS.crumbBar },
						h('span', { style: CSS.pathText, title: desktopPath }, desktopPath || '（未选择电脑目录）'),
					),
				),
				h(
					'div',
					{ style: CSS.content },
					// 搜索 + 全选放在**列表上方**（列表可能有 70+ 项，
					// 放下面用户得先滑到底才看得见）。
					toolbar,
					h('div', { style: CSS.column }, rows),
				),
				h(
					'div',
					{ style: CSS.footerBar },
					h('span', { style: CSS.note }, count === 0 ? '勾选要同步的对话' : '已选 ' + count + ' 个'),
					h('span', { style: CSS.footerGap }),
					h(
						Button,
						{
							variant: 'secondary',
							style: CSS.footerAction,
							disabled: busy,
							onClick: onClose,
						},
						'取消',
					),
					h(
						Button,
						{
							variant: 'primary',
							style: CSS.footerAction,
							disabled: busy || count === 0,
							onClick: submit,
						},
						busy ? '同步中…' : '同步',
					),
				),
			);

			return h(
				Modal,
				{
					open: open,
					onClose: onClose,
					title: '同步对话',
					closeLabel: '关闭',
					className: DIALOG_CLASS,
					headless: true,
				},
				body,
			);
		}

		/**
		 * 「同步对话」的**挂载器**：把菜单项接进工作区行的「⋯」菜单。
		 *
		 * ## 为什么必须走 DOM（这是本项目第二个 DOM 注入点）
		 *
		 * 官方工作区行的菜单项是**写死的两条**
		 *（`dsh-client-ui-workspace/lib/client.js:732-741`：`rename` / `delete`），
		 * 既没有插槽、也没有 `inject` 扩展点；`sidebar.workspaces` 这个 slot 还是
		 * `kind: "single"`，整块只能有一个 occupant（官方自己的 `WorkspaceBrowser`）。
		 *
		 * 所以只能等官方把菜单渲染出来之后，往那个浮层里**追加一行**。
		 * 判据是菜单里的文案（「重命名」/「删除工作区」）—— 官方菜单是
		 * portal 到 body 的浮层，没有稳定的类名可用。
		 *
		 * ⚠️ 只追加、不改动官方那两条，也不拦截它们的点击：官方自己的逻辑
		 * 完全不知道我们的存在，所以不可能被我们弄坏。
		 */
		function installSyncMenu(ctx) {
			/** 当前挂着的那个「同步对话」按钮（避免重复插入）。 */
			var mounted = null;
			/** 当前对话框状态。 */
			var dialog = { open: false, desktopPath: '' };
			/**
			 * 最近一次点开「⋯」的那个工作区行的标题。
			 *
			 * ⚠️ **必须这样记，不能从菜单 DOM 往上找行**：官方菜单是
			 * `portal: true` 渲染到 body 下的独立浮层（
			 * `dsh-client-ui-workspace/lib/client.js:785`），它在 DOM 上
			 * **不是**工作区行的后代 —— 往上找永远找不到那一行。
			 */
			var lastMenuRowTitle = '';
			/**
			 * 最近一次点开「⋯」的那个工作区行的**路径**（唯一标识）。
			 *
			 * 比标题可靠：`desktopTitle()` 取末段，两个同名目录会撞。
			 */
			var lastMenuRowPath = '';
			/**
			 * 上一次被我们藏起来的那个官方菜单浮层节点。
			 *
			 * 点「同步对话」后为了收起菜单，给浮层写了内联
			 * `visibility: hidden; pointer-events: none`。而 React 会**复用**这个
			 * portal 节点 ⇒ 不还原的话，下次打开的菜单就是隐藏且点不中的。
			 *
			 * 真机症状（用户 2026-10-22 报障）：「⋯ 点了没反应」，
			 * 必须重启 App 才恢复。所以在下一次 pointerdown 时清掉（见
			 * `restoreHiddenMenu`）。
			 */
			var hiddenMenuRoot = null;

			/** 还原被藏起来的菜单浮层（清内联样式，节点本身不动）。 */
			var restoreHiddenMenu = function () {
				if (hiddenMenuRoot === null) return;
				try {
					hiddenMenuRoot.style.visibility = '';
					hiddenMenuRoot.style.pointerEvents = '';
				} catch {
					/* 节点可能已被 React 移除 —— 无所谓 */
				}
				hiddenMenuRoot = null;
			};

			var root = null;
			var host = null;

			/** 重渲染对话框（用一个独立的 React root，与官方树完全隔离）。 */
			var renderDialog = function () {
				if (host === null) return;
				if (root === null) {
					// ⚠️ 官方前端只用 `require("react-dom")`（见
					// `dsh-client-ui-chat/lib/client.js:11`），**没有任何包**用
					// `react-dom/client` —— 说明模块加载器只保证前者可解析。
					// 所以先试 `react-dom/client`（React 18 的正式入口，能消除告警），
					// 拿不到就退回 `react-dom` 的 legacy `render`；两个都拿不到就放弃
					// 挂载（菜单项仍然不会破坏官方界面）。
					var legacy = null;
					var legacyError = '';
					try {
						legacy = require('react-dom');
					} catch (domError) {
						legacy = null;
						legacyError = String((domError && domError.message) || domError);
					}
					var clientModule = null;
					var clientErrorText = '';
					try {
						clientModule = require('react-dom/client');
					} catch (clientError) {
						clientModule = null;
						clientErrorText = String((clientError && clientError.message) || clientError);
					}
					// 诊断：把模块解析结果暴露出来（排查「对话框打开了却是空的」）。
					try {
						window.__dshSyncRender = {
							at: Date.now(),
							legacyType: legacy === null ? 'null' : typeof legacy,
							legacyRender: legacy !== null && typeof legacy.render === 'function',
							clientType: clientModule === null ? 'null' : typeof clientModule,
							clientCreateRoot: clientModule !== null && typeof clientModule.createRoot === 'function',
							legacyError: legacyError,
							clientError: clientErrorText,
						};
					} catch (probeError3) {
						/* 诊断失败不影响主流程 */
					}
					if (clientModule !== null && typeof clientModule.createRoot === 'function') {
						root = clientModule.createRoot(host);
					} else if (legacy !== null && typeof legacy.render === 'function') {
						root = {
							render: function (element) {
								legacy.render(element, host);
							},
							unmount: function () {
								if (typeof legacy.unmountComponentAtNode === 'function') legacy.unmountComponentAtNode(host);
							},
						};
					} else {
						return;
					}
				}
				var element = h(SyncConversationsDialog, {
					open: dialog.open,
					desktopPath: dialog.desktopPath,
					onClose: function () {
						dialog = { open: false, desktopPath: dialog.desktopPath };
						renderDialog();
					},
					onSynced: function () {
						// 同步完刷新侧边栏：官方会话列表是 store 驱动的，
						// 主动 refresh 一次就能把新会话画出来。
						try {
							if (ctx.sessions !== undefined && typeof ctx.sessions.refresh === 'function') {
								ctx.sessions.refresh();
							}
						} catch (refreshError) {
							/* 刷新失败不影响已建的会话 */
						}
					},
				});
				if (typeof root.render === 'function') root.render(element);
			};

			/** 确保对话框容器存在（挂在 body 下，和官方 portal 同级）。 */
			var ensureHost = function () {
				if (host !== null && document.body.contains(host)) return;
				host = document.createElement('div');
				host.setAttribute('data-dsh-remote-sync', '1');
				document.body.appendChild(host);
				root = null;
			};

			/**
			 * 打开同步对话框（需要先知道这个工作区对应电脑上哪个目录）。
			 *
			 * @param desktopPath - 电脑上的绝对目录。
			 */
			var openSync = function (desktopPath) {
				ensureHost();
				dialog = { open: true, desktopPath: desktopPath };
				renderDialog();
			};

			/**
			 * 找出某个工作区行对应的电脑路径。
			 *
			 * 从菜单按钮往上找那个 `role="treeitem"` 的行，读它的标题文字，
			 * 再和宿主给的镜像工作区清单比对。这样不需要任何官方内部状态。
			 */
			var desktopPathOfMenu = function (menuNode) {
				// ⚠️ 官方菜单是 portal 出去的，**不在**工作区行的 DOM 子树里，
				// 所以不能从菜单节点往上找行。改用「记录打开菜单时的那一行」：
				// 菜单出现的那一刻，鼠标/手指点在哪个 `role="treeitem"` 上。
				//
				// `lastMenuRowPath` 里装的是 `decorate()` 打到行上的
				// `data-dsh-workspace-desktop`，也就是**电脑路径本身** ——
				// 拿到就能直接用，不需要再查表，也就不存在「同名目录串台」。
				if (lastMenuRowPath !== '') return lastMenuRowPath;
				// 兜底：行上没打到属性（比如 `decorate()` 那一刻清单还没回来）时，
				// 按标题去镜像清单里找。标题取路径末段，同名概率低，作为兜底够用。
				if (lastMenuRowTitle === '') return null;
				var list = mirrorWorkspacesRef.value;
				for (var index = 0; index < list.length; index += 1) {
					var title = list[index].title;
					if (title !== '' && lastMenuRowTitle.indexOf(title) === 0) return list[index].desktopPath;
				}
				return null;
			};

			/**
			 * 立刻重拉镜像工作区清单，并把标记补打到指定的那一行上。
			 *
			 * ## 为什么需要这个「点菜单时临时补一次」
			 *
			 * `refreshMirrorWorkspaces()` 只在 App 启动 / `domain/changed` /
			 * 10 分钟兜底时跑。而**刚配对 + 刚选完目录**这一刻，宿主那边已经有镜像
			 * 工作区了，前端缓存却还是空的（宿主从不发 `domain/changed`，见
			 * `onPointerDown` 里的详细注释）。
			 *
			 * 于是第一次点「⋯ → 同步对话」时 `data-dsh-workspace-desktop` 还没打上，
			 * 对话框**直接消失**，必须重启 App 才好 —— 这正是用户 2026-10-22 报的
			 * 「配对成功后点同步对话没反应，退出重启之后回来就可以点了」。
			 *
			 * @param row - 刚被点开的那个 `role="treeitem"` 元素（可能已经不在 DOM 里）。
			 */
			var refreshMirrorWorkspacesAsync = function (row) {
				bridge('mirrorWorkspaces', {}).then(
					function (result) {
						var list = (result && result.workspaces) || [];
						mirrorWorkspacesRef.value = list;
						// 补打标记：这一行的标题能对上某条镜像工作区就写上去。
						//
						// ⚠️ 判据与 `decorate()` 完全一致（`indexOf(title) === 0`），
						// 两处必须同步改，否则会出现「菜单里补上了、轮询又抹掉」的抖动。
						var rowText = String((row && row.textContent) || '').trim();
						if (rowText === '') return;
						for (var i = 0; i < list.length; i += 1) {
							var item = list[i];
							if (!item || typeof item.desktopPath !== 'string' || item.desktopPath === '') continue;
							if (typeof item.title !== 'string' || item.title === '') continue;
							if (rowText.indexOf(item.title) !== 0) continue;
							try {
								row.setAttribute('data-dsh-workspace-desktop', item.desktopPath);
							} catch (setError) {
								/* 节点已被 React 换掉 —— 无所谓，下一次轮询会补上 */
							}
							// 同步修正本次 pointerdown 记下的值，让紧接着的 click
							// 能直接走 `lastMenuRowPath` 那条精确路径。
							lastMenuRowPath = item.desktopPath;
							try {
								window.__dshSyncProbe = {
									at: Date.now(),
									title: lastMenuRowTitle.slice(0, 40),
									path: lastMenuRowPath,
									via: 'late-refresh',
								};
							} catch (probeError) {
								/* 诊断失败不影响主流程 */
							}
							return;
						}
					},
					function () {
						/* 拿不到就维持现状：至少不会比修之前更差 */
					},
				);
			};

			/** 给浮层菜单追加一行「同步对话」。 */
			var decorate = function () {
				// ⚠️ 顺手给工作区行打上 `data-dsh-workspace-desktop`（幂等，只写一次）。
				//
				// 官方 `ProjectRowItem`（`dsh-client-ui-workspace/lib/client.js:735`）
				// 的 DOM 上**只有 `role="treeitem"` 和文本**，没有 workspaceId ——
				// 而「同步对话」必须知道用户点的是**哪一个**工作区，光靠标题
				// 在「两个目录同名」时会串到另一个目录的对话上。
				//
				// 所以这里按标题对上镜像工作区清单，把 id 写到属性上，
				// pointerdown 时直接读（见 `onPointerDown`）。
				//
				// 只在有镜像工作区时才做（本地工作区不需要这个属性），
				// 且用 `querySelectorAll('[role="treeitem"]')` 范围很小
				//（侧边栏展开时就几十个）。
				var mirrors = mirrorWorkspacesRef.value;
				// ⚠️ 侧边栏收起时 `treeitem` 数量是 0，这一圈本来就什么都不做；
				// 但 `querySelectorAll` 本身仍要走一次选择器引擎。加个闸把它也免掉 ——
				// 用户大多数时间是在**会话里**，侧边栏是收起的。
				var sidebarOpen = document.querySelector('[class*="mp-drawer-open"]') !== null;
				if (mirrors.length > 0 && sidebarOpen) {
					var rows = document.querySelectorAll('[role="treeitem"]');
					for (var r = 0; r < rows.length; r += 1) {
						var row = rows[r];
						// ## ⚠️⚠️ 每轮**按当前行文本重新匹配**，不能「打过就跳过」
						//
						// 原来这里第一句是
						//
						//     if (row.getAttribute('data-dsh-workspace-desktop') !== null) continue;
						//
						// 意思是「打过标记的行永远不再碰」。这是错的：**React 会复用
						// DOM 行节点** —— 同步完一批对话后侧边栏行顺序一变，同一个
						// `<div role="treeitem">` 就换了内容，而标记还留着旧路径。
						//
						// 真机症状（用户 2026-10-22 报障）：点 B 工作区的
						// 「⋯ → 同步对话」，弹出来的却是 **A 的路径**。只有重启
						// （DOM 整棵重建）才恢复 —— 这就是那个「必须重启」的根因。
						//
						// 所以改成：**每次都用当前行文本重新算一遍**，变了就改，
						// 匹配不到就删。代价是多一次 `indexOf`，而这一段本来就已经
						// 在读 `row.textContent`（那是更贵的那一步）。
						var rowText = String(row.textContent || '').trim();
						var matchedPath = null;
						if (rowText !== '') {
							for (var m = 0; m < mirrors.length; m += 1) {
								var item = mirrors[m];
								if (item.desktopPath === undefined || item.desktopPath === null) continue;
								if (item.title !== '' && rowText.indexOf(item.title) === 0) {
									// ⚠️ **打 `desktopPath`，不打 `workspaceId`**。
									//
									// 原先打的是 workspaceId，实测行不通：镜像工作区是
									// 本插件用 `registry.create()` 建的，**绝大多数在 registry
									// 里还没有 id**（`mirrorWorkspaces` 返回的 `workspaceId`
									// 是空串 —— 真机核对过：12 个镜像里只有 2 个有 id）。
									// 打空串等于没打，精确匹配那一支全部失效。
									//
									// 而 `desktopPath` 是**唯一且必然存在**的（它就是用户
									// 选的那个电脑目录），拿它匹配既精确又不依赖 registry。
									matchedPath = item.desktopPath;
									break;
								}
							}
						}
						var current = row.getAttribute('data-dsh-workspace-desktop');
						if (matchedPath === null) {
							// 这一行不再是镜像工作区（或标题变了匹配不上）⇒ 抹掉旧标记，
							// 否则 `onPointerDown` 会读到上一任的路径。
							if (current !== null) row.removeAttribute('data-dsh-workspace-desktop');
						} else if (current !== matchedPath) {
							row.setAttribute('data-dsh-workspace-desktop', matchedPath);
						}
					}
				}
				// ⚠️ 先用一个**便宜**的判据定位：官方把菜单 portal 到 body 下，
				// 所以只在 body 的**直接子节点**里找浮层（通常就十几个），
				// 不要用 `querySelectorAll('div,ul')` 全文档扫一遍 —— 那在
				// 250ms 轮询下会把手机端拖卡。
				//
				// ⚠️⚠️ **再加一道更便宜的闸：菜单没开就立刻返回。**
				//
				// 下面那圈循环对每个 `body > *` 都读 `node.textContent` ——
				// 那会**递归收集整棵子树的文本**，而侧边栏那种几万节点的子树
				// 读一次就是一次实打实的遍历（`textContent` 不是常量时间）。
				// 250ms 一次 × 每次十几棵子树，在手机上是很可观的常态开销，
				// 而**99% 的时间里菜单根本没开**，这些遍历全是白做的。
				//
				// `role="menu"` 是 O(1) 的属性查询（走的是原生 attribute 索引），
				// 官方菜单浮层一定带它（真机 DOM 核对过：
				// `<div role="menu" class="_surface_ri079_1 _list_4ub78_7">`）。
				// 所以先用它当闸门，没菜单就直接跳过整段。
				if (document.querySelector('[role="menu"]') === null) {
					if (mounted !== null) mounted = null;
					return;
				}
				var panel = null;
				var tops = document.body.children;
				for (var index = 0; index < tops.length; index += 1) {
					var node = tops[index];
					if (node.getAttribute !== undefined && node.getAttribute('data-dsh-remote-sync') === '1') continue;
					var text = String(node.textContent || '');
					if (text.indexOf('删除工作区') < 0 || text.indexOf('重命名') < 0) continue;
					if (node.querySelector('input,textarea') !== null) continue;
					// 再往里收一层：真正的那一行菜单项才是我们要插入的容器。
					panel = node;
					break;
				}
				if (panel === null) {
					if (mounted !== null) mounted = null;
					return;
				}
				if (panel.querySelector('[data-dsh-remote-sync-item]') !== null) return;

				// ⚠️ 从 portal 根往里**收窄**到真正装菜单项的那一层：
				// 官方菜单的 DOM 是 `portal > 定位层 > 列表 > 项`，直接往 portal
				// 根上插会插到列表外面（视觉上跑到浮层边缘、点不到）。
				//
				// ⚠️⚠️ **收窄的判据必须是「它还是菜单项容器」，不能只是「含重命名文本」**。
				// 踩过的坑（1.0.71 真机）：官方菜单项内部是
				// `<div role=menuitem><span class="_itemLabel_">重命名</span></div>`，
				// 按「含文本的最深容器」一路收窄会停在那 个 **span** 上，
				// 按钮被塞进 label span 里 ⇒ ① 视觉上挤在文字位置、
				// ② React 重渲染这个 span 时把按钮连监听一起冲掉，
				// 表现为「菜单里有『同步对话』但点了毫无反应」。
				//
				// 正确判据：**子节点里得有 `role="menuitem"`（或 ≥2 个子项）**，
				// 也就是「还能装下多个菜单项」的那一层。纯 label 元素不满足。
				var inner = panel;
				while (true) {
					var found = null;
					for (var k = 0; k < inner.children.length; k += 1) {
						var child = inner.children[k];
						if (String(child.textContent || '').indexOf('重命名') < 0) continue;
						// 这一层必须是「项容器」：它自己得含 menuitem，或者有多个子元素。
						var isItemHost = child.children.length >= 2;
						if (!isItemHost) {
							try {
								if (child.querySelector('[role="menuitem"]') !== null) isItemHost = true;
							} catch (probeError) {
								/* 忽略 */
							}
						}
						if (child.getAttribute !== undefined &&
							child.getAttribute('role') === 'menuitem') {
							// 它自己就是菜单项 ⇒ 不能再往里收，父层才是容器。
							isItemHost = false;
						}
						if (!isItemHost) continue;
						found = child;
						break;
					}
					if (found === null) break;
					inner = found;
				}
				panel = inner;

				// ⚠️ **必须照抄官方的三段结构**，否则视觉上和原生菜单项不一样：
				//
				//     <button role="menuitem" class="_item_…">
				//       <span class="_itemIcon_…"><svg width=16 height=16 …/></span>
				//       <span class="_itemLabel_…">同步对话</span>
				//     </button>
				//
				// 官方每个菜单项都是「图标 + 文字」两栏（`_itemIcon_4ub78_148`
				// 负责左内边距与 16×16 的图标位）。原先只塞了一个纯文本
				// `button.textContent = '同步对话'`，结果是**一行没有图标的秃文字**，
				// 和旁边的「重命名 / 删除工作区」完全不是一个长相 —— 用户原话：
				// 「你就像人家归档对话，还有重命名那样画一个图标在前面」。
				//
				// 图标自己画（官方没有「同步」这个动作的图标），语义取
				// 「两条弧线首尾相接」＝ 循环/同步，与菜单里其它图标的
				// 1px 描边、16×16、`currentColor` 风格保持一致。
				var button = document.createElement('button');
				button.type = 'button';
				button.setAttribute('data-dsh-remote-sync-item', '1');
				// 尽量沿用官方菜单项的排版：直接抄「重命名」那一行的行内样式。
				var sample = null;
				var candidates = panel.querySelectorAll('[role="menuitem"],button,div');
				for (var j = 0; j < candidates.length; j += 1) {
					if (String(candidates[j].textContent || '').trim() === '重命名') {
						sample = candidates[j];
						break;
					}
				}
				/**
				 * 按官方菜单项的结构拼一个「图标 + 文字」的行。
				 *
				 * @param iconMarkup - 16×16 的 svg 源码。
				 * @param labelText - 文字。
				 */
				var buildMenuItem = function (iconMarkup, labelText) {
					button.textContent = '';
					var icon = document.createElement('span');
					// 类名从官方那一行现抄，抄不到就用官方固定的类名兜底
					//（`_itemIcon_4ub78_148` 是构建 hash，写死会在官方换版本后失效，
					// 所以优先抄 sample 里的，抄不到才退回写死值）。
					var iconClass = '_itemIcon_4ub78_148';
					var labelClass = '_itemLabel_4ub78_190';
					if (sample !== null) {
						var si = sample.querySelector('span');
						if (si !== null && si.className !== '') iconClass = si.className;
						var spans = sample.querySelectorAll('span');
						if (spans.length > 1) labelClass = spans[spans.length - 1].className;
					}
					icon.className = iconClass;
					icon.setAttribute('aria-hidden', 'true');
					icon.innerHTML = iconMarkup;
					var label = document.createElement('span');
					label.className = labelClass;
					label.textContent = labelText;
					button.appendChild(icon);
					button.appendChild(label);
				};
				buildMenuItem(
					'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" ' +
						'xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1">' +
						// 上弧：从左下往右上，带箭头
						'<path d="M2.5 9.2A5.5 5.5 0 0 1 8 3.5c1.6 0 3 .7 4 1.8" ' +
						'stroke="currentColor" stroke-linecap="round"></path>' +
						'<path d="M12 2.6v2.9H9.1" stroke="currentColor" ' +
						'stroke-linecap="round" stroke-linejoin="round"></path>' +
						// 下弧：镜像
						'<path d="M13.5 6.8A5.5 5.5 0 0 1 8 12.5c-1.6 0-3-.7-4-1.8" ' +
						'stroke="currentColor" stroke-linecap="round"></path>' +
						'<path d="M4 13.4v-2.9h2.9" stroke="currentColor" ' +
						'stroke-linecap="round" stroke-linejoin="round"></path>' +
						'</svg>',
					'同步对话',
				);
				if (sample !== null) {
					button.className = sample.className;
					button.setAttribute('style', sample.getAttribute('style') || '');
					// 照抄角色：官方是 `<button role="menuitem">`，抄不到就当普通按钮，
					// 两种都能点（点击走 document 上的委托，见下）。
					var sampleRole = sample.getAttribute('role');
					if (sampleRole !== null && sampleRole !== '') button.setAttribute('role', sampleRole);
				} else {
					button.setAttribute('style', 'display:block;width:100%;padding:8px 12px;' +
						'text-align:left;border:none;background:0 0;cursor:pointer;font-size:13px;');
				}
				// ⚠️ **不在按钮上挂 click 监听**，改用 document 上的事件委托
				//（见 `onDocumentClick`）。理由：这个按钮插在 React 管理的 DOM 里，
				// 父节点重渲染会把它整个替换成新节点，挂在旧节点上的监听随之失效 ——
				// 症状是「按钮看得见、点了没反应」。委托在 document 上就不受影响。
				//
				// ⚠️ **必须包一层 `_itemWrap_`，不能把 button 直接塞进容器**：
				// 官方的每个菜单项都是 `_viewport_ > _itemWrap_ > button`，
				// `_itemWrap_` 负责项与项之间的间距（以及 hover 高亮的圆角范围）。
				// 直接插 button 的话它在视觉上和上面那项**粘在一起**，看着像同一个
				// 菜单项里多出的一行文字。包一层后就与「重命名 / 删除工作区」对齐了。
				var wrap = document.createElement('div');
				if (sample !== null && sample.parentNode !== null &&
					String(sample.parentNode.className || '') !== '') {
					wrap.className = sample.parentNode.className;
				}
				wrap.appendChild(button);
				// ⚠️⚠️ **必须 `appendChild` 追加到末尾，绝不能 `insertBefore(firstChild)`。**
				//
				// 这是「点同步就整个侧边栏空白」的第二个根因（第一个是
				// `onDocumentClick` 里主动 removeChild，已删）。
				//
				// 真机异常原文：
				//   Failed to execute 'removeChild' on 'Node':
				//   The node to be removed is not a child of this node.
				//   slot entry crashed in 'sidebar.workspaces'
				//
				// React 对**子节点列表**按位置记账。往列表**头部**插一个它不认识的
				// 节点，等于把它认的第 0 项挤到第 1 位；等它下次 commit 去
				// `removeChild(children[0])`（它以为那是自己渲染的第一个菜单项），
				// 拿到的却是我们插的 wrap —— 于是抛错，整个 slot 被
				// `SlotErrorBoundary` 换成空 div，工作区与会话列表全消失。
				//
				// 追加到**末尾**则不会移动 React 自己的任何节点位置：它删除时
				// 按 `children[i]` 拿到的仍是它自己的项，我们的 wrap 排在最后
				// 不受影响。（视觉上它在「删除工作区」下面，一样是菜单里的一项。）
				panel.appendChild(wrap);
				mounted = button;
			};

			/**
			 * 委托处理「同步对话」的点击。
			 *
			 * 走委托而不是 `button.addEventListener`，是为了扛住 React 重渲染
			 * 把按钮节点替换掉的情况（见 `decorate()` 里的说明）。
			 */
			var onDocumentClick = function (event) {
				try {
					var node = event.target;
					while (node !== null && node !== undefined && node !== document.body) {
						if (node.getAttribute !== undefined &&
							node.getAttribute('data-dsh-remote-sync-item') === '1') {
							event.preventDefault();
							event.stopPropagation();
							var desktopPath = desktopPathOfMenu(node.parentNode);
							// ## 收起官方菜单 —— **只改样式，绝不改 DOM 结构**
							//
							// 这里踩过两次，两次都很难查，记下来：
							//
							// ### ❌ 第一版：派发 mousedown 指望官方自己关
							// 关不掉。官方的关闭判据挂在它自己那套 pointerdown 链上，
							// 而这里已经 `stopPropagation` 了；就算到了，菜单项自己
							// 也算「内部」，不会被判成外部点击。
							//
							// ### ❌ 第二版：直接 `removeChild` 摘掉浮层
							// **整个侧边栏消失**（用户报障「点同步就空白了」）。
							// 那个浮层是 React 渲染的，React 记着它挂在某父节点下；
							// 摘走之后 React 下次 commit 仍去 `parentNode.removeChild(它)`
							// ⇒ 抛 `The node to be removed is not a child of this node`
							// ⇒ 被官方 `SlotErrorBoundary` 接住 ⇒ `sidebar.workspaces`
							// 整个 slot 换成空 div，工作区与会话列表全没了。
							//
							// ### ✅ 现在：只把**样式**藏起来
							// 节点还在原位、React 的父子记账完全不变，只是看不见、
							// 也点不到。官方下次要移除它时一切照旧。
							//
							// ⚠️ 用 `visibility: hidden` 而不是 `display: none`：
							// `display` 会改变布局（浮层可能有定位相关的测量），
							// 而 `visibility` 只影响绘制与命中测试，对 React 最安全。
							//
							// ## ⚠️⚠️ 必须**记住这个节点**，下次 pointerdown 还原
							//
							// 内联样式是**永久**的，而 React 会复用这个 portal 节点：
							// 下次再打开「⋯」菜单时，同一个节点还是
							// `visibility: hidden; pointer-events: none` ⇒ 菜单画得出来
							// 但**看不见、也点不中**。
							//
							// 真机症状（用户 2026-10-22 报障）：「⋯ 点了没反应」——
							// 必须重启 App（DOM 整棵重建）才恢复。
							//
							// 所以这里把节点记在 `hiddenMenuRoot` 上，由
							// `restoreHiddenMenu()` 在下一次 pointerdown 时清掉。
							try {
								var menuRoot = node.parentNode;
								while (menuRoot !== null && menuRoot.parentElement !== null &&
									menuRoot.parentElement !== document.body) {
									menuRoot = menuRoot.parentElement;
								}
								if (menuRoot !== null && menuRoot.parentElement === document.body) {
									menuRoot.style.visibility = 'hidden';
									menuRoot.style.pointerEvents = 'none';
									hiddenMenuRoot = menuRoot;
								}
							} catch (hideError) {
								/* 藏不掉也不影响打开对话框 */
							}
							if (desktopPath !== null) openSync(desktopPath);
							// 诊断：把 click 这一步拿到什么也记下来 ——
							// 与 `__dshSyncProbe`（pointerdown 记到的）对比，
							// 就能一眼看出是「没记到」还是「记到了又被清掉」。
							try {
								window.__dshSyncClick = {
									at: Date.now(),
									desktopPath: desktopPath,
									opened: desktopPath !== null,
								};
							} catch (probeError2) {
								/* 诊断失败不影响主流程 */
							}
							return;
						}
						node = node.parentElement;
					}
				} catch (delegateError) {
					/* 忽略：委托失败不能影响页面其它点击 */
				}
			};
			document.addEventListener('click', onDocumentClick, true);

			// 低频轮询：官方菜单是 React 按需渲染的浮层，没有可供订阅的事件。
			// 250ms 一次、只在 DOM 里查一次轻量选择器，对手机端开销可忽略。
			//
			// ⚠️ 同时挂一个**捕获阶段**的 pointerdown 监听来记「这次点的是哪个
			// 工作区行」—— 官方菜单 portal 出去之后，DOM 上再也回不到那一行，
			// 只能在点击发生的那一刻把它记下来。
			var onPointerDown = function (event) {
				try {
					// ⚠️ **先还原上次被藏起来的菜单浮层**，再做别的。
					//
					// 用户下一次点「⋯」时，那个 portal 节点还是
					// `visibility: hidden; pointer-events: none` ⇒ 菜单看不见、
					// 也点不中（用户报障「⋯ 点了没反应」，必须重启才恢复）。
					// 放在最前面是因为它必须无条件执行 —— 下面那段是按
					// `role="treeitem"` 匹配的，匹配不到就 `return` 了。
					restoreHiddenMenu();
					var node = event.target;
					while (node !== null && node !== undefined && node !== document.body) {
						if (node.getAttribute !== undefined && node.getAttribute('role') === 'treeitem') {
							// 只记**工作区行**（它有展开箭头）；会话行也带 treeitem，
							// 但会话行的标题不会匹配镜像工作区清单，所以直接记原文即可，
							// 匹配失败时菜单项点了不会有反应（安全失败）。
							//
							// ⚠️⚠️ **两个变量必须无条件覆盖，不能「记到才写」。**
							//
							// 这是真机踩到的串台 bug：用户在 DSHAPP 上点过一次「同步对话」
							// （路径记成了 DSHAPP），随后去 **ai-office-mcp** 那一行点「⋯」→
							// 「同步对话」，弹出的对话框标题却还是 **DSHAPP 的路径**，
							// 列出来的是另一个目录的对话。
							//
							// 原因：`ai-office-mcp` 那个工作区行上**没有**
							// `data-dsh-workspace-desktop`（`decorate()` 只给能匹配到
							// 镜像清单的行打），于是 `path` 是空串；而下面原来的写法是
							// 「有值才覆盖」，空串就保留了上一次的旧路径 ⇒ 串台。
							//
							// 所以这里改成**总是写**（包括空串），旧值一律作废。
							// 空路径时 `desktopPathOfMenu()` 会走标题兜底匹配，
							// 再匹配不到就返回 null（安全失败，不会串到别的目录）。
							lastMenuRowTitle = String(node.textContent || '').trim();
							lastMenuRowPath = String(node.getAttribute('data-dsh-workspace-desktop') || '');
							// ## ⚠️⚠️ 行上没有标记 ⇒ **立刻重拉清单并补打**（用户 2026-10-22 报障）
							//
							// 真机实测的根因链（全新安装 + 刚配对）：
							//
							//   ① 用户在「电脑」页签里配对 + 选目录 ⇒ 宿主
							//      `ensureDesktopWorkspace()` 建出镜像工作区，
							//      `mirrorWorkspaces` 立刻就有数据了；
							//   ② 但前端 `mirrorWorkspacesRef.value` **还是空的** ——
							//      它只在三个时机刷新：App 启动、`domain/changed` 事件、
							//      10 分钟兜底；
							//   ③ 而宿主**从不发** `domain/changed`（全文件搜不到），
							//      于是这一格只能等 10 分钟或重启 App；
							//   ④ `decorate()` 拿空清单 ⇒ 打不上
							//      `data-dsh-workspace-desktop` ⇒ 点「⋯」记到的
							//      `path` 是空串 ⇒ `desktopPathOfMenu()` 返回 null
							//      ⇒ `openSync` 不被调用 ⇒ **对话框直接消失**。
							//
							// 真机探针证据（复现时抓的）：
							//     __dshSyncProbe = { title: "_项目文件夹", path: "" }
							//     __dshSyncClick = { desktopPath: null, opened: false }
							//
							// 用户的感受就是「点同步对话没反应」，而**重启一次就好了**
							// （重启走「App 启动」那条刷新路）。
							//
							// 修法：**点开「⋯」的这一刻就补一次**。菜单是用户点出来的，
							// 这个时机既不费流量（只在用户真的要用这个功能时发一次），
							// 又能保证「点下去之前清单一定是新的」。
							//
							// ⚠️ 必须异步、且**不能挡住本次 pointerdown**：清单回来之后再
							// 补打标记并重算路径。用户手速再快也要几百毫秒才点到菜单项，
							// 而本地桥调用通常几十毫秒，实测够用。
							if (lastMenuRowPath === '' && lastMenuRowTitle !== '') {
								refreshMirrorWorkspacesAsync(node);
							}
							// 诊断：把「这次记到了什么」暴露给页面，排查「点同步没反应」用。
							try {
								window.__dshSyncProbe = {
									at: Date.now(),
									title: lastMenuRowTitle.slice(0, 40),
									path: lastMenuRowPath,
								};
							} catch (probeError) {
								/* 诊断失败不影响主流程 */
							}
							return;
						}
						node = node.parentElement;
					}
					// ⚠️⚠️ **什么都不做，尤其是不要清空。**
					//
					// 这里原本是 `lastMenuRowTitle = ''; lastMenuRowPath = '';`，
					// 那是「点空白处就忘掉上一次的行」的直觉写法 —— 但它把
					// **点菜单项这一次**也当成「点空白处」了：
					//
					//   ① 用户点「⋯」            → pointerdown 命中工作区行，记下路径 ✅
					//   ② 用户点「同步对话」      → pointerdown 的 target 是菜单项里的
					//      `<span>`，它挂在 portal 出来的浮层下、**不在**任何
					//      `role="treeitem"` 里 → 向上找不命中 → 走到这里把刚记下的
					//      路径**清空** ❌
					//   ③ 紧接着的 click 走 `onDocumentClick` → `desktopPathOfMenu()`
					//      拿到空串 → 返回 null → `openSync` 不被调用
					//
					// 净效果就是用户说的「点同步对话没反应」：按钮画得出来、点得中
					//（探针实测捕获阶段确实命中了），但什么都不会发生。
					//
					// 不清空是安全的：这个值只在「点同步对话」时被读一次，
					// 而那时官方菜单一定还开着（点了就关），菜单跟着的就是那次
					// 「⋯」。真点到别处也不会误触发 —— 委托只在命中
					// `data-dsh-remote-sync-item` 时才读它。
				} catch (recordError) {
					/* 记录失败就保持上一次的值，同上：宁可用旧值也不要清空 */
				}
			};
			document.addEventListener('pointerdown', onPointerDown, true);

			var timer = setInterval(function () {
				try {
					decorate();
				} catch (decorateError) {
					/* 结构变化导致的偶发失败忽略 */
				}
			}, 250);
			return function () {
				clearInterval(timer);
				document.removeEventListener('pointerdown', onPointerDown, true);
				document.removeEventListener('click', onDocumentClick, true);
				// 卸载前把可能藏着的菜单浮层还原，别给官方留一个隐藏节点。
				restoreHiddenMenu();
				if (host !== null && host.parentNode !== null) host.parentNode.removeChild(host);
				host = null;
				root = null;
			};
		}
		//#endregion

		//#region 电脑流式帧 → 本地 transient
		/**
		 * 每个会话的流式折叠状态。
		 *
		 * 与官方 `ClientAssistantStream` 同构：`start` 建立 attempt、`chunk` 逐帧递增
		 * `nextIndex`、`end` 收尾。**序号不连续时直接放弃这一轮流式动画**
		 * （不抛错）——durable 事件随后会把完整内容补上，用户看到的是「没有逐字动画」
		 * 而不是「内容缺失」。这与官方 `rebaseline` 的兜底方向一致。
		 */
		var attempts = new Map();

		/** 取某会话的绑定（`eventSource` 就是浏览器侧的会话事件源）。 */
		function bindingOf(ctx, sessionId) {
			try {
				return ctx.sessions.binding(sessionId);
			} catch (error) {
				return undefined;
			}
		}

		/**
		 * 退役某会话的逐字残片。
		 *
		 * ⚠️ **必须由我们来做**：官方的清理点是
		 * `MutableSessionEventSource.settleAssistant(attemptId)`，它只被
		 * `ClientAssistantStream.acceptEventChange` 调用 —— 而那条链服务于**远程
		 * 事件流**。手机本地的 durable 事件是宿主直接 `session.append()` 进会话的，
		 * 走不到它。不清理的话，逐字残片会永久留在窗口里，与随后到达的完整消息
		 * 叠成两份。
		 *
		 * 不传 `entry`：durable 的完整消息会由会话事件流自己送进窗口，这里只负责
		 * 把残片摘掉。
		 *
		 * @param ctx - client 根上下文。
		 * @param sessionId - 会话 id。
		 * @param attemptId - 要退役的 attempt。
		 */
		function retireTransient(ctx, sessionId, attemptId) {
			if (typeof attemptId !== 'string') return;
			var binding = bindingOf(ctx, sessionId);
			if (binding === undefined || binding.eventSource === undefined) return;
			try {
				binding.eventSource.settleAssistant(attemptId);
			} catch (error) {
				/* 窗口已被替换：无需清理 */
			}
		}

		/**
		 * 把「这条消息没发出去」显式画给用户看。
		 *
		 * ## 为什么需要（乐观返回的必然配套）
		 *
		 * `prompt` 改成乐观返回之后，用户按发送 → 消息立刻上屏 → 转发在后台跑。
		 * 如果转发失败，前端**收不到任何错误**（它早就拿到 `{accepted:true}` 了），
		 * 于是用户会盯着一个永远不来的回复干等。
		 *
		 * ## 为什么不用官方组件
		 *
		 * 试过两条官方路径都不通：
		 * · `api-session/error` —— 前端 `dsh-client-ui-conversation` **不监听**它；
		 * · 往会话 append 一条错误事件 —— 同步会话在本地**没有 session 对象**
		 *   （`ctx.sessions.get()` 是 undefined，历史全在电脑上），写不进去。
		 *
		 * 所以直接在页面世界插一条自己的浮层。用 `position: fixed` 贴在顶部，
		 * 6 秒后自动消失，点一下也能立刻关掉 —— 不打断操作，但一定看得见。
		 *
		 * ⚠️ 同一时刻只留一条：连续失败时不叠成一片，后一条替换前一条。
		 *
		 * @param ctx - client 根上下文（这里只用它拿 logger，允许为 undefined）。
		 * @param sessionId - 出问题的会话（仅用于文案定位，不展示）。
		 * @param message - 失败原因原文。
		 */
		function showPromptFailure(ctx, sessionId, message) {
			try {
				var host = document.body;
				if (host === null) return;
				var previous = document.getElementById('dsh-remote-prompt-failed');
				if (previous !== null) previous.remove();
				var bar = document.createElement('div');
				bar.id = 'dsh-remote-prompt-failed';
				bar.setAttribute('role', 'alert');
				bar.textContent = '消息没有发到电脑：' + message;
				var style = bar.style;
				style.position = 'fixed';
				style.left = '12px';
				style.right = '12px';
				style.top = 'calc(env(safe-area-inset-top, 0px) + 56px)';
				style.zIndex = '2147483000';
				style.padding = '10px 14px';
				style.borderRadius = '12px';
				style.background = 'rgba(190, 46, 46, 0.96)';
				style.color = '#fff';
				style.fontSize = '13px';
				style.lineHeight = '1.45';
				style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.22)';
				style.wordBreak = 'break-word';
				bar.addEventListener('click', function () {
					bar.remove();
				});
				host.appendChild(bar);
				setTimeout(function () {
					if (bar.isConnected) bar.remove();
				}, 6000);
			} catch (error) {
				if (ctx.logger && typeof ctx.logger.warn === 'function') { ctx.logger.warn('[dsh-remote-mobile] 画发送失败提示出错: ' + String(error)); }
			}
		}

		/**
		 * 画一张「电脑在等你回答」的卡片。
		 *
		 * ## 为什么必须自己画，不能复用官方那个 ask 卡片
		 *
		 * 官方 `dsh-client-ui-user-questions` 的卡片是挂在**本地 waterfall**
		 * 上的（`ctx.remote.$on('user-questions/request', …)`）。而手机这边
		 * 根本没有这条 waterfall —— 请求在电脑上、answerer 也在电脑上，
		 * 手机只收到一条 SSE。没有可挂的 waterfall，官方组件就渲染不出来。
		 *
		 * 所以这里画一张**独立的浮层**，用户点完直接把答案经 RPC
		 * `answerAsk` 送回电脑，由电脑端的 answerer 喂回那条真正的 waterfall。
		 *
		 * ## 设计约束（手机窄屏 + 用户可能在半梦半醒之间点）
		 *
		 * - 卡片从底部升起来，压在输入框上方，不遮挡消息内容；
		 * - 选项做成**整行可点**的大按钮（最小 44px 高，符合触控标准），
		 *   而不是官方那种紧凑的小方块 —— 手机上一排小方块很容易点错；
		 * - 明确写出「来自电脑」，否则用户不知道这是谁在问；
		 * - 授权类**危险动作用红色**、安全的用蓝色，颜色本身就是提示；
		 * - 一次性：点完立刻收起，不做二次确认（二次确认在手机上反而误触）。
		 *
		 * @param ctx - client 根上下文。
		 * @param payload - 电脑端推来的 `{ requestId, kind, … }`。
		 */
		function showAskCard(ctx, payload) {
			try {
				if (document.body === null) return;
				// 同一时刻只留一张：电脑端串行发问，堆叠只会互相遮挡。
				var existing = document.getElementById('dsh-remote-ask');
				if (existing !== null) existing.remove();

				var kind = payload.kind === 'approval' ? 'approval' : 'question';
				var questions = Array.isArray(payload.questions) ? payload.questions : [];
				// 当前正在答第几题（多题时逐题走，避免一屏塞满）。
				var cursor = { index: 0, answers: [] };

				var card = document.createElement('div');
				card.id = 'dsh-remote-ask';
				card.setAttribute('role', 'dialog');
				card.setAttribute('aria-modal', 'false');
				var cs = card.style;
				cs.position = 'fixed';
				cs.left = '10px';
				cs.right = '10px';
				cs.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 76px)';
				cs.zIndex = '2147483001';
				cs.borderRadius = '16px';
				cs.background = '#ffffff';
				cs.color = '#0f1115';
				cs.boxShadow = '0 12px 40px rgba(0, 0, 0, 0.28)';
				cs.padding = '14px 14px 12px';
				cs.fontSize = '14px';
				cs.lineHeight = '1.5';
				cs.maxHeight = '62vh';
				cs.overflowY = 'auto';
				cs.boxSizing = 'border-box';

				/** 小工具：造一个元素并设好样式。 */
				var el = function (tag, css, text) {
					var node = document.createElement(tag);
					if (css) {
						for (var key in css) {
							if (Object.prototype.hasOwnProperty.call(css, key)) node.style[key] = css[key];
						}
					}
					if (text !== undefined) node.textContent = text;
					return node;
				};

				/** 顶部那行「来自电脑」的标识。 */
				var eyebrow = el(
					'div',
					{
						fontSize: '11px',
						letterSpacing: '0.04em',
						color: '#6b7280',
						marginBottom: '6px',
						textTransform: 'uppercase',
					},
					kind === 'approval' ? '电脑请求权限' : '电脑在等你回答',
				);
				card.appendChild(eyebrow);

				/** 收起卡片（不回答 = 让电脑那边超时或走官方兜底）。 */
				var dismiss = function () {
					if (card.isConnected) card.remove();
				};

				/** 把答案送回电脑。 */
				var submit = function (answer) {
					dismiss();
					try {
						// 走官方 RPC 通道（与手机端其他调用同一条）。
						fetch('/api/dsh-remote/rpc', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								method: 'answerAsk',
								params: { requestId: payload.requestId, answer: answer },
							}),
						}).catch(function () {
							// 送不回去就算了：电脑端会超时并走官方兜底，
							// 用户也可以在电脑上直接点。这里弹错误只会添乱。
						});
					} catch (error) {
						if (ctx.logger && typeof ctx.logger.warn === 'function') { ctx.logger.warn('[dsh-remote-mobile] 回传答案失败: ' + String(error)); }
					}
				};

				/** 渲染一题。 */
				var renderQuestion = function () {
					// 清掉除 eyebrow 外的旧内容。
					while (card.childNodes.length > 1) card.removeChild(card.lastChild);

					if (kind === 'approval') {
						// ── 授权：两个大按钮，危险动作红色 ──
						var what = payload.toolName !== '' ? '「' + payload.toolName + '」' : '这个操作';
						card.appendChild(
							el('div', { fontWeight: '600', marginBottom: '4px' }, '允许电脑执行 ' + what + '？'),
						);
						if (typeof payload.reason === 'string' && payload.reason !== '') {
							card.appendChild(
								el('div', { fontSize: '13px', color: '#4b5563', marginBottom: '10px' }, payload.reason),
							);
						} else {
							card.appendChild(el('div', { height: '8px' }));
						}
						var allow = el(
							'button',
							{
								display: 'block',
								width: '100%',
								minHeight: '46px',
								marginBottom: '8px',
								border: 'none',
								borderRadius: '11px',
								background: '#2563eb',
								color: '#ffffff',
								fontSize: '15px',
								fontWeight: '600',
							},
							'允许这一次',
						);
						allow.addEventListener('click', function () {
							submit('allowed-once');
						});
						card.appendChild(allow);
						var deny = el(
							'button',
							{
								display: 'block',
								width: '100%',
								minHeight: '46px',
								border: '1px solid #e5e7eb',
								borderRadius: '11px',
								background: '#f9fafb',
								color: '#b91c1c',
								fontSize: '15px',
								fontWeight: '600',
							},
							'拒绝',
						);
						deny.addEventListener('click', function () {
							submit('rejected');
						});
						card.appendChild(deny);
						return;
					}

					// ── 提问：逐题渲染 ──
					var q = questions[cursor.index];
					if (q === undefined) {
						submit({ answers: cursor.answers });
						return;
					}
					if (questions.length > 1) {
						card.appendChild(
							el(
								'div',
								{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' },
								'第 ' + (cursor.index + 1) + ' / ' + questions.length + ' 题',
							),
						);
					}
					if (typeof q.header === 'string' && q.header !== '') {
						card.appendChild(
							el('div', { fontSize: '12px', color: '#6b7280', marginBottom: '2px' }, q.header),
						);
					}
					card.appendChild(
						el('div', { fontWeight: '600', marginBottom: '10px' }, String(q.question || '请选择')),
					);

					var picked = [];
					var options = Array.isArray(q.options) ? q.options : [];
					var multi = q.multiSelect === true;

					/** 收尾一题：记下答案，进入下一题或提交。 */
					var commit = function (selected) {
						cursor.answers.push({ questionId: q.id, selected: selected });
						cursor.index += 1;
						if (cursor.index >= questions.length) submit({ answers: cursor.answers });
						else renderQuestion();
					};

					options.forEach(function (option) {
						var label = String(option.label || '');
						var row = el('button', {
							display: 'block',
							width: '100%',
							minHeight: '44px',
							marginBottom: '8px',
							padding: '10px 12px',
							border: '1px solid #e5e7eb',
							borderRadius: '11px',
							background: '#ffffff',
							color: '#0f1115',
							fontSize: '14px',
							textAlign: 'left',
							lineHeight: '1.35',
						});
						row.appendChild(el('div', { fontWeight: '500' }, label));
						if (typeof option.description === 'string' && option.description !== '') {
							row.appendChild(
								el('div', { fontSize: '12px', color: '#6b7280', marginTop: '2px' }, option.description),
							);
						}
						row.addEventListener('click', function () {
							if (!multi) {
								commit([label]);
								return;
							}
							// 多选：切换高亮，另有一个「确认」按钮统一提交。
							var at = picked.indexOf(label);
							if (at >= 0) picked.splice(at, 1);
							else picked.push(label);
							row.style.background = at >= 0 ? '#ffffff' : '#eff6ff';
							row.style.borderColor = at >= 0 ? '#e5e7eb' : '#2563eb';
						});
						card.appendChild(row);
					});

					if (multi) {
						var confirm = el(
							'button',
							{
								display: 'block',
								width: '100%',
								minHeight: '46px',
								border: 'none',
								borderRadius: '11px',
								background: '#2563eb',
								color: '#ffffff',
								fontSize: '15px',
								fontWeight: '600',
							},
							'确认',
						);
						confirm.addEventListener('click', function () {
							commit(picked.slice());
						});
						card.appendChild(confirm);
					}

					// 「跳过」：只对多题有意义，单题跳过等于不回答。
					if (questions.length > 1) {
						var skip = el(
							'button',
							{
								display: 'block',
								width: '100%',
								minHeight: '38px',
								marginTop: '4px',
								border: 'none',
								background: 'transparent',
								color: '#6b7280',
								fontSize: '13px',
							},
							'跳过这题',
						);
						skip.addEventListener('click', function () {
							commit([]);
						});
						card.appendChild(skip);
					}
				};

				renderQuestion();
				document.body.appendChild(card);
			} catch (error) {
				if (ctx.logger && typeof ctx.logger.warn === 'function') { ctx.logger.warn('[dsh-remote-mobile] 画 ask 卡片出错: ' + String(error)); }
			}
		}

		/**
		 * 把一帧电脑流式数据折进手机本地会话的 transient 行。
		 *
		 * @param ctx - client 根上下文。
		 * @param sessionId - 两端同名的会话 id。
		 * @param frame - 电脑端流式帧。
		 */		function injectFrame(ctx, sessionId, frame) {
			if (frame.type === 'start') {
				// 上一轮若还挂着（start 帧没等到 end 帧），先把它退役，免得起重。
				var stale = attempts.get(sessionId);
				if (stale !== undefined) {
					attempts.delete(sessionId);
					retireTransient(ctx, sessionId, stale.attemptId);
				}
				attempts.set(sessionId, {
					attemptId: frame.attemptId,
					turn: frame.turn,
					step: frame.step,
					nextIndex: 0,
					gap: 0,
				});
				return;
			}
			var attempt = attempts.get(sessionId);
			if (attempt === undefined || attempt.attemptId !== frame.attemptId) return;
			if (frame.type === 'end') {
				attempts.delete(sessionId);
				// `abandoned` 不会有 durable 结算，全靠这里把残片摘掉。
				retireTransient(ctx, sessionId, attempt.attemptId);
				return;
			}
			if (frame.type !== 'chunk') return;
			if (frame.index !== attempt.nextIndex) {
				// 序号跳了：这一轮流式不可信，交给 durable 通道兜底。
				attempts.delete(sessionId);
				retireTransient(ctx, sessionId, attempt.attemptId);
				return;
			}
			attempt.nextIndex += 1;
			attempt.gap += 1;

			var binding = bindingOf(ctx, sessionId);
			if (binding === undefined) return;

			// transient 的 seq 要插在已提交事件之间：官方用 durableCursor + 1 - 1/(n+1)。
			var cursor = -1;
			var snapshot = binding.eventSource.getSnapshot();
			var entries = (snapshot && snapshot.entries) || [];
			for (var index = 0; index < entries.length; index += 1) {
				var entry = entries[index];
				if (entry.type !== 'transient' && entry.event && typeof entry.event.seq === 'number') {
					if (entry.event.seq > cursor) cursor = entry.event.seq;
				}
			}
			try {
				binding.eventSource.append({
					type: 'transient',
					event: {
						type: 'assistant/live-chunk',
						seq: cursor + 1 - 1 / (attempt.gap + 1),
						time: typeof frame.time === 'number' ? frame.time : Date.now(),
						data: {
							attemptId: attempt.attemptId,
							turn: attempt.turn,
							step: attempt.step,
							chunk: frame.chunk,
						},
					},
				});
			} catch (error) {
				attempts.delete(sessionId);
			}
		}

		/**
		 * 订阅宿主桥的全局 SSE。
		 *
		 * 全局一条：手机 WebView 对并发连接有上限，且一条连接就能服务所有会话。
		 * EventSource 自带断线重连，所以这里不做退避。
		 *
		 * @param ctx - client 根上下文。
		 */
		function subscribe(ctx) {
			var source = new EventSource(ROUTE_STREAM);
			source.addEventListener('frame', function (message) {
				var payload;
				try {
					payload = JSON.parse(message.data);
				} catch (error) {
					return;
				}
				if (!payload || typeof payload.sessionId !== 'string') return;
				injectFrame(ctx, payload.sessionId, payload.frame);
			});
			// durable 结算兜底：万一 `end` 帧丢了，残片也要被摘掉。
			source.addEventListener('settled', function (message) {
				var payload;
				try {
					payload = JSON.parse(message.data);
				} catch (error) {
					return;
				}
				if (!payload || typeof payload.sessionId !== 'string') return;
				var attempt = attempts.get(payload.sessionId);
				if (attempt === undefined) return;
				attempts.delete(payload.sessionId);
				retireTransient(ctx, payload.sessionId, attempt.attemptId);
			});
			// ══ 电脑端发起了 ask 提问 / 权限授权 ══════════════════════════════
			//
			// 用户报障原文（2026-10-21）：
			//   「手机在远程访问电脑的时候，电脑这边工作发起了 ask 弹窗或者
			//     权限授权弹窗，手机那边都没有正常的弹出，导致用户无法选择
			//     任务卡住」
			//
			// 这条事件是**新增的**：`ask` / `approval` 不走会话事件流（它们是
			// cordis waterfall，进程内同步派发、不落盘），所以原来的 `event`
			// 通道一条都碰不到。桌面端现在注册了 answerer 把请求推过来。
			source.addEventListener('ask', function (message) {
				var payload;
				try {
					payload = JSON.parse(message.data);
				} catch (error) {
					return;
				}
				if (!payload || typeof payload.requestId !== 'string') return;
				showAskCard(ctx, payload);
			});
			// 转发失败通知。
			//
			// `prompt` 现在是**乐观返回**的（见服务端 `controller.prompt` 的注释）：
			// 用户按发送后消息立刻上屏，转发在后台跑。所以转发失败时前端**不会**
			// 拿到任何错误 —— 用户会一直等一个永远不来的回复。
			//
			// 这里把失败显式画出来：在消息列表顶部弹一条可读的错误条。
			// 之所以不重试：`prompt` 的失败多为「电脑侧会话不存在 / 路径未知」，
			// 重试也还是同一个结果，必须让用户知道并自己决定（重新同步对话）。
			source.addEventListener('prompt-failed', function (message) {
				var payload;
				try {
					payload = JSON.parse(message.data);
				} catch (error) {
					return;
				}
				if (!payload || typeof payload.message !== 'string') return;
				showPromptFailure(ctx, payload.sessionId, payload.message);
			});
			return function () {
				source.close();
			};
		}
		//#endregion

		/**
		 * 需要宿主提供的服务：slot 注册表、工作区浏览与导航、会话数据。
		 *
		 * ⚠️ `remote` / `remote.agentPresets` 是**预设名单**那条路要用的：
		 * 官方 `dsh-client-ui-agent-preset` 自己也 inject 了这两个
		 * （见其 `lib/client.js:1527` 的 inject 数组）。不加的话 `ctx.remote`
		 * 属性访问会拿到 `undefined`，`patchAgentPresets` 直接静默跳过。
		 */
		/**
		 * 需要宿主提供的服务：slot 注册表、工作区浏览与导航、会话数据、远程命名空间。
		 *
		 * ⚠️⚠️ **这里只能写「真实存在的服务名」，绝不能写带点的子属性。**
		 *
		 * 这是 1.0.25 → 1.0.28 四个版本「改了却完全没有效果」的**真正根因**。
		 *
		 * cordis 的 `Inject.resolve()`（`cordis/lib/index.js:1491`）把数组每一项
		 * 原样收进一个 map：`for (const name of inject) result[name] = null;`。
		 * 然后 `Fiber._refresh()`（同文件 `:1317`）逐个检查：
		 *
		 * ```js
		 * for (const name of Object.keys(this.inject)) {
		 *   const impl = this._store[name];
		 *   if (!impl) { epoch = INACTIVE; break; }   // ← 缺一个就全不激活
		 *   ...
		 * }
		 * ```
		 *
		 * 我原来在这里写了 `'remote.agentPresets'` —— 它不是服务名，而是 `remote`
		 * 服务上的一个**属性**。`_getImpl('remote.agentPresets')` 找不到它
		 * ⇒ `_store['remote.agentPresets']` 是 undefined ⇒ `epoch = INACTIVE`
		 * ⇒ **`apply()` 从头到尾没有被调用过**。
		 *
		 * 症状正好是用户报的三连：
		 *   - 「模型列表能够快速切换回来了，但是预设列表没有切换」——
		 *     模型走的是 `patchModelDirectories`，它在 `apply()` 里……**同样没跑**，
		 *     但模型列表的切换靠的是宿主 `mergeCatalog` + 官方自己的重算，所以照样生效；
		 *   - 「不管是私有默认工作区还是手机目录工作区，都无法切换回手机预设」——
		 *     因为我的 `patchAgentPresets` 一次都没执行；
		 *   - 而「电脑模型列表能显示」也成立：那是宿主侧做的，与客户端插件无关。
		 *
		 * 官方 `dsh-client-ui-agent-preset` 之所以能写 `'remote.agentPresets'`
		 * （见其 `lib/client.js:1532`），是因为它**同时**注入了 `'remote'`
		 * 且那是 `RemoteNamespace` 的合法子服务寻址方式；
		 * 本插件不依赖子命名空间 —— `ctx.remote.agentPresets` 经 `'remote'`
		 * 注入后是可直接读到的属性（`ctx.get('remote')` 的返回值上带它），
		 * 所以只声明 `'remote'` 就够，**不要**再列子路径。
		 */
		const inject = ['slots', 'uiWorkspace', 'sessions', 'workspaces', 'remote'];

		/**
		 * Client 插件主体：注册「手机 / 电脑」双页签的目录选择对话框 + 订阅流式帧。
		 *
		 * @param ctx - client 根上下文。
		 */
		function apply(ctx) {
			/**
			 * ⚠️⚠️ **整个 `apply()` 必须整体兜底 —— 这是 1.0.29 让 App 无限重启的教训。**
			 *
			 * 1.0.29 把 `inject` 里那个非法的 `'remote.agentPresets'` 去掉之后，
			 * `apply()` **第一次真正开始执行**（1.0.25–1.0.28 它从来没跑过，
			 * 所以那四版是「不崩但也不工作」）。
			 *
			 * 一旦它真的跑起来，里面任何一步抛错都会被 cordis 记成插件 FAILED，
			 * 而 `dsh-client-modules` 的 `ClientPackageCompositionError`
			 * （`lib/index.js:144-157`）是**整批聚合抛出**的 —— 一个插件炸掉，
			 * 整页 `Failed to load plugins`，App 直接进救援模式并无限重启：
			 *
			 * ```
			 * 首帧正文="HARNESS Failed to load plugins dsh-jiuli"
			 * 救援：启动层级 = rescue 原因=浏览器侧插件加载失败
			 * 引擎已退出…准备自动重启（第 1 次）
			 * ```
			 *
			 * 用户的原话是「你他妈想让我手机死机是吧」—— 这个兜底就是为此加的。
			 *
			 * **兜底原则：本插件只是「多一个电脑页签」的增强件，
			 * 它坏了绝不能把整个界面带走。** 任何一步失败都只放弃那一步。
			 */
			const guard = (label, fn, fallback) => {
				try {
					return fn();
				} catch (error) {
					// 诊断出口②：被吞掉的异常必须留痕，否则「改了没效果」永远查不出原因。
					try {
						window.__dshRemoteGuardError = String(label) + ': ' + String(error);
					} catch (probeError) {
						/* 诊断失败绝不影响主流程 */
					}
					// 只打日志，绝不外抛：外抛 = 整页加载失败。
					try {
						if (ctx.logger && typeof ctx.logger.warn === 'function') {
							ctx.logger.warn('[dsh-jiuling-remote-mobile] ' + label + ' 失败（已忽略）: ' + error);
						}
					} catch (ignored) {
						/* 连日志都打不出来也不能炸 */
					}
					return fallback;
				}
			};

			const injected = () => ({
				listDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal),
				createDirectory: (path, name) => ctx.uiWorkspace.createDirectory(path, name),
				openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId),
				/**
				 * 把宿主刚建好的会话登记进本地列表。
				 *
				 * 走官方 client 的 `sessions.create({sessionId, cwd})`：
				 * `SessionManager.create()` 在 RPC 回执后立刻
				 * `recordMutation({kind:'placeholder'})` 把这一行写进列表快照，
				 * 于是 `openSession()` 当场就能解析到这个 id。
				 * **不登记就直接 `openSession()` 是竞态**，会抛
				 * `sessions.retain: unknown session` 并被静默吞掉
				 * （详见组件里 `settleLocal` 的注释）。
				 *
				 * 传 `cwd`（宿主回执里的**手机本地**路径）而不是 `workspaceId`：
				 * 宿主侧已经把这个会话挂进工作区了，这里只需要让客户端列表
				 * 认识它；带上 cwd 才能让列表把它分进正确的工作区分组。
				 *
				 * 宿主侧已建过该 id ⇒ `createOrAdopt` 看到活着的 agent 直接返回，
				 * 不会重复建。
				 *
				 * @param sessionId - 会话 id。
				 * @param cwd - 宿主回执里的本地 cwd（两端只在 id 上对齐）。
				 */
				registerLocal: (sessionId, cwd) => {
					const options = { sessionId };
					if (cwd !== undefined && cwd !== '') options.cwd = cwd;
					return ctx.sessions.create(options);
				},
				/** 兜底：拉一次全量会话列表。 */
				refreshSessions: () => ctx.sessions.refresh(),
				/**
				 * 官方的模型目录服务（`super(ctx, "modelDirectories")`）。
				 *
				 * 「刷新」按钮要让它失效重载 —— 官方目录**带缓存**，光把宿主那边的
				 * 数据换掉，前端仍然显示旧值（见 `refreshAll` 的注释）。
				 * `ctx.get` 拿不到就返回 `undefined`，组件里会跳过这一步。
				 */
				modelDirectories: ctx.get === undefined ? undefined : ctx.get('modelDirectories'),
				/**
				 * 把一个会话标记成「跑在电脑上」。
				 *
				 * 建完远程会话**当场**登记，用户不必等下一次全量拉取就能看到
				 * 正确的模型列表（见 `remoteSessionIds` 的注释）。
				 *
				 * @param sessionId - 会话 id。
				 */
				markRemote: (sessionId) => {
					if (typeof sessionId === 'string' && sessionId !== '') remoteSessionIds[sessionId] = true;
				},
				/**
				 * 重拉一次「电脑镜像工作区 slug 集合」。
				 *
				 * ⚠️ **必须在「刚给某个电脑目录建好工作区」之后调**：宿主
				 * `ensureDesktopWorkspace()` 每碰到一个新的电脑目录就往 `workspaceMap`
				 * 里加一条 slug，而前端这份集合是**快照**。不重拉的话，新加的镜像工作区
				 * 在侧边栏里点进去仍会被判成「本地」—— 正是用户报的那个 bug。
				 */
				refreshMirrorSlugs: () => loadMirrorSlugs(),
				/** 解绑后把所有会话退回「本地」（电脑已经不在了）。 */
				clearRemote: () => {
					remoteSessionIds = {};
					mirrorSlugs = {};
				},
			});

			// 拉一次全量远程会话清单（重启 App 后已有会话也要能正确识别）。
			guard('loadRemoteSessionIds', () => loadRemoteSessionIds());
			// 拉一次镜像工作区 slug 集合（隔离的**真正判据**，见 `mirrorSlugs`）。
			guard('loadMirrorSlugs', () => loadMirrorSlugs());

			// 把「按工作区筛模型目录」接到官方服务上。
			guard('patchModelDirectories', () =>
				ctx.effect(
					() => patchModelDirectories(ctx, makeCwdOf(ctx)),
					'dsh-remote-mobile: workspace-scoped model catalog',
				),
			);

			// 把「按工作区筛预设名单」接到官方 RPC 上。
			//
			// ⚠️⚠️ **必须走 `ctx.inject([...], cb)` 子作用域，不能直接用外层 `ctx`。**
			//
			// `remote.agentPresets` 是 `dsh-api-remotes` 动态 provide 的**子命名空间**。
			// 本插件的 `inject` 只声明了父服务 `'remote'`，于是外层 `ctx` 上读
			// `ctx.remote.agentPresets` 会**直接抛**：
			//
			//     Error: cannot get property "remote.agentPresets" without inject
			//
			// 而这句话被 `guard` 吞掉后，`patchAgentPresets` 的第一行就 return 了 ——
			// `list` 一次都没被包过。真机取证（1.0.34，`window.__dshRemoteGuardError`）：
			//
			//     patchAgentPresets: Error: cannot get property "remote.agentPresets" without inject
			//
			// 这才是 1.0.25→1.0.33 九个版本「改了没效果」的**唯一**根因。之前注释里
			// 归因的「Proxy 没解包」「roster 没人重请求」都不是主因 —— 那些代码压根
			// 没跑到过。
			//
			// ⚠️ 但**也不能把 `'remote.agentPresets'` 写进 `export const inject`**：
			// 那是**静态**声明，子服务在未配对/未挂载时不存在 ⇒ `Fiber._refresh()`
			// 里 `epoch = INACTIVE` ⇒ **整个插件一次都不激活**（连目录选择器都没了）。
			// `ctx.inject()` 是**运行期**动态作用域：子服务就绪才回调，不阻塞本插件。
			guard('patchAgentPresets', () =>
				ctx.inject(['remote.agentPresets', 'uiWorkspace', 'sessions', 'workspaces', 'slots'], (scope) => {
					scope.effect(
						() => patchAgentPresets(scope, makeCwdOf(scope)),
						'dsh-remote-mobile: workspace-scoped agent presets',
					);
				}),
			);

			// 负 priority：single slot 取 entries[0]，entries 按 priority 升序 ⇒ 最先渲染。
			const register = (name) =>
				ctx.slots.register(
					{
						name: name,
						priority: -1,
						inject: injected,
					},
					RemoteDirectoryFlow,
				);

			guard('slots.inject', () =>
				ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
					ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
						yield register('conversation.hero.workspace.directoryFlow');
						yield register('sidebar.workspaces.directoryFlow');
					}),
				),
			);

			guard('subscribe', () =>
				ctx.effect(() => subscribe(ctx), 'dsh-remote-mobile: assistant stream bridge'),
			);

			// 「同步对话」：把菜单项接进工作区行的「⋯」菜单。
			//
			// ⚠️ 必须先拉一次镜像工作区清单：菜单项要按工作区标题反查电脑路径，
			// 清单为空时那一项会静默不出现（不报错，但功能等于没有）。
			guard('refreshMirrorWorkspaces', () => {
				ctx.effect(() => {
					refreshMirrorWorkspaces();
					// ⚠️⚠️ **原来这里有一个 `setInterval(refreshMirrorWorkspaces, 5000)`**
					// —— 每 5 秒打一次隧道，**7×24 不停**，一小时 720 次。
					//
					// 这是纯隐形浪费，理由：
					//   · 这个清单只在**用户选了/新增了电脑工作区**之后才会变；
					//   · 而那种操作一定伴随一次工作区列表变化，宿主会推事件；
					//   · 就算事件漏了，用户打开「⋯」菜单时再拉一次也来得及
					//    （菜单是点出来的，不是常驻的）。
					//
					// 所以改成**事件驱动 + 极低频兜底**：
					//   · 主路：`api-workspace/added` 之类的工作区事件（见下面的订阅）；
					//   · 兜底：每 10 分钟一次，只为覆盖「事件没覆盖到的边角」。
					//
					// 用户第一准则是「不费流量」，720 次/小时 vs 6 次/小时，
					// 差的不是一点。而功能上没有任何损失：菜单点开前清单一定是新的。
					const timer = setInterval(refreshMirrorWorkspaces, 10 * 60 * 1000);
					// 工作区真的变了就重拉（这是唯一真正需要的时机）。
					//
					// ⚠️ 事件名必须用官方的 `domain/changed`（见
					// `dsh-api-workspace-controller/lib/index.js:48`）。官方**没有**
					// `api-workspace/added` 这种事件 —— 那是 `api-session/*` 那一套的
					// 命名习惯，套到工作区上是我猜错了，订阅会静默收不到任何东西。
					//
					// 判据与官方 `changed()` 一致：
					//   · `change.domain === 'workspace'` ⇒ 工作区集合/顺序变了；
					//   · `change.table === 'workspaces'` ⇒ 某条工作区记录变了。
					const off = ctx.on('domain/changed', function (change) {
						if (change === null || typeof change !== 'object') return;
						if (change.domain !== 'workspace' && change.table !== 'workspaces') return;
						refreshMirrorWorkspaces();
					});
					return () => {
						clearInterval(timer);
						if (typeof off === 'function') off();
					};
				}, 'dsh-remote-mobile: mirror workspace index');
			});

			guard('installSyncMenu', () =>
				ctx.effect(() => installSyncMenu(ctx), 'dsh-remote-mobile: 同步对话菜单'),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
