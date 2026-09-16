import CoreGraphics
import Foundation
// ALL windows (on and off screen) for the overlay pid.
for onScreenOnly in [true, false] {
    var opt = CGWindowListOption([.excludeDesktopElements])
    if onScreenOnly { opt.insert(.optionOnScreenOnly) }
    let list = (CGWindowListCopyWindowInfo(opt, kCGNullWindowID) as? [[String: Any]]) ?? []
    let mine = list.filter { (($0[kCGWindowOwnerPID as String] as? Int) ?? -1) == 3883 }
    print("onScreenOnly=\(onScreenOnly): \(mine.count) window(s) for pid 3883")
    for w in mine {
        let id = (w[kCGWindowNumber as String] as? UInt32) ?? 0
        let alpha = (w[kCGWindowAlpha as String] as? Double) ?? -1
        let onscreen = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
        var sz = ""
        if let b = w[kCGWindowBounds as String] as? [String: Any] {
            sz = "\(Int((b["Width"] as? Double) ?? 0))x\(Int((b["Height"] as? Double) ?? 0)) @ (\(Int((b["X"] as? Double) ?? 0)),\(Int((b["Y"] as? Double) ?? 0)))"
        }
        print("   id=\(id) onscreen=\(onscreen) alpha=\(alpha) \(sz)")
    }
}
