import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CTX_OPEN, CTX_CLOSE, SLS_CTX_OPEN, SLS_CTX_CLOSE, SessionSummary, TimelineItem } from "../shared";

/**
 * Reads Claude Code's own on-disk session transcripts so we can list past
 * conversations and rehydrate them. The CLI owns persistence; we only read.
 *
 * Transcripts live at: <configDir>/projects/<encoded-cwd>/<session-id>.jsonl
 *   - configDir = $CLAUDE_CONFIG_DIR or ~/.claude
 *   - encoded-cwd = absolute cwd with every non-alphanumeric char -> '-'
 */
export class SessionStore {
  constructor(private readonly cwd: string) {}

  /** Persist a user-set title by appending a `custom-title` entry to the
   *  transcript — the exact same mechanism the official Claude UI uses, so
   *  renames sync both ways. Empty title clears the override (back to AI title).
   *  Returns false if the session file isn't on disk yet. */
  setCustomTitle(sessionId: string, title: string): boolean {
    const file = this.findFile(sessionId);
    if (!file) return false;
    // Field order mirrors what the official Claude UI writes, byte-for-byte.
    const entry = JSON.stringify({ type: "custom-title", sessionId, customTitle: title }) + "\n";
    try {
      fs.appendFileSync(file, entry, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  private configDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  }

  /** Candidate project dirs (handles macOS /tmp -> /private/tmp symlinks). */
  private projectDirs(): string[] {
    const enc = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");
    const dirs = new Set<string>();
    dirs.add(path.join(this.configDir(), "projects", enc(this.cwd)));
    try {
      const real = fs.realpathSync(this.cwd);
      dirs.add(path.join(this.configDir(), "projects", enc(real)));
    } catch {
      /* ignore */
    }
    return [...dirs];
  }

  /** List sessions for the current workspace, newest first. */
  /** peek() results keyed by path — reparsing every transcript on every refresh
   *  is O(total bytes) sync I/O per turn; the mtime+size key skips unchanged files. */
  private readonly peekCache = new Map<string, { m: number; s: number; v: { title: string; messageCount: number; hasContent: boolean } }>();

  list(): SessionSummary[] {
    const out: SessionSummary[] = [];
    const seen = new Set<string>();
    for (const dir of this.projectDirs()) {
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const full = path.join(dir, file);
        seen.add(full);
        try {
          const stat = fs.statSync(full);
          const cached = this.peekCache.get(full);
          let v = cached && cached.m === stat.mtimeMs && cached.s === stat.size ? cached.v : undefined;
          if (!v) {
            v = this.peek(full);
            this.peekCache.set(full, { m: stat.mtimeMs, s: stat.size, v });
          }
          if (!v.hasContent) continue; // skip truly-empty sessions (system-init only)
          out.push({
            id: file.replace(/\.jsonl$/, ""),
            title: v.title,
            updatedAt: stat.mtimeMs,
            messageCount: v.messageCount,
          });
        } catch {
          /* ignore unreadable file */
        }
      }
    }
    // Drop cache entries for deleted files so the map doesn't grow forever.
    for (const k of [...this.peekCache.keys()]) if (!seen.has(k)) this.peekCache.delete(k);
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Cheap scan for the list. Title priority mirrors the official UI:
   *  manual rename (`custom-title`) > AI title (`ai-title`) > first user prompt
   *  > last prompt. `hasContent` decides visibility — a session counts as real
   *  if it has any user/assistant turn, a title, or a stored prompt (some
   *  sessions store the prompt only as a `last-prompt`, with no `user` entry). */
  private peek(file: string): { title: string; messageCount: number; hasContent: boolean } {
    const lines = this.readLines(file);
    let customTitle: string | null = null; // last custom-title; "" means user cleared it
    let aiTitle = "";
    let firstUserText = "";
    let lastPrompt = "";
    let userTurns = 0;
    let assistantTurns = 0;
    for (const o of lines) {
      if (o.type === "custom-title" && typeof o.customTitle === "string") {
        customTitle = o.customTitle.trim();
      } else if (o.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle.trim()) {
        aiTitle = o.aiTitle.trim();
      } else if (o.type === "last-prompt" && typeof o.lastPrompt === "string" && o.lastPrompt.trim()) {
        lastPrompt = o.lastPrompt.trim();
      } else if (o.type === "assistant") {
        assistantTurns++;
      } else if (o.type === "user" && this.isRealUserText(o)) {
        userTurns++;
        if (!firstUserText) {
          // Strip IDE/attached-context noise so the title is the real first message.
          const clean = splitAttachedContext(this.userText(o)).text;
          if (clean) firstUserText = truncate(clean, 60);
        }
      }
    }
    const fallbackPrompt = lastPrompt ? truncate(splitAttachedContext(lastPrompt).text || lastPrompt, 60) : "";
    const title = customTitle || aiTitle || firstUserText || fallbackPrompt || "新对话";
    const hasContent = userTurns > 0 || assistantTurns > 0 || !!customTitle || !!aiTitle || !!lastPrompt;
    // Show a sensible count: real user turns, else assistant turns (edge sessions).
    const messageCount = userTurns > 0 ? userTurns : assistantTurns;
    return { title, messageCount, hasContent };
  }

  /** Rehydrate a full session transcript into renderable timeline items.
   *  按文件顺序读取，但跳过「被放弃的分支」：从主链（文件末尾链条目的祖先链，压缩
   *  边界经 logicalParentUuid 接上）某节点分叉出去、却不在主链上的记录——那是回退
   *  /编辑重发之后留在文件里的旧尾巴，显示出来会占掉可见的最后几轮且没有还原点。
   *  与主链完全不相连的孤儿树（旧版截断留下的断链、CLI 侧其它情况）照常显示：
   *  纯沿链过滤实测会把老会话大段真实历史连同还原点一起藏掉。 */
  load(sessionId: string): TimelineItem[] {
    const file = this.findFile(sessionId);
    if (!file) return [];
    const all = this.readLines(file);
    const abandoned = this.abandonedSet(all);
    const items: TimelineItem[] = [];
    const toolIndex = new Map<string, number>(); // tool_use_id -> items index
    let prevTs = 0; // previous record's timestamp — estimates thinking duration
    for (const o of all) {
      if (typeof o.uuid === "string" && abandoned.has(o.uuid)) continue;
      const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
      if (o.type === "user" && Array.isArray(o.message?.content)) {
        const images: string[] = [];
        for (const b of o.message.content) {
          if (b?.type === "tool_result") {
            const idx = toolIndex.get(b.tool_use_id);
            if (idx !== undefined) {
              const item = items[idx];
              if (item.type === "tool") {
                // Display-only cap: a session can hold many multi-MB tool
                // outputs, and shipping them all to the webview made big
                // sessions take seconds to open. The transcript keeps the
                // full result; only the history card view is truncated.
                const s = stringify(b.content);
                item.result = s.length > 50_000 ? s.slice(0, 50_000) + "\n…（输出过长，历史视图已截断）" : s;
                item.isError = !!b.is_error;
              }
            }
          } else if (b?.type === "image") {
            const uri = imageDataUri(b);
            if (uri) images.push(uri);
          }
        }
        if (this.isRealUserText(o) || images.length) {
          const { text, files, sls } = splitAttachedContext(this.userText(o));
          // Skip pure IDE-context injections (no real text, no images).
          if (text || images.length) {
            items.push({
              type: "user",
              text,
              files: files.length ? files : undefined,
              images: images.length ? images : undefined,
              sls: sls || undefined,
            });
          }
        }
      } else if (o.type === "user" && typeof o.message?.content === "string") {
        if (this.isRealUserText(o)) {
          const { text, files, sls } = splitAttachedContext(o.message.content);
          if (text) items.push({ type: "user", text, files: files.length ? files : undefined, sls: sls || undefined });
        }
      } else if (o.type === "assistant" && Array.isArray(o.message?.content)) {
        for (const b of o.message.content) {
          if (b?.type === "text" && b.text?.trim()) {
            items.push({ type: "assistant_text", text: b.text });
          } else if (b?.type === "thinking") {
            // The CLI persists thinking blocks with EMPTY text (signature only)
            // — the block's presence is the signal, so no text filter here or
            // the node never renders (verified: 0/783 blocks had text).
            // Duration ≈ gap since the previous transcript record (the record
            // holding the thinking block is written when it finishes). Rough,
            // but the right order of magnitude — omit when implausible.
            const secs = prevTs && !isNaN(ts) ? Math.round((ts - prevTs) / 1000) : 0;
            items.push({ type: "thinking", text: b.thinking || "", secs: secs > 0 && secs < 3600 ? secs : undefined });
          } else if (b?.type === "tool_use") {
            toolIndex.set(b.id, items.length);
            items.push({ type: "tool", toolId: b.id, name: b.name, input: b.input });
          } else if (b?.type === "image") {
            const uri = imageDataUri(b);
            if (uri) items.push({ type: "image", src: uri });
          }
        }
      } else if (o.type === "system" && (o as any).subtype === "compact_boundary") {
        // Mark where a /compact summarized the conversation (a divider in the UI).
        const cm = (o as any).compactMetadata ?? (o as any).compact_metadata ?? {};
        items.push({
          type: "compaction",
          preTokens: cm.preTokens ?? cm.pre_tokens ?? 0,
          postTokens: cm.postTokens ?? cm.post_tokens ?? 0,
        });
      }
      if (!isNaN(ts)) prevTs = ts;
    }
    return items;
  }

  /** Approx context used by a session = the last assistant message's full prompt
   *  (input + cached) plus its output, along with that message's model id (so the
   *  caller can pick the right context window). Undefined if no usage found. */
  lastContextUsage(sessionId: string): { used: number; model?: string } | undefined {
    const file = this.findFile(sessionId);
    if (!file) return undefined;
    // Only the transcript tail matters here (the LAST usage / compact boundary
    // wins) — a full parse was a second multi-MB read on every session open.
    return this.scanUsage(this.readTailLines(file, 512 * 1024)) ?? this.scanUsage(this.readLines(file));
  }

  private scanUsage(objs: any[]): { used: number; model?: string } | undefined {
    let used: number | undefined;
    let model: string | undefined;
    for (const o of objs) {
      const msg = (o as any)?.message;
      const u = msg?.usage;
      if (o.type === "assistant" && u) {
        const v =
          (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0) +
          (u.output_tokens || 0);
        if (v > 0) {
          used = v;
          model = msg?.model;
        }
      } else if (o.type === "system" && (o as any).subtype === "compact_boundary") {
        // After a /compact the live context drops to postTokens until the next
        // turn — without this, reloading re-reads the big pre-compact usage.
        const cm = (o as any).compactMetadata ?? (o as any).compact_metadata;
        const post = cm?.postTokens ?? cm?.post_tokens;
        if (typeof post === "number" && post > 0) used = post;
      }
    }
    return used !== undefined ? { used, model } : undefined;
  }

  /** Number of non-empty lines in a session transcript (0 if not yet written). */
  countLines(sessionId: string): number {
    const file = this.findFile(sessionId);
    if (!file) return 0;
    try {
      return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }

  /** 截点（前 keepLines 个非空行）之前最后一个链条目的 uuid——即回退后对话的叶子。
   *  链条目 = 同时带 uuid 与 parentUuid 键的记录（user/assistant/attachment/system
   *  皆可）；SDK 的 forkSession.upToMessageId 接受任意链条目。 */
  lastChainUuidBefore(sessionId: string, keepLines: number): string | undefined {
    const file = this.findFile(sessionId);
    if (!file) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    let seen = 0;
    let last: string | undefined;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      seen++;
      if (seen > keepLines) break;
      try {
        const o = JSON.parse(line);
        if (typeof o?.uuid === "string" && "parentUuid" in o) last = o.uuid;
      } catch {
        /* skip */
      }
    }
    return last;
  }

  /** 文件里每条真人提问所在的行号（非空行计数，1 起）及其正文/是否带图——还原点
   *  迁移到派生出的新会话时，靠「同一段提问文本」把 truncateLine 重新对齐到新文件
   *  （fork 只复制链记录，行号与原文件不同）。判定规则与 firstUserTurnAfter 一致。 */
  userTurnLines(sessionId: string): { text: string; hasImages: boolean; line: number }[] {
    const file = this.findFile(sessionId);
    if (!file) return [];
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const out: { text: string; hasImages: boolean; line: number }[] = [];
    let seen = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      seen++;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o?.type !== "user" || o.isMeta === true || o.isCompactSummary === true) continue;
      const originKind = o?.origin?.kind;
      if (typeof originKind === "string" && originKind !== "human") continue;
      const content = o.message?.content;
      let hasImages = false;
      if (Array.isArray(content)) {
        if (content.some((b: any) => b?.type === "tool_result")) continue;
        hasImages = content.some((b: any) => b?.type === "image");
      }
      if (!this.isRealUserText(o) && !hasImages) continue;
      const t = this.userText(o);
      out.push({ text: splitAttachedContext(t).text || t, hasImages, line: seen });
    }
    return out;
  }

  /** 回退到「第 cutLine 行之前」时应接续的链节点：取截点后第一条链记录（即该轮的
   *  提问）的 parentUuid——那才是这一轮当初接在哪个节点上；文件里若有被放弃的分支，
   *  「截点前最后一行」可能正好是旧分支的尾巴，会切到错误的分支。截点后没有链记录
   *  时退回截点前最后一条链记录。 */
  rewindLeafFor(sessionId: string, cutLine: number): string | undefined {
    const file = this.findFile(sessionId);
    if (!file) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    const ids = new Set<string>();
    let seen = 0;
    let firstAfter: any;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      seen++;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof o?.uuid !== "string" || !("parentUuid" in o)) continue;
      ids.add(o.uuid);
      if (seen > cutLine && !firstAfter) firstAfter = o;
    }
    const parent = firstAfter?.parentUuid;
    if (typeof parent === "string" && ids.has(parent)) return parent;
    return this.lastChainUuidBefore(sessionId, cutLine);
  }

  /** 被放弃分支上的记录 uuid：不在主链上、但沿 parentUuid 往上能走到主链节点的记录。
   *  主链 = 文件末尾链条目的祖先链（压缩边界经 logicalParentUuid 接上）。往上走到
   *  断链/根而未触及主链的记录属于孤儿树，不算放弃，照常显示。 */
  private abandonedSet(all: any[]): Set<string> {
    const byId = new Map<string, any>();
    let leaf: any;
    for (const o of all) {
      if (typeof o?.uuid === "string" && "parentUuid" in o) {
        byId.set(o.uuid, o);
        leaf = o;
      }
    }
    const chain = new Set<string>();
    for (let cur = leaf; cur && !chain.has(cur.uuid); ) {
      chain.add(cur.uuid);
      const next = cur.parentUuid ?? cur.logicalParentUuid;
      cur = typeof next === "string" ? byId.get(next) : undefined;
    }
    const abandoned = new Set<string>();
    const verdict = new Map<string, boolean>(); // uuid -> 是否挂在主链下（即被放弃）
    for (const o of byId.values()) {
      if (chain.has(o.uuid)) continue;
      const path: any[] = [];
      let cur: any = o;
      let hangsOffChain = false;
      while (cur && !verdict.has(cur.uuid) && !path.includes(cur)) {
        if (chain.has(cur.uuid)) {
          hangsOffChain = true;
          break;
        }
        path.push(cur);
        cur = typeof cur.parentUuid === "string" ? byId.get(cur.parentUuid) : undefined;
      }
      if (cur && verdict.has(cur.uuid)) hangsOffChain = verdict.get(cur.uuid)!;
      for (const p of path) {
        verdict.set(p.uuid, hangsOffChain);
        if (hangsOffChain) abandoned.add(p.uuid);
      }
    }
    return abandoned;
  }

  /** 截断点之后的第一条真人消息（提问文本 + 随附图片）——还原时既做对齐校验，
   *  也把图片趁截断前取出来带回输入框（截断后 transcript 里就没有这条消息了）。
   *  纯图片消息正文为空、过不了 isRealUserText，这里单独认；isMeta / 非 human
   *  注入照旧跳过，别把 IDE 注入或工具回执里的图片当成用户消息。
   *  返回 undefined 表示截断点之后没有真人消息（无从校验，交由调用方放行）。 */
  firstUserTurnAfter(
    sessionId: string,
    afterLines: number,
  ): { text: string; images: { mediaType: string; data: string }[] } | undefined {
    const file = this.findFile(sessionId);
    if (!file) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    let seen = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      seen++;
      if (seen <= afterLines) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o?.type !== "user") continue;
      if (o.isMeta === true || o.isCompactSummary === true) continue;
      const originKind = o?.origin?.kind;
      if (typeof originKind === "string" && originKind !== "human") continue;
      const content = o.message?.content;
      const images: { mediaType: string; data: string }[] = [];
      if (Array.isArray(content)) {
        if (content.some((b: any) => b?.type === "tool_result")) continue;
        for (const b of content) {
          if (b?.type === "image" && b.source?.type === "base64" && b.source.data) {
            images.push({ mediaType: b.source.media_type || "image/png", data: b.source.data });
          }
        }
      }
      if (!this.isRealUserText(o) && !images.length) continue;
      const t = this.userText(o);
      return { text: splitAttachedContext(t).text || t, images };
    }
    return undefined;
  }

  findFile(sessionId: string): string | undefined {
    for (const dir of this.projectDirs()) {
      const f = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
    return undefined;
  }

  /** 官方 CLI 在 ~/.claude 下按 sessionId 建的附属目录。只删 transcript 的话它们
   *  会永远堆着（实测一台机器攒了 61 个孤儿），且官方侧仍认得这个会话——所以
   *  "删了还在"。删会话时一并清理。 */
  private static readonly SIDECAR_DIRS = ["file-history", "session-env", "tasks", "sessions"];

  delete(sessionId: string): boolean {
    const f = this.findFile(sessionId);
    let ok = false;
    if (f) {
      try {
        fs.unlinkSync(f);
        ok = true;
      } catch {
        /* 文件可能被占用；附属目录仍继续清理 */
      }
      // 新版 CLI 在 transcript 旁边还有同名目录（subagents/ 子agent对话、
      // tool-results/ 等）——里面是对话内容，比 sidecar 更该跟着删。
      try {
        const sib = path.join(path.dirname(f), sessionId);
        if (fs.existsSync(sib)) fs.rmSync(sib, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    this.deleteSidecars(sessionId);
    return ok;
  }

  /** 清理某会话在 ~/.claude 下的附属数据（目录或同名 .json）。best-effort。 */
  deleteSidecars(sessionId: string): void {
    for (const dir of SessionStore.SIDECAR_DIRS) {
      for (const name of [sessionId, `${sessionId}.json`, `${sessionId}.jsonl`]) {
        const p = path.join(this.configDir(), dir, name);
        try {
          if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 扫掉所有"transcript 已不存在"的附属目录——历史遗留的孤儿。返回清理数量。
   *  sidecar 目录是全局的（不分项目），所以存活集必须收集**所有**项目的
   *  transcript——只看当前工作区会把其他项目的活会话当孤儿误删（实锤 bug）。 */
  sweepOrphanSidecars(): number {
    const live = new Set<string>();
    const projectsRoot = path.join(this.configDir(), "projects");
    let projDirs: string[];
    try {
      projDirs = fs
        .readdirSync(projectsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(projectsRoot, d.name));
    } catch {
      return 0; // projects 都读不到：环境异常，别动任何数据
    }
    for (const dir of projDirs) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith(".jsonl")) live.add(f.slice(0, -6));
        }
      } catch {
        /* ignore */
      }
    }
    // 一个 transcript 都读不到时果断放弃：可能是路径判断出错，别误删用户数据。
    if (!live.size) return 0;
    const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    let removed = 0;
    for (const dir of SessionStore.SIDECAR_DIRS) {
      const base = path.join(this.configDir(), dir);
      let entries: string[];
      try {
        entries = fs.readdirSync(base);
      } catch {
        continue;
      }
      for (const e of entries) {
        const id = e.replace(/\.(json|jsonl)$/, "");
        // 只认 uuid 形态，避免误伤官方将来放进去的其它文件。
        if (!isUuid(id)) continue;
        if (live.has(id)) continue;
        try {
          fs.rmSync(path.join(base, e), { recursive: true, force: true });
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
    // projects/<enc>/<sid>/ 形态的同名目录（subagents/tool-results）：
    // 同目录下没有对应 .jsonl 的就是删会话时的历史残留。
    for (const dir of projDirs) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || !isUuid(e.name) || live.has(e.name)) continue;
        try {
          fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
    return removed;
  }

  /** Parse only the last `bytes` of a transcript (first partial line dropped).
   *  Falls back to a full read for small files. */
  private readTailLines(file: string, bytes: number): any[] {
    try {
      const size = fs.statSync(file).size;
      if (size <= bytes) return this.readLines(file);
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(bytes);
      try {
        fs.readSync(fd, buf, 0, bytes, size - bytes);
      } finally {
        fs.closeSync(fd);
      }
      const out: any[] = [];
      for (const line of buf.toString("utf8").split("\n").slice(1)) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t));
        } catch {
          /* skip */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private readLines(file: string): any[] {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const out: any[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /** CLI 注入的合成消息开头标签——这些挂在 user 角色下但不是用户敲的。 */
  private static readonly INJECTED_TAG_RE =
    /^<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|task-notification|system-reminder)>/;

  /** 按 Stop 后 CLI 写入的中断标记（user 角色、无 origin、无 isMeta）——
   *  实时流从不显示它，历史回放也不该显示。 */
  private static readonly INTERRUPT_MARK_RE = /^\[Request interrupted by user( for tool use)?\]$/;

  private static isInjectedText(t: string): boolean {
    return SessionStore.INJECTED_TAG_RE.test(t) || SessionStore.INTERRUPT_MARK_RE.test(t);
  }

  /** True for genuine user-typed text (not tool results or synthetic injects). */
  private isRealUserText(o: any): boolean {
    // Skip CLI-generated meta turns: /compact summaries, slash-command echoes,
    // and local-command stdout/caveat wrappers — these aren't real user input.
    if (o?.isMeta === true || o?.isCompactSummary === true) return false;
    // 权威标记（新版 CLI 写入）：origin.kind==="human" 才是真人消息；
    // "task-notification" 等一律是系统注入（曾被当成用户气泡渲染过——实锤 bug）。
    const originKind = o?.origin?.kind;
    if (typeof originKind === "string" && originKind !== "human") return false;
    const c = o.message?.content;
    if (typeof c === "string") {
      const t = c.trim();
      if (!t) return false;
      if (SessionStore.isInjectedText(t)) return false;
      return true;
    }
    if (Array.isArray(c)) {
      const texts = c.filter((b) => b?.type === "text" && b.text?.trim());
      const hasToolResult = c.some((b) => b?.type === "tool_result");
      if (!texts.length || hasToolResult) return false;
      // 老条目没有 origin——数组形态的正文同样要按开头标签兜底过滤。
      return !SessionStore.isInjectedText(String(texts[0].text).trim());
    }
    return false;
  }

  private userText(o: any): string {
    const c = o.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
    return "";
  }
}

/**
 * Separate a stored user message into the real input text and the names of any
 * auto-attached files/dirs. The attachment dump is embedded between sentinels
 * (new messages) — for older messages we fall back to the leading phrase. Only
 * file/dir names are surfaced (as chips); the embedded contents are dropped.
 */
function splitAttachedContext(raw: string): { text: string; files: string[]; sls: boolean } {
  if (!raw) return { text: "", files: [], sls: false };
  // Strip the SLS log-tool snippet (injected by the composer toggle) — surface it
  // only as a flag/chip, never render its body.
  let sls = false;
  {
    const o = raw.indexOf(SLS_CTX_OPEN);
    const c = raw.indexOf(SLS_CTX_CLOSE);
    if (o !== -1 && c !== -1 && c > o) {
      sls = true;
      raw = (raw.slice(0, o) + raw.slice(c + SLS_CTX_CLOSE.length)).trim();
    }
  }
  const files: string[] = [];
  const seen = new Set<string>();
  const addFile = (p: string) => {
    const base = (p || "").trim().split(/[\\/]/).pop() || "";
    if (base && !seen.has(base)) {
      seen.add(base);
      files.push(base);
    }
  };

  // Strip the official Claude extension's IDE context tags (sessions created
  // there embed these into user messages). Surface the opened file as a chip.
  raw = raw.replace(/<ide_opened_file>([\s\S]*?)<\/ide_opened_file>/g, (_m, inner: string) => {
    const mm = /opened the file\s+(.+?)\s+in the IDE/.exec(inner);
    if (mm) addFile(mm[1]);
    return "";
  });
  raw = raw.replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, ""); // ide_selection, ide_diagnostics, …
  raw = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  raw = raw.trim();
  if (!raw) return { text: "", files, sls };

  let block = "";
  let text = raw;
  const open = raw.indexOf(CTX_OPEN);
  const close = raw.indexOf(CTX_CLOSE);
  if (open !== -1 && close !== -1 && close > open) {
    block = raw.slice(open + CTX_OPEN.length, close);
    text = (raw.slice(0, open) + raw.slice(close + CTX_CLOSE.length)).trim();
  } else if (raw.startsWith("用户附带了以下文件作为上下文：")) {
    // Legacy (un-sentineled): the whole leading dump can't be cleanly split
    // from the trailing input, so just extract the file names for chips.
    block = raw;
    text = "";
  } else {
    return { text: raw, files, sls };
  }
  const re = /^(?:文件|目录) (.+?)(?:\/ 包含:|：|:|（|\(|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    if (m[1].trim()) addFile(m[1]);
  }
  return { text, files, sls };
}

/** Build a data: URI from an Anthropic image content block (base64 source). */
function imageDataUri(block: any): string | undefined {
  const src = block?.source;
  if (!src) return undefined;
  if (src.type === "base64" && src.data) {
    return `data:${src.media_type || "image/png"};base64,${src.data}`;
  }
  if (src.type === "url" && typeof src.url === "string") return src.url;
  return undefined;
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function stringify(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // 非 text 块与实时侧 stringifyToolResult 对齐（JSON 序列化），否则同一个
    // 工具卡片实时显示有内容、重启后回放变空行。
    return content.map((c) => (typeof c === "string" ? c : (c as any).text ?? JSON.stringify(c))).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}
