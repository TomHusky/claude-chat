# ClaudeCopilot — VS Code 插件

一个对标 GitHub Copilot Chat 的聊天插件，**底层驱动你本机的 `claude` CLI**（Claude Code）。
复用你已有的 Claude 订阅 / 登录态 —— 插件不需要 API Key，所有请求都由本地 `claude` 进程发出。

## ⚡ 安装

仓库内已附带打包好的安装包，**无需自己构建**。在仓库根目录执行：

```bash
code --install-extension release/claude-chat.vsix --force
```

然后 Reload Window 即可。完整步骤（含 `code` 命令未安装、图形界面安装、从源码构建等）见 **[INSTALL.md](INSTALL.md)**。

> 前置条件：本机已安装并登录 `claude` CLI（`claude --version` 可用）。已针对 claude-code **2.1.x** 验证。

## 功能

### 聊天

- 🗨️ **聊天面板**：多轮对话、流式回复、Markdown + 代码高亮；可在侧边栏与编辑器区之间切换
- 🧠 **思考过程**：思考阶段显示为时间线节点（`Thinking · Ns`，悬停查看思考内容），思考中实时显示 token 数；直播与历史回放渲染一致
- 🔧 **工具调用卡片**：Read / Write / Edit / Bash 等以卡片展示输入与结果；`TodoWrite` 渲染为勾选清单
- 🔗 **可点击引用**：AI 提到的文件路径、`file.ts:42` 行号、符号名都会变成可点击链接跳转到源码。**校验后才给链接** —— 工作区里不存在的一律降级为纯文本，不留死链接
- ✅ **改动待确认区**：默认权限模式下每个敏感操作弹出 *允许 / 拒绝 / 本会话总是允许*
- 🗂 **已更改文件面板**：本会话被 Claude 改过的文件集中列出（默认折叠，每轮开始自动收起），逐个或全部 *保留 / 回滚*，点击查看 diff
- 🖼 **图片**：输入框粘贴图片直接发送；聊天内图片点开大图，可复制 / 保存
- 🧭 **我的消息**：顶部按钮弹出全部提问列表，点击跳到对应消息，长会话快速定位
- ⛔ **随时中断**：停止按钮即时生效
- 📋 **任务队列**：回复进行中可继续排队消息，按顺序自动发送
- 📊 **用量胶囊**：5 小时 / 每周额度实时显示，限额告警可按周期关闭；输入框旁上下文占用环，压缩 / 还原后即时刷新

### 会话

- 🕘 **会话管理**：复用 Claude Code 的本地会话记录，可切换、重命名、单个或批量删除；删除会同步清理官方侧的附属数据（`file-history` / `session-env` / `tasks` / 子 agent 记录），不留"删了还在"的残留
- ⏱ **还原点**：每轮对话前自动建点。一键还原会**同时**回滚工作区文件、**并真正截断对话**（截断 `.jsonl` + `--resume` 续接，Claude 会真的"忘记"之后的轮次）；被回退的那条提问连同图片附件自动带回输入框，改完即可重发。截断前有安全校验，还原点与对话对不上时中止，绝不误删上下文
- ⑂ **派生新会话**：还原点旁一键把截断点之前的对话复制成新会话、新标签页打开（对齐官方 *Fork conversation from here*）——当前会话不回滚不截断，两边此后各自独立；分支带走此前的还原点，仍可继续回退
- ✏️ **消息编辑重发**：改写历史消息并从该点重新生成
- 🗜 **上下文压缩**：`/compact` 一键压缩；超大会话打开时会主动提示压缩

### 性能与稳定性

- 🔥 **进程预启动**：打开会话即后台 `--resume` 拉起进程，把读取上下文的耗时与你读历史/打字的时间重叠
- ♨️ **缓存预热**：大会话（>1MB）后台预热服务端 prompt cache。预热记录跨窗口共享、不重复烧 token；超过 `prewarmMaxSizeMB` 的会话不再预热而是建议压缩
- 🧯 **保活池**：关闭 tab 的会话进程后台保留（LRU，上限 5 个），重新打开秒回；正在回复的进程永不被回收
- 🐕 **双看门狗**：① 一轮对话完全静默超时（默认 12 分钟）判定 CLI 卡死，自动重置连接并提示重发，上下文不丢；② webview 通道假死检测（ping/pong），自动重建界面并保留输入框草稿
- 📁 **固定日志目录**：`~/.claude-chat/logs/`（按天分文件、保留 7 天），命令面板 `Claude: 打开日志文件夹` 直达

### 扩展能力

- 🤖 **QQ 机器人**：接入 QQ 开放平台，手机上发消息即可远程操控 Claude 干活。白名单授权 + 配对模式；支持 `/help` `/status` `/usage` `/model` `/effort` `/compact` `/clear` `/stop` 命令。多窗口自动选主，全局只保持一个机器人连接
- 📈 **SLS 日志查询**：接入阿里云 SLS，让 Claude 直接查生产日志辅助排查；支持**多账号**（独立配置面板，卡片式管理），按应用/项目自动路由到对应账号
- 🔔 **任务完成推送**：长任务跑完时向 webhook（飞书/企微/钉钉群机器人）推一条通知，任务耗时超过阈值即推。面板标题栏铃铛图标（或命令 `Claude: 任务完成推送配置`）打开配置页，可发测试消息
- ⌨️ **斜杠命令**：输入框支持 `/help` `/clear` `/compact` `/model` `/effort` `/usage`，未知的 `/` 命令原样透传给 CLI（不吞掉 skills）
- 🔄 **插件更新**：每 3 小时自动检测新版本，侧边栏亮起「发现新版本 · 点击更新」横幅，点击一键下载安装；也可命令面板 `Claude: 检查更新`

## 配置项（设置 → 搜索 "Claude Chat"）

| 配置 | 说明 | 默认 |
| --- | --- | --- |
| `claudeChat.claudePath` | `claude` 可执行文件路径（不在 PATH 时填绝对路径） | `claude` |
| `claudeChat.model` | 模型（`opus` / `sonnet` / `fable` 或完整 id），留空用 CLI 默认 | `""` |
| `claudeChat.permissionMode` | 新会话的初始权限模式 | `default` |
| `claudeChat.effort` | 推理强度 `low`/`medium`/`high`/`xhigh`/`max` | `""` |
| `claudeChat.appendSystemPrompt` | 追加到系统提示的全局指令（如强制中文回复） | `""` |
| `claudeChat.snapshotFilesForRestore` | 文件被修改前先快照，供还原点回滚 | `true` |
| `claudeChat.prespawnOnOpen` | 打开会话即后台启动进程 | `true` |
| `claudeChat.prewarmCache` | 大会话打开时预热 prompt cache（耗 token） | `true` |
| `claudeChat.prewarmMaxSizeMB` | 超过此大小不再预热，改为建议压缩；`0` 表示不限制 | `12` |
| `claudeChat.turnStallTimeoutSec` | 一轮对话允许的最大完全静默秒数，超时判定卡死并自愈 | `720` |
| `claudeChat.qqBotPermissionMode` | QQ 机器人专用会话的权限模式 | `acceptEdits` |
| `claudeChat.notifyWebhook` | 任务完成推送的 webhook（支持飞书/企微/钉钉群机器人），留空关闭 | `""` |
| `claudeChat.notifyMinDurationSec` | 任务时长达到该秒数才推送 | `60` |
| `claudeChat.pythonPath` | SLS 查询引擎初始化用的 python3 路径 | `""` |

## 快捷键

- `Cmd/Ctrl+Shift+I`：聚焦聊天输入框
- `Cmd/Ctrl+Shift+L`：把编辑器选中代码加入聊天上下文
- 输入框中 `Enter` 发送 / `Shift+Enter` 换行

## 工作原理

### 与 claude CLI 的对接

插件为每个会话维护**一个长驻的 `claude` 子进程**，通过官方
[`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/typescript)
的 streaming input mode 驱动 —— 这是官方推荐的集成形态，官方 VS Code 扩展亦然。

- **启动**：用官方 `startup()` / `WarmQuery` 先 spawn 子进程并完成 initialize 握手，再挂上消息流。（直接 `query()` 会把 spawn 推迟到第一条消息，预启动就失去意义。）
- **权限**：`canUseTool` 回调 → 界面待确认区 → 用户点击后 resolve 挂起的 Promise。
- **中断 / 切模型 / 切权限模式**：`Query` 对象的原生方法，进程保留不杀，中断后可继续对话。
- **鉴权计费**：SDK 驱动的是你本机已登录的 `claude` CLI，与你自己在终端里敲 `claude` 完全一致，插件不接触任何凭据。

协议层由官方维护，CLI 升级不必再追协议变化。（0.1.238 之前另有一套自维护的
stream-json 解析实现，SDK 稳定后已整体移除。）

### 会话与还原点

- 会话记录由 Claude Code 自身持久化在 `~/.claude/projects/<编码后的工作目录>/<session-id>.jsonl`，插件读取这些文件来列出、回放、还原历史会话。
- **还原点的真实截断**：每轮发送前记录该 `.jsonl` 的行数；还原时先结束当前进程、把文件截断回该行数，下一条消息用 `--resume` 续接 —— `.jsonl` 是顺序追加的，截断成前缀等价于把会话回退到那个时间点。
- 历史回放会过滤掉 CLI 注入的合成消息（`task-notification`、斜杠命令回显、`[Request interrupted by user]` 等），只渲染真人发的内容。

## 已知限制

- **需要本机 `claude` CLI 已登录**，插件不接受 API Key。
- **还原点的截断粒度按整轮对齐**；若上一轮收尾元数据尚未落盘就立刻还原（极少见），可能少留一两行无关元数据，不影响记忆与文件回滚。
- **还原点只在「从插件输入框发出消息」时建立**：Claude 回复期间由 CLI 侧产生的轮次（如任务通知、其它入口插入的内容）没有还原点入口——轮次中间无法安全截断（会拆散工具调用与结果的配对）。
- `acceptEdits` / `bypassPermissions` 模式下 CLI 自动应用编辑、不再询问，因此不弹待确认区（但文件仍会被快照，可还原）。
- **QQ 机器人的工具请求一律自动放行**（远程无法逐条弹窗确认），白名单是唯一的安全边界；只想让它读代码可把 `qqBotPermissionMode` 设为 `plan`。
- 超大会话（>10MB）受 CLI 自身限制，`--resume` 会很慢甚至卡住，请及时 `/compact`。
- 行内补全（Ghost text）按需不做。

## 目录结构

```
src/
  extension.ts            激活入口，注册视图与命令，日志双写
  shared.ts               扩展 <-> webview 的消息契约（无运行时依赖）
  claude/
    process.ts            ClaudeProcess：官方 Agent SDK 对接（进程、事件翻译、权限）
    session.ts            SessionStore：读写 CLI 的 .jsonl 会话记录
  checkpoints.ts          CheckpointManager：文件快照与还原点
  panel/
    chatViewProvider.ts   核心：进程池 / 会话 / 预热 / 看门狗 / QQ / SLS 桥接
  qq/
    bot.ts                QQ 开放平台机器人（WebSocket，零依赖）
  webview/
    main.ts               前端：流式 Markdown、工具卡片、待确认区、引用链接校验
media/
  main.css                使用 VS Code 主题变量的样式
  webview.js              （构建产物）前端打包，内联 markdown-it + highlight.js
```

## 开发

```bash
npm install
npm run build      # 生产构建；开发时用 npm run watch
npm run check-types
```

用 VS Code 打开本文件夹按 **F5** 启动 *Extension Development Host*。打包发布：

```bash
npx @vscode/vsce package --no-dependencies
code --install-extension claude-chat-<版本>.vsix --force
```

> 打包产物同时更新 `release/claude-chat.vsix` 并随仓库提交，同事直接拉取安装。

## License

MIT
