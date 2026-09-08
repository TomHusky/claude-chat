# 安装 ClaudeCopilot

> 给 AI 助手的提示：用户希望安装这个 VS Code 插件，按下面的步骤执行命令即可。
> 安装包已随仓库提供，路径是 **`release/claude-chat.vsix`**，无需自己构建。

## 前置条件

1. 已安装 **VS Code**（或 Cursor 等兼容编辑器）。
2. 本机已安装并登录 **`claude` CLI**（Claude Code），建议 2.1.x 及以上。验证：
   ```bash
   claude --version
   ```
   插件不需要 API Key，它通过官方 `@anthropic-ai/claude-agent-sdk` 驱动这个本地 CLI，鉴权与计费和你在终端里敲 `claude` 完全一致。

## 一键安装（推荐）

在仓库根目录执行：

```bash
code --install-extension release/claude-chat.vsix --force
```

- 提示 `code: command not found`：VS Code 的命令行工具没装。在 VS Code 里 `Cmd/Ctrl+Shift+P` → **Shell Command: Install 'code' command in PATH**，重开终端再执行。
- macOS 仍找不到 `code` 时用完整路径（注意应用名若含空格要加引号）：
  ```bash
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension release/claude-chat.vsix --force
  ```
- Cursor 用户把 `code` 换成 `cursor`。

装完后**重载窗口**（`Cmd/Ctrl+Shift+P` → **Reload Window**），左侧活动栏出现 **ClaudeCopilot** 图标即成功。

## 备选：图形界面安装

1. `Cmd/Ctrl+Shift+P` → **Extensions: Install from VSIX...**
2. 选择仓库里的 `release/claude-chat.vsix`
3. Reload Window

## 备选：从源码构建

```bash
npm install
npm run build
npx @vscode/vsce package --no-dependencies
code --install-extension claude-chat-*.vsix --force
```

## 开始使用

- 左侧活动栏点 **ClaudeCopilot** 管理会话；聊天面板在编辑器区或侧边栏打开。
- 首次使用确保 `claude` CLI 已登录（终端里 `claude` 能正常对话）。
- 功能说明、快捷键、配置项见 [README.md](README.md)。

## 更新

插件每 3 小时自动检测仓库 `main` 分支的新版本，侧边栏亮起「发现新版本 · 点击更新」横幅，点击一键安装；也可命令面板 `Claude: 检查更新`。

## 出问题时

- 日志固定在 **`~/.claude-chat/logs/`**（按天分文件，保留 7 天）。命令面板 `Claude: 打开日志文件夹` 直接打开；反馈问题时把当天的 `.log` 发出来。
- 先确认 `claude` CLI 本身正常：终端里 `claude --version`、随便对话一句。插件的所有请求都由这个本地 CLI 发出，它不通插件必然不通。

## 卸载

```bash
code --uninstall-extension local.claude-chat
```
