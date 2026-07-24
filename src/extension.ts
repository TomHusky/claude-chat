import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChatViewProvider } from "./panel/chatViewProvider";

/** 固定日志目录：~/.claude-chat/logs/claude-chat-YYYY-MM-DD.log（按天分文件）。
 *  VS Code 输出通道的落盘路径深埋且每次会话都变，用户/同事根本找不到——
 *  所有日志双写到这里，收日志只需要拿这个目录。 */
const LOG_DIR = path.join(os.homedir(), ".claude-chat", "logs");

function logFilePath(): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(LOG_DIR, `claude-chat-${day}.log`);
}

/** 包一层 OutputChannel：appendLine 同时落盘到固定目录。写盘失败静默（日志不能反噬功能）。 */
function teeOutput(channel: vscode.OutputChannel): vscode.OutputChannel {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // 只保留最近 7 天，防止无限膨胀。
    for (const f of fs.readdirSync(LOG_DIR)) {
      try {
        const full = path.join(LOG_DIR, f);
        if (Date.now() - fs.statSync(full).mtimeMs > 7 * 24 * 3600_000) fs.unlinkSync(full);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  const writeLine = (line: string) => {
    try {
      const ts = new Date();
      const hh = `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;
      fs.appendFileSync(logFilePath(), `[${hh}] ${line}\n`, "utf8");
    } catch { /* 日志写盘失败不打扰任何功能 */ }
  };
  return {
    name: channel.name,
    append: (v) => channel.append(v),
    appendLine: (v) => {
      channel.appendLine(v);
      writeLine(v);
    },
    replace: (v) => channel.replace(v),
    clear: () => channel.clear(),
    show: ((...args: unknown[]) => (channel.show as (...a: unknown[]) => void)(...args)) as vscode.OutputChannel["show"],
    hide: () => channel.hide(),
    dispose: () => channel.dispose(),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const output = teeOutput(vscode.window.createOutputChannel("Claude Chat"));
  output.appendLine(`[boot] ClaudeCopilot v${(context.extension.packageJSON as { version?: string }).version ?? "?"} 日志目录 ${LOG_DIR}`);
  const provider = new ChatViewProvider(context, output);

  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Rehydrate the editor-area chat panel after a window reload/restart so it
    // doesn't come back as a blank, titleless tab.
    vscode.window.registerWebviewPanelSerializer("claude-chat.editor", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { sessionId?: string } | undefined): Promise<void> {
        await provider.revivePanel(panel, state?.sessionId);
      },
    }),
    vscode.commands.registerCommand("claude-chat.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("claude-chat.showSessions", () => provider.showSessions()),
    vscode.commands.registerCommand("claude-chat.stop", () => provider.stop()),
    vscode.commands.registerCommand("claude-chat.focusInput", () => provider.focusInput()),
    vscode.commands.registerCommand("claude-chat.addSelectionToChat", () => provider.addSelection()),
    vscode.commands.registerCommand("claude-chat.moveToRight", () => moveToRight()),
    vscode.commands.registerCommand("claude-chat.checkUpdate", () => provider.checkForUpdate()),
    vscode.commands.registerCommand("claude-chat.slsConfig", () => provider.showSlsConfig()),
    vscode.commands.registerCommand("claude-chat.qqConfig", () => provider.showQQConfig()),
    vscode.commands.registerCommand("claude-chat.openLogs", () => {
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
      } catch { /* ignore */ }
      void vscode.env.openExternal(vscode.Uri.file(LOG_DIR));
    }),
    vscode.commands.registerCommand("claude-chat.openInEditor", () => provider.openInEditor()),
    // The icon on FILE editors' title bar: always start a FRESH conversation
    // (openInEditor would resurrect the last session).
    vscode.commands.registerCommand("claude-chat.open", () => provider.newSession()),
  );

  // Auto-check for updates once on startup (silent — only prompts if newer).
  const updateTimer = setTimeout(() => void provider.checkForUpdate(true), 4000);
  context.subscriptions.push({ dispose: () => clearTimeout(updateTimer) });

  // First run: recommend moving the chat to the right Secondary Side Bar.
  // (A side-bar view — unlike an editor tab — lets you drag files from the
  //  explorer into the input to attach them without VS Code opening them.)
  if (!context.globalState.get("claudeChat.rightBarPrompted")) {
    void context.globalState.update("claudeChat.rightBarPrompted", true);
    void vscode.window
      .showInformationMessage(
        "把 Claude Chat 放到右侧栏吗？在右边不挡代码，并且可以从资源管理器拖文件到输入框附加（不会打开文件）。",
        "移到右侧栏",
        "暂不",
      )
      .then((choice) => {
        if (choice === "移到右侧栏") void moveToRight();
      });
  }
}

/** Focus the chat view, then open VS Code's move picker (choose “Secondary Side Bar”). */
async function moveToRight(): Promise<void> {
  try {
    await vscode.commands.executeCommand("claude-chat.chatView.focus");
    await vscode.commands.executeCommand("workbench.action.moveFocusedView");
  } catch {
    void vscode.window.showInformationMessage(
      "把左侧活动栏的 Claude Chat 图标拖到编辑器右侧，或右键它选择 “Move To → Secondary Side Bar” 即可。",
    );
  }
}

export function deactivate(): void {
  /* subscriptions handle teardown */
}
