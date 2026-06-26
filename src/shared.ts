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
};

// ---- Extension host -> webview --------------------------------------------

export type ToWebview =
  | { kind: "session"; sessionId: string; model: string; cwd: string; tools: string[]; resumed?: boolean }
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
  | { kind: "update_available"; version: string }
  | { kind: "context"; used: number; total: number }
  | { kind: "refs_validated"; invalid: string[] }
  | { kind: "result"; isError: boolean; costUsd?: number; durationMs?: number; numTurns?: number }
  | { kind: "usage"; sessionPct?: number; sessionResetAt?: number; weekPct?: number; weekReset?: string; weekSonnetPct?: number }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string }
  // Full conversation replacement (switching/restoring sessions)
  | { kind: "load_history"; items: TimelineItem[]; sessionId?: string; title?: string; checkpoints?: CheckpointSummary[] }
  | { kind: "sessions"; list: SessionSummary[]; activeId?: string; runningIds?: string[] }
  | { kind: "running"; sessionIds: string[] }
  | { kind: "checkpoints"; list: CheckpointSummary[] }
  // A restore point was created for the turn just sent (live).
  | { kind: "checkpoint_marker"; checkpointId: string; userText: string }
  | { kind: "config"; permissionMode: string; model: string; effort: string }
  | { kind: "context_added"; label: string; text: string }
  | { kind: "active_file"; path: string | null }
  | { kind: "attach_files"; paths: string[] }
  | { kind: "changed_files"; files: ChangedFile[]; totalAdded: number; totalRemoved: number };

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

/** A persisted/rehydratable timeline item (used when reloading a session). */
export type TimelineItem =
  | { type: "user"; text: string; context?: string; images?: string[]; files?: string[] }
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
  | { type: "checkpoint"; id: string; label: string };

// ---- Webview -> extension host --------------------------------------------

export type FromWebview =
  | { type: "ready" }
  | { type: "checkUpdate" }
  | { type: "refreshUsage" }
  | { type: "send"; text: string; context?: string; images?: { mediaType: string; data: string }[]; files?: string[] }
  | { type: "editMessage"; checkpointId: string; text: string }
  | { type: "interrupt" }
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
  | { type: "copy"; text: string };
