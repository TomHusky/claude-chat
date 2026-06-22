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
  play: _s('<path d="M5 3.8v8.4l7-4.2z"/>'),
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
  | { kind: "result"; isError: boolean; costUsd?: number; durationMs?: number; numTurns?: number }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string }
  // Full conversation replacement (switching/restoring sessions)
  | { kind: "load_history"; items: TimelineItem[]; sessionId?: string; title?: string; checkpoints?: CheckpointSummary[] }
  | { kind: "sessions"; list: SessionSummary[]; activeId?: string }
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
  | { type: "warm" }
  | { type: "send"; text: string; context?: string; images?: { mediaType: string; data: string }[]; files?: string[] }
  | { type: "editMessage"; checkpointId: string; text: string }
  | { type: "interrupt" }
  | { type: "permission"; requestId: string; behavior: "allow" | "deny"; suggestionId?: string }
  | { type: "newSession" }
  | { type: "listSessions" }
  | { type: "switchSession"; sessionId: string }
  | { type: "openSession"; sessionId: string }
  | { type: "newInEditor" }
  | { type: "deleteSession"; sessionId: string }
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
  | { type: "runInTerminal"; code: string }
  | { type: "copy"; text: string };
