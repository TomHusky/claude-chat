import { ClaudeProcess } from "../src/claude/process";
import { SessionStore } from "../src/claude/session";
import { CheckpointManager } from "../src/checkpoints";
import { ToWebview } from "../src/shared";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-restore-"));
  const store = new SessionStore(cwd);
  const checkpoints = new CheckpointManager(fs.mkdtempSync(path.join(os.tmpdir(), "cc-store-")));
  const sessionId = randomUUID();
  checkpoints.setSession(sessionId);

  let results = 0;
  let text = "";

  const makeProc = (resume: boolean) =>
    new ClaudeProcess(
      {
        claudePath: "claude",
        cwd,
        permissionMode: "default",
        sessionId: resume ? undefined : sessionId,
        resumeSessionId: resume ? sessionId : undefined,
      },
      {
        emit: (e: ToWebview) => {
          if (e.kind === "result") results++;
          if (e.kind === "text_delta") text += e.text;
          // mirror provider.handleEmit: snapshot files before edits
          if (e.kind === "tool_input" && FILE_TOOLS.has(e.name)) {
            const p = (e.input.file_path ?? e.input.notebook_path) as string | undefined;
            if (p && path.isAbsolute(p)) checkpoints.snapshotFile(p);
          }
        },
        onPermission: (req) => proc.respondPermission(req.requestId, { behavior: "allow" }),
        onSessionId: () => {},
        onClose: () => {},
      },
    );

  let proc = makeProc(false);
  await proc.start();

  // mirror provider.handleSend
  async function turn(t: string) {
    const before = results;
    const lineBefore = store.countLines(sessionId);
    checkpoints.beginTurn(t, lineBefore);
    text = "";
    proc.sendUserMessage(t);
    const t0 = Date.now();
    while (results <= before && Date.now() - t0 < 45000) await new Promise((r) => setTimeout(r, 150));
    await new Promise((r) => setTimeout(r, 800)); // settle flush
    return text.trim();
  }

  console.log("turn1:", JSON.stringify((await turn("Remember: the secret word is ALPHA. Reply only 'ok'.")).slice(0, 30)));
  console.log("turn2:", JSON.stringify((await turn(
    "Create a file named marker.txt containing the text BETA using the Write tool. Also remember the secret word is now BETA. Reply only 'done'.",
  )).slice(0, 30)));
  console.log("turn3:", JSON.stringify((await turn("Remember: the secret word is now GAMMA. Reply only 'ok'.")).slice(0, 30)));

  const markerPath = path.join(cwd, "marker.txt");
  const markerBefore = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : "(missing)";
  const cps = checkpoints.list();
  console.log("\ncheckpoints:", cps.map((c) => c.label));
  console.log("marker.txt before restore:", JSON.stringify(markerBefore));

  // === RESTORE to checkpoint #2 (turn 2) — undo turn2 onward ===
  const target = cps[1];
  console.log("restoring checkpoint:", JSON.stringify(target.label));
  const res = checkpoints.restore(target.id)!;
  proc.dispose();
  await new Promise((r) => setTimeout(r, 600));
  const remaining = store.truncateToLines(sessionId, res.truncateLine);
  const checkpointsLeft = checkpoints.list().length; // capture before the probe turn mutates it
  console.log("restoredFiles:", res.restoredFiles, "| remaining user turns:", remaining, "| checkpoints left:", checkpointsLeft);

  const markerAfter = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : "(deleted)";
  console.log("marker.txt after restore:", JSON.stringify(markerAfter));

  // === RESUME truncated session and probe memory ===
  results = 0;
  proc = makeProc(true);
  await proc.start();
  const answer = await turn("What is the secret word right now? Reply with ONLY the word.");
  console.log("\n==== RESTORE E2E SUMMARY ====");
  console.log("answer after restore+resume:", JSON.stringify(answer.slice(0, 40)));
  const ok =
    /alpha/i.test(answer) &&
    !/beta|gamma/i.test(answer) &&
    markerAfter === "(deleted)" &&
    remaining === 1 &&
    checkpointsLeft === 1;
  console.log("conversation rewound to ALPHA:", /alpha/i.test(answer) && !/beta|gamma/i.test(answer));
  console.log("marker.txt reverted (deleted):", markerAfter === "(deleted)");
  console.log("1 turn + 1 checkpoint remained at restore:", remaining === 1 && checkpointsLeft === 1);
  console.log("PASS:", ok);

  proc.dispose();
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
