// Tiny JSON settings store kept in Electron's userData directory.
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5",
  effort: "low",
  systemPrompt:
    "You are a discreet real-time assistant running in a small overlay on the user's screen. " +
    "The user is usually mid-task (a call, an interview, a document, code) and needs help fast. " +
    "Answer directly and concisely. Lead with the answer, then at most a few supporting points. " +
    "When given a screenshot, read it carefully and respond to what is actually on screen. " +
    "Use plain text or light markdown. No preamble, no restating the question.",
  notes: "",
  opacity: 0.96,
  windowBounds: null,
};

let cache = null;

function filePath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  const next = { ...load(), ...patch };
  cache = next;
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(next, null, 2));
  return next;
}

function get(key) {
  return load()[key];
}

module.exports = { load, save, get, DEFAULTS };
