import * as vscode from "vscode";
import { ClaudeProcess, ClaudeProcessOptions, ClaudeProcessHooks } from "./process";
import { SdkClaudeProcess } from "./sdkProcess";

/** 两个引擎的公共类型：公开成员完全一致，provider 按此类型持有实例。 */
export type EngineProcess = ClaudeProcess | SdkClaudeProcess;

/** 按设置选择对接引擎：
 *  - "sdk"（默认）：官方 @anthropic-ai/claude-agent-sdk，协议层由官方维护，
 *    CLI 升级不再担心协议漂移（0.1.235 起转正）；
 *  - "stream-json"：自维护协议层（src/claude/process.ts），保留作回退开关，
 *    SDK 路线稳定运行一段时间后整体移除。 */
export function createClaudeProcess(opts: ClaudeProcessOptions, hooks: ClaudeProcessHooks): EngineProcess {
  const engine = vscode.workspace.getConfiguration("claudeChat").get<string>("engine", "sdk");
  return engine === "stream-json" ? new ClaudeProcess(opts, hooks) : new SdkClaudeProcess(opts, hooks);
}
