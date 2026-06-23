# 安装 ClaudeCopilot（一键安装说明）

> 给 AI 助手的提示：用户希望安装这个 VS Code 插件。请按下面的步骤执行命令即可。
> 安装包已经随仓库提供，路径是 **`release/claude-chat.vsix`**，无需自己构建。

## 前置条件

1. 已安装 **VS Code**（或 Cursor 等兼容编辑器）。
2. 本机已安装并登录 **`claude` CLI**（Claude Code）。验证：
   ```bash
   claude --version
   ```
   插件不需要 API Key，它直接复用你本机 `claude` 的登录态。

## 一键安装（推荐）

在仓库根目录执行：

```bash
code --install-extension release/claude-chat.vsix --force
```

- 如果提示 `code: command not found`，说明 VS Code 的命令行工具没装：
  在 VS Code 里按 `Cmd/Ctrl+Shift+P` → 运行 **“Shell Command: Install 'code' command in PATH”**，然后重开终端再执行上面的命令。
- macOS 上若仍找不到 `code`，可用完整路径：
  ```bash
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension release/claude-chat.vsix --force
  ```
- Cursor 用户把 `code` 换成 `cursor` 即可。

装完后**重启编辑器窗口**（`Cmd/Ctrl+Shift+P` → “Reload Window”），左侧活动栏会出现 **ClaudeCopilot** 图标。

## 备选：用 VS Code 图形界面安装

1. `Cmd/Ctrl+Shift+P` → **“Extensions: Install from VSIX...”**
2. 选择仓库里的 `release/claude-chat.vsix`
3. 安装后 Reload Window。

## 备选：从源码自行构建安装

```bash
npm install
node esbuild.js --production
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension claude-chat-*.vsix --force
```

## 使用

- 左侧活动栏点击 **ClaudeCopilot** 管理会话；聊天面板在编辑器区/侧边栏打开。
- 首次使用确保 `claude` CLI 已登录（`claude` 命令能正常对话）。

## 卸载

```bash
code --uninstall-extension local.claude-chat
```
