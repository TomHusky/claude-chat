import { ClaudeProcess } from "../src/claude/process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function waitResult(flag: () => boolean, ms = 45000) {
  const t0 = Date.now();
  while (!flag() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 150));
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mt-"));
  const fixedId = randomUUID();
  let results = 0;
  let closed = false;
  let initId = "";
  let text = "";

  const proc = new ClaudeProcess(
    { claudePath: "claude", cwd, permissionMode: "default", sessionId: fixedId },
    {
      emit: (e) => {
        if (e.kind === "result") results++;
        if (e.kind === "session") initId = e.sessionId;
        if (e.kind === "text_delta") text += e.text;
      },
      onPermission: (req) => proc.respondPermission(req.requestId, { behavior: "allow" }),
      onSessionId: () => {},
      onClose: () => (closed = true),
    },
  );

  await proc.start();
  console.log("requested session-id:", fixedId);

  // Turn 1
  text = "";
  proc.sendUserMessage("Remember the secret word is BANANA. Reply with just 'ok'.");
  await waitResult(() => results >= 1);
  console.log("after turn1: results=", results, "closed=", closed, "initId==requested:", initId === fixedId);
  console.log("turn1 text:", JSON.stringify(text.trim().slice(0, 80)));

  // Turn 2 in the SAME process (tests both liveness AND context retention)
  text = "";
  proc.sendUserMessage("What was the secret word? Reply with just the word.");
  await waitResult(() => results >= 2);
  console.log("after turn2: results=", results, "closed=", closed);
  console.log("turn2 text:", JSON.stringify(text.trim().slice(0, 80)));

  console.log("\n==== MULTITURN SUMMARY ====");
  console.log("--session-id honored:", initId === fixedId);
  console.log("process survived turn 1 (2 results, not closed mid-way):", results >= 2 && !closed);
  console.log("context retained (knows BANANA):", /banana/i.test(text));
  console.log("PASS:", initId === fixedId && results >= 2 && /banana/i.test(text));

  proc.dispose();
  setTimeout(() => process.exit(0), 400);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
