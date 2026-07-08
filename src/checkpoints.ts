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
  /** Pre-session content of files whose ORIGINAL snapshot lived in a checkpoint
   *  that has since been pruned. Without this, `originalOf()` would return a
   *  mid-session snapshot (already containing Claude's earlier edits) and
   *  "revert file" would silently keep those edits while claiming success. */
  private baseline = new Map<string, string | null>();
  private baselineSkipped = new Set<string>();
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
      // Fold the dropped checkpoints' EARLIEST snapshots into `baseline` before
      // discarding them — they are the only record of the files' pre-session
      // content. Dropping them outright corrupts revert/diff.
      const cut = this.checkpoints.length - MAX_CHECKPOINTS;
      for (const c of this.checkpoints.slice(0, cut)) {
        for (const f of c.files) if (!this.baseline.has(f.path)) this.baseline.set(f.path, f.content);
        for (const s of c.skipped ?? []) this.baselineSkipped.add(s);
      }
      this.checkpoints = this.checkpoints.slice(cut);
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

  /** All file paths touched during this session (incl. pruned-away turns). */
  changedPaths(): string[] {
    const set = new Set<string>(this.baseline.keys());
    for (const c of this.checkpoints) for (const f of c.files) set.add(f.path);
    return [...set];
  }

  /**
   * Accept a file's changes: drop its snapshots so it no longer appears as a
   * pending change (the on-disk content is kept as the new baseline).
   */
  accept(path: string): void {
    let changed = this.baseline.delete(path);
    this.baselineSkipped.delete(path);
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
    // Pruned turns hold the TRUE earliest content — check them first.
    if (this.baseline.has(path)) return this.baseline.get(path);
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
    // Restoring the OLDEST surviving checkpoint means going back to the session
    // baseline — pruned turns' un-snapshottable files must be reported too.
    if (idx === 0) for (const s of this.baselineSkipped) skippedSet.add(s);

    // Earliest backup per path across checkpoints[idx..] == pre-turn content.
    const target = new Map<string, string | null>();
    for (let i = idx; i < this.checkpoints.length; i++) {
      for (const b of this.checkpoints[i].files) {
        if (!target.has(b.path)) target.set(b.path, b.content);
      }
    }
    // Rewinding to the oldest surviving turn == rewinding to the session start:
    // files whose only snapshot lived in a pruned turn must revert to baseline.
    if (idx === 0) for (const [p, c] of this.baseline) if (!target.has(p)) target.set(p, c);

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
    // Everything at/after idx is undone; if we went all the way back, the
    // baseline has been applied to disk and is no longer pending.
    if (idx === 0) {
      this.baseline.clear();
      this.baselineSkipped.clear();
    }
    this.persist();
    return { restoredFiles: restored, skipped: [...skippedSet], userText, truncateLine };
  }

  clear(): void {
    this.checkpoints = [];
    this.baseline.clear();
    this.baselineSkipped.clear();
    this.persist();
  }

  /** Force any debounced snapshot write to disk (window closing / disposal). */
  flush(): void {
    if (this.persistTimer) this.persist();
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
    this.checkpoints = [];
    this.baseline = new Map();
    this.baselineSkipped = new Set();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8"));
      // Legacy files are a bare array; new ones carry the folded baseline too.
      if (Array.isArray(raw)) {
        this.checkpoints = raw;
      } else if (raw && Array.isArray(raw.checkpoints)) {
        this.checkpoints = raw.checkpoints;
        for (const [p, c] of raw.baseline ?? []) this.baseline.set(p, c);
        for (const s of raw.baselineSkipped ?? []) this.baselineSkipped.add(s);
      }
    } catch {
      /* absent/corrupt — start clean */
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
      const payload = {
        checkpoints: this.checkpoints,
        baseline: [...this.baseline],
        baselineSkipped: [...this.baselineSkipped],
      };
      fs.writeFileSync(this.file(), JSON.stringify(payload), "utf8");
    } catch {
      /* ignore persistence failure */
    }
  }
}

function shortLabel(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? t.slice(0, 48) + "…" : t || "(空消息)";
}
