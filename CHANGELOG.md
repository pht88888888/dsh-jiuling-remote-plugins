# 更新日志

版本号各自独立：电脑端 `dsh-jiuling-remote-desktop`、手机端 `dsh-jiuling-remote-mobile`。

---

## 手机端 `dsh-jiuling-remote-mobile`

### 1.2.98

- **修复：同步会话被写坏后从侧边栏永久消失（严重）**
  两条用户反馈（20261030-111618-3d1620、20261029-030943-8a4b33）指向同一根因：
  同步会话的本地「占位壳」只该放 `session/title` + 一对占位 turn，但
  `pollCatchUp` 与 `followSynced` 会把电脑上的 **mid-turn 事件**写进去
  （从对话中段开始，缺 `turn/start` / `step/start`，还夹着 delivery 标记事件），
  引擎 session-format v4 校验器随即判损坏 ⇒ 会话不渲染 ⇒ 用户看到「消失」。
  现在两条写盘路径都跳过同步会话（`broadcast` / `deriveRunning` 保留，
  实时显示与运行态照常正确）。
- **修复：损坏自愈的重建路径必然失败**
  `ensureLocalMirror` 的 catch 块引用了外层 try 的块内变量 `request`，
  每次重建必抛 `request is not defined` ⇒ 壳被删了又建不回来 ⇒ **永久消失**。
  现在就地构造 request，并在重建成功后补 `markSessionNonBlank`
  （否则新壳没有 `turn/start`，按 blank 规则仍会被隐藏）。
- **装错端提醒**：`dsh-jiuling-remote-mobile` 运行在 win32 / darwin 上时打印
  明确警告，提示电脑端应该装 `dsh-jiuling-remote-desktop`。
  有用户把手机端包装进电脑 DSH，导致启动反复崩溃（20261029-150302-2ab475）。
- 「缺口过大」日志对同步会话静默（原来每个同步会话每 3 秒刷一条）。

### 1.2.97

- **修复：后来进入 App 时，弹窗能看见但点了电脑端收不到**
  手机不在线的那一刻，电脑端原来会「立刻把 fallback 交回 GUI」并把请求放进
  `ghostAsks`（幽灵记录）。实测证明那个假设不成立：GUI 并没有「接管并结束」，
  而是一直在等；而 `answerAsk` 只查 `pendingAsks`，于是手机上点它只能拿到
  `expired` —— 表现为「点了没反应」。现在无论手机是否在线都登记进
  `pendingAsks` 并等待，`ghostAsks` 整个概念删除。
- **修复：`ask_user_question` 报 `value is not lossless JSON`**
  回传答案的字段名是 `questionId`，而官方 `answerResult()` 读的是 `answer.id`，
  于是 `id` 变成 `undefined` 并被带进工具输出。改用官方的
  `id` / `selected` / `custom`，电脑端另加一层严格校验挡住坏数据。
- **修复：不在那个对话时也弹悬浮窗**
  收到 ask 时比较 `sessionId` 与当前打开的会话，不一致就不弹（请求不丢，
  切过去时会补出来）。避免不相关的浮层一直挡在别的对话上。

### 1.2.96

- **修复：自绘弹窗点击无反应、无输入框、与系统弹窗重复**
  ① 答案形状不匹配被电脑端判成「没答」；② 问题没有选项时卡片上一个可点元素
  都没有，既答不了也关不掉（补 textarea + 提交 + 跳过）；③ 自绘与官方两条渲染
  路径同时触发导致两张卡片叠加，现统一只走自绘。

### 1.2.95 / 1.2.94

- **修复：App 退后台再回来收不到任何东西**
  WebView 冻结后 EventSource 不会自愈。改成 3 秒一条**短连接**轮询补洞
  （长连接死掉也照样能同步），并按「本地 seq 是否真的前进」决定是继续
  立刻补还是等下一个周期，避免 0 延迟空转。
- 顺带修掉轮询自己的死锁：`pollCatchUp` 顶部原来的
  `if (watchers.size === 0) return;` 恰恰在最需要它的场景下把整条轮询关掉了。

### 1.2.93

- 修复前台唤醒（`wake`）后不立即补洞、要等下一个周期才同步的问题。

### 1.2.92

- **修复：ask 卡片渲染成功但用户完全看不到**
  卡片原本贴底定位，被约 300px 高的输入框整块盖住（实测可见高度 0/219）。
  改为贴顶 `calc(env(safe-area-inset-top) + 64px)`，并加 `max-height` 与滚动。

### 1.2.19 – 1.2.91

- 配对多地址回退、分页、启动连接风暴、文件选择器滚动、模型与预设列表刷新、
  监听器泄漏等一批修复，详见 git 历史。

### 1.2.18

- **修复：目录选择弹窗在横屏/矮屏下列表高度为 0**
  中间区被「已配对」提示条和说明文字吃光后，列表被压成 `0px` —— 用户一个文件夹都看不到。
  给列表加 `min-height:96px`，并让中间区整体可滚（原来是 `overflow:hidden`，超出部分
  直接被裁掉，用户连滑的机会都没有）。

### 1.2.17

- **修复：弹窗被内容撑满整屏、标题栏与底部按钮消失**
  1.2.15 只写了 `height:min(560px,100dvh - 32px)`。`dvh` 是 Chrome 108+ 的单位，
  旧 WebView 不认识它会让**整条声明失效**（不是降级，是整条无效），`height` 退回
  `auto`，几十个文件夹就把弹窗撑到屏幕 2.6 倍高。
  现在三档兜底：`vh` → `dvh` → `100%`，并把理想高度从 560px 提到 720px。
- 横竖屏实测：竖屏可视行数 7 → 18 行；旧内核模拟下弹窗高度 2021px → 716px。

### 1.2.15

- 修复 `display:contents` 导致 `flex:none` / `flex:1 1 auto` 全部失效的问题，
  改为真正的 flex 列容器。
- 头部与底栏间距改用 `clamp()`，随视口高度收缩，把空间让给文件列表。

### 1.2.13

- **修复：切换非官方模型时仍显示官方「1017」标签**
  根因是 `mergeCatalog` 用了 `...local`，导致 `default` 取的是手机本地的
  `deepseek-official/deepseek-flash`。官方前端按
  `current = projected.next ?? catalog.value.default` 算当前选中，投影为空时退回
  这个官方默认值，于是不管点哪个第三方模型，provider 都被算成 `deepseek-official`。
  改为优先用电脑的 `default`，本地工作区再用 `localDefault` 还原。
- **修复：手机选的模型不同步到电脑**
  模型选择原来只存在内存 `pendingPlans` 里，App 重启即丢；丢了之后请求不带 `model`，
  电脑就用自己的默认模型（可能是该 provider 不支持的型号，导致 502）。
  现在模型选择落盘到 `sessions.json` 的 `models` 键，发消息时优先用最新选择，
  其次读落盘值兜底。
- 修复补洞写入的 off-by-one：`wantFrom` 少算了 1，导致每次补洞都失败。
- 本地会话日志损坏时，`selectModel` 这条路也会删掉坏日志并重建（原来只在
  SSE 事件到达时才自愈）。

### 1.2.11

- 预设列表在缓存为空时主动去电脑拉取，不再要求重启才显示完整列表。

---

## 电脑端 `dsh-jiuling-remote-desktop`

### 1.0.52

- **修复：手机离线时把 ask 判成「已交给 GUI」，导致手机后来作答无效**
  原来手机不在线就立刻 `return fallback`（`NO_TAKEOVER`）并把请求塞进
  `ghostAsks`。实测证明 GUI 并没有因此结束这一轮，而是一直在等 ——
  于是手机上作答拿到 `expired`，表现为「点了没反应」。现在无论手机在不在线
  都登记进 `pendingAsks` 并等待，`ghostAsks` 已删除。
- **新增：手机答案的形状校验**
  逐条校验 `id` 是非空字符串、`selected` 是数组，不合格就当没答退回 GUI，
  避免把 `undefined` 带进工具输出触发
  `tool "ask_user_question" returned invalid output: value is not lossless JSON`。
- **修复：`sessionCursors` 恒返回空对象**
  原来读 `item.projections.asOfSeq`，而官方 `listFields()` 并不提供该字段。
  改用 `session.seq - 1`（会话存活）或 `sessionQuery.observeSession().cursor`（冷会话）。

### 1.0.51

- 补齐 `sessionCursors` / `readEventRange` 等 RPC，供手机端 3 秒轮询补洞使用。

### 1.0.42

- **修复：绑定过程中下载依赖超时，导致激活码失效且无法重装**
  原来 `/register` 把两件事塞在一起：先拿激活码去服务端注册（**此刻激活码已被消费**），
  再在同一个 HTTP 请求里下载 55 MB 的 cloudflared（实测 47–67 秒）。国内网络下
  常见的结果是：激活码已经绑到机器上，但下载超时让整个响应失败，用户看到「绑定失败」
  以为没用上，重填就可能撞上服务端的「设备不符」，激活码永久废掉。
- **改动**：把下载与注册彻底拆开。
  - 新增 `/environment` 端点，专门检查并下载依赖，可以随便重试。
  - `/register` 只做注册，几秒返回，不再下载任何东西（只调 `findCloudflared()` 查询）。
- **界面**：未配对时拆成固定两步 —— 先「第 1 步：准备环境」（带百分比进度条），
  环境就绪后「第 2 步：填写激活码」的输入框才出现。
- 已配对但组件缺失的用户，那个按钮变成主按钮并改名为「下载隧道组件」，不必解绑重配。

### 1.0.41

- 补齐 `readEventRange` / `modelCatalog` / `presetList` 三个 RPC，供手机端调用。

---

## 更早的版本

早期迭代没有逐条记录。主要里程碑：

- 隧道打通，手机可浏览电脑目录并在电脑上开会话。
- 配对从「手工填隧道地址」改为「激活码 + 配对码」。
- 移除包内硬编码的隧道令牌（那等于把凭据公开发布到 npm）。
- 事件流镜像支持断点续传与乱序补洞。
- 解绑时通知服务端清除记录，避免出现「本机已解绑但服务端仍占着」的死局。
