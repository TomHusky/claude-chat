import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { ClaudeProcess, PermissionRequest } from "../claude/process";
import { SessionStore } from "../claude/session";
import { CheckpointManager } from "../checkpoints";
import { ChangedFile, CTX_OPEN, CTX_CLOSE, FromWebview, ICONS, ToWebview } from "../shared";

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** URI scheme that serves the pre-edit baseline content for the native diff editor. */
const ORIG_SCHEME = "claude-orig";
/** workspaceState key: id of the last active session (restored on open). */
const LAST_SESSION_KEY = "claudeChat.lastSession";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "claude-chat.chatView";

  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel; // editor-area webview (movable / splittable, e.g. to the right)
  private active?: vscode.Webview; // whichever webview the user last interacted with
  private proc?: ClaudeProcess;
  private starting?: Promise<ClaudeProcess | undefined>;
  private store: SessionStore;
  private checkpoints: CheckpointManager;
  private activeSessionId?: string;
  private webviewReady = false;
  private pendingContext?: string;
  private forceBlank = false; // next panel-ready should show a blank new session
  private readonly origChanged = new vscode.EventEmitter<vscode.Uri>();
  private terminal?: vscode.Terminal;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.store = new SessionStore(this.cwd());
    this.checkpoints = new CheckpointManager(this.storageDir());

    // Serve baseline (pre-edit) content so the native diff editor can show
    // "original ⟷ current" for any file Claude changed this session.
    const cm = this.checkpoints;
    const origChanged = this.origChanged;
    this.context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, {
        onDidChange: origChanged.event,
        provideTextDocumentContent(uri: vscode.Uri): string {
          if (uri.query === "empty") return "";
          return cm.originalOf(uri.path) ?? "";
        },
      }),
      origChanged,
      vscode.window.onDidCloseTerminal((t) => {
        if (t === this.terminal) this.terminal = undefined;
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.postActiveFile()),
    );
  }

  /** Tell the webview which file is shown (for the default chip). Never clears
   *  it just because focus moved to the chat — only updates to a real file. */
  private postActiveFile(): void {
    let p: string | undefined;
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === "file") {
      p = ed.document.uri.fsPath;
    } else {
      const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input as { uri?: vscode.Uri } | undefined;
      if (input?.uri && input.uri.scheme === "file") p = input.uri.fsPath;
    }
    if (p) this.post({ kind: "active_file", path: p });
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
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.post2(view.webview, { kind: "sessions", list: this.store.list(), activeId: this.activeSessionId });
    });
  }

  /** Post to a specific webview (used to keep the sidebar's session list in sync). */
  private post2(target: vscode.Webview | undefined, e: ToWebview): void {
    target?.postMessage(e);
  }

  /** Broadcast the session list to both the sidebar manager and the chat panel. */
  private refreshSessions(): void {
    const e: ToWebview = { kind: "sessions", list: this.store.list(), activeId: this.activeSessionId };
    this.view?.webview.postMessage(e);
    this.panel?.webview.postMessage(e);
  }

  /** Open the chat as an editor-area panel (like Claude Code) — opens beside the
   *  current editor so it can live on the right and be split/moved freely. */
  async openInEditor(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
      await this.lockChatGroup();
      return;
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
    this.adoptPanel(panel);
    // Lock the chat's editor group so files opened from the explorer go to another
    // group instead of replacing the chat tab (lets you view files + chat together).
    await this.lockChatGroup();
  }

  /** Wire a freshly-created OR a restored (deserialized) editor panel into the
   *  provider: set its HTML/icon, route its messages, and track it as the panel. */
  private adoptPanel(panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    panel.title = "ClaudeCopilot";
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg");
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m: FromWebview) => {
      this.active = panel.webview;
      this.onMessage(m);
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      if (this.active === panel.webview) this.active = this.view?.webview;
    });
    this.panel = panel;
    this.active = panel.webview;
  }

  /** Re-adopt a panel restored by VS Code after a window reload/restart. Without
   *  this, the serialized tab comes back blank (no title, no content). */
  async revivePanel(panel: vscode.WebviewPanel): Promise<void> {
    if (this.panel && this.panel !== panel) {
      // We somehow already have a live panel; drop the duplicate restored one.
      panel.dispose();
      return;
    }
    this.adoptPanel(panel);
    await this.lockChatGroup();
  }

  /** Lock the chat panel's editor group so explorer files open in another group
   *  instead of replacing the chat tab. */
  private async lockChatGroup(): Promise<void> {
    if (!this.panel) return;
    try {
      // Bring the chat panel forward so ITS group becomes the active group.
      this.panel.reveal(this.panel.viewColumn, false);
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
    await this.startFreshSession();
  }

  async showSessions(): Promise<void> {
    this.refreshSessions();
    this.reveal();
  }

  async stop(): Promise<void> {
    await this.proc?.interrupt();
  }

  focusInput(): void {
    this.reveal();
    this.post({ kind: "notice", message: "" }); // no-op nudge; webview focuses input on reveal
  }

  addSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showInformationMessage("没有选中的代码。");
      return;
    }
    const sel = editor.document.getText(editor.selection);
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const lang = editor.document.languageId;
    const start = editor.selection.start.line + 1;
    const end = editor.selection.end.line + 1;
    const label = `${rel}:${start}-${end}`;
    const text = `选中代码 \`${label}\`:\n\`\`\`${lang}\n${sel}\n\`\`\``;
    this.pendingContext = text;
    this.reveal();
    this.post({ kind: "context_added", label, text });
  }

  // -- Message handling ----------------------------------------------------

  private async onMessage(m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case "ready":
          this.webviewReady = true;
          this.post({
            kind: "config",
            permissionMode: this.config().get<string>("permissionMode", "default"),
            model: this.config().get<string>("model", ""),
            effort: this.config().get<string>("effort", ""),
          });
          this.restoreLastOrActive();
          this.postActiveFile();
          this.prewarm();
          break;
        case "warm":
          this.prewarm();
          break;
        case "send":
          await this.handleSend(m.text, m.context, m.images, m.files);
          break;
        case "editMessage":
          await this.editMessage(m.checkpointId, m.text);
          break;
        case "interrupt":
          await this.proc?.interrupt();
          break;
        case "permission":
          this.handlePermission(m.requestId, m.behavior, m.suggestionId);
          break;
        case "newSession":
          await this.startFreshSession();
          break;
        case "listSessions":
          this.refreshSessions();
          break;
        case "switchSession":
          await this.switchSession(m.sessionId);
          break;
        case "openSession":
          await this.openInEditor();
          await this.switchSession(m.sessionId);
          break;
        case "newInEditor":
          this.forceBlank = true;
          await this.openInEditor();
          await this.startFreshSession();
          break;
        case "deleteSession":
          await this.deleteSessions([m.sessionId]);
          break;
        case "deleteSessions":
          await this.deleteSessions(m.sessionIds);
          break;
        case "listCheckpoints":
          this.post({ kind: "checkpoints", list: this.checkpoints.list() });
          break;
        case "restoreCheckpoint":
          await this.restoreCheckpoint(m.checkpointId);
          break;
        case "setPermissionMode":
          await this.setPermissionMode(m.mode);
          break;
        case "setModel":
          await this.setModel(m.model);
          break;
        case "setEffort":
          await this.setEffort(m.effort);
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
          if (picked?.length) this.post({ kind: "attach_files", paths: picked.map((u) => u.fsPath) });
          break;
        }
        case "openDiff":
          await this.openDiff(m.path);
          break;
        case "acceptFile":
          this.checkpoints.accept(m.path);
          this.refreshChangedFiles();
          break;
        case "revertFile":
          this.revertFile(m.path);
          this.refreshChangedFiles();
          break;
        case "acceptAll":
          for (const f of this.getChangedFiles().files) this.checkpoints.accept(f.path);
          this.refreshChangedFiles();
          break;
        case "revertAll": {
          const files = this.getChangedFiles().files;
          if (files.length) {
            const ok = await vscode.window.showWarningMessage(
              `回滚全部 ${files.length} 个文件的改动？`,
              { modal: true, detail: "将把这些文件恢复到 Claude 改动前的状态，此操作不可撤销。" },
              "回滚全部",
            );
            if (ok === "回滚全部") {
              for (const f of files) this.revertFile(f.path);
              this.refreshChangedFiles();
            }
          }
          break;
        }
        case "runInTerminal":
          this.runInTerminal(m.code);
          break;
        case "openFile":
          await this.openFile(m.path, m.line, m.endLine);
          break;
        case "openSymbol":
          await this.openSymbol(m.name);
          break;
        case "copy":
          await vscode.env.clipboard.writeText(m.text);
          break;
      }
    } catch (err) {
      this.output.appendLine(`[onMessage:${m.type}] ${String(err)}`);
      this.post({ kind: "error", message: String((err as Error)?.message ?? err) });
    }
  }

  private async handleSend(
    text: string,
    context?: string,
    images?: { mediaType: string; data: string }[],
    files?: string[],
  ): Promise<void> {
    let ctx = context ?? this.pendingContext;
    this.pendingContext = undefined;
    if (files && files.length) {
      const fileCtx = this.buildFileContext(files);
      ctx = ctx ? `${fileCtx}\n\n${ctx}` : fileCtx;
    }
    const proc = await this.ensureProcess();
    if (!proc) return;
    // Record the transcript length *before* this turn so a restore point can
    // truncate the conversation back to exactly here.
    const lineBefore = this.activeSessionId ? this.store.countLines(this.activeSessionId) : 0;
    const checkpointId = this.checkpoints.beginTurn(text || "(图片)", lineBefore);
    proc.sendUserMessage(text, ctx, images);
    this.post({ kind: "checkpoint_marker", checkpointId, userText: text });
  }

  /**
   * Edit a past user message: rewind the conversation to before that message
   * (revert files + truncate transcript), then resend the new text as the turn.
   * The webview has already trimmed its own view, so we don't reload history.
   */
  private async editMessage(checkpointId: string, text: string): Promise<void> {
    if (checkpointId) {
      const res = this.checkpoints.restore(checkpointId);
      if (res) {
        this.proc?.dispose();
        this.proc = undefined;
        this.starting = undefined;
        let remaining = 0;
        if (this.activeSessionId) {
          remaining = this.store.truncateToLines(this.activeSessionId, res.truncateLine);
        }
        if (remaining === 0) {
          this.activeSessionId = undefined;
          this.checkpoints.clear();
        }
        this.refreshChangedFiles();
      }
    }
    await this.handleSend(text);
  }

  private handlePermission(requestId: string, behavior: "allow" | "deny", suggestionId?: string): void {
    if (!this.proc) return;
    if (behavior === "allow" && suggestionId?.startsWith("setMode:")) {
      const mode = suggestionId.split(":")[1];
      if (mode) void this.proc.setPermissionMode(mode);
    }
    this.proc.respondPermission(requestId, { behavior });
  }

  private async setPermissionMode(mode: string): Promise<void> {
    await this.config().update("permissionMode", mode, vscode.ConfigurationTarget.Global);
    await this.proc?.setPermissionMode(mode);
    // No chat notice — the picker label already reflects the change.
  }

  private async setModel(model: string): Promise<void> {
    await this.config().update("model", model, vscode.ConfigurationTarget.Global);
    // Model is a spawn argument; restart the process so it applies. Context is
    // preserved because the next send resumes the same session id.
    if (this.proc) {
      this.proc.dispose();
      this.proc = undefined;
      this.starting = undefined;
    }
    // No chat notice — the picker label already reflects the change.
  }

  private async setEffort(effort: string): Promise<void> {
    await this.config().update("effort", effort, vscode.ConfigurationTarget.Global);
    // Effort is also a spawn argument — restart so it applies on the next message.
    if (this.proc) {
      this.proc.dispose();
      this.proc = undefined;
      this.starting = undefined;
    }
  }

  // -- Changed files & native diff ----------------------------------------

  /** Which editor column to open code/diffs in — always opposite the chat panel
   *  so it doesn't cover the conversation (code on one side, chat on the other). */
  private codeColumn(): vscode.ViewColumn {
    return this.panel?.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  }

  private async openDiff(absPath: string): Promise<void> {
    const original = this.checkpoints.originalOf(absPath);
    const rel = vscode.workspace.asRelativePath(absPath);
    const left = vscode.Uri.from({ scheme: ORIG_SCHEME, path: absPath });
    const exists = fs.existsSync(absPath);
    const right = exists
      ? vscode.Uri.file(absPath)
      : vscode.Uri.from({ scheme: ORIG_SCHEME, path: absPath, query: "empty" });
    const tag = original == null ? "新增" : exists ? "改动" : "删除";
    await vscode.commands.executeCommand("vscode.diff", left, right, `${rel} (Claude ${tag})`, {
      preview: true,
      viewColumn: this.codeColumn(),
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
  private revertFile(absPath: string): void {
    const base = this.checkpoints.originalOf(absPath);
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
    this.checkpoints.accept(absPath); // stop tracking it (now matches baseline)
    this.origChanged.fire(vscode.Uri.from({ scheme: ORIG_SCHEME, path: absPath }));
  }

  private refreshChangedFiles(): void {
    const { files, totalAdded, totalRemoved } = this.getChangedFiles();
    for (const f of files) this.origChanged.fire(vscode.Uri.from({ scheme: ORIG_SCHEME, path: f.path }));
    this.post({ kind: "changed_files", files, totalAdded, totalRemoved });
  }

  private getChangedFiles(): { files: ChangedFile[]; totalAdded: number; totalRemoved: number } {
    const files: ChangedFile[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const p of this.checkpoints.changedPaths()) {
      const original = this.checkpoints.originalOf(p); // string | null | undefined
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

  private async restoreCheckpoint(checkpointId: string): Promise<void> {
    const preview = this.checkpoints.preview(checkpointId);
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

    const result = this.checkpoints.restore(checkpointId);
    if (!result) {
      this.post({ kind: "error", message: "找不到该还原点。" });
      return;
    }

    // 1) Stop the live process so it isn't writing to the transcript.
    this.proc?.dispose();
    this.proc = undefined;
    this.starting = undefined;

    // 2) Truly rewind the conversation: truncate the transcript so a future
    //    --resume makes Claude forget everything after this point.
    let remainingTurns = 0;
    if (this.activeSessionId) {
      remainingTurns = this.store.truncateToLines(this.activeSessionId, result.truncateLine);
    }

    // 3) If nothing remains, this becomes a brand-new conversation.
    if (remainingTurns === 0) {
      this.activeSessionId = undefined;
      this.checkpoints.clear();
      this.post({ kind: "load_history", items: [], title: "新对话", checkpoints: [] });
    } else {
      const items = this.store.load(this.activeSessionId!);
      this.post({ kind: "load_history", items, sessionId: this.activeSessionId, checkpoints: this.checkpoints.list() });
    }

    this.post({
      kind: "notice",
      message: `已还原 ${result.restoredFiles} 个文件，并把对话回退到这条消息之前。下一条消息将从这里继续。`,
    });
    this.refreshChangedFiles();
  }

  // -- Process management --------------------------------------------------

  /** Spawn + initialize the CLI ahead of the first message (cold start ≈ 1–2s)
   *  so sending feels instant. Fire-and-forget; no-op if already up/starting. */
  private prewarm(): void {
    if (this.proc || this.starting) return;
    void this.ensureProcess().catch(() => {
      /* errors surface on the real send */
    });
  }

  private ensureProcess(): Promise<ClaudeProcess | undefined> {
    if (this.proc) return Promise.resolve(this.proc);
    if (this.starting) return this.starting;
    this.starting = this.spawnProcess().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async spawnProcess(): Promise<ClaudeProcess | undefined> {
    const isResume = !!this.activeSessionId;
    const sessionId = this.activeSessionId ?? randomUUID();
    if (!isResume) {
      this.activeSessionId = sessionId;
      this.checkpoints.setSession(sessionId);
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
      },
      {
        emit: (e) => this.handleEmit(e),
        onPermission: (req) => this.onPermission(req),
        onSessionId: (id, resumed) => this.onSessionId(id, resumed),
        onClose: (code) => this.onProcessClose(code),
      },
    );
    this.proc = proc;
    try {
      await proc.start();
    } catch (err) {
      this.post({ kind: "error", message: `初始化 claude 失败: ${String(err)}` });
      this.proc = undefined;
      return undefined;
    }
    return proc;
  }

  /** Snapshot file edits for restore points as soon as Claude proposes them. */
  private handleEmit(e: ToWebview): void {
    if (e.kind === "tool_input" && FILE_TOOLS.has(e.name)) {
      if (this.config().get<boolean>("snapshotFilesForRestore", true)) {
        const p = (e.input.file_path ?? e.input.notebook_path) as string | undefined;
        if (p && path.isAbsolute(p)) this.checkpoints.snapshotFile(p);
      }
    }
    this.post(e);
    // Refresh the changed-files panel when a turn finishes or a file result lands.
    if (e.kind === "result" || (e.kind === "tool_result" && !e.isError)) {
      this.refreshChangedFiles();
    }
  }

  private onPermission(req: PermissionRequest): void {
    this.post({
      kind: "permission_request",
      requestId: req.requestId,
      toolUseId: req.toolUseId,
      toolName: req.toolName,
      displayName: req.displayName,
      input: req.input,
      description: req.description,
      suggestions: req.suggestions,
    });
  }

  private onSessionId(id: string, resumed: boolean): void {
    this.forceBlank = false;
    this.activeSessionId = id;
    this.checkpoints.setSession(id);
    void this.context.workspaceState.update(LAST_SESSION_KEY, id);
    if (!resumed) {
      // Newly created — refresh the session list lazily.
      this.refreshSessions();
    }
  }

  /** On webview load, re-render the active session, or restore the last one used. */
  private restoreLastOrActive(): void {
    if (this.forceBlank) {
      // The chat panel was just opened via "new chat" from the sidebar.
      this.forceBlank = false;
      this.activeSessionId = undefined;
      this.checkpoints.clear();
      this.post({ kind: "load_history", items: [], title: "新对话", checkpoints: [] });
      this.refreshChangedFiles();
      return;
    }
    const sid = this.activeSessionId ?? this.context.workspaceState.get<string>(LAST_SESSION_KEY);
    if (!sid || !this.store.findFile(sid)) {
      this.refreshChangedFiles();
      return;
    }
    this.activeSessionId = sid;
    this.checkpoints.setSession(sid);
    const items = this.store.load(sid);
    const title = this.store.list().find((s) => s.id === sid)?.title;
    this.post({ kind: "load_history", items, sessionId: sid, title, checkpoints: this.checkpoints.list() });
    this.refreshSessions();
    this.refreshChangedFiles();
  }

  private onProcessClose(code: number | null): void {
    this.output.appendLine(`[claude] process closed (code ${code})`);
    this.proc = undefined; // next send respawns with --resume to keep context
    this.post({ kind: "busy", busy: false });
  }

  private async startFreshSession(): Promise<void> {
    this.proc?.dispose();
    this.proc = undefined;
    this.starting = undefined;
    this.activeSessionId = undefined;
    this.checkpoints.clear();
    this.post({ kind: "load_history", items: [], title: "新对话", checkpoints: [] });
    this.refreshChangedFiles();
    this.reveal();
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
      this.store.delete(id);
      if (id === this.activeSessionId) {
        this.activeSessionId = undefined;
        this.checkpoints.clear();
        this.post({ kind: "load_history", items: [], title: "新对话", checkpoints: [] });
      }
    }
    this.refreshSessions();
  }

  private async switchSession(sessionId: string): Promise<void> {
    this.forceBlank = false;
    this.proc?.dispose();
    this.proc = undefined;
    this.starting = undefined;
    this.activeSessionId = sessionId;
    this.checkpoints.setSession(sessionId);
    void this.context.workspaceState.update(LAST_SESSION_KEY, sessionId);
    const items = this.store.load(sessionId);
    this.post({ kind: "load_history", items, sessionId, checkpoints: this.checkpoints.list() });
    this.refreshSessions();
    this.refreshChangedFiles();
    this.reveal();
  }

  // -- Helpers -------------------------------------------------------------

  private async openFile(p: string, line?: number, endLine?: number): Promise<void> {
    try {
      const abs = path.isAbsolute(p) ? p : path.join(this.cwd(), p);
      const doc = await vscode.workspace.openTextDocument(abs);
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: this.codeColumn(), preview: false });
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
  private async openSymbol(name: string): Promise<void> {
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
        await this.openFile(pick.location.uri.fsPath, pick.location.range.start.line + 1);
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
        await this.openFile(matches[0].fsPath, this.findDefLine(doc.getText(), name));
        return;
      }
    } catch {
      /* ignore */
    }
    // 3) Direct text search for a definition site, jump to the first hit.
    try {
      const hit = await this.searchDefinition(name);
      if (hit) {
        await this.openFile(hit.uri.fsPath, hit.line);
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
    // Reveal the panel in its CURRENT column — never re-pass ViewColumn.Beside,
    // which would re-dock the panel into a new (unlocked) group and let explorer
    // files start replacing the chat tab again.
    if (this.panel) this.panel.reveal(this.panel.viewColumn, true);
    else this.view?.show?.(true);
  }

  private post(e: ToWebview): void {
    const target = this.active ?? this.panel?.webview ?? this.view?.webview;
    target?.postMessage(e);
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("claudeChat");
  }

  private cwd(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && active.scheme === "file") return path.dirname(active.fsPath);
    return os.homedir();
  }

  private workspaceDirs(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  private storageDir(): string {
    return this.context.globalStorageUri.fsPath;
  }

  dispose(): void {
    this.proc?.dispose();
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
  .list { padding: 2px 6px 12px; }
  .empty { opacity: .5; text-align: center; padding: 26px 10px; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 6px; cursor: pointer; position: relative; }
  .row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.14)); }
  .row.active { background: var(--vscode-list-activeSelectionBackground, rgba(80,120,255,.22)); }
  .row .chk { display: none; flex: 0 0 auto; width: 14px; height: 14px; }
  body.multi .row .chk { display: inline-block; }
  .row .body { flex: 1; min-width: 0; }
  .row .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
  .row .meta { font-size: 10.5px; opacity: .55; margin-top: 1px; }
  .row .del { flex: 0 0 auto; opacity: 0; background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 2px; border-radius: 4px; }
  .row:hover .del { opacity: .65; }
  .row .del:hover { opacity: 1; color: var(--vscode-errorForeground, #e55); }
  .row .del svg { width: 14px; height: 14px; }
  body.multi .row .del { display: none; }
  .ctx { position: fixed; z-index: 50; background: var(--vscode-menu-background, #2a2a2a); border: 1px solid var(--vscode-menu-border, rgba(127,127,127,.3)); border-radius: 6px; padding: 4px; box-shadow: 0 4px 14px rgba(0,0,0,.35); min-width: 120px; }
  .ctx.hidden { display: none; }
  .ctx button { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--vscode-menu-foreground, inherit); padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .ctx button:hover { background: var(--vscode-menu-selectionBackground, rgba(80,120,255,.3)); }
  .ctx button.danger { color: var(--vscode-errorForeground, #e55); }
</style>
</head>
<body>
  <div class="head">
    <span class="ttl">会话</span>
    <span class="sp"></span>
    <button id="multi" class="abtn" title="多选">多选</button>
    <button id="delsel" class="abtn danger hidden">删除所选</button>
  </div>
  <button id="new" class="new">${ICONS.add}<span>新建会话</span></button>
  <div id="list" class="list"><div class="empty">暂无会话</div></div>
  <div id="ctx" class="ctx hidden"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const TRASH = ${JSON.stringify(TRASH)};
    let sessions = [], activeId = null, multi = false;
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
        const t = document.createElement("div"); t.className = "t"; t.textContent = s.title || "新对话";
        const meta = document.createElement("div"); meta.className = "meta";
        meta.textContent = fmt(s.updatedAt) + (s.messageCount ? "  ·  " + s.messageCount + " 条" : "");
        body.append(t, meta);
        const del = document.createElement("button"); del.className = "del"; del.title = "删除"; del.innerHTML = TRASH;
        del.addEventListener("click", (e) => { e.stopPropagation(); confirmDel([s.id]); });
        row.append(chk, body, del);
        row.addEventListener("click", () => { if (multi) toggle(s.id, !sel.has(s.id)); else open(s.id); });
        row.addEventListener("contextmenu", (e) => { e.preventDefault(); showCtx(e.clientX, e.clientY, s.id); });
        list.appendChild(row);
      }
    }

    function toggle(id, on) { if (on) sel.add(id); else sel.delete(id); $("delsel").classList.toggle("hidden", sel.size === 0); render(); }
    function open(id) { vscode.postMessage({ type: "openSession", sessionId: id }); }
    function confirmDel(ids) { if (ids.length) vscode.postMessage({ type: "deleteSessions", sessionIds: ids }); }

    function showCtx(x, y, id) {
      const c = $("ctx");
      c.innerHTML = "";
      const openBtn = document.createElement("button"); openBtn.textContent = "打开";
      openBtn.onclick = () => { hideCtx(); open(id); };
      const delBtn = document.createElement("button"); delBtn.className = "danger"; delBtn.textContent = "删除";
      delBtn.onclick = () => { hideCtx(); confirmDel([id]); };
      c.append(openBtn, delBtn);
      c.style.left = Math.min(x, window.innerWidth - 140) + "px";
      c.style.top = Math.min(y, window.innerHeight - 80) + "px";
      c.classList.remove("hidden");
    }
    function hideCtx() { $("ctx").classList.add("hidden"); }
    window.addEventListener("click", hideCtx);
    window.addEventListener("scroll", hideCtx, true);

    $("new").addEventListener("click", () => vscode.postMessage({ type: "newInEditor" }));
    $("multi").addEventListener("click", () => {
      multi = !multi; document.body.classList.toggle("multi", multi);
      $("multi").textContent = multi ? "取消" : "多选";
      if (!multi) { sel.clear(); $("delsel").classList.add("hidden"); }
      render();
    });
    $("delsel").addEventListener("click", () => confirmDel([...sel]));

    window.addEventListener("message", (ev) => {
      const m = ev.data;
      if (m && m.kind === "sessions") {
        sessions = m.list || []; activeId = m.activeId || null;
        for (const id of [...sel]) if (!sessions.find((s) => s.id === id)) sel.delete(id);
        $("delsel").classList.toggle("hidden", sel.size === 0);
        render();
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
          <span class="cf-title">已更改 <span id="cf-count">0</span> 个文件</span>
          <span id="cf-stat" class="cf-stat"></span>
        </div>
        <div id="cf-list" class="cf-list"></div>
      </div>
      <div id="context-chips"></div>
      <div id="file-chips"></div>
      <div id="image-previews"></div>
      <div class="input-wrap">
        <textarea id="input" rows="1" placeholder="给 Claude 发消息…  (Enter 发送 / Shift+Enter 换行 · 📎 或拖拽附加文件)"></textarea>
        <div class="composer-bottom">
          <button id="btn-attach-file" class="composer-btn" title="附加文件/目录到会话">${ICONS.attach}</button>
          <button id="model-trigger" class="composer-pick" title="选择模型"><span id="model-label">默认模型</span><span class="pick-caret">⌄</span></button>
          <button id="mode-trigger" class="composer-pick" title="选择模式"><span id="mode-icon" class="pick-emoji">⚡</span><span id="mode-label">Auto</span></button>
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
