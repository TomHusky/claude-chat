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
import { ChangedFile, contextWindowFor, CTX_OPEN, CTX_CLOSE, SLS_CTX_OPEN, SLS_CTX_CLOSE, FromWebview, ICONS, SlsConfig, ToWebview } from "../shared";

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
  /** Selection added while the webview was still loading — replayed as a
   *  visible chip on ready. NEVER silently attached at send time: what the
   *  composer shows must be exactly what gets sent. */
  pendingContext?: { label: string; text: string };
  pendingPrefill?: string; // prompt to prefill the composer with, once the webview is ready
  pendingPerm?: ToWebview; // permission raised while this tab was hidden/closed
  blank: boolean; // a fresh "new chat" tab with no session yet
  ready: boolean; // its webview finished loading
  /** Monotonic send counter + the seq at which Stop was last pressed. A send
   *  started at seq N is cancelled iff stopSeq >= N — a plain boolean gets
   *  clobbered when a second send races the first one's spawn await. */
  sendSeq?: number;
  stopSeq?: number;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "claude-chat.chatView";

  private view?: vscode.WebviewView;
  /** One context per open chat tab. */
  private readonly sessions = new Set<SessionCtx>();
  /** The chat tab the user most recently focused (target for global commands). */
  private activeCtx?: SessionCtx;
  private store: SessionStore;
  private slsWatching = false; // guards the ~/sls-tools/config.json file watcher (set up once)
  private lastActiveFilePath?: string; // path last posted as the active-file auto-chip (to detect its close)
  private updateAvailable?: string; // remote version when an update was detected (drives the red dot)
  private installedPending?: string; // version installed this session, awaiting a window reload to take effect
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
      // A file was closed — if it's the one currently auto-attached, re-evaluate and
      // allow clearing the auto-chip (posts the new active file, or null if none left).
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme !== "file") return;
        this.postActiveFile(doc.uri.fsPath === this.lastActiveFilePath);
      }),
    );
  }

  /** Chat tabs whose panel was closed while their reply was still streaming.
   *  Keyed by sessionId — kept alive in the background; reopening re-adopts them. */
  private readonly detached = new Map<string, SessionCtx>();

  /** Tell the webview which file is shown (for the default auto-chip). Normally
   *  never clears just because focus moved to the chat — only updates to a real
   *  file. But when `allowClear` is set (the tracked file was just CLOSED) and no
   *  file is active anymore, it posts null so the auto-chip goes away. */
  private postActiveFile(allowClear = false): void {
    if (!this.activeCtx) return;
    let p: string | undefined;
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === "file") {
      p = ed.document.uri.fsPath;
    } else {
      const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input as { uri?: vscode.Uri } | undefined;
      if (input?.uri && input.uri.scheme === "file") p = input.uri.fsPath;
    }
    if (p) {
      this.lastActiveFilePath = p;
      this.post(this.activeCtx, { kind: "active_file", path: p });
    } else if (allowClear) {
      this.lastActiveFilePath = undefined;
      this.post(this.activeCtx, { kind: "active_file", path: null });
    }
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
    this.watchSlsConfig();
  }

  /** 监听 ~/sls-tools/config.json：外部（Claude 自己写、或手动改）改动后，侧边栏表单自动刷新。 */
  private watchSlsConfig(): void {
    if (this.slsWatching) return;
    this.slsWatching = true;
    const file = path.join(this.slsDir(), "config.json");
    fs.watchFile(file, { interval: 2000 }, () => {
      this.view?.webview.postMessage({
        kind: "sls_config",
        config: this.readSlsConfig(),
        enginePresent: this.slsEngineReady(),
      } satisfies ToWebview);
    });
    this.context.subscriptions.push({ dispose: () => fs.unwatchFile(file) });
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
      this.setPanelTitle(ctx, list);
    }
  }

  /** Show a session's conversation title on its own editor tab (falls back to brand).
   *  Pass the already-computed list when available — store.list() re-reads disk. */
  private setPanelTitle(ctx: SessionCtx, list?: ReturnType<SessionStore["list"]>): void {
    const title = ctx.sessionId
      ? (list ?? this.store.list()).find((s) => s.id === ctx.sessionId)?.title
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
   *  this, the serialized tab comes back blank (no title, no content). The
   *  webview persists its sessionId via setState, so each revived tab restores
   *  its OWN conversation — and duplicates (two tabs on one session would mean
   *  two --resume processes appending to one transcript) become blank tabs. */
  async revivePanel(panel: vscode.WebviewPanel, sessionId?: string): Promise<void> {
    let sid = sessionId && this.store.findFile(sessionId) ? sessionId : undefined;
    if (sid) {
      for (const other of this.sessions) {
        if (other.sessionId === sid) {
          sid = undefined; // already open in another live tab
          break;
        }
      }
    }
    const ctx: SessionCtx = {
      panel,
      webview: panel.webview,
      sessionId: sid,
      checkpoints: new CheckpointManager(this.storageDir()),
      blank: !sid && !!sessionId, // its session is taken/gone — stay blank, don't steal LAST_SESSION_KEY
      ready: false,
    };
    if (sid) ctx.checkpoints.setSession(sid);
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
      // The user may have clicked a file editor during that window — locking
      // would then freeze THEIR group. Only lock while the panel is truly active.
      if (!panel.active) return;
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

  // -- SLS 日志配置 --------------------------------------------------------

  /** `~/sls-tools` —— 查询引擎与 config.json 的落盘位置（`sls` CLI 也读这里）。 */
  private slsDir(): string {
    return path.join(os.homedir(), "sls-tools");
  }

  /** venv 里的 python 是否已就绪（引擎能否真正发起查询）。 */
  private slsEngineReady(): boolean {
    return fs.existsSync(path.join(this.slsDir(), "venv", "bin", "python"));
  }

  /** 读取已保存的配置；文件不存在时返回空表单。 */
  private readSlsConfig(): SlsConfig {
    const empty: SlsConfig = { endpoint: "", accessKeyId: "", accessKeySecret: "", projects: { dev: "", pro: "" }, logs: {} };
    try {
      const raw = fs.readFileSync(path.join(this.slsDir(), "config.json"), "utf8");
      const j = JSON.parse(raw) as Record<string, unknown>;
      const projects = (j.projects as { dev?: string; pro?: string }) || {};
      return {
        endpoint: (j.endpoint as string) || "",
        accessKeyId: (j.accessKeyId as string) || "",
        accessKeySecret: (j.accessKeySecret as string) || "",
        projects: { dev: projects.dev || "", pro: projects.pro || "" },
        logs: (j.logs as SlsConfig["logs"]) || {},
      };
    } catch {
      return empty;
    }
  }

  /** 把 UI 配置写回 config.json，权限 600。 */
  private writeSlsConfig(cfg: SlsConfig): void {
    const out = {
      endpoint: cfg.endpoint.trim(),
      accessKeyId: cfg.accessKeyId.trim(),
      accessKeySecret: cfg.accessKeySecret.trim(),
      projects: { dev: (cfg.projects?.dev || "").trim(), pro: (cfg.projects?.pro || "").trim() },
      logs: cfg.logs || {},
    };
    const dir = this.slsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600); // 确保已存在的文件也收紧权限
  }

  /** 把扩展自带的引擎脚本铺到 ~/sls-tools（同事首次用也能一键就绪）。 */
  private provisionSlsFiles(): void {
    const dir = this.slsDir();
    fs.mkdirSync(dir, { recursive: true });
    const srcDir = path.join(this.context.extensionUri.fsPath, "sls-engine");
    for (const name of ["query.py", "sls", "requirements.txt"]) {
      const src = path.join(srcDir, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
    }
    try {
      fs.chmodSync(path.join(dir, "sls"), 0o755);
    } catch {
      /* ignore */
    }
  }

  /** 跑一条命令，收集 stdout/stderr（不抛异常，返回退出码）。 */
  private runCmd(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
      const p = spawn(cmd, args, { cwd });
      let out = "";
      let err = "";
      const timer = setTimeout(() => p.kill(), timeoutMs);
      p.stdout.on("data", (d) => (out += d.toString()));
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, out, err: err || String(e) });
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, out, err });
      });
    });
  }

  /** 确保 venv + SDK 就绪；缺失则创建并 pip 安装（较慢，调用方应包在进度里）。 */
  private async ensureSlsEngine(): Promise<void> {
    this.provisionSlsFiles();
    if (this.slsEngineReady()) return;
    const dir = this.slsDir();
    const py = this.config().get<string>("pythonPath", "") || "python3";
    const venv = await this.runCmd(py, ["-m", "venv", "venv"], dir, 120_000);
    if (venv.code !== 0) throw new Error(`创建 venv 失败（python3 是否可用？）：${venv.err || venv.out}`);
    const pip = path.join(dir, "venv", "bin", "pip");
    const install = await this.runCmd(pip, ["install", "-q", "aliyun-log-python-sdk"], dir, 300_000);
    if (install.code !== 0) throw new Error(`安装 SDK 失败：${install.err || install.out}`);
  }

  /** 用给定配置(可能未保存)逐个环境列 logstore，验证连通性。
   *  返回各环境的 logstore 数量说明，以及所有 logstore 名的并集（供 UI 生成映射模板参考）。 */
  private async slsTestConnection(cfg: SlsConfig): Promise<{ ok: boolean; message: string; stores?: string[] }> {
    for (const [k, label] of [["endpoint", "Endpoint"], ["accessKeyId", "AccessKey ID"], ["accessKeySecret", "AccessKey Secret"]] as const) {
      if (!cfg[k]?.trim()) return { ok: false, message: `请先填写 ${label}` };
    }
    const envs: { env: string; project: string }[] = [];
    if (cfg.projects?.pro?.trim()) envs.push({ env: "pro", project: cfg.projects.pro.trim() });
    if (cfg.projects?.dev?.trim()) envs.push({ env: "dev", project: cfg.projects.dev.trim() });
    if (!envs.length) return { ok: false, message: "请至少填写 dev 或 pro 的 SLS Project 名" };

    await this.ensureSlsEngine();
    const dir = this.slsDir();
    const py = path.join(dir, "venv", "bin", "python");
    const tmp = path.join(os.tmpdir(), `sls-test-${randomUUID()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({
      endpoint: cfg.endpoint.trim(),
      accessKeyId: cfg.accessKeyId.trim(),
      accessKeySecret: cfg.accessKeySecret.trim(),
      projects: { dev: cfg.projects?.dev?.trim() || "", pro: cfg.projects?.pro?.trim() || "" },
      logs: {},
    }), { mode: 0o600 });
    try {
      const lines: string[] = [];
      const union = new Set<string>();
      for (const { env, project } of envs) {
        const r = await this.runCmd(py, ["query.py", "logstores", "--config", tmp, "--project", project, "--json"], dir, 60_000);
        if (r.code !== 0) {
          return { ok: false, message: `${env}（${project}）连接失败：${(r.err || r.out || "").trim()}` };
        }
        let stores: string[] = [];
        try {
          stores = JSON.parse(r.out.trim());
        } catch {
          return { ok: false, message: `${env} 返回无法解析：${r.out.slice(0, 160)}` };
        }
        stores.forEach((s) => union.add(s));
        lines.push(`${env}（${project}）：${stores.length} 个 logstore`);
      }
      return { ok: true, message: "连接成功\n" + lines.join("\n"), stores: [...union].sort() };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  /** SLS 是否已配置到可用（有 endpoint 且有至少一个项目映射）——决定输入框是否显示开关。 */
  private slsConfigured(): boolean {
    const c = this.readSlsConfig();
    return !!(c.endpoint && Object.keys(c.logs || {}).length);
  }

  /** 若 SLS 已配置好，生成一段系统提示，告诉每个会话「有 sls 工具、怎么用、dev=测试环境」。
   *  没配 logs 就返回 ""，不干扰普通会话。 */
  private slsSystemPromptSnippet(): string {
    const cfg = this.readSlsConfig();
    const apps = Object.keys(cfg.logs || {});
    if (!cfg.endpoint || !apps.length) return "";
    const sls = "~/sls-tools/sls";
    return [
      "## 阿里云 SLS 后端日志查询",
      `你可以直接查询后端服务的线上日志：运行本机命令 \`${sls}\`（已配置好凭证，可直接用 Bash 调）。`,
      "- 环境 --env：`dev` = 测试/开发环境，`pro` = 生产/线上环境（不传默认 pro）。用户说“测试环境/开发环境”用 dev，说“线上/生产/正式”用 pro。",
      `- 业务项目 --app 可选值：${apps.join("、")}。`,
      "- 日志类型 --kind：`error`=异常/报错日志(默认)，`info`=普通日志，`both`=两者都查。",
      "- 时间 --from：默认最近 1 小时，可用 `30m`/`2h`/`1d` 或绝对时间；条数 `-n`（默认 20）。加 `--json` 得结构化输出。",
      `- 示例：查测试环境 game-server 最近 1 小时的报错 → \`${sls} -q "*" --env dev --app game-server --kind error --from 1h\`；\`${sls} apps\` 列出全部项目映射。`,
      "当用户要求查看/排查某环境某服务的日志、报错、异常、线上问题时，**主动用这个命令去查真实日志**，不要只翻本地代码或说无法获取。查询语句 -q 用 SLS 语法（如 `level: ERROR`、`* and 关键词`）。",
    ].join("\n");
  }

  /** 「让 Claude 生成映射」：打开/复用一个聊天，把扫描工作区+生成映射的 prompt 预填进输入框。 */
  private async generateSlsMapping(): Promise<void> {
    if (!this.activeCtx) await this.openSession(undefined);
    const ctx = this.activeCtx;
    if (!ctx) {
      vscode.window.showWarningMessage("请先打开一个聊天会话。");
      return;
    }
    const cfgPath = path.join(this.slsDir(), "config.json");
    const prompt = [
      "根据当前工作区的 Spring Boot 项目生成 SLS 日志映射并写入配置，请尽量快、用 Grep 批量搜，别逐个模块慢慢读文件：",
      "1. **一次 Grep 搜 `spring.application.name`**（基本都在各模块 application.yml/application.yaml），拿到所有服务名。若值是 ${xxx} 占位符，再看 pom.xml/build.gradle 的 artifactId 补全。",
      "2. **info/异常的真实 logstore 名通常写在 logback 配置里**（logback-spring.xml，及按环境分的 logback-pre.xml / logback-pro.xml 等变体）的阿里云 SLS appender 里。**一次 Grep 搜 `logstore`/`logStore`/`logStoreName`/`project`/`aliyun`**（限定 logback*.xml），拿到每个服务在各环境实际用的 logstore（区分 info/error）与 project——这是权威来源，优先于按命名规律猜。",
      "3. 各跑一次 `~/sls-tools/sls logstores --env pro` 和 `--env dev` 核对真实存在的 logstore 名（报连接错误就提示我先在侧边栏填好连接信息并保存）。",
      "4. 把每个服务名匹配到 info / error logstore：以 logback 里读到的为准，用 `sls logstores` 结果核对是否真实存在；两者对不上或某服务没找到 logback 配置的，列出来让我确认，**不要瞎猜**。",
      `5. 读取 ${cfgPath}，把映射写入其 "logs" 字段（endpoint / accessKeyId / accessKeySecret / projects 原样不动），格式 {"<app>": {"info": "<logstore>", "error": "<logstore>"}}，2 空格缩进整体写回。`,
      "6. **最后必须单独用一个 ```json 代码块**输出最终的 logs 映射对象（就是要填进文本框的那部分，最外层是 {\"<app>\": {\"info\":..., \"error\":...}}）。严格要求：只输出这一个 JSON 对象、合法可解析、2 空格缩进、不含注释/省略号/多余字段/尾逗号，方便我直接整段复制粘贴。",
      "7. 代码块之外再简要汇报：映射了哪些、哪些没匹配上需我手动补。",
    ].join("\n");
    this.reveal();
    if (ctx.ready) this.post(ctx, { kind: "prefill", text: prompt });
    else ctx.pendingPrefill = prompt;
  }

  /** 标题栏「日志配置」按钮：显示侧边栏并弹开配置抽屉，回填当前配置。 */
  showSlsConfig(): void {
    this.view?.show?.(true);
    this.view?.webview.postMessage({
      kind: "sls_open",
      config: this.readSlsConfig(),
      enginePresent: this.slsEngineReady(),
    } satisfies ToWebview);
  }

  /** slsLoad / slsSave / slsTest 的共用处理，`reply` 决定回哪个 webview。 */
  private async handleSlsMessage(m: FromWebview, reply: (e: ToWebview) => void): Promise<boolean> {
    if (m.type === "slsLoad") {
      reply({ kind: "sls_config", config: this.readSlsConfig(), enginePresent: this.slsEngineReady() });
      return true;
    }
    if (m.type === "slsTest") {
      try {
        const res = await this.slsTestConnection(m.config);
        reply({ kind: "sls_result", action: "test", ...res });
      } catch (err) {
        reply({ kind: "sls_result", action: "test", ok: false, message: String((err as Error)?.message ?? err) });
      }
      return true;
    }
    if (m.type === "slsSave") {
      try {
        this.writeSlsConfig(m.config);
        await this.ensureSlsEngine();
        reply({ kind: "sls_result", action: "save", ok: true, message: `已保存到 ${path.join(this.slsDir(), "config.json")}` });
      } catch (err) {
        reply({ kind: "sls_result", action: "save", ok: false, message: `保存或初始化失败：${String((err as Error)?.message ?? err)}` });
      }
      return true;
    }
    return false;
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
    if (ctx.ready) {
      // Webview is live — it shows the chip and owns the state from here.
      this.post(ctx, { kind: "context_added", label, text });
    } else {
      // Still loading — replay as a visible chip when it becomes ready.
      ctx.pendingContext = { label, text };
    }
    this.reveal();
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
        case "slsLoad":
        case "slsSave":
        case "slsTest":
          await this.handleSlsMessage(m, (e) => this.view?.webview.postMessage(e));
          break;
        case "slsGenerate":
          await this.generateSlsMapping();
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
            slsConfigured: this.slsConfigured(),
          });
          this.loadCtxSession(ctx);
          this.postActiveFile();
          if (ctx.pendingContext) {
            // Selection added before the webview finished loading — show it as
            // a normal removable chip now (never attach anything invisibly).
            this.post(ctx, { kind: "context_added", ...ctx.pendingContext });
            ctx.pendingContext = undefined;
          }
          if (ctx.pendingPrefill) {
            this.post(ctx, { kind: "prefill", text: ctx.pendingPrefill });
            ctx.pendingPrefill = undefined;
          }
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
          await this.handleSend(ctx, m.text, m.context, m.images, m.files, m.sls);
          break;
        case "editMessage":
          await this.editMessage(ctx, m.checkpointId, m.text, m.images);
          break;
        case "interrupt":
          ctx.pendingPerm = undefined;
          ctx.stopSeq = ctx.sendSeq ?? 0; // cancel every send already in flight (incl. mid-spawn)
          this.post(ctx, { kind: "busy", busy: false }); // instant UI feedback regardless of CLI latency
          void ctx.proc?.interrupt(); // fire-and-forget — don't block the message loop on the round-trip
          break;
        case "compact": {
          // Resume/spawn the process so it holds the full transcript, then /compact it.
          const proc = await this.ensureProcess(ctx);
          if (proc) proc.compact();
          else this.post(ctx, { kind: "busy", busy: false });
          break;
        }
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
        case "saveImage":
          await this.saveImage(m.dataUri);
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
    // Revived panel (no serialized state) — restore the last session used, or
    // fall back to blank. Never claim a session another live tab already holds:
    // two tabs on one session = two processes forking one transcript.
    let sid = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
    if (sid) {
      for (const other of this.sessions) {
        if (other !== ctx && other.sessionId === sid) {
          sid = undefined;
          break;
        }
      }
    }
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
    sls?: boolean,
  ): Promise<void> {
    // ONLY what the webview sent — a host-side fallback here once re-attached a
    // selection whose chip the user had already removed (invisible attach).
    let attached = context;
    const mySeq = (ctx.sendSeq = (ctx.sendSeq ?? 0) + 1);
    if (files && files.length) {
      const fileCtx = this.buildFileContext(files);
      attached = attached ? `${fileCtx}\n\n${attached}` : fileCtx;
    }
    // SLS 开关打开：把日志工具用法作为隐藏上下文随本条消息带上（不改系统提示，逐条生效）。
    // 用专用标记包起来，重载会话时解析器会剥掉正文、只留一个「SLS日志」chip，不整段渲染。
    if (sls) {
      const snip = this.slsSystemPromptSnippet();
      if (snip) {
        const block = `${SLS_CTX_OPEN}\n${snip}\n${SLS_CTX_CLOSE}`;
        attached = attached ? `${block}\n\n${attached}` : block;
      }
    }
    const proc = await this.ensureProcess(ctx);
    if (!proc) {
      // Spawn failed — release the composer or the tab is stuck busy forever.
      this.post(ctx, { kind: "busy", busy: false });
      return;
    }
    // The user hit Stop after this send started (e.g. while spawning) — drop it.
    if ((ctx.stopSeq ?? -1) >= mySeq) {
      this.post(ctx, { kind: "busy", busy: false });
      return;
    }
    // Record the transcript length *before* this turn so a restore point can
    // truncate the conversation back to exactly here.
    const lineBefore = ctx.sessionId ? this.store.countLines(ctx.sessionId) : 0;
    if (!proc.sendUserMessage(text, attached, images)) {
      // The process died between ensureProcess and here — never leave the UI
      // spinning on a dropped message. Clear the corpse so retry respawns.
      // Note: create the checkpoint only *after* a successful write — otherwise a
      // dropped send leaves an orphan checkpoint that shifts every restore marker.
      this.output.appendLine("[claude] send dropped: process not writable (exited mid-send)");
      if (ctx.proc === proc) ctx.proc = undefined;
      this.post(ctx, { kind: "error", message: "claude 进程已退出，本条消息未送出——请重新发送（会自动重启进程）。" });
      this.post(ctx, { kind: "busy", busy: false });
      return;
    }
    // Record the checkpoint only now that the message is actually on the wire.
    const checkpointId = ctx.checkpoints.beginTurn(text || "(图片)", lineBefore);
    this.post(ctx, { kind: "checkpoint_marker", checkpointId, userText: text });
  }

  /**
   * Edit a past user message: rewind the conversation to before that message
   * (revert files + truncate transcript), then resend the new text as the turn.
   * The webview has already trimmed its own view, so we don't reload history.
   */
  private async editMessage(
    ctx: SessionCtx,
    checkpointId: string,
    text: string,
    images?: { mediaType: string; data: string }[],
  ): Promise<void> {
    // The webview already deleted this message and everything after it. If we
    // can't actually rewind, sending anyway would leave the transcript holding
    // turns the user believes are gone (and files at Claude's latest edits).
    // Bail loudly and reload the true history instead.
    const res = checkpointId ? ctx.checkpoints.restore(checkpointId) : undefined;
    if (!res) {
      this.post(ctx, {
        kind: "error",
        message: checkpointId ? "找不到该还原点（可能已被清理），无法重新生成。" : "这条消息没有还原点，无法重新生成。",
      });
      this.post(ctx, { kind: "busy", busy: false });
      this.loadCtxSession(ctx); // restore the view we just let the webview trim
      return;
    }
    // Wait for the CLI to actually exit before rewriting the transcript —
    // a dying process can flush buffered lines AFTER our truncation,
    // resurrecting the rewound turns (and --resume would race the flush).
    const proc = ctx.proc;
    ctx.proc = undefined;
    ctx.starting = undefined;
    if (proc) await proc.disposeAndWait();
    let remaining = 0;
    if (ctx.sessionId) {
      remaining = this.store.truncateToLines(ctx.sessionId, res.truncateLine);
    }
    if (remaining === 0) {
      ctx.sessionId = undefined;
      ctx.checkpoints.clear();
    }
    this.refreshChangedFiles(ctx);
    await this.handleSend(ctx, text, undefined, images);
  }

  /** Save a chat image (data URI) to disk via the native save dialog. */
  private async saveImage(dataUri: string): Promise<void> {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(dataUri);
    if (!m) return;
    const ext = m[1] === "jpeg" ? "jpg" : m[1].replace(/[^a-z0-9]/gi, "") || "png";
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), "Downloads", `claude-image-${Date.now()}.${ext}`)),
      filters: { 图片: [ext] },
    });
    if (!uri) return;
    fs.writeFileSync(uri.fsPath, Buffer.from(m[2], "base64"));
    vscode.window.showInformationMessage(`图片已保存到 ${uri.fsPath}`);
  }

  private handlePermission(ctx: SessionCtx, requestId: string, behavior: "allow" | "deny", suggestionId?: string): void {
    if (!ctx.proc) return;
    // The chosen suggestion is echoed back raw (updatedPermissions) — the CLI
    // applies it to the session and persists it, so "总是允许" truly sticks.
    ctx.proc.respondPermission(requestId, { behavior, suggestionId });
  }

  /** Write a setting to the scope that actually WINS for `get()`. A plain
   *  Global update is silently shadowed by a Workspace/Folder value, so the
   *  picker would appear to change while every new process kept the old value. */
  private async updateConfig(key: string, value: unknown): Promise<void> {
    // These settings are window-scoped, so `inspect()` never reports a
    // workspaceFolderValue — only Workspace can shadow Global.
    const insp = this.config().inspect(key);
    const target =
      insp?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    try {
      await this.config().update(key, value, target);
    } catch (err) {
      // Don't fall back to Global: a workspace value would keep shadowing it and
      // the pick would silently not apply. Tell the user instead.
      this.output.appendLine(`[updateConfig:${key}] ${String(err)}`);
      vscode.window.showWarningMessage(`无法保存设置 claudeChat.${key}，请检查工作区设置是否只读。`);
    }
  }

  /** Every live process (all tabs + background runs) — the settings below are
   *  global, so applying them to only the current tab left other tabs on the
   *  old mode, still asking for permissions the user thought they'd disabled. */
  private allProcs(): ClaudeProcess[] {
    const out: ClaudeProcess[] = [];
    for (const c of this.sessions) if (c.proc) out.push(c.proc);
    for (const c of this.detached.values()) if (c.proc) out.push(c.proc);
    return out;
  }

  private modeSeq = 0;

  private async setPermissionMode(_ctx: SessionCtx, mode: string): Promise<void> {
    // Two quick picks race: each awaits a CLI round-trip, and the slower one's
    // broadcast used to land last and show the losing mode everywhere.
    const seq = ++this.modeSeq;
    await this.updateConfig("permissionMode", mode);
    if (seq !== this.modeSeq) return; // superseded — the later pick owns the UI
    // Keep every open picker in sync BEFORE the (possibly slow) round-trips.
    const cfg: ToWebview = {
      kind: "config",
      permissionMode: mode,
      model: this.config().get<string>("model", ""),
      effort: this.config().get<string>("effort", ""),
      slsConfigured: this.slsConfigured(),
    };
    for (const c of this.sessions) this.post(c, cfg);
    // Apply to every running process, not just this tab's.
    const results = await Promise.allSettled(this.allProcs().map((p) => p.setPermissionMode(mode)));
    if (seq !== this.modeSeq) return;
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) {
      this.post(_ctx, { kind: "error", message: `有 ${failed} 个会话未能切换到该模式，请重试或新建会话。` });
    }
  }

  private async setModel(ctx: SessionCtx, model: string): Promise<void> {
    await this.updateConfig("model", model);
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
    await this.updateConfig("effort", effort);
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
    // Detached/closed panels can't render this anyway — skip the (expensive)
    // per-file LCS diff instead of computing it for a no-op post.
    if (!this.alive(ctx)) return;
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

    // 1) Stop the live process AND wait for it to exit — a dying CLI can still
    //    flush transcript lines after our truncation, undoing the rewind.
    const proc = ctx.proc;
    ctx.proc = undefined;
    ctx.starting = undefined;
    if (proc) await proc.disposeAndWait();

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

    const skippedNote = result.skipped.length
      ? `⚠️ ${result.skipped.length} 个文件因过大或为二进制无法还原：${result.skipped.map((p) => path.basename(p)).join("、")}。`
      : "";
    this.post(ctx, {
      kind: "notice",
      message: `已还原 ${result.restoredFiles} 个文件，并把对话回退到这条消息之前。${skippedNote}下一条消息将从这里继续。`,
    });
    this.refreshChangedFiles(ctx);
  }

  // -- Process management --------------------------------------------------

  private ensureProcess(ctx: SessionCtx): Promise<ClaudeProcess | undefined> {
    // `starting` first: spawnProcess assigns ctx.proc BEFORE the initialize
    // handshake finishes, and sendUserMessage on an uninitialized proc silently
    // drops the message. Wait for the in-flight start instead.
    if (ctx.starting) return ctx.starting;
    // A dead process must never be handed to a sender — sends would be dropped
    // and the UI spins forever. Discard and respawn (with --resume) instead.
    if (ctx.proc?.isExited) {
      this.output.appendLine("[claude] discarding exited process, respawning");
      ctx.proc = undefined;
    }
    if (ctx.proc) return Promise.resolve(ctx.proc);
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
    const t0 = Date.now();
    try {
      await proc.start();
      this.output.appendLine(`[claude] spawned+initialized in ${Date.now() - t0}ms (resume=${isResume})`);
    } catch (err) {
      this.post(ctx, { kind: "error", message: `初始化 claude 失败: ${String(err)}` });
      proc.dispose(); // reap the half-started child
      ctx.proc = undefined;
      // A brand-new tab minted this sessionId but the CLI never created the
      // session. Keeping it would make every retry `--resume <ghost>` and fail
      // forever, even after the user fixes claudePath.
      if (!isResume) ctx.sessionId = undefined;
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
    // Keep a trace of anomalies in the output channel — 同事反馈"卡住"时可以看这里。
    if ((e.kind === "error" || e.kind === "notice") && (e as { message: string }).message) {
      this.output.appendLine(`[${new Date().toISOString()}] [${e.kind}] ${(e as { message: string }).message}`);
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
      } else {
        // Transient failure — don't let the throttle block retries for 90s.
        this.lastUsageAt = 0;
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
      // Async EPIPE on stdin (child died instantly) is otherwise an UNCAUGHT
      // exception that crashes the whole extension host.
      proc.stdin.on("error", () => undefined);
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
      // Collect every live process bound to this session — we must wait for
      // them to EXIT before unlinking the jsonl, or a dying CLI recreates the
      // file with its final buffered lines and the session "resurrects".
      const waits: Promise<void>[] = [];
      // Tear down any open tab for this session.
      for (const ctx of [...this.sessions]) {
        if (ctx.sessionId === id) {
          this.sessions.delete(ctx);
          if (this.activeCtx === ctx) this.activeCtx = undefined;
          if (ctx.proc) waits.push(ctx.proc.disposeAndWait());
          ctx.proc = undefined;
          ctx.panel.dispose();
        }
      }
      // Tear down any background (detached) run for this session.
      const det = this.detached.get(id);
      if (det) {
        if (det.proc) waits.push(det.proc.disposeAndWait());
        this.detached.delete(id);
      }
      if (waits.length) await Promise.all(waits);
      this.store.delete(id);
      // Also drop its persisted checkpoint snapshots — otherwise globalStorage
      // keeps full pre-edit file contents of deleted sessions forever.
      CheckpointManager.deleteFor(this.storageDir(), id);
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
      this.installedPending = undefined; // running version caught up — clear any pending-reload flag
      if (!silent) vscode.window.showInformationMessage(`已是最新版本 v${local}`);
      return;
    }
    // Newer version available.
    // Already installed this (or newer) earlier this session — it just needs a
    // window reload. Don't re-download / re-prompt (that caused an update loop),
    // and don't re-light the badge for a version that's already on disk.
    if (this.installedPending && cmpVersion(remote, this.installedPending) <= 0) {
      this.postUpdateDot();
      if (!silent) {
        const reload = await vscode.window.showInformationMessage(
          `v${remote} 已安装，需重新加载窗口后生效。`,
          "重新加载",
        );
        if (reload === "重新加载") void vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
      return;
    }
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
    this.installedPending = remote; // remember so we don't re-prompt before the reload takes effect
    this.postUpdateDot();
    const reload = await vscode.window.showInformationMessage(
      `已下载安装 v${remote}，必须重新加载窗口才会生效（在此之前仍显示旧版本，属正常现象）。`,
      "重新加载",
    );
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
    // Flush debounced snapshot writes first — a hard window close within 500ms
    // of the last file edit would otherwise lose that file's baseline.
    for (const ctx of this.sessions) ctx.checkpoints.flush();
    for (const ctx of this.detached.values()) ctx.checkpoints.flush();
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
    const EYE =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg>';
    const EYE_OFF =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 6.6a2 2 0 0 0 2.8 2.8M3 3l10 10M5.3 5.3C3 6.4 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1 0 1.9-.2 2.7-.6M9.9 4.1C9.3 3.7 8.7 3.5 8 3.5"/></svg>';

    return /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); display: flex; flex-direction: column; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; flex: 0 0 auto; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .head .ttl { font-weight: 600; opacity: .85; }
  .head .sp { flex: 1; }
  .abtn { background: none; border: none; color: var(--vscode-foreground); opacity: .8; cursor: pointer; font-size: 12px; padding: 3px 7px; border-radius: 5px; }
  .abtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.18)); opacity: 1; }
  .abtn.primary { color: var(--vscode-button-background); font-weight: 600; }
  .abtn.danger { color: var(--vscode-errorForeground, #e55); }
  .abtn.hidden { display: none; }
  .new { display: flex; align-items: center; gap: 7px; width: calc(100% - 16px); margin: 8px; padding: 7px 10px; border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); border-radius: 7px; background: none; color: var(--vscode-foreground); cursor: pointer; font-size: 12.5px; flex: 0 0 auto; }
  .new:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.16)); }
  .new svg { width: 15px; height: 15px; }
  .upd-banner { display: flex; align-items: center; gap: 7px; width: calc(100% - 16px); margin: 8px 8px 0; padding: 7px 10px; border: 1px solid #d97757; border-radius: 7px; background: rgba(217,119,87,.12); color: var(--vscode-foreground); cursor: pointer; font-size: 12.5px; flex: 0 0 auto; }
  .upd-banner:hover { background: rgba(217,119,87,.22); }
  .upd-banner.hidden { display: none; }
  .upd-banner svg { width: 15px; height: 15px; color: #d97757; }
  .upd-banner b { font-weight: 600; }
  .list { padding: 2px 6px 12px; flex: 1 1 auto; min-height: 40px; overflow-y: auto; }
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
  /* ---- SLS 日志配置（会话列表下方）---- */
  .sls-sec { border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25)); flex: 0 0 auto; display: flex; flex-direction: column; min-height: 0; background: var(--vscode-sideBar-background); }
  .sls-toggle { display: flex; align-items: center; gap: 6px; width: 100%; background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 10px 12px; font-size: 12px; font-weight: 600; opacity: .85; }
  .sls-toggle:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.14)); opacity: 1; }
  .sls-caret { display: inline-block; transition: transform .15s; font-size: 10px; opacity: .7; }
  .sls-sec.open .sls-caret { transform: rotate(90deg); }
  .sls-form { padding: 2px 12px 16px; display: flex; flex-direction: column; gap: 10px; max-height: 55vh; overflow-y: auto; }
  .sls-form.hidden { display: none; }
  .sls-f { display: flex; flex-direction: column; gap: 4px; }
  .sls-f > span { font-size: 11px; font-weight: 600; opacity: .8; }
  .sls-form input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(127,127,127,.35))); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 12px; }
  .sls-form input:focus { outline: none; border-color: var(--vscode-focusBorder, #3794ff); }
  .sls-pw { position: relative; }
  .sls-pw input { padding-right: 30px; }
  .sls-eye { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; background: none; border: none; cursor: pointer; color: var(--vscode-descriptionForeground); opacity: .75; border-radius: 4px; }
  .sls-eye:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.16)); }
  .sls-eye svg { width: 15px; height: 15px; }
  .sls-lsh { display: flex; align-items: center; justify-content: space-between; }
  .sls-lsh > span { font-size: 11px; font-weight: 600; opacity: .8; }
  .sls-mini { font-size: 11px; cursor: pointer; background: none; color: var(--vscode-button-background); border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); border-radius: 5px; padding: 2px 8px; }
  .sls-mini:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.16)); }
  .sls-rows { display: flex; flex-direction: column; gap: 6px; }
  .sls-row { display: flex; align-items: center; gap: 6px; }
  .sls-row .a { flex: 0 0 34%; }
  .sls-row .s { flex: 1; }
  .sls-row .x { flex: 0 0 auto; width: 22px; height: 26px; line-height: 1; font-size: 15px; cursor: pointer; background: none; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); border-radius: 5px; }
  .sls-row .x:hover { color: var(--vscode-errorForeground, #e55); }
  .sls-json { width: 100%; min-height: 120px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(127,127,127,.35))); border-radius: 6px; padding: 7px 8px; font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 11.5px; line-height: 1.5; }
  .sls-json:focus { outline: none; border-color: var(--vscode-focusBorder, #3794ff); }
  .sls-json.bad { border-color: var(--vscode-errorForeground, #e55); }
  .sls-lsh > span:last-child { display: inline-flex; gap: 6px; }
  .sls-sub { font-size: 10.5px; opacity: .6; line-height: 1.5; }
  .sls-sub code, .sls-hint code { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.18)); padding: 0 4px; border-radius: 3px; }
  .sls-hint { font-size: 11px; opacity: .7; line-height: 1.5; margin: 0; }
  .sls-status { font-size: 11.5px; line-height: 1.5; padding: 7px 9px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  .sls-status.hidden { display: none; }
  .sls-status.ok { background: rgba(63,185,80,.16); color: #3fb950; }
  .sls-status.err { background: rgba(229,85,85,.14); color: var(--vscode-errorForeground, #e55); }
  .sls-status.wait { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.14)); opacity: .85; }
  .sls-imp { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; opacity: .85; }
  .sls-acts { display: flex; gap: 8px; }
  .sls-btn { flex: 1; cursor: pointer; font-size: 12.5px; padding: 7px 10px; border-radius: 6px; background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.22)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); }
  .sls-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .sls-btn:hover:not(:disabled) { opacity: .9; }
  .sls-btn:disabled { opacity: .5; cursor: default; }
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

  <div id="sls-sec" class="sls-sec">
    <button id="sls-toggle" class="sls-toggle" title="配置阿里云 SLS 日志，让 Claude 直接查后端日志"><span class="sls-caret">▸</span><span>SLS 日志配置</span></button>
    <div id="sls-form" class="sls-form hidden">
      <p class="sls-hint">配置后 Claude 可直接查询阿里云 SLS 后端日志，不用再手动复制粘贴。建议用只读子账号 AccessKey，仅存本机（权限 600）。</p>
      <label class="sls-f"><span>Endpoint（地域）</span><input id="sls-endpoint" type="text" placeholder="cn-hangzhou.log.aliyuncs.com" spellcheck="false" /></label>
      <label class="sls-f"><span>AccessKey ID</span><input id="sls-ak-id" type="text" placeholder="LTAI…" spellcheck="false" autocomplete="off" /></label>
      <div class="sls-f"><span>AccessKey Secret</span>
        <div class="sls-pw"><input id="sls-ak-secret" type="password" placeholder="仅存本机" spellcheck="false" autocomplete="off" /><button id="sls-ak-eye" class="sls-eye" type="button" title="显示/隐藏"></button></div></div>
      <label class="sls-f"><span>dev 环境 SLS Project</span><input id="sls-proj-dev" type="text" placeholder="dev 的 project 名" spellcheck="false" /></label>
      <label class="sls-f"><span>pro 环境 SLS Project</span><input id="sls-proj-pro" type="text" placeholder="pro 的 project 名" spellcheck="false" /></label>
      <div class="sls-f">
        <div class="sls-lsh"><span>项目日志映射（JSON）</span>
          <span><button id="sls-tpl" class="sls-mini" title="测试连接后可根据实际 logstore 生成模板">生成模板</button>
          <button id="sls-gen" class="sls-mini" title="让 Claude 扫描工作区 Spring Boot 配置自动生成，需先填好连接信息并保存">AI 生成配置</button></span></div>
        <textarea id="sls-logs" class="sls-json" spellcheck="false" placeholder='{&#10;  "order": { "info": "order-info", "error": "order-error" },&#10;  "user":  { "info": "user-info",  "error": "user-error" }&#10;}'></textarea>
        <div class="sls-sub">每个业务项目 → info / 异常两个 logstore，dev/pro 共用此映射。查询示例：<code>sls -q "*" --env pro --app order</code>（默认查 error，加 <code>--kind info</code> 查 info）。</div>
      </div>
      <div id="sls-status" class="sls-status hidden"></div>
      <div class="sls-acts">
        <button id="sls-test" class="sls-btn">测试连接</button>
        <button id="sls-save" class="sls-btn primary">保存</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const TRASH = ${JSON.stringify(TRASH)};
    const PENCIL = ${JSON.stringify(PENCIL)};
    const EYE = ${JSON.stringify(EYE)}, EYE_OFF = ${JSON.stringify(EYE_OFF)};
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
      } else if (m && m.kind === "sls_open") {
        slsFill(m.config); slsExpand();
      } else if (m && m.kind === "sls_config") {
        slsFill(m.config);
      } else if (m && m.kind === "sls_result") {
        slsSetBusy(false);
        slsStatus(m.message, m.ok ? "ok" : "err");
        slsLastStores = (m.ok && m.action === "test" && m.stores) ? m.stores : [];
        slsShowStores(slsLastStores);
      }
    });

    // ---- SLS 日志配置 ----
    let slsBusy = false, slsLastStores = [];
    function slsFill(cfg) {
      cfg = cfg || {};
      $("sls-endpoint").value = cfg.endpoint || "";
      $("sls-ak-id").value = cfg.accessKeyId || "";
      $("sls-ak-secret").value = cfg.accessKeySecret || "";
      $("sls-ak-secret").type = "password"; $("sls-ak-eye").innerHTML = EYE; // 回填后回到隐藏态
      const proj = cfg.projects || {};
      $("sls-proj-dev").value = proj.dev || "";
      $("sls-proj-pro").value = proj.pro || "";
      const logs = cfg.logs || {};
      $("sls-logs").value = Object.keys(logs).length ? JSON.stringify(logs, null, 2) : "";
      $("sls-logs").classList.remove("bad");
      slsStatus(""); slsShowStores([]);
    }
    // 解析 JSON 文本框 -> {ok, logs, error}
    function slsParseLogs() {
      const raw = $("sls-logs").value.trim();
      if (!raw) return { ok: true, logs: {} };
      try {
        const obj = JSON.parse(raw);
        if (typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "最外层必须是对象 { 项目: {...} }" };
        return { ok: true, logs: obj };
      } catch (e) { return { ok: false, error: "JSON 格式错误：" + (e && e.message ? e.message : e) }; }
    }
    function slsCollect(logs) {
      return {
        endpoint: $("sls-endpoint").value.trim(),
        accessKeyId: $("sls-ak-id").value.trim(),
        accessKeySecret: $("sls-ak-secret").value.trim(),
        projects: { dev: $("sls-proj-dev").value.trim(), pro: $("sls-proj-pro").value.trim() },
        logs: logs || {},
      };
    }
    function slsStatus(text, kind) {
      const el = $("sls-status");
      el.textContent = text || "";
      el.className = "sls-status" + (text ? "" : " hidden") + (kind ? " " + kind : "");
    }
    function slsSetBusy(b) { slsBusy = b; $("sls-test").disabled = b; $("sls-save").disabled = b; }
    function slsExpand() { $("sls-sec").classList.add("open"); $("sls-form").classList.remove("hidden"); $("sls-sec").scrollIntoView({ block: "nearest" }); }
    // 测试成功后把拉到的 logstore 名列出来，供参考/生成模板
    function slsShowStores(stores) {
      const old = $("sls-imp"); if (old) old.remove();
      if (!stores || !stores.length) return;
      const wrap = document.createElement("div"); wrap.id = "sls-imp"; wrap.className = "sls-imp";
      const span = document.createElement("span"); span.textContent = "共 " + stores.length + " 个 logstore：" + stores.join("、");
      wrap.append(span); $("sls-status").after(wrap);
    }
    // 根据 logstore 名启发式生成 项目->{info,error} 映射模板
    function slsGuessTemplate(stores) {
      const tpl = {};
      (stores || []).forEach((s) => {
        const low = s.toLowerCase();
        let kind = null;
        if (/error|err|exception|异常/.test(low)) kind = "error";
        else if (/info|stdout|std/.test(low)) kind = "info";
        let app = s;
        if (kind) app = s.replace(/[-_.]?(error|err|exception|info|stdout|std|异常)$/i, "").replace(/[-_.]+$/, "") || s;
        if (!tpl[app]) tpl[app] = {};
        if (kind) tpl[app][kind] = s; else if (!tpl[app].info) tpl[app].info = s;
      });
      return tpl;
    }
    $("sls-toggle").addEventListener("click", () => {
      const open = $("sls-sec").classList.toggle("open");
      $("sls-form").classList.toggle("hidden", !open);
    });
    $("sls-ak-eye").innerHTML = EYE;
    $("sls-ak-eye").addEventListener("click", () => {
      const inp = $("sls-ak-secret"), show = inp.type === "password";
      inp.type = show ? "text" : "password";
      $("sls-ak-eye").innerHTML = show ? EYE_OFF : EYE;
    });
    $("sls-gen").addEventListener("click", () => {
      vscode.postMessage({ type: "slsGenerate" });
      slsStatus("已在聊天里预填生成指令，回车即可让 Claude 扫描工作区并写入映射；写完这里会自动刷新。", "wait");
    });
    $("sls-tpl").addEventListener("click", () => {
      if (!slsLastStores.length) { slsStatus("请先“测试连接”，拉到实际 logstore 后再生成模板", "wait"); return; }
      const cur = slsParseLogs();
      const base = cur.ok ? cur.logs : {};
      const tpl = slsGuessTemplate(slsLastStores);
      for (const app in tpl) base[app] = Object.assign({}, tpl[app], base[app]);
      $("sls-logs").value = JSON.stringify(base, null, 2);
      $("sls-logs").classList.remove("bad");
      slsStatus("已按 logstore 名生成映射模板，请核对 info/error 是否对应正确", "ok");
    });
    $("sls-test").addEventListener("click", () => {
      if (slsBusy) return;
      slsSetBusy(true); slsStatus("正在测试连接…（首次会自动安装查询引擎，稍等十几秒）", "wait");
      vscode.postMessage({ type: "slsTest", config: slsCollect({}) });
    });
    $("sls-save").addEventListener("click", () => {
      if (slsBusy) return;
      const r = slsParseLogs();
      if (!r.ok) { $("sls-logs").classList.add("bad"); slsStatus(r.error, "err"); return; }
      $("sls-logs").classList.remove("bad");
      slsSetBusy(true); slsStatus("正在保存…", "wait");
      vscode.postMessage({ type: "slsSave", config: slsCollect(r.logs) });
    });

    vscode.postMessage({ type: "listSessions" });
    vscode.postMessage({ type: "slsLoad" });
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
    <div id="lightbox" class="lightbox hidden">
      <div class="lightbox-actions">
        <button id="lb-copy" title="复制图片到剪贴板">${ICONS.copy} 复制</button>
        <button id="lb-save" title="保存图片到本地">${ICONS.file} 保存</button>
        <button id="lb-close" title="关闭">×</button>
      </div>
      <img id="lightbox-img" alt="预览" />
    </div>
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
          <button id="mode-trigger" class="composer-pick" title="选择模式"><span id="mode-icon" class="pick-emoji"></span><span id="mode-label"></span></button>
          <button id="sls-toggle-btn" class="composer-pick sls-toggle-btn hidden" title="打开后，本条消息会带上 SLS 日志工具用法，Claude 可直接查后端日志"><span class="sls-dot"></span><span>SLS日志</span></button>
          <span id="ctx-gauge" class="ctx-gauge hidden" title="上下文使用量"><span class="cg-ring"><span class="cg-pct"></span></span></span>
          <button id="usage-pill" class="usage-pill hidden" title="Claude 订阅用量 · 点击查看详情"></button>
          <div class="spacer"></div>
          <button id="btn-send" class="composer-send" title="发送">${ICONS.send}</button>
          <button id="btn-stop" class="composer-send stop hidden" title="停止">${ICONS.stop}</button>
        </div>
      </div>
      <div id="pick-backdrop" class="pick-backdrop hidden"></div>
      <div id="mode-menu" class="pick-menu hidden"></div>
      <div id="model-menu" class="pick-menu hidden"></div>
      <div id="usage-menu" class="pick-menu usage-menu hidden"></div>
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
function parseUsage(text: string): { sessionPct?: number; sessionReset?: string; weekPct?: number; weekReset?: string; weekSonnetPct?: number } | undefined {
  if (!text) return undefined;
  const reset = (s?: string) => s?.replace(/\s*\(.*?\)\s*$/, "").trim() || undefined; // drop "(Asia/Shanghai)"
  const sess = /Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n(]+))?/i.exec(text);
  const week = /Current week \(all models\):\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n(]+))?/i.exec(text);
  const sonnet = /Current week \(Sonnet only\):\s*(\d+)%\s*used/i.exec(text);
  if (!sess && !week) return undefined;
  return {
    sessionPct: sess ? parseInt(sess[1], 10) : undefined,
    sessionReset: reset(sess?.[2]),
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
