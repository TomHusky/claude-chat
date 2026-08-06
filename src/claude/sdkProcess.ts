// SDK 是 ESM-only：类型走 import type（编译期擦除），运行时在 start() 里动态
// import（esbuild 打包时会内联进 bundle，宿主侧无需真实 ESM 解析）。
import type { Options, Query, PermissionResult, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { randomUUID } from "node:crypto";
import { ClaudeProcessOptions, ClaudeProcessHooks } from "./process";
import { contextWindowFor, PermissionSuggestionView, ToWebview } from "../shared";

/**
 * 官方 @anthropic-ai/claude-agent-sdk 版的进程实现（实验，claudeChat.engine=sdk 启用）。
 *
 * 与 ClaudeProcess（自维护 stream-json 协议层）公开接口完全一致——provider 无感切换。
 * SDK 的 streaming input mode 底层同样是一个长驻 CLI 子进程 + stream-json，
 * 区别只是协议解析/控制通道由官方维护：
 *   - 事件流：SDK 吐出的消息对象与 CLI 原始 stream-json 同构，翻译逻辑与
 *     process.ts 逐段对齐（本文件的 handleMessage 就是它的移植版）。
 *   - 权限：不再走 stdin 的 control_request，而是 options.canUseTool 回调；
 *     respondPermission/answerQuestion 通过 resolve 挂起的 Promise 来应答。
 *   - interrupt/setModel/setPermissionMode：Query 对象的原生方法。
 */
export class SdkClaudeProcess {
  private q?: Query;
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly abort = new AbortController();
  private exited = false;
  private disposed = false;
  private initialized = false;
  private sessionId?: string;
  private busy = false;
  private currentModel?: string;
  private currentToolId?: string;
  private currentToolName?: string;
  private currentToolJson = "";
  private readonly seenToolIds = new Set<string>();
  private lastRateLimitLevel?: "warning" | "exhausted";
  private stderrTail = "";
  /** 消息循环结束的信号（disposeAndWait 用）。 */
  private closedPromise?: Promise<void>;
  /** 等待用户应答的权限请求：requestId -> resolver + 原始 input/suggestions。 */
  private readonly pendingPermissions = new Map<
    string,
    { resolve: (r: PermissionResult) => void; input: Record<string, unknown>; suggestions: unknown[] }
  >();

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

  get isExited(): boolean {
    return this.exited;
  }

  /** 启动 SDK 会话。注意：直接 query() 会把 spawn 推迟到第一条消息（实测 init
   *  在首条消息之后才到）——那样 prespawn/预热就失去意义，start() 也会干等超时。
   *  官方为此提供 startup()/WarmQuery：先 spawn + 完成 initialize 握手再挂 prompt，
   *  语义与 stream-json 版的 start() 完全一致。 */
  async start(): Promise<void> {
    const { startup } = await import("@anthropic-ai/claude-agent-sdk");
    const options: Options = {
      pathToClaudeCodeExecutable: this.resolveCli(),
      cwd: this.opts.cwd,
      includePartialMessages: true,
      permissionMode: (this.opts.permissionMode || "default") as Options["permissionMode"],
      model: this.opts.model || undefined,
      effort: (this.opts.effort || undefined) as Options["effort"],
      resume: this.opts.resumeSessionId,
      sessionId: this.opts.resumeSessionId ? undefined : this.opts.sessionId,
      forkSession: this.opts.forkNoPersist ? true : undefined,
      persistSession: this.opts.forkNoPersist ? false : undefined,
      maxTurns: this.opts.maxTurns,
      additionalDirectories: this.opts.addDirs,
      systemPrompt: this.opts.appendSystemPrompt
        ? { type: "preset", preset: "claude_code", append: this.opts.appendSystemPrompt }
        : undefined,
      abortController: this.abort,
      stderr: (d) => {
        this.stderrTail = (this.stderrTail + d).slice(-4096);
      },
      // 与 stream-json 版一致：标识为 VSCode 入口，让会话出现在官方插件的列表里。
      env: { ...(process.env as Record<string, string>), CLAUDE_CODE_ENTRYPOINT: "claude-vscode", ...(this.opts.env as Record<string, string> | undefined) },
      canUseTool: (toolName, input, extra) => this.onCanUseTool(toolName, input, extra),
    };

    // spawn + initialize 握手（失败会抛异常，由 spawnProcess 的 catch 兜住）。
    const warm = await startup({ options, initializeTimeoutMs: 30_000 });
    if (this.disposed) {
      // 握手期间被 dispose（比如用户 /clear 换进程）：直接丢弃，别泄漏子进程。
      warm.close();
      this.exited = true;
      throw new Error("已在启动期间被丢弃");
    }
    this.q = warm.query(this.input);
    this.initialized = true;
    // 握手期间攒下的模式/模型切换现在补上（失败不致命，保持 spawn 时的值）。
    if (this.pendingMode !== undefined) {
      const mode = this.pendingMode;
      this.pendingMode = undefined;
      try {
        await this.q.setPermissionMode(mode as Parameters<Query["setPermissionMode"]>[0]);
      } catch {
        /* keep spawn mode */
      }
    }
    if (this.pendingModel !== undefined) {
      const model = this.pendingModel;
      this.pendingModel = undefined;
      try {
        await this.q.setModel(model || undefined);
      } catch {
        /* keep spawn model */
      }
    }

    // 消息循环常驻后台。
    this.closedPromise = (async () => {
      let code: number | null = 0;
      try {
        for await (const m of this.q!) {
          this.handleMessage(m as Record<string, unknown>);
        }
      } catch (err) {
        code = 1;
        if (!this.disposed) {
          const msg = String((err as Error)?.message ?? err);
          this.hooks.emit({ kind: "error", message: `claude 会话异常退出: ${msg}${this.stderrTail ? `\n${this.stderrTail.slice(-800)}` : ""}` });
        }
      } finally {
        this.exited = true;
        // 尚未应答的权限请求随进程一起作废（与 stream-json 版 close 处理一致）。
        for (const requestId of [...this.pendingPermissions.keys()]) {
          this.pendingPermissions.delete(requestId);
          this.hooks.emit({ kind: "permission_resolved", requestId, behavior: "deny" });
        }
        this.setBusy(false);
        if (!this.disposed) this.hooks.onClose(code);
      }
    })();
  }

  /** SDK 不做 PATH 查找（实测裸 "claude" 会报 Native CLI binary not found）——
   *  裸命令名要先解析成真实路径。 */
  private resolveCli(): string {
    const p = this.opts.claudePath || "claude";
    if (p.includes("/")) return p; // 已是路径
    if (SdkClaudeProcess.cliPathCache?.name === p) return SdkClaudeProcess.cliPathCache.path;
    let resolved = p;
    try {
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      const out = execSync(`command -v ${JSON.stringify(p)}`, { encoding: "utf8", shell: "/bin/zsh", timeout: 3000 }).trim();
      if (out) resolved = out.split("\n")[0];
    } catch {
      // which 失败就试常见安装位置
      const os = require("node:os") as typeof import("node:os");
      const fs = require("node:fs") as typeof import("node:fs");
      for (const cand of [`${os.homedir()}/.local/bin/${p}`, `/opt/homebrew/bin/${p}`, `/usr/local/bin/${p}`]) {
        if (fs.existsSync(cand)) {
          resolved = cand;
          break;
        }
      }
    }
    SdkClaudeProcess.cliPathCache = { name: p, path: resolved };
    return resolved;
  }

  private static cliPathCache?: { name: string; path: string };

  // -- 发送 ----------------------------------------------------------------

  sendUserMessage(text: string, context?: string, images?: { mediaType: string; data: string }[]): boolean {
    if (this.exited || !this.initialized) return false;
    const body = context ? `${context}\n\n${text}` : text;
    this.setBusy(true);
    const content: Array<Record<string, unknown>> = [];
    for (const img of images ?? []) {
      content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    }
    content.push({ type: "text", text: body });
    this.pushUser(content);
    return true;
  }

  compact(): void {
    if (this.exited || !this.initialized) return;
    this.setBusy(true);
    this.pushUser([{ type: "text", text: "/compact" }]);
  }

  private pushUser(content: Array<Record<string, unknown>>): void {
    this.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      // 键盘输入必须显式标 human（transcript 的 origin.kind 判别依赖它）。
      origin: { kind: "human" },
      session_id: this.sessionId ?? "",
    } as unknown as SDKUserMessage);
  }

  // -- 权限（canUseTool 回调 <-> UI 应答）-----------------------------------

  private onCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    // 注意：SDK 回调的附加字段是 camelCase（toolUseID/blockedPath/displayName），
    // 和 stream-json 控制通道的 snake_case 不同——按 .d.ts 实际字段读。
    extra: {
      signal: AbortSignal;
      suggestions?: unknown[];
      blockedPath?: string;
      displayName?: string;
      description?: string;
      toolUseID?: string;
      requestId?: string;
    },
  ): Promise<PermissionResult> {
    const requestId = extra?.requestId || `req-${randomUUID()}`;
    return new Promise<PermissionResult>((resolve) => {
      const suggestionsRaw = (extra?.suggestions as unknown[]) ?? [];
      this.pendingPermissions.set(requestId, { resolve, input, suggestions: suggestionsRaw });
      extra?.signal?.addEventListener?.("abort", () => {
        // 轮次被中断/进程退出：撤掉 UI 上的弹窗。
        if (this.pendingPermissions.delete(requestId)) {
          this.hooks.emit({ kind: "permission_resolved", requestId, behavior: "deny" });
          resolve({ behavior: "deny", message: "已中断。", interrupt: false });
        }
      });
      this.hooks.onPermission({
        requestId,
        toolUseId: extra?.toolUseID,
        toolName,
        displayName: extra?.displayName,
        input,
        description: extra?.description,
        blockedPath: extra?.blockedPath,
        suggestions: this.normalizeSuggestions(suggestionsRaw),
      });
    });
  }

  respondPermission(requestId: string, decision: { behavior: "allow" | "deny"; message?: string; suggestionId?: string }): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending === undefined) return;
    this.pendingPermissions.delete(requestId);
    if (decision.behavior === "allow") {
      const result: PermissionResult = { behavior: "allow", updatedInput: pending.input };
      const m = /^sugg:(\d+)$/.exec(decision.suggestionId ?? "");
      const raw = m ? pending.suggestions[Number(m[1])] : undefined;
      if (raw) (result as Record<string, unknown>).updatedPermissions = [raw];
      pending.resolve(result);
    } else {
      pending.resolve({ behavior: "deny", message: decision.message ?? "用户拒绝了此操作。", interrupt: false });
    }
    this.hooks.emit({ kind: "permission_resolved", requestId, behavior: decision.behavior });
  }

  answerQuestion(requestId: string, answers: Record<string, string | string[]>): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending === undefined) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answers } });
    this.hooks.emit({ kind: "permission_resolved", requestId, behavior: "allow" });
  }

  private normalizeSuggestions(raw: unknown[]): PermissionSuggestionView[] {
    const out: PermissionSuggestionView[] = [];
    const seen = new Set<string>();
    raw.forEach((s, i) => {
      const sug = s as { type?: string; mode?: string };
      let label: string | undefined;
      if (sug.type === "setMode" && sug.mode) label = `本会话总是允许 (${sug.mode})`;
      else if (sug.type === "addRules") label = "总是允许此类操作";
      if (label && !seen.has(label)) {
        seen.add(label);
        out.push({ id: `sugg:${i}`, label });
      }
    });
    return out;
  }

  // -- 控制 ----------------------------------------------------------------

  async interrupt(): Promise<void> {
    if (this.exited) return;
    // 与 stream-json 版一致：busy 先行复位让 Stop 永远跟手。
    this.setBusy(false);
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.respondPermission(requestId, { behavior: "deny", message: "已中断。" });
    }
    try {
      await this.q?.interrupt();
    } catch {
      /* best effort */
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (this.exited) return;
    if (!this.initialized || !this.q) {
      // 握手期先记下，start() 收尾时统一应用（stream-json 版同款缓冲，否则静默丢失）。
      this.pendingMode = mode;
      return;
    }
    await this.q.setPermissionMode(mode as Parameters<Query["setPermissionMode"]>[0]);
  }

  async setModel(model: string): Promise<void> {
    if (this.exited) return;
    if (!this.initialized || !this.q) {
      this.pendingModel = model;
      return;
    }
    await this.q.setModel(model || undefined);
  }

  private pendingMode?: string;
  private pendingModel?: string;

  dispose(): void {
    this.disposed = true;
    this.input.end();
    try {
      this.abort.abort();
    } catch {
      /* ignore */
    }
  }

  disposeAndWait(): Promise<void> {
    const done = new Promise<void>((resolve) => {
      if (this.exited || !this.closedPromise) return resolve();
      void this.closedPromise.then(resolve).catch(() => resolve());
      setTimeout(resolve, 3000); // hard cap — 与 stream-json 版一致
    });
    this.dispose();
    return done;
  }

  // -- 事件翻译（process.ts handleEvent 的移植版，逐段对齐）------------------

  private handleMessage(m: Record<string, unknown>): void {
    // 子 agent 内部事件不渲染（Task 的 tool_result 会汇总）。
    if ((m as any).parent_tool_use_id && (m.type === "stream_event" || m.type === "assistant" || m.type === "user")) return;
    switch (m.type) {
      case "system":
        this.handleSystem(m as any);
        return;
      case "stream_event":
        this.handleStreamEvent(m as any);
        return;
      case "assistant":
        this.handleAssistant(m as any);
        return;
      case "user":
        this.handleUser(m as any);
        return;
      case "result":
        this.handleResult(m as any);
        return;
      case "rate_limit_event":
        this.handleRateLimit(m as any);
        return;
      default:
        return;
    }
  }

  private handleSystem(ev: any): void {
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
        // 与 stream-json 版一致：握手期改过模式的话，init 报的还是 spawn 时的旧值。
        permissionMode: this.pendingMode ?? ev.permissionMode,
      });
    } else if (ev.subtype === "status") {
      if (ev.status === "compacting") this.hooks.emit({ kind: "compacting" });
      else if (ev.compact_result) {
        /* swallow; compact_boundary carries the numbers */
      } else if (typeof ev.status === "string") this.hooks.emit({ kind: "status", label: ev.status });
    } else if (ev.subtype === "compact_boundary") {
      const md = ev.compact_metadata ?? {};
      this.hooks.emit({ kind: "compacted", trigger: md.trigger ?? "manual", preTokens: md.pre_tokens ?? 0, postTokens: md.post_tokens ?? 0 });
    } else if (ev.subtype === "api_retry") {
      this.hooks.emit({
        kind: "diag",
        message: `api_retry: ${JSON.stringify({ attempt: ev.attempt ?? ev.retry_count, delay: ev.delay_ms ?? ev.retry_in, error: ev.error }).slice(0, 300)}`,
      });
    } else if (ev.subtype === "thinking_tokens") {
      // SDK 类型定义的字段是 estimated_tokens（老候选保留兜底）。
      const n = Number(ev.estimated_tokens ?? ev.tokens ?? ev.thinking_tokens ?? ev.count ?? ev.output_tokens ?? 0);
      if (Number.isFinite(n) && n > 0) this.hooks.emit({ kind: "thinking_tokens", tokens: n });
    }
  }

  private handleStreamEvent(ev: any): void {
    const e = ev.event as any;
    switch (e?.type) {
      case "message_start": {
        const u = e.message?.usage;
        if (u) {
          if (typeof u.output_tokens === "number") this.hooks.emit({ kind: "tokens", output: u.output_tokens });
          const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (used > 0) {
            const model = e.message?.model || this.currentModel;
            this.hooks.emit({ kind: "context", used, total: contextWindowFor(model, used) });
          }
        }
        return;
      }
      case "message_delta": {
        const out = e.usage?.output_tokens;
        if (typeof out === "number") this.hooks.emit({ kind: "tokens", output: out });
        return;
      }
      case "content_block_start": {
        const t = e.content_block?.type;
        if (t === "text" || t === "thinking") {
          this.hooks.emit({ kind: "block_start", blockType: t });
        } else if (t === "tool_use") {
          this.currentToolId = e.content_block.id;
          this.currentToolName = e.content_block.name;
          this.currentToolJson = "";
          this.hooks.emit({ kind: "block_start", blockType: "tool_use", toolId: e.content_block.id, toolName: e.content_block.name });
        }
        return;
      }
      case "content_block_delta": {
        const d = e.delta;
        if (d.type === "text_delta") this.hooks.emit({ kind: "text_delta", text: d.text });
        else if (d.type === "thinking_delta") this.hooks.emit({ kind: "thinking_delta", text: d.thinking });
        else if (d.type === "input_json_delta" && this.currentToolId) {
          this.currentToolJson += d.partial_json ?? "";
          this.hooks.emit({ kind: "tool_input_partial", toolId: this.currentToolId, name: this.currentToolName || "tool", json: this.currentToolJson });
        }
        return;
      }
      case "content_block_stop":
        this.currentToolId = undefined;
        this.currentToolName = undefined;
        this.currentToolJson = "";
        return;
      default:
        return;
    }
  }

  private handleAssistant(ev: any): void {
    for (const block of ev.message?.content ?? []) {
      if (block.type === "tool_use") {
        if (this.seenToolIds.has(block.id)) continue;
        this.seenToolIds.add(block.id);
        this.hooks.emit({ kind: "tool_input", toolId: block.id, name: block.name, input: block.input ?? {} });
      }
    }
  }

  private handleUser(ev: any): void {
    for (const block of ev.message?.content ?? []) {
      if (block.type === "tool_result") {
        this.hooks.emit({
          kind: "tool_result",
          toolUseId: block.tool_use_id,
          content: stringifyToolResult(block.content),
          isError: !!block.is_error,
        });
      }
    }
  }

  private handleResult(ev: any): void {
    this.seenToolIds.clear();
    this.setBusy(false);
    this.hooks.emit({ kind: "result", isError: ev.is_error, costUsd: ev.total_cost_usd, durationMs: ev.duration_ms, numTurns: ev.num_turns });
  }

  private handleRateLimit(ev: any): void {
    const info = ev.rate_limit_info ?? {};
    const status = info.status;
    let level: "warning" | "exhausted" | undefined;
    if (status === "rejected" || status === "exhausted") level = "exhausted";
    else if (status === "warning" || status === "allowed_warning") level = "warning";
    if (!level) {
      if (this.lastRateLimitLevel === "exhausted") this.hooks.emit({ kind: "rate_limit_cleared" });
      this.lastRateLimitLevel = undefined;
      return;
    }
    if (this.lastRateLimitLevel === level) return;
    this.lastRateLimitLevel = level;
    this.hooks.emit({
      kind: "rate_limit",
      level,
      limitLabel: info.rateLimitType === "seven_day" ? "每周用量" : "5 小时用量",
      resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : undefined,
    });
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.hooks.emit({ kind: "busy", busy });
  }
}

/** 简单的可推送异步队列（SDK streaming input 的 prompt 载体）。 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

const MAX_TOOL_RESULT_CHARS = 200_000;

function stringifyToolResult(content: unknown): string {
  let s: string;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    s = content.map((c) => (typeof c === "string" ? c : (c as { text?: string }).text ?? JSON.stringify(c))).join("\n");
  } else if (content == null) s = "";
  else s = JSON.stringify(content, null, 2);
  if (s.length > MAX_TOOL_RESULT_CHARS) {
    s = s.slice(0, MAX_TOOL_RESULT_CHARS) + `\n…（输出过长，已截断 ${s.length - MAX_TOOL_RESULT_CHARS} 字符）`;
  }
  return s;
}
