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
function addUser(text, withScreenshot) {
  clearHint();
  const el = document.createElement("div");
  el.className = "msg user";
  if (withScreenshot) {
    const img = document.createElement("img");
    img.alt = "screenshot";
    img.dataset.pending = "1";
    el.appendChild(img);
  }
  const t = document.createElement("div");
  t.textContent = text || (withScreenshot ? "(screenshot)" : "");
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

// --- Sending -------------------------------------------------------------------
async function send(withScreenshotOverride) {
  const text = inputEl.value.trim();
  const withScreenshot = withScreenshotOverride ?? attachShotEl.checked;
  if (!text && !withScreenshot) return;
  inputEl.value = "";
  autosize();
  attachShotEl.checked = false;
  await overlay.ask(text, withScreenshot);
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
  overlay.solve(extra);
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
overlay.onStart(({ text, withScreenshot }) => {
  busy = true;
  finishAssistant();
  addUser(text, withScreenshot);
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
