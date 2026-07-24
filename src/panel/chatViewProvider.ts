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
import { ChangedFile, contextWindowFor, CTX_OPEN, CTX_CLOSE, SLS_CTX_OPEN, SLS_CTX_CLOSE, FromWebview, ICONS, QQConfig, SlsConfig, ToWebview } from "../shared";
import { QQBot, QQIncoming, QQState, splitForQQ } from "../qq/bot";

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
  /** The next send is the first turn of a freshly-resumed BIG session with no
   *  warm cache — show an honest "loading context" hint instead of a dead spinner. */
  coldStart?: boolean;
  /** When this ctx last entered the background pool. Drives LRU eviction — the
   *  oldest IDLE background process is reaped first once the pool exceeds its cap. */
  lastUsedAt?: number;
  /** 本条消息写入 CLI 的时刻；首个流事件到达时用来算真实等待并记日志（然后清掉）。 */
  sendAt?: number;
  /** 看门狗：连续未回应的 ping 数。webview↔host 通道会无声半死（页面活着但消息
   *  不通，表现为永远转圈/按钮全聋），连续 3 次不回就重建 webview 自愈。 */
  missedPings?: number;
  /** 上次看门狗重建的时刻——5 分钟冷却，防止超大会话渲染慢被误判成失联后反复重建。 */
  rebuildAt?: number;
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
  // -- Prompt-cache prewarmer (big sessions) --
  private readonly prewarmStarted = new Map<string, number>(); // sessionId -> ts (dedupe in-flight)
  private readonly prewarmDone = new Map<string, number>(); // sessionId -> ts of last completed warm
  private prewarmProc?: ClaudeProcess; // at most one warm-up runs at a time (they're token-expensive)
  private keepWarmTimer?: ReturnType<typeof setInterval>; // periodic re-warm for idle open tabs
  private usageTimer?: ReturnType<typeof setInterval>; // 用量胶囊定时刷新（不然要点开菜单才更新）
  private watchdogTimer?: ReturnType<typeof setInterval>; // webview 通道半死检测 + 自愈
  private sidebarMissedPings = 0; // 侧边栏的看门狗计数（它不在 sessions 里）
  // -- QQ 开放平台机器人（远程操控，专用后台会话）--
  private qqBot?: QQBot;
  private qqProc?: ClaudeProcess; // 机器人专用的 Claude 进程（与聊天 tab 完全隔离）
  private qqSessionId?: string;
  private qqState: QQState = "offline";
  /** QQ 配置的独立 webview 面板——与侧边栏零耦合，坏也只坏它自己。 */
  private qqPanel?: vscode.WebviewPanel;
  /** 当前正在处理的 QQ 消息（收集回复用）。机器人一次只处理一条，避免串台。 */
  private qqTurn?: { target: QQIncoming; text: string; done: boolean };
  private readonly qqQueue: QQIncoming[] = [];
  /** 轮次忙标记。命令处理期间 qqTurn 为空，只靠它防止并发跑第二条。 */
  private qqRunning = false;
  /** 正在跑的预热（warmKey + 完成 promise）。发送撞上同会话的预热时等它完成再发：
   *  两个请求并发冷啃同一段大上下文会互相拖慢（实测比先焐后发慢好几倍）。 */
  private prewarmInflight?: { key: string; promise: Promise<void> };

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

    // 保温：预热只在打开会话那一刻跑一次，tab 一直开着不动的话 ~1h 后服务端缓存
    // 过期，下一条消息就变成"冷发送"（大会话实测五六十秒）。这里每 5 分钟对所有
    // 打开的 tab 补一次 maybePrewarm —— 它自带全部守卫（>1MB、50min 内焐过不重复、
    // 额度>80% 跳过、同时只跑一个），所以静息成本为零，只在快过期时才真正花钱。
    // 用量随时间流逝（5h 窗口滚动）+ 其他设备的消耗——不主动刷新的话，胶囊上的
    // 数字要等用户点开菜单才变。每 3 分钟拉一次（fetchUsage 自带 90s 节流）。
    this.usageTimer = setInterval(() => this.fetchUsage(), 3 * 60_000);

    // 看门狗：webview↔host 通道会无声半死（实锤案例：宿主 103s 完成的轮次，面板
    // 转圈到 1000s+，确认更改按钮全聋，官方插件同时正常）。每 10s ping 一次已就绪
    // 的聊天面板，连续 3 次（30s）不回 pong 就重建该面板的 webview——历史与忙碌
    // 状态由 ready→loadCtxSession 恢复，用户看到的只是界面刷了一下而不是永久卡死。
    this.watchdogTimer = setInterval(() => {
      for (const ctx of this.sessions) {
        if (!ctx.ready) continue; // 尚未加载完不算失联
        ctx.missedPings = (ctx.missedPings ?? 0) + 1;
        if ((ctx.missedPings ?? 0) > 3) {
          ctx.missedPings = 0;
          // 5 分钟冷却：超大会话首次渲染可能合法地阻塞主线程较久，别反复重建打转。
          if (Date.now() - (ctx.rebuildAt ?? 0) < 5 * 60_000) {
            this.output.appendLine(`[${new Date().toISOString()}] [watchdog] 面板仍未响应，但 5min 内已重建过，跳过`);
            continue;
          }
          ctx.rebuildAt = Date.now();
          this.output.appendLine(
            `[${new Date().toISOString()}] [watchdog] 面板 ${ctx.sessionId?.slice(0, 8) ?? "新会话"} 通道无响应 30s，重建 webview`,
          );
          ctx.ready = false;
          try {
            ctx.panel.webview.html = this.html(ctx.panel.webview); // 强制整页重载，ready 后自动恢复
          } catch (err) {
            this.output.appendLine(`[watchdog] 重建失败: ${String(err)}`);
          }
          continue;
        }
        this.post(ctx, { kind: "ping", id: Date.now() });
      }
      // 侧边栏同款（昨天的"全灭"案例正是侧边栏通道死了）。只在可见时检测——
      // 隐藏的侧边栏收不到 ping 属正常，不能误判重建。
      if (this.view?.visible) {
        this.sidebarMissedPings++;
        if (this.sidebarMissedPings > 3) {
          this.output.appendLine(`[${new Date().toISOString()}] [watchdog] 侧边栏通道无响应 30s，重建 webview`);
          this.sidebarMissedPings = 0;
          try {
            this.view.webview.html = this.sidebarHtml(this.view.webview);
          } catch (err) {
            this.output.appendLine(`[watchdog] 侧边栏重建失败: ${String(err)}`);
          }
        } else {
          this.view.webview.postMessage({ kind: "ping", id: Date.now() } satisfies ToWebview);
        }
      } else {
        this.sidebarMissedPings = 0;
      }
    }, 10_000);

    this.keepWarmTimer = setInterval(() => {
      // 有会话正在回复时避让：预热是全量上下文的大请求，跟真实对话抢并发可能
      // 触发 API 限流重试，反而拖慢用户正在等的那条。下个 tick 再补不迟。
      for (const ctx of this.sessions) if (ctx.proc?.isBusy) return;
      for (const ctx of this.detached.values()) if (ctx.proc?.isBusy) return;
      if (this.activeCtx) this.maybePrewarm(this.activeCtx); // 活跃 tab 优先
      for (const ctx of this.sessions) if (ctx !== this.activeCtx) this.maybePrewarm(ctx);
    }, 5 * 60_000);
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

  /** 工作区外拖入（Finder 等）：webview 拿不到绝对路径，把读出的内容镜像写到扩展
   *  存储目录，再按普通绝对路径附加——后续 buildFileContext / Read 工具都照常工作。
   *  顺手清理 7 天前的旧镜像，防止 globalStorage 无限膨胀。 */
  private importDropped(
    ctx: SessionCtx,
    roots: { name: string; isDir: boolean }[],
    files: { rel: string; base64: string }[],
    skipped?: number,
  ): void {
    const base = path.join(this.storageDir(), "dropped");
    try {
      for (const d of fs.readdirSync(base)) {
        const ts = Number(d);
        if (Number.isFinite(ts) && Date.now() - ts > 7 * 24 * 3600_000) {
          fs.rmSync(path.join(base, d), { recursive: true, force: true });
        }
      }
    } catch {
      /* base 不存在等 —— 忽略 */
    }
    // 去掉 ".."、盘符、前导斜杠，防止 rel 逃出镜像目录。
    const safe = (rel: string) =>
      rel
        .split(/[\\/]+/)
        .filter((s) => s && s !== ".." && s !== ".")
        .join(path.sep);
    const dir = path.join(base, String(Date.now()));
    for (const f of files) {
      const rel = safe(f.rel);
      if (!rel) continue;
      try {
        const dest = path.join(dir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(f.base64, "base64"));
      } catch (err) {
        this.output.appendLine(`[dropped] 写入失败 ${f.rel}: ${String(err)}`);
      }
    }
    const paths: string[] = [];
    for (const r of roots) {
      const rel = safe(r.name);
      if (!rel) continue;
      const p = path.join(dir, rel);
      try {
        if (r.isDir) fs.mkdirSync(p, { recursive: true }); // 空目录也保留
      } catch {
        /* ignore */
      }
      if (fs.existsSync(p)) paths.push(p);
    }
    if (skipped) {
      this.output.appendLine(`[dropped] 跳过 ${skipped} 个文件（超出单文件 10MB / 总量 30MB / 300 个上限）`);
    }
    this.output.appendLine(`[dropped] 镜像 ${files.length} 个文件到 ${dir}`);
    if (paths.length) this.post(ctx, { kind: "attach_files", paths });
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
    // QQ 机器人是纯宿主侧功能（界面在独立面板，与侧边栏零耦合）。上次开着就自动
    // 续上；任何失败只记日志，绝不影响侧边栏/聊天主链路。
    try {
      if (this.qqStored().enabled && !this.qqBot) {
        void this.startQQBot().catch((e) => this.output.appendLine(`[qq] 自动启动失败: ${String(e)}`));
      }
    } catch (e) {
      this.output.appendLine(`[qq] 初始化异常(已隔离): ${String(e)}`);
    }
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
    this.output.appendLine(`[${new Date().toISOString()}] [open] ${sessionId ? sessionId.slice(0, 8) : "新会话"}`);
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

  /** A chat tab was closed. 有限常驻：只要它已经有一个活进程(不管在不在忙)，就把
   *  进程转后台保活并把 ctx 存进 detached，重开时秒级复用（上下文还在进程内存里，
   *  省掉 --resume 全量重读）。超过后台上限就按 LRU 回收空闲的。空白 tab / 进程已死
   *  没什么可复用的，直接清理。 */
  private onPanelClosed(ctx: SessionCtx): void {
    this.sessions.delete(ctx);
    if (this.activeCtx === ctx) this.activeCtx = undefined;
    if (ctx.proc && !ctx.proc.isExited && ctx.sessionId) {
      ctx.lastUsedAt = Date.now();
      this.detached.set(ctx.sessionId, ctx);
      this.trimBackground(); // 超上限就砍掉最久未用的空闲后台进程
    } else {
      ctx.proc?.dispose();
      ctx.proc = undefined;
      ctx.starting = undefined;
    }
    this.broadcastRunning();
    this.refreshSessions();
  }

  /** 后台常驻进程上限：超了按最久未用(LRU)回收，防止一堆闲置进程堆积吃内存。 */
  private static readonly MAX_BACKGROUND = 5;

  /** Reap idle background processes once the pool exceeds its cap, oldest first.
   *  NEVER touches a busy one — it's actively streaming a reply that closing the
   *  tab kept alive; killing it would silently drop that turn. Busy procs still
   *  count toward the cap (they cost memory too), they're just not eligible to
   *  be evicted, so the cap is soft while several background replies run. */
  private trimBackground(): void {
    let overflow = this.detached.size - ChatViewProvider.MAX_BACKGROUND;
    if (overflow <= 0) return;
    const idle = [...this.detached.values()]
      .filter((c) => c.proc && !c.proc.isBusy && c.sessionId)
      .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
    for (const c of idle) {
      if (overflow <= 0) break;
      c.checkpoints.flush(); // 落盘防丢 baseline，跟 dispose() 一致
      c.proc?.dispose();
      c.proc = undefined;
      this.detached.delete(c.sessionId!);
      overflow--;
      this.output.appendLine(`[claude] LRU 回收后台进程 ${c.sessionId!.slice(0, 8)}（后台剩 ${this.detached.size}）`);
    }
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

  /** 把 j.projects 归一化成「环境名 -> project 字符串」的映射，只保留字符串值。 */
  private normalizeProjects(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (raw && typeof raw === "object") {
      for (const [env, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "string" && env.trim()) out[env.trim()] = v;
      }
    }
    return out;
  }

  /** 读取已保存的配置；文件不存在时返回空表单（种子 dev/pro 两个空环境）。 */
  private readSlsConfig(): SlsConfig {
    const seed = (): Record<string, string> => ({ dev: "", pro: "" });
    try {
      const raw = fs.readFileSync(path.join(this.slsDir(), "config.json"), "utf8");
      const j = JSON.parse(raw) as Record<string, unknown>;
      const projects = this.normalizeProjects(j.projects);
      return {
        endpoint: (j.endpoint as string) || "",
        accessKeyId: (j.accessKeyId as string) || "",
        accessKeySecret: (j.accessKeySecret as string) || "",
        // 完全没有任何环境时，回填 dev/pro 两个空行方便填写。
        projects: Object.keys(projects).length ? projects : seed(),
        logs: (j.logs as SlsConfig["logs"]) || {},
      };
    } catch {
      return { endpoint: "", accessKeyId: "", accessKeySecret: "", projects: seed(), logs: {} };
    }
  }

  /** 把 UI 配置写回 config.json，权限 600。环境名/Project 都去空白，丢掉环境名为空的行。 */
  private writeSlsConfig(cfg: SlsConfig): void {
    const projects: Record<string, string> = {};
    for (const [env, proj] of Object.entries(cfg.projects || {})) {
      const name = (env || "").trim();
      if (name) projects[name] = (proj || "").trim();
    }
    const out = {
      endpoint: cfg.endpoint.trim(),
      accessKeyId: cfg.accessKeyId.trim(),
      accessKeySecret: cfg.accessKeySecret.trim(),
      projects,
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
    // pro 优先测（更常用），其余环境按填写顺序；空 Project 的环境跳过。
    const entries = Object.entries(cfg.projects || {})
      .map(([env, project]) => ({ env: env.trim(), project: (project || "").trim() }))
      .filter((e) => e.env && e.project);
    const envs = entries.sort((a, b) => (a.env === "pro" ? -1 : b.env === "pro" ? 1 : 0));
    if (!envs.length) return { ok: false, message: "请至少给一个环境填写 SLS Project 名" };

    await this.ensureSlsEngine();
    const dir = this.slsDir();
    const py = path.join(dir, "venv", "bin", "python");
    const tmp = path.join(os.tmpdir(), `sls-test-${randomUUID()}.json`);
    const projSnapshot: Record<string, string> = {};
    for (const { env, project } of envs) projSnapshot[env] = project;
    fs.writeFileSync(tmp, JSON.stringify({
      endpoint: cfg.endpoint.trim(),
      accessKeyId: cfg.accessKeyId.trim(),
      accessKeySecret: cfg.accessKeySecret.trim(),
      projects: projSnapshot,
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
    // 环境说明按实际配置动态生成：dev/pro 给出「测试/生产」语义，其余自定义环境
    // 原样列出让模型按名字理解。默认环境优先取 pro，没有 pro 就取第一个。
    const envNames = Object.entries(cfg.projects || {}).filter(([, p]) => (p || "").trim()).map(([e]) => e.trim());
    const defEnv = envNames.includes("pro") ? "pro" : (envNames[0] || "pro");
    const hint = (e: string) => (e === "dev" ? "（测试/开发环境）" : e === "pro" ? "（生产/线上环境）" : "");
    const envLine = envNames.length
      ? `- 环境 --env 可选值：${envNames.map((e) => `\`${e}\`${hint(e)}`).join("、")}；不传默认 \`${defEnv}\`。用户说“测试环境/开发环境”用 \`dev\`，说“线上/生产/正式”用 \`pro\`。`
      : "- 环境 --env：`dev` = 测试/开发环境，`pro` = 生产/线上环境（不传默认 pro）。";
    return [
      "## 阿里云 SLS 后端日志查询",
      `你可以直接查询后端服务的线上日志：运行本机命令 \`${sls}\`（已配置好凭证，可直接用 Bash 调）。`,
      envLine,
      `- 业务项目 --app 可选值：${apps.join("、")}。`,
      "- 日志类型 --kind：`error`=异常/报错日志(默认)，`info`=普通日志，`both`=两者都查。",
      "- 时间 --from：默认最近 1 小时，可用 `30m`/`2h`/`1d` 或绝对时间；条数 `-n`（默认 20）。加 `--json` 得结构化输出。",
      `- 示例：查 ${defEnv} 环境 game-server 最近 1 小时的报错 → \`${sls} -q "*" --env ${defEnv} --app game-server --kind error --from 1h\`；\`${sls} apps\` 列出全部项目映射。`,
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
    this.sidebarMissedPings = 0; // 任何消息都证明通道活着
    try {
      switch (m.type) {
        case "pong":
          break; // 心跳，无需处理（上面已归零计数）
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
        case "webviewError":
          this.output.appendLine(`[${new Date().toISOString()}] [webview] 侧边栏脚本错误: ${m.message}`);
          break;
      }
    } catch (err) {
      this.output.appendLine(`[onSidebarMessage:${m.type}] ${String(err)}`);
    }
  }

  /** Messages from a chat panel — every message is scoped to that panel's ctx. */
  private async onPanelMessage(ctx: SessionCtx, m: FromWebview): Promise<void> {
    ctx.missedPings = 0; // 任何消息都证明通道活着
    try {
      switch (m.type) {
        case "pong":
          break; // 心跳，无需处理
        case "dismissRateLimit": {
          // 记到 resetsAt（秒→毫秒）；事件没带就兜底 6 小时，别永久闭嘴。
          const until = m.resetsAt ? m.resetsAt * 1000 : Date.now() + 6 * 3600_000;
          const map = { ...this.context.globalState.get<Record<string, number>>("claudeChat.rateLimitDismissed") };
          map[m.limitLabel] = until;
          await this.context.globalState.update("claudeChat.rateLimitDismissed", map);
          this.output.appendLine(`[${new Date().toISOString()}] [ratelimit] 「${m.limitLabel}」警告已关闭至 ${new Date(until).toLocaleString()}`);
          break;
        }
        case "webviewError":
          this.output.appendLine(`[${new Date().toISOString()}] [webview] 聊天面板脚本错误: ${m.message}`);
          break;
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
        case "newContext":
          await this.newContext(ctx, m);
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
        case "importDropped":
          this.importDropped(ctx, m.roots, m.files, m.skipped);
          break;
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
    // 打开会话就后台起进程 + --resume：把本地重读上下文的耗时提前，跟用户读历史/打字重叠，
    // 而不是全压在按下发送那一刻（这是"发消息才卡十几秒"的主因之一）。
    this.maybePrespawn(ctx);
    // 大会话且缓存已凉：趁用户读历史/打字的空档，后台把服务端 prompt cache 焐热。
    this.maybePrewarm(ctx);
    if (ctx.proc?.isBusy) {
      this.post(ctx, { kind: "busy", busy: true });
      // Replay an unanswered prompt; keep it stashed in case the tab closes again
      // before it's answered. It's cleared only when the user actually responds.
      if (ctx.pendingPerm) this.post(ctx, ctx.pendingPerm);
    }
    this.refreshSessions();
    this.refreshChangedFiles(ctx);
  }

  /** `/clear`：在同一个 tab 里换一段全新的上下文。旧会话不删除（仍在列表里可翻），
   *  只是这个 tab 从此与它脱钩：进程杀掉、sessionId 清空，下次发送会 mint 新 id
   *  且不带 --resume，模型因此完全看不到之前的历史。 */
  private async newContext(
    ctx: SessionCtx,
    m: { text?: string; context?: string; images?: { mediaType: string; data: string }[]; files?: string[]; sls?: boolean },
  ): Promise<void> {
    const old = ctx.sessionId;
    ctx.proc?.dispose();
    ctx.proc = undefined;
    ctx.starting = undefined;
    ctx.sessionId = undefined;
    ctx.blank = true;
    ctx.coldStart = false;
    ctx.pendingPerm = undefined;
    ctx.sendAt = undefined;
    // 新上下文配新的检查点账本——旧会话的还原点不该落到新对话头上。
    ctx.checkpoints.flush();
    ctx.checkpoints = new CheckpointManager(this.storageDir());
    this.output.appendLine(`[${new Date().toISOString()}] [clear] ${old?.slice(0, 8) ?? "空"} → 新上下文`);
    this.post(ctx, { kind: "load_history", items: [], title: "新对话", checkpoints: [] });
    this.refreshChangedFiles(ctx);
    this.refreshSessions();
    if (m.text || m.images?.length) {
      await this.handleSend(ctx, m.text ?? "", m.context, m.images, m.files, m.sls);
    }
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
    // 本会话的预热正在跑：等它焐完再发（上限 45s 兜底）。实测两个请求并发冷啃
    // 同一段大上下文会互相拖慢（比先焐后发慢好几倍）；等到缓存写完那一刻立即
    // 发出，等价于"手动等 10 秒再发"，但事件驱动、小会话零等待。
    const inflight = this.prewarmInflight;
    if (inflight && ctx.sessionId && inflight.key === this.warmKey(ctx.sessionId)) {
      const t0 = Date.now();
      await Promise.race([inflight.promise, new Promise<void>((r) => setTimeout(r, 45_000))]);
      this.output.appendLine(`[prewarm] 发送等待预热 ${Date.now() - t0}ms 后放行`);
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
    ctx.sendAt = Date.now(); // 埋点：首个流事件到达时计算真实等待时长
    this.output.appendLine(
      `[${new Date().toISOString()}] [send] session=${ctx.sessionId?.slice(0, 8)} 正文${text.length}字 附加${attached?.length ?? 0}字 图片${images?.length ?? 0}`,
    );
    // Record the checkpoint only now that the message is actually on the wire.
    const checkpointId = ctx.checkpoints.beginTurn(text || "(图片)", lineBefore);
    this.post(ctx, { kind: "checkpoint_marker", checkpointId, userText: text });
    // 冷启动的第一轮：底部状态栏给一行安静的提示（首个流事件到达即清除）。
    // 不往聊天里塞通知 —— 与官方一致，界面保持干净。
    if (ctx.coldStart) {
      ctx.coldStart = false;
      if (this.cacheCold(ctx.sessionId ?? "")) {
        this.post(ctx, { kind: "status", label: "正在读取会话上下文…大会话首次响应较慢" });
      }
    }
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
    // Hot-swap on every live process via the control channel — NOT a restart.
    // Disposing here forced the next message to respawn + `--resume` the whole
    // transcript (seconds of dead spinner on large sessions); `set_model` keeps
    // the warm process alive and applies on the next turn, like the official ext.
    // updateConfig already persisted it, so any future respawn still uses it.
    const results = await Promise.allSettled(this.allProcs().map((p) => p.setModel(model)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) {
      this.post(ctx, { kind: "error", message: `有 ${failed} 个会话未能切换模型，请重试或新建会话。` });
    }
    // Prompt cache 按模型隔离：切到新模型后这个会话的缓存必然是冷的，趁着
    // 用户还没发消息先焐热，避免下一条撞上 1~2 分钟的静默读取。
    this.maybePrewarm(ctx);
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
      // 恢复的大会话且缓存冷：第一轮会等很久，标记好在发送时给出诚实提示。
      ctx.coldStart = isResume && this.cacheCold(sessionId);
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

  // -- Prompt-cache prewarmer ----------------------------------------------
  // 大会话的痛点：服务端 prompt cache 过期(1h)后，第一轮要全量重读上下文
  // (实测 11MB 会话冷启动 ~37s，热缓存 ~6s)。打开大会话时后台用
  // `--fork-session --no-session-persistence` 发一轮微型请求：发送的前缀
  // (系统提示+历史)与真实会话完全一致，把缓存焐热；fork+不落盘保证绝不碰
  // 用户的真实 transcript。官方插件都没做这个。

  private static readonly PREWARM_MIN_SIZE = 1_000_000; // <1MB 的会话冷启动本来就不慢
  private static readonly PREWARM_FRESH_MS = 50 * 60_000; // 缓存 TTL 1h，提前 10min 视为过期
  private static readonly PREWARM_RETRY_MS = 10 * 60_000; // 失败/未完成的预热最少隔 10min 再试
  private static readonly PREWARM_MAX_IDLE_MS = 3 * 24 * 3600_000; // 超过 3 天未活动的会话不预热（多半是翻旧账）

  private transcriptSize(sid: string): number {
    const f = this.store.findFile(sid);
    if (!f) return 0;
    try {
      return fs.statSync(f).size;
    } catch {
      return 0;
    }
  }

  /** 缓存按 (会话, 模型) 记录 —— prompt cache 是按模型隔离的，切模型后同一
   *  会话的缓存对新模型而言是冷的。 */
  private warmKey(sid: string): string {
    return `${sid}|${this.config().get<string>("model", "") || "default"}`;
  }

  /** 这个会话当前是否大且缓存大概率是冷的（驱动预热与冷启动提示）。 */
  private cacheCold(sid: string): boolean {
    if (this.transcriptSize(sid) < ChatViewProvider.PREWARM_MIN_SIZE) return false;
    const done = this.prewarmDone.get(this.warmKey(sid)) ?? 0;
    return Date.now() - done >= ChatViewProvider.PREWARM_FRESH_MS;
  }

  /** 会话打开即后台预启动真实进程并 --resume，让本地重读上下文的开销与用户读历史/打字
   *  重叠，而不是全压在按下发送那一刻。fire-and-forget：ensureProcess 自带 starting/复用
   *  去重，重复调用安全；真正起不来（如 claudePath 配错）时 spawnProcess 会自行报错。 */
  private maybePrespawn(ctx: SessionCtx): void {
    if (!this.config().get<boolean>("prespawnOnOpen", true)) return;
    if (!ctx.sessionId) return;        // 新会话无需 resume，首启动本来就快
    if (ctx.proc || ctx.starting) return; // 已有活进程 / 正在启动
    void this.ensureProcess(ctx);
  }

  /** Best-effort：失败静默（顶多损失一次预热），绝不打扰正常使用。 */
  private maybePrewarm(ctx: SessionCtx): void {
    if (!this.config().get<boolean>("prewarmCache", true)) return;
    const sid = ctx.sessionId;
    if (!sid || !this.cacheCold(sid)) return;
    if (ctx.proc?.isBusy) return; // 正在跑的真实轮次本身就在焐缓存
    if (this.prewarmProc) return; // 同时只跑一个，预热是要花 token 的
    // 超过 3 天没动过的会话大概率是翻旧账（查资料），不是要续聊 —— 不花这笔预热
    // token。真续聊了，第一轮回复会刷新 transcript 的 mtime，之后保温恢复正常。
    {
      const f = this.store.findFile(sid);
      try {
        if (f && Date.now() - fs.statSync(f).mtimeMs > ChatViewProvider.PREWARM_MAX_IDLE_MS) {
          this.output.appendLine(`[prewarm] ${sid.slice(0, 8)} skipped: 会话超过 3 天未活动`);
          return;
        }
      } catch {
        /* stat 失败不拦截 */
      }
    }
    // 5小时额度快用完时不再预热 —— 把剩余额度留给真实对话。
    const pct = (this.lastUsage as { sessionPct?: number } | undefined)?.sessionPct;
    if (pct !== undefined && pct >= 80) {
      this.output.appendLine(`[prewarm] skipped: 5h usage at ${pct}%`);
      return;
    }
    const key = this.warmKey(sid);
    const started = this.prewarmStarted.get(key) ?? 0;
    if (Date.now() - started < ChatViewProvider.PREWARM_RETRY_MS) return;
    this.prewarmStarted.set(key, Date.now());

    const t0 = Date.now();
    let done = false;
    // 完成信号：让撞上预热的真实发送可以等到"焐好那一刻"立即发出（见 handleSend）。
    let signalDone: () => void = () => undefined;
    const inflight = { key, promise: new Promise<void>((r) => (signalDone = r)) };
    this.prewarmInflight = inflight;
    const cleanup = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ok) this.prewarmDone.set(key, Date.now());
      this.output.appendLine(`[prewarm] ${sid.slice(0, 8)} ${ok ? "warmed" : "aborted"} in ${Date.now() - t0}ms`);
      if (this.prewarmProc === proc) this.prewarmProc = undefined;
      if (this.prewarmInflight === inflight) this.prewarmInflight = undefined;
      signalDone(); // 无论成败都放行等待中的发送 —— 失败就按原来的冷发送走
      proc.dispose();
    };
    // 系统提示/历史前缀必须与 spawnProcess 完全一致 —— 缓存按前缀精确匹配。
    // effort 是请求级参数、不进缓存前缀，预热用 low 省 token（不用思考半天）。
    const proc = new ClaudeProcess(
      {
        claudePath: this.config().get<string>("claudePath", "claude"),
        cwd: this.cwd(),
        model: this.config().get<string>("model", "") || undefined,
        effort: "low",
        permissionMode: this.config().get<string>("permissionMode", "default"),
        resumeSessionId: sid,
        forkNoPersist: true,
        maxTurns: 1, // 一轮即停：即使模型想调工具也不会执行
        addDirs: this.workspaceDirs(),
        appendSystemPrompt: this.config().get<string>("appendSystemPrompt", "") || undefined,
      },
      {
        emit: (e) => {
          if (e.kind === "result") cleanup(!e.isError);
        },
        onPermission: (req) => proc.respondPermission(req.requestId, { behavior: "deny", message: "预热请求，无需工具。" }),
        onSessionId: () => undefined, // fork 出的新 id 与任何 tab 无关
        onClose: () => cleanup(false),
      },
    );
    this.prewarmProc = proc;
    const timer = setTimeout(() => cleanup(false), 180_000); // 硬上限 3min
    this.output.appendLine(`[prewarm] ${sid.slice(0, 8)} start (${Math.round(this.transcriptSize(sid) / 1024)}KB)`);
    void proc
      .start()
      .then(() => {
        if (!proc.sendUserMessage("这是一条缓存预热消息：请只回复“ok”两个字母，不要调用任何工具。")) cleanup(false);
      })
      .catch(() => cleanup(false));
  }

  // -- QQ 开放平台机器人 ----------------------------------------------------
  // 远程操控：QQ 消息 -> 专用后台 ClaudeProcess -> 回复发回 QQ。刻意不复用
  // SessionCtx（它强依赖 panel），这样完全不干扰用户在 VS Code 里开的 tab；
  // 这个会话是真实 transcript，仍会出现在侧边栏列表里可点开查看。

  private static readonly QQ_STATE_KEY = "claudeChat.qq";
  private static readonly QQ_SECRET_KEY = "claudeChat.qq.appSecret";
  private static readonly QQ_SESSION_KEY = "claudeChat.qq.sessionId";

  /** 「QQ 机器人」独立配置面板：自己的 HTML、脚本和消息通道，完全不碰侧边栏。 */
  showQQConfig(): void {
    if (this.qqPanel) {
      this.qqPanel.reveal();
      void this.postQQConfig();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "claude-chat.qq",
      "QQ 机器人",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.qqPanel = panel;
    panel.webview.html = this.qqHtml();
    panel.webview.onDidReceiveMessage(async (m: FromWebview) => {
      try {
        switch (m.type) {
          case "webviewError":
            this.output.appendLine(`[${new Date().toISOString()}] [webview] QQ面板脚本错误: ${m.message}`);
            break;
          case "qqLoad":
            await this.postQQConfig();
            break;
          case "qqSave":
            await this.saveQQConfig(m.config);
            break;
          case "qqToggle":
            await this.toggleQQBot(m.enabled);
            break;
        }
      } catch (err) {
        this.output.appendLine(`[qq] 面板消息处理失败(${m.type}): ${String(err)}`);
      }
    });
    panel.onDidDispose(() => {
      if (this.qqPanel === panel) this.qqPanel = undefined;
    });
  }

  private qqHtml(): string {
    const nonce = randomUUID().replace(/-/g, "");
    return /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; display: flex; justify-content: center; }
  .wrap { width: 100%; max-width: 560px; padding: 24px 20px 40px; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; }
  h2 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .45; }
  .dot.connecting { background: #e0a33e; opacity: 1; }
  .dot.online { background: #3fb950; opacity: 1; }
  .warn { font-size: 11.5px; line-height: 1.7; padding: 9px 11px; border-radius: 6px;
    background: var(--vscode-inputValidation-warningBackground, rgba(224,163,62,.14));
    border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(224,163,62,.5)); }
  label.f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
  label.f > span { font-weight: 600; opacity: .85; }
  input[type=text], input[type=password], textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,.35)); border-radius: 6px; padding: 7px 9px; font: inherit; font-size: 12.5px; }
  input:focus, textarea:focus { outline: none; border-color: var(--vscode-focusBorder, #3794ff); }
  textarea { min-height: 72px; resize: none; font-family: var(--vscode-editor-font-family, monospace); }
  .check { display: flex; align-items: center; gap: 7px; font-size: 12px; cursor: pointer; }
  .status { font-size: 12px; line-height: 1.6; padding: 7px 10px; border-radius: 6px; white-space: pre-wrap; word-break: break-all;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12)); }
  .status.hidden { display: none; }
  .status.ok { color: #3fb950; }
  .status.err { color: var(--vscode-errorForeground, #e5534b); }
  .acts { display: flex; gap: 10px; }
  button.btn { flex: 1; padding: 7px 0; font: inherit; font-size: 12.5px; cursor: pointer; border-radius: 6px;
    border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); background: none; color: var(--vscode-foreground); }
  button.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  button.btn:hover { filter: brightness(1.1); }
  .mini { font-size: 11.5px; cursor: pointer; background: none; color: var(--vscode-button-background); border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); border-radius: 5px; padding: 2px 9px; }
  .sub { font-size: 11px; opacity: .65; line-height: 1.7; }
</style>
</head>
<body>
<div class="wrap">
  <h2><span id="dot" class="dot"></span>QQ 机器人 · 远程操控 Claude</h2>
  <div class="warn">⚠ 开启后，白名单内的 QQ 用户可通过消息驱动 Claude <b>读写本机代码、执行命令</b>（远程无法逐条确认，工具请求会自动放行）。白名单是唯一安全边界，务必只填你自己的 openid。</div>
  <label class="f"><span>AppID</span><input id="appid" type="text" placeholder="q.qq.com 机器人管理端获取" spellcheck="false" /></label>
  <label class="f"><span>AppSecret</span><input id="secret" type="password" placeholder="仅存本机（加密）" spellcheck="false" autocomplete="off" /></label>
  <label class="f"><span>白名单 openid（每行一个）</span><textarea id="allowed" spellcheck="false" placeholder="先开启并给机器人发一条消息，机器人会把你的 openid 回给你（这里也会弹出一键填入按钮）"></textarea></label>
  <label class="check"><input id="sandbox" type="checkbox" /><span>使用沙箱环境（q.qq.com 的沙箱配置）</span></label>
  <div id="status" class="status hidden"></div>
  <div class="acts">
    <button id="save" class="btn">保存</button>
    <button id="power" class="btn primary">开启机器人</button>
  </div>
  <div class="sub">私聊需你先主动给机器人发消息；群里需 @机器人。消息走独立的后台会话（在侧边栏列表可见），不影响你打开的聊天 tab。机器人会话的权限模式见设置 claudeChat.qqBotPermissionMode。</div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.addEventListener("error", (e) => {
    try { vscode.postMessage({ type: "webviewError", message: (e.message || "?") + " @qq:" + e.lineno }); } catch {}
  });
  window.addEventListener("unhandledrejection", (e) => {
    try { vscode.postMessage({ type: "webviewError", message: "unhandledrejection@qq: " + String(e.reason).slice(0, 300) }); } catch {}
  });
  const $ = (id) => document.getElementById(id);
  let enabled = false;
  function status(text, kind) {
    const el = $("status");
    el.textContent = text || "";
    el.className = "status" + (text ? "" : " hidden") + (kind ? " " + kind : "");
  }
  function fill(cfg, hasSecret) {
    $("appid").value = cfg.appId || "";
    $("allowed").value = cfg.allowed || "";
    $("sandbox").checked = !!cfg.sandbox;
    enabled = !!cfg.enabled;
    $("secret").value = "";
    $("secret").placeholder = hasSecret ? "已保存（留空则不修改）" : "仅存本机（加密）";
    $("power").textContent = enabled ? "停止机器人" : "开启机器人";
  }
  function setDot(state, detail) {
    $("dot").className = "dot " + state;
    if (state === "online") status("机器人已上线，可在 QQ 私聊或群里 @ 它", "ok");
    else if (state === "connecting") status("正在连接…");
    else if (detail) status("已断开：" + detail, "err");
  }
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.kind === "ping") { vscode.postMessage({ type: "pong", id: m.id }); return; }
    if (m.kind === "qq_config") fill(m.config, m.hasSecret);
    else if (m.kind === "qq_state") setDot(m.state, m.detail);
    else if (m.kind === "qq_result") status(m.message, m.ok ? "ok" : "err");
    else if (m.kind === "qq_pairing") {
      const box = $("allowed");
      if (box.value.split(/[\\s,，;；]+/).some((s) => s.trim() === m.openId)) return;
      const el = $("status");
      el.className = "status";
      el.textContent = "捕获到 openid：" + m.openId + " ";
      const btn = document.createElement("button");
      btn.className = "mini";
      btn.textContent = "填入白名单并保存";
      btn.onclick = () => {
        box.value = (box.value.trim() ? box.value.trim() + "\\n" : "") + m.openId;
        $("save").click();
      };
      el.appendChild(btn);
    }
  });
  $("save").addEventListener("click", () => {
    vscode.postMessage({ type: "qqSave", config: {
      appId: $("appid").value.trim(),
      appSecret: $("secret").value,
      allowed: $("allowed").value,
      sandbox: $("sandbox").checked,
      enabled,
    } });
  });
  $("power").addEventListener("click", () => {
    enabled = !enabled;
    $("power").textContent = enabled ? "停止机器人" : "开启机器人";
    vscode.postMessage({ type: "qqToggle", enabled });
  });
  vscode.postMessage({ type: "qqLoad" });
</script>
</body>
</html>`;
  }

  /** 非敏感配置存 globalState，AppSecret 存 SecretStorage（加密，不落明文）。 */
  private qqStored(): Omit<QQConfig, "appSecret"> {
    const d = this.context.globalState.get<Omit<QQConfig, "appSecret">>(ChatViewProvider.QQ_STATE_KEY);
    return { appId: d?.appId ?? "", allowed: d?.allowed ?? "", sandbox: !!d?.sandbox, enabled: !!d?.enabled };
  }

  private async postQQConfig(target?: vscode.Webview): Promise<void> {
    const secret = await this.context.secrets.get(ChatViewProvider.QQ_SECRET_KEY);
    const e: ToWebview = {
      kind: "qq_config",
      config: { ...this.qqStored(), appSecret: "" }, // 永不回传明文密钥
      hasSecret: !!secret,
    };
    (target ?? this.qqPanel?.webview)?.postMessage(e);
    (target ?? this.qqPanel?.webview)?.postMessage({ kind: "qq_state", state: this.qqState } satisfies ToWebview);
  }

  private setQQState(state: QQState, detail?: string): void {
    this.qqState = state;
    try {
      this.qqPanel?.webview.postMessage({ kind: "qq_state", state, detail } satisfies ToWebview);
    } catch { /* 面板可能正在销毁 */ }
  }

  private async saveQQConfig(cfg: QQConfig): Promise<void> {
    await this.context.globalState.update(ChatViewProvider.QQ_STATE_KEY, {
      appId: cfg.appId.trim(),
      allowed: cfg.allowed.trim(),
      sandbox: !!cfg.sandbox,
      enabled: this.qqStored().enabled, // 开关由 qqToggle 单独管理
    });
    // 空字符串表示"保持原密钥不变"（界面从不回填明文，用户不改就不该被清空）。
    if (cfg.appSecret.trim()) {
      await this.context.secrets.store(ChatViewProvider.QQ_SECRET_KEY, cfg.appSecret.trim());
    }
    this.qqPanel?.webview.postMessage({ kind: "qq_result", ok: true, message: "已保存" } satisfies ToWebview);
    if (this.qqStored().enabled) await this.startQQBot(); // 已开启则用新配置重连
  }

  private async toggleQQBot(enabled: boolean): Promise<void> {
    await this.context.globalState.update(ChatViewProvider.QQ_STATE_KEY, { ...this.qqStored(), enabled });
    if (enabled) await this.startQQBot();
    else this.stopQQBot();
  }

  private async startQQBot(): Promise<void> {
    this.stopQQBot(); // 重连前先拆掉旧连接
    const cfg = this.qqStored();
    const secret = (await this.context.secrets.get(ChatViewProvider.QQ_SECRET_KEY)) ?? "";
    const allowed = cfg.allowed.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
    if (!cfg.appId || !secret) {
      this.setQQState("offline", "缺少 AppID / AppSecret");
      this.qqPanel?.webview.postMessage({ kind: "qq_result", ok: false, message: "请先填写 AppID 和 AppSecret 并保存" } satisfies ToWebview);
      return;
    }
    // 白名单为空不再拒绝启动——openid 只能从消息事件里拿到，必须先能连上、
    // 让用户发一条消息完成"配对"。此时机器人只回 openid，不执行任何指令。
    if (!allowed.length) {
      this.qqPanel?.webview.postMessage({
        kind: "qq_result",
        ok: true,
        message: "配对模式：白名单为空，机器人只会回你的 openid、不执行指令。请在 QQ 里给它发一条消息。",
      } satisfies ToWebview);
    }
    this.qqBot = new QQBot(
      { appId: cfg.appId, appSecret: secret, sandbox: cfg.sandbox, allowedOpenIds: allowed },
      {
        onLog: (line) => this.output.appendLine(`[${new Date().toISOString()}] ${line}`),
        onState: (state, detail) => this.setQQState(state, detail),
        onMessage: (msg) => this.onQQMessage(msg),
        onPairing: (openId) => {
          try {
            this.qqPanel?.webview.postMessage({ kind: "qq_pairing", openId } satisfies ToWebview);
          } catch { /* 面板未开——openid 也会通过 QQ 回复和输出日志给到用户 */ }
        },
      },
    );
    void this.qqBot.start();
  }

  private stopQQBot(): void {
    this.qqBot?.stop();
    this.qqBot = undefined;
    this.qqProc?.dispose();
    this.qqProc = undefined;
    this.qqTurn = undefined;
    this.qqRunning = false; // 不重置的话重启后队列永远不再被消费
    this.qqQueue.length = 0;
    this.setQQState("offline");
  }

  /** 排队处理——机器人一次只跑一轮，避免多条消息串到同一个进程里互相打断。 */
  private onQQMessage(msg: QQIncoming): void {
    this.qqQueue.push(msg);
    if (!this.qqRunning) void this.runQQTurn();
  }

  private async runQQTurn(): Promise<void> {
    if (this.qqRunning) return; // 命令处理期间 qqTurn 是空的，得靠独立的忙标记防并发
    const msg = this.qqQueue.shift();
    if (!msg) return;
    this.qqRunning = true;
    // 命令优先：本地处理、不花模型 token。返回 true = 已消费。
    try {
      if (await this.handleQQCommand(msg)) {
        this.qqBot?.forget(msg.msgId);
        this.qqRunning = false;
        if (this.qqQueue.length) void this.runQQTurn();
        return;
      }
    } catch (err) {
      this.output.appendLine(`[qq] 命令处理失败: ${String(err)}`);
      await this.qqBot?.reply(msg, `❌ 命令执行出错\n${String((err as Error)?.message ?? err)}`);
      this.qqRunning = false;
      if (this.qqQueue.length) void this.runQQTurn();
      return;
    }
    this.qqTurn = { target: msg, text: "", done: false };
    const proc = await this.ensureQQProcess();
    if (!proc) {
      await this.qqBot?.reply(msg, "❌ 启动 Claude 失败\n请在 VS Code 输出面板查看 Claude Chat 日志");
      this.finishQQTurn();
      return;
    }
    if (!proc.sendUserMessage(msg.text)) {
      this.qqProc = undefined; // 进程已死，下条消息会重建
      await this.qqBot?.reply(msg, "❌ Claude 进程已退出，请重试");
      this.finishQQTurn();
    }
  }

  private finishQQTurn(): void {
    const t = this.qqTurn;
    this.qqTurn = undefined;
    this.qqRunning = false;
    if (t) this.qqBot?.forget(t.target.msgId);
    if (this.qqQueue.length) void this.runQQTurn();
  }

  // -- QQ 机器人命令 --------------------------------------------------------
  // 手机上没有界面可点，所有配置只能靠文字命令。未知的 / 命令原样透传给 Claude
  // （CLI 自己的 skills 不能被吃掉）。

  private static readonly QQ_RUNTIME_KEY = "claudeChat.qq.runtime";
  /** 机器人专属的模型/强度覆盖——刻意不改全局设置，免得手机上一句话把你桌面的配置也换了。 */
  private qqRuntime(): { model?: string; effort?: string } {
    return this.context.globalState.get<{ model?: string; effort?: string }>(ChatViewProvider.QQ_RUNTIME_KEY) ?? {};
  }

  private static readonly QQ_MODELS = ["默认", "opus", "sonnet", "haiku", "fable"];
  private static readonly QQ_EFFORTS = ["低", "low", "medium", "high", "xhigh", "max"];

  /** QQ 是纯文本消息（不渲染 Markdown），排版只能靠分隔线 / emoji / 方块进度条。 */
  private static readonly QQ_HR = "━━━━━━━━━━━━━";

  /** 10 格方块进度条，用量一眼可见；≥90% 变红灯提示。
   *  非零用量至少点亮 1 格——否则 4% 会显示成全空，看着像根本没用。 */
  private static qqBar(pct: number): string {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    const filled = p > 0 ? Math.max(1, Math.round(p / 10)) : 0;
    const light = p >= 90 ? "🔴" : p >= 70 ? "🟡" : "🟢";
    return `${light} ${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${p}%`;
  }

  /** 把 CLI 的英文重置串（"Jul 27 at 2am" / "Jul 20 at 12:10pm"）转成中文。 */
  private static qqCnReset(raw: string): string {
    const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const m = /([A-Za-z]{3,})\s+(\d{1,2})(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(raw);
    if (!m) return raw;
    const mon = MON[m[1].slice(0, 3).toLowerCase()];
    if (!mon) return raw;
    let hh = m[3] != null ? parseInt(m[3], 10) : undefined;
    const mm = m[4] != null ? m[4] : "00";
    const ap = (m[5] || "").toLowerCase();
    if (hh != null) {
      if (ap === "pm" && hh < 12) hh += 12;
      if (ap === "am" && hh === 12) hh = 0;
    }
    const date = `${mon}月${parseInt(m[2], 10)}日`;
    return hh != null ? `${date} ${String(hh).padStart(2, "0")}:${mm}` : date;
  }

  /** 重置时间的展示串：优先用精确时间戳，否则解析 CLI 的英文串。 */
  private static qqResetText(at?: number, raw?: string): string {
    if (typeof at === "number" && Number.isFinite(at)) {
      const d = new Date(at);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm} 重置`;
    }
    return raw ? `${ChatViewProvider.qqCnReset(raw)} 重置` : "";
  }

  private qqHelpText(): string {
    const hr = ChatViewProvider.QQ_HR;
    return [
      "🤖 Claude 机器人 · 命令",
      hr,
      "📝 对话",
      "· /clear [消息]  清空上下文重新开始",
      "· /compact  压缩上下文，保留要点",
      "· /stop  中断当前回复",
      "",
      "⚙️ 设置",
      "· /model [名称]  opus / sonnet / haiku / fable",
      "· /effort [档位]  low / medium / high / xhigh / max",
      "",
      "📊 信息",
      "· /status  当前状态",
      "· /usage  用量查询",
      "· /help  本帮助",
      hr,
      "💡 不带参数可查看当前值；其它 / 命令会原样交给 Claude Code",
    ].join("\n");
  }

  private qqUsageText(): string {
    const u = this.lastUsage as
      | {
          sessionPct?: number;
          sessionResetAt?: number;
          sessionReset?: string;
          weekPct?: number;
          weekReset?: string;
          weekModelPct?: number;
          weekModelName?: string;
        }
      | undefined;
    if (!u || (u.sessionPct === undefined && u.weekPct === undefined)) {
      return "📊 订阅用量\n" + ChatViewProvider.QQ_HR + "\n⚠️ 暂时取不到用量数据，请稍后再试";
    }
    const block = (title: string, pct?: number, reset?: string) => {
      if (pct === undefined) return "";
      return [title, ChatViewProvider.qqBar(pct), reset ? `   ⏱ ${reset}` : ""].filter(Boolean).join("\n");
    };
    const parts = [
      block("⏳ 5 小时限额", u.sessionPct, ChatViewProvider.qqResetText(u.sessionResetAt, u.sessionReset)),
      block("📅 每周 · 全部模型", u.weekPct, ChatViewProvider.qqResetText(undefined, u.weekReset)),
      block(`🎯 每周 · 仅 ${u.weekModelName || "特定模型"}`, u.weekModelPct),
    ].filter(Boolean);
    return "📊 订阅用量\n" + ChatViewProvider.QQ_HR + "\n" + parts.join("\n\n");
  }

  /** 处理机器人命令。返回 true = 已消费（不再交给 Claude）。
   *  `/clear 消息` 会先清空再把 msg.text 改写成剩余内容并返回 false，让它走正常轮次。 */
  private async handleQQCommand(msg: QQIncoming): Promise<boolean> {
    const t = msg.text.trim();
    if (!t.startsWith("/")) return false;
    const sp = t.search(/\s/);
    const cmd = (sp === -1 ? t : t.slice(0, sp)).toLowerCase();
    const arg = sp === -1 ? "" : t.slice(sp + 1).trim();
    const reply = (s: string) => this.qqBot?.reply(msg, s) ?? Promise.resolve();
    const rt = this.qqRuntime();

    switch (cmd) {
      case "/help":
        await reply(this.qqHelpText());
        return true;

      case "/status": {
        const busy = this.qqProc?.isBusy;
        await reply(
          [
            "📊 机器人状态",
            ChatViewProvider.QQ_HR,
            `🧠 模型　　${rt.model || this.config().get<string>("model", "") || "默认"}`,
            `⚡ 强度　　${rt.effort || this.config().get<string>("effort", "") || "默认"}`,
            `🔐 权限　　${this.config().get<string>("qqBotPermissionMode", "acceptEdits")}`,
            `💬 会话　　${this.qqSessionId ? this.qqSessionId.slice(0, 8) : "尚未创建"}`,
            `${busy ? "🔵" : "🟢"} 状态　　${busy ? "正在回复中" : "空闲"}`,
            `📥 排队　　${this.qqQueue.length} 条`,
          ].join("\n"),
        );
        return true;
      }

      case "/usage":
        this.fetchUsage(true);
        // 等一小会儿拿最新值（拿不到就报缓存/提示稍后）。
        for (let i = 0; i < 24 && !this.lastUsage; i++) await new Promise((r) => setTimeout(r, 500));
        await reply(this.qqUsageText());
        return true;

      case "/stop":
        if (this.qqProc?.isBusy) {
          await this.qqProc.interrupt();
          const dropped = this.qqQueue.length;
          this.qqQueue.length = 0;
          // 被中断的那轮不会再有 result 事件 → finishQQTurn 永远不会被调用。
          // 必须在这里手动收尾，否则 qqRunning 卡死、机器人从此不再响应任何消息。
          if (this.qqTurn) {
            this.qqBot?.forget(this.qqTurn.target.msgId);
            this.qqTurn = undefined;
          }
          this.qqRunning = false;
          await reply(dropped ? `⏹ 已中断当前回复\n并清空了 ${dropped} 条排队消息` : "⏹ 已中断当前回复");
        } else {
          await reply("💤 当前没有正在跑的回复");
        }
        return true;

      case "/model": {
        if (!arg) {
          await reply(`🧠 当前模型：${rt.model || this.config().get<string>("model", "") || "默认"}\n${ChatViewProvider.QQ_HR}\n可选：${ChatViewProvider.QQ_MODELS.join(" / ")}\n用法：/model opus`);
          return true;
        }
        const v = /^(默认|default)$/i.test(arg) ? "" : arg.toLowerCase();
        if (v && !ChatViewProvider.QQ_MODELS.includes(v)) {
          await reply(`❌ 未知模型「${arg}」\n可选：${ChatViewProvider.QQ_MODELS.join(" / ")}`);
          return true;
        }
        await this.context.globalState.update(ChatViewProvider.QQ_RUNTIME_KEY, { ...rt, model: v });
        // 进程活着就热切（控制通道），不用重启、不丢上下文。
        try {
          if (this.qqProc && !this.qqProc.isExited) await this.qqProc.setModel(v);
        } catch {
          this.qqProc?.dispose();
          this.qqProc = undefined; // 热切失败就让下轮重建
        }
        await reply(`✅ 已切换模型：${v || "默认"}`);
        return true;
      }

      case "/effort": {
        if (!arg) {
          await reply(`⚡ 当前强度：${rt.effort || this.config().get<string>("effort", "") || "默认"}\n${ChatViewProvider.QQ_HR}\n可选：low / medium / high / xhigh / max / 默认\n用法：/effort high`);
          return true;
        }
        const v = /^(默认|default)$/i.test(arg) ? "" : arg.toLowerCase();
        if (v && !ChatViewProvider.QQ_EFFORTS.includes(v)) {
          await reply(`❌ 未知强度「${arg}」\n可选：low / medium / high / xhigh / max / 默认`);
          return true;
        }
        await this.context.globalState.update(ChatViewProvider.QQ_RUNTIME_KEY, { ...rt, effort: v });
        // effort 是启动参数，只能重建进程（会话仍会 --resume 回来，不丢历史）。
        this.qqProc?.dispose();
        this.qqProc = undefined;
        await reply(`✅ 已切换思考强度：${v || "默认"}\n（下一条消息生效）`);
        return true;
      }

      case "/compact": {
        const proc = await this.ensureQQProcess();
        if (!proc) {
          await reply("❌ 启动 Claude 失败，无法压缩");
          return true;
        }
        proc.compact();
        await reply("🗜 正在压缩上下文，稍后可继续对话");
        return true;
      }

      case "/clear": {
        this.qqProc?.dispose();
        this.qqProc = undefined;
        this.qqSessionId = undefined;
        await this.context.globalState.update(ChatViewProvider.QQ_SESSION_KEY, undefined);
        this.output.appendLine(`[${new Date().toISOString()}] [qq] /clear 已重置机器人会话`);
        if (arg) {
          // 清空后把剩余内容当普通消息走正常轮次（用全新上下文回答）。
          msg.text = arg;
          await reply("🧹 已清空上下文，正在用全新上下文回答…");
          return false;
        }
        await reply("🧹 已清空上下文\n之后的对话不会带上之前的历史");
        return true;
      }
    }
    return false; // 未知 / 命令：交给 Claude（它的 skills 不能被吞掉）
  }

  /** 机器人专用进程。权限模式取配置；工具请求自动放行——远程没有弹窗可确认，
   *  不放行就会永久卡住（所以白名单是这套东西唯一的安全边界）。 */
  private async ensureQQProcess(): Promise<ClaudeProcess | undefined> {
    if (this.qqProc && !this.qqProc.isExited) return this.qqProc;
    const stored = this.context.globalState.get<string>(ChatViewProvider.QQ_SESSION_KEY);
    const resume = stored && this.store.findFile(stored) ? stored : undefined;
    const sid = resume ?? randomUUID();
    this.qqSessionId = sid;
    const proc = new ClaudeProcess(
      {
        claudePath: this.config().get<string>("claudePath", "claude"),
        cwd: this.cwd(),
        // 机器人专属覆盖优先（/model、/effort 命令设的），没有才回落到全局设置。
        model: this.qqRuntime().model ?? this.config().get<string>("model", "") ?? undefined,
        effort: this.qqRuntime().effort ?? this.config().get<string>("effort", "") ?? undefined,
        permissionMode: this.config().get<string>("qqBotPermissionMode", "acceptEdits"),
        resumeSessionId: resume,
        sessionId: resume ? undefined : sid,
        addDirs: this.workspaceDirs(),
        appendSystemPrompt: this.config().get<string>("appendSystemPrompt", "") || undefined,
      },
      {
        emit: (e) => this.onQQEmit(e),
        onPermission: (req) => proc.respondPermission(req.requestId, { behavior: "allow" }),
        onSessionId: (id) => {
          this.qqSessionId = id;
          void this.context.globalState.update(ChatViewProvider.QQ_SESSION_KEY, id);
          this.refreshSessions();
        },
        onClose: () => {
          if (this.qqProc === proc) this.qqProc = undefined;
          // 进程中途死掉不会发 result → 本轮永远收不了尾，qqRunning 会卡死导致
          // 机器人此后不再响应任何消息。这里兜底告知用户并放行队列。
          const t = this.qqTurn;
          if (t && !t.done) {
            t.done = true;
            this.output.appendLine(`[qq] 进程退出，本轮未完成：${t.target.msgId}`);
            void (async () => {
              const partial = t.text.trim();
              await this.qqBot?.reply(
                t.target,
                partial ? `⚠️ 回复中断（进程退出），已生成部分内容：\n${splitForQQ(partial)[0]}` : "⚠️ Claude 进程意外退出，请重新发送",
              );
              this.finishQQTurn();
            })();
          }
        },
      },
    );
    this.qqProc = proc;
    try {
      await proc.start();
      this.output.appendLine(`[qq] Claude 进程就绪 session=${sid.slice(0, 8)}`);
      return proc;
    } catch (err) {
      this.output.appendLine(`[qq] Claude 启动失败：${String(err)}`);
      proc.dispose();
      this.qqProc = undefined;
      return undefined;
    }
  }

  /** 收集这一轮的助手文本，轮次结束时整段回给 QQ。
   *  进程事件可能在宿主关闭途中到达——整个处理体自兜底，绝不外抛。 */
  private onQQEmit(e: ToWebview): void {
    try {
      this.onQQEmitInner(e);
    } catch {
      /* isolated */
    }
  }

  private onQQEmitInner(e: ToWebview): void {
    const t = this.qqTurn;
    if (!t) return;
    if (e.kind === "text_delta") t.text += e.text;
    else if (e.kind === "error") this.output.appendLine(`[qq] ${e.message}`);
    else if (e.kind === "result") {
      if (t.done) return;
      t.done = true;
      const parts = splitForQQ(t.text || "（本轮没有文本输出）");
      void (async () => {
        for (const p of parts) await this.qqBot?.reply(t.target, p);
        this.output.appendLine(`[qq] 已回复 ${parts.length} 段，共 ${t.text.length} 字`);
        this.finishQQTurn();
      })();
    }
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
    // 用量"警告"横幅被用户关过的话，本重置周期内不再弹（每个新进程都会重报一次，
    // 不在这拦就永远关不干净）。exhausted 是阻断性的，永远放行。
    if (e.kind === "rate_limit" && e.level === "warning") {
      const until = this.context.globalState.get<Record<string, number>>("claudeChat.rateLimitDismissed")?.[e.limitLabel] ?? 0;
      if (Date.now() < until) {
        this.output.appendLine(`[${new Date().toISOString()}] [ratelimit] 「${e.limitLabel}」警告已被关闭，跳过（至 ${new Date(until).toLocaleString()}）`);
        return;
      }
    }
    // 纯诊断事件：只进日志，绝不进界面（用户明确要求界面保持干净）。
    if (e.kind === "diag") {
      this.output.appendLine(`[${new Date().toISOString()}] [diag] session=${ctx.sessionId?.slice(0, 8)} ${e.message}`);
      return;
    }
    // Keep a trace of anomalies in the output channel — 同事反馈"卡住"时可以看这里。
    if ((e.kind === "error" || e.kind === "notice") && (e as { message: string }).message) {
      this.output.appendLine(`[${new Date().toISOString()}] [${e.kind}] ${(e as { message: string }).message}`);
    }
    // status 事件很少（compacting 等 CLI 阶段提示）——全记下来，排查"莫名卡住"用。
    if (e.kind === "status" && e.label) {
      this.output.appendLine(`[${new Date().toISOString()}] [status] ${e.label}`);
    }
    // 埋点：本条消息发出后第一个流事件到达 = 用户真实等待的时长。偏大时结合上面
    // 的 [status] 行（API 重试）与 [prewarm] 行就能定位卡在哪一段。
    if (
      ctx.sendAt &&
      (e.kind === "block_start" || e.kind === "text_delta" || e.kind === "thinking_delta" || e.kind === "context" || e.kind === "tokens")
    ) {
      this.output.appendLine(
        `[${new Date().toISOString()}] [ttfb] session=${ctx.sessionId?.slice(0, 8)} 首个流事件延迟 ${Date.now() - ctx.sendAt}ms`,
      );
      ctx.sendAt = undefined;
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
      ctx.sendAt = undefined; // 秒错的轮次没有流事件——别把时间戳漏进下一轮的测量
      this.output.appendLine(
        `[${new Date().toISOString()}] [turn] session=${ctx.sessionId?.slice(0, 8)} 完成 ${e.durationMs}ms 轮次${e.numTurns}${e.isError ? " (出错)" : ""}`,
      );
      this.refreshSessions();
      this.fetchUsage(); // throttled — subscription usage moved after this turn
      // 一轮真实对话本身就把缓存焐热了 —— 记下来，别再浪费 token 去预热。
      if (ctx.sessionId) this.prewarmDone.set(this.warmKey(ctx.sessionId), Date.now());
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
   * Query the Claude subscription usage (5h session + weekly + per-model weekly)
   * by running the CLI's `/usage` slash command headlessly and parsing its text.
   * 只走官方 CLI，不直调内部接口（第三方挪用 OAuth token 有账号风险）。
   * 按模型的周限额行（如 Fable）需要 CLI ≥2.1.2xx 才会输出。
   * Throttled so it doesn't itself burn quota on every turn.
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
    this.sweepResurrected(ids);
  }

  /** 删除后的"防复活"复查：垂死的 CLI（本窗口 3s 兜底没等到的、其他 VS Code 窗口
   *  常驻着同一会话的、官方插件的）可能在 unlink 之后 flush 缓冲，把 jsonl 又写回
   *  来——列表里就"删不掉"。删完在 4s/12s 各复查一次，复活就再删。 */
  private sweepResurrected(ids: string[]): void {
    for (const delay of [4_000, 12_000]) {
      setTimeout(() => {
        let revived = 0;
        for (const id of ids) {
          if (this.store.findFile(id)) {
            this.store.delete(id);
            revived++;
            this.output.appendLine(`[${new Date().toISOString()}] [delete] 会话 ${id.slice(0, 8)} 被残留进程复活，已再次删除`);
          }
        }
        if (revived) this.refreshSessions();
      }, delay);
    }
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
    if (this.keepWarmTimer) clearInterval(this.keepWarmTimer);
    this.keepWarmTimer = undefined;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = undefined;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
    this.stopQQBot(); // 关窗口就断开机器人，不留孤儿进程/连接
    this.qqPanel?.dispose();
    this.qqPanel = undefined;
    // Flush debounced snapshot writes first — a hard window close within 500ms
    // of the last file edit would otherwise lose that file's baseline.
    for (const ctx of this.sessions) ctx.checkpoints.flush();
    for (const ctx of this.detached.values()) ctx.checkpoints.flush();
    for (const ctx of this.sessions) ctx.proc?.dispose();
    for (const ctx of this.detached.values()) ctx.proc?.dispose();
    this.prewarmProc?.dispose();
    this.prewarmProc = undefined;
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
  /* 用系统内置滚动条；resize:none 去掉右下角那个丑陋的缩放手柄方块。 */
  .sls-json { width: 100%; min-height: 120px; resize: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(127,127,127,.35))); border-radius: 6px; padding: 7px 8px; font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 11.5px; line-height: 1.5; }
  .sls-json:focus { outline: none; border-color: var(--vscode-focusBorder, #3794ff); }
  .sls-json.bad { border-color: var(--vscode-errorForeground, #e55); }
  /* 可增删的环境行：[环境名][Project 名][删除] */
  .sls-envs { display: flex; flex-direction: column; gap: 6px; }
  .sls-env-row { display: flex; align-items: center; gap: 6px; }
  .sls-env-row .env { flex: 0 0 33%; min-width: 0; }
  .sls-env-row .proj { flex: 1 1 auto; min-width: 0; }
  .sls-env-row .del { flex: 0 0 auto; width: 26px; height: 30px; line-height: 1; font-size: 15px; cursor: pointer;
    display: flex; align-items: center; justify-content: center; padding: 0; background: none;
    color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(127,127,127,.35))); border-radius: 6px; }
  .sls-env-row .del:hover { color: var(--vscode-errorForeground, #e55); border-color: var(--vscode-errorForeground, #e55); }
  /* 查看态：只读、隐藏删除按钮、视觉弱化，一眼能看出不可编辑。 */
  .sls-envs.view .sls-env-row .del { display: none; }
  .sls-envs.view .sls-env-row input { cursor: default; opacity: .7; border-style: dashed; background: transparent; }
  /* 编辑态末尾的「新增环境」按钮：整行虚线框。 */
  .sls-env-add-btn { width: 100%; padding: 6px; margin-top: 2px; font: inherit; font-size: 12px; cursor: pointer;
    background: none; color: var(--vscode-descriptionForeground);
    border: 1px dashed var(--vscode-input-border, var(--vscode-panel-border, rgba(127,127,127,.4))); border-radius: 6px; }
  .sls-env-add-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder, #3794ff); }
  /* 头部小按钮进入「保存」态时高亮成主按钮色。 */
  .sls-mini.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .sls-mini.primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
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
      <div class="sls-f">
        <div class="sls-lsh"><span>环境 SLS Project</span>
          <span><button id="sls-env-edit" class="sls-mini" type="button" title="编辑环境（增删 / 改名）">编辑环境</button></span></div>
        <div id="sls-envs" class="sls-envs view"></div>
        <div class="sls-sub"><code>dev</code>=测试/开发、<code>pro</code>=生产/线上；也可自定义环境名。点“编辑环境”增删，改完点“保存”一起提交，留空的行自动忽略。</div>
      </div>
      <div class="sls-f">
        <div class="sls-lsh"><span>项目日志映射（JSON）</span>
          <span><button id="sls-tpl" class="sls-mini" title="测试连接后可根据实际 logstore 生成模板">生成模板</button>
          <button id="sls-gen" class="sls-mini" title="让 Claude 扫描工作区 Spring Boot 配置自动生成，需先填好连接信息并保存">AI 生成配置</button></span></div>
        <textarea id="sls-logs" class="sls-json" spellcheck="false" placeholder='{&#10;  "order": { "info": "order-info", "error": "order-error" },&#10;  "user":  { "info": "user-info",  "error": "user-error" }&#10;}'></textarea>
        <div class="sls-sub">每个业务项目 → info / 异常两个 logstore，各环境共用此映射。查询示例：<code>sls -q "*" --env pro --app order</code>（默认查 error，加 <code>--kind info</code> 查 info）。</div>
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
    // 侧边栏脚本一旦抛错整个面板就会"点了没反应"且无迹可循——错误上报给 host 记日志。
    window.addEventListener("error", (e) => {
      try { vscode.postMessage({ type: "webviewError", message: (e.message || "?") + " @sidebar:" + e.lineno }); } catch {}
    });
    window.addEventListener("unhandledrejection", (e) => {
      try { vscode.postMessage({ type: "webviewError", message: "unhandledrejection@sidebar: " + String(e.reason).slice(0, 300) }); } catch {}
    });
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
    function exitMulti() {
      multi = false;
      document.body.classList.remove("multi");
      $("multi").textContent = "多选";
      sel.clear();
      $("delsel").classList.add("hidden");
      render();
    }
    $("multi").addEventListener("click", () => {
      if (multi) { exitMulti(); return; }
      multi = true; document.body.classList.add("multi");
      $("multi").textContent = "取消";
      render();
    });
    $("delsel").addEventListener("click", () => confirmDel([...sel]));
    $("upd-banner").addEventListener("click", () => vscode.postMessage({ type: "checkUpdate" }));

    window.addEventListener("message", (ev) => {
      const m = ev.data;
      if (m && m.kind === "ping") { vscode.postMessage({ type: "pong", id: m.id }); return; }
      if (m && m.kind === "sessions") {
        sessions = m.list || []; activeId = m.activeId || null;
        if (m.runningIds !== undefined) runningIds = new Set(m.runningIds || []);
        const hadSel = sel.size > 0;
        for (const id of [...sel]) if (!sessions.find((s) => s.id === id)) sel.delete(id);
        // 批量删除完成的信号：之前选中的会话全部从列表消失 → 自动退出多选。
        // （宿主弹窗点了取消时 sel 原样保留，不会误退。）
        if (multi && hadSel && sel.size === 0) { exitMulti(); return; }
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
    let slsBusy = false, slsLastStores = [], slsEnvEditing = false;
    // 已提交的环境数据（数组保留顺序，允许编辑时出现空行）。查看态从这里渲染。
    let slsEnvEntries = [];
    // 造一行 [环境名][Project 名][删除]；readonly 由当前是否编辑态决定。
    function slsMakeEnvRow(env, project) {
      const row = document.createElement("div");
      row.className = "sls-env-row";
      const envIn = document.createElement("input");
      envIn.type = "text"; envIn.className = "env"; envIn.placeholder = "环境名"; envIn.spellcheck = false;
      envIn.value = env || ""; envIn.readOnly = !slsEnvEditing;
      const projIn = document.createElement("input");
      projIn.type = "text"; projIn.className = "proj"; projIn.placeholder = "SLS Project 名"; projIn.spellcheck = false;
      projIn.value = project || ""; projIn.readOnly = !slsEnvEditing;
      const del = document.createElement("button");
      del.type = "button"; del.className = "del"; del.title = "删除此环境"; del.textContent = "×";
      del.addEventListener("click", () => row.remove());
      row.append(envIn, projIn, del);
      return row;
    }
    // 按当前 slsEnvEditing 重绘环境区：查看态只读弱化、无新增；编辑态可改可删 + 末尾「新增环境」。
    function slsRenderEnvs() {
      const box = $("sls-envs");
      box.innerHTML = "";
      box.classList.toggle("view", !slsEnvEditing);
      const entries = slsEnvEntries.length ? slsEnvEntries : [{ env: "dev", project: "" }, { env: "pro", project: "" }];
      for (const e of entries) box.appendChild(slsMakeEnvRow(e.env, e.project));
      if (slsEnvEditing) {
        const add = document.createElement("button");
        add.type = "button"; add.className = "sls-env-add-btn"; add.textContent = "+ 新增环境";
        add.addEventListener("click", () => {
          const row = slsMakeEnvRow("", "");
          box.insertBefore(row, add);
          row.querySelector(".env").focus();
        });
        box.appendChild(add);
      }
      const btn = $("sls-env-edit");
      btn.textContent = slsEnvEditing ? "保存" : "编辑环境";
      btn.title = slsEnvEditing ? "保存环境改动" : "编辑环境（增删 / 改名）";
      btn.classList.toggle("primary", slsEnvEditing);
    }
    function slsFillEnvs(projects) {
      slsEnvEntries = Object.entries(projects || {}).map(([env, project]) => ({ env, project }));
      slsEnvEditing = false; // 外部刷新/回填一律回到查看态
      slsRenderEnvs();
    }
    function slsFill(cfg) {
      cfg = cfg || {};
      $("sls-endpoint").value = cfg.endpoint || "";
      $("sls-ak-id").value = cfg.accessKeyId || "";
      $("sls-ak-secret").value = cfg.accessKeySecret || "";
      $("sls-ak-secret").type = "password"; $("sls-ak-eye").innerHTML = EYE; // 回填后回到隐藏态
      slsFillEnvs(cfg.projects || {});
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
    // 从环境行收集 { 环境名: project }；环境名为空的行丢弃，重名后者覆盖前者。
    function slsCollectEnvs() {
      const projects = {};
      for (const row of $("sls-envs").querySelectorAll(".sls-env-row")) {
        const env = row.querySelector(".env").value.trim();
        if (env) projects[env] = row.querySelector(".proj").value.trim();
      }
      return projects;
    }
    function slsCollect(logs) {
      return {
        endpoint: $("sls-endpoint").value.trim(),
        accessKeyId: $("sls-ak-id").value.trim(),
        accessKeySecret: $("sls-ak-secret").value.trim(),
        projects: slsCollectEnvs(),
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
    // 头部按钮：查看态 → 进入编辑；编辑态 → 校验并一起保存整份配置、回到查看态。
    $("sls-env-edit").addEventListener("click", () => {
      if (slsBusy) return;
      if (!slsEnvEditing) { slsEnvEditing = true; slsRenderEnvs(); return; }
      const r = slsParseLogs();
      if (!r.ok) { $("sls-logs").classList.add("bad"); slsStatus(r.error, "err"); return; }
      $("sls-logs").classList.remove("bad");
      // 收集编辑态的环境行为已提交数据（丢弃环境名为空的行），再退出编辑态。
      slsEnvEntries = [];
      for (const row of $("sls-envs").querySelectorAll(".sls-env-row")) {
        const env = row.querySelector(".env").value.trim();
        if (env) slsEnvEntries.push({ env, project: row.querySelector(".proj").value.trim() });
      }
      slsEnvEditing = false;
      slsRenderEnvs();
      slsSetBusy(true); slsStatus("正在保存…", "wait");
      vscode.postMessage({ type: "slsSave", config: slsCollect(r.logs) });
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
function parseUsage(text: string): { sessionPct?: number; sessionReset?: string; weekPct?: number; weekReset?: string; weekModelPct?: number; weekModelName?: string } | undefined {
  if (!text) return undefined;
  const reset = (s?: string) => s?.replace(/\s*\(.*?\)\s*$/, "").trim() || undefined; // drop "(Asia/Shanghai)"
  const sess = /Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n(]+))?/i.exec(text);
  // 按模型的周限额行不写死模型名（Sonnet/Opus/Fable 随账号计划变），"all models"
  // 归全部模型，其余第一条按模型行原样带出名字显示。
  let weekPct: number | undefined;
  let weekReset: string | undefined;
  let weekModelPct: number | undefined;
  let weekModelName: string | undefined;
  const weekRe = /Current week \(([^)]+)\):\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n(]+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = weekRe.exec(text))) {
    const label = m[1].trim();
    if (/^all models$/i.test(label)) {
      weekPct = parseInt(m[2], 10);
      weekReset = reset(m[3]);
    } else if (weekModelPct === undefined) {
      weekModelName = label.replace(/\s+only$/i, "").trim();
      weekModelPct = parseInt(m[2], 10);
    }
  }
  if (!sess && weekPct === undefined && weekModelPct === undefined) return undefined;
  return {
    sessionPct: sess ? parseInt(sess[1], 10) : undefined,
    sessionReset: reset(sess?.[2]),
    weekPct,
    weekReset,
    weekModelPct,
    weekModelName,
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
