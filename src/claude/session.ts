import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CTX_OPEN, CTX_CLOSE, SessionSummary, TimelineItem } from "../shared";

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
  list(): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const dir of this.projectDirs()) {
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const full = path.join(dir, file);
        try {
          const stat = fs.statSync(full);
          const { title, messageCount } = this.peek(full);
          if (messageCount === 0) continue; // skip empty/aborted sessions
          out.push({
            id: file.replace(/\.jsonl$/, ""),
            title,
            updatedAt: stat.mtimeMs,
            messageCount,
          });
        } catch {
          /* ignore unreadable file */
        }
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Cheap scan: first user prompt as title + count of user turns. */
  private peek(file: string): { title: string; messageCount: number } {
    const lines = this.readLines(file);
    let title = "新对话";
    let messageCount = 0;
    let gotTitle = false;
    for (const o of lines) {
      if (o.type === "ai-title" && typeof o.title === "string" && !gotTitle) {
        title = o.title;
        gotTitle = true;
      }
      if (o.type === "user" && this.isRealUserText(o)) {
        messageCount++;
        if (!gotTitle && title === "新对话") {
          // Strip IDE/attached-context noise so the title is the real first message.
          const clean = splitAttachedContext(this.userText(o)).text;
          if (clean) title = truncate(clean, 60);
        }
      }
    }
    return { title, messageCount };
  }

  /** Rehydrate a full session transcript into renderable timeline items. */
  load(sessionId: string): TimelineItem[] {
    const file = this.findFile(sessionId);
    if (!file) return [];
    const items: TimelineItem[] = [];
    const toolIndex = new Map<string, number>(); // tool_use_id -> items index
    for (const o of this.readLines(file)) {
      if (o.type === "user" && Array.isArray(o.message?.content)) {
        const images: string[] = [];
        for (const b of o.message.content) {
          if (b?.type === "tool_result") {
            const idx = toolIndex.get(b.tool_use_id);
            if (idx !== undefined) {
              const item = items[idx];
              if (item.type === "tool") {
                item.result = stringify(b.content);
                item.isError = !!b.is_error;
              }
            }
          } else if (b?.type === "image") {
            const uri = imageDataUri(b);
            if (uri) images.push(uri);
          }
        }
        if (this.isRealUserText(o) || images.length) {
          const { text, files } = splitAttachedContext(this.userText(o));
          // Skip pure IDE-context injections (no real text, no images).
          if (text || images.length) {
            items.push({
              type: "user",
              text,
              files: files.length ? files : undefined,
              images: images.length ? images : undefined,
            });
          }
        }
      } else if (o.type === "user" && typeof o.message?.content === "string") {
        if (this.isRealUserText(o)) {
          const { text, files } = splitAttachedContext(o.message.content);
          if (text) items.push({ type: "user", text, files: files.length ? files : undefined });
        }
      } else if (o.type === "assistant" && Array.isArray(o.message?.content)) {
        for (const b of o.message.content) {
          if (b?.type === "text" && b.text?.trim()) {
            items.push({ type: "assistant_text", text: b.text });
          } else if (b?.type === "thinking" && b.thinking?.trim()) {
            items.push({ type: "thinking", text: b.thinking });
          } else if (b?.type === "tool_use") {
            toolIndex.set(b.id, items.length);
            items.push({ type: "tool", toolId: b.id, name: b.name, input: b.input });
          } else if (b?.type === "image") {
            const uri = imageDataUri(b);
            if (uri) items.push({ type: "image", src: uri });
          }
        }
      }
    }
    return items;
  }

  /** Approx context used by a session = the last assistant message's full prompt
   *  (input + cached) plus its output, along with that message's model id (so the
   *  caller can pick the right context window). Undefined if no usage found. */
  lastContextUsage(sessionId: string): { used: number; model?: string } | undefined {
    const file = this.findFile(sessionId);
    if (!file) return undefined;
    let result: { used: number; model?: string } | undefined;
    for (const o of this.readLines(file)) {
      const msg = (o as any)?.message;
      const u = msg?.usage;
      if (o.type === "assistant" && u) {
        const v =
          (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0) +
          (u.output_tokens || 0);
        if (v > 0) result = { used: v, model: msg?.model };
      }
    }
    return result;
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

  /**
   * Truncate a session transcript to its first `keepLines` non-empty lines.
   * This is how a restore point rewinds the conversation: resuming the
   * truncated session makes Claude forget everything after the cut.
   * Returns the number of real user turns remaining after truncation.
   */
  truncateToLines(sessionId: string, keepLines: number): number {
    const file = this.findFile(sessionId);
    if (!file) return 0;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return 0;
    }
    const out: string[] = [];
    let kept = 0;
    let userTurns = 0;
    for (const line of raw.split("\n")) {
      if (line.trim()) {
        if (kept >= keepLines) break;
        kept++;
        try {
          const o = JSON.parse(line);
          if (o.type === "user" && this.isRealUserText(o)) userTurns++;
        } catch {
          /* keep non-JSON lines verbatim */
        }
      }
      out.push(line);
    }
    try {
      fs.writeFileSync(file, out.join("\n").replace(/\n*$/, "\n"), "utf8");
    } catch {
      /* best effort */
    }
    return userTurns;
  }

  findFile(sessionId: string): string | undefined {
    for (const dir of this.projectDirs()) {
      const f = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
    return undefined;
  }

  delete(sessionId: string): boolean {
    const f = this.findFile(sessionId);
    if (!f) return false;
    try {
      fs.unlinkSync(f);
      return true;
    } catch {
      return false;
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

  /** True for genuine user-typed text (not tool results or synthetic injects). */
  private isRealUserText(o: any): boolean {
    const c = o.message?.content;
    if (typeof c === "string") return c.trim().length > 0;
    if (Array.isArray(c)) {
      const hasText = c.some((b) => b?.type === "text" && b.text?.trim());
      const hasToolResult = c.some((b) => b?.type === "tool_result");
      return hasText && !hasToolResult;
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
function splitAttachedContext(raw: string): { text: string; files: string[] } {
  if (!raw) return { text: "", files: [] };
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
  if (!raw) return { text: "", files };

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
    return { text: raw, files };
  }
  const re = /^(?:文件|目录) (.+?)(?:\/ 包含:|：|:|（|\(|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    if (m[1].trim()) addFile(m[1]);
  }
  return { text, files };
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
    return content.map((c) => (typeof c === "string" ? c : (c as any).text ?? "")).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}
