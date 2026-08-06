import * as vscode from "vscode";
import { ClaudeProcess, ClaudeProcessOptions, ClaudeProcessHooks } from "./process";
import { SdkClaudeProcess } from "./sdkProcess";

/** 两个引擎的公共类型：公开成员完全一致，provider 按此类型持有实例。 */
export type EngineProcess = ClaudeProcess | SdkClaudeProcess;

/** 按设置选择对接引擎：
 *  - "stream-json"（默认）：自维护协议层（src/claude/process.ts），久经生产验证；
 *  - "sdk"（实验）：官方 @anthropic-ai/claude-agent-sdk，协议层交给官方维护。
 *  出问题随时切回，无需重启会话以外的任何代价（下一个新进程生效）。 */
export function createClaudeProcess(opts: ClaudeProcessOptions, hooks: ClaudeProcessHooks): EngineProcess {
  const engine = vscode.workspace.getConfiguration("claudeChat").get<string>("engine", "stream-json");
  return engine === "sdk" ? new SdkClaudeProcess(opts, hooks) : new ClaudeProcess(opts, hooks);
}
