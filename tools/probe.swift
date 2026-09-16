import CoreGraphics
import Foundation
import ScreenCaptureKit

// List all on-screen windows with owner + pid, flag Electron/overlay pid.
let opts = CGWindowListOption([.optionOnScreenOnly, .excludeDesktopElements])
print("=== window server list ===")
if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
    for w in list {
        let id = (w[kCGWindowNumber as String] as? UInt32) ?? 0
        let owner = (w[kCGWindowOwnerName as String] as? String) ?? "?"
        let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? -1
        let name = (w[kCGWindowName as String] as? String) ?? ""
        let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
        var sz = ""
        if let b = w[kCGWindowBounds as String] as? [String: Any] {
            sz = "\(Int((b["Width"] as? Double) ?? 0))x\(Int((b["Height"] as? Double) ?? 0))"
        }
        if owner.lowercased().contains("electron") || pid == 3883 {
            print("  >>> id \(id)  owner=\(owner)  pid=\(pid)  layer=\(layer)  size=\(sz)  title='\(name)'")
        }
    }
}

guard #available(macOS 14.0, *) else { exit(0) }
func blankFrac(_ image: CGImage) -> Double {
    guard let data = image.dataProvider?.data, let ptr = CFDataGetBytePtr(data) else { return 1 }
    let len = CFDataGetLength(data); if len == 0 { return 1 }
    let step = max(1, len / 20000); let first = ptr[0]
    var same = 0, total = 0; var i = 0
    while i < len { if ptr[i] == first { same += 1 }; total += 1; i += step }
    return Double(same) / Double(total)
}

// Full-DISPLAY capture — this is what a screen share sends.
let sema = DispatchSemaphore(value: 0)
var content: SCShareableContent?
SCShareableContent.getWithCompletionHandler { c, _ in content = c; sema.signal() }
_ = sema.wait(timeout: .now() + 10)
guard let display = content?.displays.first else { print("no display"); exit(0) }

let cfg = SCStreamConfiguration()
cfg.width = display.width; cfg.height = display.height
let filter = SCContentFilter(display: display, excludingWindows: [])
var saved = ""
let s2 = DispatchSemaphore(value: 0)
SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { img, err in
    if let img = img {
        let url = URL(fileURLWithPath: "/tmp/fulldisplay.png")
        if let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(dest, img, nil); CGImageDestinationFinalize(dest)
            saved = "saved /tmp/fulldisplay.png (\(img.width)x\(img.height))"
        }
    } else { saved = "capture failed: \(err?.localizedDescription ?? "?")" }
    s2.signal()
}
_ = s2.wait(timeout: .now() + 5)
print("\n=== full-display capture ===\n  \(saved)")
