import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as https from "node:https";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ClaudeProcess, PermissionRequest } from "../claude/process";
import { SessionStore } from "../claude/session";
import { CheckpointManager } from "../checkpoints";
import { ChangedFile, contextWindowFor, CTX_OPEN, CTX_CLOSE, FromWebview, ICONS, ToWebview } from "../shared";

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** URI scheme that serves the pre-edit baseline content for the native diff editor. */
const ORIG_SCHEME = "claude-orig";
/** workspaceState key: id of the last active session (restored on open). */
const LAST_SESSION_KEY = "claudeChat.lastSession";

/** Everything that belongs to one chat tab: its own panel, process, transcript
 *  position, checkpoints. Each session lives in its OWN editor tab and its OWN
 *  claude process — switching/closing tabs never touches another session. */
interface SessionCtx {
  panel: vscode.WebviewPanel;
  webview: vscode.Webview;
  sessionId?: string; // undefined until the first turn creates one
  proc?: ClaudeProcess;
  starting?: Promise<ClaudeProcess | undefined>;
  checkpoints: CheckpointManager;
  pendingContext?: string;
  pendingPerm?: ToWebview; // permission raised while this tab was hidden/closed
  blank: boolean; // a fresh "new chat" tab with no session yet
  ready: boolean; // its webview finished loading
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "claude-chat.chatView";

  private view?: vscode.WebviewView;
  /** One context per open chat tab. */
  private readonly sessions = new Set<SessionCtx>();
  /** The chat tab the user most recently focused (target for global commands). */
  private activeCtx?: SessionCtx;
  private store: SessionStore;
  private updateAvailable?: string; // remote version when an update was detected (drives the red dot)
  private lastUsageAt = 0; // throttle for subscription-usage queries
  private usageInFlight = false;
  private lastUsage?: ToWebview; // most recent usage result, replayed to new tabs
  private layoutFixing = false; // guards re-entrancy while sliding a file group left
  private readonly origChanged = new vscode.EventEmitter<vscode.Uri>();
  private terminal?: vscode.Terminal;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.store = new SessionStore(this.cwd());

    // Serve baseline (pre-edit) content so the native diff editor can show
    // "original ⟷ current" for any file Claude changed — checking every open
    // session's checkpoints for the file's pre-edit content.
    const origChanged = this.origChanged;
    const sessions = this.sessions;
    this.context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, {
        onDidChange: origChanged.event,
        provideTextDocumentContent(uri: vscode.Uri): string {
          if (uri.query === "empty") return "";
          for (const s of sessions) {
            const orig = s.checkpoints.originalOf(uri.path);
            if (orig != null) return orig;
          }
          return "";
        },
      }),
      origChanged,
      vscode.window.onDidCloseTerminal((t) => {
        if (t === this.terminal) this.terminal = undefined;
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        this.postActiveFile();
        void this.keepFilesLeft(ed);
      }),
    );
  }

  /** Chat tabs whose panel was closed while their reply was still streaming.
   *  Keyed by sessionId — kept alive in the background; reopening re-adopts them. */
  private readonly detached = new Map<string, SessionCtx>();

  /** Tell the webview which file is shown (for the default chip). Never clears
   *  it just because focus moved to the chat — only updates to a real file. */
  private postActiveFile(): void {
    if (!this.activeCtx) return;
    let p: string | undefined;
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === "file") {
      p = ed.document.uri.fsPath;
    } else {
      const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input as { uri?: vscode.Uri } | undefined;
      if (input?.uri && input.uri.scheme === "file") p = input.uri.fsPath;
    }
    if (p) this.post(this.activeCtx, { kind: "active_file", path: p });
  }

  /** Build a context block from attached files/dirs (embedded content / listing). */
  private buildFileContext(paths: string[]): string {
    const MAX_FILE = 60 * 1024;
    let budget = 200 * 1024;
    const parts: string[] = [];
    for (const p of paths) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(p);
      } catch {
        continue;
      }
      const rel = vscode.workspace.asRelativePath(p);
      if (stat.isDirectory()) {
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(p).slice(0, 200);
        } catch {
          /* ignore */
        }
        parts.push(`目录 ${rel}/ 包含:\n${entries.map((e) => "  " + e).join("\n")}`);
      } else if (stat.size > 0 && budget > 0) {
        try {
          let content = fs.readFileSync(p, "utf8");
          let note = "";
          if (content.length > MAX_FILE) {
            content = content.slice(0, MAX_FILE);
            note = `\n…（已截断，完整内容请用 Read 工具读取 ${rel}）`;
          }
          budget -= content.length;
          const ext = path.extname(p).replace(".", "");
          parts.push(`文件 ${rel}:\n\`\`\`${ext}\n${content}\n\`\`\`${note}`);
        } catch {
          parts.push(`文件 ${rel}（无法读取，请用 Read 工具）`);
        }
      } else {
        parts.push(`文件 ${rel}`);
      }
    }
    if (!parts.length) return "";
    // Wrap in sentinels so reloading a session can separate this auto-embedded
    // file dump from the user's actual message (only chips are shown in history).
    return `${CTX_OPEN}\n用户附带了以下文件作为上下文：\n\n${parts.join("\n\n")}\n${CTX_CLOSE}`;
  }

  /** Send a code block to a dedicated integrated terminal and run it. */
  private runInTerminal(code: string): void {
    const text = code.replace(/\n+$/, "");
    if (!text.trim()) return;
    if (!this.terminal) {
      this.terminal = vscode.window.createTerminal({ name: "Claude Chat", cwd: this.cwd() });
    }
    this.terminal.show(true);
    this.terminal.sendText(text, true);
  }

  // -- View lifecycle ------------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    // The left sidebar is a session manager only — chat lives in the editor panel.
    view.webview.html = this.sidebarHtml(view.webview);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onSidebarMessage(m));
    this.postUpdateDot(); // restore the badge if an update was already detected
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post2(view.webview, {
          kind: "sessions",
          list: this.store.list(),
          activeId: this.activeCtx?.sessionId,
          runningIds: this.runningIds(),
        });
        this.postUpdateDot();
      }
    });
  }

  /** Post to a specific webview (used to keep the sidebar's session list in sync). */
  private post2(target: vscode.Webview | undefined, e: ToWebview): void {
    target?.postMessage(e);
  }

  /** Reflect the "update available" state: a banner atop the sidebar list AND a
   *  badge on the ClaudeCopilot activity-bar icon. */
  private postUpdateDot(): void {
    this.view?.webview.postMessage({ kind: "update_available", version: this.updateAvailable ?? "" });
    if (this.view) {
      this.view.badge = this.updateAvailable
        ? { value: 1, tooltip: `发现新版本 v${this.updateAvailable}` }
        : undefined;
    }
  }

  /** Broadcast the session list to the sidebar manager and EVERY chat panel,
   *  and set each panel's tab title to its own session's title. */
  private refreshSessions(): void {
    const list = this.store.list();
    const e: ToWebview = {
      kind: "sessions",
      list,
      activeId: this.activeCtx?.sessionId,
      runningIds: this.runningIds(),
    };
    this.view?.webview.postMessage(e);
    for (const ctx of this.sessions) {
      ctx.panel.webview.postMessage(e);
      this.setPanelTitle(ctx);
    }
  }

  /** Show a session's conversation title on its own editor tab (falls back to brand). */
  private setPanelTitle(ctx: SessionCtx): void {
    const title = ctx.sessionId
      ? this.store.list().find((s) => s.id === ctx.sessionId)?.title
      : undefined;
    ctx.panel.title = title?.trim() || "ClaudeCopilot";
  }

  /**
   * Open a chat session in its OWN editor tab with its OWN claude process.
   * If `sessionId` is given and already open, reveal that tab. If it's detached
   * (closed mid-reply, still running), re-adopt it. Otherwise create a fresh tab.
   */
  async openSession(sessionId?: string): Promise<void> {
    // Already open in a live tab — just reveal it.
    if (sessionId) {
      for (const ctx of this.sessions) {
        if (ctx.sessionId === sessionId) {
          ctx.panel.reveal(ctx.panel.viewColumn, false);
          this.activeCtx = ctx;
          await this.lockChatGroup(ctx.panel);
          return;
        }
      }
      // Detached but still running in the background — re-adopt with its process.
      const det = this.detached.get(sessionId);
      if (det) {
        this.detached.delete(sessionId);
        await this.reopenDetached(det);
        return;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      "claude-chat.editor",
      "ClaudeCopilot",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      },
    );
    const ctx: SessionCtx = {
      panel,
      webview: panel.webview,
      sessionId,
      checkpoints: new CheckpointManager(this.storageDir()),
      blank: !sessionId,
      ready: false,
    };
    if (sessionId) ctx.checkpoints.setSession(sessionId);
    this.adoptPanel(ctx);
    this.sessions.add(ctx);
    this.activeCtx = ctx;
    // Lock the chat's editor group so files opened from the explorer go to another
    // group instead of replacing the chat tab (lets you view files + chat together).
    await this.lockChatGroup(panel);
  }

  /** Re-adopt a session detached while streaming: fresh panel, reuse its proc. */
  private async reopenDetached(det: SessionCtx): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      "claude-chat.editor",
      "ClaudeCopilot",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      },
    );
    det.panel = panel;
    det.webview = panel.webview;
    det.ready = false;
    det.blank = false;
    this.adoptPanel(det);
    this.sessions.add(det);
    this.activeCtx = det;
    await this.lockChatGroup(panel);
    // History + busy state are restored when its webview fires `ready`.
  }

  /** Wire a freshly-created OR a restored (deserialized) editor panel into a ctx:
   *  set its HTML/icon, route its messages, and handle its disposal. */
  private adoptPanel(ctx: SessionCtx): void {
    const panel = ctx.panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    panel.title = "ClaudeCopilot";
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg");
    panel.webview.html = this.html(panel.webview);
    ctx.webview = panel.webview;
    panel.webview.onDidReceiveMessage((m: FromWebview) => {
      this.activeCtx = ctx;
      this.onPanelMessage(ctx, m);
    });
    panel.onDidDispose(() => this.onPanelClosed(ctx));
  }

  /** A chat tab was closed. If its reply is still streaming, keep the process
   *  running in the background and stash the ctx so reopening re-attaches it;
   *  otherwise dispose the process. */
  private onPanelClosed(ctx: SessionCtx): void {
    this.sessions.delete(ctx);
    if (this.activeCtx === ctx) this.activeCtx = undefined;
    if (ctx.proc?.isBusy && ctx.sessionId) {
      // 后台继续跑,重开再接管 — keep it alive, suppress its (now-dead) UI posts.
      this.detached.set(ctx.sessionId, ctx);
    } else {
      ctx.proc?.dispose();
      ctx.proc = undefined;
      ctx.starting = undefined;
    }
    this.broadcastRunning();
    this.refreshSessions();
  }

  /** Re-adopt a panel restored by VS Code after a window reload/restart. Without
   *  this, the serialized tab comes back blank (no title, no content). It loads
   *  the last session (or blank) when its webview fires `ready`. */
  async revivePanel(panel: vscode.WebviewPanel): Promise<void> {
    const ctx: SessionCtx = {
      panel,
      webview: panel.webview,
      checkpoints: new CheckpointManager(this.storageDir()),
      blank: false, // restore last session on ready
      ready: false,
    };
    this.adoptPanel(ctx);
    this.sessions.add(ctx);
    this.activeCtx = ctx;
    await this.lockChatGroup(panel);
  }

  /** Keep the layout "files on the left, chat on the right": whenever a file
   *  editor ends up to the right of (or alongside) the chat, slide its group to
   *  the far left. Focus stays on the file. */
  private async keepFilesLeft(ed?: vscode.TextEditor): Promise<void> {
    if (this.layoutFixing || !ed || ed.viewColumn === undefined) return;
    if (!this.sessions.size) return;
    if (ed.document.uri.scheme === ORIG_SCHEME) return; // our diff baselines
    const chatCol = (): number | undefined => {
      let m: number | undefined;
      for (const ctx of this.sessions) {
        const c = ctx.panel.viewColumn;
        if (c && (m === undefined || c < m)) m = c;
      }
      return m;
    };
    const cc = chatCol();
    if (cc === undefined || ed.viewColumn < cc) return; // already left of the chat
    this.layoutFixing = true;
    try {
      for (let i = 0; i < 8; i++) {
        const a = vscode.window.activeTextEditor;
        const col = a?.viewColumn;
        if (!a || col === undefined || col === vscode.ViewColumn.One) break;
        const ck = chatCol();
        if (ck !== undefined && col < ck) break; // now left of the chat
        await vscode.commands.executeCommand("workbench.action.moveActiveEditorGroupLeft");
        if (vscode.window.activeTextEditor?.viewColumn === col) break; // no movement
      }
    } catch {
      /* best effort */
    } finally {
      this.layoutFixing = false;
    }
  }

  /** Lock a chat panel's editor group so explorer files open in another group
   *  instead of replacing the chat tab. */
  private async lockChatGroup(panel: vscode.WebviewPanel): Promise<void> {
    try {
      // Bring the chat panel forward so ITS group becomes the active group.
      panel.reveal(panel.viewColumn, false);
      // reveal()'s group activation is applied asynchronously — wait a tick so we
      // don't lock whatever group happened to be active (e.g. a file group) and
      // leave the chat group unlocked (which lets files replace the chat tab).
      await new Promise((r) => setTimeout(r, 60));
      await vscode.commands.executeCommand("workbench.action.lockEditorGroup");
    } catch {
      /* lock command may be unavailable on older VS Code */
    }
  }

  // -- Commands (from package.json) ----------------------------------------

  async newSession(): Promise<void> {
    await this.openSession(undefined);
  }

  /** Open the chat panel (compat command). Opens the last session, or a new one. */
  async openInEditor(): Promise<void> {
    const last = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
    await this.openSession(last && this.store.findFile(last) ? last : undefined);
  }

  async showSessions(): Promise<void> {
    this.refreshSessions();
    this.reveal();
  }

  async stop(): Promise<void> {
    await this.activeCtx?.proc?.interrupt();
  }

  focusInput(): void {
    this.reveal();
    if (this.activeCtx) this.post(this.activeCtx, { kind: "notice", message: "" }); // webview focuses input on reveal
  }

  addSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showInformationMessage("没有选中的代码。");
      return;
    }
    const ctx = this.activeCtx;
    if (!ctx) {
      vscode.window.showInformationMessage("请先打开一个会话。");
      return;
    }
    const sel = editor.document.getText(editor.selection);
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const lang = editor.document.languageId;
    const start = editor.selection.start.line + 1;
    const end = editor.selection.end.line + 1;
    const label = `${rel}:${start}-${end}`;
    const text = `选中代码 \`${label}\`:\n\`\`\`${lang}\n${sel}\n\`\`\``;
    ctx.pendingContext = text;
    this.reveal();
    this.post(ctx, { kind: "context_added", label, text });
  }

  // -- Message handling ----------------------------------------------------

  /** Messages from the left sidebar (session manager only). */
  private async onSidebarMessage(m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case "ready":
        case "listSessions":
          this.refreshSessions();
          this.postUpdateDot();
          this.fetchUsage();
          break;
        case "checkUpdate":
          await this.checkForUpdate();
          break;
        case "refreshUsage":
          this.fetchUsage(true);
          break;
        case "switchSession":
        case "openSession":
          await this.openSession(m.sessionId);
          break;
        case "newInEditor":
        case "newSession":
          await this.openSession(undefined);
          break;
        case "deleteSession":
          await this.deleteSessions([m.sessionId]);
          break;
        case "deleteSessions":
          await this.deleteSessions(m.sessionIds);
          break;
        case "renameSession":
          this.renameSession(m.sessionId, m.title);
          break;
      }
    } catch (err) {
      this.output.appendLine(`[onSidebarMessage:${m.type}] ${String(err)}`);
    }
  }

  /** Messages from a chat panel — every message is scoped to that panel's ctx. */
  private async onPanelMessage(ctx: SessionCtx, m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case "ready":
          ctx.ready = true;
          this.post(ctx, {
            kind: "config",
            permissionMode: this.config().get<string>("permissionMode", "default"),
            model: this.config().get<string>("model", ""),
            effort: this.config().get<string>("effort", ""),
          });
          this.loadCtxSession(ctx);
          this.postActiveFile();
          if (this.lastUsage) this.post(ctx, this.lastUsage); // show cached usage immediately
          this.fetchUsage();
          break;
        case "checkUpdate":
          await this.checkForUpdate();
          break;
        case "refreshUsage":
          this.fetchUsage(true);
          break;
        case "send":
          await this.handleSend(ctx, m.text, m.context, m.images, m.files);
          break;
        case "editMessage":
          await this.editMessage(ctx, m.checkpointId, m.text);
          break;
        case "interrupt":
          ctx.pendingPerm = undefined;
          await ctx.proc?.interrupt();
          break;
        case "permission":
          ctx.pendingPerm = undefined;
          this.handlePermission(ctx, m.requestId, m.behavior, m.suggestionId);
          break;
        case "answerQuestion":
          ctx.pendingPerm = undefined;
          ctx.proc?.answerQuestion(m.requestId, m.answers);
          break;
        case "newSession":
          await this.openSession(undefined);
          break;
        case "listSessions":
          this.refreshSessions();
          this.postUpdateDot();
          break;
        case "listCheckpoints":
          this.post(ctx, { kind: "checkpoints", list: ctx.checkpoints.list() });
          break;
        case "restoreCheckpoint":
          await this.restoreCheckpoint(ctx, m.checkpointId);
          break;
        case "setPermissionMode":
          await this.setPermissionMode(ctx, m.mode);
          break;
        case "setModel":
          await this.setModel(ctx, m.model);
          break;
        case "setEffort":
          await this.setEffort(ctx, m.effort);
          break;
        case "addContext":
          this.addSelection();
          break;
        case "pickFiles": {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: true,
            openLabel: "附加到会话",
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
          });
          if (picked?.length) this.post(ctx, { kind: "attach_files", paths: picked.map((u) => u.fsPath) });
          break;
        }
        case "openDiff":
          await this.openDiff(ctx, m.path);
          break;
        case "acceptFile":
          ctx.checkpoints.accept(m.path);
          this.refreshChangedFiles(ctx);
          break;
        case "revertFile":
          this.revertFile(ctx, m.path);
          this.refreshChangedFiles(ctx);
          break;
        case "acceptAll":
          for (const f of this.getChangedFiles(ctx).files) ctx.checkpoints.accept(f.path);
          this.refreshChangedFiles(ctx);
          break;
        case "revertAll": {
          const files = this.getChangedFiles(ctx).files;
          if (files.length) {
            const ok = await vscode.window.showWarningMessage(
              `回滚全部 ${files.length} 个文件的改动？`,
              { modal: true, detail: "将把这些文件恢复到 Claude 改动前的状态，此操作不可撤销。" },
              "回滚全部",
            );
            if (ok === "回滚全部") {
              for (const f of files) this.revertFile(ctx, f.path);
              this.refreshChangedFiles(ctx);
            }
          }
          break;
        }
        case "runInTerminal":
          this.runInTerminal(m.code);
          break;
        case "openFile":
          await this.openFile(ctx, m.path, m.line, m.endLine);
          break;
        case "openSymbol":
          await this.openSymbol(ctx, m.name);
          break;
        case "validateRefs": {
          const invalid = m.refs.filter((r) => !this.fileRefExists(r.path)).map((r) => r.id);
          if (invalid.length) this.post(ctx, { kind: "refs_validated", invalid });
          break;
        }
        case "copy":
          await vscode.env.clipboard.writeText(m.text);
          break;
      }
    } catch (err) {
      this.output.appendLine(`[onPanelMessage:${m.type}] ${String(err)}`);
      this.post(ctx, { kind: "error", message: String((err as Error)?.message ?? err) });
    }
  }

  /** On a chat panel's webview load, render its session (or last/blank). */
  private loadCtxSession(ctx: SessionCtx): void {
    if (ctx.sessionId) {
      this.loadSessionInto(ctx, ctx.sessionId);
      return;
    }
    if (ctx.blank) {
      this.post(ctx, { kind: "load_history", items: [], title: "新对话", checkpoints: [] });
      this.refreshChangedFiles(ctx);
      return;
    }
    // Revived panel — restore the last session used, or fall back to blank.
    const sid = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
    if (sid && this.store.findFile(sid)) {
      ctx.sessionId = sid;
      ctx.checkpoints.setSession(sid);
      this.loadSessionInto(ctx, sid);
    } else {
      this.post(ctx, { kind: "load_history", items: [], title: "新对话", checkpoints: [] });
      this.refreshChangedFiles(ctx);
    }
  }

  /** Push a session's full transcript/checkpoints/busy state into a chat panel. */
  private loadSessionInto(ctx: SessionCtx, sid: string): void {
    const items = this.store.load(sid);
    const title = this.store.list().find((s) => s.id === sid)?.title;
    this.post(ctx, { kind: "load_history", items, sessionId: sid, title, checkpoints: ctx.checkpoints.list() });
    this.postSessionContext(ctx, sid);
    if (ctx.proc?.isBusy) {
      this.post(ctx, { kind: "busy", busy: true });
      // Replay an unanswered prompt; keep it stashed in case the tab closes again
      // before it's answered. It's cleared only when the user actually responds.
      if (ctx.pendingPerm) this.post(ctx, ctx.pendingPerm);
    }
    this.refreshSessions();
    this.refreshChangedFiles(ctx);
  }

  private async handleSend(
    ctx: SessionCtx,
    text: string,
    context?: string,
    images?: { mediaType: string; data: string }[],
    files?: string[],
  ): Promise<void> {
    let attached = context ?? ctx.pendingContext;
    ctx.pendingContext = undefined;
    if (files && files.length) {
      const fileCtx = this.buildFileContext(files);
      attached = attached ? `${fileCtx}\n\n${attached}` : fileCtx;
    }
    const proc = await this.ensureProcess(ctx);
    if (!proc) return;
    // Record the transcript length *before* this turn so a restore point can
    // truncate the conversation back to exactly here.
    const lineBefore = ctx.sessionId ? this.store.countLines(ctx.sessionId) : 0;
    const checkpointId = ctx.checkpoints.beginTurn(text || "(图片)", lineBefore);
    proc.sendUserMessage(text, attached, images);
    this.post(ctx, { kind: "checkpoint_marker", checkpointId, userText: text });
  }

  /**
   * Edit a past user message: rewind the conversation to before that message
   * (revert files + truncate transcript), then resend the new text as the turn.
   * The webview has already trimmed its own view, so we don't reload history.
   */
  private async editMessage(ctx: SessionCtx, checkpointId: string, text: string): Promise<void> {
    if (checkpointId) {
      const res = ctx.checkpoints.restore(checkpointId);
      if (res) {
        ctx.proc?.dispose();
        ctx.proc = undefined;
        ctx.starting = undefined;
        let remaining = 0;
        if (ctx.sessionId) {
          remaining = this.store.truncateToLines(ctx.sessionId, res.truncateLine);
        }
        if (remaining === 0) {
          ctx.sessionId = undefined;
          ctx.checkpoints.clear();
        }
        this.refreshChangedFiles(ctx);
      }
    }
    await this.handleSend(ctx, text);
  }

  private handlePermission(ctx: SessionCtx, requestId: string, behavior: "allow" | "deny", suggestionId?: string): void {
    if (!ctx.proc) return;
    if (behavior === "allow" && suggestionId?.startsWith("setMode:")) {
      const mode = suggestionId.split(":")[1];
      if (mode) void ctx.proc.setPermissionMode(mode);
    }
    ctx.proc.respondPermission(requestId, { behavior });
  }

  private async setPermissionMode(ctx: SessionCtx, mode: string): Promise<void> {
    await this.config().update("permissionMode", mode, vscode.ConfigurationTarget.Global);
    await ctx.proc?.setPermissionMode(mode);
    // No chat notice — the picker label already reflects the change.
  }

  private async setModel(ctx: SessionCtx, model: string): Promise<void> {
    await this.config().update("model", model, vscode.ConfigurationTarget.Global);
    // Model is a spawn argument; restart the process so it applies. Context is
    // preserved because the next send resumes the same session id.
    if (ctx.proc) {
      ctx.proc.dispose();
      ctx.proc = undefined;
      ctx.starting = undefined;
    }
    // No chat notice — the picker label already reflects the change.
  }

  private async setEffort(ctx: SessionCtx, effort: string): Promise<void> {
    await this.config().update("effort", effort, vscode.ConfigurationTarget.Global);
    // Effort is also a spawn argument — restart so it applies on the next message.
    if (ctx.proc) {
      ctx.proc.dispose();
      ctx.proc = undefined;
      ctx.starting = undefined;
    }
  }

  // -- Changed files & native diff ----------------------------------------

  /** Which editor column to open code/diffs in — always opposite the chat panel
   *  so it doesn't cover the conversation (code on one side, chat on the other). */
  private codeColumn(ctx: SessionCtx): vscode.ViewColumn {
    return ctx.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  }

  private async openDiff(ctx: SessionCtx, absPath: string): Promise<void> {
    const original = ctx.checkpoints.originalOf(absPath);
    const rel = vscode.workspace.asRelativePath(absPath);
    const left = vscode.Uri.from({ scheme: ORIG_SCHEME, path: absPath });
    const exists = fs.existsSync(absPath);
    const right = exists
      ? vscode.Uri.file(absPath)
      : vscode.Uri.from({ scheme: ORIG_SCHEME, path: absPath, query: "empty" });
    const tag = original == null ? "新增" : exists ? "改动" : "删除";
    await vscode.commands.executeCommand("vscode.diff", left, right, `${rel} (Claude ${tag})`, {
      preview: true,
      viewColumn: this.codeColumn(ctx),
    });
    // Jump to the first changed line (the modified side is the active editor).
    if (exists && typeof original === "string") {
      try {
        const current = fs.readFileSync(absPath, "utf8");
        const line = firstChangedLine(original, current);
        const ed = vscode.window.activeTextEditor;
        if (ed && line >= 0) {
          const pos = new vscode.Position(line, 0);
          ed.selection = new vscode.Selection(pos, pos);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      } catch {
        /* best effort */
      }
    }
  }

  /** Revert a file to its pre-edit baseline, then drop it from the change list. */
  private revertFile(ctx: SessionCtx, absPath: string): void {
    const base = ctx.checkpoints.originalOf(absPath);
    try {
      if (base === null) {
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath); // created by Claude -> remove
      } else if (base !== undefined) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, base, "utf8");
      }
    } catch (err) {
      this.output.appendLine(`[revertFile] ${absPath}: ${String(err)}`);
    }
    ctx.checkpoints.accept(absPath); // stop tracking it (now matches baseline)
    this.origChanged.fire(vscode.Uri.from({ scheme: ORIG_SCHEME, path: absPath }));
  }

  private refreshChangedFiles(ctx: SessionCtx): void {
    const { files, totalAdded, totalRemoved } = this.getChangedFiles(ctx);
    for (const f of files) this.origChanged.fire(vscode.Uri.from({ scheme: ORIG_SCHEME, path: f.path }));
    this.post(ctx, { kind: "changed_files", files, totalAdded, totalRemoved });
  }

  private getChangedFiles(ctx: SessionCtx): { files: ChangedFile[]; totalAdded: number; totalRemoved: number } {
    const files: ChangedFile[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const p of ctx.checkpoints.changedPaths()) {
      const original = ctx.checkpoints.originalOf(p); // string | null | undefined
      if (original === undefined) continue;
      const exists = fs.existsSync(p);
      let current = "";
      if (exists) {
        try {
          current = fs.readFileSync(p, "utf8");
        } catch {
          continue;
        }
      }
      const status: ChangedFile["status"] = original === null ? "added" : exists ? "modified" : "deleted";
      const { added, removed } = diffCounts(original ?? "", current);
      if (added === 0 && removed === 0) continue; // no net change
      files.push({ path: p, rel: vscode.workspace.asRelativePath(p), added, removed, status });
      totalAdded += added;
      totalRemoved += removed;
    }
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    return { files, totalAdded, totalRemoved };
  }

  private async restoreCheckpoint(ctx: SessionCtx, checkpointId: string): Promise<void> {
    const preview = ctx.checkpoints.preview(checkpointId);
    const confirm = await vscode.window.showWarningMessage(
      "还原到这条消息之前？",
      {
        modal: true,
        detail:
          (preview ? `消息：${preview.userText}\n\n` : "") +
          "将回滚此后的文件改动，并截断对话 —— Claude 会忘记这条消息及之后的所有轮次。此操作不可撤销。",
      },
      "还原",
    );
    if (confirm !== "还原") return;

    const result = ctx.checkpoints.restore(checkpointId);
    if (!result) {
      this.post(ctx, { kind: "error", message: "找不到该还原点。" });
      return;
    }

    // 1) Stop the live process so it isn't writing to the transcript.
    ctx.proc?.dispose();
    ctx.proc = undefined;
    ctx.starting = undefined;

    // 2) Truly rewind the conversation: truncate the transcript so a future
    //    --resume makes Claude forget everything after this point.
    let remainingTurns = 0;
    if (ctx.sessionId) {
      remainingTurns = this.store.truncateToLines(ctx.sessionId, result.truncateLine);
    }

    // 3) If nothing remains, this becomes a brand-new conversation.
    if (remainingTurns === 0) {
      ctx.sessionId = undefined;
      ctx.checkpoints.clear();
      this.post(ctx, { kind: "load_history", items: [], title: "新对话", checkpoints: [] });
    } else {
      const items = this.store.load(ctx.sessionId!);
      this.post(ctx, { kind: "load_history", items, sessionId: ctx.sessionId, checkpoints: ctx.checkpoints.list() });
    }

    this.post(ctx, {
      kind: "notice",
      message: `已还原 ${result.restoredFiles} 个文件，并把对话回退到这条消息之前。下一条消息将从这里继续。`,
    });
    this.refreshChangedFiles(ctx);
  }

  // -- Process management --------------------------------------------------

  private ensureProcess(ctx: SessionCtx): Promise<ClaudeProcess | undefined> {
    if (ctx.proc) return Promise.resolve(ctx.proc);
    if (ctx.starting) return ctx.starting;
    ctx.starting = this.spawnProcess(ctx).finally(() => {
      ctx.starting = undefined;
    });
    return ctx.starting;
  }

  private async spawnProcess(ctx: SessionCtx): Promise<ClaudeProcess | undefined> {
    const isResume = !!ctx.sessionId;
    const sessionId = ctx.sessionId ?? randomUUID();
    if (!isResume) {
      ctx.sessionId = sessionId;
      ctx.checkpoints.setSession(sessionId);
    }
    const proc = new ClaudeProcess(
      {
        claudePath: this.config().get<string>("claudePath", "claude"),
        cwd: this.cwd(),
        model: this.config().get<string>("model", "") || undefined,
        effort: this.config().get<string>("effort", "") || undefined,
        permissionMode: this.config().get<string>("permissionMode", "default"),
        resumeSessionId: isResume ? sessionId : undefined,
        sessionId: isResume ? undefined : sessionId,
        addDirs: this.workspaceDirs(),
        appendSystemPrompt: this.config().get<string>("appendSystemPrompt", "") || undefined,
      },
      {
        emit: (e) => this.handleEmit(ctx, e),
        onPermission: (req) => this.onPermission(ctx, req),
        onSessionId: (id, resumed) => this.onSessionId(ctx, id, resumed),
        onClose: (code) => this.onProcessClose(ctx, code, proc),
      },
    );
    ctx.proc = proc;
    try {
      await proc.start();
    } catch (err) {
      this.post(ctx, { kind: "error", message: `初始化 claude 失败: ${String(err)}` });
      ctx.proc = undefined;
      return undefined;
    }
    return proc;
  }

  /** Is this ctx still attached to a live, displayable panel? */
  private alive(ctx: SessionCtx): boolean {
    return this.sessions.has(ctx);
  }

  /** Snapshot file edits for restore points as soon as Claude proposes them. */
  private handleEmit(ctx: SessionCtx, e: ToWebview): void {
    if (e.kind === "tool_input" && FILE_TOOLS.has(e.name)) {
      if (this.config().get<boolean>("snapshotFilesForRestore", true)) {
        const p = (e.input.file_path ?? e.input.notebook_path) as string | undefined;
        if (p && path.isAbsolute(p)) ctx.checkpoints.snapshotFile(p);
      }
    }
    // post() safely no-ops if this ctx's panel was closed (detached/background).
    this.post(ctx, e);
    // Track streaming state to drive the "active" green dot in the session list.
    if (e.kind === "busy") this.broadcastRunning();
    // Refresh the changed-files panel when a turn finishes or a file result lands.
    if (e.kind === "result" || (e.kind === "tool_result" && !e.isError)) {
      this.refreshChangedFiles(ctx);
    }
    // After a turn, a new session's title becomes available — sync list + tab title.
    if (e.kind === "result") {
      this.refreshSessions();
      this.fetchUsage(); // throttled — subscription usage moved after this turn
    }
  }

  /** All sessions (live tabs AND detached/background runs) currently streaming.
   *  Drives the live green "active" dots in the list. */
  private runningIds(): string[] {
    const ids: string[] = [];
    for (const ctx of this.sessions) if (ctx.proc?.isBusy && ctx.sessionId) ids.push(ctx.sessionId);
    for (const ctx of this.detached.values()) if (ctx.proc?.isBusy && ctx.sessionId) ids.push(ctx.sessionId);
    return ids;
  }

  /** Tell every webview which sessions are currently streaming, so the list can
   *  show live "active" dots — even after a chat tab is closed or switched. */
  private broadcastRunning(): void {
    const e: ToWebview = { kind: "running", sessionIds: this.runningIds() };
    this.view?.webview.postMessage(e);
    for (const ctx of this.sessions) ctx.panel.webview.postMessage(e);
  }

  /**
   * Query the Claude subscription usage (5h session + weekly quota) by running
   * the CLI's `/usage` slash command headlessly and parsing its text output.
   * Throttled so it doesn't itself burn quota on every turn. Posts a `usage`
   * message to the webview (which shows it where the per-turn cost used to be).
   */
  private fetchUsage(force = false): void {
    if (this.usageInFlight) return;
    const now = Date.now();
    if (!force && now - this.lastUsageAt < 90_000) return; // at most ~once / 90s
    this.usageInFlight = true;
    this.lastUsageAt = now;

    let out = "";
    let settled = false;
    const finish = (raw: string) => {
      if (settled) return;
      settled = true;
      this.usageInFlight = false;
      // Parse the JSONL: the `result` event carries the /usage text; a
      // `rate_limit_event` carries the exact five-hour reset timestamp.
      let resultText = "";
      let sessionResetAt: number | undefined;
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let o: any;
        try { o = JSON.parse(t); } catch { continue; }
        if (o.type === "result" && typeof o.result === "string") resultText = o.result;
        if (o.type === "rate_limit_event") {
          const info = o.rate_limit_info || {};
          if (info.rateLimitType === "five_hour" && typeof info.resetsAt === "number") sessionResetAt = info.resetsAt;
        }
      }
      const parsed = parseUsage(resultText);
      if (parsed) {
        // Remember it so newly-opened tabs can show it immediately, and push it
        // to every open chat tab (not just the focused one).
        this.lastUsage = { kind: "usage", ...parsed, sessionResetAt };
        for (const ctx of this.sessions) this.post(ctx, this.lastUsage);
      }
    };

    try {
      const proc = spawn(
        this.config().get<string>("claudePath", "claude"),
        ["-p", "--no-session-persistence", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        { cwd: this.cwd(), env: process.env, stdio: ["pipe", "pipe", "ignore"] },
      );
      const kill = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        finish(out);
      }, 30_000);
      proc.on("error", () => { clearTimeout(kill); finish(""); });
      proc.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        // Collect the assistant text as it arrives; the `result` event repeats it.
      });
      proc.on("close", () => { clearTimeout(kill); finish(out); });
      proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "/usage" }] } }) + "\n");
      proc.stdin.end();
    } catch {
      finish("");
    }
  }

  private onPermission(ctx: SessionCtx, req: PermissionRequest): void {
    const msg: ToWebview = {
      kind: "permission_request",
      requestId: req.requestId,
      toolUseId: req.toolUseId,
      toolName: req.toolName,
      displayName: req.displayName,
      input: req.input,
      description: req.description,
      suggestions: req.suggestions,
    };
    // Always remember the latest unanswered prompt so a closed/reopened tab can
    // replay it (the process keeps waiting in the meantime). Cleared on answer.
    ctx.pendingPerm = msg;
    if (this.alive(ctx)) this.post(ctx, msg);
  }

  private onSessionId(ctx: SessionCtx, id: string, resumed: boolean): void {
    const isNew = ctx.sessionId !== id;
    ctx.blank = false;
    ctx.sessionId = id;
    ctx.checkpoints.setSession(id);
    void this.context.workspaceState.update(LAST_SESSION_KEY, id);
    if (!resumed || isNew) {
      // Newly created — refresh the session list lazily.
      this.refreshSessions();
    }
  }

  private onProcessClose(ctx: SessionCtx, code: number | null, proc: ClaudeProcess): void {
    this.output.appendLine(`[claude] process closed (code ${code})`);
    if (ctx.proc !== proc) return; // stale process, already replaced
    ctx.proc = undefined; // next send respawns with --resume to keep context
    // A detached (background) session's process exited: drop it.
    if (!this.alive(ctx) && ctx.sessionId) {
      this.detached.delete(ctx.sessionId);
    } else {
      this.post(ctx, { kind: "busy", busy: false });
    }
    this.broadcastRunning();
  }

  private async deleteSessions(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const detail =
      ids.length === 1
        ? `会话「${this.store.list().find((s) => s.id === ids[0])?.title ?? ids[0]}」将被永久删除。`
        : `选中的 ${ids.length} 个会话将被永久删除。`;
    const ok = await vscode.window.showWarningMessage("删除会话？此操作不可撤销。", { modal: true, detail }, "删除");
    if (ok !== "删除") return;
    for (const id of ids) {
      // Tear down any open tab for this session.
      for (const ctx of [...this.sessions]) {
        if (ctx.sessionId === id) {
          this.sessions.delete(ctx);
          if (this.activeCtx === ctx) this.activeCtx = undefined;
          ctx.proc?.dispose();
          ctx.proc = undefined;
          ctx.panel.dispose();
        }
      }
      // Tear down any background (detached) run for this session.
      const det = this.detached.get(id);
      if (det) {
        det.proc?.dispose();
        this.detached.delete(id);
      }
      this.store.delete(id);
    }
    this.broadcastRunning();
    this.refreshSessions();
  }

  /** Set (or clear, when blank) a user-defined title. Persisted as a
   *  `custom-title` entry in the transcript — the same mechanism the official
   *  Claude UI uses, so renames stay in sync both ways. */
  private renameSession(sessionId: string, title: string): void {
    const clean = (title || "").trim().slice(0, 80);
    if (!this.store.setCustomTitle(sessionId, clean)) {
      vscode.window.showWarningMessage("重命名失败：找不到该会话的记录文件。");
      return;
    }
    this.refreshSessions();
  }

  /** Post the context-usage gauge value for a loaded session (from its transcript). */
  private postSessionContext(ctx: SessionCtx, sid: string): void {
    const u = this.store.lastContextUsage(sid);
    if (u && u.used > 0) this.post(ctx, { kind: "context", used: u.used, total: contextWindowFor(u.model, u.used) });
  }

  // -- Update check --------------------------------------------------------

  // GitHub API (not the raw CDN) so version/vsix reflect the latest commit
  // immediately — raw.githubusercontent.com is CDN-cached for minutes.
  private static readonly REPO_API = "https://api.github.com/repos/TomHusky/claude-chat/contents";

  /** Check GitHub for a newer packaged build; if found, download + install it.
   *  In `silent` mode (auto-check on startup) it stays quiet unless a newer
   *  version exists — no "already latest" / error popups. */
  async checkForUpdate(silent = false): Promise<void> {
    const local = (this.context.extension.packageJSON.version as string) || "0.0.0";
    let remote = "";
    try {
      const pkg = await this.fetchRepoFile("package.json");
      remote = JSON.parse(pkg.toString("utf8")).version || "";
    } catch (err) {
      if (!silent) vscode.window.showErrorMessage(`检查更新失败：${String((err as Error)?.message ?? err)}`);
      return;
    }
    if (!remote) {
      if (!silent) vscode.window.showErrorMessage("检查更新失败：无法读取远程版本号");
      return;
    }
    if (cmpVersion(remote, local) <= 0) {
      if (!silent) vscode.window.showInformationMessage(`已是最新版本 v${local}`);
      return;
    }
    // Newer version available.
    this.updateAvailable = remote; // remembered so the dot re-appears when the sidebar opens
    if (silent) {
      this.postUpdateDot(); // auto-check: show banner + activity-bar badge, no popup
      return;
    }
    const pick = await vscode.window.showInformationMessage(
      `发现新版本 v${remote}（当前 v${local}）`,
      "下载并安装",
      "取消",
    );
    if (pick !== "下载并安装") return;
    try {
      const dest = path.join(os.tmpdir(), `claude-chat-${remote}.vsix`);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在下载并安装 v${remote}…` },
        async () => {
          const vsix = await this.fetchRepoFile("release/claude-chat.vsix");
          fs.writeFileSync(dest, vsix);
          await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(dest));
        },
      );
    } catch (err) {
      vscode.window.showErrorMessage(`更新失败：${String((err as Error)?.message ?? err)}`);
      return;
    }
    this.updateAvailable = undefined; // installed — clear the pending-update flag
    this.postUpdateDot();
    const reload = await vscode.window.showInformationMessage(`已更新到 v${remote}，重新加载窗口后生效。`, "重新加载");
    if (reload === "重新加载") void vscode.commands.executeCommand("workbench.action.reloadWindow");
  }

  /** Fetch a repo file via the GitHub contents API and return its raw bytes.
   *  Uses the API (not raw CDN) so it always reflects the latest commit. */
  private async fetchRepoFile(repoPath: string): Promise<Buffer> {
    const url = `${ChatViewProvider.REPO_API}/${repoPath}?ref=main`;
    const json = await this.httpGetText(url);
    const obj = JSON.parse(json) as { content?: string; encoding?: string };
    if (!obj.content) throw new Error("响应缺少内容");
    return Buffer.from(obj.content, (obj.encoding as BufferEncoding) || "base64");
  }

  /** GET a text resource over HTTPS (follows redirects). */
  private httpGetText(url: string, depth = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      if (depth > 5) return reject(new Error("重定向次数过多"));
      const headers = { "User-Agent": "claude-chat", Accept: "application/vnd.github+json" };
      const req = https.get(url, { headers }, (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          resolve(this.httpGetText(res.headers.location, depth + 1));
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`HTTP ${code}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.setTimeout(20000, () => req.destroy(new Error("请求超时")));
    });
  }

  // -- Helpers -------------------------------------------------------------

  /** Does a file ref (path, optionally with `:line`) point at a real file? */
  private fileRefExists(ref: string): boolean {
    const p = ref.replace(/:\d+(?:-\d+)?$/, "").trim();
    if (!p) return false;
    const candidates = path.isAbsolute(p)
      ? [p]
      : [path.join(this.cwd(), p), ...this.workspaceDirs().map((d) => path.join(d, p))];
    return candidates.some((c) => {
      try {
        return fs.statSync(c).isFile();
      } catch {
        return false;
      }
    });
  }

  private async openFile(ctx: SessionCtx, p: string, line?: number, endLine?: number): Promise<void> {
    try {
      const abs = path.isAbsolute(p) ? p : path.join(this.cwd(), p);
      const doc = await vscode.workspace.openTextDocument(abs);
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: this.codeColumn(ctx), preview: false });
      if (line && line > 0) {
        const start = new vscode.Position(line - 1, 0);
        const last = endLine && endLine >= line ? endLine - 1 : line - 1;
        const end = new vscode.Position(last, doc.lineAt(Math.min(last, doc.lineCount - 1)).text.length);
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`无法打开文件: ${p}`);
    }
  }

  /** Jump to a code symbol's definition (class / method / enum …) by name.
   *  Tries the language-server symbol index first (same as "Go to Symbol in
   *  Workspace" / Copilot), then jumps directly via file-name & text search. */
  private async openSymbol(ctx: SessionCtx, name: string): Promise<void> {
    // 1) Language-server workspace-symbol index (best — needs the lang extension).
    try {
      const syms =
        (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          "vscode.executeWorkspaceSymbolProvider",
          name,
        )) ?? [];
      const exact = syms.filter((s) => s.name === name);
      const candidates = exact.length ? exact : syms;
      const order: Record<number, number> = {
        [vscode.SymbolKind.Class]: 0,
        [vscode.SymbolKind.Interface]: 0,
        [vscode.SymbolKind.Enum]: 0,
        [vscode.SymbolKind.Struct]: 0,
        [vscode.SymbolKind.Constructor]: 1,
        [vscode.SymbolKind.Method]: 1,
        [vscode.SymbolKind.Function]: 1,
      };
      candidates.sort((a, b) => (order[a.kind] ?? 5) - (order[b.kind] ?? 5));
      const pick = candidates[0];
      if (pick) {
        await this.openFile(ctx, pick.location.uri.fsPath, pick.location.range.start.line + 1);
        return;
      }
    } catch {
      /* no symbol provider — fall through */
    }
    // 2) A type whose file is named after it (Java/Kotlin/C#/TS/Go/… convention).
    try {
      const matches = await vscode.workspace.findFiles(
        `**/${name}.{java,kt,kts,scala,cs,ts,tsx,go,rs,php,swift,dart}`,
        "**/{node_modules,dist,build,out,target,.git}/**",
        3,
      );
      if (matches.length) {
        const doc = await vscode.workspace.openTextDocument(matches[0]);
        await this.openFile(ctx, matches[0].fsPath, this.findDefLine(doc.getText(), name));
        return;
      }
    } catch {
      /* ignore */
    }
    // 3) Direct text search for a definition site, jump to the first hit.
    try {
      const hit = await this.searchDefinition(name);
      if (hit) {
        await this.openFile(ctx, hit.uri.fsPath, hit.line);
        return;
      }
    } catch {
      /* ignore */
    }
    // 4) Last resort: open the Search panel pre-filled.
    try {
      await vscode.commands.executeCommand("workbench.action.findInFiles", {
        query: name,
        triggerSearch: true,
        matchWholeWord: true,
        isCaseSensitive: true,
      });
    } catch {
      vscode.window.showInformationMessage(`未找到符号定义：${name}`);
    }
  }

  /** First line (1-based) where `name` is defined in source text, else undefined. */
  private findDefLine(text: string, name: string): number | undefined {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const def = new RegExp(`\\b(class|interface|enum|record|struct|trait|object|def|func|function|fun|type)\\s+${esc}\\b`);
    const word = new RegExp(`\\b${esc}\\b`);
    const lines = text.split("\n");
    let firstWord: number | undefined;
    for (let i = 0; i < lines.length; i++) {
      if (def.test(lines[i])) return i + 1;
      if (firstWord === undefined && word.test(lines[i])) firstWord = i + 1;
    }
    return firstWord;
  }

  /** Scan workspace source files for a definition of `name` (bounded, early-exit). */
  private async searchDefinition(name: string): Promise<{ uri: vscode.Uri; line: number } | undefined> {
    const files = await vscode.workspace.findFiles(
      "**/*.{java,kt,kts,scala,ts,tsx,js,jsx,go,rs,cs,py,php,rb,swift,dart,c,cpp,h,hpp}",
      "**/{node_modules,dist,build,out,target,.git}/**",
      2500,
    );
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const word = new RegExp(`\\b${esc}\\b`);
    const def = new RegExp(
      `\\b(class|interface|enum|record|struct|trait|object|def|func|function|fun|type)\\s+${esc}\\b` +
        `|\\b[\\w<>\\[\\].]+\\s+${esc}\\s*\\(` +
        `|\\b${esc}\\s*[:=]\\s*(?:function\\b|\\()`,
    );
    let fallback: { uri: vscode.Uri; line: number } | undefined;
    for (const uri of files) {
      let content: string;
      try {
        content = await fs.promises.readFile(uri.fsPath, "utf8");
      } catch {
        continue;
      }
      if (!word.test(content)) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (def.test(lines[i])) return { uri, line: i + 1 };
        if (!fallback && word.test(lines[i])) fallback = { uri, line: i + 1 };
      }
    }
    return fallback;
  }

  private reveal(): void {
    // Reveal the active chat panel in its CURRENT column — never re-pass
    // ViewColumn.Beside, which would re-dock the panel into a new (unlocked)
    // group and let explorer files start replacing the chat tab again.
    if (this.activeCtx) this.activeCtx.panel.reveal(this.activeCtx.panel.viewColumn, true);
    else this.view?.show?.(true);
  }

  /** Post to a chat panel's webview. Safely no-ops if the panel was disposed
   *  (the session is detached/running in the background). */
  private post(ctx: SessionCtx, e: ToWebview): void {
    if (!this.alive(ctx)) return;
    ctx.webview.postMessage(e);
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("claudeChat");
  }

  private cwd(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
    // No folder opened (just a loose file): walk up to the project root so
    // Claude can access the whole project, not only the file's own folder.
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && active.scheme === "file") return this.findProjectRoot(path.dirname(active.fsPath));
    return os.homedir();
  }

  /** Nearest ancestor (incl. start) that looks like a project root. */
  private findProjectRoot(start: string): string {
    const markers = [".git", "package.json", "pom.xml", "build.gradle", "settings.gradle", "go.mod", "Cargo.toml", "pyproject.toml", "tsconfig.json", ".hg", ".svn"];
    let dir = start;
    for (let i = 0; i < 40; i++) {
      for (const m of markers) {
        try {
          if (fs.existsSync(path.join(dir, m))) return dir;
        } catch {
          /* ignore */
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return start;
  }

  /** All directories Claude may access — every workspace folder. */
  private workspaceDirs(): string[] {
    const dirs = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    // Ensure the chosen cwd is always included (covers the loose-file case).
    const root = this.cwd();
    if (root && !dirs.includes(root)) dirs.push(root);
    return dirs;
  }

  private storageDir(): string {
    return this.context.globalStorageUri.fsPath;
  }

  dispose(): void {
    for (const ctx of this.sessions) ctx.proc?.dispose();
    for (const ctx of this.detached.values()) ctx.proc?.dispose();
    this.sessions.clear();
    this.detached.clear();
    this.terminal?.dispose();
  }

  // -- Webview HTML --------------------------------------------------------

  /** The left sidebar: a session manager only. Chat itself lives in the editor
   *  panel (opened via "new chat" or by clicking a session). */
  private sidebarHtml(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, "");
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const TRASH =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3M5 4.5l.6 8a.8.8 0 0 0 .8.7h3.2a.8.8 0 0 0 .8-.7l.6-8"/></svg>';
    const PENCIL =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3.2H3.6a1 1 0 0 0-1 1v7.2a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V7.5"/><path d="M11 2.6a1.1 1.1 0 0 1 1.6 1.6L7.8 9 5.6 9.6 6.2 7.4z"/></svg>';

    return /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); }
  .head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; position: sticky; top: 0; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .head .ttl { font-weight: 600; opacity: .85; }
  .head .sp { flex: 1; }
  .abtn { background: none; border: none; color: var(--vscode-foreground); opacity: .8; cursor: pointer; font-size: 12px; padding: 3px 7px; border-radius: 5px; }
  .abtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.18)); opacity: 1; }
  .abtn.primary { color: var(--vscode-button-background); font-weight: 600; }
  .abtn.danger { color: var(--vscode-errorForeground, #e55); }
  .abtn.hidden { display: none; }
  .new { display: flex; align-items: center; gap: 7px; width: calc(100% - 16px); margin: 8px; padding: 7px 10px; border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); border-radius: 7px; background: none; color: var(--vscode-foreground); cursor: pointer; font-size: 12.5px; }
  .new:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.16)); }
  .new svg { width: 15px; height: 15px; }
  .upd-banner { display: flex; align-items: center; gap: 7px; width: calc(100% - 16px); margin: 8px 8px 0; padding: 7px 10px; border: 1px solid #d97757; border-radius: 7px; background: rgba(217,119,87,.12); color: var(--vscode-foreground); cursor: pointer; font-size: 12.5px; }
  .upd-banner:hover { background: rgba(217,119,87,.22); }
  .upd-banner.hidden { display: none; }
  .upd-banner svg { width: 15px; height: 15px; color: #d97757; }
  .upd-banner b { font-weight: 600; }
  .list { padding: 2px 6px 12px; }
  .empty { opacity: .5; text-align: center; padding: 26px 10px; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 6px; cursor: pointer; position: relative; }
  .row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.14)); }
  .row.active { background: var(--vscode-list-activeSelectionBackground, rgba(80,120,255,.22)); }
  .row .chk { display: none; flex: 0 0 auto; width: 14px; height: 14px; }
  body.multi .row .chk { display: inline-block; }
  .row .body { flex: 1; min-width: 0; }
  .row .trow { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .row .trow .t { flex: 1; }
  .row .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
  .run-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; animation: runpulse 1.6s ease-out infinite; }
  @keyframes runpulse { 0% { box-shadow: 0 0 0 0 rgba(63,185,80,.55); } 70% { box-shadow: 0 0 0 5px rgba(63,185,80,0); } 100% { box-shadow: 0 0 0 0 rgba(63,185,80,0); } }
  .row .meta { font-size: 10.5px; opacity: .55; margin-top: 1px; }
  .row .rename { width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; padding: 1px 4px;
    border: 1px solid var(--vscode-focusBorder, #3794ff); border-radius: 4px; outline: none;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .row .edit, .row .del { flex: 0 0 auto; opacity: 0; background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 2px; border-radius: 4px; }
  .row:hover .edit, .row:hover .del { opacity: .65; }
  .row .edit:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.25)); }
  .row .del:hover { opacity: 1; color: var(--vscode-errorForeground, #e55); }
  .row .edit svg, .row .del svg { width: 14px; height: 14px; }
  body.multi .row .edit, body.multi .row .del { display: none; }
</style>
</head>
<body>
  <div class="head">
    <span class="ttl">会话</span>
    <span class="sp"></span>
    <button id="multi" class="abtn" title="多选">多选</button>
    <button id="delsel" class="abtn danger hidden">删除所选</button>
  </div>
  <button id="upd-banner" class="upd-banner hidden">${ICONS.update}<span>发现新版本 <b id="upd-ver"></b> · 点击更新</span></button>
  <button id="new" class="new">${ICONS.add}<span>新建会话</span></button>
  <div id="list" class="list"><div class="empty">暂无会话</div></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const TRASH = ${JSON.stringify(TRASH)};
    const PENCIL = ${JSON.stringify(PENCIL)};
    let sessions = [], activeId = null, runningIds = new Set(), multi = false;
    const sel = new Set();
    const $ = (id) => document.getElementById(id);

    function fmt(ts) {
      if (!ts) return "";
      const d = new Date(ts), now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      if (sameDay) return d.toTimeString().slice(0, 5);
      return (d.getMonth() + 1) + "月" + d.getDate() + "日";
    }

    function render() {
      const list = $("list");
      if (!sessions.length) { list.innerHTML = '<div class="empty">暂无会话</div>'; return; }
      list.innerHTML = "";
      for (const s of sessions) {
        const row = document.createElement("div");
        row.className = "row" + (s.id === activeId ? " active" : "");
        row.dataset.id = s.id;
        const chk = document.createElement("input");
        chk.type = "checkbox"; chk.className = "chk"; chk.checked = sel.has(s.id);
        chk.addEventListener("click", (e) => { e.stopPropagation(); toggle(s.id, chk.checked); });
        const body = document.createElement("div"); body.className = "body";
        const tRow = document.createElement("div"); tRow.className = "trow";
        if (runningIds.has(s.id)) { const dot = document.createElement("span"); dot.className = "run-dot"; dot.title = "正在回复中"; tRow.appendChild(dot); }
        const t = document.createElement("div"); t.className = "t"; t.textContent = s.title || "新对话";
        tRow.appendChild(t);
        const meta = document.createElement("div"); meta.className = "meta";
        meta.textContent = fmt(s.updatedAt) + (s.messageCount ? "  ·  " + s.messageCount + " 条" : "");
        body.append(tRow, meta);
        const edit = document.createElement("button"); edit.className = "edit"; edit.title = "重命名"; edit.innerHTML = PENCIL;
        edit.addEventListener("click", (e) => { e.stopPropagation(); rename(s.id); });
        const del = document.createElement("button"); del.className = "del"; del.title = "删除"; del.innerHTML = TRASH;
        del.addEventListener("click", (e) => { e.stopPropagation(); confirmDel([s.id]); });
        row.append(chk, body, edit, del);
        row.addEventListener("click", () => { if (multi) toggle(s.id, !sel.has(s.id)); else open(s.id); });
        list.appendChild(row);
      }
    }

    function toggle(id, on) { if (on) sel.add(id); else sel.delete(id); $("delsel").classList.toggle("hidden", sel.size === 0); render(); }
    function open(id) { vscode.postMessage({ type: "openSession", sessionId: id }); }
    function confirmDel(ids) { if (ids.length) vscode.postMessage({ type: "deleteSessions", sessionIds: ids }); }

    function rename(id) {
      const row = document.querySelector('.row[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (!row) return;
      const t = row.querySelector(".t");
      const cur = (sessions.find((s) => s.id === id) || {}).title || "";
      const input = document.createElement("input");
      input.className = "rename"; input.value = cur;
      t.replaceWith(input); input.focus(); input.select();
      let done = false;
      const commit = (save) => {
        if (done) return; done = true;
        if (save) vscode.postMessage({ type: "renameSession", sessionId: id, title: input.value.trim() });
        render();
      };
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(true); }
        else if (e.key === "Escape") { e.preventDefault(); commit(false); }
      });
      input.addEventListener("blur", () => commit(true));
    }
    $("new").addEventListener("click", () => vscode.postMessage({ type: "newInEditor" }));
    $("multi").addEventListener("click", () => {
      multi = !multi; document.body.classList.toggle("multi", multi);
      $("multi").textContent = multi ? "取消" : "多选";
      if (!multi) { sel.clear(); $("delsel").classList.add("hidden"); }
      render();
    });
    $("delsel").addEventListener("click", () => confirmDel([...sel]));
    $("upd-banner").addEventListener("click", () => vscode.postMessage({ type: "checkUpdate" }));

    window.addEventListener("message", (ev) => {
      const m = ev.data;
      if (m && m.kind === "sessions") {
        sessions = m.list || []; activeId = m.activeId || null;
        if (m.runningIds !== undefined) runningIds = new Set(m.runningIds || []);
        for (const id of [...sel]) if (!sessions.find((s) => s.id === id)) sel.delete(id);
        $("delsel").classList.toggle("hidden", sel.size === 0);
        render();
      } else if (m && m.kind === "running") {
        runningIds = new Set(m.sessionIds || []);
        render();
      } else if (m && m.kind === "update_available") {
        if (m.version) { $("upd-ver").textContent = "v" + m.version; $("upd-banner").classList.remove("hidden"); }
        else $("upd-banner").classList.add("hidden");
      }
    });
    vscode.postMessage({ type: "listSessions" });
  </script>
</body>
</html>`;
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, "");
    // Cache-bust so the webview never serves a stale copy of the bundled assets.
    const scriptUri =
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js")).toString() +
      `?v=${nonce}`;
    const styleUri =
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")).toString() +
      `?v=${nonce}`;
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>ClaudeCopilot</title>
</head>
<body>
  <div id="app">
    <div id="overlay" class="overlay hidden"></div>
    <div id="lightbox" class="lightbox hidden"><img id="lightbox-img" alt="预览" /></div>
    <header id="toolbar">
      <div class="title"><span id="session-title">新对话</span></div>
      <div class="spacer"></div>
      <button id="btn-sessions" class="icon-btn" title="历史会话">${ICONS.sessions}</button>
      <button id="btn-new" class="icon-btn" title="新建会话">${ICONS.newChat}</button>
    </header>

    <div id="messages" class="messages"></div>

    <div id="panel-sessions" class="drawer hidden">
      <div class="drawer-head">
        <span>历史会话</span>
        <span class="drawer-spacer"></span>
        <button id="sessions-multi" class="drawer-act" title="多选">多选</button>
        <button id="sessions-del-sel" class="drawer-act danger hidden">删除所选</button>
        <button class="drawer-close" data-close>×</button>
      </div>
      <div id="sessions-list" class="drawer-body"></div>
    </div>
    <div id="ctx-menu" class="ctx-menu hidden"></div>
    <footer id="composer">
      <div id="changed-files" class="changed-files hidden">
        <div class="cf-header" id="cf-header">
          <span class="cf-caret">▾</span>
          <span class="cf-title">已更改文件</span>
          <span id="cf-stat" class="cf-stat"></span>
        </div>
        <div id="cf-list" class="cf-list"></div>
      </div>
      <div id="task-queue" class="task-queue hidden"></div>
      <div id="context-chips"></div>
      <div id="file-chips"></div>
      <div id="image-previews"></div>
      <div id="queue-hint" class="queue-hint hidden"><span class="qh-key">↵</span> 任务进行中 · 回车将内容加入<b>等待队列</b></div>
      <div class="input-wrap">
        <textarea id="input" rows="1" placeholder="给 Claude 发消息…  (Enter 发送 / Shift+Enter 换行 · 📎 或拖拽附加文件)"></textarea>
        <div class="composer-bottom">
          <button id="btn-attach-file" class="composer-btn" title="附加文件/目录到会话">${ICONS.attach}</button>
          <button id="model-trigger" class="composer-pick" title="选择模型"><span id="model-label">默认模型</span><span class="pick-caret">⌄</span></button>
          <button id="mode-trigger" class="composer-pick" title="选择模式"><span id="mode-icon" class="pick-emoji">⚡</span><span id="mode-label">Auto</span></button>
          <span id="ctx-gauge" class="ctx-gauge hidden" title="上下文使用量"><span class="cg-ring"><span class="cg-pct"></span></span></span>
          <button id="usage-pill" class="usage-pill hidden" title="Claude 订阅用量 · 点击刷新"></button>
          <div class="spacer"></div>
          <button id="btn-send" class="composer-send" title="发送">${ICONS.send}</button>
          <button id="btn-stop" class="composer-send stop hidden" title="停止">${ICONS.stop}</button>
        </div>
      </div>
      <div id="pick-backdrop" class="pick-backdrop hidden"></div>
      <div id="mode-menu" class="pick-menu hidden"></div>
      <div id="model-menu" class="pick-menu hidden"></div>
      <div id="status-line" class="status-line"></div>
    </footer>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Parse the CLI `/usage` text into the current-session + weekly quota
 *  percentages (and the weekly reset). Mirrors the official panel. Returns
 *  undefined if nothing recognizable was found (e.g. API-key accounts). */
function parseUsage(text: string): { sessionPct?: number; weekPct?: number; weekReset?: string; weekSonnetPct?: number } | undefined {
  if (!text) return undefined;
  const reset = (s?: string) => s?.replace(/\s*\(.*?\)\s*$/, "").trim() || undefined; // drop "(Asia/Shanghai)"
  const sess = /Current session:\s*(\d+)%\s*used/i.exec(text);
  const week = /Current week \(all models\):\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n(]+))?/i.exec(text);
  const sonnet = /Current week \(Sonnet only\):\s*(\d+)%\s*used/i.exec(text);
  if (!sess && !week) return undefined;
  return {
    sessionPct: sess ? parseInt(sess[1], 10) : undefined,
    weekPct: week ? parseInt(week[1], 10) : undefined,
    weekReset: reset(week?.[2]),
    weekSonnetPct: sonnet ? parseInt(sonnet[1], 10) : undefined,
  };
}

/** Compare two dotted versions: >0 if a>b, <0 if a<b, 0 if equal. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Git-style added/removed line counts via an LCS line diff. */
/** First line index (0-based) that differs between two texts. */
function firstChangedLine(a: string, b: string): number {
  const al = a.split("\n");
  const bl = b.split("\n");
  const n = Math.min(al.length, bl.length);
  for (let i = 0; i < n; i++) if (al[i] !== bl[i]) return i;
  return al.length === bl.length ? 0 : n;
}

function diffCounts(oldText: string, newText: string): { added: number; removed: number } {
  // Strip a single trailing newline so it isn't counted as a phantom line.
  const split = (t: string): string[] => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const a = split(oldText);
  const b = split(newText);
  const n = a.length;
  const m = b.length;
  if (n === 0) return { added: m, removed: 0 };
  if (m === 0) return { added: 0, removed: n };
  if (n * m > 4_000_000) {
    // Too large for an exact LCS — fall back to a size-based estimate.
    return { added: Math.max(0, m - n), removed: Math.max(0, n - m) };
  }
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { added: m - lcs, removed: n - lcs };
}
