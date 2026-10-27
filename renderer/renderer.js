/* global overlay */
const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const inputEl = $("#input");
const attachShotEl = $("#attach-shot");
const statusEl = $("#status-text");
const settingsEl = $("#settings");

let currentAssistant = null;
let currentRaw = "";
let currentUserBubble = null;
let busy = false;
let pendingPdf = null; // {name, data} attached to the next message

// --- Minimal, safe markdown -> HTML --------------------------------------------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}
function renderMarkdown(src) {
  const out = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ""));
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ol>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<p><strong>${inline(h[2])}</strong></p>`);
      i++;
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(```|\s*[-*•]\s|\s*\d+[.)]\s|#{1,6}\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join("\n"))}</p>`);
  }
  return out.join("");
}

// --- Messages ------------------------------------------------------------------
function clearHint() {
  const hint = messagesEl.querySelector(".hint");
  if (hint) hint.remove();
}
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function addUser(text, withScreenshot, pdfName) {
  clearHint();
  const el = document.createElement("div");
  el.className = "msg user";
  if (pdfName) {
    const tag = document.createElement("div");
    tag.className = "pdf-tag";
    tag.textContent = "📄 " + pdfName;
    el.appendChild(tag);
  }
  if (withScreenshot) {
    const img = document.createElement("img");
    img.alt = "screenshot";
    img.dataset.pending = "1";
    el.appendChild(img);
  }
  const t = document.createElement("div");
  t.textContent = text || (withScreenshot ? "(screenshot)" : pdfName ? "(PDF)" : "");
  el.appendChild(t);
  messagesEl.appendChild(el);
  currentUserBubble = el;
  scrollToBottom();
}
function startAssistant() {
  currentAssistant = document.createElement("div");
  currentAssistant.className = "msg assistant streaming";
  currentRaw = "";
  messagesEl.appendChild(currentAssistant);
  scrollToBottom();
}
function appendDelta(text) {
  if (!currentAssistant) startAssistant();
  currentRaw += text;
  currentAssistant.innerHTML = renderMarkdown(currentRaw);
  scrollToBottom();
}
function finishAssistant() {
  if (currentAssistant) currentAssistant.classList.remove("streaming");
  currentAssistant = null;
}
function addError(message) {
  finishAssistant();
  const el = document.createElement("div");
  el.className = "msg error";
  el.textContent = message;
  messagesEl.appendChild(el);
  scrollToBottom();
}
function setStatus(text, cls) {
  statusEl.textContent = text;
  document.body.classList.remove("busy", "error");
  if (cls) document.body.classList.add(cls);
}

// --- PDF attachment ------------------------------------------------------------
// The API takes requests up to 32 MB, and base64 grows a file by a third.
const MAX_PDF_BYTES = 20 * 1024 * 1024;

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function attachPdf(file) {
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    setStatus("Only PDF files can be attached", "error");
    return;
  }
  if (file.size > MAX_PDF_BYTES) {
    setStatus(`PDF too large (max ${MAX_PDF_BYTES / 1024 / 1024} MB)`, "error");
    return;
  }
  pendingPdf = { name: file.name, data: await readAsBase64(file) };
  $("#attachment-name").textContent = "📄 " + file.name;
  $("#attachment").hidden = false;
  setStatus("PDF attached");
  inputEl.focus();
}

function takePdf() {
  const pdf = pendingPdf;
  pendingPdf = null;
  $("#attachment").hidden = true;
  return pdf;
}

$("#attachment-remove").addEventListener("click", () => {
  takePdf();
  setStatus("Ready");
});
// A PDF copied in Finder (Cmd+C) pastes as a file.
inputEl.addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  if (file) {
    e.preventDefault();
    attachPdf(file);
  }
});

// --- Sending -------------------------------------------------------------------
async function send(withScreenshotOverride) {
  const text = inputEl.value.trim();
  const withScreenshot = withScreenshotOverride ?? attachShotEl.checked;
  if (!text && !withScreenshot && !pendingPdf) return;
  inputEl.value = "";
  autosize();
  attachShotEl.checked = false;
  await overlay.ask(text, withScreenshot, takePdf());
}

function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
}

inputEl.addEventListener("input", autosize);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (busy) return;
    send();
  } else if (e.key === "Escape") {
    if (busy) overlay.stop();
    else overlay.hide();
  }
});
$("#btn-send").addEventListener("click", () => (busy ? overlay.stop() : send()));
$("#btn-shot").addEventListener("click", () => send(true));
$("#btn-solve").addEventListener("click", () => {
  if (busy) return;
  const extra = inputEl.value.trim();
  inputEl.value = "";
  autosize();
  attachShotEl.checked = false;
  overlay.solve(extra, takePdf());
});
$("#btn-reset").addEventListener("click", () => overlay.reset().then(resetView));
$("#btn-hide").addEventListener("click", () => overlay.hide());

function resetView() {
  finishAssistant();
  messagesEl.innerHTML = "";
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.innerHTML = "<p>New conversation.</p>";
  messagesEl.appendChild(hint);
  setStatus("Ready");
}

// --- Events from main ----------------------------------------------------------
overlay.onStart(({ text, withScreenshot, pdfName }) => {
  busy = true;
  finishAssistant();
  addUser(text, withScreenshot, pdfName);
  setStatus(withScreenshot ? "Capturing screen…" : "Thinking…", "busy");
  $("#btn-send").textContent = "■";
  $("#btn-solve").disabled = true;
});
overlay.onScreenshot(({ preview }) => {
  const img = currentUserBubble?.querySelector("img[data-pending]");
  if (img) {
    img.src = preview;
    delete img.dataset.pending;
  }
  setStatus("Thinking…", "busy");
});
overlay.onDelta((delta) => {
  setStatus("Answering…", "busy");
  appendDelta(delta);
});
overlay.onDone(() => {
  busy = false;
  finishAssistant();
  setStatus("Ready");
  $("#btn-send").textContent = "➤";
  $("#btn-solve").disabled = false;
});
overlay.onError(({ message }) => {
  busy = false;
  addError(message);
  setStatus("Error", "error");
  $("#btn-send").textContent = "➤";
  $("#btn-solve").disabled = false;
});
overlay.onReset(resetView);
overlay.onFocusInput(() => inputEl.focus());
overlay.onScreenshotAsk(() => {
  if (busy) return;
  // Sends whatever is typed along with a screenshot; empty text is fine.
  send(true);
});
overlay.onScroll((dir) => {
  messagesEl.scrollBy({ top: dir * messagesEl.clientHeight * 0.8, behavior: "smooth" });
});
overlay.onCopied((ok) => setStatus(ok ? "Copied last reply" : "Nothing to copy yet"));
overlay.onClickThrough((on) => {
  document.body.classList.toggle("click-through", on);
  setStatus(on ? `Click-through (${hotkeyKeys("clickthrough")} to disable)` : "Ready");
});

// --- Settings ------------------------------------------------------------------
async function openSettings() {
  const s = await overlay.getSettings();
  $("#s-key").value = s.apiKey;
  $("#s-key").placeholder = s.hasKey ? "(key saved) paste to replace" : "sk-ant-…";
  $("#s-model").value = s.model;
  $("#s-effort").value = s.effort;
  $("#s-opacity").value = s.opacity;
  $("#s-opacity-val").textContent = Math.round(s.opacity * 100) + "%";
  $("#s-system").value = s.systemPrompt;
  $("#s-notes").value = s.notes;
  $("#s-error").textContent = "";
  settingsEl.hidden = false;
  $("#s-key").focus();
}
$("#btn-settings").addEventListener("click", openSettings);
$("#s-cancel").addEventListener("click", () => (settingsEl.hidden = true));
$("#s-quit").addEventListener("click", () => overlay.quit());
$("#s-opacity").addEventListener("input", (e) => {
  $("#s-opacity-val").textContent = Math.round(e.target.value * 100) + "%";
  overlay.setSettings({ opacity: Number(e.target.value) });
});
async function saveSettings() {
  const btn = $("#s-save");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    await overlay.setSettings({
      apiKey: $("#s-key").value,
      model: $("#s-model").value,
      effort: $("#s-effort").value,
      opacity: Number($("#s-opacity").value),
      systemPrompt: $("#s-system").value,
      notes: $("#s-notes").value,
    });
    settingsEl.hidden = true;
    setStatus("Settings saved");
    inputEl.focus();
  } catch (err) {
    // Never fail silently - a dead Save button is impossible to diagnose.
    $("#s-error").textContent = "Could not save: " + (err?.message || err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
}
$("#s-save").addEventListener("click", saveSettings);
$("#s-reset-prompt").addEventListener("click", async () => {
  $("#s-system").value = await overlay.defaultSystemPrompt();
});
// Esc closes settings; Cmd/Ctrl+Enter saves without reaching for the mouse.
settingsEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    settingsEl.hidden = true;
  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    saveSettings();
  }
});

// Open external links in the default browser rather than inside the overlay.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (a) {
    e.preventDefault();
    overlay.openExternal(a.href);
  }
});

// First run: prompt for a key.
overlay.getSettings().then((s) => {
  if (!s.hasKey) openSettings();
  else inputEl.focus();
});

// --- Hotkeys: labels come from what the main process actually registered -------
let hotkeys = [];
function hotkeyKeys(id) {
  return hotkeys.find((h) => h.id === id)?.keys || "";
}
overlay.getHotkeys().then((list) => {
  hotkeys = list;
  $("#btn-shot").title = `Screenshot + ask (${hotkeyKeys("shot")})`;
  $("#btn-reset").title = `New conversation (${hotkeyKeys("reset")})`;
  $("#btn-hide").title = `Hide (${hotkeyKeys("toggle")})`;
  document.querySelectorAll("[data-hk]").forEach((el) => (el.textContent = hotkeyKeys(el.dataset.hk)));

  const listEl = $("#hotkey-list");
  if (listEl) {
    const up = hotkeyKeys("move-up");
    const entries = [
      [hotkeyKeys("toggle"), "show/hide"],
      [hotkeyKeys("clickthrough"), "click-through"],
      [up ? up.slice(0, -1) + "↑↓←→" : "", "move"],
      [hotkeyKeys("scroll-up") ? hotkeyKeys("scroll-up").slice(0, -1) + "U/D" : "", "scroll"],
      [hotkeyKeys("copy"), "copy reply"],
      [hotkeyKeys("reset"), "new chat"],
      [hotkeyKeys("quit"), "quit"],
    ];
    entries.forEach(([keys, what], i) => {
      const kbd = document.createElement("kbd");
      kbd.textContent = keys;
      listEl.append(kbd, ` ${what}${i < entries.length - 1 ? " · " : ""}`);
    });
  }

  const failed = list.filter((h) => !h.ok);
  if (failed.length) {
    addError(
      "These shortcuts are already taken by another app and will not work: " +
        failed.map((h) => `${h.keys} (${h.action})`).join(", ")
    );
  }
});

// --- Mouse pass-through --------------------------------------------------------
// The window ignores the mouse everywhere except over its own controls, so the
// app underneath keeps receiving the moves that decide which cursor is drawn --
// an overlay that is invisible to screen share must not be visible in the
// pointer either. Chromium still delivers mousemove while the window is
// ignoring the mouse (setIgnoreMouseEvents forward:true), which is what lets
// this notice the pointer arriving on a control and hand the mouse back in time
// for the click. Anything not listed here (the transcript, the panel's own
// background) passes clicks and scrolling through to whatever is behind.
// #bar is the whole title strip: the window is dragged from it (further down),
// so the mouse has to reach it for dragging to work at all.
const CONTROLS = "#bar, #composer, #settings, button, input, select, textarea, label, a[href]";
let pointerOnControl = false;

function setPointerOnControl(on) {
  if (on === pointerOnControl) return;
  pointerOnControl = on;
  overlay.setPointerOnControl(on);
}

document.addEventListener(
  "mousemove",
  (e) => {
    // A drag that outruns the window would otherwise land the pointer outside
    // the bar, hand the mouse back to the app behind and drop the drag.
    if (dragging) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    setPointerOnControl(Boolean(el && el.closest(CONTROLS)));
  },
  true
);

// Leaving the window over a control would otherwise leave the mouse captured.
// While a control holds it the window gets real events, so these do arrive. A
// drag is exempt: it can pull the pointer clean out of the window and still has
// to keep receiving moves.
function releaseOnLeave() {
  if (!dragging) setPointerOnControl(false);
}
document.addEventListener("mouseleave", releaseOnLeave, true);
document.addEventListener("mouseout", (e) => {
  if (!e.relatedTarget) releaseOnLeave();
}, true);

// --- Dragging the window -------------------------------------------------------
// Done by hand rather than with -webkit-app-region: drag, which cannot work
// while the window is ignoring the mouse (see above): AppKit never sees the
// press, and a drag region would swallow the moves that decide when to take the
// mouse back. The bar is an ordinary element, and the window follows how far the
// pointer has travelled on screen since the press.
const DRAG_FROM = "#bar, #settings h2";
let dragging = null;

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const from = e.target.closest(DRAG_FROM);
  // The buttons live in the bar; a press on one is a click, not a drag.
  if (!from || e.target.closest("button, input, select, textarea, label, a[href]")) return;
  dragging = { x: e.screenX, y: e.screenY };
  overlay.dragStart();
  e.preventDefault();
});

document.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  // The window follows the mouse, so a lost mouseup would leave it stuck to the
  // pointer; no button still down means the press ended somewhere unseen.
  if (e.buttons === 0) endDrag(e);
  else overlay.dragMove(e.screenX - dragging.x, e.screenY - dragging.y);
});

function endDrag(e) {
  if (!dragging) return;
  dragging = null;
  overlay.dragEnd();
  // The pointer may have ended up off the bar, or off the window entirely, and
  // no move is guaranteed to follow: settle the mouse from where it actually is,
  // or the next click could land on the app behind instead of on a button.
  const el = document.elementFromPoint(e.clientX, e.clientY);
  setPointerOnControl(Boolean(el && el.closest(CONTROLS)));
}
document.addEventListener("mouseup", endDrag);
