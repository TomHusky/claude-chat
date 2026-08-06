import { SdkClaudeProcess } from "/Users/duodian/claude-chat/src/claude/sdkProcess";
const events: string[] = [];
let text = "";
let gotResult = false;
const proc = new SdkClaudeProcess(
  {
    claudePath: "claude",
    cwd: process.argv[2],
    permissionMode: "default",
    model: "haiku",
  } as any,
  {
    emit: (e: any) => {
      events.push(e.kind);
      if (e.kind === "text_delta") text += e.text;
      if (e.kind === "result") gotResult = true;
      if (e.kind === "error") console.error("[emit error]", e.message);
    },
    onPermission: (req: any) => { console.error("unexpected permission:", req.toolName); },
    onSessionId: (id: string, resumed: boolean) => console.log("[session]", id.slice(0, 8), "resumed=", resumed),
    onClose: (code: any) => console.log("[close]", code),
  } as any,
);
(async () => {
  const t0 = Date.now();
  await proc.start();
  console.log("[start] initialized in", Date.now() - t0, "ms");
  const ok = proc.sendUserMessage("只回复ok两个字，不要多说");
  console.log("[send] accepted =", ok);
  for (let i = 0; i < 120 && !gotResult; i++) await new Promise((r) => setTimeout(r, 500));
  console.log("[text]", JSON.stringify(text.slice(0, 100)));
  console.log("[events]", [...new Set(events)].join(","));
  console.log("[assert] text_delta:", events.includes("text_delta"), "result:", gotResult, "busy往返:", events.filter(e=>e==="busy").length >= 2);
  await proc.disposeAndWait();
  console.log("[done] exited =", proc.isExited);
  process.exit(gotResult && events.includes("text_delta") ? 0 : 1);
})().catch((e) => { console.error("SMOKE FAIL:", e); process.exit(1); });
