import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as https from "node:https";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ClaudeProcess, PermissionRequest } from "../claude/process";
import { SessionStore } from "../claude/session";
import { CheckpointManager, shortLabel } from "../checkpoints";
import { ChangedFile, CheckpointSummary, contextWindowFor, CTX_OPEN, CTX_CLOSE, SLS_CTX_OPEN, SLS_CTX_CLOSE, FromWebview, ICONS, QQConfig, SessionSummary, SlsConfig, ToWebview } from "../shared";
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
  /** 本轮提问原文（截断留底）——任务完成 webhook 推送时带上，让通知可读。 */
  lastUserText?: string;
  /** 用户最近一次动作的时刻（发消息/点停止/答授权/答提问；等待推送发出后也会
   *  刷新，兼作冷却锚点）。等待输入的 webhook 推送用它判断「人多半已走开」：
   *  距它超过阈值才推，连续多个等待按间隔冷却不刷屏。 */
  lastUserActionAt?: number;
  /** 轮次看门狗：本轮最后一次收到任何 CLI 事件的时刻；有值 = 轮次进行中。
   *  CLI 有已知的静默 hang 缺陷（stream-json 多轮、result 后不退出等），一旦发生
   *  我们永远等不到 result、界面永远转圈。超过静默上限就判定卡死并自愈。 */
  lastEventAt?: number;
  /** 看门狗：连续未回应的 ping 数。webview↔host 通道会无声半死（页面活着但消息
   *  不通，表现为永远转圈/按钮全聋），连续 3 次不回就重建 webview 自愈。 */
  missedPings?: number;
  /** 上次看门狗重建的时刻——5 分钟冷却，防止超大会话渲染慢被误判成失联后反复重建。 */
  rebuildAt?: number;
  /** 进程最近一次吐出任何事件的时刻（不随轮次收尾清零，与 lastEventAt 不同）。
   *  LRU 淘汰用它兜底：interrupt 会乐观置 busy=false，但 CLI 可能还在继续输出——
   *  刚有动静的进程不能当"空闲"杀掉。 */
  lastEmitAt?: number;
  /** 输入框草稿（webview 每次变化都同步过来）。通道看门狗重建 webview 是整页
   *  重载，不存宿主侧的话用户打了一半的长消息会瞬间消失。 */
  draft?: string;
  /** 还原时随草稿一起回填的图片附件（发送/清空草稿后作废）。 */
  draftImages?: { mediaType: string; data: string }[];
}

/** 预热时间戳台账，落盘在 ~/.claude-chat/prewarm.json，所有窗口共用。
 *  预热一次的代价是一份完整上下文的 input token，绝不能因为"换了个窗口/刚
 *  reload 过"就重来一遍。文件很小、读写频次低，直接同步 IO；任何失败都退化成
 *  "当作没预热过"（顶多多热一次，不会反过来把功能搞坏）。 */
class PrewarmLedger {
  private static readonly TTL = 24 * 3600_000; // 超过一天的记录没有意义，顺手清掉
  constructor(private readonly field: "s" | "d") {}

  private file(): string {
    return path.join(os.homedir(), ".claude-chat", "prewarm.json");
  }

  private read(): Record<string, { s?: number; d?: number }> {
    try {
      return JSON.parse(fs.readFileSync(this.file(), "utf8")) || {};
    } catch {
      return {};
    }
  }

  get(key: string): number | undefined {
    return this.read()[key]?.[this.field];
  }

  set(key: string, ts: number): void {
    try {
      const all = this.read();
      const entry = all[key] ?? {};
      entry[this.field] = ts;
      all[key] = entry;
      for (const [k, v] of Object.entries(all)) {
        if (Math.max(v.s ?? 0, v.d ?? 0) < Date.now() - PrewarmLedger.TTL) delete all[k];
      }
      const file = this.file();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 原子写：writeFileSync 会先 truncate 再写，另一个窗口若恰好在这中间读，
      // 会读到空文件→当成"全表为空"→把所有记录一次性抹掉，反而害得每个会话
      // 都重烧一次预热。tmp + rename 让读者永远看到完整的旧版或新版。
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(all), "utf8");
        fs.renameSync(tmp, file);
      } catch (e) {
        try {
          fs.unlinkSync(tmp); // 别在用户目录里留下永不回收的 .tmp
        } catch {
          /* ignore */
        }
        throw e;
      }
    } catch {
      /* 记不下来最多多预热一次，不能反过来影响功能 */
    }
  }
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
  private usageFails = 0; // 连续解析失败次数（API-key 账号会一直失败，不能无限重试）
  private usageInFlight = false;
  private lastUsage?: ToWebview; // most recent usage result, replayed to new tabs
  private layoutFixing = false; // guards re-entrancy while sliding a file group left
  private readonly origChanged = new vscode.EventEmitter<vscode.Uri>();
  private terminal?: vscode.Terminal;
  // -- Prompt-cache prewarmer (big sessions) --
  // 预热记录必须跨窗口/跨 reload 持久化：放内存里的话，窗口每 reload 一次就重新
  // 预热一次，两个窗口还各预热各的——实测一个 16.7MB 的会话 75 分钟内被预热了
  // 4 次，每次都是一份完整上下文的 input token。这是"莫名其妙很费 token"的真凶。
  private readonly prewarmStarted = new PrewarmLedger("s"); // warmKey -> ts (dedupe in-flight)
  private readonly prewarmDone = new PrewarmLedger("d"); // warmKey -> ts of last completed warm
  private prewarmProc?: ClaudeProcess; // at most one warm-up runs at a time (they're token-expensive)
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
  private notifyPanel?: vscode.WebviewPanel;
  private slsPanel?: vscode.WebviewPanel;
  /** 当前正在处理的 QQ 消息（收集回复用）。机器人一次只处理一条，避免串台。 */
  private qqTurn?: { target: QQIncoming; text: string; done: boolean; blockStart?: number };
  private readonly qqQueue: QQIncoming[] = [];
  /** 轮次忙标记。命令处理期间 qqTurn 为空，只靠它防止并发跑第二条。 */
  private qqRunning = false;
  /** QQ 轮次的卡死看门狗心跳（对齐聊天侧 ctx.lastEventAt——CLI 静默卡死时
   *  机器人不能永久装死，尤其人不在电脑前时没有任何手动恢复手段）。 */
  private qqLastEventAt?: number;
  /** /compact 进行中标记：压缩结束会发一个正常 result，不吃掉的话它会把
   *  压缩期间新发的那轮"偷走"（用户收到空回复，真正的回答被丢弃）。 */
  private qqCompacting = false;
  /** 正在跑的预热（warmKey + 完成 promise）。发送撞上同会话的预热时等它完成再发：
   *  两个请求并发冷啃同一段大上下文会互相拖慢（实测比先焐后发慢好几倍）。 */
  private prewarmInflight?: { key: string; promise: Promise<void> };
  /** 已弹过"建议压缩"提示的会话（每窗口每会话只提示一次，不做唐僧）。 */
  private readonly compactPrompted = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.store = new SessionStore(this.cwd());

    // 引擎脚本随插件一起演进，但运行时用的是 ~/sls-tools 里的副本，而副本
    // 原本只在「保存/测试配置」时刷新——升级插件后老脚本会一直跑下去。
    // 已经初始化过 SLS 的机器（目录存在）在激活时同步一次最新脚本。
    try {
      if (fs.existsSync(path.join(this.slsDir(), "config.json"))) this.provisionSlsFiles();
    } catch {
      /* 同步失败不阻塞激活，下次保存配置时仍会重试 */
    }

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
      // onDidCloseTextDocument is unreliable for TAB closes (VS Code keeps the
      // document alive in the background), which left the auto-chip stuck. The
      // tab list is the truth: when the attached file has no tab left anywhere,
      // clear or replace the chip.
      vscode.window.tabGroups.onDidChangeTabs(() => {
        const p = this.lastActiveFilePath;
        if (!p) return;
        const stillOpen = vscode.window.tabGroups.all.some((g) =>
          g.tabs.some((t) => ((t.input as { uri?: vscode.Uri } | undefined)?.uri?.fsPath ?? "") === p),
        );
        if (!stillOpen) this.postActiveFile(true);
      }),
    );

    // 用量随时间流逝（5h 窗口滚动）+ 其他设备的消耗——不主动刷新的话，胶囊上的
    // 数字要等用户点开菜单才变。每 3 分钟拉一次（fetchUsage 自带 90s 节流）。
    this.usageTimer = setInterval(() => this.fetchUsage(), 3 * 60_000);

    // QQ 机器人自动续连放在这（扩展激活）而不是侧边栏 resolve——重载窗口后
    // 侧边栏不展开的话 resolveWebviewView 根本不执行，开着的机器人会一直离线。
    setTimeout(() => {
      try {
        if (this.qqStored().enabled && !this.qqBot) {
          void this.startQQBot().catch((e) => this.output.appendLine(`[qq] 自动启动失败: ${String(e)}`));
        }
      } catch (e) {
        this.output.appendLine(`[qq] 初始化异常(已隔离): ${String(e)}`);
      }
    }, 1500);

    // 启动清一次历史遗留的孤儿附属目录（旧版本删会话时没清 file-history /
    // session-env / tasks，实测能攒到几十个）。延后执行，不拖慢激活。
    setTimeout(() => {
      try {
        const n = this.store.sweepOrphanSidecars();
        if (n) this.output.appendLine(`[${new Date().toISOString()}] [cleanup] 清理了 ${n} 个已删会话的残留数据`);
      } catch (err) {
        this.output.appendLine(`[cleanup] 清理残留失败: ${String(err)}`);
      }
    }, 8000);

    // 看门狗：webview↔host 通道会无声半死（实锤案例：宿主 103s 完成的轮次，面板
    // 转圈到 1000s+，确认更改按钮全聋，官方插件同时正常）。每 10s ping 一次已就绪
    // 的聊天面板，连续 3 次（30s）不回 pong 就重建该面板的 webview——历史与忙碌
    // 状态由 ready→loadCtxSession 恢复，用户看到的只是界面刷了一下而不是永久卡死。
    this.watchdogTimer = setInterval(() => {
      // ① 轮次看门狗：CLI 静默太久 = 卡死（已知缺陷，见 anthropics/claude-code
      //    #3187 / #25629）。前台后台都查——后台跑着的轮次卡住同样要收尾。
      for (const ctx of [...this.sessions, ...this.detached.values()]) this.checkTurnStall(ctx);
      this.checkQQStall(); // QQ 机器人进程同样会被 CLI 静默卡死拖死，且人不在电脑前无法手动救
      // ② webview 通道看门狗（下方）
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
            this.view.webview.html = this.sidebarHtml();
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

    // （原来这里有个每 5 分钟的"定时保温"：对所有开着的 tab 每 50 分钟重焐一遍
    // prompt cache。经调研已删除——官方与全部同类项目都没有这种机制，挂着一个
    // 大会话的 tab 等于每小时白烧一份完整上下文的 input token，是费 token 的
    // 头号元凶。现在只保留"打开会话时预热一次"；缓存过期后靠发送前的诚实提示
    // 和一键 /compact（官方 Resume-from-summary 的同款思路）。）
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
    // 移动侧边栏位置（如移到辅助侧栏）会 dispose 旧 view 再 resolve 新的——
    // 死引用不清掉的话，进程事件路径上的 postMessage 会抛异常。
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    // The left sidebar is a session manager only — chat lives in the editor panel.
    view.webview.html = this.sidebarHtml();
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onSidebarMessage(m));
    this.postUpdateDot(); // restore the badge if an update was already detected
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post2(view.webview, {
          kind: "sessions",
          list: this.withPinned(this.store.list()),
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
      // 外部改动（Claude 自己写映射、或手动改）→ 刷新已打开的配置面板 + 组合器开关。
      this.slsPanel?.webview.postMessage({
        kind: "sls_config",
        accounts: this.readSlsAccounts(),
        enginePresent: this.slsEngineReady(),
      } satisfies ToWebview);
      this.activeCtx && this.post(this.activeCtx, { kind: "config", permissionMode: "", model: "", effort: "", slsConfigured: this.slsConfigured() } as ToWebview);
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

  /** Broadcast the session list to the sidebar manager,
   *  and set each panel's tab title to its own session's title. */
  private refreshSessions(): void {
    const list = this.store.list();
    try {
      this.view?.webview.postMessage({
        kind: "sessions",
        list: this.withPinned(list),
        activeId: this.activeCtx?.sessionId,
        runningIds: this.runningIds(),
      } satisfies ToWebview);
    } catch {
      /* view disposed（移动侧边栏位置会短暂出现死引用） */
    }
    for (const ctx of this.sessions) {
      try {
        this.setPanelTitle(ctx, list);
      } catch {
        /* panel disposed */
      }
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
      // 60s 内还在吐事件的进程不算空闲：interrupt 乐观置了 busy=false，但 CLI
      // 可能没理会、仍在写 transcript——这时候杀掉会截断落盘内容。
      .filter((c) => c.proc && !c.proc.isBusy && c.sessionId && Date.now() - (c.lastEmitAt ?? 0) > 60_000)
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

  /** 空账号模板（种子 dev/pro 两个空环境）。 */
  private emptySlsAccount(name = ""): SlsConfig {
    return { name, endpoint: "", accessKeyId: "", accessKeySecret: "", projects: { dev: "", pro: "" }, logs: {} };
  }

  /** 读取全部账号。新格式 { accounts:[...] }；旧的平铺单账号自动包成一个「默认」账号；
   *  文件不存在时给一个空账号。 */
  private readSlsAccounts(): SlsConfig[] {
    const one = (j: Record<string, unknown>, name: string): SlsConfig => {
      const projects = this.normalizeProjects(j.projects);
      return {
        name: (j.name as string) || name,
        endpoint: (j.endpoint as string) || "",
        accessKeyId: (j.accessKeyId as string) || "",
        accessKeySecret: (j.accessKeySecret as string) || "",
        projects: Object.keys(projects).length ? projects : { dev: "", pro: "" },
        logs: (j.logs as SlsConfig["logs"]) || {},
      };
    };
    try {
      const raw = fs.readFileSync(path.join(this.slsDir(), "config.json"), "utf8");
      const j = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(j.accounts) && j.accounts.length) {
        return (j.accounts as Record<string, unknown>[]).map((a, i) => one(a, `账号${i + 1}`));
      }
      // 旧平铺格式：整个对象就是单账号
      if (j.endpoint || j.logs) return [one(j, "默认")];
    } catch {
      /* 落到空账号 */
    }
    return [this.emptySlsAccount("默认")];
  }

  /** 写回全部账号为 { accounts:[...] }，权限 600。环境名/Project 去空白。 */
  private writeSlsAccounts(accounts: SlsConfig[]): void {
    const clean = (accounts.length ? accounts : [this.emptySlsAccount("默认")]).map((a, i) => {
      const projects: Record<string, string> = {};
      for (const [env, proj] of Object.entries(a.projects || {})) {
        const name = (env || "").trim();
        if (name) projects[name] = (proj || "").trim();
      }
      return {
        name: (a.name || "").trim() || `账号${i + 1}`,
        endpoint: (a.endpoint || "").trim(),
        accessKeyId: (a.accessKeyId || "").trim(),
        accessKeySecret: (a.accessKeySecret || "").trim(),
        projects,
        logs: a.logs || {},
      };
    });
    const dir = this.slsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ accounts: clean }, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
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
    return this.readSlsAccounts().some((c) => !!(c.endpoint && Object.keys(c.logs || {}).length));
  }

  /** 若 SLS 已配置好，生成一段系统提示，告诉每个会话「有 sls 工具、怎么用、dev=测试环境」。
   *  没配 logs 就返回 ""，不干扰普通会话。 */
  private slsSystemPromptSnippet(): string {
    const sls = "~/sls-tools/sls";
    // 只保留配好的账号（有 endpoint 且有 logs 映射）。
    const ready = this.readSlsAccounts().filter((a) => a.endpoint && Object.keys(a.logs || {}).length);
    if (!ready.length) return "";
    const hint = (e: string) => (e === "dev" ? "（测试/开发环境）" : e === "pro" ? "（生产/线上环境）" : "");
    const envLineOf = (a: SlsConfig): string => {
      const envNames = Object.entries(a.projects || {}).filter(([, p]) => (p || "").trim()).map(([e]) => e.trim());
      const defEnv = envNames.includes("pro") ? "pro" : (envNames[0] || "pro");
      return envNames.length
        ? `环境 --env 可选：${envNames.map((e) => `\`${e}\`${hint(e)}`).join("、")}（默认 \`${defEnv}\`）`
        : "环境 --env：`dev`=测试、`pro`=生产（默认 pro）";
    };
    const head = [
      "## 阿里云 SLS 后端日志查询",
      `你可以直接查询后端服务的线上日志：运行本机命令 \`${sls}\`（已配置好凭证，可直接用 Bash 调，\`${sls} apps\` 列出全部项目映射）。`,
    ];
    let appsBlock: string[];
    if (ready.length === 1) {
      const a = ready[0];
      appsBlock = [
        `- ${envLineOf(a)}`,
        `- 业务项目 --app 可选值：${Object.keys(a.logs || {}).join("、")}。`,
      ];
    } else {
      // 多账号：分别列出各账号的 app；--app 名唯一时 CLI 自动路由到对应账号，
      // 只有同名 app 撞车才需要 --account。
      appsBlock = ["- **有多个阿里云账号**，按 `--app` 自动路由到对应账号（app 名唯一时无需 `--account`；撞名才加 `--account <账号名>`）："];
      for (const a of ready) {
        appsBlock.push(`  · 账号 \`${a.name || "(未命名)"}\`（${envLineOf(a)}）：${Object.keys(a.logs || {}).join("、")}`);
      }
    }
    return [
      ...head,
      ...appsBlock,
      "- 日志类型 --kind：`error`=异常/报错日志(默认)，`info`=普通日志，`both`=两者都查。",
      "- 时间 --from：默认最近 1 小时，可用 `30m`/`2h`/`1d` 或绝对时间；条数 `-n`（默认 10）。加 `--json` 得结构化输出。单条日志默认按字段截断到 700 字符（保头保尾），确需完整堆栈时对单条加 `--full -n 1`。",
      "当用户要求查看/排查某环境某服务的日志、报错、异常、线上问题时，**主动用这个命令去查真实日志**，不要只翻本地代码或说无法获取。查询语句 -q 用 SLS 语法（如 `level: ERROR`、`* and 关键词`）。",
      "**省 token 纪律**（生产日志量极大）：先小样本（`-n 5`）确认方向再放大；能用关键词/traceId 过滤就别 `-q \"*\"` 全量拉；查不到时按 1h→6h→1d 逐步扩时间窗，**不要**同时对多个 app/env 撒网全量扫；定位到目标后才用 `--full -n 1` 取完整堆栈。",
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

  /** 标题栏「日志配置」按钮：打开独立的 SLS 多账号配置面板（照「任务完成推送」模式）。 */
  showSlsConfig(): void {
    this.watchSlsConfig();
    if (this.slsPanel) {
      this.slsPanel.reveal();
      this.slsPanel.webview.postMessage({ kind: "sls_config", accounts: this.readSlsAccounts(), enginePresent: this.slsEngineReady() } satisfies ToWebview);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "claude-chat.sls",
      "SLS 日志配置",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.slsPanel = panel;
    panel.webview.html = this.slsHtml();
    panel.webview.onDidReceiveMessage(async (m: FromWebview) => {
      try {
        if (m.type === "webviewError") {
          this.output.appendLine(`[${new Date().toISOString()}] [webview] SLS 面板脚本错误: ${m.message}`);
          return;
        }
        if (m.type === "slsGenerate") {
          await this.generateSlsMapping();
          return;
        }
        await this.handleSlsMessage(m, (e) => panel.webview.postMessage(e));
      } catch (err) {
        this.output.appendLine(`[sls] 面板消息处理失败(${(m as { type?: string }).type}): ${String(err)}`);
      }
    });
    panel.onDidDispose(() => {
      if (this.slsPanel === panel) this.slsPanel = undefined;
    });
  }

  /** slsLoad / slsSave / slsTest 的共用处理，`reply` 决定回哪个 webview。 */
  private async handleSlsMessage(m: FromWebview, reply: (e: ToWebview) => void): Promise<boolean> {
    if (m.type === "slsLoad") {
      reply({ kind: "sls_config", accounts: this.readSlsAccounts(), enginePresent: this.slsEngineReady() });
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
        this.writeSlsAccounts(m.accounts);
        await this.ensureSlsEngine();
        reply({ kind: "sls_result", action: "save", ok: true, message: `已保存 ${m.accounts.length} 个账号到 ${path.join(this.slsDir(), "config.json")}` });
        this.activeCtx && this.post(this.activeCtx, { kind: "config", permissionMode: "", model: "", effort: "", slsConfigured: this.slsConfigured() } as ToWebview);
      } catch (err) {
        reply({ kind: "sls_result", action: "save", ok: false, message: `保存或初始化失败：${String((err as Error)?.message ?? err)}` });
      }
      return true;
    }
    return false;
  }

  async stop(): Promise<void> {
    const ctx = this.activeCtx;
    if (!ctx) return;
    // 与面板内 interrupt 分支保持一致：被中断的轮次不会再有 result 事件，
    // 不清 lastEventAt 的话 12 分钟后看门狗会对早已停止的会话"补一枪"。
    ctx.pendingPerm = undefined;
    ctx.lastEventAt = undefined;
    ctx.stopSeq = ctx.sendSeq ?? 0;
    this.post(ctx, { kind: "busy", busy: false });
    await ctx.proc?.interrupt();
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
          // 只有点横幅才弹"下载并安装"确认；手动「检查更新」只点亮横幅，
          // 但仍给出结果反馈（已最新/失败），不然点了像没反应。
          await this.checkForUpdate(!m.fromBanner, false);
          break;
        case "refreshUsage":
          this.fetchUsage(true);
          break;
        case "openSession":
          await this.openSession(m.sessionId);
          break;
        case "newInEditor":
          await this.openSession(undefined);
          break;
        case "deleteSessions":
          await this.deleteSessions(m.sessionIds);
          break;
        case "renameSession":
          this.renameSession(m.sessionId, m.title);
          break;
        case "pinSession":
          await this.setPinned(m.sessionId, m.pinned);
          break;
        case "slsLoad":
        case "slsSave":
        case "slsTest":
          await this.handleSlsMessage(m, (e) => this.view?.webview.postMessage(e));
          break;
        case "slsGenerate":
          await this.generateSlsMapping();
          break;
        case "openSlsConfig":
          this.showSlsConfig();
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
        case "draft":
          ctx.draft = m.text; // 宿主侧留底，webview 被看门狗重建时回填
          if (!m.text) ctx.draftImages = undefined; // 发送/清空后，还原带回的图片留底一并作废
          break;
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
          // 只有点横幅才弹"下载并安装"确认；手动「检查更新」只点亮横幅，
          // 但仍给出结果反馈（已最新/失败），不然点了像没反应。
          await this.checkForUpdate(!m.fromBanner, false);
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
          ctx.lastUserActionAt = Date.now(); // 点停止也是在场证明
          ctx.lastEventAt = undefined; // 用户主动停止，本轮不再受看门狗管辖
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
          if (proc) {
            proc.compact();
            // 压缩也纳入轮次看门狗：CLI 在 compacting 中静默卡死同样会永久转圈。
            ctx.lastEventAt = Date.now();
          } else this.post(ctx, { kind: "busy", busy: false });
          break;
        }
        case "permission":
          ctx.pendingPerm = undefined;
          ctx.lastUserActionAt = Date.now(); // 答复授权 = 人在屏幕前
          // 挂起期间不计时（checkTurnStall 跳过），答复后从现在重新起算。
          if (ctx.lastEventAt !== undefined) ctx.lastEventAt = Date.now();
          this.handlePermission(ctx, m.requestId, m.behavior, m.suggestionId);
          break;
        case "answerQuestion":
          ctx.pendingPerm = undefined;
          ctx.lastUserActionAt = Date.now(); // 答复提问 = 人在屏幕前
          if (ctx.lastEventAt !== undefined) ctx.lastEventAt = Date.now();
          ctx.proc?.answerQuestion(m.requestId, m.answers);
          break;
        case "restoreCheckpoint":
          await this.restoreCheckpoint(ctx, m.checkpointId);
          break;
        case "forkCheckpoint":
          await this.forkCheckpoint(ctx, m.checkpointId);
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
        case "validateSymbols": {
          const invalid = await this.validateSymbols(m.syms);
          if (invalid.length) this.post(ctx, { kind: "refs_validated", invalid });
          break;
        }
        case "validateRefs": {
          // 逐个解析（含全工作区文件名搜索）——裸文件名 `bridge.js:282` 也算有效链接。
          const invalid: string[] = [];
          for (const r of m.refs) {
            if (!(await this.fileRefResolves(r.path))) invalid.push(r.id);
          }
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
    if (ctx.draft || ctx.draftImages?.length)
      this.post(ctx, { kind: "draft", text: ctx.draft ?? "", images: ctx.draftImages }); // 重建后回填草稿
    if (ctx.sessionId) {
      this.loadSessionInto(ctx, ctx.sessionId);
      return;
    }
    if (ctx.blank) {
      this.post(ctx, { kind: "load_history", items: [], checkpoints: [] });
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
      this.post(ctx, { kind: "load_history", items: [], checkpoints: [] });
      this.refreshChangedFiles(ctx);
    }
  }

  /** Push a session's full transcript/checkpoints/busy state into a chat panel. */
  private loadSessionInto(ctx: SessionCtx, sid: string): void {
    const items = this.store.load(sid);
    this.post(ctx, { kind: "load_history", items, sessionId: sid, checkpoints: this.checkpointsForView(ctx, sid) });
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
    ctx.lastEventAt = undefined; // 旧轮次随进程一起作废，别让看门狗事后再开火
    // 新上下文配新的检查点账本——旧会话的还原点不该落到新对话头上。
    ctx.checkpoints.flush();
    ctx.checkpoints = new CheckpointManager(this.storageDir());
    this.output.appendLine(`[${new Date().toISOString()}] [clear] ${old?.slice(0, 8) ?? "空"} → 新上下文`);
    this.post(ctx, { kind: "load_history", items: [], checkpoints: [] });
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
    ctx.lastEventAt = ctx.sendAt; // 轮次看门狗开始计时（任何事件都会刷新它）
    ctx.lastUserText = (text || "(图片)").slice(0, 200); // 完成推送的通知正文用
    ctx.lastUserActionAt = ctx.sendAt; // 等待输入推送的「用户在场」锚点
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
    const meta = checkpointId ? this.cpMeta(ctx, checkpointId) : undefined;
    if (!meta) {
      this.post(ctx, {
        kind: "error",
        message: checkpointId ? "找不到该还原点（可能已被清理），无法重新生成。" : "这条消息没有还原点，无法重新生成。",
      });
      this.post(ctx, { kind: "busy", busy: false });
      this.loadCtxSession(ctx); // restore the view we just let the webview trim
      return;
    }
    // 先停掉进程再动会话（垂死 CLI 还会往旧 transcript 刷记录；派生替换后旧文件
    // 会被删掉，复活复查兜底）。界面同步进入「正在还原」过渡态。
    this.post(ctx, { kind: "restoring" });
    while (ctx.proc) {
      const dying = ctx.proc;
      ctx.proc = undefined;
      ctx.starting = undefined;
      await dying.disposeAndWait();
    }
    try {
      await this.forkRewind(ctx, checkpointId, meta.truncateLine);
    } catch (err) {
      this.output.appendLine(`[restore] 派生失败: ${String(err)}`);
      this.post(ctx, { kind: "error", message: `回退对话失败：${String(err)}` });
      this.post(ctx, { kind: "busy", busy: false });
      this.loadCtxSession(ctx);
      return;
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
      ctx.lastEventAt = undefined; // 进程被主动换掉，旧轮次不再受看门狗管辖
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

  /** 从还原点派生新会话：复制截断点之前的对话为新 sessionId，新编辑器标签页打开。
   *  与「还原」不同——不回滚文件、不截断当前会话，两边此后各聊各的。 */
  private async forkCheckpoint(ctx: SessionCtx, checkpointId: string): Promise<void> {
    const cut = this.cpMeta(ctx, checkpointId)?.truncateLine;
    if (cut === undefined || !ctx.sessionId) {
      this.post(ctx, { kind: "error", message: "找不到该还原点，无法派生。" });
      return;
    }
    if (cut <= 0) {
      this.post(ctx, { kind: "notice", message: "该点之前没有对话内容，无法派生新会话。" });
      return;
    }
    const preview = this.cpPreview(ctx, checkpointId);
    const confirm = await vscode.window.showWarningMessage(
      "从此处派生新会话？",
      {
        modal: true,
        detail:
          (preview ? `消息：${preview.userText}\n\n` : "") +
          "将复制这条消息之前的对话开一个新会话（新标签页打开）。当前会话不受影响，两边此后各自独立。",
      },
      "派生",
    );
    if (confirm !== "派生") return;
    // 用 SDK 的 forkSession 从该轮提问的父节点派生：沿 parentUuid 链复制、UUID 重映射、
    // 跨压缩边界保留全部历史，且天然避开文件里被放弃的分支（此前按行复制前缀，截点
    // 若落在旧分支之后会把旧分支当成对话尾巴带进新会话）。
    const leaf = this.store.rewindLeafFor(ctx.sessionId, cut);
    if (!leaf) {
      this.post(ctx, { kind: "error", message: "派生失败：该点之前没有可用对话。" });
      return;
    }
    let newId: string;
    try {
      const { forkSession, getSessionInfo } = await import("@anthropic-ai/claude-agent-sdk");
      const info = await getSessionInfo(ctx.sessionId).catch(() => undefined);
      const title = info?.customTitle ?? info?.summary;
      newId = (await forkSession(ctx.sessionId, { upToMessageId: leaf, ...(title ? { title } : {}) })).sessionId;
    } catch (err) {
      this.output.appendLine(`[fork] ${String(err)}`);
      this.post(ctx, { kind: "error", message: `派生失败：${String(err)}` });
      return;
    }
    // 分支带走截断点之前的还原点（按新文件的提问行重对齐），派生出的会话同样能继续往回还原。
    CheckpointManager.forkFor(this.storageDir(), ctx.sessionId, newId, cut, this.store.userTurnLines(newId));
    await this.openSession(newId);
    vscode.window.showInformationMessage("已从该点派生新会话，与原会话互不影响。");
  }

  /** 给界面的还原点列表：真实还原点 + 为没有还原点的真人轮次合成的 `turn:<行号>` 条目。
   *  由官方插件、其它窗口发出的轮次本插件没记过还原点，此前这些轮次上没有「还原到此处」，
   *  可见的最后几轮恰好是这类时用户会以为还原点"全没了"。合成点只回退对话（fork
   *  派生本就不依赖快照），不回滚文件；真实还原点按提问文本单调匹配，优先保留。 */
  private checkpointsForView(ctx: SessionCtx, sid: string): CheckpointSummary[] {
    const real = ctx.checkpoints.list();
    const turns = this.store.userTurnLines(sid);
    const norm = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 80);
    const assigned = new Map<number, CheckpointSummary>();
    let from = 0;
    for (const c of real) {
      for (let k = from; k < turns.length; k++) {
        const t = turns[k];
        const ok = c.userText === "(图片)" ? t.hasImages && !norm(t.text) : norm(t.text) === norm(c.userText);
        if (ok) {
          assigned.set(k, c);
          from = k + 1;
          break;
        }
      }
    }
    const out: CheckpointSummary[] = [];
    turns.forEach((t, k) => {
      const c = assigned.get(k);
      if (c) out.push(c);
      else if (t.text) out.push({ id: `turn:${t.line}`, label: shortLabel(t.text), createdAt: 0, userText: t.text, fileCount: 0, synthetic: true });
    });
    return out;
  }

  private syntheticTurn(ctx: SessionCtx, checkpointId: string): { truncateLine: number; userText: string } | undefined {
    if (!checkpointId.startsWith("turn:") || !ctx.sessionId) return undefined;
    const line = Number(checkpointId.slice(5));
    const t = this.store.userTurnLines(ctx.sessionId).find((x) => x.line === line);
    return t ? { truncateLine: line - 1, userText: t.text } : undefined;
  }

  private cpMeta(ctx: SessionCtx, checkpointId: string): { truncateLine: number; userText: string } | undefined {
    return checkpointId.startsWith("turn:") ? this.syntheticTurn(ctx, checkpointId) : ctx.checkpoints.metaOf(checkpointId);
  }

  private cpPreview(ctx: SessionCtx, checkpointId: string): { userText: string } | undefined {
    if (!checkpointId.startsWith("turn:")) return ctx.checkpoints.preview(checkpointId);
    const t = this.syntheticTurn(ctx, checkpointId);
    return t ? { userText: shortLabel(t.userText) } : undefined;
  }

  /** 回滚文件 + 丢弃截点及之后的还原点。合成还原点没有快照：只丢弃、不回滚。 */
  private cpRestore(ctx: SessionCtx, checkpointId: string, cutLine: number) {
    if (!checkpointId.startsWith("turn:")) return ctx.checkpoints.restore(checkpointId);
    const t = this.syntheticTurn(ctx, checkpointId);
    if (!t) return undefined;
    ctx.checkpoints.pruneFrom(cutLine);
    return { restoredFiles: 0, skipped: [] as string[], userText: t.userText, truncateLine: cutLine };
  }

  /** 把会话回退到还原点之前：用 SDK 的 forkSession 从截点前最后一条链记录派生出一个
   *  干净的新会话（沿 parentUuid 链复制、UUID 重映射、跨压缩边界保留全部历史，实测
   *  49MB 会话 365ms），当前标签页静默切到新会话，旧会话删除——用户看到的还是同一
   *  段对话，而官方插件 / --resume 立即一致。为什么不截文件：垂死 CLI 会在截断后再
   *  刷出记录，若为链记录则 parentUuid 链断裂，官方读取器只剩尾巴、上下文丢失。为
   *  什么不用 resumeSessionAt：它要等下一条消息才落盘，期间官方插件仍显示旧尾巴。
   *  顺序：先派生（失败则一切未动）→ 回滚文件、丢弃截点后的还原点 → 还原点按提问
   *  文本重对齐到新文件 → 切换会话 → 旧会话退场。调用前须已停掉该会话的进程。 */
  private async forkRewind(
    ctx: SessionCtx,
    checkpointId: string,
    cutLine: number,
  ): Promise<{ result: NonNullable<ReturnType<CheckpointManager["restore"]>>; rewoundToStart: boolean }> {
    const oldId = ctx.sessionId;
    // 截点之前没有任何真人提问（还原到第一条消息之前）= 清空对话重来，不派生。
    const hasEarlierTurn = !!oldId && cutLine > 0 && this.store.userTurnLines(oldId).some((t) => t.line <= cutLine);
    const leaf = hasEarlierTurn ? this.store.rewindLeafFor(oldId!, cutLine) : undefined;
    if (!oldId || !leaf) {
      // 截点之前没有任何链记录 = 回到第一条消息之前：回滚文件后转为全新对话。
      const result = this.cpRestore(ctx, checkpointId, cutLine);
      if (!result) throw new Error("找不到该还原点");
      ctx.sessionId = undefined;
      ctx.checkpoints.clear();
      return { result, rewoundToStart: true };
    }
    const { forkSession, getSessionInfo } = await import("@anthropic-ai/claude-agent-sdk");
    const info = await getSessionInfo(oldId).catch(() => undefined);
    const title = info?.customTitle ?? info?.summary;
    const newId = (await forkSession(oldId, { upToMessageId: leaf, ...(title ? { title } : {}) })).sessionId;
    const result = this.cpRestore(ctx, checkpointId, cutLine);
    if (!result) {
      this.store.delete(newId);
      throw new Error("找不到该还原点");
    }
    ctx.checkpoints.migrateTo(newId, this.store.userTurnLines(newId));
    ctx.sessionId = newId;
    void this.context.workspaceState.update(LAST_SESSION_KEY, newId);
    // 旧会话退场：后台池里若还挂着它的进程一并停掉；删文件与附属目录；垂死 CLI
    // 可能在 unlink 之后把旧文件刷回来，复用删除会话的防复活复查。
    const det = this.detached.get(oldId);
    if (det) {
      if (det.proc) await det.proc.disposeAndWait();
      this.detached.delete(oldId);
    }
    this.store.delete(oldId);
    this.sweepResurrected([oldId]);
    this.refreshSessions();
    this.output.appendLine(`[restore] ${oldId.slice(0, 8)} → 派生 ${newId.slice(0, 8)} 替换（回退点 ${leaf.slice(0, 8)}，还原点 ${ctx.checkpoints.list().length} 个）`);
    return { result, rewoundToStart: false };
  }

  private async restoreCheckpoint(ctx: SessionCtx, checkpointId: string): Promise<void> {
    const preview = this.cpPreview(ctx, checkpointId);
    const confirm = await vscode.window.showWarningMessage(
      "还原到这条消息之前？",
      {
        modal: true,
        detail:
          (preview ? `消息：${preview.userText}\n\n` : "") +
          (checkpointId.startsWith("turn:")
            ? "把对话回退到这里 —— Claude 会忘记这条消息及之后的所有轮次。这一轮不是从本插件发出的，没有文件快照：只回退对话，工作区文件保持现状。此操作不可撤销。"
            : "将回滚此后的文件改动，并把对话回退到这里 —— Claude 会忘记这条消息及之后的所有轮次。此操作不可撤销。") +
          (ctx.proc?.isBusy ? "\n\nClaude 正在回复中，还原会先自动停止本轮。" : ""),
      },
      "还原",
    );
    if (confirm !== "还原") return;

    // 元数据先行（metaOf 无副作用）：安全闸必须在动任何东西之前跑完。此前是
    // restore() 先把文件全回滚了才校验，闸拦下时文件已经被改过，「已中止还原」
    // 是假的；会话还在跑的场景下也不能为一个校验不过的还原点白杀进程。
    const meta = this.cpMeta(ctx, checkpointId);
    if (!meta) {
      this.post(ctx, { kind: "error", message: "找不到该还原点。" });
      return;
    }

    // 安全闸：还原点记录的 truncateLine 是「发起该轮时的行数」。若它与当前
    // transcript 严重不符（例如跨天长会话里的陈旧还原点，指向几千行文件的第 8
    // 行），照它截断会把整段上下文连同官方插件里的记录一起报废。校验：截断点
    // 处的那条用户消息，文本必须和还原点记录的提问对得上；对不上就中止。
    // 顺带取回该消息随附的图片——截断后 transcript 里这条消息就没了，必须趁
    // 截断前拿到，稍后随草稿一起回填输入框。
    const nextTurn =
      ctx.sessionId && meta.truncateLine > 0
        ? this.store.firstUserTurnAfter(ctx.sessionId, meta.truncateLine)
        : undefined;
    if (ctx.sessionId && meta.truncateLine > 0 && meta.userText && nextTurn !== undefined) {
      const norm = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 80);
      // 纯图片轮次 beginTurn 存的是占位符「(图片)」，正文无从比对——改验「该轮
      // 确实是纯图片消息」；此前拿占位符硬比后面某轮的文本，纯图片还原必被误拦。
      const aligned =
        meta.userText === "(图片)"
          ? nextTurn.images.length > 0 && !norm(nextTurn.text)
          : norm(nextTurn.text) === norm(meta.userText);
      if (!aligned) {
        this.output.appendLine(
          `[restore] 中止：还原点与 transcript 对不上 truncateLine=${meta.truncateLine} ` +
            `期望提问=${JSON.stringify(norm(meta.userText))} 实际=${JSON.stringify(norm(nextTurn.text))} ` +
            `图片=${nextTurn.images.length}`,
        );
        this.post(ctx, {
          kind: "error",
          message: "这个还原点与当前对话对不上（可能来自更早的会话状态），已中止还原以免误删上下文。",
        });
        return;
      }
    }

    // 1) 会话还在跑就先自动停止，并等进程真正退出——垂死的 CLI 仍可能在截断后
    //    flush transcript 行；进行中的工具（长 Bash、流式写文件）也会把刚还原
    //    的文件又改回去，所以停进程必须发生在回滚文件之前。写成循环是为了补杀：
    //    disposeAndWait 最长等 5s，期间用户可能抢发消息又拉起新进程（spawn 时
    //    ctx.proc 同步就位）——不补的话它会在截断后继续写 transcript，把回退
    //    当场冲掉。
    const wasLive = !!ctx.proc?.isBusy;
    // 先给界面一个零延迟的「正在还原」过渡态：下面停进程（忙时实测 1~3s，上限
    // 5s）+ 派生复制 transcript（大会话几百毫秒），期间界面若毫无反应观感就是卡死。
    this.post(ctx, { kind: "restoring" });
    while (ctx.proc) {
      const dying = ctx.proc;
      ctx.proc = undefined;
      ctx.starting = undefined;
      await dying.disposeAndWait(); // 自带 5s 上限，握手期进程也涵盖
    }
    // dispose 之后进程被静默，busy:false / result 都不会再来——不补这条复位，
    // 中途还原后 webview 会永远停在「回复中」：停止按钮常驻、光圈一直转、新消
    // 息全进等待队列，用户得再手点一次停止才能解套。（没进程在跑时是空操作。）
    this.post(ctx, { kind: "busy", busy: false });

    // 2) 校验已过、进程已停——派生替换 + 回滚文件 + 迁移还原点（见 forkRewind）。
    let rewind: { result: NonNullable<ReturnType<CheckpointManager["restore"]>>; rewoundToStart: boolean };
    try {
      rewind = await this.forkRewind(ctx, checkpointId, meta.truncateLine);
    } catch (err) {
      this.output.appendLine(`[restore] 派生失败: ${String(err)}`);
      this.post(ctx, { kind: "error", message: `还原失败：${String(err)}。会话与文件均未改动。` });
      return;
    }
    const { result, rewoundToStart } = rewind;
    this.output.appendLine(
      `[restore] truncateLine=${result.truncateLine} 还原文件=${result.restoredFiles} 自动停止=${wasLive ? "是" : "否"} ` +
        `${rewoundToStart ? "→ 回到开头，转为新对话" : `→ 已派生替换为 ${ctx.sessionId?.slice(0, 8)}`}`,
    );
    if (rewoundToStart) {
      this.post(ctx, { kind: "load_history", items: [], checkpoints: [] });
    } else {
      const items = this.store.load(ctx.sessionId!);
      this.post(ctx, { kind: "load_history", items, sessionId: ctx.sessionId, checkpoints: this.checkpointsForView(ctx, ctx.sessionId!) });
      // load_history 会清空上下文环（等下一轮用量再刷新），但还原后进程已被杀、
      // 也不走"打开会话"，环会一直空到用户发下一条消息才回来。截断后的用量可以
      // 直接从 transcript 估出来——立刻补一次，环随即显示回退后的真实占用。
      this.postSessionContext(ctx, ctx.sessionId!);
    }

    const skippedNote = result.skipped.length
      ? `⚠️ ${result.skipped.length} 个文件因过大或为二进制无法还原：${result.skipped.map((p) => path.basename(p)).join("、")}。`
      : "";
    this.post(ctx, {
      kind: "notice",
      message:
        `${wasLive ? "已自动停止进行中的回复。" : ""}` +
        `已还原 ${result.restoredFiles} 个文件，并把对话回退到这条消息之前。${skippedNote}下一条消息将从这里继续。`,
    });
    // 被回退掉的那轮提问自动带回输入框（含随附图片），方便改完重发（webview
    // 侧输入框非空时不覆盖）；同步宿主侧留底，看门狗重建 webview 后也不丢。
    // 纯图片轮次存的占位符「(图片)」不是用户打的字，不塞进输入框。
    const draftText = result.userText === "(图片)" ? "" : result.userText;
    const draftImages = nextTurn?.images.length ? nextTurn.images : undefined;
    if (draftText || draftImages) {
      ctx.draft = draftText;
      ctx.draftImages = draftImages;
      this.post(ctx, { kind: "draft", text: draftText, images: draftImages });
    }
    this.refreshChangedFiles(ctx);
  }

  // -- Process management --------------------------------------------------

  private ensureProcess(ctx: SessionCtx): Promise<ClaudeProcess | undefined> {
    // `starting` first: spawnProcess assigns ctx.proc BEFORE the initialize
    // handshake finishes, and sendUserMessage on an uninitialized proc rejects
    // the send (returns false). Wait for the in-flight start instead.
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
      proc.dispose(); // reap the half-started child
      // Stale 守卫（对照 onProcessClose）：握手期这个进程可能已被换掉
      // （/clear、setEffort 等 dispose 老进程后立刻挂了新进程）——那时
      // ctx.proc 指向的是新进程，这里再清引用/报错会打断正常工作的后继者。
      if (ctx.proc !== proc) return undefined;
      // 找不到可执行文件是最常见的配置错误，直接给出修复指引（SDK 引擎的
      // 原始报错只说 "executable not found at ..."，用户不知道该改哪里）。
      const raw = String(err);
      const hint = /not found|ENOENT|no such file/i.test(raw)
        ? `\n请检查设置 claudeChat.claudePath，或确认 \`claude\` 在 PATH 中（终端里 \`claude --version\` 能跑通）。`
        : "";
      this.post(ctx, { kind: "error", message: `初始化 claude 失败: ${raw}${hint}` });
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

  /** "有效上下文体量"：最后一次 /compact 边界之后的字节数。
   *  transcript 是只追加的，压缩不会让文件变小——直接用文件大小判断"太大了"，
   *  用户压缩完之后仍然超限，于是预热被永久关掉、"建议压缩"反复弹。
   *  按压缩边界之后的部分衡量才反映真实上下文。 */
  private effectiveTranscriptSize(sid: string): number {
    const f = this.store.findFile(sid);
    if (!f) return 0;
    try {
      const size = fs.statSync(f).size;
      if (size < ChatViewProvider.PREWARM_MIN_SIZE) return size; // 小文件不必扫
      // 只读尾部：本机实测最大的 transcript 有 110MB，全量 readFileSync 会让
      // 扩展宿主同步卡住并瞬时吃掉上百 MB 内存。边界若不在这段尾巴里，说明
      // 它之后的内容已经超过窗口大小——直接按"很大"处理即可，结论不受影响。
      const WINDOW = 16 * 1024 * 1024;
      const tailLen = Math.min(size, WINDOW);
      const buf = Buffer.alloc(tailLen);
      const fd = fs.openSync(f, "r");
      try {
        fs.readSync(fd, buf, 0, tailLen, size - tailLen);
      } finally {
        fs.closeSync(fd);
      }
      // 子代理（isSidechain）自己也会压缩，它的边界不代表主会话被压过——
      // 命中后要回到整行确认，是 sidechain 就继续往前找。
      let from = tailLen;
      for (let i = 0; i < 8; i++) {
        const idx = buf.lastIndexOf('"subtype":"compact_boundary"', from - 1);
        if (idx < 0) break;
        const lineStart = buf.lastIndexOf(0x0a, idx) + 1; // \n
        let lineEnd = buf.indexOf(0x0a, idx);
        if (lineEnd < 0) lineEnd = tailLen;
        let sidechain = false;
        try {
          sidechain = JSON.parse(buf.toString("utf8", lineStart, lineEnd))?.isSidechain === true;
        } catch {
          /* 半行/损坏：当成主会话边界，宁可保守 */
        }
        if (!sidechain) return tailLen - idx;
        from = idx;
      }
      return size; // 尾部没有主会话的压缩边界
    } catch {
      return this.transcriptSize(sid);
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

  /** 从提示按钮触发的压缩：复用面板 compact 的完整链路（含看门狗保护）。 */
  private async compactSession(ctx: SessionCtx): Promise<void> {
    // 弹窗是非模态的，用户可能过很久才点。这期间 tab 可能已经关了——给一个
    // 谁都不持有的 ctx 起进程，就是个永远不会被回收的孤儿。
    if (!this.alive(ctx)) {
      vscode.window.showInformationMessage("该会话的窗口已关闭，请重新打开会话后再压缩。");
      return;
    }
    if (ctx.proc?.isBusy) {
      vscode.window.showInformationMessage("当前会话正在回复中，等这一轮结束再压缩。");
      return;
    }
    const proc = await this.ensureProcess(ctx);
    if (!proc) {
      this.post(ctx, { kind: "busy", busy: false });
      vscode.window.showErrorMessage("启动 Claude 失败，无法压缩。");
      return;
    }
    if (!this.alive(ctx)) {
      vscode.window.showInformationMessage("会话窗口已关闭，本次压缩已取消。");
      return;
    }
    this.post(ctx, { kind: "busy", busy: true });
    proc.compact();
    ctx.lastEventAt = Date.now();
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
    // 超大会话的预热是笔亏本买卖：实测 16.7MB 的会话预热完 1 分钟后发送，首字
    // 延迟仍有 13.4 秒（没焐上），但 token 照花。这种会话该 /compact，不该硬焐。
    const capMB = this.config().get<number>("prewarmMaxSizeMB", 12);
    // 用压缩边界之后的体量：压缩过的会话不该再被判为"超大"。
    const sizeMB = this.effectiveTranscriptSize(sid) / 1_000_000;
    if (capMB > 0 && sizeMB > capMB) {
      this.output.appendLine(
        `[prewarm] ${sid.slice(0, 8)} skipped: 会话 ${sizeMB.toFixed(1)}MB 超过预热上限 ${capMB}MB（预热成本高且收效甚微，建议 /compact 压缩上下文）`,
      );
      // 官方 Resume-from-summary 的同款思路：不硬焐，提示用户一键压缩。
      if (!this.compactPrompted.has(sid)) {
        this.compactPrompted.add(sid);
        void vscode.window
          .showWarningMessage(
            `会话已达 ${sizeMB.toFixed(1)}MB，每条回复都要重读全部历史（首条会慢几十秒）。建议压缩上下文：保留要点、大幅提速。`,
            "立即压缩",
          )
          .then((pick) => {
            if (pick === "立即压缩") void this.compactSession(ctx);
          });
      }
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
  /** 会话列表里被用户置顶的 sessionId 集合（存 globalState，跨窗口/重启保留）。 */
  private static readonly PINNED_KEY = "claudeChat.pinnedSessions";

  /** 读出置顶集合。删除会话时旧 id 会残留，但只是查表命中不到、无副作用。 */
  private pinnedSet(): Set<string> {
    return new Set(this.context.globalState.get<string[]>(ChatViewProvider.PINNED_KEY) ?? []);
  }

  /** 给会话摘要打上 pinned 标记（列表分组用），顺序不变，仍按 updatedAt 降序。 */
  private withPinned(list: SessionSummary[]): SessionSummary[] {
    const pinned = this.pinnedSet();
    return list.map((s) => (pinned.has(s.id) ? { ...s, pinned: true } : s));
  }

  /** 置顶/取消置顶后写回 globalState 并刷新侧边栏。 */
  private async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    const set = this.pinnedSet();
    if (pinned) set.add(sessionId);
    else set.delete(sessionId);
    await this.context.globalState.update(ChatViewProvider.PINNED_KEY, [...set]);
    this.refreshSessions();
  }

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

  /** 「推送通知」独立配置面板：读写 VS Code 设置（与设置页互通），带测试按钮。 */
  showNotifyConfig(): void {
    if (this.notifyPanel) {
      this.notifyPanel.reveal();
      this.postNotifyConfig();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "claude-chat.notify",
      "任务推送",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.notifyPanel = panel;
    panel.webview.html = this.notifyHtml();
    panel.webview.onDidReceiveMessage(async (m: FromWebview) => {
      try {
        switch (m.type) {
          case "webviewError":
            this.output.appendLine(`[${new Date().toISOString()}] [webview] 推送面板脚本错误: ${m.message}`);
            break;
          case "notifyLoad":
            this.postNotifyConfig();
            break;
          case "notifySave": {
            const cfg = vscode.workspace.getConfiguration("claudeChat");
            await cfg.update("notifyWebhook", m.webhook.trim(), vscode.ConfigurationTarget.Global);
            await cfg.update("notifyMinDurationSec", Math.max(0, Math.round(m.minSec) || 0), vscode.ConfigurationTarget.Global);
            panel.webview.postMessage({ kind: "notify_result", ok: true, message: "已保存。" } satisfies ToWebview);
            break;
          }
          case "notifyTest": {
            const url = m.webhook.trim();
            if (!url) {
              panel.webview.postMessage({ kind: "notify_result", ok: false, message: "请先填写 webhook 地址。" } satisfies ToWebview);
              break;
            }
            const r = await this.sendWebhook(url, "🔔 ClaudeCopilot 推送测试：webhook 配置成功。", { test: true });
            panel.webview.postMessage({
              kind: "notify_result",
              ok: r.ok,
              message: r.ok ? `测试消息已发出（HTTP ${r.status}），请到群里确认。` : `发送失败：${r.error}`,
            } satisfies ToWebview);
            break;
          }
        }
      } catch (err) {
        this.output.appendLine(`[notify] 面板消息处理失败(${m.type}): ${String(err)}`);
      }
    });
    // 设置页里改了配置，已打开的面板同步刷新——"互通"要双向。
    const cfgSub = vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration("claudeChat.notifyWebhook") || ev.affectsConfiguration("claudeChat.notifyMinDurationSec")) {
        this.postNotifyConfig();
      }
    });
    panel.onDidDispose(() => {
      cfgSub.dispose();
      if (this.notifyPanel === panel) this.notifyPanel = undefined;
    });
  }

  private postNotifyConfig(): void {
    const cfg = vscode.workspace.getConfiguration("claudeChat");
    this.notifyPanel?.webview.postMessage({
      kind: "notify_config",
      webhook: cfg.get<string>("notifyWebhook") ?? "",
      minSec: cfg.get<number>("notifyMinDurationSec") ?? 60,
    } satisfies ToWebview);
  }

  private notifyHtml(): string {
    const nonce = randomUUID().replace(/-/g, "");
    return /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; display: flex; justify-content: center; }
  .wrap { width: 100%; max-width: 560px; padding: 24px 20px 40px; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; }
  h2 { margin: 0; font-size: 16px; }
  label.f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
  label.f > span { font-weight: 600; opacity: .85; }
  input[type=text], input[type=number] { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,.35)); border-radius: 6px; padding: 7px 9px; font: inherit; font-size: 12.5px; }
  input:focus { outline: none; border-color: var(--vscode-focusBorder, #3794ff); }
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
  .sub { font-size: 11px; opacity: .65; line-height: 1.7; }
</style>
</head>
<body>
<div class="wrap">
  <h2>🔔 任务推送</h2>
  <div class="sub">长任务跑完时向 webhook 推一条通知：任务耗时达到阈值即推送。Claude 停下来等你输入（工具授权 / 选项提问）且你离开超过同一阈值时，也会推一条「等你输入」。</div>
  <label class="f"><span>Webhook 地址</span><input id="webhook" type="text" spellcheck="false" placeholder="飞书/企业微信/钉钉群机器人的 webhook，或任意接收 JSON 的地址" /></label>
  <label class="f"><span>耗时阈值（秒）</span><input id="minsec" type="number" min="0" step="10" placeholder="60" /></label>
  <div id="status" class="status hidden"></div>
  <div class="acts">
    <button id="test" class="btn">发送测试消息</button>
    <button id="save" class="btn primary">保存</button>
  </div>
  <div class="sub">飞书 / 企业微信 / 钉钉的群机器人按域名自动适配报文格式，直接收到文本；其他地址收到通用 JSON：{ text, isError, durationMs, project, question }（等待输入的推送另带 waiting:true 与 ask）。配置与 VS Code 设置（claudeChat.notifyWebhook / notifyMinDurationSec）互通。</div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.addEventListener("error", (e) => {
    try { vscode.postMessage({ type: "webviewError", message: (e.message || "?") + " @notify:" + e.lineno }); } catch {}
  });
  const $ = (id) => document.getElementById(id);
  function status(text, kind) {
    const el = $("status");
    el.textContent = text || "";
    el.className = "status" + (text ? "" : " hidden") + (kind ? " " + kind : "");
  }
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.kind === "notify_config") {
      $("webhook").value = m.webhook || "";
      $("minsec").value = m.minSec;
    } else if (m.kind === "notify_result") {
      status(m.message, m.ok ? "ok" : "err");
    }
  });
  $("save").addEventListener("click", () => {
    // 阈值留空按默认 60 处理——空值存成 0 会变成"任何时长都推"，与占位符暗示不符
    const raw = $("minsec").value.trim();
    vscode.postMessage({ type: "notifySave", webhook: $("webhook").value, minSec: raw === "" ? 60 : Number(raw) });
  });
  $("test").addEventListener("click", () => {
    status("发送中…");
    vscode.postMessage({ type: "notifyTest", webhook: $("webhook").value });
  });
  vscode.postMessage({ type: "notifyLoad" });
</script>
</body>
</html>`;
  }


  /** 独立的 SLS 多账号配置面板：卡片列表 → 详情编辑两级结构。 */
  private slsHtml(): string {
    const nonce = randomUUID().replace(/-/g, "");
    return /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; display: flex; justify-content: center; }
  .wrap { width: 100%; max-width: 620px; padding: 22px 20px 48px; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; }
  h2 { margin: 0; font-size: 16px; }
  h3 { margin: 0; font-size: 14px; }
  .hint { font-size: 12px; opacity: .75; line-height: 1.7; margin: -4px 0 2px; }
  .hidden { display: none !important; }
  /* 两个视图都是纵向堆叠、统一间距 */
  #view-list, #view-detail { display: flex; flex-direction: column; gap: 14px; }
  /* ---- 列表视图 ---- */
  .sec-h { display: flex; align-items: baseline; gap: 8px; margin-top: 4px; }
  .sec-h .t { font-size: 12px; font-weight: 600; opacity: .85; }
  .sec-h .c { font-size: 11px; opacity: .55; }
  .cards { display: flex; flex-direction: column; gap: 10px; }
  .card { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.28)); border-radius: 10px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.06)); cursor: pointer; transition: border-color .12s, background .12s, transform .12s; }
  .card:hover { border-color: var(--vscode-focusBorder, #3794ff); background: var(--vscode-list-hoverBackground, rgba(127,127,127,.12)); }
  .card .ic { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: rgba(127,127,127,.12); color: var(--vscode-foreground); }
  .card .ic svg { width: 20px; height: 20px; opacity: .85; }
  .card .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .card .nm { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .meta { font-size: 11.5px; opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .right { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; }
  .card .pill { font-size: 10.5px; padding: 3px 9px; border-radius: 9px; white-space: nowrap; }
  .card .pill.ok { color: #3fb950; background: rgba(63,185,80,.14); }
  .card .pill.no { color: var(--vscode-descriptionForeground, #999); background: rgba(127,127,127,.14); }
  .card .del { width: 26px; height: 26px; padding: 0; border: none; border-radius: 6px; background: none; color: var(--vscode-descriptionForeground, #999); cursor: pointer; font-size: 16px; line-height: 1; opacity: .6; }
  .card:hover .del { opacity: 1; }
  .card .del:hover { color: var(--vscode-errorForeground, #e5534b); background: rgba(127,127,127,.15); }
  .card .chev { color: var(--vscode-descriptionForeground, #999); opacity: .5; font-size: 14px; }
  .add-card { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; box-sizing: border-box; padding: 14px; border: 1px dashed var(--vscode-panel-border, rgba(127,127,127,.45)); border-radius: 10px; background: none; color: var(--vscode-foreground); cursor: pointer; font: inherit; font-size: 12.5px; opacity: .85; }
  .add-card:hover { opacity: 1; border-color: var(--vscode-focusBorder, #3794ff); background: var(--vscode-list-hoverBackground, rgba(127,127,127,.08)); }
  /* ---- 详情视图 ---- */
  .detail-head { display: flex; align-items: center; gap: 10px; }
  .back { flex: 0 0 auto; font: inherit; font-size: 12.5px; cursor: pointer; border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); border-radius: 6px; background: none; color: var(--vscode-foreground); padding: 5px 11px; }
  .back:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.15)); }
  label.f, .f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
  label.f > span, .f > span { font-weight: 600; opacity: .85; }
  input[type=text], input[type=password], textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,.35)); border-radius: 6px; padding: 7px 9px; font: inherit; font-size: 12.5px; }
  input:focus, textarea:focus { outline: none; border-color: var(--vscode-focusBorder, #3794ff); }
  textarea { min-height: 120px; resize: vertical; font-family: var(--vscode-editor-font-family, ui-monospace, monospace); line-height: 1.5; }
  textarea.bad { border-color: var(--vscode-errorForeground, #e5534b); }
  .pw { display: flex; gap: 6px; }
  .pw input { flex: 1; }
  .eye { flex: 0 0 auto; width: 36px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--vscode-input-border, rgba(127,127,127,.35)); border-radius: 6px; background: none; color: var(--vscode-descriptionForeground, #999); cursor: pointer; }
  .eye:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.15)); }
  .lsh { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .lsh > span:first-child { font-weight: 600; opacity: .85; font-size: 12px; }
  .lsh .btns { display: flex; gap: 6px; }
  .mini { font: inherit; font-size: 12px; cursor: pointer; border-radius: 6px; border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); background: none; color: var(--vscode-foreground); padding: 5px 10px; }
  .mini:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.15)); }
  .envs { display: flex; flex-direction: column; gap: 6px; }
  .env-row { display: flex; gap: 6px; align-items: center; }
  .env-row input { flex: 1; }
  .env-row .del { flex: 0 0 auto; width: 28px; padding: 0; height: 30px; border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); border-radius: 6px; background: none; color: var(--vscode-errorForeground, #e5534b); cursor: pointer; }
  .env-add { align-self: flex-start; font: inherit; font-size: 12px; cursor: pointer; border: 1px dashed var(--vscode-panel-border, rgba(127,127,127,.4)); border-radius: 6px; background: none; color: var(--vscode-foreground); padding: 5px 10px; }
  .sub { font-size: 11px; opacity: .65; line-height: 1.7; }
  .sub code { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.14)); padding: 1px 5px; border-radius: 4px; }
  .status { font-size: 12px; line-height: 1.6; padding: 7px 10px; border-radius: 6px; white-space: pre-wrap; word-break: break-all; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12)); }
  .status.hidden { display: none; }
  .status.ok { color: #3fb950; }
  .status.err { color: var(--vscode-errorForeground, #e5534b); }
  .status.wait { opacity: .8; }
  .imp { font-size: 11px; opacity: .7; line-height: 1.6; }
  .imp:empty { display: none; }
  .acts { display: flex; gap: 10px; margin-top: 2px; }
  button.btn { flex: 1; padding: 8px 0; font: inherit; font-size: 12.5px; cursor: pointer; border-radius: 6px; border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); background: none; color: var(--vscode-foreground); }
  button.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  button.btn.danger { color: var(--vscode-errorForeground, #e5534b); border-color: rgba(229,83,75,.4); flex: 0 0 auto; padding: 8px 14px; }
  button.btn:hover { filter: brightness(1.1); }
  button.btn:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<div class="wrap">
  <h2>SLS 日志配置</h2>

  <div id="view-list">
    <p class="hint">配置后 Claude 可直接查询阿里云 SLS 后端日志。<b>不同阿里云账号各建一个配置</b>，查询时按业务项目名自动路由到对应账号。建议用只读子账号 AccessKey，仅存本机（权限 600）。</p>
    <div class="sec-h"><span class="t">账号</span><span id="cnt" class="c"></span></div>
    <div id="cards" class="cards"></div>
    <button id="add" class="add-card">＋ 新增账号配置</button>
  </div>

  <div id="view-detail" class="hidden">
    <div class="detail-head">
      <button id="back" class="back">← 返回</button>
      <h3 id="detail-title">编辑账号</h3>
    </div>
    <label class="f"><span>账号名</span><input id="acct-name" type="text" placeholder="如 gameserver（用于区分与自动路由）" spellcheck="false" /></label>
    <label class="f"><span>Endpoint（地域）</span><input id="endpoint" type="text" placeholder="cn-hangzhou.log.aliyuncs.com" spellcheck="false" /></label>
    <label class="f"><span>AccessKey ID</span><input id="ak-id" type="text" placeholder="LTAI…" spellcheck="false" autocomplete="off" /></label>
    <div class="f"><span>AccessKey Secret</span>
      <div class="pw"><input id="ak-secret" type="password" placeholder="仅存本机" spellcheck="false" autocomplete="off" /><button id="ak-eye" class="eye" type="button" title="显示/隐藏"></button></div>
    </div>
    <div class="f">
      <div class="lsh"><span>环境 → SLS Project</span></div>
      <div id="envs" class="envs"></div>
      <div class="sub"><code>dev</code>=测试/开发、<code>pro</code>=生产/线上；也可自定义环境名。留空的行保存时自动忽略。</div>
    </div>
    <div class="f">
      <div class="lsh"><span>项目日志映射（JSON）</span>
        <div class="btns"><button id="gen" class="mini" title="让 Claude 扫描工作区 Spring Boot 配置自动生成，需先填好连接信息并保存">AI 生成配置</button>
          <button id="tpl" class="mini" title="测试连接后可根据实际 logstore 生成模板">生成模板</button></div></div>
      <textarea id="logs" spellcheck="false" placeholder='{&#10;  "order": { "info": "order-info", "error": "order-error" },&#10;  "user":  { "info": "user-info",  "error": "user-error" }&#10;}'></textarea>
      <div class="sub">每个业务项目 → info / 异常两个 logstore，各环境共用此映射。查询示例：<code>sls -q "*" --env pro --app order</code>（默认查 error，加 <code>--kind info</code> 查 info）。</div>
    </div>
    <div id="status" class="status hidden"></div>
    <div id="imp" class="imp"></div>
    <div class="acts">
      <button id="test" class="btn">测试连接</button>
      <button id="save" class="btn primary">保存</button>
      <button id="del-detail" class="btn danger">删除</button>
    </div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.addEventListener("error", (e) => { try { vscode.postMessage({ type: "webviewError", message: String(e.message || e) }); } catch {} });
  const $ = (id) => document.getElementById(id);
  const EYE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;display:block"><path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="2"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;display:block"><path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 2.5l11 11"/></svg>';
  let accounts = [], editing = -1, lastStores = [];

  function seed() { return { name: "", endpoint: "", accessKeyId: "", accessKeySecret: "", projects: { dev: "", pro: "" }, logs: {} }; }
  function configured(a) { return !!(a.endpoint && a.logs && Object.keys(a.logs).length); }

  // ---- 视图切换 ----
  function showList() { editing = -1; $("view-detail").classList.add("hidden"); $("view-list").classList.remove("hidden"); renderCards(); }
  function showDetail(i) { editing = i; fillForm(accounts[i]); $("detail-title").textContent = accounts[i].name ? ("编辑 · " + accounts[i].name) : "新账号"; $("view-list").classList.add("hidden"); $("view-detail").classList.remove("hidden"); $("del-detail").classList.toggle("hidden", accounts.length <= 1); }

  // ---- 列表卡片 ----
  function renderCards() {
    const box = $("cards"); box.innerHTML = "";
    accounts.forEach((a, i) => {
      const card = document.createElement("div"); card.className = "card";
      const ic = document.createElement("div"); ic.className = "ic";
      ic.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/></svg>';
      const body = document.createElement("div"); body.className = "body";
      const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = a.name || ("账号" + (i + 1));
      const meta = document.createElement("div"); meta.className = "meta";
      const napp = a.logs ? Object.keys(a.logs).length : 0;
      meta.textContent = a.endpoint ? (a.endpoint + " · " + napp + " 个项目") : "未配置";
      body.append(nm, meta);
      const pill = document.createElement("span"); const ok = configured(a);
      pill.className = "pill " + (ok ? "ok" : "no"); pill.textContent = ok ? "已配置" : "未完成";
      const del = document.createElement("button"); del.className = "del"; del.title = "删除此账号"; del.textContent = "×";
      del.addEventListener("click", (e) => { e.stopPropagation(); if (accounts.length <= 1) { accounts = [seed()]; } else { accounts.splice(i, 1); } persist(); renderCards(); });
      const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "›";
      const right = document.createElement("div"); right.className = "right"; right.append(pill, del, chev);
      card.append(ic, body, right);
      card.addEventListener("click", () => showDetail(i));
      box.appendChild(card);
    });
    $("cnt").textContent = accounts.length + " 个";
  }

  // ---- 环境行 ----
  function envRow(env, project) {
    const row = document.createElement("div"); row.className = "env-row";
    const a = document.createElement("input"); a.type = "text"; a.className = "env"; a.placeholder = "环境名"; a.spellcheck = false; a.value = env || "";
    const b = document.createElement("input"); b.type = "text"; b.className = "proj"; b.placeholder = "SLS Project 名"; b.spellcheck = false; b.value = project || "";
    const d = document.createElement("button"); d.type = "button"; d.className = "del"; d.title = "删除此环境"; d.textContent = "×";
    d.addEventListener("click", () => row.remove());
    row.append(a, b, d); return row;
  }
  function renderEnvs(projects) {
    const box = $("envs"); box.innerHTML = "";
    const entries = Object.entries(projects || {});
    (entries.length ? entries : [["dev", ""], ["pro", ""]]).forEach(([e, p]) => box.appendChild(envRow(e, p)));
    const add = document.createElement("button"); add.type = "button"; add.className = "env-add"; add.textContent = "+ 新增环境";
    add.addEventListener("click", () => { const r = envRow("", ""); box.insertBefore(r, add); r.querySelector(".env").focus(); });
    box.appendChild(add);
  }
  function collectEnvs() {
    const out = {};
    for (const row of $("envs").querySelectorAll(".env-row")) { const e = row.querySelector(".env").value.trim(); if (e) out[e] = row.querySelector(".proj").value.trim(); }
    return out;
  }

  // ---- 表单 <-> 账号 ----
  function fillForm(a) {
    a = a || seed();
    $("acct-name").value = a.name || "";
    $("endpoint").value = a.endpoint || "";
    $("ak-id").value = a.accessKeyId || "";
    $("ak-secret").value = a.accessKeySecret || ""; $("ak-secret").type = "password"; $("ak-eye").innerHTML = EYE;
    renderEnvs(a.projects || {});
    const logs = a.logs || {};
    $("logs").value = Object.keys(logs).length ? JSON.stringify(logs, null, 2) : "";
    $("logs").classList.remove("bad");
    status(""); showStores([]);
  }
  function parseLogs() {
    const raw = $("logs").value.trim();
    if (!raw) return { ok: true, logs: {} };
    try { const o = JSON.parse(raw); if (typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "最外层必须是对象 { 项目: {...} }" }; return { ok: true, logs: o }; }
    catch (e) { return { ok: false, error: "JSON 格式错误：" + (e && e.message ? e.message : e) }; }
  }
  function collectForm() {
    const r = parseLogs();
    return { name: $("acct-name").value.trim(), endpoint: $("endpoint").value.trim(), accessKeyId: $("ak-id").value.trim(),
      accessKeySecret: $("ak-secret").value.trim(), projects: collectEnvs(), logs: r.ok ? r.logs : (accounts[editing] && accounts[editing].logs) || {} };
  }
  function saveEditingIntoState() { if (editing >= 0) accounts[editing] = collectForm(); }
  function persist() { vscode.postMessage({ type: "slsSave", accounts }); }

  function loadAccounts(list) {
    accounts = (list && list.length ? list : [seed()]).map((a) => Object.assign(seed(), a));
    if (editing >= 0 && editing < accounts.length) { fillForm(accounts[editing]); } else { showList(); }
  }

  // ---- 事件 ----
  $("add").addEventListener("click", () => { accounts.push(seed()); showDetail(accounts.length - 1); $("acct-name").focus(); });
  $("back").addEventListener("click", () => { saveEditingIntoState(); showList(); });
  $("del-detail").addEventListener("click", () => { if (accounts.length <= 1) { accounts = [seed()]; } else { accounts.splice(editing, 1); } persist(); showList(); });
  $("acct-name").addEventListener("input", () => { $("detail-title").textContent = $("acct-name").value ? ("编辑 · " + $("acct-name").value) : "新账号"; });
  $("ak-eye").addEventListener("click", () => { const el = $("ak-secret"); const show = el.type === "password"; el.type = show ? "text" : "password"; $("ak-eye").innerHTML = show ? EYE_OFF : EYE; });
  $("gen").addEventListener("click", () => { vscode.postMessage({ type: "slsGenerate" }); status("已在聊天里预填生成指令，回车即可让 Claude 扫描工作区并写入映射；写完这里会自动刷新。", "wait"); });
  $("tpl").addEventListener("click", () => {
    if (!lastStores.length) { status("请先“测试连接”，拉到实际 logstore 后再生成模板", "wait"); return; }
    const cur = parseLogs(); const base = cur.ok ? cur.logs : {};
    lastStores.forEach((sname) => {
      const low = sname.toLowerCase(); let kind = /error|err|exception|异常|warn/.test(low) ? "error" : /info|stdout|std/.test(low) ? "info" : null;
      let app = sname.replace(/[-_](info|error|err|warn|stdout|std)$/i, "");
      if (!base[app]) base[app] = {}; if (kind) base[app][kind] = sname; else { base[app].info = base[app].info || sname; base[app].error = base[app].error || sname; }
    });
    $("logs").value = JSON.stringify(base, null, 2); $("logs").classList.remove("bad");
    status("已按 logstore 名生成映射模板，请核对 info/error 是否对应正确", "ok");
  });
  $("test").addEventListener("click", () => { setBusy(true); status("正在测试连接…（首次会自动安装查询引擎，稍等十几秒）", "wait"); vscode.postMessage({ type: "slsTest", config: collectForm() }); });
  $("save").addEventListener("click", () => {
    const r = parseLogs();
    if (!r.ok) { $("logs").classList.add("bad"); status(r.error, "err"); return; }
    $("logs").classList.remove("bad"); saveEditingIntoState(); setBusy(true); status("正在保存…", "wait"); persist();
  });

  function status(text, kind) { const el = $("status"); el.textContent = text || ""; el.className = "status" + (text ? "" : " hidden") + (kind ? " " + kind : ""); }
  function setBusy(b) { $("test").disabled = b; $("save").disabled = b; }
  function showStores(stores) { $("imp").textContent = (stores && stores.length) ? ("共 " + stores.length + " 个 logstore：" + stores.join("、")) : ""; }

  window.addEventListener("message", (ev) => {
    const m = ev.data; if (!m) return;
    if (m.kind === "sls_config" || m.kind === "sls_open") { loadAccounts(m.accounts); }
    else if (m.kind === "sls_result") { setBusy(false); status(m.message, m.ok ? "ok" : "err"); lastStores = (m.ok && m.action === "test" && m.stores) ? m.stores : []; showStores(lastStores); if (m.ok && m.action === "save" && editing >= 0) showList(); }
  });
  vscode.postMessage({ type: "slsLoad" });
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

  // -- QQ 机器人单实例锁（跨 VS Code 窗口）---------------------------------
  // 每个窗口都是独立的扩展宿主，各自会去连机器人：同一条 QQ 消息被两个窗口
  // 各跑一遍 Claude、回两次。用一个带心跳的锁文件选主，只有持锁窗口连机器人。
  private static readonly QQ_LOCK_TTL = 90_000;
  private readonly qqLockOwner = `${process.pid}-${Date.now()}`;
  private qqLockTimer?: ReturnType<typeof setInterval>;
  private qqHoldsLock = false;

  private qqLockFile(): string {
    return path.join(os.homedir(), ".claude-chat", "qq-bot.lock");
  }

  /** 读当前锁持有者。文件不存在/损坏都返回 undefined。 */
  private readQQLock(): { owner?: string; at?: number } | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.qqLockFile(), "utf8"));
    } catch {
      return undefined;
    }
  }

  /** 写锁文件。用 tmp+rename 保证原子，避免别的窗口读到写了一半的内容
   *  （truncate 后、写入前那一瞬读到空文件，会被当成"没人持锁"）。 */
  private writeQQLock(): boolean {
    const file = this.qqLockFile();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ owner: this.qqLockOwner, at: Date.now() }), "utf8");
      fs.renameSync(tmp, file);
      return true;
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  /** 独占创建锁文件（O_EXCL）。这是唯一真正原子的一步：两个窗口同时创建，
   *  内核保证只有一个成功——"写完再回读确认"挡不住 A 写→A 回读→B 写→B 回读
   *  这种交错（两边都会认为自己赢）。 */
  private createQQLockExclusive(): boolean {
    const file = this.qqLockFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, "wx"); // wx = 必须由我创建，已存在就抛
      try {
        fs.writeSync(fd, JSON.stringify({ owner: this.qqLockOwner, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 抢锁：没人占、锁过期、或本来就是自己的，都算抢到。 */
  private acquireQQLock(): boolean {
    try {
      // ① 没有锁文件 —— 独占创建，赢者唯一。
      if (this.createQQLockExclusive()) {
        this.qqHoldsLock = true;
        return true;
      }
      const cur = this.readQQLock();
      // ② 本来就是自己的锁：续期即可。
      if (cur?.owner === this.qqLockOwner) {
        this.qqHoldsLock = this.writeQQLock();
        if (!this.qqHoldsLock) {
          this.output.appendLine(`[${new Date().toISOString()}] [qq] 锁文件写入失败，本窗口不启动机器人`);
        }
        return this.qqHoldsLock;
      }
      // ③ 别人持有且还新鲜：认输。
      const fresh = cur?.at && Date.now() - cur.at < ChatViewProvider.QQ_LOCK_TTL;
      if (fresh) return false;
      // ④ 过期锁（原持有窗口崩了）：先把它 rename 挪走再独占创建。
      // 不能直接 unlink——多进程实测 unlink+create 会让 3 个窗口同时"接管成功"：
      // B 的 unlink 把 A 刚创建好的新锁删掉了。rename 是原子的，源文件只有一个
      // 进程能挪走，其余的拿到 ENOENT，天然选出唯一赢家。
      const stale = `${this.qqLockFile()}.stale.${this.qqLockOwner}`;
      try {
        fs.renameSync(this.qqLockFile(), stale);
      } catch {
        this.qqHoldsLock = false; // 别的窗口先挪走了，这轮认输
        return false;
      }
      // 再确认一次挪走的确实是过期锁：从"读到过期"到"挪走"之间，可能已经有
      // 别的窗口完成接管并写入了新锁——那样我们刚挪走的是人家的有效锁。
      // （多进程实测就是这条路径导致两个窗口同时接管成功。）误伤就放回去。
      let moved: { owner?: string; at?: number } | undefined;
      try {
        moved = JSON.parse(fs.readFileSync(stale, "utf8"));
      } catch {
        /* 读不出来就按过期处理 */
      }
      if (moved?.at && Date.now() - moved.at < ChatViewProvider.QQ_LOCK_TTL) {
        try {
          fs.renameSync(stale, this.qqLockFile()); // 放回
        } catch {
          try {
            fs.unlinkSync(stale);
          } catch {
            /* ignore */
          }
        }
        this.qqHoldsLock = false;
        return false;
      }
      try {
        fs.unlinkSync(stale);
      } catch {
        /* ignore */
      }
      if (this.createQQLockExclusive()) {
        this.qqHoldsLock = true;
        return true;
      }
      this.qqHoldsLock = false; // 挪走后被别人抢先创建了
      return false;
    } catch {
      this.qqHoldsLock = false;
      return false;
    }
  }

  /** 续期。续期前先确认锁还是自己的——宿主被长时间阻塞（合盖、超大会话渲染）
   *  超过 TTL 后别的窗口会合法接管，这时必须让位，而不是把 owner 盖回来
   *  （盖回去就成了两个 bot 互相覆盖、永不收敛）。返回 false = 已失去锁。 */
  private renewQQLock(): "ok" | "lost" | "io-error" {
    if (!this.qqHoldsLock) return "lost";
    const cur = this.readQQLock();
    if (cur?.owner && cur.owner !== this.qqLockOwner) {
      this.qqHoldsLock = false;
      return "lost"; // 真的被接管了，必须让位
    }
    // 写失败只是磁盘/权限的一时问题，不能当成"被别的窗口抢走"——那会在
    // 单窗口环境下把好端端的机器人停掉，还提示一个不存在的窗口抢走了它。
    return this.writeQQLock() ? "ok" : "io-error";
  }

  private releaseQQLock(): void {
    if (!this.qqHoldsLock) return;
    this.qqHoldsLock = false;
    try {
      if (this.readQQLock()?.owner === this.qqLockOwner) fs.unlinkSync(this.qqLockFile());
    } catch {
      /* ignore */
    }
  }

  /** 心跳 + 接管：持锁时续期；没抢到锁时定期重试，持锁窗口一关就自动顶上。 */
  private ensureQQLockTimer(): void {
    if (this.qqLockTimer) return;
    this.qqLockTimer = setInterval(() => {
      try {
        if (this.qqBot) {
          const r = this.renewQQLock();
          if (r === "lost") {
            // 本窗口卡了太久（合盖/长阻塞），锁已被合法接管。主动下线避免双 bot。
            this.output.appendLine(`[${new Date().toISOString()}] [qq] 锁已被其它窗口接管，本窗口停止机器人`);
            this.stopQQBot();
            this.setQQState("offline", "另一个 VS Code 窗口已接管机器人");
          } else if (r === "io-error") {
            this.output.appendLine(`[${new Date().toISOString()}] [qq] 锁续期写入失败（磁盘/权限？），保持运行，下个心跳重试`);
          }
          return;
        }
        if (!this.qqStored().enabled) return;
        // 没配好就别去抢锁：抢了也起不来，白白把持锁窗口的锁删掉一瞬间。
        if (!this.qqStored().appId) return;
        if (this.acquireQQLock()) {
          this.output.appendLine(`[${new Date().toISOString()}] [qq] 接管机器人（原持有窗口已退出）`);
          void this.startQQBot();
        }
      } catch {
        /* 心跳绝不能把宿主拖下水 */
      }
    }, 30_000);
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

  /** start/stop 的代际号：stopQQBot 与每次 startQQBot 都 +1。
   *  startQQBot 中间有 await（读 SecretStorage）——期间被关掉或被新的 start
   *  顶掉的话，旧调用恢复后不能再创建 bot（否则实例引用丢失、永远没人 stop）。 */
  private qqStartSeq = 0;

  private async startQQBot(): Promise<void> {
    // 注意：先读配置、再拆旧连接。反过来的话 stopQQBot 会先把锁删掉，而读
    // SecretStorage 是异步的（keychain 可能几百毫秒）——这段真空期里别的窗口
    // 会抢到锁，机器人就莫名其妙搬到了用户没操作的那个窗口。
    const seq = ++this.qqStartSeq;
    const cfg = this.qqStored();
    const secret = (await this.context.secrets.get(ChatViewProvider.QQ_SECRET_KEY)) ?? "";
    if (seq !== this.qqStartSeq) return; // await 期间被 stop / 新 start 作废
    const allowed = cfg.allowed.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
    if (!cfg.appId || !secret) {
      this.stopQQBot();
      this.setQQState("offline", "缺少 AppID / AppSecret");
      this.qqPanel?.webview.postMessage({ kind: "qq_result", ok: false, message: "请先填写 AppID 和 AppSecret 并保存" } satisfies ToWebview);
      return;
    }
    // 配置齐全，现在才拆旧连接（此时若本窗口持锁，锁会被释放又立刻抢回）。
    const heldLock = this.qqHoldsLock;
    this.stopQQBot();
    if (heldLock) this.acquireQQLock(); // 本来就是自己的锁，立即抢回，不给真空期
    // 跨窗口单实例：抢不到锁说明另一个 VS Code 窗口已经在跑机器人了，本窗口
    // 不再连接（否则同一条消息会被两个窗口各跑一遍、回两次）。
    this.ensureQQLockTimer();
    if (!this.acquireQQLock()) {
      this.output.appendLine(`[${new Date().toISOString()}] [qq] 另一个窗口已在运行机器人，本窗口跳过连接`);
      this.setQQState("offline", "另一个 VS Code 窗口已在运行机器人");
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
    this.qqStartSeq++; // 作废还悬在 startQQBot await 里的并发调用
    this.releaseQQLock(); // 让位给其它窗口
    this.qqBot?.stop();
    this.qqBot = undefined;
    this.qqProc?.dispose();
    this.qqProc = undefined;
    this.qqTurn = undefined;
    this.qqRunning = false; // 不重置的话重启后队列永远不再被消费
    this.qqQueue.length = 0;
    this.qqLastEventAt = undefined;
    this.qqCompacting = false;
    this.setQQState("offline");
  }

  /** 排队处理——机器人一次只跑一轮，避免多条消息串到同一个进程里互相打断。 */
  private onQQMessage(msg: QQIncoming): void {
    // /stop 必须绕过队列：排队的话要等本轮跑完才被处理，"中断"就没有意义了
    // （这正是它此前形同虚设的原因）。
    if (this.qqRunning && msg.text.trim().toLowerCase() === "/stop") {
      void this.qqInterrupt(msg);
      return;
    }
    this.qqQueue.push(msg);
    if (!this.qqRunning) void this.runQQTurn();
  }

  /** 立即中断当前轮次并清空队列（/stop 的插队通道）。 */
  private async qqInterrupt(msg: QQIncoming): Promise<void> {
    try {
      const t = this.qqTurn;
      const dropped = this.qqQueue.length;
      this.qqQueue.length = 0;
      if (t) t.done = true; // 迟到的 result / onClose 兜底都不要再回复
      this.qqTurn = undefined;
      this.qqRunning = false;
      this.qqLastEventAt = undefined;
      if (t) this.qqBot?.forget(t.target.msgId);
      try {
        if (this.qqProc?.isBusy) await this.qqProc.interrupt();
      } catch {
        this.qqProc?.dispose(); // 连中断都不响应的进程直接丢弃，下轮重建
        this.qqProc = undefined;
      }
      await this.qqBot?.reply(
        msg,
        t || dropped
          ? dropped
            ? `⏹ 已中断当前回复\n并清空了 ${dropped} 条排队消息`
            : "⏹ 已中断当前回复"
          : "💤 当前没有正在跑的回复",
      );
      if (this.qqQueue.length) void this.runQQTurn();
    } catch (err) {
      this.output.appendLine(`[qq] /stop 处理失败: ${String(err)}`);
    }
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
    // 建进程的 1-3 秒里机器人可能被关掉（stopQQBot 已清 qqTurn/queue）——
    // 不能再以"已关闭"的状态把消息发出去在本机自动执行。
    if (!this.qqBot) {
      proc?.dispose();
      this.qqProc = undefined;
      this.qqTurn = undefined;
      this.qqRunning = false;
      return;
    }
    if (!proc) {
      await this.qqBot?.reply(msg, "❌ 启动 Claude 失败\n请在 VS Code 输出面板查看 Claude Chat 日志");
      this.finishQQTurn();
      return;
    }
    if (!proc.sendUserMessage(msg.text)) {
      this.qqProc = undefined; // 进程已死，下条消息会重建
      await this.qqBot?.reply(msg, "❌ Claude 进程已退出，请重试");
      this.finishQQTurn();
      return;
    }
    this.qqLastEventAt = Date.now(); // QQ 轮次也纳入卡死看门狗
  }

  private finishQQTurn(): void {
    const t = this.qqTurn;
    this.qqTurn = undefined;
    this.qqRunning = false;
    this.qqLastEventAt = undefined;
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
  private static readonly QQ_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  /** 中文档位别名 → CLI 合法值。字面量"低"直接传 --effort 会让进程再也起不来。 */
  private static readonly QQ_EFFORT_ALIASES: Record<string, string> = {
    低: "low",
    中: "medium",
    高: "high",
    极高: "xhigh",
    最大: "max",
    最高: "max",
  };

  /** 校验/翻译 effort 值；非法（含历史持久化进去的脏值）一律回落到 undefined。 */
  private static saneEffort(v?: string): string | undefined {
    if (!v) return undefined;
    const mapped = ChatViewProvider.QQ_EFFORT_ALIASES[v] ?? v.toLowerCase();
    return ChatViewProvider.QQ_EFFORTS.includes(mapped) ? mapped : undefined;
  }

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

      case "/usage": {
        // 等"这一次强制刷新"的结果（对象引用变化 = 新数据落地）——原来的
        // 条件是 !lastUsage，缓存几乎总是存在，等于永远立即返回 3 分钟前的旧值。
        const prev = this.lastUsage;
        this.fetchUsage(true);
        for (let i = 0; i < 24 && this.lastUsage === prev; i++) await new Promise((r) => setTimeout(r, 500));
        await reply(this.qqUsageText());
        return true;
      }

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
        let v = /^(默认|default)$/i.test(arg) ? "" : arg.toLowerCase();
        if (v) v = ChatViewProvider.QQ_EFFORT_ALIASES[arg.trim()] ?? v;
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
        this.qqCompacting = true;
        this.qqLastEventAt = Date.now(); // 压缩也受卡死看门狗保护
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
        // effort 过 saneEffort：历史版本可能把"低"这类非法值持久化进了 globalState，
        // 原样下发 --effort 会让机器人进程永远起不来。
        model: this.qqRuntime().model ?? this.config().get<string>("model", "") ?? undefined,
        effort:
          this.qqRuntime().effort !== undefined
            ? ChatViewProvider.saneEffort(this.qqRuntime().effort) // ""（/effort 默认）→ undefined = CLI 默认
            : ChatViewProvider.saneEffort(this.config().get<string>("effort", "")),
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
    if (this.qqLastEventAt !== undefined) this.qqLastEventAt = Date.now();
    // 压缩收尾的 result 只代表压缩完成，不是任何用户轮次的结束。
    if (e.kind === "result" && this.qqCompacting) {
      this.qqCompacting = false;
      this.output.appendLine(`[qq] 压缩完成`);
      return;
    }
    const t = this.qqTurn;
    if (!t) return;
    if (e.kind === "block_start" && e.blockType === "text") t.blockStart = t.text.length;
    else if (e.kind === "text_delta") t.text += e.text;
    else if (e.kind === "text_snap") t.text = t.text.slice(0, t.blockStart ?? t.text.length) + e.text; // 权威快照：替换当前文本块
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

  /** 一轮对话允许的最大"完全静默"时长。CLI 只要还在思考/调工具就会持续吐事件，
   *  真正 0 事件这么久只可能是卡死了。实测正常轮次最长 11 分钟但期间事件不断，
   *  首字延迟最大 9.6 秒——12 分钟静默给了极宽的余量，不会误伤长任务。 */
  private turnStallMs(): number {
    const min = 60_000;
    const v = this.config().get<number>("turnStallTimeoutSec", 720) * 1000;
    return Number.isFinite(v) && v >= min ? v : 720_000;
  }

  /** 轮次卡死检测 + 自愈：清掉转圈、告知用户、丢弃卡住的进程（下次发送会
   *  自动 --resume 重建，上下文不丢）。 */
  private checkTurnStall(ctx: SessionCtx): void {
    const last = ctx.lastEventAt;
    if (last === undefined) return; // 没有进行中的轮次
    // 权限确认/提问弹窗挂起时 CLI 静默是正常的——在等用户，不是卡死。
    // 用户想离开多久都行；答复后（permission/answerQuestion 分支）重新计时。
    if (ctx.pendingPerm) return;
    const idle = Date.now() - last;
    if (idle < this.turnStallMs()) return;
    ctx.lastEventAt = undefined;
    ctx.sendAt = undefined;
    this.output.appendLine(
      `[${new Date().toISOString()}] [stall] session=${ctx.sessionId?.slice(0, 8)} CLI 静默 ${Math.round(idle / 1000)}s，判定卡死，丢弃进程`,
    );
    // 卡住的进程不能再用（同一条 stdin 已经不响应了），丢掉让下轮重建。
    try {
      ctx.proc?.dispose();
    } catch {
      /* ignore */
    }
    ctx.proc = undefined;
    ctx.starting = undefined;
    // 后台（关着 tab）的会话：进程已经没了，留在池里就是个僵尸条目——占
    // MAX_BACKGROUND 容量却永远不在可淘汰列表里，变相把保活池越挤越小。
    if (!this.alive(ctx) && ctx.sessionId && this.detached.get(ctx.sessionId) === ctx) {
      ctx.checkpoints.flush();
      this.detached.delete(ctx.sessionId);
    }
    this.post(ctx, {
      kind: "error",
      message: `Claude 已 ${Math.round(idle / 60_000)} 分钟没有任何响应，判定为卡死并已重置连接。请重新发送这条消息（上下文不会丢失）。`,
    });
    this.post(ctx, { kind: "busy", busy: false });
    this.broadcastRunning();
  }

  /** QQ 侧的轮次卡死检测（对齐 checkTurnStall）：重置进程、通知发信人重发。 */
  private checkQQStall(): void {
    const last = this.qqLastEventAt;
    if (last === undefined) return;
    const idle = Date.now() - last;
    if (idle < this.turnStallMs()) return;
    this.qqLastEventAt = undefined;
    this.qqCompacting = false;
    this.output.appendLine(
      `[${new Date().toISOString()}] [qq][stall] CLI 静默 ${Math.round(idle / 1000)}s，判定卡死，重置机器人进程`,
    );
    const t = this.qqTurn;
    if (t) t.done = true; // 先标记，dispose 触发的 onClose 兜底才不会重复回复
    try {
      this.qqProc?.dispose();
    } catch {
      /* ignore */
    }
    this.qqProc = undefined;
    if (t) {
      void (async () => {
        await this.qqBot?.reply(
          t.target,
          `⚠️ Claude 已 ${Math.round(idle / 60_000)} 分钟没有任何响应，判定卡死并已重置\n请重新发送这条消息（上下文不会丢失）`,
        );
        this.finishQQTurn();
      })();
    } else {
      this.finishQQTurn();
    }
  }

  /** Is this ctx still attached to a live, displayable panel? */
  private alive(ctx: SessionCtx): boolean {
    return this.sessions.has(ctx);
  }

  /** Snapshot file edits for restore points as soon as Claude proposes them. */
  private handleEmit(ctx: SessionCtx, e: ToWebview): void {
    // 轮次看门狗心跳：CLI 只要还有任何动静（思考、工具、状态）就算活着。
    // 放在最前面，任何 early-return 都不会漏掉刷新。
    if (ctx.lastEventAt !== undefined) ctx.lastEventAt = Date.now();
    ctx.lastEmitAt = Date.now(); // 无条件版（LRU 淘汰的"最近有动静"兜底）
    if (e.kind === "tool_input" && FILE_TOOLS.has(e.name)) {
      if (this.config().get<boolean>("snapshotFilesForRestore", true)) {
        const p = (e.input.file_path ?? e.input.notebook_path) as string | undefined;
        if (p && path.isAbsolute(p)) ctx.checkpoints.snapshotFile(p);
      }
    }
    // 用量"警告"横幅被用户关过的话，本重置周期内不再弹（每个新进程都会重报一次，
    // 不在这拦就永远关不干净）。全局 exhausted 是阻断性的，永远放行；按模型的
    // exhausted 不阻断、可关闭，所以同样尊重用户的关闭。
    if (e.kind === "rate_limit" && (e.level === "warning" || (e.level === "exhausted" && e.modelScoped))) {
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
    // CLI 自己撤回了一条权限询问（中断、轮次结束、abort）：宿主侧的挂起记录要同步
    // 清掉，否则 checkTurnStall 一直以为「在等用户答复」而永不判定卡死——一次
    // 卡死的 /compact 就这样挂了 20 分钟没人管。只清同一条，别误清更新的询问。
    if (e.kind === "permission_resolved" && ctx.pendingPerm?.kind === "permission_request" && ctx.pendingPerm.requestId === e.requestId) {
      ctx.pendingPerm = undefined;
    }
    if (e.kind === "busy") this.broadcastRunning();
    // Refresh the changed-files panel when a turn finishes or a file result lands.
    if (e.kind === "result" || (e.kind === "tool_result" && !e.isError)) {
      this.refreshChangedFiles(ctx);
    }
    // After a turn, a new session's title becomes available — sync list + tab title.
    if (e.kind === "result") {
      ctx.sendAt = undefined; // 秒错的轮次没有流事件——别把时间戳漏进下一轮的测量
      ctx.lastEventAt = undefined; // 轮次正常收尾，停掉看门狗
      ctx.pendingPerm = undefined; // 轮次已结束不可能还有挂起询问；残留会让看门狗跳过下一轮（如 /compact）
      this.output.appendLine(
        `[${new Date().toISOString()}] [turn] session=${ctx.sessionId?.slice(0, 8)} 完成 ${e.durationMs}ms 轮次${e.numTurns}${e.isError ? " (出错)" : ""}`,
      );
      this.refreshSessions();
      this.fetchUsage(); // throttled — subscription usage moved after this turn
      // 一轮真实对话本身就把缓存焐热了 —— 记下来，别再浪费 token 去预热。
      if (ctx.sessionId) this.prewarmDone.set(this.warmKey(ctx.sessionId), Date.now());
      this.maybeNotifyTurnDone(ctx, e);
    }
  }

  /** 长任务完成的 webhook 推送：耗时达到阈值就发（曾按窗口聚焦跳过，实际用下来
   *  人在电脑前窗口常年聚焦、一条都收不到，已去掉该判断）。支持飞书/企微/钉钉
   *  群机器人（按域名适配报文），其他地址收到通用 JSON。失败只记日志，绝不影响
   *  会话流程。 */
  private maybeNotifyTurnDone(ctx: SessionCtx, e: { durationMs?: number; isError: boolean }): void {
    // 一次性消费本轮提问：/compact 等没有用户提问的收尾也是普通 result，
    // 不消费的话会带着上一轮的提问误推一条"任务完成"。
    const lastText = ctx.lastUserText;
    ctx.lastUserText = undefined;
    if (!lastText) return;
    const cfg = vscode.workspace.getConfiguration("claudeChat");
    const url = (cfg.get<string>("notifyWebhook") || "").trim();
    if (!url) return;
    const minSec = cfg.get<number>("notifyMinDurationSec") ?? 60;
    const dur = e.durationMs ?? 0;
    if (dur < minSec * 1000) return;
    const mins = Math.floor(dur / 60000);
    const secs = Math.round((dur % 60000) / 1000);
    const durText = mins ? `${mins} 分 ${secs} 秒` : `${secs} 秒`;
    const proj = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
    const q = lastText.replace(/\s+/g, " ").slice(0, 80);
    const msg =
      `${e.isError ? "⚠️ Claude 任务出错" : "✅ Claude 任务完成"}（耗时 ${durText}）` +
      `${proj ? `\n项目：${proj}` : ""}${q ? `\n提问：${q}` : ""}`;
    void this.sendWebhook(url, msg, { isError: e.isError, durationMs: dur, project: proj, question: q }).then((r) =>
      this.output.appendLine(`[${new Date().toISOString()}] [notify] ${r.ok ? `webhook HTTP ${r.status}` : `webhook 失败: ${r.error}`}`),
    );
  }

  /** AI 停下来等用户输入（工具授权 / AskUserQuestion 选项提问）的 webhook 推送。
   *  语义是「提示晾着没人管才提醒」：不能在提示弹出的瞬间判断——那时多半刚发完
   *  消息、距上次操作不足阈值，而“问题弹出后人才走开”恰是主场景，一次性判断
   *  永远推不出来。改为定时到「距上次用户动作满阈值」的时刻再看：这条提示仍挂
   *  着没被答复才推。答复/停止/新消息都会清 pendingPerm、还原会换掉 proc，定时
   *  器醒来自证作废；CLI 等答复期间不会弹新提示，一条提示至多推一次，天然不刷
   *  屏。复用完成推送的 webhook 与阈值配置，失败只记日志，绝不影响会话流程。 */
  private maybeNotifyWaiting(ctx: SessionCtx, req: PermissionRequest): void {
    const cfg = vscode.workspace.getConfiguration("claudeChat");
    const url = (cfg.get<string>("notifyWebhook") || "").trim();
    if (!url) return;
    const minSec = cfg.get<number>("notifyMinDurationSec") ?? 60;
    const since = ctx.lastUserActionAt ?? Date.now();
    const delay = Math.max(0, minSec * 1000 - (Date.now() - since));
    const proc = ctx.proc;
    setTimeout(() => {
      if (ctx.proc !== proc) return; // 进程已被换掉/杀掉（还原、重启），提示已作废
      const pend = ctx.pendingPerm;
      if (pend?.kind !== "permission_request" || pend.requestId !== req.requestId) return; // 已被答复/清除
      const waited = Date.now() - (ctx.lastUserActionAt ?? since);
      const mins = Math.floor(waited / 60000);
      const secs = Math.round((waited % 60000) / 1000);
      const durText = mins ? `${mins} 分 ${secs} 秒` : `${secs} 秒`;
      const proj = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
      // 只读不消费 lastUserText——本轮收尾的完成推送还要用它。
      const q = (ctx.lastUserText ?? "").replace(/\s+/g, " ").slice(0, 80);
      let ask: string;
      if (req.toolName === "AskUserQuestion") {
        const qs = (req.input as { questions?: { question?: string }[] } | undefined)?.questions;
        const first = (qs?.[0]?.question ?? "").replace(/\s+/g, " ").slice(0, 80);
        ask = `待回答：${first || "（选项提问）"}${qs && qs.length > 1 ? `（共 ${qs.length} 问）` : ""}`;
      } else {
        ask = `待授权：${req.displayName || req.toolName}`;
      }
      const msg =
        `⏳ Claude 正在等你输入（距上次操作 ${durText}）` +
        `${proj ? `\n项目：${proj}` : ""}\n${ask}${q ? `\n本轮提问：${q}` : ""}`;
      void this.sendWebhook(url, msg, { waiting: true, project: proj, question: q, ask }).then((r) =>
        this.output.appendLine(
          `[${new Date().toISOString()}] [notify] ${r.ok ? `等待输入推送 HTTP ${r.status}` : `等待输入推送失败: ${r.error}`}`,
        ),
      );
    }, delay);
  }

  /** 按目标域名适配报文：飞书/企微/钉钉群机器人收纯文本，其他地址收通用 JSON。 */
  private async sendWebhook(
    url: string,
    msg: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; status?: number; error?: string }> {
    let payload: unknown;
    if (/open\.feishu\.cn|open\.larksuite\.com/.test(url)) payload = { msg_type: "text", content: { text: msg } };
    else if (/qyapi\.weixin\.qq\.com|oapi\.dingtalk\.com/.test(url)) payload = { msgtype: "text", text: { content: msg } };
    else payload = { source: "claude-chat", text: msg, ...extra };
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: r.ok, status: r.status, ...(r.ok ? {} : { error: `HTTP ${r.status}` }) };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
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

  /** Tell the sidebar manager which sessions are currently streaming, so the
   *  list can show live "active" dots — even after a chat tab is closed. */
  private broadcastRunning(): void {
    // 这条会从进程事件（busy/close）进入，没有外层 try/catch 保护——侧边栏
    // 被移动位置/收起时 view 是已 dispose 的死引用，postMessage 直接抛
    // "Webview is disposed"，异常会中断当轮事件处理。吞掉。
    try {
      this.view?.webview.postMessage({ kind: "running", sessionIds: this.runningIds() } satisfies ToWebview);
    } catch {
      /* view disposed */
    }
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
        this.usageFails = 0;
        // Remember it so newly-opened tabs can show it immediately, and push it
        // to every open chat tab (not just the focused one).
        this.lastUsage = { kind: "usage", ...parsed, sessionResetAt };
        for (const ctx of this.sessions) this.post(ctx, this.lastUsage);
      } else {
        // Transient failure — don't let the throttle block retries for 90s.
        // 但 API-key 账号的 /usage 永远解析不出百分比：连续失败几次后就恢复
        // 正常节流，否则每个 ready/result/定时器都会真实 spawn 一个 CLI 进程。
        this.usageFails++;
        if (this.usageFails <= 3) this.lastUsageAt = 0;
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
    // 后台/前台会话都提醒：等的就是不在屏幕前的人。
    this.maybeNotifyWaiting(ctx, req);
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
    ctx.lastEventAt = undefined; // 进程都没了，本轮不可能再有事件——停掉看门狗
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
      // QQ 机器人的专用会话也在列表里——不停掉 qqProc 的话，下一条 QQ 消息
      // 会用还活着的进程把 transcript 重新写回磁盘，会话"删不掉"。
      if (id === this.qqSessionId || id === this.context.globalState.get<string>(ChatViewProvider.QQ_SESSION_KEY)) {
        if (this.qqProc) waits.push(this.qqProc.disposeAndWait());
        this.qqProc = undefined;
        this.qqTurn = undefined;
        this.qqRunning = false;
        this.qqLastEventAt = undefined;
        this.qqSessionId = undefined;
        void this.context.globalState.update(ChatViewProvider.QQ_SESSION_KEY, undefined);
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
          } else {
            this.store.deleteSidecars(id); // 垂死进程可能又写回了 file-history 等附属数据
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
  async checkForUpdate(silent = false, quiet = silent): Promise<void> {
    const local = (this.context.extension.packageJSON.version as string) || "0.0.0";
    let remote = "";
    try {
      const pkg = await this.fetchRepoFile("package.json");
      remote = JSON.parse(pkg.toString("utf8")).version || "";
    } catch (err) {
      if (!quiet) vscode.window.showErrorMessage(`检查更新失败：${String((err as Error)?.message ?? err)}`);
      return;
    }
    if (!remote) {
      if (!quiet) vscode.window.showErrorMessage("检查更新失败：无法读取远程版本号");
      return;
    }
    if (cmpVersion(remote, local) <= 0) {
      this.installedPending = undefined; // running version caught up — clear any pending-reload flag
      if (!quiet) vscode.window.showInformationMessage(`已是最新版本 v${local}`);
      return;
    }
    // Newer version available.
    // Already installed this (or newer) earlier this session — it just needs a
    // window reload. Don't re-download / re-prompt (that caused an update loop),
    // and don't re-light the badge for a version that's already on disk.
    if (this.installedPending && cmpVersion(remote, this.installedPending) <= 0) {
      this.postUpdateDot();
      if (!quiet) {
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
  /** 把 AI 提到的（往往不完整的）路径解析成真实文件：先按给定路径直接拼，拼不到
   *  就全工作区按文件名搜（回复里常见 `bridge.js:282` 这种裸文件名——以前直接拼
   *  接找不到，点击就"没反应"）。多个候选且无法判定时弹选择器（interactive）。 */
  private async resolveWorkspaceFile(p: string, interactive: boolean): Promise<string | undefined> {
    const direct = path.isAbsolute(p)
      ? [p]
      : [path.join(this.cwd(), p), ...this.workspaceDirs().map((d) => path.join(d, p))];
    for (const c of direct) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {
        /* try next */
      }
    }
    const base = p.split(/[\\/]/).pop() || "";
    if (!base) return undefined;
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        `**/${base}`,
        "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/target/**,**/out/**}",
        12,
      );
    } catch {
      return undefined;
    }
    if (!uris.length) return undefined;
    // 带目录的引用优先后缀完全匹配（src/a/bridge.js 优于 test/bridge.js）；再取路径最浅的。
    const norm = "/" + p.replace(/\\/g, "/");
    const ranked = uris.map((u) => u.fsPath).sort((a, b) => {
      const sa = a.replace(/\\/g, "/").endsWith(norm) ? 0 : 1;
      const sb = b.replace(/\\/g, "/").endsWith(norm) ? 0 : 1;
      return sa - sb || a.length - b.length;
    });
    if (ranked.length === 1 || ranked[0].replace(/\\/g, "/").endsWith(norm) || !interactive) return ranked[0];
    const pick = await vscode.window.showQuickPick(
      ranked.map((f) => ({ label: vscode.workspace.asRelativePath(f), f })),
      { placeHolder: `找到多个「${base}」，选择要打开的文件` },
    );
    return pick?.f;
  }

  /** 符号名 -> 是否能在工作区解析到。LSP 查询有成本，且历史重渲染会反复问同一批。 */
  private readonly symbolCache = new Map<string, boolean>();

  /** 工作区符号索引可用性：undefined=未知，true=用得上，false=这个工作区根本没有
   *  （比如 Java 项目没装语言服务扩展——查询永远返回空）。
   *  实测教训：不区分"冷启动"和"压根没有"的话，每次点击都要为一个永远不会
   *  热起来的索引白等 2 秒多重试，这就是"点了很久才反应"的根因。 */
  private lspSymbolUsable?: boolean;
  /** LSP 查不到、但我们自己（文件名/文本搜索）找到了的次数——连续两次就判定索引不可用。 */
  private lspMisses = 0;
  /** 连续"整轮重试都查不到任何东西"的次数——判定索引不可用的另一条出口。 */
  private lspEmptyCycles = 0;

  /** 校验一批符号引用，返回无效项的 id。策略：LSP 工作区符号索引（快、准）。
   *  保护：整批一个都查不到时不下结论——可能是语言服务还没热身（窗口刚开时索引
   *  是空的），此时全部保留，宁可留几个可疑链接也不错杀真符号。 */
  private async validateSymbols(syms: { id: string; name: string }[]): Promise<string[]> {
    const results = new Map<string, boolean>();
    let anyHit = false;
    for (const { name } of syms) {
      if (!name || results.has(name)) continue;
      const cached = this.symbolCache.get(name);
      if (cached !== undefined) {
        results.set(name, cached);
        if (cached) anyHit = true;
        continue;
      }
      let ok = false;
      try {
        const found =
          (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            "vscode.executeWorkspaceSymbolProvider",
            name,
          )) ?? [];
        if (found.length) {
          this.lspSymbolUsable = true; // 索引有反应 = 确实可用
          this.lspMisses = 0;
        }
        ok = found.some((s) => s.name === name || s.name.startsWith(name + "("));
      } catch {
        ok = true; // 查询本身失败（无语言服务等）——不下结论，保留链接
      }
      results.set(name, ok);
      if (ok) anyHit = true;
      if (this.symbolCache.size > 500) this.symbolCache.clear(); // 简单防膨胀
      this.symbolCache.set(name, ok);
    }
    // 一个都没命中：大概率是 LSP 冷启动（索引为空），全部保留、且不要缓存这批
    // 否定结论（等索引热了下次重新验）。
    if (!anyHit) {
      for (const { name } of syms) if (results.get(name) === false) this.symbolCache.delete(name);
      return [];
    }
    return syms.filter(({ name }) => results.get(name) === false).map(({ id }) => id);
  }

  private async fileRefResolves(ref: string): Promise<boolean> {
    const p = ref.replace(/:\d+(?:-\d+)?$/, "").trim();
    if (!p) return false;
    return !!(await this.resolveWorkspaceFile(p, false));
  }

  private async openFile(ctx: SessionCtx, p: string, line?: number, endLine?: number): Promise<void> {
    const t0 = Date.now();
    try {
      const abs = await this.resolveWorkspaceFile(p, true);
      if (!abs) {
        this.output.appendLine(`[openFile] ${p} 未找到 (${Date.now() - t0}ms)`);
        vscode.window.showWarningMessage(`工作区里找不到文件：${p}`);
        return;
      }
      // 慢的时候要能查出来是"找文件"慢还是"开编辑器"慢。
      const resolveMs = Date.now() - t0;
      if (abs !== p || resolveMs > 300) this.output.appendLine(`[openFile] ${p} → ${abs} (解析 ${resolveMs}ms)`);
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
  /** 正在定位中的符号（LSP 热身重试最长 ~4s，期间重复点击直接忽略，防止开一串编辑器）。 */
  private openingSymbol?: string;

  private async openSymbol(ctx: SessionCtx, name: string): Promise<void> {
    if (this.openingSymbol === name) return;
    this.openingSymbol = name;
    try {
      await this.openSymbolInner(ctx, name);
    } finally {
      this.openingSymbol = undefined;
    }
  }

  private async openSymbolInner(ctx: SessionCtx, name: string): Promise<void> {
    const t0 = Date.now();
    const done = (via: string) =>
      this.output.appendLine(
        `[${new Date().toISOString()}] [symbol] ${name} 定位 ${Date.now() - t0}ms 途径=${via}` +
          (lspMs ? ` (其中 lsp ${lspMs}ms)` : ""),
      );
    // 1) Language-server workspace-symbol index (best — needs the lang extension).
    //    冷启动值得等一下（窗口刚开时索引是空的，立即降级会把用户丢进搜索面板）；
    //    但"这个工作区压根没有语言服务"时（如 Java 项目没装 redhat.java，查询永远
    //    返回空）再等就是每次点击白卡两秒多——所以先判可用性，不可用就直接跳过。
    let lspMs = 0;
    const lspHit = this.lspSymbolUsable === false ? undefined : await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `定位 ${name}…` },
      async () => {
        const lt = Date.now();
        // 冷启动重试的适用条件：索引可用性还未知。Java/Kotlin 大仓的语言服务
        // 常要 30s~2min 才建好索引，用"扩展启动 60 秒内"卡窗口会把冷启动期
        // 排除在外，等于退回了"第一次点击掉进搜索面板"的老问题——所以只看
        // 可用性未知，并给足退避预算（累计 ~3s，与旧实现一致）。
        const mayBeCold = this.lspSymbolUsable === undefined;
        const tries = mayBeCold ? 4 : 1;
        try {
          for (let attempt = 0; attempt < tries; attempt++) {
            if (attempt) await new Promise((r) => setTimeout(r, attempt * 500)); // 累计 500+1000+1500 = 3s
            let syms: vscode.SymbolInformation[];
            try {
              syms =
                (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                  "vscode.executeWorkspaceSymbolProvider",
                  name,
                )) ?? [];
            } catch {
              return undefined; // 没有语言服务——重试无意义，走后面的降级链路
            }
            if (syms.length) {
              this.lspSymbolUsable = true;
              this.lspMisses = 0;
              this.lspEmptyCycles = 0;
            } else if (this.lspSymbolUsable) {
              return undefined; // 索引确认可用 → 空 = 真没有，别再等
            }
            const exact = syms.filter((s) => s.name === name || s.name.startsWith(name + "("));
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
            if (candidates[0]) return candidates[0];
          }
          // 整轮重试全空：这本身就是"索引不管用"的证据，与后面的降级链路
          // 找没找到无关（符号可能压根不存在）。连续几次就判定不可用，否则
          // 没装语言服务的工作区每次点击都要白等 3 秒，永远等不到结论。
          if (++this.lspEmptyCycles >= 3 && this.lspSymbolUsable !== false) {
            this.lspSymbolUsable = false;
            this.output.appendLine(
              `[${new Date().toISOString()}] [symbol] 工作区符号索引连续 ${this.lspEmptyCycles} 次无响应，后续点击跳过 LSP`,
            );
          }
          return undefined;
        } finally {
          lspMs = Date.now() - lt;
        }
      },
    );
    if (lspHit) {
      done("lsp");
      await this.openFile(ctx, lspHit.location.uri.fsPath, lspHit.location.range.start.line + 1);
      return;
    }
    // 2) A type whose file is named after it (Java/Kotlin/C#/TS/Go/… convention).
    //    只对"类型名"形态（首字母大写）才查——saveOrder 这类方法名不可能有同名
    //    文件，白跑一次 findFiles 就是几百毫秒。
    try {
      if (!/^[A-Z]/.test(name)) throw new Error("skip");
      const matches = await vscode.workspace.findFiles(
        `**/${name}.{java,kt,kts,scala,cs,ts,tsx,go,rs,php,swift,dart}`,
        "**/{node_modules,dist,build,out,target,.git}/**",
        3,
      );
      if (matches.length) {
        this.noteLspMiss();
        done("file");
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
        this.noteLspMiss();
        done("search");
        await this.openFile(ctx, hit.uri.fsPath, hit.line);
        return;
      }
    } catch {
      /* ignore */
    }
    // 4) Last resort: open the Search panel pre-filled.
    // 注意：这里"什么都没找到"不能计入 LSP 不可用的证据——符号本来就不存在
    // （模型编的名字）时也会走到这，误判会把装了语言服务的工作区也降级掉。
    // 只有"我们自己找到了、LSP 没找到"（前两个分支）才是索引不管用的实锤。
    done("找不到→搜索面板");
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
  /** LSP 没查到、但我们自己找到了 —— 连续两次就判定这个工作区没有可用的符号索引，
   *  之后所有点击直接跳过 LSP（省掉每次两秒多的无用等待）。 */
  private noteLspMiss(): void {
    if (this.lspSymbolUsable === true) return; // 索引本来可用，只是这个符号它不认识
    if (++this.lspMisses >= 2) {
      if (this.lspSymbolUsable !== false) {
        this.output.appendLine(
          `[${new Date().toISOString()}] [symbol] 工作区无可用符号索引（未装语言服务？），后续点击跳过 LSP 直接走搜索`,
        );
      }
      this.lspSymbolUsable = false;
    }
  }

  /** 源码文件清单缓存：findFiles 在大仓库本身就要几百毫秒，每次点击都重扫太浪费。 */
  private srcFilesCache?: { at: number; uris: vscode.Uri[] };

  private async sourceFiles(): Promise<vscode.Uri[]> {
    const c = this.srcFilesCache;
    if (c && Date.now() - c.at < 60_000) return c.uris;
    const uris = await vscode.workspace.findFiles(
      "**/*.{java,kt,kts,scala,ts,tsx,js,jsx,go,rs,cs,py,php,rb,swift,dart,c,cpp,h,hpp}",
      "**/{node_modules,dist,build,out,target,.git}/**",
      2500,
    );
    this.srcFilesCache = { at: Date.now(), uris };
    return uris;
  }

  private async searchDefinition(name: string): Promise<{ uri: vscode.Uri; line: number } | undefined> {
    const files = await this.sourceFiles();
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const word = new RegExp(`\\b${esc}\\b`);
    const def = new RegExp(
      `\\b(class|interface|enum|record|struct|trait|object|def|func|function|fun|type)\\s+${esc}\\b` +
        `|\\b[\\w<>\\[\\].]+\\s+${esc}\\s*\\(` +
        `|\\b${esc}\\s*[:=]\\s*(?:function\\b|\\()`,
    );
    let fallback: { uri: vscode.Uri; line: number } | undefined;
    // 分批并行读：串行 2500 次 readFile 是"点了要等两秒"的另一半原因。
    // 批内按原顺序判定，保证结果和串行版一致（第一个定义处优先）。
    const BATCH = 48;
    for (let start = 0; start < files.length; start += BATCH) {
      const batch = files.slice(start, start + BATCH);
      const contents = await Promise.all(
        batch.map((u) => fs.promises.readFile(u.fsPath, "utf8").catch(() => undefined)),
      );
      for (let b = 0; b < batch.length; b++) {
        const content = contents[b];
        if (content === undefined || !word.test(content)) continue;
        const uri = batch[b];
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (def.test(lines[i])) return { uri, line: i + 1 };
          if (!fallback && word.test(lines[i])) fallback = { uri, line: i + 1 };
        }
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
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = undefined;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
    if (this.qqLockTimer) clearInterval(this.qqLockTimer);
    this.qqLockTimer = undefined;
    this.stopQQBot(); // 关窗口就断开机器人并让出锁，另一个窗口会自动接管
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
  private sidebarHtml(): string {
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
    // pushpin — 置顶开关与「置顶」组头共用；置顶行由 CSS 填充实心。
    const PIN =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 2.6h5M6.6 2.6l-.5 4-2 2v.7h7.8v-.7l-2-2-.5-4M8 9.3V13"/></svg>';
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
  /* 置顶开关：与 edit/del 同款（hover 才现，pinned 行常亮实心图钉）。 */
  .row .pin { flex: 0 0 auto; opacity: 0; background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 2px; border-radius: 4px; }
  .row:hover .pin { opacity: .65; }
  .row .pin:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.25)); }
  .row .pin svg { width: 14px; height: 14px; }
  .row.pinned .pin { opacity: .9; }
  .row.pinned .pin svg { fill: currentColor; }
  body.multi .row .pin { display: none; }
  /* 置顶区独立成组：中性浅底一整块，「置顶」组头（图钉 + 计数），「最近」分隔。 */
  .group-head { display: flex; align-items: center; gap: 6px; padding: 9px 8px 4px; font-size: 11px; opacity: .6; }
  .group-head svg { width: 12px; height: 12px; flex: 0 0 auto; }
  .group-head .gh-ttl { flex: 1; }
  .group-head .gh-count { font-variant-numeric: tabular-nums; opacity: .85; }
  .pin-zone { background: rgba(127,127,127,.08); border-radius: 8px; padding: 2px; margin: 0 2px 4px; }
  .recent-head { padding: 6px 8px 3px; font-size: 11px; opacity: .5; }
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
    // 侧边栏脚本一旦抛错整个面板就会"点了没反应"且无迹可循——错误上报给 host 记日志。
    window.addEventListener("error", (e) => {
      try { vscode.postMessage({ type: "webviewError", message: (e.message || "?") + " @sidebar:" + e.lineno }); } catch {}
    });
    window.addEventListener("unhandledrejection", (e) => {
      try { vscode.postMessage({ type: "webviewError", message: "unhandledrejection@sidebar: " + String(e.reason).slice(0, 300) }); } catch {}
    });
    const TRASH = ${JSON.stringify(TRASH)};
    const PENCIL = ${JSON.stringify(PENCIL)};
    const PIN = ${JSON.stringify(PIN)};
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

    function makeRow(s) {
      const row = document.createElement("div");
      row.className = "row" + (s.id === activeId ? " active" : "") + (s.pinned ? " pinned" : "");
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
      const pin = document.createElement("button"); pin.className = "pin";
      pin.title = s.pinned ? "取消置顶" : "置顶"; pin.innerHTML = PIN;
      pin.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "pinSession", sessionId: s.id, pinned: !s.pinned }); });
      const edit = document.createElement("button"); edit.className = "edit"; edit.title = "重命名"; edit.innerHTML = PENCIL;
      edit.addEventListener("click", (e) => { e.stopPropagation(); rename(s.id); });
      const del = document.createElement("button"); del.className = "del"; del.title = "删除"; del.innerHTML = TRASH;
      del.addEventListener("click", (e) => { e.stopPropagation(); confirmDel([s.id]); });
      row.append(chk, body, pin, edit, del);
      row.addEventListener("click", () => { if (multi) toggle(s.id, !sel.has(s.id)); else open(s.id); });
      return row;
    }

    function render() {
      const list = $("list");
      if (!sessions.length) { list.innerHTML = '<div class="empty">暂无会话</div>'; return; }
      list.innerHTML = "";
      const pinned = sessions.filter((s) => s.pinned);
      const others = sessions.filter((s) => !s.pinned);
      if (pinned.length) {
        const gh = document.createElement("div"); gh.className = "group-head";
        gh.innerHTML = PIN + '<span class="gh-ttl">置顶</span><span class="gh-count">' + pinned.length + '</span>';
        list.appendChild(gh);
        const zone = document.createElement("div"); zone.className = "pin-zone";
        for (const s of pinned) zone.appendChild(makeRow(s));
        list.appendChild(zone);
        if (others.length) {
          const rh = document.createElement("div"); rh.className = "recent-head"; rh.textContent = "最近";
          list.appendChild(rh);
        }
      }
      for (const s of others) list.appendChild(makeRow(s));
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
    $("upd-banner").addEventListener("click", () => vscode.postMessage({ type: "checkUpdate", fromBanner: true }));

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
    <div id="lightbox" class="lightbox hidden">
      <div class="lightbox-actions">
        <button id="lb-copy" title="复制图片到剪贴板">${ICONS.copy} 复制</button>
        <button id="lb-save" title="保存图片到本地">${ICONS.file} 保存</button>
        <button id="lb-close" title="关闭">×</button>
      </div>
      <img id="lightbox-img" alt="预览" />
    </div>
    <div id="messages" class="messages"></div>
    <footer id="composer">
      <div id="changed-files" class="changed-files hidden collapsed">
        <div class="cf-header" id="cf-header">
          <span class="cf-caret">${ICONS.chevron}</span>
          <span class="cf-title">已更改文件</span>
          <span id="cf-count" class="cf-count"></span>
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
        <textarea id="input" rows="1" placeholder="给 Claude 发消息…"></textarea>
        <div class="composer-bottom">
          <div class="composer-tools">
            <button id="btn-attach-file" class="composer-btn" title="附加文件/目录到会话">${ICONS.attach}</button>
            <span class="composer-sep"></span>
            <button id="model-trigger" class="composer-pick" title="选择模型"><span class="pick-emoji">${ICONS.model}</span><span id="model-label" class="pick-label">默认模型</span><span class="pick-caret">${ICONS.chevron}</span></button>
            <button id="mode-trigger" class="composer-pick" title="选择模式"><span id="mode-icon" class="pick-emoji"></span><span id="mode-label" class="pick-label"></span><span class="pick-caret">${ICONS.chevron}</span></button>
            <button id="sls-toggle-btn" class="composer-pick sls-toggle-btn hidden" title="打开后，本条消息会带上 SLS 日志工具用法，Claude 可直接查后端日志"><span class="pick-emoji sls-ico">${ICONS.sls}</span><span class="pick-label">SLS日志</span></button>
            <span class="composer-state">
              <span id="ctx-gauge" class="ctx-gauge hidden" title="上下文使用量"><span class="cg-ring"><span class="cg-pct"></span></span></span>
              <button id="usage-pill" class="usage-pill hidden" title="Claude 订阅用量 · 点击查看详情"></button>
            </span>
          </div>
          <button id="btn-send" class="composer-send" title="发送">${ICONS.send}</button>
          <button id="btn-stop" class="composer-send stop hidden" title="停止">${ICONS.stop}</button>
        </div>
      </div>
      <div id="pick-backdrop" class="pick-backdrop hidden"></div>
      <div id="mode-menu" class="pick-menu hidden"></div>
      <div id="model-menu" class="pick-menu hidden"></div>
      <div id="usage-menu" class="pick-menu usage-menu hidden"></div>
      <div class="composer-foot">
        <span class="foot-keys"><kbd>Enter</kbd>发送<kbd>⇧↵</kbd>换行</span>
        <span class="foot-spacer"></span>
        <span id="status-line" class="status-line"></span>
      </div>
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
