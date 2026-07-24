/**
 * Message contract between the extension host and the webview.
 * Imported by both `src/panel/*` (Node) and `src/webview/*` (browser),
 * so it must stay free of any runtime imports.
 */

/** Minimal monochrome line icons (stroke = currentColor). Shared by host + webview. */
const _s = (p: string, fill = false): string =>
  `<svg viewBox="0 0 16 16" ${fill ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"'}>${p}</svg>`;

export const ICONS: Record<string, string> = {
  add: _s('<path d="M8 3.5v9M3.5 8h9"/>'),
  send: _s('<path d="M8 12.5V4M4.6 7.4 8 4l3.4 3.4"/>'),
  stop: _s('<rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/>', true),
  attach: _s('<path d="M11.6 7.1 6.8 11.9a2.3 2.3 0 0 1-3.25-3.25l5.2-5.2a1.4 1.4 0 0 1 2 2L5.6 10.7a.5.5 0 0 1-.7-.7l4.5-4.5"/>'),
  sessions: _s('<path d="M3.5 4.5h9M3.5 8h9M3.5 11.5h6"/>'),
  newChat: _s('<path d="M8 3.5v9M3.5 8h9"/>'),
  terminal: _s('<rect x="2.5" y="3" width="11" height="10" rx="1.6"/><path d="M5 7l2 1.6-2 1.6"/><path d="M8.6 10.4h2.9"/>'),
  search: _s('<circle cx="7" cy="7" r="3.8"/><path d="M9.9 9.9 13 13"/>'),
  web: _s('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/><path d="M8 2.5c2.3 2.2 2.3 8.8 0 11"/><path d="M8 2.5c-2.3 2.2-2.3 8.8 0 11"/>'),
  task: _s('<rect x="3" y="3" width="10" height="10" rx="2.2"/><path d="M6 8.2 7.3 9.5 10.2 6.4"/>'),
  tool: _s('<rect x="3.5" y="3.5" width="9" height="9" rx="2.2"/>'),
  file: _s('<path d="M4 2.5h4.5L12 6v7.5H4z"/><path d="M8.5 2.5V6H12"/>'),
  copy: _s('<rect x="5.4" y="5.4" width="7.1" height="7.1" rx="1.6"/><path d="M3.5 10.4V4a.5.5 0 0 1 .5-.5h6.4"/>'),
  edit: _s('<path d="M8.5 3.2H3.6a1 1 0 0 0-1 1v7.2a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V7.5"/><path d="M11 2.6a1.1 1.1 0 0 1 1.6 1.6L7.8 9 5.6 9.6 6.2 7.4z"/>'),
  trash: _s('<path d="M3 4.5h10M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3M5 4.5l.6 8a.8.8 0 0 0 .8.7h3.2a.8.8 0 0 0 .8-.7l.6-8"/>'),
  play: _s('<path d="M5 3.8v8.4l7-4.2z"/>'),
  update: _s('<path d="M12.7 8a4.7 4.7 0 1 1-1.4-3.35"/><path d="M12.9 2.8v2.4h-2.4"/>'),
  thumbUp: _s('<g transform="translate(.5 .5) scale(.625)" stroke-width="2.2"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></g>'),
  thumbDown: _s('<g transform="translate(.5 .5) scale(.625)" stroke-width="2.2"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></g>'),
  database: _s('<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/>'),
};

/** SLS 连接配置。持久化在 `~/sls-tools/config.json`，供 `sls` CLI 与本面板共用。
 *  projects 是「环境名 -> SLS Project」的映射，可自由增删环境（默认种子 dev/pro）；
 *  logs 把每个业务项目映射到 info/error 两个 logstore（各环境共用同一份映射，环境只切
 *  Project）。 */
/** QQ 开放平台机器人配置。AppSecret 不走这里持久化（存 VS Code SecretStorage），
 *  但表单读写时会经过它；回填到界面时 secret 用占位符表示"已保存"。 */
export interface QQConfig {
  appId: string;
  appSecret: string;
  /** 白名单 user openid（换行/逗号分隔的原始文本，由宿主解析）。 */
  allowed: string;
  sandbox: boolean;
  enabled: boolean;
}

export interface SlsConfig {
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  projects: Record<string, string>;
  logs: Record<string, { info?: string; error?: string }>;
}

// ---- Extension host -> webview --------------------------------------------

export type ToWebview =
  /** `permissionMode` is the mode the CLI process ACTUALLY runs in (from its
   *  init event) — the picker syncs to this, never to a local guess. */
  | { kind: "session"; sessionId: string; model: string; cwd: string; tools: string[]; resumed?: boolean; permissionMode?: string }
  | { kind: "busy"; busy: boolean }
  | { kind: "status"; label: string }
  | { kind: "block_start"; blockType: "text" | "thinking" | "tool_use"; toolId?: string; toolName?: string }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_input"; toolId: string; name: string; displayName?: string; input: Record<string, unknown> }
  | { kind: "tool_input_partial"; toolId: string; name: string; json: string }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | {
      kind: "permission_request";
      requestId: string;
      toolUseId?: string;
      toolName: string;
      displayName?: string;
      input: Record<string, unknown>;
      description?: string;
      suggestions: PermissionSuggestionView[];
    }
  | { kind: "permission_resolved"; requestId: string; behavior: "allow" | "deny"; auto?: boolean }
  | { kind: "tokens"; output: number }
  | { kind: "thinking_tokens"; tokens: number }
  /** 纯诊断信息：只进输出通道日志，绝不显示到界面。 */
  | { kind: "diag"; message: string }
  /** 看门狗心跳：webview 必须立即回 pong。通道半死（页面活着但消息不通）时
   *  宿主据此发现并重建 webview——否则表现为"永远转圈/按钮全聋"。 */
  | { kind: "ping"; id: number }
  | { kind: "update_available"; version: string }
  | { kind: "context"; used: number; total: number }
  | { kind: "refs_validated"; invalid: string[] }
  | { kind: "result"; isError: boolean; costUsd?: number; durationMs?: number; numTurns?: number }
  /** weekModel*: 除 "all models" 外的按模型周限额行（CLI 输出哪个模型就显示哪个，
   *  如 Sonnet / Fable —— 不写死模型名，跟着官方 /usage 文案走）。 */
  | { kind: "usage"; sessionPct?: number; sessionResetAt?: number; sessionReset?: string; weekPct?: number; weekReset?: string; weekModelPct?: number; weekModelName?: string }
  | { kind: "compacting" }
  | { kind: "compacted"; trigger: string; preTokens: number; postTokens: number }
  /** Subscription quota. `exhausted` blocks further turns until `resetsAt`. */
  | { kind: "rate_limit"; level: "warning" | "exhausted"; limitLabel: string; resetsAt?: number }
  /** The quota window reset — unlock the composer. */
  | { kind: "rate_limit_cleared" }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string }
  // Full conversation replacement (switching/restoring sessions)
  | { kind: "load_history"; items: TimelineItem[]; sessionId?: string; title?: string; checkpoints?: CheckpointSummary[] }
  | { kind: "sessions"; list: SessionSummary[]; activeId?: string; runningIds?: string[] }
  | { kind: "running"; sessionIds: string[] }
  | { kind: "checkpoints"; list: CheckpointSummary[] }
  // A restore point was created for the turn just sent (live).
  | { kind: "checkpoint_marker"; checkpointId: string; userText: string }
  | { kind: "config"; permissionMode: string; model: string; effort: string; slsConfigured?: boolean }
  | { kind: "context_added"; label: string; text: string }
  | { kind: "active_file"; path: string | null }
  | { kind: "attach_files"; paths: string[] }
  | { kind: "changed_files"; files: ChangedFile[]; totalAdded: number; totalRemoved: number }
  // ---- SLS 日志配置面板 ----
  /** 打开配置抽屉并回填当前配置；enginePresent 表示查询引擎(venv)是否已就绪。 */
  | { kind: "sls_open"; config: SlsConfig; enginePresent: boolean }
  /** slsLoad 的应答，仅回填表单不弹开抽屉。 */
  | { kind: "sls_config"; config: SlsConfig; enginePresent: boolean }
  | { kind: "qq_config"; config: QQConfig; hasSecret: boolean }
  | { kind: "qq_state"; state: "connecting" | "online" | "offline"; detail?: string }
  | { kind: "qq_result"; ok: boolean; message: string }
  /** 配对模式下捕获到的发信人 openid —— 界面提供"填入白名单"一键操作。 */
  | { kind: "qq_pairing"; openId: string }
  /** 测试连接/保存的结果反馈。stores 为拉取到的 logstore 列表（成功时）。 */
  | { kind: "sls_result"; action: "test" | "save"; ok: boolean; message: string; stores?: string[] }
  /** 把一段文本预填进聊天输入框（供“让 Claude 生成映射”一键塞入 prompt）。 */
  | { kind: "prefill"; text: string };

export interface ChangedFile {
  path: string; // absolute
  rel: string;
  added: number;
  removed: number;
  status: "added" | "modified" | "deleted";
}

export interface PermissionSuggestionView {
  id: string;
  label: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface CheckpointSummary {
  id: string;
  label: string;
  createdAt: number;
  userText: string;
  fileCount: number;
}

/** Context window (tokens) for a given Claude model, used by the usage gauge.
 *  The CLI doesn't report the window, so map by model id; the 4.x family runs an
 *  extended 1M context in Claude Code. `used` is a safety floor: if the observed
 *  prompt already exceeds the mapped window, lift to 1M so we never show >100%. */
export function contextWindowFor(model?: string, used = 0): number {
  const m = (model || "").toLowerCase();
  let win = 200_000;
  if (/(opus|sonnet|haiku)-4|claude-4|fable/.test(m)) win = 1_000_000;
  if (used > win) win = 1_000_000;
  return win;
}

/** Sentinels wrapping the auto-embedded "attached files" context inside a user
 *  message, so the loader can split the real user input from the file dump. */
export const CTX_OPEN = "<user-attached-context>";
export const CTX_CLOSE = "</user-attached-context>";

/** Sentinels wrapping the SLS log-tool usage snippet injected when the composer's
 *  「SLS日志」toggle is on. Stripped from the displayed text on reload; surfaced
 *  only as a small chip on the user message. */
export const SLS_CTX_OPEN = "<sls-log-context>";
export const SLS_CTX_CLOSE = "</sls-log-context>";

/** A persisted/rehydratable timeline item (used when reloading a session). */
export type TimelineItem =
  | { type: "user"; text: string; context?: string; images?: string[]; files?: string[]; sls?: boolean }
  | { type: "image"; src: string } // standalone image (assistant/tool), data: URI
  | { type: "assistant_text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      toolId: string;
      name: string;
      displayName?: string;
      input?: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      permission?: "allow" | "deny" | "pending";
    }
  | { type: "checkpoint"; id: string; label: string }
  | { type: "compaction"; preTokens: number; postTokens: number };

// ---- Webview -> extension host --------------------------------------------

export type FromWebview =
  | { type: "ready" }
  | { type: "checkUpdate" }
  | { type: "refreshUsage" }
  | { type: "send"; text: string; context?: string; images?: { mediaType: string; data: string }[]; files?: string[]; sls?: boolean }
  /** 从 OS（Finder 等）拖入工作区外的文件/目录：webview 拿不到绝对路径，只能读出
   *  内容传给宿主，由宿主镜像写盘后再按普通路径附加。rel 含顶层名（如 "dir/a.ts"）。 */
  | { type: "importDropped"; roots: { name: string; isDir: boolean }[]; files: { rel: string; base64: string }[]; skipped?: number }
  | { type: "editMessage"; checkpointId: string; text: string; images?: { mediaType: string; data: string }[] }
  | { type: "interrupt" }
  | { type: "compact" }
  /** /clear：丢弃当前会话上下文，在同一个 tab 里开一段全新的会话。
   *  带 text 时清空后立刻把这条消息发进新上下文。 */
  | { type: "newContext"; text?: string; context?: string; images?: { mediaType: string; data: string }[]; files?: string[]; sls?: boolean }
  | { type: "permission"; requestId: string; behavior: "allow" | "deny"; suggestionId?: string }
  | { type: "answerQuestion"; requestId: string; answers: Record<string, string | string[]> }
  | { type: "newSession" }
  | { type: "listSessions" }
  | { type: "switchSession"; sessionId: string }
  | { type: "openSession"; sessionId: string }
  | { type: "newInEditor" }
  | { type: "deleteSession"; sessionId: string }
  | { type: "renameSession"; sessionId: string; title: string }
  | { type: "deleteSessions"; sessionIds: string[] }
  | { type: "listCheckpoints" }
  | { type: "restoreCheckpoint"; checkpointId: string }
  | { type: "setPermissionMode"; mode: string }
  | { type: "setModel"; model: string }
  | { type: "setEffort"; effort: string }
  | { type: "addContext" }
  | { type: "pickFiles" }
  | { type: "openDiff"; path: string }
  | { type: "acceptFile"; path: string }
  | { type: "revertFile"; path: string }
  | { type: "acceptAll" }
  | { type: "revertAll" }
  | { type: "openFile"; path: string; line?: number; endLine?: number }
  | { type: "openSymbol"; name: string }
  | { type: "validateRefs"; refs: { id: string; path: string }[] }
  | { type: "runInTerminal"; code: string }
  | { type: "copy"; text: string }
  | { type: "saveImage"; dataUri: string }
  // ---- SLS 日志配置面板 ----
  | { type: "slsLoad" }
  /** webview 内部 JS 错误上报——host 记入输出通道（webview 控制台平时看不到）。 */
  | { type: "webviewError"; message: string }
  | { type: "pong"; id: number }
  /** 用户关掉了"用量即将用尽"警告横幅——本重置周期内不再提示（exhausted 不受影响）。 */
  | { type: "dismissRateLimit"; limitLabel: string; resetsAt?: number }
  | { type: "qqLoad" }
  | { type: "qqSave"; config: QQConfig }
  | { type: "qqToggle"; enabled: boolean }
  | { type: "slsSave"; config: SlsConfig }
  | { type: "slsTest"; config: SlsConfig }
  /** 让 Claude 扫描工作区 Spring Boot 配置生成日志映射（预填 prompt 到聊天）。 */
  | { type: "slsGenerate" };
