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
  } else {
    try {
      body = hljs.highlightAuto(token.content).value;
    } catch {
      body = escapeHtml(token.content);
    }
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
const sessionTitle = $("session-title");
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
  if (assistantEl) {
    assistantEl.classList.remove("streaming-turn");
    assistantEl.querySelector(".rail .thread-active")?.remove(); // stop the progress pulse
    const body = assistantEl.querySelector(".msg-body");
    if (body && body.children.length === 0) {
      assistantEl.remove();
    } else if (body) {
      // Mark the final summary text as the closing timeline node (a dot at its
      // start) — but only when it follows earlier content (not the very first item).
      const segs = body.querySelectorAll(".text-seg");
      const last = segs[segs.length - 1];
      if (last && body.firstElementChild !== last) last.classList.add("summary-node");
      endTimelineAtLastNode(assistantEl); // stop the line at the last node
    }
  }
  assistantEl = null;
  liveBlock = null;
}

/** Shorten the timeline rail so it ends exactly at the last node (no trailing line). */
function endTimelineAtLastNode(msg: HTMLElement) {
  const line = msg.querySelector(".thread-line") as HTMLElement | null;
  if (!line) return;
  const nodes = msg.querySelectorAll(".step, .text-seg.summary-node");
  const last = nodes[nodes.length - 1] as HTMLElement | undefined;
  if (!last) {
    line.style.display = "none";
    return;
  }
  const aTop = msg.getBoundingClientRect().top;
  const lineTop = line.getBoundingClientRect().top - aTop;
  const endY = last.getBoundingClientRect().top - aTop + 9; // ≈ dot center
  line.style.flex = "0 0 auto";
  line.style.height = Math.max(0, endY - lineTop) + "px";
}

/** Reveal the live text with a typewriter: complete lines are rendered as
 *  markdown (committed once each newline arrives), and the current line types
 *  out char-by-char as plain text. Cheap — markdown only re-renders per line. */
function renderLive() {
  if (!liveBlock) return;
  const shownText = liveBlock.raw.slice(0, liveBlock.shown);
  const lastNl = shownText.lastIndexOf("\n");
  const commitLen = lastNl >= 0 ? lastNl + 1 : 0;
  if (commitLen > liveBlock.committedLen) {
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

/** Snap the live block to its full text, rendered with syntax highlighting. */
function finalizeLive() {
  if (typewriterRAF) {
    cancelAnimationFrame(typewriterRAF);
    typewriterRAF = 0;
  }
  if (!liveBlock) return;
  liveBlock.el.innerHTML = mdFull.render(liveBlock.raw);
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
  // Anchor the bottom to the rail's end (which grows with the message) so the
  // active segment always reaches the very bottom of the line, even when more
  // content (e.g. a permission box) is added after the last node.
  active.style.top = `${startY}px`;
  active.style.bottom = "2px";
  active.style.removeProperty("height");
}

// -- Shared 1s ticker: updates the "Thinking · Ns · N tokens" pill ------------
let tickTimer = 0;
let turnTokens = 0; // running output-token count for the current turn
function fmtTokens(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
}
function onTokens(output: number) {
  // output_tokens is cumulative per assistant message; keep the max this turn.
  turnTokens = Math.max(turnTokens, output);
  const tk = assistantEl?.querySelector(".working-pill .wk-tokens") as HTMLElement | null;
  if (tk) tk.textContent = turnTokens > 0 ? `${fmtTokens(turnTokens)} tokens` : "";
}

const ctxGauge = $("ctx-gauge");
/** Circular context-usage gauge next to the mode picker (hidden below 10%). */
function updateContextGauge(used: number, total: number) {
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
  ctxGauge.title = `上下文使用 ${pct}%（约 ${fmtTokens(used)} / ${fmtTokens(total)} tokens）`;
}
function startTick() {
  if (tickTimer) return;
  tickTimer = window.setInterval(() => {
    const wk = assistantEl?.querySelector(".working-pill") as HTMLElement | null;
    if (!wk) {
      clearInterval(tickTimer);
      tickTimer = 0;
      return;
    }
    const t = wk.querySelector(".wk-time") as HTMLElement | null;
    if (t) t.textContent = `${Math.round((performance.now() - Number(wk.dataset.start || performance.now())) / 1000)}s`;
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
  switch (m.kind) {
    case "session":
      sessionTitle.textContent = m.resumed ? sessionTitle.textContent || "会话" : sessionTitle.textContent || "新对话";
      statusLine.textContent = `模型 ${m.model} · ${m.cwd}`;
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
      break; // thinking text is not displayed (only its token count, via "tokens")
    case "tokens":
      onTokens(m.output);
      break;
    case "context":
      updateContextGauge(m.used, m.total);
      break;
    case "update_available": {
      const b = $("btn-update");
      b.classList.add("has-update");
      b.title = `发现新版本 v${m.version} · 点击更新`;
      break;
    }
    case "tool_input":
      updateToolInput(m.toolId, m.name, m.input);
      break;
    case "tool_input_partial":
      updateToolPartial(m.toolId, m.name, m.json);
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
        statusLine.textContent =
          `完成 · ${m.numTurns} 轮` + (m.costUsd ? ` · $${m.costUsd.toFixed(4)}` : "");
      }
      break;
    case "error":
      finalizeTurn();
      appendNotice(m.message, "error");
      break;
    case "notice":
      if (m.message) appendNotice(m.message, "info");
      break;
    case "load_history":
      loadHistory(m.items, m.title, m.checkpoints);
      break;
    case "sessions":
      renderSessions(m.list, m.activeId);
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
    removeWorking();
    createToolCard(body, toolId, toolName || "tool");
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
    `<span class="tool-name">${escapeHtml(name)}</span><span class="tool-sub"></span>` +
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

function setToolResult(toolUseId: string, content: string, isError: boolean) {
  const card = toolCards.get(toolUseId);
  if (!card) return;
  card.classList.remove("running");
  card.classList.toggle("error", isError);
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

function loadHistory(items: TimelineItem[], title?: string, checkpoints?: { id: string; label: string }[]) {
  historyState = { items, checkpoints: checkpoints || [] };
  if (title) sessionTitle.textContent = title;
  renderHistory(false);
}

function renderHistory(showAll: boolean) {
  if (!historyState) return;
  const { items, checkpoints } = historyState;
  messagesEl.innerHTML = "";
  toolCards.clear();
  assistantEl = null;
  liveBlock = null;
  lastUserEl = null;
  userMsgCount = 0;
  ctxGauge.classList.add("hidden"); // refreshes from the next turn's usage

  // Align checkpoints to the trailing user messages (tracking may start mid-session).
  const userTotal = items.filter((i) => i.type === "user").length;
  const offset = Math.max(0, userTotal - checkpoints.length);
  const cpByOrdinal = new Map<number, { id: string }>();
  checkpoints.forEach((c, j) => cpByOrdinal.set(offset + j, c));

  // By default only render the last HISTORY_TURN_LIMIT turns; fold the rest.
  let cutoff = 0;
  if (!showAll && userTotal > HISTORY_TURN_LIMIT) {
    const target = userTotal - HISTORY_TURN_LIMIT; // skip this many user turns
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
    banner.onclick = () => renderHistory(true);
    messagesEl.appendChild(banner);
  }

  let userOrdinal = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type === "user") userOrdinal++;
    if (i < cutoff) continue; // fold earlier items but keep ordinal counting accurate
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
      seg.innerHTML = mdFull.render(it.text);
      linkifyRefs(seg);
      body.appendChild(seg);
    } else if (it.type === "thinking") {
      // thinking is not displayed
    } else if (it.type === "tool") {
      const body = ensureAssistant();
      createToolCard(body, it.toolId, it.name);
      if (it.input) updateToolInput(it.toolId, it.name, it.input);
      if (it.result != null) setToolResult(it.toolId, it.result, !!it.isError);
    }
  }
  finalizeTurn();
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
    main.append(el("div", "list-title", s.title), el("div", "list-meta", `${new Date(s.updatedAt).toLocaleString()} · ${s.messageCount} 条`));
    row.appendChild(main);
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
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [{ label: "删除会话", danger: true, run: () => send({ type: "deleteSession", sessionId: s.id }) }]);
    };
    sessionsList.appendChild(row);
  }
  updateSessionTools();
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
  autoDismissed = false;
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
  appendUser(p.text, p.labels, p.imageUris);
  finalizeTurn();
  turnTokens = 0; // reset token counter for the new turn
  isBusy = true;
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
  if (isBusy || !taskQueue.length) return;
  const next = taskQueue.shift()!;
  renderQueue();
  performSend(next);
}

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
stopBtn.onclick = () => send({ type: "interrupt" });
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
  };
  wrap.append(img, x);
  imagePreviews.appendChild(wrap);
}

// Lightbox (click any chat image to view full size)
function openLightbox(src: string) {
  lightboxImg.src = src;
  lightbox.classList.remove("hidden");
}
lightbox.onclick = () => {
  lightbox.classList.add("hidden");
  lightboxImg.src = "";
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
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
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

function closePickers() {
  modeMenu.classList.add("hidden");
  modelMenu.classList.add("hidden");
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
  // Reasoning-effort row (dots) — lives in the model settings.
  const idx = EFFORTS.indexOf(currentEffort);
  html += `<div class="pick-sep"></div><div class="pick-effort"><span>推理强度 ${currentEffort ? `(${currentEffort})` : "(默认)"}</span><span class="effort-dots">`;
  EFFORTS.forEach((e, i) => {
    html += `<span class="effort-dot ${idx >= 0 && i <= idx ? "on" : ""}" data-effort="${e}" title="${e}"></span>`;
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

$("btn-new").onclick = () => {
  send({ type: "newSession" });
  sessionTitle.textContent = "新对话";
};
$("btn-sessions").onclick = () => {
  send({ type: "listSessions" });
  openDrawer(sessionsPanel);
};
$("btn-update").onclick = () => {
  $("btn-update").classList.remove("has-update"); // acting on it clears the dot
  send({ type: "checkUpdate" });
};
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
  body.title = "点击编辑并重发（会回撤其后的对话）";
  // Click the message to edit it directly (but let links / images / selection through).
  body.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("a") || t.closest("img") || t.closest("button") || t.closest("textarea")) return;
    if (window.getSelection()?.toString()) return;
    enterEditMode(msg);
  });
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

/** Click ✎ on a user message: edit it inline. Sending rewinds the conversation
 *  to before that message (truncate + revert files) and resends the new text. */
function enterEditMode(msg: HTMLElement) {
  if (isBusy) return;
  const body = msg.querySelector(".msg-body") as HTMLElement;
  if (!body || body.classList.contains("editing")) return;
  const raw = msg.dataset.rawText || "";
  const checkpointId = msg.dataset.checkpointId || "";
  const prevHTML = body.innerHTML;
  body.classList.add("editing");
  const ta = el("textarea", "edit-area") as HTMLTextAreaElement;
  ta.value = raw;
  const bar = el("div", "edit-bar");
  const cancelB = el("button", "edit-cancel", "取消");
  const sendB = el("button", "edit-send", "发送");
  bar.append(cancelB, sendB);
  body.innerHTML = "";
  body.append(ta, bar);
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  };
  grow();
  ta.focus();
  ta.setSelectionRange(raw.length, raw.length);
  ta.addEventListener("input", grow);
  const restore = () => {
    body.classList.remove("editing");
    body.innerHTML = prevHTML;
  };
  cancelB.onclick = restore;
  sendB.onclick = () => {
    const t = ta.value.trim();
    if (!t) return;
    submitEdit(msg, checkpointId, t);
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (e as KeyboardEvent).keyCode !== 229) {
      e.preventDefault();
      sendB.click();
    } else if (e.key === "Escape") {
      restore();
    }
  });
}

function submitEdit(msg: HTMLElement, checkpointId: string, newText: string) {
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
  appendUser(newText);
  finalizeTurn();
  send({ type: "editMessage", checkpointId, text: newText });
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
function showWorking(label = "Thinking") {
  const body = ensureAssistant();
  let w = body.querySelector(".working-pill") as HTMLElement | null;
  if (!w) {
    w = el("div", "working-pill");
    w.dataset.start = String(performance.now());
    w.innerHTML =
      `<span class="typing"><span></span><span></span><span></span></span>` +
      `<span class="wk-label"></span><span class="wk-time">0s</span><span class="wk-tokens"></span>`;
    body.appendChild(w);
  }
  const lbl = w.querySelector(".wk-label") as HTMLElement;
  if (lbl) lbl.textContent = label;
  const tk = w.querySelector(".wk-tokens") as HTMLElement;
  if (tk) tk.textContent = turnTokens > 0 ? `${fmtTokens(turnTokens)} tokens` : "";
  // Always keep the pill as the last element so it sits below the latest output.
  if (body.lastElementChild !== w) body.appendChild(w);
  startTick();
  maybeScroll();
}
function removeWorking() {
  assistantEl?.querySelector(".working-pill")?.remove();
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
