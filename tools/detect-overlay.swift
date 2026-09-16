// Capture-hidden window detector (macOS 14+).
//
// For each real on-screen window, ScreenCaptureKit is asked to capture just that
// window. A window with content protection (NSWindowSharingNone — what Electron's
// setContentProtection(true) sets) is still listed by the system, but its
// captured pixels come back blank. "Visible on screen, blank when captured" is
// what a screen share cannot see and what desktop proctoring tools flag. This
// tool only reports it.
//
// STATUS: incomplete. As written it does NOT detect this project's overlay.
// Per-window capture via SCScreenshotManager still returns real pixels for a
// content-protected window, and the protected window is additionally absent
// from the on-screen CGWindowList, so both signals this tool relies on miss it.
// A working detector needs to compare the window server's full window list
// (including off-screen entries) against a full-display capture.
//
// Build & run:  swiftc tools/detect-overlay.swift -o /tmp/detect && /tmp/detect
import CoreGraphics
import Foundation
import ScreenCaptureKit

@available(macOS 14.0, *)
func isBlank(_ image: CGImage) -> Bool {
    guard let data = image.dataProvider?.data, let ptr = CFDataGetBytePtr(data) else { return true }
    let len = CFDataGetLength(data)
    if len == 0 { return true }
    let step = max(1, len / 8192)
    let first = ptr[0]
    var i = 0
    while i < len { if ptr[i] != first { return false }; i += step }
    return true
}

// Real on-screen windows, by id, from the window server.
struct WinInfo { let owner: String; let name: String; let pid: Int; let w: Int; let h: Int }
var server: [UInt32: WinInfo] = [:]
let opts = CGWindowListOption([.optionOnScreenOnly, .excludeDesktopElements])
if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
    for w in list {
        guard let id = w[kCGWindowNumber as String] as? UInt32 else { continue }
        if ((w[kCGWindowLayer as String] as? Int) ?? 0) < 0 { continue }
        var ww = 0, hh = 0
        if let b = w[kCGWindowBounds as String] as? [String: Any] {
            ww = Int((b["Width"] as? Double) ?? 0); hh = Int((b["Height"] as? Double) ?? 0)
        }
        if ww < 60 || hh < 60 { continue }
        server[id] = WinInfo(owner: (w[kCGWindowOwnerName as String] as? String) ?? "?",
                             name: (w[kCGWindowName as String] as? String) ?? "",
                             pid: (w[kCGWindowOwnerPID as String] as? Int) ?? -1, w: ww, h: hh)
    }
}

guard #available(macOS 14.0, *) else { print("Needs macOS 14+."); exit(1) }

let sema = DispatchSemaphore(value: 0)
var scWindows: [SCWindow] = []
var scErr: String?
SCShareableContent.getWithCompletionHandler { content, error in
    if let error = error { scErr = error.localizedDescription }
    scWindows = content?.windows ?? []
    sema.signal()
}
_ = sema.wait(timeout: .now() + 10)
if let scErr = scErr { print("ScreenCaptureKit error: \(scErr)\n") }

struct Hit { let owner: String; let name: String; let pid: Int; let size: String }
var hidden: [Hit] = []
var normal = 0

for scw in scWindows {
    guard let info = server[scw.windowID] else { continue } // only real on-screen ones
    let cfg = SCStreamConfiguration()
    cfg.width = max(2, Int(scw.frame.width)); cfg.height = max(2, Int(scw.frame.height))
    cfg.showsCursor = false
    let filter = SCContentFilter(desktopIndependentWindow: scw)
    var blank = true
    let s2 = DispatchSemaphore(value: 0)
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { img, _ in
        if let img = img { blank = isBlank(img) }
        s2.signal()
    }
    _ = s2.wait(timeout: .now() + 5)
    if blank {
        hidden.append(Hit(owner: info.owner, name: info.name, pid: info.pid, size: "\(info.w)x\(info.h)"))
    } else {
        normal += 1
    }
}

print("Captured \(normal + hidden.count) on-screen windows; \(normal) rendered normally.\n")
if hidden.isEmpty {
    print("No capture-hidden windows detected.")
} else {
    print("\u{26A0}\u{FE0F}  \(hidden.count) window(s) HIDDEN FROM CAPTURE but present on screen:")
    print(String(repeating: "-", count: 62))
    for h in hidden {
        print("  app: \(h.owner)    pid: \(h.pid)    size: \(h.size)")
        print("  title: \(h.name.isEmpty ? "(no title)" : h.name)")
        print(String(repeating: "-", count: 62))
    }
    print("\nEach window above is visible to your eyes and to a camera, but blank")
    print("in screen shares and screenshots. Desktop proctoring flags this.")
}
