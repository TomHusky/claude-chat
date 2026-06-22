import { ClaudeProcess } from "../src/claude/process";
import { SessionStore } from "../src/claude/session";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function countLines(file: string): number {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}
function truncateToLines(file: string, keep: number): void {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  // keep first `keep` non-empty lines (preserve exact bytes of those lines)
  let kept = 0;
  const out: string[] = [];
  for (const l of lines) {
    if (l.trim()) {
      if (kept >= keep) break;
      kept++;
    }
    out.push(l);
  }
  fs.writeFileSync(file, out.join("\n") + "\n", "utf8");
}

async function runTurn(proc: ClaudeProcess, text: string, getResults: () => number): Promise<string> {
  const before = getResults();
  let captured = "";
  // hook into emit is already wired; we collect via the shared `text` accumulator below
  proc.sendUserMessage(text);
  const t0 = Date.now();
  while (getResults() <= before && Date.now() - t0 < 45000) await new Promise((r) => setTimeout(r, 150));
  await new Promise((r) => setTimeout(r, 800)); // settle: let jsonl flush
  return captured;
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-trunc-"));
  const sessionId = randomUUID();
  const store = new SessionStore(cwd);
  let results = 0;
  let lastText = "";

  const mk = () =>
    new ClaudeProcess(
      { claudePath: "claude", cwd, permissionMode: "default", resumeSessionId: undefined, sessionId },
      {
        emit: (e) => {
          if (e.kind === "result") results++;
          if (e.kind === "text_delta") lastText += e.text;
        },
        onPermission: (req) => p.respondPermission(req.requestId, { behavior: "allow" }),
        onSessionId: () => {},
        onClose: () => {},
      },
    );

  let p = mk();
  await p.start();

  lastText = "";
  await runTurn(p, "The secret word is ALPHA. Reply with just 'ok'.", () => results);
  console.log("turn1:", JSON.stringify(lastText.trim().slice(0, 40)));

  const file = store.findFile(sessionId); // file now exists (written during turn 1)
  console.log("session file:", file);
  if (!file) {
    console.log("FAIL: could not locate session jsonl");
    process.exit(1);
  }

  // record the truncation boundary == lines present BEFORE turn 2 is sent
  const keepLines = countLines(file!);
  console.log("lines after turn1 (truncation boundary):", keepLines);

  lastText = "";
  await runTurn(p, "Correction: the secret word is now BETA. Reply with just 'ok'.", () => results);
  console.log("turn2:", JSON.stringify(lastText.trim().slice(0, 40)));

  lastText = "";
  await runTurn(p, "Correction: the secret word is now GAMMA. Reply with just 'ok'.", () => results);
  console.log("turn3:", JSON.stringify(lastText.trim().slice(0, 40)));

  const totalLines = countLines(file!);
  console.log("lines after turn3:", totalLines);

  // inspect the line types around the cut and at the tail
  const allLines = fs.readFileSync(file!, "utf8").split("\n").filter((l) => l.trim());
  const typeAt = (i: number) => {
    try {
      const o = JSON.parse(allLines[i]);
      return o.type + (o.subtype ? "/" + o.subtype : "");
    } catch {
      return "?";
    }
  };
  console.log("type at cut-1:", typeAt(keepLines - 1), "| at cut:", typeAt(keepLines));
  console.log("tail types:", allLines.slice(-3).map((_, i) => typeAt(allLines.length - 3 + i)));

  // === TRUNCATE ===
  p.dispose();
  await new Promise((r) => setTimeout(r, 600));
  truncateToLines(file!, keepLines);
  console.log("truncated to", keepLines, "lines; now", countLines(file!), "lines");

  // === RESUME the truncated session ===
  results = 0;
  p = mk2(cwd, sessionId, () => results, (t) => (lastText = t));
  await p.start2();
  lastText = "";
  await runTurn(p.proc, "What is the secret word? Reply with ONLY the word, nothing else.", () => p.getResults());
  const answer = lastText.trim();
  console.log("\n==== TRUNCATION SUMMARY ====");
  console.log("answer after truncation+resume:", JSON.stringify(answer.slice(0, 60)));
  const saysAlpha = /alpha/i.test(answer);
  const saysLater = /beta|gamma/i.test(answer);
  console.log("remembers ALPHA (turn1 kept):", saysAlpha);
  console.log("forgot BETA/GAMMA (turns truncated):", !saysLater);
  console.log("PASS (true truncation):", saysAlpha && !saysLater);

  p.proc.dispose();
  setTimeout(() => process.exit(0), 500);
}

// small wrapper so the resumed process has its own counters
function mk2(cwd: string, sessionId: string, _g: () => number, setText: (t: string) => void) {
  let results = 0;
  let acc = "";
  let proc!: ClaudeProcess;
  proc = new ClaudeProcess(
    { claudePath: "claude", cwd, permissionMode: "default", resumeSessionId: sessionId },
    {
      emit: (e) => {
        if (e.kind === "result") results++;
        if (e.kind === "text_delta") {
          acc += e.text;
          setText(acc);
        }
      },
      onPermission: (req) => proc.respondPermission(req.requestId, { behavior: "allow" }),
      onSessionId: () => {},
      onClose: () => {},
    },
  );
  return {
    proc,
    getResults: () => results,
    start2: () => proc.start(),
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
