import { ClaudeProcess } from "../src/claude/process";
import { ToWebview } from "../src/shared";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-smoke-"));
  console.log("cwd:", cwd);
  let text = "";
  const tools: string[] = [];
  let permissionAsks = 0;
  let resultSeen = false;

  const proc = new ClaudeProcess(
    { claudePath: "claude", cwd, permissionMode: "default" },
    {
      emit: (e: ToWebview) => {
        if (e.kind === "text_delta") text += e.text;
        else if (e.kind === "tool_input") tools.push(e.name);
        else if (e.kind === "session") console.log("[session]", e.sessionId, e.model);
        else if (e.kind === "result") {
          resultSeen = true;
          console.log("[result] isError=", e.isError, "turns=", e.numTurns, "cost=", e.costUsd);
        } else if (e.kind === "error") console.log("[ERROR]", e.message);
        else if (e.kind === "status") {} // quiet
        else console.log("[evt]", e.kind);
      },
      onPermission: (req) => {
        permissionAsks++;
        console.log("[permission] ", req.toolName, JSON.stringify(req.input).slice(0, 80), "suggestions=", req.suggestions.map((s) => s.id));
        proc.respondPermission(req.requestId, { behavior: "allow" });
      },
      onSessionId: (id) => console.log("[sessionId]", id),
      onClose: (code) => console.log("[close]", code),
    },
  );

  await proc.start();
  console.log("[started] session:", proc.currentSessionId);
  proc.sendUserMessage("Create a file smoke.txt containing SMOKE_OK using the Write tool. Then stop.");

  // wait up to 60s for result
  const t0 = Date.now();
  while (!resultSeen && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 200));

  const target = path.join(cwd, "smoke.txt");
  const created = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "(missing)";
  console.log("\n==== SMOKE SUMMARY ====");
  console.log("text length:", text.length, "| first 120:", JSON.stringify(text.slice(0, 120)));
  console.log("tools seen:", tools);
  console.log("permission asks:", permissionAsks);
  console.log("smoke.txt:", JSON.stringify(created));
  console.log("PASS:", created.includes("SMOKE_OK") && permissionAsks > 0 && resultSeen);

  proc.dispose();
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
