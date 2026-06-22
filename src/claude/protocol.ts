/**
 * Type definitions for the `claude` CLI stream-json protocol.
 *
 * All shapes below were verified empirically against claude-code 2.1.x running
 * with: `claude -p --input-format stream-json --output-format stream-json
 * --verbose --include-partial-messages --permission-prompt-tool stdio`.
 *
 * Two channels share stdout/stdin:
 *   - the "message" channel (system/assistant/user/result/stream_event/...)
 *   - the "control" channel (control_request / control_response) used for the
 *     initialize handshake and for tool-permission prompts (`can_use_tool`).
 */

// ---------------------------------------------------------------------------
// Anthropic content blocks (as they appear inside assistant/user messages)
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  is_error?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Output events (CLI -> us, the "message" channel)
// ---------------------------------------------------------------------------

export interface SystemInitEvent {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  model: string;
  tools: string[];
  mcp_servers?: Array<{ name: string; status?: string }>;
  uuid?: string;
}

export interface SystemStatusEvent {
  type: "system";
  subtype: "status" | "thinking_tokens" | "api_retry" | string;
  status?: string;
  session_id?: string;
  [k: string]: unknown;
}

export interface AssistantEvent {
  type: "assistant";
  message: {
    id: string;
    model: string;
    role: "assistant";
    content: ContentBlock[];
    stop_reason?: string | null;
    usage?: Usage;
  };
  session_id?: string;
  uuid?: string;
}

export interface UserEvent {
  type: "user";
  message: {
    role: "user";
    content: ContentBlock[];
  };
  session_id?: string;
  uuid?: string;
}

export interface ResultEvent {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | string;
  is_error: boolean;
  result?: string;
  session_id: string;
  total_cost_usd?: number;
  usage?: Usage;
  duration_ms?: number;
  num_turns?: number;
  uuid?: string;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Wraps a raw Anthropic streaming event when --include-partial-messages is on. */
export interface StreamEvent {
  type: "stream_event";
  event: AnthropicStreamEvent;
  session_id?: string;
  uuid?: string;
}

export type AnthropicStreamEvent =
  | { type: "message_start"; message?: unknown }
  | { type: "content_block_start"; index: number; content_block: { type: string; id?: string; name?: string } }
  | { type: "content_block_delta"; index: number; delta: ContentDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: string }; usage?: Usage }
  | { type: "message_stop" };

export type ContentDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "signature_delta"; signature: string };

export interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Control channel
// ---------------------------------------------------------------------------

/** Permission suggestions attached to a can_use_tool request (power "always allow"). */
export type PermissionSuggestion =
  | { type: "setMode"; mode: string; destination?: string }
  | { type: "addRules"; rules: Array<{ toolName: string; ruleContent?: string }>; destination?: string }
  | { type: string; [k: string]: unknown };

export interface CanUseToolRequest {
  subtype: "can_use_tool";
  tool_name: string;
  display_name?: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  description?: string;
  blocked_path?: string;
  permission_suggestions?: PermissionSuggestion[];
  decision_reason?: string;
}

/** CLI -> us. Currently we only act on can_use_tool. */
export interface ControlRequest {
  type: "control_request";
  request_id: string;
  request: CanUseToolRequest | { subtype: string; [k: string]: unknown };
}

/** CLI -> us, the reply to a control_request *we* sent (e.g. initialize). */
export interface ControlResponse {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: unknown;
    error?: string;
  };
}

export type OutEvent =
  | SystemInitEvent
  | SystemStatusEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | StreamEvent
  | RateLimitEvent
  | ControlRequest
  | ControlResponse
  | { type: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Input messages (us -> CLI)
// ---------------------------------------------------------------------------

export interface UserInputMessage {
  type: "user";
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
}

export interface InitializeControlRequest {
  type: "control_request";
  request_id: string;
  request: { subtype: "initialize" };
}

export interface InterruptControlRequest {
  type: "control_request";
  request_id: string;
  request: { subtype: "interrupt" };
}

export interface SetModeControlRequest {
  type: "control_request";
  request_id: string;
  request: { subtype: "set_permission_mode"; mode: string };
}

/** Our reply to a can_use_tool request. updatedInput MUST be echoed for allow. */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message?: string; interrupt?: boolean };

export interface PermissionControlResponse {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response: PermissionDecision;
  };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isControlRequest(e: OutEvent): e is ControlRequest {
  return e.type === "control_request";
}
export function isControlResponse(e: OutEvent): e is ControlResponse {
  return e.type === "control_response";
}
export function isCanUseTool(r: ControlRequest["request"]): r is CanUseToolRequest {
  return r.subtype === "can_use_tool";
}
