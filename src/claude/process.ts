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
import { PermissionSuggestionView, ToWebview } from "../shared";

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
  private readonly pendingControl = new Map<string, (resp: unknown) => void>();
  private readonly pendingPermissions = new Map<string, Record<string, unknown>>();
  private sessionId?: string;
  private initialized = false;
  private disposed = false;
  private currentBlockType?: "text" | "thinking" | "tool_use";
  private busy = false;
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
      env: { ...process.env, ...this.opts.env },
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

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));

    let stderrBuf = "";
    this.proc.stderr.on("data", (d: Buffer) => {
      stderrBuf += d.toString();
      // Surface only obvious fatal lines; the CLI is chatty on stderr.
      const lower = stderrBuf.toLowerCase();
      if (lower.includes("error") && stderrBuf.length < 4000) {
        // Defer; many "errors" are benign. Emit on close instead.
      }
    });

    this.proc.on("close", (code) => {
      if (code && code !== 0 && stderrBuf.trim()) {
        this.hooks.emit({ kind: "error", message: `claude 进程退出 (code ${code}): ${stderrBuf.trim().slice(0, 800)}` });
      }
      this.setBusy(false);
      if (!this.disposed) this.hooks.onClose(code);
    });

    // Handshake: must complete before sending user turns, and it is what
    // enables `can_use_tool` permission prompts over the control channel.
    await this.sendControlRequest({ subtype: "initialize" });
    this.initialized = true;
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

  /** Resolve a pending permission request (called by the provider). */
  respondPermission(requestId: string, decision: { behavior: "allow" | "deny"; message?: string }): void {
    const originalInput = this.pendingPermissions.get(requestId);
    if (originalInput === undefined) return;
    this.pendingPermissions.delete(requestId);

    const response: PermissionDecision =
      decision.behavior === "allow"
        ? { behavior: "allow", updatedInput: originalInput }
        : { behavior: "deny", message: decision.message ?? "用户拒绝了此操作。", interrupt: false };

    this.write({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
    this.hooks.emit({ kind: "permission_resolved", requestId, behavior: decision.behavior });
  }

  /** Interrupt the current turn. */
  async interrupt(): Promise<void> {
    if (!this.proc) return;
    // Deny any in-flight permission asks so the turn can unwind cleanly.
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.respondPermission(requestId, { behavior: "deny", message: "已中断。" });
    }
    try {
      await this.sendControlRequest({ subtype: "interrupt" });
    } catch {
      /* best effort */
    }
    this.setBusy(false);
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (!this.proc) return;
    try {
      await this.sendControlRequest({ subtype: "set_permission_mode", mode });
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.disposed = true;
    this.rl?.close();
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.stdin.end();
      } catch {
        /* ignore */
      }
      this.proc.kill("SIGTERM");
      const p = this.proc;
      setTimeout(() => {
        if (!p.killed) p.kill("SIGKILL");
      }, 2000);
    }
  }

  // -- Control channel -----------------------------------------------------

  private sendControlRequest(request: Record<string, unknown>): Promise<unknown> {
    const requestId = `req-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(new Error(`control_request timed out: ${String(request.subtype)}`));
      }, 30_000);
      this.pendingControl.set(requestId, (resp) => {
        clearTimeout(timer);
        resolve(resp);
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
    switch (ev.type) {
      case "control_response": {
        const r = (ev as any).response;
        const cb = this.pendingControl.get(r?.request_id);
        if (cb) {
          this.pendingControl.delete(r.request_id);
          cb(r);
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
      this.pendingPermissions.set(ev.request_id, req.input);
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
    for (const s of req.permission_suggestions ?? []) {
      const sug = s as { type?: string; mode?: string };
      let item: PermissionSuggestionView | undefined;
      if (sug.type === "setMode" && sug.mode) {
        item = { id: `setMode:${sug.mode}`, label: `本会话总是允许 (${sug.mode})` };
      } else if (sug.type === "addRules") {
        item = { id: "addRules", label: "总是允许此类操作" };
      }
      // The CLI may send several variants (different scopes) that we surface
      // identically — de-dupe so the user doesn't see two identical buttons.
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }

  private handleSystem(ev: SystemInitEvent): void {
    if (ev.subtype === "init") {
      const resumed = !!this.opts.resumeSessionId;
      this.sessionId = ev.session_id;
      this.hooks.onSessionId(ev.session_id, resumed);
      this.hooks.emit({
        kind: "session",
        sessionId: ev.session_id,
        model: ev.model,
        cwd: ev.cwd,
        tools: ev.tools ?? [],
        resumed,
      });
    } else if ((ev as any).subtype === "status") {
      const status = (ev as any).status;
      if (typeof status === "string") this.hooks.emit({ kind: "status", label: status });
    }
  }

  private handleStreamEvent(ev: StreamEvent): void {
    const e = ev.event as any;
    switch (e.type) {
      case "message_start": {
        const out = e.message?.usage?.output_tokens;
        if (typeof out === "number") this.hooks.emit({ kind: "tokens", output: out });
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
        return;
      }
      case "content_block_stop":
        this.currentBlockType = undefined;
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

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : (c as { text?: string }).text ?? JSON.stringify(c)))
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}
