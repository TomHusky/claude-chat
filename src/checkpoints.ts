import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CheckpointSummary } from "./shared";

interface FileBackup {
  path: string;
  /** Pre-edit content, or null if the file did not exist (i.e. was created). */
  content: string | null;
}

interface Checkpoint {
  id: string;
  label: string;
  createdAt: number;
  userText: string;
  files: FileBackup[];
  /** Files touched this turn that could NOT be snapshotted (too large / binary).
   *  Restore must surface these — silently reporting success while a file keeps
   *  Claude's edits is a lie. */
  skipped?: string[];
  /** Number of lines the session .jsonl had *before* this turn ran. Restoring
   *  this checkpoint truncates the transcript back to this many lines. */
  truncateLine: number;
}

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** Oldest checkpoints beyond this are pruned (their earliest-baseline role for
 *  the changed-files panel passes to the next snapshot). Keeps globalStorage
 *  from growing without bound: each checkpoint can hold full file contents. */
const MAX_CHECKPOINTS = 40;

/**
 * Restore points. A checkpoint is created at each user turn. Before any
 * file-modifying tool runs, the target file's current content is snapshotted
 * into the active checkpoint. Restoring a checkpoint reverts every file change
 * made at or after that point.
 */
export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  private sessionId?: string;

  constructor(private readonly storageDir: string) {}

  setSession(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.load();
  }

  /**
   * Open a new checkpoint for a user turn.
   * @param truncateLine line count of the session transcript before this turn.
   */
  beginTurn(userText: string, truncateLine: number): string {
    const id = randomUUID();
    this.checkpoints.push({
      id,
      label: shortLabel(userText),
      createdAt: Date.now(),
      userText,
      files: [],
      truncateLine,
    });
    if (this.checkpoints.length > MAX_CHECKPOINTS) {
      this.checkpoints = this.checkpoints.slice(-MAX_CHECKPOINTS);
    }
    this.persist();
    return id;
  }

  /** Snapshot a file before it is modified (idempotent within a checkpoint). */
  snapshotFile(absPath: string): void {
    const cp = this.current();
    if (!cp) return;
    if (cp.files.some((f) => f.path === absPath) || cp.skipped?.includes(absPath)) return;
    let content: string | null = null;
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > MAX_SNAPSHOT_BYTES) {
        (cp.skipped ??= []).push(absPath); // too large — restore must report it
        this.persistSoon();
        return;
      }
      const buf = fs.readFileSync(absPath);
      // Binary files round-tripped through utf8 come back corrupted — skip them.
      if (buf.subarray(0, 8192).includes(0)) {
        (cp.skipped ??= []).push(absPath);
        this.persistSoon();
        return;
      }
      content = buf.toString("utf8");
    } catch {
      content = null; // file does not exist yet -> created by this turn
    }
    cp.files.push({ path: absPath, content });
    // Debounced: a turn with many edits otherwise rewrites the (potentially
    // multi-MB) snapshot JSON once per tool call, on the host thread.
    this.persistSoon();
  }

  list(): CheckpointSummary[] {
    return this.checkpoints.map((c) => ({
      id: c.id,
      label: c.label,
      createdAt: c.createdAt,
      userText: c.userText,
      fileCount: c.files.length,
    }));
  }

  hasAny(): boolean {
    return this.checkpoints.length > 0;
  }

  preview(checkpointId: string): { userText: string } | undefined {
    const c = this.checkpoints.find((x) => x.id === checkpointId);
    return c ? { userText: c.label } : undefined;
  }

  /** All file paths touched during this session. */
  changedPaths(): string[] {
    const set = new Set<string>();
    for (const c of this.checkpoints) for (const f of c.files) set.add(f.path);
    return [...set];
  }

  /**
   * Accept a file's changes: drop its snapshots so it no longer appears as a
   * pending change (the on-disk content is kept as the new baseline).
   */
  accept(path: string): void {
    let changed = false;
    for (const c of this.checkpoints) {
      const before = c.files.length;
      c.files = c.files.filter((f) => f.path !== path);
      if (c.files.length !== before) changed = true;
    }
    if (changed) this.persist();
  }

  /**
   * The session-baseline content of a path: the earliest snapshot taken
   * (i.e. its content before Claude first touched it this session).
   * Returns null if the file did not exist at baseline, undefined if untracked.
   */
  originalOf(path: string): string | null | undefined {
    for (const c of this.checkpoints) {
      const f = c.files.find((x) => x.path === path);
      if (f) return f.content;
    }
    return undefined;
  }

  /**
   * Revert workspace files to the state just before the given checkpoint's
   * turn, and drop that checkpoint and everything after it.
   * Returns the number of files reverted.
   */
  restore(checkpointId: string): { restoredFiles: number; skipped: string[]; userText: string; truncateLine: number } | undefined {
    const idx = this.checkpoints.findIndex((c) => c.id === checkpointId);
    if (idx < 0) return undefined;
    const truncateLine = this.checkpoints[idx].truncateLine;
    // Files we could never snapshot (large/binary) keep Claude's edits — collect
    // them so the caller can tell the user instead of claiming a full revert.
    const skippedSet = new Set<string>();
    for (let i = idx; i < this.checkpoints.length; i++) {
      for (const s of this.checkpoints[i].skipped ?? []) skippedSet.add(s);
    }

    // Earliest backup per path across checkpoints[idx..] == pre-turn content.
    const target = new Map<string, string | null>();
    for (let i = idx; i < this.checkpoints.length; i++) {
      for (const b of this.checkpoints[i].files) {
        if (!target.has(b.path)) target.set(b.path, b.content);
      }
    }

    let restored = 0;
    for (const [p, content] of target) {
      try {
        if (content === null) {
          if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            restored++;
          }
        } else {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content, "utf8");
          restored++;
        }
      } catch {
        /* best effort per file */
      }
    }

    const userText = this.checkpoints[idx].userText;
    this.checkpoints = this.checkpoints.slice(0, idx);
    this.persist();
    return { restoredFiles: restored, skipped: [...skippedSet], userText, truncateLine };
  }

  clear(): void {
    this.checkpoints = [];
    this.persist();
  }

  private current(): Checkpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  private file(): string {
    return path.join(this.storageDir, `checkpoints-${this.sessionId ?? "none"}.json`);
  }

  /** Delete the persisted checkpoint file of a session (used when the session
   *  itself is deleted — otherwise globalStorage grows forever). */
  static deleteFor(storageDir: string, sessionId: string): void {
    try {
      fs.unlinkSync(path.join(storageDir, `checkpoints-${sessionId}.json`));
    } catch {
      /* absent is fine */
    }
  }

  private load(): void {
    try {
      this.checkpoints = JSON.parse(fs.readFileSync(this.file(), "utf8"));
      if (!Array.isArray(this.checkpoints)) this.checkpoints = [];
    } catch {
      this.checkpoints = [];
    }
  }

  private persistTimer?: ReturnType<typeof setTimeout>;

  /** Debounced persist for high-frequency snapshot writes. */
  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, 500);
  }

  private persist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify(this.checkpoints), "utf8");
    } catch {
      /* ignore persistence failure */
    }
  }
}

function shortLabel(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? t.slice(0, 48) + "…" : t || "(空消息)";
}
