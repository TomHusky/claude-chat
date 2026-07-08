import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import type { FromWebview, TimelineItem, ToWebview } from "../shared";
import { ICONS as ICON } from "../shared";

// ---------------------------------------------------------------------------
// VS Code bridge
// ---------------------------------------------------------------------------
declare function acquireVsCodeApi(): {
  postMessage(msg: FromWebview): void;
  getState(): unknown;
  setState(s: unknown): void;
};
const vscode = acquireVsCodeApi();
const send = (m: FromWebview) => vscode.postMessage(m);

// ---------------------------------------------------------------------------
// Markdown (fast = per-line while streaming; full = finalized w/ highlighting)
// ---------------------------------------------------------------------------
const mdFast = new MarkdownIt({ html: false, linkify: true, breaks: true });
const mdFull = new MarkdownIt({ html: false, linkify: true, breaks: true });

const COLLAPSE_THRESHOLD = 6; // code blocks longer than this collapse to a 3-line preview

mdFull.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = (token.info || "").trim();
  const lang = info.split(/\s+/)[0] || "";
  let body: string;
  if (lang && hljs.getLanguage(lang)) {
    try {
      body = hljs.highlight(token.content, { language: lang }).value;
    } catch {
      body = escapeHtml(token.content);
    }
  } else if (token.content.length <= 10_000) {
    try {
      body = hljs.highlightAuto(token.content).value;
    } catch {
      body = escapeHtml(token.content);
    }
  } else {
    // Auto-detection runs EVERY registered grammar — on big unlabeled blocks
    // that visibly stalls the finalize step. Plain text is fine there.
    body = escapeHtml(token.content);
  }
  return wrapCodeBlock(body, lang, token.content, true, true);
};

/**
 * Build the shared code-block HTML (hover copy/run actions + long-code collapse).
 * `highlighted` is the inner HTML for <code>; `raw` is the plain text used for
 * line counting (copy/run read it back from the DOM).
 */
function wrapCodeBlock(highlighted: string, lang: string, raw: string, run: boolean, actions: boolean): string {
  const lineCount = raw.replace(/\n+$/, "").split("\n").length;
  const collapsible = lineCount > COLLAPSE_THRESHOLD;
  const cls = "code-block" + (collapsible ? " collapsible collapsed" : "");
  const runBtn = run ? `<button class="code-act" data-action="run" title="在终端执行">${ICON.play} 执行</button>` : "";
  const actionsHtml = actions
    ? `<div class="code-actions">${runBtn}<button class="code-act" data-action="copy" title="复制">${ICON.copy} 复制</button></div>`
    : "";
  const expandBtn = collapsible
    ? `<button class="code-expand" data-action="toggle-code">展开全部 ${lineCount} 行</button>`
    : "";
  return (
    `<div class="${cls}" data-lines="${lineCount}">` +
    actionsHtml +
    `<div class="code-body"><pre class="hljs"><code>${highlighted}</code></pre></div>` +
    expandBtn +
    `</div>`
  );
}

/** Highlight + wrap arbitrary code (tool cards: Bash command, JSON, …). No inline
 *  actions — copy/run live in the tool card header instead. */
function codeBlock(code: string, lang: string): string {
  let body: string;
  if (lang && hljs.getLanguage(lang)) {
    try {
      body = hljs.highlight(code, { language: lang }).value;
    } catch {
      body = escapeHtml(code);
    }
  } else {
    body = escapeHtml(code);
  }
  return wrapCodeBlock(body, lang, code, false, false);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const messagesEl = $("messages");
const inputEl = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("btn-send");
const stopBtn = $<HTMLButtonElement>("btn-stop");
const queueHint = $("queue-hint");
const PLACEHOLDER_IDLE = inputEl.placeholder;
const PLACEHOLDER_BUSY = "任务进行中 · 回车将内容加入等待队列";
const statusLine = $("status-line");
const modeTrigger = $("mode-trigger");
const modeIcon = $("mode-icon");
const modeLabel = $("mode-label");
const modeMenu = $("mode-menu");
const modelTrigger = $("model-trigger");
const modelLabel = $("model-label");
const modelMenu = $("model-menu");
const pickBackdrop = $("pick-backdrop");
const contextChips = $("context-chips");
const sessionsPanel = $("panel-sessions");
const sessionsList = $("sessions-list");
const overlay = $("overlay");
const changedFiles = $("changed-files");
const cfList = $("cf-list");
const cfStat = $("cf-stat");
const cfHeader = $("cf-header");
const lightbox = $("lightbox");
const lightboxImg = $<HTMLImageElement>("lightbox-img");
const imagePreviews = $("image-previews");
const fileChips = $("file-chips");

// ---------------------------------------------------------------------------
// Live streaming state
// ---------------------------------------------------------------------------
interface LiveBlock {
  type: "text";
  raw: string; // full text received so far (target)
  shown: number; // chars currently revealed (typewriter cursor)
  el: HTMLElement; // the .text-seg wrapper
  committedEl: HTMLElement; // rendered markdown for complete lines
  lineEl: HTMLElement; // the current line being typed (plain text)
  committedLen: number; // chars already committed (rendered as markdown)
}
let assistantEl: HTMLElement | null = null;
let liveBlock: LiveBlock | null = null;
let typewriterRAF = 0;
let pinnedToBottom = true;
let isBusy = false;
let lastUserEl: HTMLElement | null = null;
let userMsgCount = 0;
const toolCards = new Map<string, HTMLElement>();
const pendingContexts: { label: string; text: string }[] = [];
const pendingImages: { mediaType: string; data: string; uri: string }[] = [];

/** Original rainbow radial sunburst mark (generic geometry, our own design). */
const SUNBURST = (() => {
  const cx = 12, cy = 12, r1 = 3.6, r2 = 9, n = 12;
  const hues = [
    "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#27ae60", "#1abc9c",
    "#00bcd4", "#3498db", "#5b6cf0", "#8e44ad", "#c0399b", "#e84393",
  ];
  let s = "";
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x1 = (cx + r1 * Math.cos(a)).toFixed(2);
    const y1 = (cy + r1 * Math.sin(a)).toFixed(2);
    const x2 = (cx + r2 * Math.cos(a)).toFixed(2);
    const y2 = (cy + r2 * Math.sin(a)).toFixed(2);
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${hues[i]}"/>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke-width="2.1" stroke-linecap="round">${s}</svg>`;
})();

function ensureAssistant(): HTMLElement {
  if (!assistantEl) {
    messagesEl.querySelector(".empty-state")?.remove();
    assistantEl = el("div", "msg assistant");
    if (isBusy) assistantEl.classList.add("streaming-turn");
    const rail = el("div", "rail");
    const avatar = el("div", "avatar");
    avatar.innerHTML = SUNBURST;
    const line = el("div", "thread-line");
    rail.append(avatar, line);
    const body = el("div", "msg-body");
    assistantEl.append(rail, body);
    messagesEl.appendChild(assistantEl);
  }
  return assistantEl.querySelector(".msg-body") as HTMLElement;
}

function finalizeTurn() {
  finalizeLive();
  removeWorking();
  cancelPendingInteractions();
  if (assistantEl) {
    assistantEl.classList.remove("streaming-turn");
    assistantEl.querySelector(".rail .thread-active")?.remove(); // stop the progress pulse
    const body = assistantEl.querySelector(".msg-body");
    // If the user manually stopped, mark it at the very end of the reply.
    if (body && userStopped) body.appendChild(el("div", "msg-interrupted", "[Request interrupted by user]"));
    if (body && body.children.length === 0) {
      assistantEl.remove();
    } else if (body) {
      // Mark the final summary text as the closing timeline node (a dot at its
      // start) — but only when it follows earlier content (not the very first item).
      const segs = body.querySelectorAll(".text-seg");
      const last = segs[segs.length - 1];
      if (last && body.firstElementChild !== last) last.classList.add("summary-node");
      endTimelineAtLastNode(assistantEl); // stop the line at the last node
      // Footer: a row of borderless icon buttons under the reply.
      if (!body.querySelector(".msg-actions")) {
        body.appendChild(buildReplyActions(assistantEl));
      }
    }
  }
  // Reset unconditionally: if Stop landed after the bubble was already
  // finalized, a sticky flag would stamp "[interrupted]" onto the NEXT turn.
  userStopped = false;
  assistantEl = null;
  liveBlock = null;
}

/** The turn is over — any interactive UI still waiting for the user (question
 *  picker `.askp`, permission bar `.perm-bar`) is bound to a dead request:
 *  answering it would silently go nowhere. Freeze it visibly instead. */
function cancelPendingInteractions() {
  Array.from(
    messagesEl.querySelectorAll<HTMLElement>(
      ".askp:not(.interaction-cancelled), .perm-bar:not(.resolved):not(.interaction-cancelled)",
    ),
  ).forEach((box) => {
    box.classList.add("interaction-cancelled");
    Array.from(box.querySelectorAll("button")).forEach((b) => ((b as HTMLButtonElement).disabled = true));
  });
}

/** Shorten the timeline rail so it ends exactly at the last node (no trailing line). */
function endTimelineAtLastNode(msg: HTMLElement) {
  const line = msg.querySelector(".thread-line") as HTMLElement | null;
  if (!line) return;
  const compute = () => {
    const nodes = msg.querySelectorAll(".step, .text-seg.summary-node");
    const last = nodes[nodes.length - 1] as HTMLElement | undefined;
    if (!last) {
      line.style.display = "none";
      return;
    }
    line.style.display = "";
    const aTop = msg.getBoundingClientRect().top;
    const lineTop = line.getBoundingClientRect().top - aTop;
    const endY = last.getBoundingClientRect().top - aTop + 9; // ≈ dot center
    line.style.flex = "0 0 auto";
    line.style.height = Math.max(0, endY - lineTop) + "px";
  };
  compute();
  // The pixel height goes stale when content below reflows (code highlighting,
  // expanding a tool result, images loading). Recompute on any size change so
  // the line always connects every node exactly.
  const m = msg as HTMLElement & { _lineObs?: ResizeObserver };
  if (!m._lineObs) {
    let raf = 0;
    m._lineObs = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(compute);
    });
    m._lineObs.observe(msg);
    railObservers.push(m._lineObs); // disconnected when the transcript re-renders
  }
}
/** Rail observers of all finalized messages — long sessions otherwise pile up
 *  one live ResizeObserver per reply, each still firing on any resize. */
const railObservers: ResizeObserver[] = [];

/** Reveal the live text with a typewriter: complete lines are rendered as
 *  markdown (committed once each newline arrives), and the current line types
 *  out char-by-char as plain text.
 *  NOTE: each commit re-renders the whole prefix — O(n²) over a long reply.
 *  Once the text is big, batch commits into larger chunks: the tail lines just
 *  stay as plain text a moment longer, which is visually indistinguishable. */
function renderLive() {
  if (!liveBlock) return;
  const shownText = liveBlock.raw.slice(0, liveBlock.shown);
  const lastNl = shownText.lastIndexOf("\n");
  const commitLen = lastNl >= 0 ? lastNl + 1 : 0;
  // Commit threshold grows with size: instant at first, ~1/16 of length later.
  const minGain = Math.min(4096, Math.max(1, liveBlock.committedLen >> 4));
  if (commitLen - liveBlock.committedLen >= minGain) {
    liveBlock.committedLen = commitLen;
    liveBlock.committedEl.innerHTML = mdFast.render(liveBlock.raw.slice(0, commitLen));
  }
  liveBlock.lineEl.textContent = shownText.slice(liveBlock.committedLen);
  updateActiveLine();
  maybeScroll();
}

function startTypewriter() {
  if (typewriterRAF) return;
  const tick = () => {
    typewriterRAF = 0;
    if (!liveBlock) return;
    const target = liveBlock.raw.length;
    if (liveBlock.shown < target) {
      const remaining = target - liveBlock.shown;
      const step = Math.max(2, Math.ceil(remaining / 8)); // accelerate when far behind
      liveBlock.shown = Math.min(target, liveBlock.shown + step);
      renderLive();
    }
    if (liveBlock && liveBlock.shown < liveBlock.raw.length) typewriterRAF = requestAnimationFrame(tick);
  };
  typewriterRAF = requestAnimationFrame(tick);
}

/** The model occasionally leaks its internal tool-call XML into plain prose
 *  (degenerate output after long context/compaction). It's stored that way in
 *  the transcript — fold it into a fenced block so it reads as raw syntax
 *  instead of broken paragraphs. */
function foldLeakedToolXml(text: string): string {
  if (!text.includes("<invoke name=")) return text;
  return text.replace(/<invoke name=[\s\S]*?(?:<\/invoke>|$)/g, (blk) => "\n```xml\n" + blk.trim() + "\n```\n");
}

/** Snap the live block to its full text, rendered with syntax highlighting. */
function finalizeLive() {
  if (typewriterRAF) {
    cancelAnimationFrame(typewriterRAF);
    typewriterRAF = 0;
  }
  if (!liveBlock) return;
  liveBlock.el.innerHTML = mdFull.render(foldLeakedToolXml(liveBlock.raw));
  linkifyRefs(liveBlock.el);
  removeWorking(); // the text block is done — drop the "Thinking" pill
  updateActiveLine();
  maybeScroll();
}

/** Position the pulsing "active" progress segment so it starts at the last
 *  timeline node (dot) and runs down to the current bottom of the thread. */
function updateActiveLine() {
  if (!assistantEl || !assistantEl.classList.contains("streaming-turn")) return;
  const rail = assistantEl.querySelector(".rail") as HTMLElement | null;
  const line = assistantEl.querySelector(".thread-line") as HTMLElement | null;
  if (!rail || !line) return;
  let active = rail.querySelector(".thread-active") as HTMLElement | null;
  if (!active) {
    active = el("div", "thread-active");
    rail.appendChild(active);
  }
  const railTop = rail.getBoundingClientRect().top;
  // Last node = the last visible step dot, else the avatar (first node).
  const dots = assistantEl.querySelectorAll(".msg-body .step .step-dot");
  let startY: number;
  const visibleDots = Array.from(dots).filter((d) => (d as HTMLElement).offsetParent !== null);
  if (visibleDots.length) {
    const r = (visibleDots[visibleDots.length - 1] as HTMLElement).getBoundingClientRect();
    startY = r.top + r.height / 2 - railTop;
  } else {
    const av = rail.querySelector(".avatar") as HTMLElement;
    const r = av.getBoundingClientRect();
    startY = r.top + r.height / 2 - railTop;
  }
  // Bottom = where the work currently IS: the live "working" pill if present
  // (so the glow reaches the bottom of a running tool's card), otherwise the
  // bottom of the last real content node — but NOT a trailing interactive box
  // (the option picker / permission box), which can be very tall.
  const pill = assistantEl.querySelector(".msg-body > .working-pill") as HTMLElement | null;
  let bottomY: number;
  if (pill) {
    bottomY = pill.getBoundingClientRect().bottom - railTop;
  } else {
    const content = assistantEl.querySelectorAll(".msg-body > .step, .msg-body > .text-seg, .msg-body > .msg-images");
    const lastContent = content[content.length - 1] as HTMLElement | undefined;
    bottomY = lastContent
      ? lastContent.getBoundingClientRect().bottom - railTop
      : rail.getBoundingClientRect().bottom - railTop - 2;
  }
  active.style.top = `${startY}px`;
  active.style.removeProperty("bottom");
  active.style.height = `${Math.max(0, bottomY - startY)}px`;
}

// -- Shared 1s ticker: updates the "Thinking · Ns · N tokens" pill ------------
let tickTimer = 0;
let turnTokens = 0; // exact output tokens (only arrives at each message's end)
let turnEst = 0; // live estimate from streamed chars (the CLI doesn't stream counts)
let msgTokenBase = 0; // sum of PREVIOUS messages' finals within this turn
let lastMsgTokens = 0; // the current message's cumulative count so far
// The CLI doesn't stream status text in -p mode, so (like Claude Code's TUI) we
// cycle through its whimsical "working" verbs locally to show it's alive.
const THINKING_WORDS = [
  "Thinking", "Cogitating", "Pondering", "Mulling", "Musing", "Noodling", "Ruminating",
  "Brewing", "Percolating", "Simmering", "Marinating", "Stewing", "Cooking", "Baking",
  "Churning", "Crunching", "Computing", "Calculating", "Processing", "Synthesizing",
  "Conjuring", "Crafting", "Forging", "Generating", "Hatching", "Manifesting",
  "Considering", "Deliberating", "Determining", "Ideating", "Inferring", "Puzzling",
  "Reticulating", "Spinning", "Vibing", "Working", "Wrangling", "Tinkering",
];
let workingRotate = false; // when true the ticker cycles the pill label
let workingFixed = ""; // a fixed phase label (e.g. preparing options) — no rotation
function fmtTokens(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
}
function setPillTokens() {
  const n = Math.max(turnTokens, Math.round(turnEst));
  const tk = assistantEl?.querySelector(".working-pill .wk-tokens") as HTMLElement | null;
  if (tk) tk.textContent = n > 0 ? `${fmtTokens(n)} tokens` : "";
}
function onTokens(output: number) {
  // `output` is cumulative WITHIN one assistant message; a turn with tool loops
  // has several messages. A drop in the counter = a new message started — bank
  // the previous message's final so the turn total is a true sum, not a max.
  if (output < lastMsgTokens) msgTokenBase += lastMsgTokens;
  lastMsgTokens = output;
  turnTokens = msgTokenBase + output;
  setPillTokens();
}
/** The CLI only reports tokens at message end, so estimate live from streamed
 *  text (CJK ≈ 1 token/char, latin ≈ 1 token/4 chars) for a growing counter. */
function addStreamEst(text: string) {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) || 0) >= 0x3000) cjk++;
    else other++;
  }
  turnEst += cjk * 1.05 + other / 4;
  setPillTokens();
}

const ctxGauge = $("ctx-gauge");
let lastCtxTotal = 1_000_000; // remembered so we can repaint the gauge after a /compact
let compacting = false;
/** Circular context-usage gauge next to the mode picker (hidden below 10%).
 *  Clicking it runs /compact to summarize and shrink the conversation. */
function updateContextGauge(used: number, total: number) {
  if (total > 0) lastCtxTotal = total;
  const pct = Math.max(0, Math.min(100, Math.round((used / total) * 100)));
  if (pct < 10) {
    ctxGauge.classList.add("hidden");
    return;
  }
  ctxGauge.classList.remove("hidden");
  ctxGauge.style.setProperty("--pct", String(pct));
  ctxGauge.style.setProperty("--cg-color", pct >= 85 ? "#e5534b" : pct >= 60 ? "#e0a33e" : "#d97757");
  const lbl = ctxGauge.querySelector(".cg-pct") as HTMLElement | null;
  if (lbl) lbl.textContent = String(pct);
  ctxGauge.title = `上下文使用 ${pct}%（约 ${fmtTokens(used)} / ${fmtTokens(total)} tokens）\n点击压缩上下文（/compact）`;
}
ctxGauge.addEventListener("click", () => {
  if (compacting || isBusy) return; // already working
  send({ type: "compact" });
});

const usagePill = $<HTMLButtonElement>("usage-pill");
/** Format a unix-seconds reset time as a "还剩 Xh Ym" countdown. */
function resetCountdown(resetAt?: number): string | undefined {
  if (!resetAt) return undefined;
  const mins = Math.round((resetAt * 1000 - Date.now()) / 60000);
  if (mins <= 0) return "即将重置";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `还剩 ${h} 小时 ${m} 分` : `还剩 ${m} 分`;
}
/** Claude subscription usage (current session + weekly quota), where cost was.
 *  Mirrors the official /usage panel: session % w/ reset countdown + weekly %. */
type UsageData = {
  sessionPct?: number;
  sessionReset?: string;
  weekPct?: number;
  weekReset?: string;
  weekSonnetPct?: number;
};
let lastUsageData: UsageData = {};
const usageMenu = $("usage-menu");
function renderUsage(sessionPct?: number, sessionReset?: string, weekPct?: number, weekReset?: string, weekSonnetPct?: number) {
  lastUsageData = { sessionPct, sessionReset, weekPct, weekReset, weekSonnetPct };
  const parts: string[] = [];
  if (typeof sessionPct === "number") parts.push(`会话 ${sessionPct}%`);
  if (typeof weekPct === "number") parts.push(`周 ${weekPct}%`);
  if (!parts.length) return;
  usagePill.classList.remove("hidden");
  const peak = Math.max(sessionPct ?? 0, weekPct ?? 0);
  usagePill.style.setProperty("--u-color", peak >= 90 ? "#e5534b" : peak >= 70 ? "#e0a33e" : "var(--vscode-descriptionForeground)");
  usagePill.textContent = parts.join(" · ");
  usagePill.title = "Claude 订阅用量 · 点击查看详情";
  if (!usageMenu.classList.contains("hidden")) buildUsageMenu(); // live-refresh while open
}

// Convert the CLI's English reset string ("Jun 30 at 1:50pm" / "Jul 6 at 2am")
// into Chinese. Session resets within hours → show just the time (or date+time
// if not today); weekly resets days out → show the date.
const RESET_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
function parseResetParts(s?: string): { mon?: number; day?: number; hh?: number; mm: number } {
  if (!s) return { mm: 0 };
  const m = /([A-Za-z]{3,})\s+(\d{1,2})(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(s);
  if (!m) return { mm: 0 };
  const mon = RESET_MONTHS[m[1].slice(0, 3).toLowerCase()];
  const day = parseInt(m[2], 10);
  let hh = m[3] != null ? parseInt(m[3], 10) : undefined;
  const mm = m[4] != null ? parseInt(m[4], 10) : 0;
  const ap = (m[5] || "").toLowerCase();
  if (hh != null) {
    if (ap === "pm" && hh < 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
  }
  return { mon, day, hh, mm };
}
function cnResetSession(s?: string): string {
  const p = parseResetParts(s);
  if (p.hh == null) return p.mon != null ? `${p.mon}月${p.day}日 重置` : "";
  const time = `${p.hh}:${String(p.mm).padStart(2, "0")}`;
  const now = new Date();
  const today = p.mon === now.getMonth() + 1 && p.day === now.getDate();
  return today ? `${time} 重置` : `${p.mon}月${p.day}日 ${time} 重置`;
}
function cnResetWeek(s?: string): string {
  const p = parseResetParts(s);
  return p.mon != null ? `${p.mon}月${p.day}日 重置` : "";
}
function usageRow(label: string, pct: number | undefined, resetText: string): string {
  const has = typeof pct === "number";
  const p = has ? Math.max(0, Math.min(100, pct as number)) : 0;
  const shown = has ? `${pct}%` : "—";
  const warn = p >= 90 ? " warn-high" : p >= 70 ? " warn-mid" : "";
  return (
    `<div class="usage-row${warn}">` +
    `<div class="usage-row-top"><span class="usage-name">${label}</span>` +
    `<span class="usage-pct">${shown}</span></div>` +
    `<div class="usage-bar"><span style="width:${p}%"></span></div>` +
    (resetText ? `<div class="usage-reset">${resetText}</div>` : "") +
    `</div>`
  );
}
/** Expanded "套餐用量" panel — mirrors the official Plan-usage popover. */
function buildUsageMenu() {
  const d = lastUsageData;
  let html = `<div class="pick-head usage-head">套餐用量</div>`;
  html += usageRow("5 小时限额", d.sessionPct, cnResetSession(d.sessionReset));
  html += usageRow("每周 · 全部模型", d.weekPct, cnResetWeek(d.weekReset));
  html += usageRow("仅 Sonnet", d.weekSonnetPct, "");
  usageMenu.innerHTML = html;
}
/** Anchor the popover directly above the usage pill (right edges aligned). */
function positionUsageMenu() {
  const parent = usageMenu.offsetParent as HTMLElement | null;
  if (!parent) return;
  const pill = usagePill.getBoundingClientRect();
  const pr = parent.getBoundingClientRect();
  usageMenu.style.left = "auto";
  usageMenu.style.right = `${Math.max(8, pr.right - pill.right)}px`;
  usageMenu.style.bottom = `${pr.bottom - pill.top + 6}px`;
}
usagePill.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = !usageMenu.classList.contains("hidden");
  closePickers();
  if (!open) {
    buildUsageMenu();
    usageMenu.classList.remove("hidden");
    positionUsageMenu();
    pickBackdrop.classList.remove("hidden");
    send({ type: "refreshUsage" }); // pull fresh numbers; renderUsage rebuilds the open panel
  }
});
function startTick() {
  if (tickTimer) return;
  tickTimer = window.setInterval(() => {
    const wk = assistantEl?.querySelector(".working-pill") as HTMLElement | null;
    if (!wk) {
      clearInterval(tickTimer);
      tickTimer = 0;
      return;
    }
    const elapsed = Math.round((performance.now() - Number(wk.dataset.start || performance.now())) / 1000);
    const t = wk.querySelector(".wk-time") as HTMLElement | null;
    if (t) t.textContent = `${elapsed}s`;
    // Cycle the label so the wait feels alive (Claude shows more than one state).
    if (workingRotate && !workingFixed) {
      const lbl = wk.querySelector(".wk-label") as HTMLElement | null;
      const seed = Number(wk.dataset.wseed || 0);
      if (lbl) lbl.textContent = `${THINKING_WORDS[(seed + Math.floor(elapsed / 3)) % THINKING_WORDS.length]}…`;
    }
    updateActiveLine(); // keep the active glow tracking the pill as content grows
  }, 1000);
}

/** Auto-scroll only when the user is already near the bottom. */
function maybeScroll() {
  if (pinnedToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}
messagesEl.addEventListener("scroll", () => {
  pinnedToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
});

// ---------------------------------------------------------------------------
// Incoming messages
// ---------------------------------------------------------------------------
window.addEventListener("message", (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  // After Stop, swallow the tail of the dying turn (deltas already in the pipe
  // would re-open a bubble and keep "typing"). Lifecycle events still flow.
  if (
    stoppingView &&
    (m.kind === "block_start" ||
      m.kind === "text_delta" ||
      m.kind === "thinking_delta" ||
      m.kind === "tool_input" ||
      m.kind === "tool_input_partial" ||
      m.kind === "status" ||
      m.kind === "tokens")
  ) {
    return;
  }
  switch (m.kind) {
    case "session":
      statusLine.textContent = `模型 ${m.model} · ${m.cwd}`;
      // The CLI reports the mode its process actually runs in — trust it over
      // our local guess, so the picker can never claim "Auto" while the
      // process is really asking for every permission.
      if (m.permissionMode && m.permissionMode !== currentMode) {
        currentMode = m.permissionMode;
        syncPickers();
      }
      // Persist the tab↔session binding so a window reload restores THIS tab to
      // THIS conversation (and never two tabs onto one session = two processes).
      if (m.sessionId) vscode.setState({ sessionId: m.sessionId });
      break;
    case "busy":
      setBusy(m.busy);
      break;
    case "status":
      break; // no live "思考中" status
    case "block_start":
      onBlockStart(m.blockType, m.toolId, m.toolName);
      break;
    case "text_delta":
      onTextDelta(m.text);
      break;
    case "thinking_delta":
      addStreamEst(m.text); // not displayed, but grows the live token estimate
      break;
    case "tokens":
      onTokens(m.output);
      break;
    case "context":
      updateContextGauge(m.used, m.total);
      break;
    case "refs_validated":
      for (const id of m.invalid) {
        const e = messagesEl.querySelector(`[data-ref-id="${id}"]`) as HTMLElement | null;
        if (e) unlinkRef(e);
      }
      break;
    case "tool_input":
      updateToolInput(m.toolId, m.name, m.input);
      break;
    case "tool_input_partial":
      if (m.name === "AskUserQuestion") updatePreparingQuestions(m.json);
      else updateToolPartial(m.toolId, m.name, m.json);
      break;
    case "tool_result":
      setToolResult(m.toolUseId, m.content, m.isError);
      break;
    case "permission_request":
      attachPermission(m);
      break;
    case "permission_resolved":
      resolvePermission(m.requestId, m.behavior);
      break;
    case "result":
      finalizeTurn();
      if (m.numTurns != null) {
        statusLine.textContent = `完成 · ${m.numTurns} 轮`;
      }
      break;
    case "usage":
      renderUsage(m.sessionPct, m.sessionReset, m.weekPct, m.weekReset, m.weekSonnetPct);
      break;
    case "compacting":
      compacting = true;
      ctxGauge.classList.add("compacting");
      showWorking("正在压缩上下文…");
      break;
    case "compacted":
      compacting = false;
      ctxGauge.classList.remove("compacting");
      finalizeTurn(); // clears the working pill AND the otherwise-empty assistant bubble
      messagesEl.appendChild(renderCompactionDivider(m.preTokens, m.postTokens));
      scrollToBottom();
      updateContextGauge(m.postTokens, lastCtxTotal);
      break;
    case "error":
      finalizeTurn();
      // A fatal error may arrive with no busy:false (spawn failures kill the
      // proc before it ever reports); release the composer or it's stuck forever.
      setBusy(false);
      compacting = false;
      ctxGauge.classList.remove("compacting");
      appendNotice(m.message, "error");
      break;
    case "notice":
      if (m.message) appendNotice(m.message, "info");
      break;
    case "load_history":
      loadHistory(m.items, m.title, m.checkpoints, m.sessionId);
      break;
    case "sessions":
      if (m.runningIds !== undefined) runningSessionIds = new Set(m.runningIds);
      renderSessions(m.list, m.activeId);
      break;
    case "running":
      runningSessionIds = new Set(m.sessionIds);
      renderSessions(lastSessions, lastActiveId);
      break;
    case "checkpoint_marker":
      onCheckpointMarker(m.checkpointId);
      break;
    case "config":
      currentMode = m.permissionMode || "default";
      currentModel = m.model || "";
      currentEffort = m.effort || "";
      syncPickers();
      break;
    case "context_added":
      addContextChip(m.label, m.text);
      break;
    case "active_file":
      onActiveFile(m.path);
      break;
    case "attach_files":
      for (const p of m.paths) addFile(p);
      break;
    case "changed_files":
      renderChangedFiles(m.files, m.totalAdded, m.totalRemoved);
      break;
  }
});

function onBlockStart(type: "text" | "thinking" | "tool_use", toolId?: string, toolName?: string) {
  const body = ensureAssistant();
  if (type === "tool_use" && toolId) {
    finalizeLive();
    // AskUserQuestion shows as an interactive picker built from its permission
    // request (which only arrives after the whole tool input has streamed). Keep
    // the "Thinking" pill alive until then so it doesn't look frozen — and never
    // render the raw tool card for it.
    if (toolName === "AskUserQuestion") {
      showWorking("准备选项…"); // updated live with a count as the input streams
      liveBlock = null;
      return;
    }
    removeWorking();
    createToolCard(body, toolId, toolName || "tool");
    // Non-file tools (e.g. Bash) can run a while — keep a live status pill below
    // the card so it's clearly executing, not frozen. File tools are instant.
    if (!FILE_VIEW_TOOLS.has(toolName || "")) showWorking();
    liveBlock = null;
    return;
  }
  if (type === "thinking") {
    // Thinking content isn't shown — keep a live "Thinking · Ns" pill instead.
    finalizeLive();
    liveBlock = null;
    showWorking();
    return;
  }
  finalizeLive(); // finalize previous text block with full highlighting
  removeWorking(); // text is starting — drop the "Thinking" pill
  const seg = el("div", "md text-seg");
  const committedEl = el("div", "live-committed");
  const lineEl = el("span", "live-line");
  seg.append(committedEl, lineEl);
  body.appendChild(seg);
  liveBlock = { type: "text", raw: "", shown: 0, el: seg, committedEl, lineEl, committedLen: 0 };
  maybeScroll();
}

function onTextDelta(text: string) {
  addStreamEst(text); // keep the running token estimate growing
  removeWorking();
  if (!liveBlock) onBlockStart("text");
  liveBlock!.raw += text;
  startTypewriter(); // typewriter reveal, committing each line as it completes
}

// ---------------------------------------------------------------------------
// Tool cards
// ---------------------------------------------------------------------------
// File tools render compact (no icon, no inline result/diff); click -> editor.
const FILE_VIEW_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DIFF_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function createToolCard(parent: HTMLElement, toolId: string, name: string): HTMLElement {
  if (toolCards.has(toolId)) return toolCards.get(toolId)!;
  const compact = FILE_VIEW_TOOLS.has(name);
  const card = el("div", "tool-card running" + (compact ? " compact" : ""));
  card.dataset.toolId = toolId;
  card.dataset.toolName = name;
  const head = el("div", "tool-head");
  const icon = compact ? "" : toolIcon(name);
  head.innerHTML =
    `${icon ? `<span class="tool-icon">${icon}</span>` : ""}` +
    `<span class="tool-name">${escapeHtml(name)}</span><span class="tool-why"></span><span class="tool-sub"></span>` +
    `<div class="tool-actions"></div>`;
  const bodyWrap = el("div", "tool-body");
  card.append(head, bodyWrap);
  // Wrap as a timeline step with a node dot on the left rail (green for edits).
  const step = el("div", "step" + (DIFF_TOOLS.has(name) ? " edit" : ""));
  step.append(el("div", "step-dot"), card);
  parent.appendChild(step);
  toolCards.set(toolId, card);
  updateActiveLine(); // the new dot becomes the active progress start
  maybeScroll();
  return card;
}

function updateToolInput(toolId: string, name: string, input: Record<string, unknown>) {
  if (name === "AskUserQuestion") return; // rendered as an interactive picker, not a card
  let card = toolCards.get(toolId);
  if (!card) card = createToolCard(ensureAssistant(), toolId, name);
  const sub = card.querySelector(".tool-sub") as HTMLElement;
  const bodyWrap = card.querySelector(".tool-body") as HTMLElement;
  const { subtitle, html } = renderToolInput(name, input);
  if (FILE_VIEW_TOOLS.has(name)) {
    // Read/Edit/…: filename on the SAME line as the tool name (in the header), no wrap.
    if (sub) sub.innerHTML = html;
    return;
  }
  if (sub) sub.textContent = subtitle;
  // Replace (don't stack) — a permission_request may already have rendered one.
  bodyWrap.querySelector(".tool-input")?.remove();
  const inputEl2 = el("div", "tool-input");
  inputEl2.innerHTML = html;
  // keep any existing result/permission below
  bodyWrap.prepend(inputEl2);
  // Non-file tools have a code block — put copy (+ run for Bash) in the card header.
  const actions = card.querySelector(".tool-actions") as HTMLElement | null;
  if (actions) {
    actions.innerHTML =
      (name === "Bash" ? `<button class="code-act" data-action="run" title="在终端执行">${ICON.play} 执行</button>` : "") +
      `<button class="code-act" data-action="copy" title="复制">${ICON.copy} 复制</button>`;
  }
}

/** Live update while a tool's input JSON is still streaming — show the target
 *  file and a growing line count so an Edit/Write is visible before it finishes. */
/** Live feedback while the AskUserQuestion input streams in (it can be large
 *  with many questions/options) — show how many questions/options have arrived
 *  so the wait for the picker doesn't look frozen. */
function updatePreparingQuestions(json: string) {
  const wk = assistantEl?.querySelector(".working-pill") as HTMLElement | null;
  if (!wk) return;
  const qs = (json.match(/"question"\s*:/g) || []).length;
  const opts = (json.match(/"label"\s*:/g) || []).length;
  let label = "准备选项…";
  if (qs > 0) label = `准备选项 · ${qs} 个问题` + (opts > 0 ? ` ${opts} 选项…` : "…");
  workingFixed = label;
  workingRotate = false;
  const lbl = wk.querySelector(".wk-label") as HTMLElement | null;
  if (lbl) lbl.textContent = label;
}

function updateToolPartial(toolId: string, name: string, json: string) {
  const card = toolCards.get(toolId);
  if (!card) return;
  const sub = card.querySelector(".tool-sub") as HTMLElement | null;
  if (!sub) return;
  // Tolerant extraction of the target file path (needs its closing quote).
  const fpm = /"(?:file_path|notebook_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json);
  if (!fpm) return; // path hasn't fully streamed in yet
  const fp = fpm[1].replace(/\\(["\\/])/g, "$1");
  const rel = shortPath(fp);
  // Live line count of the content being written (new_string for Edit, content for Write).
  let lines = 0;
  const key = name === "Write" ? "content" : "new_string";
  const km = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (km) {
    let body = json.slice(km.index + km[0].length).replace(/"\s*[,}]?\s*$/, "");
    lines = (body.match(/\\n/g) || []).length + 1;
  }
  const extra = lines > 0 ? ` <span class="muted">编辑 ${lines} 行…</span>` : ` <span class="muted">编辑中…</span>`;
  if (FILE_VIEW_TOOLS.has(name)) {
    const cls = DIFF_TOOLS.has(name) ? "file-chip diff-chip" : "file-chip";
    const action = DIFF_TOOLS.has(name) ? "diff" : "open";
    sub.innerHTML = `<a class="${cls}" data-action="${action}" data-path="${escapeHtml(fp)}">${escapeHtml(rel)}</a>${extra}`;
  } else {
    sub.textContent = rel;
  }
  maybeScroll();
}

/** Only the CLI's exact cancellation sentinels — a substring match ("interrupt"
 *  appears in ordinary code/output constantly) hid perfectly good results. */
function isInterruptSentinel(content: string): boolean {
  const t = content.trim();
  return (
    t === "[Request interrupted by user]" ||
    t === "[Request interrupted by user for tool use]" ||
    t.startsWith("The user doesn't want to proceed") ||
    t === "已中断。"
  );
}

function setToolResult(toolUseId: string, content: string, isError: boolean) {
  const card = toolCards.get(toolUseId);
  if (!card) return;
  card.classList.remove("running");
  // Abnormal endings: mark the node red and show WHY it stopped.
  const interrupted = isInterruptSentinel(content);
  const bad = isError || interrupted;
  card.classList.toggle("error", bad);
  card.closest(".step")?.classList.toggle("error", bad); // red timeline dot
  const why = card.querySelector(".tool-why") as HTMLElement | null;
  if (why) {
    why.classList.toggle("warn", interrupted && !isError);
    why.textContent = bad ? (interrupted ? "已中断" : "执行失败") : "";
  }
  // Interrupted: the "[Request interrupted by user]" text is shown once at the
  // end of the reply, so don't also dump it in the tool body — the badge says it.
  if (interrupted && !isError) {
    maybeScroll();
    return;
  }
  // While the model moves on to the next step, show the thinking pill again.
  if (isBusy) showWorking();
  // File tools (Read/Edit/Write/…) don't show their result body — only errors.
  if (FILE_VIEW_TOOLS.has(card.dataset.toolName || "") && !isError) {
    maybeScroll();
    return;
  }
  const bodyWrap = card.querySelector(".tool-body") as HTMLElement;
  const existing = card.querySelector(".tool-result");
  if (existing) existing.remove();
  const details = el("details", "tool-result");
  if (isError) details.setAttribute("open", "");
  const summary = el("summary", "", isError ? "错误输出" : "查看结果");
  const pre = el("pre", "tool-result-body");
  pre.textContent = truncateText(content, 8000);
  details.append(summary, pre);
  bodyWrap.appendChild(details);
  maybeScroll();
}

function renderToolInput(name: string, input: Record<string, unknown>): { subtitle: string; html: string } {
  const fp = (input.file_path || input.notebook_path || input.path) as string | undefined;
  const rel = fp ? shortPath(fp) : "";
  // Read: clickable filename that opens the file at the lines read.
  if (name === "Read") {
    if (!fp) return { subtitle: "", html: "" };
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    const start = offset ?? 1;
    const end = limit != null ? start + limit - 1 : undefined;
    const lineAttr = offset != null ? ` data-line="${start}"${end != null ? ` data-endline="${end}"` : ""}` : "";
    const rangeLabel =
      offset != null || limit != null ? ` <span class="muted line-range">lines ${start}${end != null ? "-" + end : "+"}</span>` : "";
    return {
      subtitle: "",
      html: `<a class="file-chip" data-action="open" data-path="${escapeHtml(fp)}"${lineAttr}>${escapeHtml(rel)}</a>${rangeLabel}`,
    };
  }
  // Edit/Write/MultiEdit/NotebookEdit: clickable filename -> native red/green diff. No inline diff.
  if (DIFF_TOOLS.has(name)) {
    const extra =
      name === "MultiEdit" && Array.isArray(input.edits) ? `<span class="muted">· ${(input.edits as any[]).length} 处修改</span>` : "";
    return {
      subtitle: "",
      html: fp
        ? `<a class="file-chip diff-chip" data-action="diff" data-path="${escapeHtml(fp)}" title="点击查看改动 (红=旧 / 绿=新)">${escapeHtml(rel)}</a> ${extra}`
        : "",
    };
  }
  const filechip = fp ? `<a class="file-chip" data-action="open" data-path="${escapeHtml(fp)}">${escapeHtml(rel)}</a>` : "";
  switch (name) {
    case "Bash": {
      const cmd = String(input.command ?? "");
      const desc = input.description ? `<div class="muted">${escapeHtml(String(input.description))}</div>` : "";
      // No header subtitle — the command is shown in the code block below.
      return { subtitle: "", html: `${desc}${codeBlock(cmd, "bash")}` };
    }
    case "Grep":
    case "Glob":
      return { subtitle: String(input.pattern ?? ""), html: codeBlock(JSON.stringify(input, null, 2), "json") };
    default:
      return { subtitle: fp || "", html: codeBlock(truncateText(JSON.stringify(input, null, 2), 3000), "json") };
  }
}

/** Show a workspace-relative-ish path (drop everything above the last 2 segments if very long). */
function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : p;
}

// ---------------------------------------------------------------------------
// Permission (待确认) cards
// ---------------------------------------------------------------------------
function attachPermission(m: Extract<ToWebview, { kind: "permission_request" }>) {
  if (m.toolName === "AskUserQuestion") {
    renderQuestion(m);
    return;
  }
  let host = m.toolUseId ? toolCards.get(m.toolUseId) : undefined;
  if (!host) {
    host = createToolCard(ensureAssistant(), m.toolUseId || m.requestId, m.toolName);
    updateToolInput(m.toolUseId || m.requestId, m.toolName, m.input);
  }
  host.classList.add("needs-approval");
  const bar = el("div", "perm-bar");
  bar.dataset.requestId = m.requestId;
  const label = el("div", "perm-label");
  const strong = el("b");
  strong.textContent = m.displayName || m.toolName;
  label.append(el("span", "perm-ico", "⚠"), document.createTextNode(" 需要你的确认 · "), strong);
  const actions = el("div", "perm-actions");
  const allow = el("button", "perm-allow", "允许");
  const deny = el("button", "perm-deny", "拒绝");
  allow.onclick = () => send({ type: "permission", requestId: m.requestId, behavior: "allow" });
  deny.onclick = () => send({ type: "permission", requestId: m.requestId, behavior: "deny" });
  actions.append(allow, deny);
  for (const s of m.suggestions || []) {
    const b = el("button", "perm-always", s.label);
    b.onclick = () => send({ type: "permission", requestId: m.requestId, behavior: "allow", suggestionId: s.id });
    actions.appendChild(b);
  }
  bar.append(label, actions);
  (host.querySelector(".tool-body") as HTMLElement).appendChild(bar);
  scrollToBottom();
}

/** Build an "AskUserQuestion" timeline node: a separate title + a boxed
 *  question→answer list (used both live after answering and in history). */
function askQuestionNode(pairs: [string, string][], emptyText = ""): HTMLElement {
  const card = el("div", "tool-card askq-card");
  const head = el("div", "tool-head");
  head.innerHTML = `<span class="tool-name">AskUserQuestion</span>`;
  const bodyWrap = el("div", "tool-body");
  if (pairs.length) {
    const list = el("div", "askq-summary");
    for (const [q, a] of pairs) {
      const row = el("div", "askq-row");
      row.append(el("span", "askq-q", q), el("span", "askq-a", a));
      list.appendChild(row);
    }
    bodyWrap.appendChild(list);
  } else if (emptyText) {
    bodyWrap.appendChild(el("div", "askq-skip", emptyText));
  }
  card.append(head, bodyWrap);
  const step = el("div", "step");
  step.append(el("div", "step-dot"), card);
  return step;
}

/** Render a previously-answered AskUserQuestion (from history) as a clean node,
 *  instead of the raw "Your questions have been answered: …" tool output. */
function renderAnsweredQuestion(parent: HTMLElement, result: string) {
  const pairs: [string, string][] = [...result.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g)].map((mm) => [mm[1], mm[2]]);
  parent.appendChild(askQuestionNode(pairs, pairs.length ? "" : truncateText(result, 1000)));
  maybeScroll();
}

/** Render an AskUserQuestion tool as a compact paginated option picker. */
function renderQuestion(m: Extract<ToWebview, { kind: "permission_request" }>) {
  const body = ensureAssistant();
  removeWorking();
  const questions = ((m.input as { questions?: any[] })?.questions || []) as Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
  if (!questions.length) return;

  const sel = questions.map(() => new Set<string>()); // chosen built-in labels per question
  const custom = questions.map(() => ""); // custom answer text per question
  let cur = 0;
  let done = false;

  const wrap = el("div", "askp");
  wrap.dataset.requestId = m.requestId;
  const card = el("div", "askp-card");
  const head = el("div", "askp-head");
  const qText = el("span", "askp-q");
  const xBtn = el("button", "askp-x", "×");
  xBtn.title = "跳过";
  head.append(qText, xBtn);
  const optsBox = el("div", "askp-opts");
  const foot = el("div", "askp-foot");
  const pager = el("div", "askp-pager");
  const prev = el("button", "askp-nav", "‹") as HTMLButtonElement;
  const next = el("button", "askp-nav", "›") as HTMLButtonElement;
  const idx = el("span", "askp-idx");
  pager.append(prev, idx, next);
  const submit = el("button", "askp-submit", "提交") as HTMLButtonElement;
  foot.append(pager, submit);
  card.append(head, optsBox, foot);
  wrap.append(card);

  const answered = (qi: number) => sel[qi].size > 0 || custom[qi].trim().length > 0;
  const updateFoot = () => {
    const multi = questions.length > 1;
    pager.style.display = multi ? "" : "none";
    idx.textContent = `${cur + 1}/${questions.length}`;
    prev.disabled = cur === 0;
    next.disabled = cur === questions.length - 1;
    submit.disabled = !questions.every((_, qi) => answered(qi));
  };

  function paint() {
    const q = questions[cur];
    qText.textContent = q.question || "";
    optsBox.innerHTML = "";
    const opts = q.options || [];
    const rows: HTMLElement[] = [];
    opts.forEach((o, i) => {
      const row = el("button", "askp-opt" + (q.multiSelect ? " multi" : ""));
      if (sel[cur].has(o.label)) row.classList.add("on");
      row.append(el("span", "askp-n", String(i + 1)));
      if (q.multiSelect) row.append(el("span", "askp-box")); // checkbox for multi-select
      const txt = el("span", "askp-txt");
      txt.append(el("span", "askp-lbl", String(o.label)));
      if (o.description) txt.append(el("span", "askp-desc", String(o.description)));
      row.append(txt);
      if (!q.multiSelect) row.append(el("span", "askp-check", "✓")); // right ✓ for single-select
      row.onclick = () => {
        if (q.multiSelect) {
          if (sel[cur].has(o.label)) {
            sel[cur].delete(o.label);
            row.classList.remove("on");
          } else {
            sel[cur].add(o.label);
            row.classList.add("on");
          }
          updateFoot();
        } else {
          sel[cur].clear();
          sel[cur].add(o.label);
          custom[cur] = "";
          rows.forEach((r) => r.classList.remove("on"));
          row.classList.add("on");
          customInput.value = "";
          customRow.classList.remove("on");
          updateFoot();
          // Single-select: auto-advance to the next question after a brief beat
          // (so the ✓ feedback is visible). Last question stays for manual submit.
          const from = cur;
          if (from < questions.length - 1) {
            setTimeout(() => {
              if (!done && cur === from) {
                cur = from + 1;
                paint();
              }
            }, 320);
          }
        }
      };
      rows.push(row);
      optsBox.append(row);
    });

    const customRow = el("div", "askp-opt askp-custom");
    customRow.append(el("span", "askp-n", String(opts.length + 1)));
    const customInput = el("input", "askp-input") as HTMLInputElement;
    customInput.type = "text";
    customInput.placeholder = "输入自定义答案";
    customInput.value = custom[cur];
    if (custom[cur].trim()) customRow.classList.add("on");
    customInput.oninput = () => {
      custom[cur] = customInput.value;
      if (!q.multiSelect && customInput.value.trim()) {
        sel[cur].clear();
        rows.forEach((r) => r.classList.remove("on"));
      }
      customRow.classList.toggle("on", customInput.value.trim().length > 0);
      updateFoot();
    };
    customRow.append(customInput);
    optsBox.append(customRow);
    updateFoot();
  }

  const finish = (answers: Record<string, string | string[]> | null) => {
    if (done) return;
    done = true;
    if (answers) {
      const pairs = questions
        .map((q): [string, string] => {
          const v = answers[q.question];
          return [q.header || q.question, Array.isArray(v) ? v.join("、") : v || ""];
        })
        .filter(([, a]) => a);
      wrap.replaceWith(askQuestionNode(pairs));
    } else {
      wrap.replaceWith(askQuestionNode([], "已跳过"));
    }
  };

  prev.onclick = () => {
    if (cur > 0) {
      cur--;
      paint();
    }
  };
  next.onclick = () => {
    if (cur < questions.length - 1) {
      cur++;
      paint();
    }
  };
  submit.onclick = () => {
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, qi) => {
      const picks = [...sel[qi]];
      if (custom[qi].trim()) picks.push(custom[qi].trim());
      answers[q.question] = q.multiSelect ? picks : picks[0] || "";
    });
    send({ type: "answerQuestion", requestId: m.requestId, answers });
    finish(answers);
  };
  xBtn.onclick = () => {
    send({ type: "answerQuestion", requestId: m.requestId, answers: {} });
    finish(null);
  };

  paint();
  body.append(wrap);
  scrollToBottom();
}

function resolvePermission(requestId: string, behavior: "allow" | "deny") {
  const bar = messagesEl.querySelector(`.perm-bar[data-request-id="${requestId}"]`) as HTMLElement;
  if (!bar) return;
  bar.closest(".tool-card")?.classList.remove("needs-approval");
  if (behavior === "allow") {
    bar.remove(); // authorized — just proceed, no result shown
  } else {
    bar.classList.add("resolved");
    bar.innerHTML = `<span class="perm-label deny">已拒绝</span>`;
  }
}

// ---------------------------------------------------------------------------
// History / sessions / checkpoints
// ---------------------------------------------------------------------------
const HISTORY_TURN_LIMIT = 3; // only the last N turns render by default; older folds behind a banner
let historyState: { items: TimelineItem[]; checkpoints: { id: string; label: string }[] } | null = null;

function loadHistory(items: TimelineItem[], title?: string, checkpoints?: { id: string; label: string }[], sessionId?: string) {
  historyState = { items, checkpoints: checkpoints || [] };
  if (sessionId) vscode.setState({ sessionId });
  renderHistory(false);
}

function renderHistory(showAll: boolean) {
  if (!historyState) return;
  const { items, checkpoints } = historyState;
  messagesEl.innerHTML = "";
  toolCards.clear();
  railObservers.forEach((o) => o.disconnect()); // per-message rail observers of removed nodes
  railObservers.length = 0;
  assistantEl = null;
  liveBlock = null;
  lastUserEl = null;
  userMsgCount = 0;
  ctxGauge.classList.add("hidden"); // refreshes from the next turn's usage

  // Align checkpoints to the trailing user messages (tracking may start
  // mid-session, and after a rewind there may be MORE checkpoints than turns —
  // then the oldest checkpoints must drop, not shift onto the wrong messages).
  const userTotal = items.filter((i) => i.type === "user").length;
  const cpByOrdinal = new Map<number, { id: string }>();
  checkpoints.forEach((c, j) => {
    const ordinal = userTotal - checkpoints.length + j;
    if (ordinal >= 0) cpByOrdinal.set(ordinal, c);
  });

  // Fold everything before the last HISTORY_TURN_LIMIT turns behind a banner.
  // IMPORTANT: everything is RENDERED (hidden with CSS) — re-rendering from
  // historyState on expand used to wipe all live messages sent since load.
  let cutoff = 0;
  if (!showAll && userTotal > HISTORY_TURN_LIMIT) {
    const target = userTotal - HISTORY_TURN_LIMIT; // fold this many user turns
    let seen = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type === "user") {
        if (seen === target) {
          cutoff = i;
          break;
        }
        seen++;
      }
    }
    const banner = el("div", "history-expand", `▾ 显示更早的 ${target} 条消息`);
    banner.onclick = () => {
      Array.from(messagesEl.querySelectorAll(".history-folded")).forEach((n) => n.classList.remove("history-folded"));
      banner.remove();
    };
    messagesEl.appendChild(banner);
  }

  // Elements appended while i < cutoff get folded after the loop.
  const foldBoundary = () => messagesEl.children.length;
  let foldEnd = 0;

  let userOrdinal = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type === "user") userOrdinal++;
    if (cutoff && i === cutoff) {
      finalizeTurn(); // close the folded portion's last assistant bubble
      foldEnd = foldBoundary();
    }
    if (it.type === "user") {
      finalizeTurn();
      const cp = cpByOrdinal.get(userOrdinal);
      if (cp && userOrdinal > 0) messagesEl.appendChild(renderCheckpointDivider(cp.id)); // no divider above the very first message
      const m = appendUser(it.text, it.files || [], it.images || []);
      if (cp) m.dataset.checkpointId = cp.id; // link message -> checkpoint (for edit)
    } else if (it.type === "image") {
      const body = ensureAssistant();
      const grid = el("div", "msg-images");
      grid.appendChild(makeThumb(it.src));
      body.appendChild(grid);
    } else if (it.type === "assistant_text") {
      const body = ensureAssistant();
      const seg = el("div", "md text-seg");
      seg.innerHTML = mdFull.render(foldLeakedToolXml(it.text));
      linkifyRefs(seg);
      body.appendChild(seg);
    } else if (it.type === "thinking") {
      // thinking is not displayed
    } else if (it.type === "compaction") {
      finalizeTurn();
      messagesEl.appendChild(renderCompactionDivider(it.preTokens, it.postTokens));
    } else if (it.type === "tool") {
      if (it.name === "AskUserQuestion") {
        // Show the answered question as a clean titled card (not the raw output).
        renderAnsweredQuestion(ensureAssistant(), typeof it.result === "string" ? it.result : "");
        continue;
      }
      const body = ensureAssistant();
      createToolCard(body, it.toolId, it.name);
      if (it.input) updateToolInput(it.toolId, it.name, it.input);
      if (it.result != null) setToolResult(it.toolId, it.result, !!it.isError);
    }
  }
  finalizeTurn();
  // Hide the folded portion (children after the banner, before foldEnd).
  if (cutoff && foldEnd > 1) {
    const kids = Array.from(messagesEl.children);
    for (let k = 1; k < foldEnd; k++) kids[k]?.classList.add("history-folded");
  }
  updateEmptyState();
  scrollToBottom();
}

/** Show a branded placeholder when the conversation is empty (new session). */
function updateEmptyState() {
  if (messagesEl.querySelector(".msg")) {
    messagesEl.querySelector(".empty-state")?.remove();
    return;
  }
  if (messagesEl.querySelector(".empty-state")) return;
  const es = el("div", "empty-state");
  es.innerHTML =
    `<div class="es-logo">${SUNBURST}</div>` +
    `<div class="es-title">ClaudeCopilot</div>` +
    `<div class="es-sub">问我任何关于这个项目的问题。<br>在根目录放一个 <code>CLAUDE.md</code>，每次对话都会自动读取它作为项目说明。</div>`;
  messagesEl.appendChild(es);
}

// -- Clickable code references in assistant text ------------------------------
// Turn file-path mentions (e.g. `src/foo.ts:42`) into links that jump to the
// file (and line) in the editor, reusing the messages' data-action="open" path.
const CODE_EXT = new Set([
  "ts","tsx","js","jsx","mjs","cjs","vue","svelte","java","kt","kts","py","go","rs","rb","php","cs",
  "cpp","cc","cxx","c","h","hpp","hh","m","mm","swift","scala","dart","lua","r","sh","bash","zsh",
  "html","htm","css","scss","sass","less","json","jsonc","xml","yaml","yml","toml","ini","env",
  "properties","gradle","sql","md","mdx","txt","proto","tf","vy","sol",
]);

function parseCodeRef(s: string): { path: string; line?: number; endLine?: number } | null {
  const t = s.trim();
  const m = /^([~\w./\\@\-+]+\.[A-Za-z0-9]{1,10})(?::(\d+)(?:[:-](\d+))?)?$/.exec(t);
  if (!m) return null;
  const ext = (m[1].split(".").pop() || "").toLowerCase();
  if (!CODE_EXT.has(ext)) return null;
  return {
    path: m[1],
    line: m[2] ? parseInt(m[2], 10) : undefined,
    endLine: m[3] ? parseInt(m[3], 10) : undefined,
  };
}

const REF_RE =
  /(?:[~\w.\-@+]+[/\\])+[\w.\-@+]*\.[A-Za-z0-9]{1,10}(?::\d+(?:[:-]\d+)?)?|[\w.\-@+]+\.[A-Za-z0-9]{1,10}:\d+(?:[:-]\d+)?/g;

function makeRef(text: string, ref: { path: string; line?: number; endLine?: number }): HTMLElement {
  const span = document.createElement("span");
  span.className = "code-ref";
  span.dataset.action = "open";
  span.dataset.path = ref.path;
  if (ref.line) span.dataset.line = String(ref.line);
  if (ref.endLine) span.dataset.endline = String(ref.endLine);
  span.textContent = text;
  span.title = "打开 " + ref.path + (ref.line ? `:${ref.line}` : "");
  return span;
}

// Common keywords / JDK types we don't want to turn into "go to symbol" links.
const SYM_STOP = new Set([
  "String","Integer","Long","Double","Float","Boolean","Object","Number","Character","Byte","Short",
  "List","Map","Set","Collection","Optional","Exception","RuntimeException","Throwable","System",
  "Override","Deprecated","NotNull","Nullable","Autowired","Resource","Override","Math","Arrays",
  "Collections","Objects","Thread","Runnable","Comparable","Iterable","Class","Void","TODO","FIXME",
]);

/** A single CamelCase/PascalCase identifier looks like a jump-able symbol. */
function symbolName(s: string): string | null {
  const t = s.trim();
  if (!/^@?[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) return null;
  const id = t.replace(/^@/, "");
  if (id.length < 3 || !/[A-Z]/.test(id) || SYM_STOP.has(id)) return null; // skip keywords/vars like log, null, int
  return id;
}

/** Make file references inside rendered assistant markdown clickable. */
function linkifyRefs(container: HTMLElement) {
  // 1) Inline code spans: a file path -> open file; a symbol -> go to definition.
  container.querySelectorAll("code").forEach((code) => {
    if (code.closest("pre") || code.children.length) return;
    const txt = code.textContent || "";
    const ref = parseCodeRef(txt);
    if (ref) {
      code.classList.add("code-ref");
      code.setAttribute("data-action", "open");
      code.setAttribute("data-path", ref.path);
      if (ref.line) code.setAttribute("data-line", String(ref.line));
      if (ref.endLine) code.setAttribute("data-endline", String(ref.endLine));
      (code as HTMLElement).title = "打开 " + ref.path + (ref.line ? `:${ref.line}` : "");
      return;
    }
    const sym = symbolName(txt);
    if (sym) {
      code.classList.add("code-ref");
      code.setAttribute("data-action", "symbol");
      code.setAttribute("data-symbol", sym);
      (code as HTMLElement).title = "跳转到定义：" + sym;
    }
  });
  // 2) Bare path mentions in plain prose (must have a / separator or :line).
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || p.closest("a, code, pre, .code-ref")) return NodeFilter.FILTER_REJECT;
      REF_RE.lastIndex = 0;
      return REF_RE.test(n.nodeValue || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) targets.push(node as Text);
  for (const tn of targets) {
    const text = tn.nodeValue || "";
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(text))) {
      const ref = parseCodeRef(m[0]);
      if (!ref) continue; // matched something path-like but not a known code file
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(makeRef(m[0], ref));
      last = m.index + m[0].length;
    }
    if (!frag.childNodes.length) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    tn.replaceWith(frag);
  }
  // 3) Verify file refs actually exist — non-existent ones get unlinked so we
  //    don't show dead "jump to file" links.
  const fileRefs = container.querySelectorAll<HTMLElement>('.code-ref[data-action="open"]:not([data-ref-id])');
  if (fileRefs.length) {
    const refs: { id: string; path: string }[] = [];
    fileRefs.forEach((e) => {
      const id = "ref" + refSeq++;
      e.dataset.refId = id;
      refs.push({ id, path: e.dataset.path || "" });
    });
    send({ type: "validateRefs", refs });
  }
}

let refSeq = 0;
/** Strip the clickable-link affordance from a ref element (keeps plain text/code). */
function unlinkRef(e: HTMLElement) {
  e.classList.remove("code-ref");
  for (const a of ["action", "path", "line", "endline", "symbol", "refId"]) delete e.dataset[a];
  e.removeAttribute("title");
}

function renderChangedFiles(
  files: { path: string; rel: string; added: number; removed: number; status: "added" | "modified" | "deleted" }[],
  totalAdded: number,
  totalRemoved: number,
) {
  if (!files.length) {
    changedFiles.classList.add("hidden");
    cfList.innerHTML = "";
    return;
  }
  changedFiles.classList.remove("hidden");
  cfStat.innerHTML =
    `<button class="cf-all accept" data-cf="acceptAll" title="同意全部改动（保留）">✓ 全部</button>` +
    `<button class="cf-all revert" data-cf="revertAll" title="回滚全部改动">↩ 全部</button>`;
  cfList.innerHTML = "";
  for (const f of files) {
    const row = el("div", "cf-row");
    const badge = el("span", `cf-badge ${f.status}`, f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M");
    const slash = f.rel.lastIndexOf("/");
    const name = el("span", "cf-name", slash >= 0 ? f.rel.slice(slash + 1) : f.rel);
    const dir = el("span", "cf-dir", slash >= 0 ? f.rel.slice(0, slash) : "");
    const stat = el("span", "cf-rowstat");
    stat.innerHTML = `<span class="add">+${f.added}</span> <span class="del">-${f.removed}</span>`;
    const acc = el("button", "cf-act accept", "✓");
    acc.title = "同意（保留改动）";
    acc.onclick = (e) => {
      e.stopPropagation();
      send({ type: "acceptFile", path: f.path });
    };
    const rev = el("button", "cf-act revert", "↩");
    rev.title = "回滚（恢复改动前）";
    rev.onclick = (e) => {
      e.stopPropagation();
      send({ type: "revertFile", path: f.path });
    };
    row.append(badge, name, dir, stat, acc, rev);
    row.title = `${f.rel} — 点击查看改动`;
    row.onclick = () => send({ type: "openDiff", path: f.path });
    cfList.appendChild(row);
  }
}

type SessionItem = { id: string; title: string; updatedAt: number; messageCount: number };
let lastSessions: SessionItem[] = [];
let lastActiveId: string | undefined;
let runningSessionIds = new Set<string>(); // sessions whose turn is currently streaming
let multiSelect = false;
const selectedSessions = new Set<string>();

function renderSessions(list: SessionItem[], activeId?: string) {
  lastSessions = list;
  lastActiveId = activeId;
  // drop selections for sessions that no longer exist
  const ids = new Set(list.map((s) => s.id));
  for (const id of [...selectedSessions]) if (!ids.has(id)) selectedSessions.delete(id);

  sessionsList.innerHTML = "";
  if (!list.length) {
    sessionsList.appendChild(el("div", "empty", "还没有历史会话"));
  }
  for (const s of list) {
    const row = el("div", "list-row" + (s.id === activeId ? " active" : "") + (selectedSessions.has(s.id) ? " selected" : ""));
    if (multiSelect) {
      const cb = el("span", "list-check" + (selectedSessions.has(s.id) ? " on" : ""));
      row.appendChild(cb);
    }
    const main = el("div", "list-main");
    const titleRow = el("div", "list-titlerow");
    if (runningSessionIds.has(s.id)) {
      const dot = el("span", "run-dot");
      dot.title = "正在回复中";
      titleRow.appendChild(dot);
    }
    const titleEl = el("div", "list-title", s.title);
    titleRow.appendChild(titleEl);
    main.append(titleRow, el("div", "list-meta", `${new Date(s.updatedAt).toLocaleString()} · ${s.messageCount} 条`));
    row.appendChild(main);
    // Inline actions: edit (left) then delete (right). No right-click menu.
    const actions = el("div", "list-actions");
    const editBtn = el("button", "list-act");
    editBtn.title = "重命名";
    editBtn.innerHTML = ICON.edit;
    editBtn.onclick = (e) => { e.stopPropagation(); startRenameSession(titleEl, s.id, s.title); };
    const delBtn = el("button", "list-act danger");
    delBtn.title = "删除";
    delBtn.innerHTML = ICON.trash;
    delBtn.onclick = (e) => { e.stopPropagation(); send({ type: "deleteSession", sessionId: s.id }); };
    actions.append(editBtn, delBtn);
    row.appendChild(actions);
    row.onclick = () => {
      if (multiSelect) {
        if (selectedSessions.has(s.id)) selectedSessions.delete(s.id);
        else selectedSessions.add(s.id);
        renderSessions(lastSessions, lastActiveId);
      } else {
        send({ type: "switchSession", sessionId: s.id });
        closeDrawers();
      }
    };
    sessionsList.appendChild(row);
  }
  updateSessionTools();
}

/** Inline-edit a session title: swap the title div for an input. Enter / blur
 *  commits (empty reverts to the auto title); Esc cancels. */
function startRenameSession(titleEl: HTMLElement, id: string, current: string) {
  const input = el("input", "rename-input") as HTMLInputElement;
  input.value = current;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) send({ type: "renameSession", sessionId: id, title: input.value.trim() });
    renderSessions(lastSessions, lastActiveId); // restore/refresh (server echo re-renders on save)
  };
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  };
  input.onblur = () => commit(true);
}

function updateSessionTools() {
  const multiBtn = $("sessions-multi");
  const delBtn = $("sessions-del-sel") as HTMLButtonElement;
  multiBtn.textContent = multiSelect ? "取消多选" : "多选";
  multiBtn.classList.toggle("on", multiSelect);
  delBtn.textContent = `删除所选 (${selectedSessions.size})`;
  delBtn.classList.toggle("hidden", !multiSelect || selectedSessions.size === 0);
}

$("sessions-multi").onclick = () => {
  multiSelect = !multiSelect;
  if (!multiSelect) selectedSessions.clear();
  renderSessions(lastSessions, lastActiveId);
};
$("sessions-del-sel").onclick = () => {
  if (selectedSessions.size) send({ type: "deleteSessions", sessionIds: [...selectedSessions] });
};

// ---- lightweight right-click menu ----
const ctxMenu = $("ctx-menu");
function showCtxMenu(x: number, y: number, items: { label: string; danger?: boolean; run: () => void }[]) {
  ctxMenu.innerHTML = "";
  for (const it of items) {
    const b = el("button", "ctx-item" + (it.danger ? " danger" : ""), it.label);
    b.onclick = () => {
      hideCtxMenu();
      it.run();
    };
    ctxMenu.appendChild(b);
  }
  ctxMenu.style.left = Math.min(x, window.innerWidth - 160) + "px";
  ctxMenu.style.top = Math.min(y, window.innerHeight - 60) + "px";
  ctxMenu.classList.remove("hidden");
}
function hideCtxMenu() {
  ctxMenu.classList.add("hidden");
}
document.addEventListener("click", hideCtxMenu);
document.addEventListener("scroll", hideCtxMenu, true);

// ---------------------------------------------------------------------------
// Inline restore points (checkpoint dividers in the conversation stream)
// ---------------------------------------------------------------------------
function renderCheckpointDivider(checkpointId: string): HTMLElement {
  const d = el("div", "checkpoint-divider");
  d.dataset.checkpointId = checkpointId;
  // A single, always-present control — hovering only restyles it (no extra
  // element appears), so the row never reflows / flickers.
  const btn = el("button", "cp-restore");
  btn.append(el("span", "cp-icon", "⑂"), document.createTextNode(" 还原到此处"));
  btn.title = "还原到此检查点（恢复改动前）";
  // Confirmation is shown by the extension (native modal); we just request it.
  btn.onclick = () => send({ type: "restoreCheckpoint", checkpointId });
  d.append(btn);
  return d;
}

/** A divider marking where the conversation was compacted (/compact). */
function renderCompactionDivider(preTokens: number, postTokens: number): HTMLElement {
  const d = el("div", "compaction-divider");
  const saved = preTokens > 0 ? `${fmtTokens(preTokens)} → ${fmtTokens(postTokens)}` : "";
  d.append(el("span", "cp-icon", "⟱"), document.createTextNode(saved ? ` 上下文已压缩 ${saved}` : " 上下文已压缩"));
  return d;
}

/** Live: a restore point was created for the turn just sent. */
function onCheckpointMarker(checkpointId: string) {
  if (lastUserEl) lastUserEl.dataset.checkpointId = checkpointId; // link message -> its checkpoint (for edit)
  if (userMsgCount <= 1 || !lastUserEl) return; // no divider above the very first message
  messagesEl.insertBefore(renderCheckpointDivider(checkpointId), lastUserEl);
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
interface QueueItem {
  text: string;
  context?: string;
  images: { mediaType: string; data: string }[];
  files: string[];
  labels: string[];
  imageUris: string[];
}
const taskQueue: QueueItem[] = [];
const taskQueueEl = $("task-queue");

/** Snapshot the composer into a sendable payload (null if nothing to send). */
function readComposer(): QueueItem | null {
  const text = inputEl.value.trim();
  if (!text && !pendingImages.length) return null;
  return {
    text,
    context: pendingContexts.map((c) => c.text).join("\n\n") || undefined,
    images: pendingImages.map((p) => ({ mediaType: p.mediaType, data: p.data })),
    files: attachedFiles.map((f) => f.path),
    labels: [...pendingContexts.map((c) => c.label), ...attachedFiles.map((f) => baseName(f.path))],
    imageUris: pendingImages.map((p) => p.uri),
  };
}

function clearComposer() {
  inputEl.value = "";
  autoResize();
  clearContextChips();
  pendingImages.length = 0;
  imagePreviews.innerHTML = "";
  // Staged attachments are consumed by the message; keep only the default current file.
  attachedFiles = [];
  // NOTE: autoDismissed is deliberately NOT reset here — if the user removed
  // the auto-attached file chip, sending must not silently re-attach it.
  // It re-arms only when the active file changes (onActiveFile) or the user
  // re-adds the file manually (addFile).
  onActiveFile(autoPath);
  refreshComposerHint();
}

function doSend() {
  const payload = readComposer();
  if (!payload) return;
  clearComposer();
  if (isBusy) {
    // A turn is running — queue this one to auto-run after the current finishes.
    taskQueue.push(payload);
    renderQueue();
    return;
  }
  performSend(payload);
}

/** Actually start a turn from a payload (used for live sends and queued ones). */
function performSend(p: QueueItem) {
  queuePaused = false; // a manual send re-arms the queue after a Stop
  stoppingView = false;
  appendUser(p.text, p.labels, p.imageUris);
  finalizeTurn();
  turnTokens = 0; // reset token counters for the new turn
  turnEst = 0;
  msgTokenBase = 0;
  lastMsgTokens = 0;
  isBusy = true;
  refreshComposerHint(); // show the Stop button immediately (don't wait for the busy event)
  showWorking(); // instant feedback (the busy event confirms it a moment later)
  if (assistantEl) assistantEl.classList.add("streaming-turn");
  send({
    type: "send",
    text: p.text,
    context: p.context,
    images: p.images.length ? p.images : undefined,
    files: p.files.length ? p.files : undefined,
  });
}

/** When the current turn ends, auto-run the next queued task (if any). */
function flushQueue() {
  // Stop means STOP: don't auto-launch the next queued prompt 150ms after the
  // user halted the current one. The queue resumes on their next manual send.
  if (queuePaused || isBusy || !taskQueue.length) return;
  const next = taskQueue.shift()!;
  renderQueue();
  performSend(next);
}
let queuePaused = false;

function renderQueue() {
  if (!taskQueue.length) {
    taskQueueEl.classList.add("hidden");
    taskQueueEl.innerHTML = "";
    return;
  }
  taskQueueEl.classList.remove("hidden");
  taskQueueEl.innerHTML = "";
  const head = el("div", "tq-head", `排队中 · ${taskQueue.length}`);
  taskQueueEl.appendChild(head);
  taskQueue.forEach((item, i) => {
    const row = el("div", "tq-row");
    row.append(el("span", "tq-idx", String(i + 1)));
    const txt = el("span", "tq-text", item.text || "(图片)");
    row.appendChild(txt);
    if (item.labels.length) row.appendChild(el("span", "tq-chips", item.labels.join(" · ")));
    const del = el("button", "tq-del", "×");
    del.title = "从队列移除";
    del.onclick = () => {
      taskQueue.splice(i, 1);
      renderQueue();
    };
    row.appendChild(del);
    taskQueueEl.appendChild(row);
  });
}

sendBtn.onclick = doSend;
let userStopped = false; // user hit Stop — append an interrupted marker on finalize
stopBtn.onclick = () => {
  userStopped = true;
  queuePaused = true; // halt the queue too — Stop shouldn't auto-fire the next task
  // Drop everything still in flight for this turn: deltas buffered in the pipe
  // (or a slow interrupt) would otherwise keep "typing" after the button
  // already flipped — the classic "stopped but still replying" bug.
  stoppingView = true;
  if (liveBlock) liveBlock.raw = liveBlock.raw.slice(0, liveBlock.shown); // freeze the typewriter tail
  send({ type: "interrupt" });
  // Optimistic: react to the click itself with zero latency. The host confirms
  // with a busy:false, and the final `result` appends the interrupted marker.
  isBusy = false;
  refreshComposerHint();
  removeWorking();
};
/** True from Stop-click until the next turn starts: render nothing new. */
let stoppingView = false;
inputEl.addEventListener("keydown", (e) => {
  // Ignore Enter while an IME composition is active (e.g. confirming a pinyin
  // candidate) — `isComposing`/keyCode 229 means it's not a real "send".
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (e as KeyboardEvent).keyCode !== 229) {
    e.preventDefault();
    doSend();
  }
});
inputEl.addEventListener("input", () => {
  autoResize();
  refreshComposerHint();
});

/** While a turn is running, hint that typing + Enter queues the message; also
 *  toggle send/stop buttons accordingly. */
function refreshComposerHint() {
  const hasContent = inputEl.value.trim().length > 0 || pendingImages.length > 0;
  if (isBusy) {
    stopBtn.classList.remove("hidden");
    sendBtn.classList.toggle("hidden", !hasContent); // clickable "add to queue" when there's content
    sendBtn.title = "加入等待队列";
    inputEl.placeholder = PLACEHOLDER_BUSY;
    queueHint.classList.toggle("hidden", !hasContent);
  } else {
    sendBtn.classList.remove("hidden");
    sendBtn.title = "发送";
    stopBtn.classList.add("hidden");
    inputEl.placeholder = PLACEHOLDER_IDLE;
    queueHint.classList.add("hidden");
  }
}
function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}

// Paste an image into the composer to attach it.
inputEl.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type.startsWith("image/")) {
      const file = it.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const uri = String(reader.result);
        const m = /^data:([^;]+);base64,(.*)$/.exec(uri);
        if (m) {
          pendingImages.push({ mediaType: m[1], data: m[2], uri });
          addImagePreview(uri);
          refreshComposerHint(); // an image alone should enable send/queue
        }
      };
      reader.readAsDataURL(file);
    }
  }
});

function addImagePreview(uri: string) {
  const wrap = el("div", "img-preview");
  const img = el("img") as HTMLImageElement;
  img.src = uri;
  img.onclick = () => openLightbox(uri);
  const x = el("button", "img-preview-x", "×");
  x.onclick = () => {
    const idx = pendingImages.findIndex((p) => p.uri === uri);
    if (idx >= 0) pendingImages.splice(idx, 1);
    wrap.remove();
    refreshComposerHint();
  };
  wrap.append(img, x);
  imagePreviews.appendChild(wrap);
}

// Lightbox (click any chat image to view full size; copy/save from the toolbar)
function openLightbox(src: string) {
  lightboxImg.src = src;
  lightbox.classList.remove("hidden");
}
function closeLightbox() {
  lightbox.classList.add("hidden");
  lightboxImg.src = "";
}
lightbox.onclick = closeLightbox; // click outside the image closes
lightboxImg.onclick = (e) => e.stopPropagation(); // clicking the image itself doesn't
$("lb-close").onclick = (e) => {
  e.stopPropagation();
  closeLightbox();
};
$("lb-save").onclick = (e) => {
  e.stopPropagation();
  if (lightboxImg.src) send({ type: "saveImage", dataUri: lightboxImg.src });
};
$<HTMLButtonElement>("lb-copy").onclick = async (e) => {
  e.stopPropagation();
  const btn = $("lb-copy");
  const src = lightboxImg.src;
  if (!src) return;
  try {
    // Clipboard only takes PNG — round-trip through a canvas (also normalizes jpeg/webp).
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("load"));
      img.src = src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("blob");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    const old = btn.textContent;
    btn.textContent = "已复制 ✓";
    setTimeout(() => (btn.innerHTML = `${ICON.copy} 复制`), 1200);
    void old;
  } catch {
    btn.textContent = "复制失败，请用「保存」";
    setTimeout(() => (btn.innerHTML = `${ICON.copy} 复制`), 2000);
  }
};

// ---- Attached files (active editor file + drag-and-drop from the explorer) ----
let attachedFiles: { path: string; auto: boolean }[] = [];
let autoPath: string | null = null;
let autoDismissed = false;

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function onActiveFile(p: string | null) {
  if (p !== autoPath) autoDismissed = false; // switched files -> allow auto again
  autoPath = p;
  attachedFiles = attachedFiles.filter((f) => !f.auto);
  if (p && !autoDismissed && !attachedFiles.some((f) => f.path === p)) {
    attachedFiles.unshift({ path: p, auto: true });
  }
  renderFileChips();
}

function addFile(p: string) {
  if (!p) return;
  if (p === autoPath) autoDismissed = false;
  if (!attachedFiles.some((f) => f.path === p)) attachedFiles.push({ path: p, auto: false });
  renderFileChips();
}

function removeFile(p: string) {
  const f = attachedFiles.find((x) => x.path === p);
  if (f?.auto) autoDismissed = true;
  attachedFiles = attachedFiles.filter((x) => x.path !== p);
  renderFileChips();
}

function renderFileChips() {
  fileChips.innerHTML = "";
  for (const f of attachedFiles) {
    const chip = el("span", "file-attach" + (f.auto ? " auto" : ""));
    const name = el("span", "fa-name", baseName(f.path) || f.path);
    name.title = f.path + (f.auto ? "（当前文件）" : "");
    name.onclick = () => send({ type: "openFile", path: f.path });
    const x = el("button", "fa-x", "×");
    x.onclick = (e) => {
      e.stopPropagation();
      removeFile(f.path);
    };
    const ico = el("span", "fa-ico");
    ico.innerHTML = ICON.file;
    chip.append(ico, name, x);
    fileChips.appendChild(chip);
  }
}

// Drag files / folders from the VS Code explorer anywhere onto the chat.
// Capture on the whole window (capture phase) and preventDefault so VS Code
// can't run its default "open the dropped file" action.
const dropZone = $("composer");
const allowDrop = (e: DragEvent) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  dropZone.classList.add("drag-over");
};
window.addEventListener("dragenter", allowDrop, true);
window.addEventListener("dragover", allowDrop, true);
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) dropZone.classList.remove("drag-over");
}, true);
window.addEventListener(
  "drop",
  (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("drag-over");
    const dt = e.dataTransfer;
    if (!dt) return;
    const raw =
      dt.getData("application/vnd.code.uri-list") || dt.getData("text/uri-list") || dt.getData("text/plain") || "";
    for (const line of raw.split(/[\r\n]+/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      try {
        const u = new URL(s);
        if (u.protocol === "file:") addFile(decodeURIComponent(u.pathname));
      } catch {
        if (s.startsWith("/")) addFile(s);
      }
    }
  },
  true,
);

// ---- Mode / model / effort pickers (popup menus, like Claude's UI) ----------
const SVG = (p: string) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  default: SVG('<path d="M8 1.8 13 3.6V7.2c0 3-2 5.2-5 6.2-3-1-5-3.2-5-6.2V3.6z"/>'), // shield (asks first)
  acceptEdits: SVG('<path d="M3 13l1-3 6.5-6.5 2 2L6 12z"/><path d="M9.5 4l2 2"/>'), // pencil
  plan: SVG('<rect x="3.5" y="2" width="9" height="12" rx="1"/><path d="M5.8 5.5h4.4M5.8 8h4.4M5.8 10.5h2.6"/>'), // plan/list
  auto: SVG('<path d="M8.6 1.6 4 9h3.2l-.6 5.4L12 6.6H8.2z"/>'), // zap (auto)
};
const MODES = [
  { id: "default", icon: ICONS.default, title: "发送前确认", desc: "每次编辑前 Claude 都会请求你确认" },
  { id: "acceptEdits", icon: ICONS.acceptEdits, title: "自动编辑", desc: "Claude 直接编辑文件，无需逐个确认" },
  { id: "plan", icon: ICONS.plan, title: "规划模式", desc: "先探索代码并给出方案，再开始编辑" },
  { id: "auto", icon: ICONS.auto, title: "Auto 模式", desc: "自动为每个任务选择最合适的权限模式" },
];
const MODELS = [
  { id: "", label: "默认模型", short: "默认", desc: "使用 CLI 默认模型" },
  { id: "opus", label: "Claude Opus 4.8", short: "Opus", desc: "最强 · 复杂任务" },
  { id: "sonnet", label: "Claude Sonnet 4.6", short: "Sonnet", desc: "均衡 · 日常编码" },
  { id: "haiku", label: "Claude Haiku 4.5", short: "Haiku", desc: "最快 · 轻量任务" },
  { id: "fable", label: "Fable 5", short: "Fable", desc: "" },
];
// Reasoning-effort levels — labels + wording aligned with Claude Code's `/effort`.
const EFFORTS = [
  { id: "low", label: "Low", desc: "快速、直接的实现" },
  { id: "medium", label: "Medium", desc: "均衡，标准测试" },
  { id: "high", label: "High", desc: "全面实现，充分测试" },
  { id: "xhigh", label: "xHigh", desc: "扩展推理，深入分析" },
  { id: "max", label: "Max", desc: "最强能力，最深推理" },
];
let currentMode = "default";
let currentModel = "";
let currentEffort = "";

function syncPickers() {
  const mode = MODES.find((x) => x.id === currentMode) || MODES[0];
  modeIcon.innerHTML = mode.icon;
  modeLabel.textContent = mode.title;
  const model = MODELS.find((x) => x.id === currentModel) || MODELS[0];
  modelLabel.textContent = model.label;
}

syncPickers(); // paint the real labels immediately (host `config` refines them)

function closePickers() {
  modeMenu.classList.add("hidden");
  modelMenu.classList.add("hidden");
  usageMenu.classList.add("hidden");
  pickBackdrop.classList.add("hidden");
}

function buildModeMenu() {
  let html = `<div class="pick-head">模式</div>`;
  for (const m of MODES) {
    html +=
      `<button class="pick-row" data-mode="${m.id}">` +
      `<span class="pick-ico">${m.icon}</span>` +
      `<span class="pick-text"><span class="pick-title">${m.title}</span><span class="pick-desc">${m.desc}</span></span>` +
      `<span class="pick-check">${m.id === currentMode ? "✓" : ""}</span></button>`;
  }
  modeMenu.innerHTML = html;
}

function buildModelMenu() {
  let html = `<div class="pick-head">模型</div>`;
  for (const m of MODELS) {
    html +=
      `<button class="pick-row" data-model="${m.id}">` +
      `<span class="pick-text"><span class="pick-title">${m.label}</span>${m.desc ? `<span class="pick-desc">${m.desc}</span>` : ""}</span>` +
      `<span class="pick-check">${m.id === currentModel ? "✓" : ""}</span></button>`;
  }
  // Reasoning-effort dots — level names + Claude's /effort wording on hover.
  const idx = EFFORTS.findIndex((e) => e.id === currentEffort);
  const curLabel = idx >= 0 ? EFFORTS[idx].label : "默认";
  html += `<div class="pick-sep"></div><div class="pick-effort"><span>推理强度 (${curLabel})</span><span class="effort-dots">`;
  EFFORTS.forEach((e, i) => {
    html += `<span class="effort-dot ${idx >= 0 && i <= idx ? "on" : ""}" data-effort="${e.id}" title="${e.label}：${e.desc}"></span>`;
  });
  html += `</span></div>`;
  modelMenu.innerHTML = html;
}

modeTrigger.onclick = (e) => {
  e.stopPropagation();
  const open = !modeMenu.classList.contains("hidden");
  closePickers();
  if (!open) {
    buildModeMenu();
    modeMenu.classList.remove("hidden");
    pickBackdrop.classList.remove("hidden");
  }
};
modelTrigger.onclick = (e) => {
  e.stopPropagation();
  const open = !modelMenu.classList.contains("hidden");
  closePickers();
  if (!open) {
    buildModelMenu();
    modelMenu.classList.remove("hidden");
    pickBackdrop.classList.remove("hidden");
  }
};
pickBackdrop.onclick = closePickers;

modeMenu.addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest("[data-mode]") as HTMLElement | null;
  if (row) {
    currentMode = row.dataset.mode || "default";
    send({ type: "setPermissionMode", mode: currentMode });
    syncPickers();
    closePickers();
  }
});
modelMenu.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const dot = t.closest("[data-effort]") as HTMLElement | null;
  if (dot) {
    currentEffort = dot.dataset.effort || "";
    send({ type: "setEffort", effort: currentEffort });
    buildModelMenu(); // keep menu open, update dots
    return;
  }
  const row = t.closest("[data-model]") as HTMLElement | null;
  if (!row) return;
  currentModel = row.dataset.model || "";
  send({ type: "setModel", model: currentModel });
  syncPickers();
  closePickers();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePickers();
});
$("btn-attach-file").onclick = () => send({ type: "pickFiles" });
cfHeader.onclick = (e) => {
  const btn = (e.target as HTMLElement).closest("[data-cf]") as HTMLElement | null;
  if (btn) {
    if (btn.dataset.cf === "acceptAll") send({ type: "acceptAll" });
    else if (btn.dataset.cf === "revertAll") send({ type: "revertAll" });
    return;
  }
  changedFiles.classList.toggle("collapsed");
};

// New-session / history are now driven from the editor title bar + sidebar;
// the in-panel toolbar was removed.
overlay.onclick = closeDrawers;
document.querySelectorAll("[data-close]").forEach((b) => ((b as HTMLElement).onclick = closeDrawers));

// Event delegation: copy buttons & file links inside the message stream.
messagesEl.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const action = t.closest("[data-action]") as HTMLElement | null;
  if (!action) return;
  const codeOf = (a: HTMLElement) =>
    (a.closest(".code-block") ?? a.closest(".tool-card"))?.querySelector("code")?.textContent ?? "";
  if (action.dataset.action === "copy") {
    const code = codeOf(action);
    send({ type: "copy", text: code });
    const orig = action.innerHTML;
    action.textContent = "✓ 已复制";
    setTimeout(() => (action.innerHTML = orig), 1200);
  } else if (action.dataset.action === "run") {
    const code = codeOf(action);
    if (code.trim()) {
      send({ type: "runInTerminal", code });
      const orig = action.innerHTML;
      action.textContent = "✓ 已发送";
      setTimeout(() => (action.innerHTML = orig), 1200);
    }
  } else if (action.dataset.action === "toggle-code") {
    const block = action.closest(".code-block") as HTMLElement | null;
    if (block) {
      const collapsed = block.classList.toggle("collapsed");
      action.textContent = collapsed ? `展开全部 ${block.dataset.lines || ""} 行` : "收起";
    }
  } else if (action.dataset.action === "diff") {
    const p = action.dataset.path;
    if (p) send({ type: "openDiff", path: p });
  } else if (action.dataset.action === "open") {
    const p = action.dataset.path;
    const line = action.dataset.line ? parseInt(action.dataset.line, 10) : undefined;
    const endLine = action.dataset.endline ? parseInt(action.dataset.endline, 10) : undefined;
    if (p) send({ type: "openFile", path: p, line, endLine });
  } else if (action.dataset.action === "symbol") {
    const name = action.dataset.symbol;
    if (name) send({ type: "openSymbol", name });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function appendUser(text: string, contextLabels: string[] = [], images: string[] = []) {
  messagesEl.querySelector(".empty-state")?.remove();
  const msg = el("div", "msg user");
  msg.dataset.rawText = text;
  const body = el("div", "msg-body");
  if (contextLabels.length) {
    const ctx = el("div", "user-context");
    for (const l of contextLabels) ctx.appendChild(el("span", "ctx-chip", l));
    body.appendChild(ctx);
  }
  if (images.length) {
    const grid = el("div", "msg-images");
    for (const src of images) grid.appendChild(makeThumb(src));
    body.appendChild(grid);
  }
  if (text.trim()) {
    const seg = el("div", "md");
    seg.innerHTML = mdFull.render(text);
    body.appendChild(seg);
  }
  msg.appendChild(body);
  messagesEl.appendChild(msg);
  lastUserEl = msg;
  userMsgCount++;
  scrollToBottom();
  return msg;
}

/** The user message that prompted a given assistant turn (walks back past dividers). */
function precedingUserMsg(aEl: HTMLElement): HTMLElement | null {
  let n = aEl.previousElementSibling as HTMLElement | null;
  while (n) {
    if (n.classList?.contains("msg") && n.classList.contains("user")) return n;
    n = n.previousElementSibling as HTMLElement | null;
  }
  return null;
}

/** The icon-button row shown at the bottom of an assistant reply. */
function buildReplyActions(aEl: HTMLElement): HTMLElement {
  const acts = el("div", "msg-actions");
  const mk = (icon: string, title: string, fn: (b: HTMLButtonElement) => void) => {
    const b = el("button", "msg-act") as HTMLButtonElement;
    b.innerHTML = icon;
    b.title = title;
    b.onclick = () => fn(b);
    return b;
  };
  const regen = mk(ICON.update, "重新生成", () => regenerate(aEl));
  const copy = mk(ICON.copy, "复制", (b) => {
    const text = Array.from(aEl.querySelectorAll(".msg-body .text-seg"))
      .map((e) => (e as HTMLElement).innerText)
      .join("\n\n")
      .trim();
    send({ type: "copy", text });
    b.classList.add("done");
    setTimeout(() => b.classList.remove("done"), 1000);
  });
  const up = mk(ICON.thumbUp, "赞", (b) => {
    b.classList.toggle("on");
    down.classList.remove("on");
  });
  const down = mk(ICON.thumbDown, "踩", (b) => {
    b.classList.toggle("on");
    up.classList.remove("on");
  });
  acts.append(regen, copy, up, down);
  return acts;
}

/** Re-run the user message that produced this reply: rewind to before it
 *  (truncate transcript + revert files) and resend the same text. */
function regenerate(aEl: HTMLElement) {
  if (isBusy) return;
  const userMsg = precedingUserMsg(aEl);
  if (!userMsg) return;
  const raw = userMsg.dataset.rawText || "";
  // Image-only messages have no text but are still regenerable.
  if (!raw && !userMsg.querySelector(".msg-images img")) return;
  submitEdit(userMsg, userMsg.dataset.checkpointId || "", raw);
}

function submitEdit(msg: HTMLElement, checkpointId: string, newText: string) {
  // Carry the original message's images through the edit/regenerate — dropping
  // them corrupted the visible history AND resent the turn without the image.
  const imageUris = Array.from(msg.querySelectorAll<HTMLImageElement>(".msg-images img")).map((i) => i.src);
  const images: { mediaType: string; data: string }[] = [];
  for (const uri of imageUris) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(uri);
    if (m) images.push({ mediaType: m[1], data: m[2] });
  }
  // Remove this message's checkpoint divider (the one just above it), the
  // message itself, and everything after it.
  const prev = msg.previousElementSibling;
  if (prev && prev.classList.contains("checkpoint-divider")) prev.remove();
  let node = msg.nextElementSibling;
  while (node) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
  msg.remove();
  // Reset streaming state and re-append the edited message as the new turn.
  assistantEl = null;
  liveBlock = null;
  toolCards.clear();
  userMsgCount = messagesEl.querySelectorAll(".msg.user").length;
  appendUser(newText, [], imageUris);
  finalizeTurn();
  // Enter busy state like performSend — the host rewinds + respawns before the
  // real busy:true arrives; without this the stop button is missing and a
  // second Enter could race a concurrent turn.
  turnTokens = 0;
  turnEst = 0;
  msgTokenBase = 0;
  lastMsgTokens = 0;
  isBusy = true;
  queuePaused = false;
  stoppingView = false;
  refreshComposerHint();
  showWorking();
  send({ type: "editMessage", checkpointId, text: newText, images: images.length ? images : undefined });
}

/** An image thumbnail that opens the lightbox on click. */
function makeThumb(src: string): HTMLElement {
  const img = el("img", "msg-image") as HTMLImageElement;
  img.src = src;
  img.loading = "lazy";
  img.onclick = () => openLightbox(src);
  return img;
}

function appendNotice(text: string, kind: "info" | "error") {
  const n = el("div", `notice ${kind}`, text);
  messagesEl.appendChild(n);
  scrollToBottom();
}

function addContextChip(label: string, text: string) {
  if (pendingContexts.some((c) => c.label === label)) return;
  pendingContexts.push({ label, text });
  const chip = el("span", "input-chip");
  chip.append(document.createTextNode(label));
  const x = el("button", "chip-x", "×");
  x.onclick = () => {
    const i = pendingContexts.findIndex((c) => c.label === label);
    if (i >= 0) pendingContexts.splice(i, 1);
    chip.remove();
  };
  chip.appendChild(x);
  contextChips.appendChild(chip);
}
function clearContextChips() {
  pendingContexts.length = 0;
  contextChips.innerHTML = "";
}

function setBusy(busy: boolean) {
  isBusy = busy;
  if (busy) stoppingView = false; // a new turn is live — resume rendering
  refreshComposerHint(); // toggles send/stop + the "加入等待队列" hint
  if (busy) {
    showWorking();
    if (assistantEl) assistantEl.classList.add("streaming-turn");
  } else {
    removeWorking();
    // Turn finished — kick off the next queued task (slight delay so the result
    // UI settles and the process is idle before resuming).
    if (taskQueue.length) setTimeout(flushQueue, 150);
  }
  if (!busy && !statusLine.textContent?.startsWith("完成")) statusLine.textContent = "";
}

/** A live "思考中 · Ns" pill shown whenever the model is working but not
 *  currently writing visible text (turn start, thinking, between tool steps). */
/** Show the live activity pill. With no arg it cycles "thinking" verbs; pass a
 *  fixed `label` for a specific phase (e.g. preparing the option picker). */
function showWorking(label?: string) {
  const body = ensureAssistant();
  let w = body.querySelector(".working-pill") as HTMLElement | null;
  if (!w) {
    w = el("div", "working-pill");
    w.dataset.start = String(performance.now());
    w.dataset.wseed = String(Math.floor(Math.random() * THINKING_WORDS.length)); // varies the starting verb
    w.innerHTML =
      `<span class="typing"><span></span><span></span><span></span></span>` +
      `<span class="wk-label"></span><span class="wk-time">0s</span><span class="wk-tokens"></span>`;
    body.appendChild(w);
  }
  workingFixed = label ?? "";
  workingRotate = !label;
  const lbl = w.querySelector(".wk-label") as HTMLElement;
  const seed = Number(w.dataset.wseed || 0);
  if (lbl) lbl.textContent = label ?? `${THINKING_WORDS[seed % THINKING_WORDS.length]}…`;
  const tk = w.querySelector(".wk-tokens") as HTMLElement;
  if (tk) tk.textContent = turnTokens > 0 ? `${fmtTokens(turnTokens)} tokens` : "";
  // Always keep the pill as the last element so it sits below the latest output.
  if (body.lastElementChild !== w) body.appendChild(w);
  startTick();
  updateActiveLine(); // extend the active glow down to the pill right away
  maybeScroll();
}
function removeWorking() {
  assistantEl?.querySelector(".working-pill")?.remove();
  workingRotate = false;
  workingFixed = "";
}

function openDrawer(panel: HTMLElement) {
  closeDrawers();
  panel.classList.remove("hidden");
  overlay.classList.remove("hidden");
}
function closeDrawers() {
  sessionsPanel.classList.add("hidden");
  overlay.classList.add("hidden");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function withHtml<T extends HTMLElement>(e: T, html: string): T {
  e.innerHTML = html;
  return e;
}
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i < 0 ? s : s.slice(0, i) + "…";
}
function truncateText(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (已截断 ${s.length - n} 字符)` : s;
}
function toolIcon(name: string): string {
  const map: Record<string, string> = {
    Bash: ICON.terminal,
    Grep: ICON.search,
    Glob: ICON.search,
    Task: ICON.task,
    WebFetch: ICON.web,
    WebSearch: ICON.web,
  };
  return map[name] || ICON.tool;
}
// ---------------------------------------------------------------------------
send({ type: "ready" });
autoResize();
updateEmptyState();
