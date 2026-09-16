const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  desktopCapturer,
  screen,
  nativeImage,
  systemPreferences,
  shell,
} = require("electron");
const path = require("node:path");
require("./env").loadEnv();

if (!app) {
  // Happens when ELECTRON_RUN_AS_NODE is set (e.g. launched from inside VS Code / Claude Code).
  console.error("Electron started in Node mode because ELECTRON_RUN_AS_NODE is set. Launch with `cluely` or `npm start`, which both clear it.");
  process.exit(1);
}
const store = require("./store");
const { ChatSession, describeError } = require("./claude");
const { buildSolvePrompt } = require("./prompts");
const macNonactivating = require("./mac-nonactivating");

const isDev = process.argv.includes("--dev");
const WIN_W = 460;
const WIN_H = 520;
const MOVE_STEP = 40;

let win = null;
let clickThrough = false;
const session = new ChatSession();

// Hide from the Dock so the app doesn't announce itself; keep a tray-less footprint.
if (process.platform === "darwin" && !isDev) app.dock?.hide();

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - WIN_W - 24,
    y: workArea.y + 24,
    width: WIN_W,
    height: WIN_H,
  };
}

function createWindow() {
  const saved = store.get("windowBounds");
  const bounds = saved || defaultBounds();

  win = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 200,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    show: false,
    focusable: true,
    // macOS: NSWindowStyleMaskNonactivatingPanel. Combined with showInactive()
    // and the native helper, clicks and typing in the overlay leave the app
    // underneath (browser, editor, …) as the active/main window.
    type: process.platform === "darwin" ? "panel" : undefined,
    // Hidden titled chrome on rounded frameless windows is an activating hit
    // target (electron#46880). The overlay still looks rounded via CSS.
    roundedCorners: false,
    // macOS: without this, a click on the unfocused overlay only activates the
    // window and never reaches the button under the cursor. Since the overlay is
    // an accessory app that sits over whatever you are working in, every click
    // would otherwise be swallowed.
    acceptFirstMouse: true,
    title: "",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // --- The core trick -------------------------------------------------------
  // macOS: NSWindowSharingNone. Windows: WDA_EXCLUDEFROMCAPTURE.
  // Screen-share apps (Zoom, Meet, Teams, Discord, OBS) and the OS screenshot
  // tools capture nothing where this window is.
  win.setContentProtection(true);

  // Float above fullscreen apps and every Space, and stay out of Mission Control.
  win.setAlwaysOnTop(true, "screen-saver", 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  if (process.platform === "darwin") {
    win.setHiddenInMissionControl(true);
    try {
      win.setWindowButtonVisibility(false);
    } catch {
      /* not applicable to this window style */
    }
  }

  macNonactivating.apply(win);
  win.on("show", () => macNonactivating.apply(win));

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  win.once("ready-to-show", () => {
    win.setOpacity(store.get("opacity"));
    macNonactivating.apply(win);
    // show() / focus() would activate this app and pull focus out of the
    // browser (or whatever is behind the overlay).
    win.showInactive();
  });

  const persistBounds = () => {
    if (win && !win.isDestroyed()) store.save({ windowBounds: win.getBounds() });
  };
  win.on("moved", persistBounds);
  win.on("resized", persistBounds);
  win.on("closed", () => (win = null));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) win.webContents.openDevTools({ mode: "detach" });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Raise the overlay without making this app the active one. `key` makes the
// panel the key window so the composer can receive typing; a panel still does
// not take the menu bar or deactivate the app underneath.
function showOverlay({ key = false } = {}) {
  if (!win || win.isDestroyed()) return;
  macNonactivating.apply(win);
  if (!win.isVisible()) win.showInactive();
  else win.moveTop();
  if (key) {
    // Electron's win.focus() activates the app on a non-NSPanel window.
    if (!macNonactivating.makeKey(win)) win.focus();
    send("ui:focus-input");
  }
}

function toggleVisibility() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    showOverlay({ key: true });
  }
}

function nudge(dx, dy) {
  if (!win) return;
  const b = win.getBounds();
  win.setBounds({ ...b, x: b.x + dx, y: b.y + dy });
}

function setClickThrough(on) {
  clickThrough = on;
  if (!win) return;
  // forward:true keeps hover events flowing so the UI can still react visually.
  win.setIgnoreMouseEvents(on, { forward: true });
  send("ui:click-through", on);
}

// --- Screenshot ---------------------------------------------------------------
// desktopCapturer honors content protection, so the overlay itself is never in
// the capture. The user only ever sees their own screen described back to them.
const SCREEN_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

async function captureScreen() {
  const isMac = process.platform === "darwin";
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const size = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  // Attempt the capture even when the status reads "denied". On macOS the first
  // real attempt is what registers the app with TCC and raises the system
  // prompt; returning early means the app never appears in the Screen Recording
  // list at all, so the user has nothing to switch on.
  let sources = [];
  let captureError = null;
  try {
    sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  } catch (err) {
    captureError = err;
  }

  if (isMac && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    shell.openExternal(SCREEN_PANE);
    throw new Error(
      "Screen Recording is off for this app. macOS has now listed it under Privacy & " +
        "Security > Screen & System Audio Recording. Switch it on there, then quit and relaunch."
    );
  }
  if (captureError) throw captureError;

  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source) throw new Error("No screen source available.");

  let img = source.thumbnail;
  // Keep the long edge at ~1568px: full detail for the model, small payload.
  const { width, height } = img.getSize();
  const longEdge = Math.max(width, height);
  if (longEdge > 1568) {
    const scale = 1568 / longEdge;
    img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
  }
  const buf = img.toJPEG(82);
  return { data: buf.toString("base64"), mediaType: "image/jpeg", preview: nativeImage.createFromBuffer(buf).resize({ width: 240 }).toDataURL() };
}

// --- IPC ----------------------------------------------------------------------
let busy = false;

async function handleAsk({ text, withScreenshot, solve }) {
  if (busy) {
    session.abort();
  }
  busy = true;
  // Solve always reads the screen. The chat shows a short label, not the full instructions.
  if (solve) withScreenshot = true;
  const label = solve ? (text?.trim() ? `Solve: ${text.trim()}` : "Solve the question on screen") : text;
  const prompt = solve ? buildSolvePrompt(text) : text;
  send("chat:start", { text: label, withScreenshot, solve: Boolean(solve) });
  try {
    let image;
    if (withScreenshot) {
      const shot = await captureScreen();
      image = { data: shot.data, mediaType: shot.mediaType };
      send("chat:screenshot", { preview: shot.preview });
    }
    const reply = await session.send({ text: prompt, image }, (delta) => send("chat:delta", delta));
    send("chat:done", { reply });
  } catch (err) {
    send("chat:error", { message: describeError(err) });
  } finally {
    busy = false;
  }
}

ipcMain.handle("chat:ask", (_e, payload) => handleAsk(payload));
ipcMain.handle("chat:stop", () => session.abort());
ipcMain.handle("chat:reset", () => {
  session.reset();
  return true;
});

ipcMain.handle("settings:get", () => {
  const s = store.load();
  return { ...s, apiKey: s.apiKey ? "•".repeat(8) + s.apiKey.slice(-4) : "", hasKey: Boolean(s.apiKey || process.env.ANTHROPIC_API_KEY) };
});
ipcMain.handle("settings:set", (_e, patch) => {
  const clean = {};
  for (const k of ["model", "effort", "systemPrompt", "opacity"]) {
    if (patch[k] !== undefined) clean[k] = patch[k];
  }
  if (typeof patch.apiKey === "string" && patch.apiKey && !patch.apiKey.startsWith("•")) {
    clean.apiKey = patch.apiKey.trim();
  }
  const next = store.save(clean);
  if (clean.opacity !== undefined && win) win.setOpacity(Number(clean.opacity));
  return { ok: true, model: next.model, effort: next.effort };
});

ipcMain.handle("settings:default-prompt", () => store.DEFAULTS.systemPrompt);

ipcMain.handle("window:hide", () => win?.hide());
ipcMain.handle("window:quit", () => app.quit());
ipcMain.handle("window:click-through", (_e, on) => setClickThrough(Boolean(on)));
ipcMain.handle("window:open-external", (_e, url) => shell.openExternal(url));

// --- Global hotkeys (work even when another app has focus) --------------------
// macOS uses Control+Option: no standard app menu binds it, and Control stops the
// combination from typing a character. Deliberately avoided:
//   Cmd+Shift+S        Save As in most editors, and it fires there whenever this
//                      app is not running or failed to grab the key
//   Cmd+Shift+arrows   select to line/document edge in every text field
//   Cmd+Shift+R / C    Chrome hard reload / inspect element
//   Ctrl+Option+Space  macOS "select next input source"
//   Cmd+Shift+Q        macOS Log Out
// On Windows/Linux Ctrl+Alt doubles as AltGr on many layouts, so Shift is added.
const IS_MAC = process.platform === "darwin";
const HK_MOD = IS_MAC ? "Control+Alt" : "Control+Alt+Shift";
const HK_LABEL = IS_MAC ? "⌃⌥" : "Ctrl+Alt+Shift+";

function showThenScreenshotAsk() {
  if (!win) return;
  showOverlay();
  send("ui:screenshot-ask");
}

const HOTKEYS = [
  { id: "toggle", key: "H", glyph: "H", action: "Show / hide", run: toggleVisibility },
  { id: "shot", key: "S", glyph: "S", action: "Screenshot + ask", run: showThenScreenshotAsk },
  {
    id: "reset",
    key: "N",
    glyph: "N",
    action: "New conversation",
    run: () => {
      session.reset();
      send("chat:reset", {});
    },
  },
  { id: "clickthrough", key: "C", glyph: "C", action: "Click-through", run: () => setClickThrough(!clickThrough) },
  { id: "move-up", key: "Up", glyph: "↑", action: "Move up", run: () => nudge(0, -MOVE_STEP) },
  { id: "move-down", key: "Down", glyph: "↓", action: "Move down", run: () => nudge(0, MOVE_STEP) },
  { id: "move-left", key: "Left", glyph: "←", action: "Move left", run: () => nudge(-MOVE_STEP, 0) },
  { id: "move-right", key: "Right", glyph: "→", action: "Move right", run: () => nudge(MOVE_STEP, 0) },
  { id: "quit", key: "Q", glyph: "Q", action: "Quit", run: () => app.quit() },
];

// What actually got registered. A key another app already owns silently falls
// through to the frontmost app, so the UI shows failures instead of hiding them.
let hotkeyStatus = [];

function registerHotkeys() {
  hotkeyStatus = HOTKEYS.map((h) => {
    const accelerator = `${HK_MOD}+${h.key}`;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, h.run);
    } catch {
      ok = false;
    }
    return { id: h.id, accelerator, keys: HK_LABEL + h.glyph, action: h.action, ok };
  });
  const failed = hotkeyStatus.filter((h) => !h.ok);
  if (failed.length) {
    console.warn("Could not register hotkeys:", failed.map((h) => h.accelerator).join(", "));
  }
}

ipcMain.handle("hotkeys:get", () => hotkeyStatus);

// --- App lifecycle --------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) showOverlay({ key: true });
  });

  app.whenReady().then(() => {
    registerHotkeys();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
