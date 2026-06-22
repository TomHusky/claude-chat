# Claude Chat — VS Code 插件

一个对标 GitHub Copilot Chat 的侧边栏聊天插件，**底层直接驱动你本机的 `claude` CLI**（Claude Code）。
你已有的 Claude 订阅 / 登录态会被直接复用 —— 插件不需要 API Key，所有请求都通过本地 `claude` 进程发出。

## 功能

- 🗨️ **侧边栏聊天面板**：多轮对话，流式回复，Markdown + 代码高亮渲染
- 🧠 **思考过程**：可折叠展示 Claude 的 thinking
- 🔧 **工具调用卡片**：Read / Write / Edit / Bash 等以卡片形式展示输入与结果，文件路径可点击跳转
- ✅ **改动待确认区**：默认权限模式下，每个敏感操作（写文件、跑命令）会弹出 *允许 / 拒绝 / 本会话总是允许* 按钮 —— 对应 Copilot 的 “Keep / Undo” 审批体验
- 🕘 **会话管理**：自动复用 Claude Code 的本地会话记录，可在历史会话间切换、删除
- ⏱ **还原点 (Restore Points)**：每轮对话前自动建立还原点。一键还原会**同时**：① 把工作区文件回滚到该消息之前的状态；② **真正截断对话** —— 截断会话记录并以 `--resume` 续接，Claude 会真的“忘记”该消息之后的所有轮次（已用实验验证：还原后它只记得截断点之前的内容）
- ⚙️ **权限模式切换**：default / acceptEdits / plan / bypassPermissions
- ⛔ **随时中断**：停止按钮可中断当前回合

## 运行方式（开发模式）

> 需要本机已安装并登录 `claude` CLI（`claude --version` 可用）。本插件已针对 claude-code **2.1.x** 验证。

```bash
cd claude-chat
npm install
npm run build      # 一次性构建；开发时用 npm run watch 监听
```

然后用 VS Code 打开 `claude-chat` 文件夹，按 **F5**（“运行扩展”）启动一个 *Extension Development Host* 窗口。
在新窗口左侧活动栏点击 **Claude Chat** 图标即可开始聊天。

> 想在真实环境长期使用，可以打包成 `.vsix`：
> ```bash
> npx @vscode/vsce package --no-dependencies
> code --install-extension claude-chat-0.1.0.vsix
> ```

## 配置项（设置 → 搜索 “Claude Chat”）

| 配置 | 说明 | 默认 |
| --- | --- | --- |
| `claudeChat.claudePath` | `claude` 可执行文件路径（不在 PATH 时填绝对路径） | `claude` |
| `claudeChat.model` | 模型（`opus` / `sonnet` / `fable` 或完整 id），留空用 CLI 默认 | `""` |
| `claudeChat.permissionMode` | 新会话的初始权限模式 | `default` |
| `claudeChat.effort` | 推理强度 low/medium/high/xhigh/max | `""` |
| `claudeChat.snapshotFilesForRestore` | 文件被修改前先快照，供还原点回滚 | `true` |

## 快捷键

- `Cmd/Ctrl+Shift+I`：聚焦聊天输入框
- `Cmd/Ctrl+Shift+L`：把编辑器选中代码加入聊天上下文
- 输入框中 `Enter` 发送 / `Shift+Enter` 换行

## 工作原理

插件为每个会话拉起一个常驻的 `claude` 进程：

```
claude -p --input-format stream-json --output-format stream-json \
       --verbose --include-partial-messages \
       --permission-mode <mode> --permission-prompt-tool stdio \
       [--model …] [--session-id <uuid> | --resume <id>] [--add-dir …]
```

- 通过 stdin/stdout 的 **stream-json 双向协议** 收发消息，实现流式渲染与多轮对话（同一进程内连续多轮，无需重启）。
- 启动时先发送 `initialize` 控制握手；`--permission-prompt-tool stdio` 让 CLI 把权限请求 (`can_use_tool`) 通过控制通道发回插件，插件据此渲染“待确认区”，用户点击后回 `control_response`（`allow` 时回显 `updatedInput`，`deny` 时附原因）。
- 会话记录由 Claude Code 自身持久化在 `~/.claude/projects/<编码后的工作目录>/<session-id>.jsonl`；本插件读取这些文件来列出/还原历史会话。
- **还原点的真实截断**：每轮对话发送前记录该会话 `.jsonl` 的行数；还原时先结束当前进程，把 `.jsonl` 截断回该行数，下一条消息再用 `--resume <id>` 续接 —— 由于 `.jsonl` 是顺序追加的，截断成前缀等价于把会话回退到那个时间点。还原后若该会话已无任何用户轮次，则自动变为一个全新对话。

## 已知限制 / 后续可做

- **还原点的截断粒度按“整轮”对齐**：截断边界记录于每轮发送前。若上一轮的收尾元数据尚未落盘就立刻还原（极少见），可能少留一两行无关元数据，不影响对话记忆与文件回滚。
- `acceptEdits` / `bypassPermissions` 模式下 CLI 会自动应用编辑、不再询问，因此不会弹出待确认区（但文件仍会在编辑前被快照，可还原）。
- 暂未实现历史消息“原地编辑并重发”入口；不过其底层机制（截断 + `--resume`）已经具备，等同于“还原到这条消息之前再重新发送”。
- 行内补全（Ghost text）按需不做。

## 目录结构

```
src/
  extension.ts            激活入口，注册视图与命令
  shared.ts               扩展 <-> webview 的消息契约（无运行时依赖）
  claude/
    protocol.ts           stream-json / 控制协议的类型定义
    process.ts            ClaudeProcess：spawn、流解析、权限控制通道、中断
    session.ts            SessionStore：读取 CLI 的 .jsonl 会话记录
  checkpoints.ts          CheckpointManager：文件快照与还原点
  panel/
    chatViewProvider.ts   WebviewViewProvider：进程/会话/还原点 与 webview 的桥接
  webview/
    main.ts               前端：流式 Markdown、工具卡片、待确认区、抽屉、输入框
media/
  main.css                使用 VS Code 主题变量的样式
  webview.js              （构建产物）前端打包，内联 markdown-it + highlight.js
  icon.svg                活动栏图标
```

## License

MIT
