// Build and load the macOS helper that stops the overlay from becoming the
// active app when clicked. See native/prevent-activation.m.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let addon = null;
let tried = false;

function unpackedDir(dir) {
  return dir.includes(`${path.sep}app.asar${path.sep}`) || dir.endsWith(`${path.sep}app.asar`)
    ? dir.replace(`${path.sep}app.asar`, `${path.sep}app.asar.unpacked`)
    : dir;
}

function addonPath() {
  return path.join(unpackedDir(path.join(__dirname, "..", "native")), `prevent-activation.${process.arch}.node`);
}

function sourcePath() {
  return path.join(__dirname, "..", "native", "prevent-activation.m");
}

function needsBuild(out) {
  if (!fs.existsSync(out)) return true;
  const src = sourcePath();
  if (!fs.existsSync(src)) return false;
  return fs.statSync(src).mtimeMs > fs.statSync(out).mtimeMs;
}

function build() {
  const src = sourcePath();
  const out = addonPath();
  if (!fs.existsSync(src)) throw new Error("missing " + src);
  execFileSync(
    "clang",
    [
      "-shared",
      "-fobjc-arc",
      "-O2",
      "-undefined",
      "dynamic_lookup",
      "-mmacosx-version-min=11.0",
      "-arch",
      process.arch,
      "-framework",
      "AppKit",
      "-o",
      out,
      src,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
}

function load() {
  if (tried) return addon;
  tried = true;
  if (process.platform !== "darwin") return null;
  const out = addonPath();
  try {
    if (needsBuild(out)) build();
    addon = require(out);
  } catch (err) {
    console.warn("Could not enable non-activating overlay:", err.message);
    addon = null;
  }
  return addon;
}

function apply(win) {
  if (process.platform !== "darwin" || !win || win.isDestroyed()) return false;
  const native = load();
  if (!native?.apply) return false;
  try {
    native.apply(win.getNativeWindowHandle());
    return true;
  } catch (err) {
    console.warn("Could not apply non-activating overlay:", err.message);
    return false;
  }
}

function makeKey(win) {
  if (process.platform !== "darwin" || !win || win.isDestroyed()) return false;
  const native = load();
  if (!native?.makeKey) return false;
  try {
    native.makeKey(win.getNativeWindowHandle());
    return true;
  } catch (err) {
    console.warn("Could not make overlay key:", err.message);
    return false;
  }
}

module.exports = { apply, makeKey };
