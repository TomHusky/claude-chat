# ClaudeCopilot — VS Code 插件

对标 GitHub Copilot Chat 的聊天插件，**底层驱动你本机的 `claude` CLI**（Claude Code）。
复用你已有的 Claude 订阅与登录态——插件不需要 API Key，所有请求都由本地 `claude` 进程发出，鉴权与计费和你在终端里敲 `claude` 完全一致。

## 目录

- [安装](#安装)
- [功能](#功能)
- [使用](#使用)
- [配置项](#配置项)
- [工作原理](#工作原理)
- [已知限制](#已知限制)
- [目录结构](#目录结构)
- [开发与发布](#开发与发布)

## 安装

仓库内已附带打包好的安装包，**无需自己构建**。在仓库根目录执行：

```bash
code --install-extension release/claude-chat.vsix --force
```

然后 Reload Window。完整步骤（`code` 命令未安装、图形界面安装、从源码构建、卸载）见 **[INSTALL.md](INSTALL.md)**。

> 前置条件：本机已安装并登录 `claude` CLI（`claude --version` 可用）。已针对 claude-code **2.1.x** 验证。

## 功能

### 聊天

- **聊天面板**：多轮对话、流式回复、Markdown + 代码高亮；可在侧边栏与编辑器区之间切换
- **思考过程**：思考阶段显示为时间线节点（`Thinking · Ns`，悬停查看内容），思考中实时显示 token 数；直播与历史回放渲染一致
- **工具调用卡片**：Read / Write / Edit / Bash 等以卡片展示输入与结果；WebSearch / Grep / Glob 把查询词、URL、pattern 提到标题行；`TodoWrite` 渲染为勾选清单；Skill 紧凑一行
- **可点击引用**：AI 提到的文件路径、`file.ts:42` 行号、符号名都变成链接跳到源码；**校验后才给链接**，工作区里不存在的降级为纯文本，不留死链
- **改动待确认区**：默认权限模式下每个敏感操作弹出 *允许 / 拒绝 / 本会话总是允许*
- **已更改文件面板**：本会话被 Claude 改过的文件集中列出（默认折叠，每轮开始自动收起），逐个或全部 *保留 / 回滚*，点击查看 diff。用 Edit / Write 工具改的、以及 auto 模式下用 `sed` / 重定向等 Bash 命令改的，都会进列表
- **消息内容搜索**：`Cmd/Ctrl+F` 唤出浮层，浮在聊天区右上角，不挤压内容也不改滚动位置；命中处底色标记、当前一条描边并滚到视野内；`Enter`/`↓` 下一处、`Shift+Enter`/`↑` 上一处、`Esc` 关闭；计数等宽数字，无结果输入框转红
- **我的消息**：顶部问题栏右侧按钮弹出本会话全部提问列表，点击跳转，长会话快速定位
- **图片**：输入框粘贴图片直接发送；聊天内图片点开大图，可复制 / 保存
- **重新生成**：最新一条回复下方一键重新生成（回退到该轮之前重发同一条提问，图片附件一并带上）；旧回复不提供此按钮，避免误砍后面的对话
- **随时中断**：停止按钮即时生效，正在压缩上下文时也能停
- **任务队列**：回复进行中可继续排队消息，按顺序自动发送
- **用量胶囊**：5 小时 / 每周额度实时显示（含按模型的周限），限额告警可按周期关闭；输入框旁上下文占用环，压缩 / 还原后即时刷新

### 会话

- **会话管理**：复用 Claude Code 的本地会话记录，可切换、重命名、单个或批量删除；删除会同步清理官方侧的附属数据（`file-history` / `session-env` / `tasks` / 子 agent 记录），不留"删了还在"的残留
- **会话置顶**：列表每行 hover 出现图钉，置顶的会话在最上方独立成组（跨窗口 / 重启保留）
- **还原点**：每轮对话前自动建点，每一轮（含第一条前）都能「还原到此处」。一键还原会**同时**回滚工作区文件、**并真正回退对话**——Claude 会真的"忘记"之后的轮次，官方插件与 `--resume` 看到的也立即一致；被回退的那条提问连同图片附件自动带回输入框，改完即可重发。会话进行中点还原会先自动停止；还原期间消息区压暗并显示过渡提示
- **派生新会话**：还原点旁一键把截断点之前的对话复制成新会话、新标签页打开（对齐官方 *Fork conversation from here*）——当前会话不回滚不截断，两边此后各自独立；分支带走此前的还原点
- **上下文压缩**：`/compact` 一键压缩；超大会话打开时主动提示压缩
- **长会话回放**：打开只渲染最近 20 轮，更早的折叠为「加载更多消息」，每次点击向上加载 30 轮（分段渲染，不再一次全展开卡死界面）

### 性能与稳定性

- **进程预启动**：打开会话即后台 `--resume` 拉起进程，把读取上下文的耗时与你读历史 / 打字的时间重叠
- **缓存预热**：大会话（>1MB）后台预热服务端 prompt cache；预热记录跨窗口共享不重复烧 token；超过 `prewarmMaxSizeMB` 的会话改为建议压缩
- **保活池**：关闭 tab 的会话进程后台保留（LRU，上限 5 个），重新打开秒回；正在回复的进程永不被回收
- **双看门狗**：① 一轮对话完全静默超时（默认 12 分钟）判定 CLI 卡死，自动重置连接并提示重发，上下文不丢；② webview 通道假死检测（ping / pong），自动重建界面并保留输入框草稿
- **固定日志目录**：`~/.claude-chat/logs/`（按天分文件、保留 7 天），命令面板 `Claude: 打开日志文件夹` 直达

### 扩展能力

- **QQ 机器人**：接入 QQ 开放平台，手机上发消息即可远程操控 Claude。白名单授权 + 配对模式；支持 `/help` `/status` `/usage` `/model` `/effort` `/compact` `/clear` `/stop`。多窗口自动选主，全局只保持一个机器人连接
- **SLS 日志查询**：接入阿里云 SLS，让 Claude 直接查生产日志辅助排查；支持**多账号**（独立配置面板，卡片式管理），按应用 / 项目自动路由；查询结果省 token（单字段截断保头保尾，`--full` 逃生口）
- **任务推送**：长任务跑完向 webhook（飞书 / 企微 / 钉钉群机器人）推通知，耗时超过阈值即推；Claude 停下来等你输入（工具授权 / 选项提问）且你离开超过同一阈值时，也推一条「等你输入」提醒（后台会话同样生效）。标题栏铃铛或命令 `Claude: 任务推送配置` 打开配置页，可发测试消息
- **插件更新**：每 3 小时自动检测新版本，侧边栏亮起「发现新版本 · 点击更新」横幅，一键下载安装；也可命令面板 `Claude: 检查更新`

## 使用

### 快捷键

| 按键 | 作用 |
| --- | --- |
| `Cmd/Ctrl+Shift+I` | 聚焦聊天输入框 |
| `Cmd/Ctrl+Shift+L` | 把编辑器选中代码加入聊天上下文 |
| `Cmd/Ctrl+F`（聊天面板内） | 搜索消息内容；`Enter` / `Shift+Enter` 前后跳，`Esc` 关闭 |
| `↑` / `↓`（输入框内） | 调回发过的消息（shell 手感）；光标在首行/末行且无选区时才接管，不影响多行编辑 |
| `Enter` / `Shift+Enter` | 发送 / 换行 |

### 斜杠命令

输入框输入 `/` 弹出提示。以下由插件处理，其余 `/` 命令原样透传给 CLI（不吞掉 skills）：

| 命令 | 作用 |
| --- | --- |
| `/help` | 列出可用命令 |
| `/clear [消息]` | 丢掉本轮之前的历史，用全新上下文回复（可直接带上要问的话） |
| `/compact` | 压缩上下文：把历史总结成摘要 |
| `/model [名称]` | 切换模型，如 `/model opus`；不带参数列出可选 |
| `/effort [档位]` | 切换思考强度，如 `/effort high` |
| `/usage` | 查看 5 小时 / 每周用量 |

### 模型与模式

- **模型**：输入框下方选择器可选 Fable 5.1 / Opus 5 / Sonnet 5 / Haiku 4.5，家族行用 CLI 别名跟随最新；Fable / Opus / Sonnet 行右侧「›」弹出历史版本子菜单（如 Opus 4.8 / 4.7 / 4.6 / 4.5），热切换不重启进程
- **思考强度**：`low` / `medium` / `high` / `xhigh` / `max`
- **权限模式**：`default`（逐个确认）/ `acceptEdits`（自动应用文件编辑）/ `plan`（先规划）/ `auto`（CLI 自动判定）/ `bypassPermissions`（全部放行，危险）

### 命令面板

`Claude: 打开新会话` · `Claude: 在编辑器右侧打开` · `Claude: 检查更新` · `Claude: SLS 日志配置` · `Claude: QQ 机器人配置` · `Claude: 任务推送配置` · `Claude: 打开日志文件夹`

## 配置项

设置 → 搜索 "Claude Chat"。

| 配置 | 说明 | 默认 |
| --- | --- | --- |
| `claudeChat.claudePath` | `claude` 可执行文件路径（不在 PATH 时填绝对路径） | `claude` |
| `claudeChat.model` | 模型（`opus` / `sonnet` / `fable` 或完整 id），留空用 CLI 默认 | `""` |
| `claudeChat.permissionMode` | 新会话的初始权限模式 | `default` |
| `claudeChat.effort` | 推理强度 `low` / `medium` / `high` / `xhigh` / `max` | `""` |
| `claudeChat.appendSystemPrompt` | 追加到系统提示的全局指令（如强制中文回复） | `""` |
| `claudeChat.snapshotFilesForRestore` | 文件被修改前先快照，供还原点回滚 | `true` |
| `claudeChat.prespawnOnOpen` | 打开会话即后台启动进程 | `true` |
| `claudeChat.prewarmCache` | 大会话打开时预热 prompt cache（耗 token） | `true` |
| `claudeChat.prewarmMaxSizeMB` | 超过此大小不再预热，改为建议压缩；`0` 表示不限制 | `12` |
| `claudeChat.turnStallTimeoutSec` | 一轮对话允许的最大完全静默秒数，超时判定卡死并自愈 | `720` |
| `claudeChat.qqBotPermissionMode` | QQ 机器人专用会话的权限模式 | `acceptEdits` |
| `claudeChat.notifyWebhook` | 任务推送的 webhook（完成 + 等待输入提醒），留空关闭 | `""` |
| `claudeChat.notifyMinDurationSec` | 任务时长达到该秒数才推完成通知；等待输入提醒同用此阈值 | `60` |
| `claudeChat.pythonPath` | SLS 查询引擎初始化用的 python3 路径 | `""` |

## 工作原理

### 与 claude CLI 的对接

每个会话维护**一个长驻的 `claude` 子进程**，通过官方 [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/typescript) 的 streaming input mode 驱动——官方 VS Code 扩展亦是这种形态。

- **启动**：先用 `startup()` spawn 子进程并完成 initialize 握手，再挂上消息流（直接 `query()` 会把 spawn 推迟到第一条消息，预启动就失去意义）
- **权限**：`canUseTool` 回调 → 界面待确认区 → 用户点击后 resolve 挂起的 Promise
- **中断 / 切模型 / 切权限模式**：`Query` 对象的原生方法，进程保留不杀，中断后可继续对话
- 协议层由官方维护，CLI 升级不必追协议变化

### 会话记录

会话由 Claude Code 自身持久化在 `~/.claude/projects/<编码后的工作目录>/<session-id>.jsonl`，插件读这些文件来列出、回放、还原历史会话。回放按文件顺序读取，只跳过从主链分叉出去的被放弃分支（回退 / 编辑重发留下的旧尾巴），并过滤 CLI 注入的合成消息（`task-notification`、斜杠命令回显等），只渲染真人发的内容。

### 还原点

- **建点**：每轮发送前记录该 `.jsonl` 的行数并保存到 `globalStorage`；由官方插件 / 其它窗口发出的轮次没有快照，从对话记录合成还原点（只回退对话、不回滚文件，悬停有说明）
- **文件快照**：`tool_input` 事件里，Write / Edit / MultiEdit / NotebookEdit 按 `file_path` 快照；`Bash` 则先从命令文本抽出会被写入 / 删除的路径再快照——覆盖 `>` `>>` 重定向、`tee`、`sed -i`、`cp` / `mv` 目标、`rm` / `touch`，heredoc 正文剥掉，变量 / 通配 / 目录跳过。快照在命令执行前完成
- **回退**：先结束当前进程，取该行之前最后一条链记录，用 SDK `forkSession(upToMessageId)` 派生出只含此前对话的新会话（沿 `parentUuid` 链复制、跨压缩边界保留全部历史），当前标签页静默切到新会话、旧会话删除，还原点按提问文本重新对齐——用户看到的还是同一段对话，而官方插件与 `--resume` 立即一致。此前按行截断文件有竞态：垂死的 CLI 会在截断后再刷出记录，链一断官方插件就只剩尾巴，这就是改用官方机制的原因
- **重新生成 / 编辑重发**：同一套回退机制，重新生成不弹遮罩

## 已知限制

- **需要本机 `claude` CLI 已登录**，插件不接受 API Key
- **其它入口发出的轮次没有文件快照**：官方插件、其它窗口发出的轮次只有合成还原点，能回退对话但不能回滚文件
- **Bash 改文件的识别是启发式的**：`python -c "open(...,'w')"`、循环里的变量路径等静态解析不了的会漏，漏了只是不进「已更改文件」，不会误伤
- `acceptEdits` / `bypassPermissions` 模式下 CLI 自动应用编辑不再询问，不弹待确认区（文件仍会被快照，可还原）
- **QQ 机器人的工具请求一律自动放行**（远程无法逐条确认），白名单是唯一的安全边界；只想让它读代码可把 `qqBotPermissionMode` 设为 `plan`
- 超大会话（>10MB）受 CLI 自身限制，`--resume` 会很慢甚至卡住，请及时 `/compact`
- 行内补全（Ghost text）按需不做

## 目录结构

```
src/
  extension.ts            激活入口，注册视图与命令，日志双写
  shared.ts               扩展 <-> webview 的消息契约（无运行时依赖）
  checkpoints.ts          CheckpointManager：文件快照与还原点
  claude/
    process.ts            ClaudeProcess：官方 Agent SDK 对接（进程、事件翻译、权限）
    session.ts            SessionStore：读写 CLI 的 .jsonl 会话记录
  panel/
    chatViewProvider.ts   核心：进程池 / 会话 / 预热 / 看门狗 / 侧边栏 / QQ / SLS / 推送
  qq/
    bot.ts                QQ 开放平台机器人（WebSocket，零依赖）
  webview/
    main.ts               前端：流式 Markdown、工具卡片、待确认区、搜索、引用链接校验
media/
  main.css                使用 VS Code 主题变量的样式
  webview.js              （构建产物）前端打包，内联 markdown-it + highlight.js
release/
  claude-chat.vsix        随仓库提交的安装包，同事直接拉取安装
esbuild.js                构建脚本（扩展与前端各一个 bundle）
```

## 开发与发布

```bash
npm install
npm run watch        # 开发：监听构建
npm run build        # 生产构建
npm run check-types  # 类型检查
```

用 VS Code 打开本文件夹按 **F5** 启动 *Extension Development Host*。

发布流程（插件跑的是**已安装的副本**，只 `compile` 不装是看不到效果的）：

```bash
# 1. 在 package.json 里 bump version
npx vsce package --no-dependencies
code --install-extension claude-chat-<版本>.vsix --force
cp claude-chat-<版本>.vsix release/claude-chat.vsix   # 随仓库提交，其它窗口 3 小时内自动检测到
```

然后 Reload Window。

## License

MIT
