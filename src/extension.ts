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
    // 只保留最近 7 天，防止无限膨胀。只清自己命名规则的文件——用户往这个
    // 目录放的其它东西（导出的旧日志、笔记）不能被静默删掉。
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/^claude-chat-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
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
    // 手动检查：只点亮侧边栏横幅（不直接弹安装确认），但保留结果反馈。
    // 真正的"下载并安装"确认统一由点击横幅触发，避免同时冒出两个入口。
    vscode.commands.registerCommand("claude-chat.checkUpdate", () => provider.checkForUpdate(true, false)),
    vscode.commands.registerCommand("claude-chat.slsConfig", () => provider.showSlsConfig()),
    vscode.commands.registerCommand("claude-chat.qqConfig", () => provider.showQQConfig()),
    vscode.commands.registerCommand("claude-chat.notifyConfig", () => provider.showNotifyConfig()),
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

  // Auto-check for updates: once shortly after startup, then every 3 hours —
  // a window left open for days would otherwise never see a new build (the
  // startup check was the only trigger). Silent: only speaks up if newer.
  const updateTimer = setTimeout(() => void provider.checkForUpdate(true), 4000);
  const UPDATE_POLL_MS = 3 * 60 * 60 * 1000;
  const updatePoll = setInterval(() => void provider.checkForUpdate(true), UPDATE_POLL_MS);
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(updateTimer);
      clearInterval(updatePoll);
    },
  });

}

export function deactivate(): void {
  /* subscriptions handle teardown */
}
