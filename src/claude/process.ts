import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import {
  AssistantEvent,
  ContentBlock,
  ControlRequest,
  isCanUseTool,
  OutEvent,
  PermissionDecision,
  ResultEvent,
  StreamEvent,
  SystemInitEvent,
  ToolUseBlock,
} from "./protocol";
import { contextWindowFor, PermissionSuggestionView, ToWebview } from "../shared";

export interface ClaudeProcessOptions {
  claudePath: string;
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode: string;
  /** Resume an existing session id instead of creating a new one. */
  resumeSessionId?: string;
  /** Force a specific session id for a brand new session. */
  sessionId?: string;
  addDirs?: string[];
  /** Extra instruction appended to the default system prompt (e.g. reply language). */
  appendSystemPrompt?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PermissionRequest {
  requestId: string;
  toolUseId?: string;
  toolName: string;
  displayName?: string;
  input: Record<string, unknown>;
  description?: string;
  blockedPath?: string;
  suggestions: PermissionSuggestionView[];
}

export interface ClaudeProcessHooks {
  /** Normalized events destined for the webview. */
  emit: (e: ToWebview) => void;
  /** A tool wants permission. The provider decides (auto / forward to UI). */
  onPermission: (req: PermissionRequest) => void;
  /** Session id became known (from system/init). */
  onSessionId: (id: string, resumed: boolean) => void;
  /** Process exited. */
  onClose: (code: number | null) => void;
}

/**
 * Drives a single long-lived `claude` CLI process in bidirectional
 * stream-json mode. One instance == one chat session.
 */
export class ClaudeProcess {
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: readline.Interface;
  private exited = false;
  private readonly pendingControl = new Map<string, { resolve: (resp: unknown) => void; reject: (err: Error) => void }>();
  /** Per pending can_use_tool ask: the original input (echoed back on allow)
   *  plus the CLI's RAW permission suggestions — echoing a chosen suggestion in
   *  `updatedPermissions` is what makes "总是允许" actually persist. */
  private readonly pendingPermissions = new Map<string, { input: Record<string, unknown>; suggestions: unknown[] }>();
  private sessionId?: string;
  private initialized = false;
  private disposed = false;
  private currentBlockType?: "text" | "thinking" | "tool_use";
  private currentToolId?: string; // tool_use block currently streaming its input JSON
  private currentToolName?: string;
  private currentToolJson = ""; // accumulated partial input JSON for the live tool
  private currentModel?: string; // model id from the init event (for context window)
  private busy = false;
  private pendingMode?: string; // mode change requested before the handshake finished
  private readonly seenToolIds = new Set<string>();

  constructor(
    private readonly opts: ClaudeProcessOptions,
    private readonly hooks: ClaudeProcessHooks,
  ) {}

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Spawn the CLI and perform the initialize handshake. */
  async start(): Promise<void> {
    const args = this.buildArgs();
    this.proc = spawn(this.opts.claudePath, args, {
      cwd: this.opts.cwd,
      // Identify as the VS Code entrypoint (not "sdk-cli") so the sessions we
      // create show up in the official Claude extension's session list, which
      // filters out headless/SDK sessions.
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "claude-vscode", ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.proc.on("error", (err) => {
      this.hooks.emit({
        kind: "error",
        message:
          `无法启动 claude CLI (${this.opts.claudePath}): ${err.message}。` +
          ` 请检查 设置 claudeChat.claudePath，或确认 \`claude\` 在 PATH 中。`,
      });
    });

    // Without a listener, an async EPIPE on stdin (CLI died mid-write) is an
    // uncaught exception that takes down the whole extension host.
    this.proc.stdin.on("error", () => undefined);

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));

    let stderrBuf = "";
    this.proc.stderr.on("data", (d: Buffer) => {
      // Keep only the tail — the CLI is chatty and the buffer must not grow forever.
      stderrBuf = (stderrBuf + d.toString()).slice(-4096);
    });

    this.proc.on("close", (code) => {
      this.exited = true;
      // Unblock anyone awaiting the control channel (initialize/interrupt/…):
      // the process is gone, no response will ever come. Without this, start()
      // hangs for the full 30s timeout when the CLI dies during the handshake.
      for (const [, pending] of this.pendingControl) pending.reject(new Error("claude 进程已退出"));
      this.pendingControl.clear();
      if (this.disposed) return; // intentional shutdown — don't disturb the ctx (a new proc may be live)
      // Close out any permission dialogs still on screen — no answer will come.
      for (const requestId of [...this.pendingPermissions.keys()]) {
        this.pendingPermissions.delete(requestId);
        this.hooks.emit({ kind: "permission_resolved", requestId, behavior: "deny" });
      }
      if (code && code !== 0 && stderrBuf.trim()) {
        this.hooks.emit({ kind: "error", message: `claude 进程退出 (code ${code}): ${stderrBuf.trim().slice(0, 800)}` });
      }
      this.setBusy(false);
      this.hooks.onClose(code);
    });

    // Handshake: must complete before sending user turns, and it is what
    // enables `can_use_tool` permission prompts over the control channel.
    await this.sendControlRequest({ subtype: "initialize" });
    this.initialized = true;
    // A mode change arrived mid-handshake — apply it now, or this process keeps
    // running the mode it was spawned with while the picker says otherwise.
    if (this.pendingMode) {
      const mode = this.pendingMode;
      this.pendingMode = undefined;
      // A refused mode switch must not fail the whole spawn — the process is
      // usable, just in its spawn-time mode.
      try {
        await this.setPermissionMode(mode);
      } catch {
        /* keep the spawned mode */
      }
    }
  }

  private buildArgs(): string[] {
    const a: string[] = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      this.opts.permissionMode || "default",
    ];
    if (this.opts.model) a.push("--model", this.opts.model);
    if (this.opts.effort) a.push("--effort", this.opts.effort);
    if (this.opts.resumeSessionId) a.push("--resume", this.opts.resumeSessionId);
    else if (this.opts.sessionId) a.push("--session-id", this.opts.sessionId);
    for (const dir of this.opts.addDirs ?? []) a.push("--add-dir", dir);
    if (this.opts.appendSystemPrompt) a.push("--append-system-prompt", this.opts.appendSystemPrompt);
    return a;
  }

  // -- Sending -------------------------------------------------------------

  /** Send a user turn. `context` is prepended; `images` are attached as blocks. */
  sendUserMessage(text: string, context?: string, images?: { mediaType: string; data: string }[]): void {
    if (!this.proc || !this.initialized) return;
    const body = context ? `${context}\n\n${text}` : text;
    this.setBusy(true);
    const content: Array<Record<string, unknown>> = [];
    for (const img of images ?? []) {
      content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    }
    content.push({ type: "text", text: body });
    this.write({ type: "user", message: { role: "user", content } });
  }

  /** Run `/compact`: ask the CLI to summarize and shrink the conversation
   *  context. The CLI streams a `compacting` status, then a `compact_boundary`
   *  system event with pre/post token counts, then a normal `result`. */
  compact(): void {
    if (!this.proc || !this.initialized) return;
    this.setBusy(true);
    this.write({ type: "user", message: { role: "user", content: [{ type: "text", text: "/compact" }] } });
  }

  /** Resolve a pending permission request (called by the provider). When the
   *  user chose a suggestion ("总是允许…"), echo the CLI's raw suggestion object
   *  in `updatedPermissions` — the CLI then applies it to the live session AND
   *  persists it (settings), so the same ask doesn't come back forever. */
  respondPermission(requestId: string, decision: { behavior: "allow" | "deny"; message?: string; suggestionId?: string }): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending === undefined) return;
    this.pendingPermissions.delete(requestId);

    let response: PermissionDecision;
    if (decision.behavior === "allow") {
      response = { behavior: "allow", updatedInput: pending.input };
      const m = /^sugg:(\d+)$/.exec(decision.suggestionId ?? "");
      const raw = m ? pending.suggestions[Number(m[1])] : undefined;
      if (raw) (response as Record<string, unknown>).updatedPermissions = [raw];
    } else {
      response = { behavior: "deny", message: decision.message ?? "用户拒绝了此操作。", interrupt: false };
    }

    this.write({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
    this.hooks.emit({ kind: "permission_resolved", requestId, behavior: decision.behavior });
  }

  /** Answer an AskUserQuestion tool: echo the input plus an `answers` map
   *  (question text -> chosen label / labels) so the CLI returns the selection. */
  answerQuestion(requestId: string, answers: Record<string, string | string[]>): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending === undefined) return;
    this.pendingPermissions.delete(requestId);
    const response: PermissionDecision = {
      behavior: "allow",
      updatedInput: { ...pending.input, answers },
    };
    this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    this.hooks.emit({ kind: "permission_resolved", requestId, behavior: "allow" });
  }

  /** Interrupt the current turn. */
  async interrupt(): Promise<void> {
    if (!this.proc) return;
    // Clear the busy UI up front so Stop always feels instant — even if the
    // control request is slow to come back (e.g. fired during init or a
    // non-streaming phase). Waiting on the round-trip first made Stop look dead.
    this.setBusy(false);
    // Deny any in-flight permission asks so the turn can unwind cleanly.
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.respondPermission(requestId, { behavior: "deny", message: "已中断。" });
    }
    try {
      await this.sendControlRequest({ subtype: "interrupt" });
    } catch {
      /* best effort */
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (!this.proc || this.exited) return;
    if (!this.initialized) {
      // Spawned with the old mode but still handshaking: a control request now
      // would wait out the 30s timeout. Remember it and apply after initialize.
      this.pendingMode = mode;
      return;
    }
    // Let rejections propagate — swallowing them made a refused mode switch look
    // like success while the process kept asking for every permission.
    await this.sendControlRequest({ subtype: "set_permission_mode", mode });
  }

  dispose(): void {
    this.disposed = true;
    this.rl?.close();
    if (this.proc && !this.exited) {
      try {
        this.proc.stdin.end();
      } catch {
        /* ignore */
      }
      this.proc.kill("SIGTERM");
      const p = this.proc;
      setTimeout(() => {
        // NOTE: `p.killed` is true as soon as SIGTERM was *sent*, not when the
        // process exits — check actual exit state or the escalation never fires.
        if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
      }, 2000);
    }
  }

  /** Dispose and wait until the child has actually exited (capped at ~3s).
   *  Needed before touching the transcript file (truncate/delete): the dying
   *  CLI can still flush buffered lines, silently undoing a rewind/delete. */
  disposeAndWait(): Promise<void> {
    const p = this.proc;
    const done = new Promise<void>((resolve) => {
      if (!p || this.exited || p.exitCode !== null || p.signalCode !== null) return resolve();
      p.once("close", () => resolve());
      setTimeout(resolve, 3000); // hard cap — don't block the UI forever
    });
    this.dispose();
    return done;
  }

  // -- Control channel -----------------------------------------------------

  private sendControlRequest(request: Record<string, unknown>): Promise<unknown> {
    const requestId = `req-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      if (this.exited) return reject(new Error("claude 进程已退出"));
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(new Error(`control_request timed out: ${String(request.subtype)}`));
      }, 30_000);
      this.pendingControl.set(requestId, {
        resolve: (resp) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.write({ type: "control_request", request_id: requestId, request });
    });
  }

  private write(obj: unknown): void {
    if (!this.proc || this.proc.stdin.destroyed) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  // -- Parsing -------------------------------------------------------------

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: OutEvent;
    try {
      ev = JSON.parse(trimmed) as OutEvent;
    } catch {
      return; // ignore non-JSON noise
    }
    this.handleEvent(ev);
  }

  private handleEvent(ev: OutEvent): void {
    // Events produced INSIDE a Task subagent carry parent_tool_use_id. Rendering
    // them would stomp the live tool-input state and show the subagent's inner
    // monologue as main-agent output — drop them (the Task tool_result summarizes).
    if ((ev as any).parent_tool_use_id && (ev.type === "stream_event" || ev.type === "assistant" || ev.type === "user")) {
      return;
    }
    switch (ev.type) {
      case "control_response": {
        const r = (ev as any).response;
        const cb = this.pendingControl.get(r?.request_id);
        if (cb) {
          this.pendingControl.delete(r.request_id);
          // A `subtype:"error"` reply is a REJECTION. Resolving it made every
          // caller (initialize, set_permission_mode) believe it succeeded.
          if (r?.subtype === "error") cb.reject(new Error(String(r.error ?? "control_request failed")));
          else cb.resolve(r);
        }
        return;
      }
      case "control_request":
        this.handleControlRequest(ev as ControlRequest);
        return;
      case "system":
        this.handleSystem(ev as SystemInitEvent);
        return;
      case "stream_event":
        this.handleStreamEvent(ev as StreamEvent);
        return;
      case "assistant":
        this.handleAssistant(ev as AssistantEvent);
        return;
      case "user":
        this.handleUser(ev as { message: { content: ContentBlock[] } });
        return;
      case "result":
        this.handleResult(ev as ResultEvent);
        return;
      default:
        return; // rate_limit_event and friends are ignored for now
    }
  }

  private handleControlRequest(ev: ControlRequest): void {
    if (isCanUseTool(ev.request)) {
      const req = ev.request;
      this.pendingPermissions.set(ev.request_id, {
        input: req.input,
        suggestions: (req.permission_suggestions as unknown[]) ?? [],
      });
      const suggestions = this.normalizeSuggestions(req);
      this.hooks.onPermission({
        requestId: ev.request_id,
        toolUseId: req.tool_use_id,
        toolName: req.tool_name,
        displayName: req.display_name,
        input: req.input,
        description: req.description,
        blockedPath: req.blocked_path,
        suggestions,
      });
      return;
    }
    // Unknown inbound control request — respond with an error so the CLI
    // doesn't block waiting on us.
    this.write({
      type: "control_response",
      response: { subtype: "error", request_id: ev.request_id, error: "unsupported control_request" },
    });
  }

  private normalizeSuggestions(req: { permission_suggestions?: unknown[] }): PermissionSuggestionView[] {
    const out: PermissionSuggestionView[] = [];
    const seen = new Set<string>();
    (req.permission_suggestions ?? []).forEach((s, i) => {
      const sug = s as { type?: string; mode?: string };
      let label: string | undefined;
      if (sug.type === "setMode" && sug.mode) label = `本会话总是允许 (${sug.mode})`;
      else if (sug.type === "addRules") label = "总是允许此类操作";
      // The id is the index into the RAW suggestion list — respondPermission
      // echoes that raw object back so the CLI applies AND persists it.
      // De-dupe by label: several scope variants would render identically.
      if (label && !seen.has(label)) {
        seen.add(label);
        out.push({ id: `sugg:${i}`, label });
      }
    });
    return out;
  }

  private handleSystem(ev: SystemInitEvent): void {
    if (ev.subtype === "init") {
      const resumed = !!this.opts.resumeSessionId;
      this.currentModel = ev.model;
      this.sessionId = ev.session_id;
      this.hooks.onSessionId(ev.session_id, resumed);
      this.hooks.emit({
        kind: "session",
        sessionId: ev.session_id,
        model: ev.model,
        cwd: ev.cwd,
        tools: ev.tools ?? [],
        resumed,
        // Ground truth from the CLI. But if a mode change arrived mid-handshake,
        // init still reports the SPAWN-time mode — reporting it would snap the
        // picker back to the mode the user just moved away from.
        permissionMode: this.pendingMode ?? (ev as any).permissionMode,
      });
    } else if ((ev as any).subtype === "status") {
      const status = (ev as any).status;
      // /compact lifecycle: a "compacting" status, then a status carrying
      // compact_result, then the compact_boundary detail below.
      if (status === "compacting") {
        this.hooks.emit({ kind: "compacting" });
      } else if ((ev as any).compact_result) {
        /* swallow; compact_boundary carries the numbers */
      } else if (typeof status === "string") {
        this.hooks.emit({ kind: "status", label: status });
      }
    } else if ((ev as any).subtype === "compact_boundary") {
      const md = (ev as any).compact_metadata ?? {};
      this.hooks.emit({
        kind: "compacted",
        trigger: md.trigger ?? "manual",
        preTokens: md.pre_tokens ?? 0,
        postTokens: md.post_tokens ?? 0,
      });
    }
  }

  private handleStreamEvent(ev: StreamEvent): void {
    const e = ev.event as any;
    switch (e.type) {
      case "message_start": {
        const u = e.message?.usage;
        if (u) {
          if (typeof u.output_tokens === "number") this.hooks.emit({ kind: "tokens", output: u.output_tokens });
          // Context size = full prompt this request: fresh input + cached history.
          const used =
            (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (used > 0) {
            const model = e.message?.model || this.currentModel;
            this.hooks.emit({ kind: "context", used, total: contextWindowFor(model, used) });
          }
        }
        return;
      }
      case "message_delta": {
        // Cumulative output tokens for the current assistant message.
        const out = e.usage?.output_tokens;
        if (typeof out === "number") this.hooks.emit({ kind: "tokens", output: out });
        return;
      }
      case "content_block_start": {
        const t = e.content_block?.type;
        if (t === "text" || t === "thinking") {
          this.currentBlockType = t;
          this.hooks.emit({ kind: "block_start", blockType: t });
        } else if (t === "tool_use") {
          this.currentBlockType = "tool_use";
          this.currentToolId = e.content_block.id;
          this.currentToolName = e.content_block.name;
          this.currentToolJson = "";
          // Card is rendered from the assistant event (has parsed input);
          // announce it now for immediate "running" feedback.
          this.hooks.emit({
            kind: "block_start",
            blockType: "tool_use",
            toolId: e.content_block.id,
            toolName: e.content_block.name,
          });
        }
        return;
      }
      case "content_block_delta": {
        const d = e.delta;
        if (d.type === "text_delta") this.hooks.emit({ kind: "text_delta", text: d.text });
        else if (d.type === "thinking_delta") this.hooks.emit({ kind: "thinking_delta", text: d.thinking });
        else if (d.type === "input_json_delta" && this.currentToolId) {
          // Stream the tool's input JSON so the UI can show the file/lines live.
          this.currentToolJson += (d as { partial_json?: string }).partial_json ?? "";
          this.hooks.emit({
            kind: "tool_input_partial",
            toolId: this.currentToolId,
            name: this.currentToolName || "tool",
            json: this.currentToolJson,
          });
        }
        return;
      }
      case "content_block_stop":
        this.currentBlockType = undefined;
        this.currentToolId = undefined;
        this.currentToolName = undefined;
        this.currentToolJson = "";
        return;
      default:
        return;
    }
  }

  private handleAssistant(ev: AssistantEvent): void {
    for (const block of ev.message.content ?? []) {
      if (block.type === "tool_use") {
        const tu = block as ToolUseBlock;
        if (this.seenToolIds.has(tu.id)) continue;
        this.seenToolIds.add(tu.id);
        this.hooks.emit({
          kind: "tool_input",
          toolId: tu.id,
          name: tu.name,
          input: tu.input ?? {},
        });
      }
    }
  }

  private handleUser(ev: { message: { content: ContentBlock[] } }): void {
    for (const block of ev.message.content ?? []) {
      if (block.type === "tool_result") {
        const tr = block as { tool_use_id: string; content: unknown; is_error?: boolean };
        this.hooks.emit({
          kind: "tool_result",
          toolUseId: tr.tool_use_id,
          content: stringifyToolResult(tr.content),
          isError: !!tr.is_error,
        });
      }
    }
  }

  private handleResult(ev: ResultEvent): void {
    this.seenToolIds.clear(); // per-turn de-dupe only; don't grow forever
    this.setBusy(false);
    this.hooks.emit({
      kind: "result",
      isError: ev.is_error,
      costUsd: ev.total_cost_usd,
      durationMs: ev.duration_ms,
      numTurns: ev.num_turns,
    });
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.hooks.emit({ kind: "busy", busy });
  }
}

/** Posting multi-MB tool outputs (huge Reads, base64 blobs) through postMessage
 *  and into the DOM stalls the webview — cap what we ship. */
const MAX_TOOL_RESULT_CHARS = 200_000;

function stringifyToolResult(content: unknown): string {
  let s: string;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    s = content
      .map((c) => (typeof c === "string" ? c : (c as { text?: string }).text ?? JSON.stringify(c)))
      .join("\n");
  } else if (content == null) s = "";
  else s = JSON.stringify(content, null, 2);
  if (s.length > MAX_TOOL_RESULT_CHARS) {
    s = s.slice(0, MAX_TOOL_RESULT_CHARS) + `\n…（输出过长，已截断 ${s.length - MAX_TOOL_RESULT_CHARS} 字符）`;
  }
  return s;
}
