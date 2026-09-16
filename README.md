# CluelyDupe

An always-on-top AI overlay for macOS and Windows that is **invisible to screen sharing, screen recording and screenshots**. Ask Claude anything, optionally with a screenshot of your current screen, while the people on your call see only your normal desktop.

## How the invisibility works

Electron's `BrowserWindow.setContentProtection(true)` maps to:

- **macOS**: `NSWindow.sharingType = .none`. The window is skipped by ScreenCaptureKit and CGWindowList-based capture, which is what Zoom, Google Meet (Chrome), Teams, Slack, Discord, OBS, QuickTime and the built-in screenshot tool all use.
- **Windows**: `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. Same effect for Teams, Zoom, OBS and Snipping Tool on Windows 10 2004+.

The overlay is also frameless, transparent, hidden from the Dock and Mission Control, floats above fullscreen apps on every Space, and can be made click-through so it never interferes with what you are doing.

The app's own screenshot feature uses Electron's `desktopCapturer`, which honors the same protection, so the overlay never shows up in the image sent to the model.

## Setup

```bash
npm install
npm start
```

Provide an Anthropic API key in any one of these ways (checked in this order):

1. Paste it into the settings panel on first launch. It is stored in the app's user-data folder.
2. Put `ANTHROPIC_API_KEY=sk-ant-...` in a `.env` file in the project root (git-ignored).
3. Export `ANTHROPIC_API_KEY` in your shell before launching.

**macOS permission:** the first time you use the screenshot feature, macOS will ask for Screen Recording access for Electron. Grant it in System Settings > Privacy & Security > Screen Recording and relaunch.

## Launch from any terminal

`npm install` puts nothing on your PATH, so link the command once:

```bash
ln -sfn "$PWD/bin/cluely" ~/.local/bin/cluely
```

Then, from anywhere:

| Command | Does |
|---|---|
| `cluely` | Start the overlay, or bring its window back if already running |
| `cluely stop` | Quit it |
| `cluely restart` | Quit and start again, e.g. after changing code |
| `cluely status` | Say whether it is running |
| `cluely logs` | Follow the log at `~/Library/Logs/cluelydupe/cluely.log` |

On macOS the command launches through LaunchServices. The overlay keeps running after you close the terminal, and the Screen Recording permission applies to the Electron entry rather than to whichever terminal app ran the command.

## Hotkeys (global, work while any other app is focused)

| Keys | Action |
|---|---|
| ⌃⌥H | Show / hide the overlay |
| ⌃⌥S | Capture the screen and send it with whatever is typed |
| Enter | Send the typed question (Shift+Enter for newline) |
| Esc | Stop the current reply, or hide the overlay |
| ⌃⌥N | Start a new conversation |
| ⌃⌥C | Toggle click-through mode |
| ⌃⌥↑ ↓ ← → | Move the overlay |
| ⌃⌥Q | Quit |

⌃⌥ is Control+Option. On Windows and Linux use Ctrl+Alt+Shift instead, because Ctrl+Alt acts as AltGr on many keyboard layouts.

These were chosen to avoid collisions. The obvious ⌘⇧ combinations are all taken: ⌘⇧S is Save As in most editors, ⌘⇧ with arrows selects text in every text field, ⌘⇧R and ⌘⇧C are Chrome's hard reload and inspect, and ⌘⇧Q logs you out. ⌃⌥Space is also skipped because macOS uses it to switch input source.

If another app already owns one of these shortcuts, the overlay shows a red notice listing it on launch, since an unregistered shortcut would otherwise pass through to the app in front.

## Settings

- **Model**: `claude-opus-5` by default. Switch to `claude-sonnet-5` or `claude-haiku-4-5` for faster replies, or `claude-fable-5-1` for the most capable model.
- **Effort**: `low` by default for snappy answers; raise for harder questions.
- **Opacity** and **system prompt** are editable.

## Packaging

```bash
npm run dist
```

Produces a signed-if-configured app via electron-builder. For distribution on macOS you will need to code-sign and notarize; content protection itself does not require any special entitlement.

## Limitations

- Content protection hides the window from *capture APIs*. It does not hide it from a phone camera pointed at your monitor, from a hardware capture card, or from screen-mirroring to an external display (a mirrored display shows the same framebuffer).
- Live audio transcription of the call is not included. Claude does not accept raw audio, so that would require a separate speech-to-text service feeding the transcript into the chat.
- Linux has no equivalent OS-level content protection API; the window will appear in screen shares there.

## Project layout

```
src/main.js       Electron main process: window, content protection, hotkeys, screenshot, IPC
src/preload.js    contextBridge API exposed to the renderer
src/claude.js     Anthropic SDK session with streaming and history
src/store.js      JSON settings in userData
src/env.js        .env loader
bin/cluely        launcher command
renderer/         UI (vanilla HTML/CSS/JS)
```
