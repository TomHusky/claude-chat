import * as vscode from "vscode";
import { ChatViewProvider } from "./panel/chatViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Claude Chat");
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
