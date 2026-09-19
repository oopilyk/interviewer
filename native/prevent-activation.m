// Node-API addon: keep an Electron panel from activating this app (and
// therefore from taking focus away from whatever the user is working in), and
// keep the overlay from touching the mouse cursor (see freezeCursor below).
//
// Electron's type:"panel" ORs NSWindowStyleMaskNonactivatingPanel onto an
// NSWindow subclass, not a real NSPanel. AppKit only sets the window-server
// "prevents activation" tag during NSPanel init, so clicks still activate
// Electron and the browser/editor behind the overlay loses focus. This calls
// the same private AppKit setter NSPanel uses, and stops the window becoming
// the main window (it can still be key, so typing in the chat works).

#import <AppKit/AppKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <stddef.h>
#include <stdint.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
typedef int napi_status;

extern napi_status napi_get_cb_info(napi_env env, napi_callback_info cbinfo, size_t *argc, napi_value *argv, napi_value *this_arg, void **data);
extern napi_status napi_get_buffer_info(napi_env env, napi_value value, void **data, size_t *length);
extern napi_status napi_create_function(napi_env env, const char *utf8name, size_t length, napi_callback cb, void *data, napi_value *result);
extern napi_status napi_set_named_property(napi_env env, napi_value object, const char *utf8name, napi_value value);
extern napi_status napi_get_undefined(napi_env env, napi_value *result);
extern napi_status napi_throw_error(napi_env env, const char *code, const char *msg);

#define NAPI_AUTO_LENGTH ((size_t)-1)

static BOOL Cluely_canBecomeMainWindow(id self, SEL _cmd) {
  (void)self;
  (void)_cmd;
  return NO;
}

static NSWindow *windowFromHandle(void *data, size_t len) {
  if (!data || len < sizeof(void *)) return nil;
  void *ptr = *(void **)data;
  if (!ptr) return nil;
  NSView *view = (__bridge NSView *)ptr;
  if (![view isKindOfClass:[NSView class]]) return nil;
  return view.window;
}

static void preventActivation(NSWindow *window) {
  SEL sel = NSSelectorFromString(@"_setPreventsActivation:");
  if ([window respondsToSelector:sel]) {
    ((void (*)(id, SEL, BOOL))objc_msgSend)(window, sel, YES);
  }

  // Override on this class only (do not patch ElectronNSWindow / DevTools).
  class_replaceMethod([window class], @selector(canBecomeMainWindow),
                      (IMP)Cluely_canBecomeMainWindow, "c@:");

  // Hidden titled chrome on rounded frameless windows is an activating hit
  // target (electron#46880). CSS still draws the rounded overlay.
  NSWindowStyleMask mask = window.styleMask;
  if (mask & NSWindowStyleMaskTitled) {
    NSRect frame = window.frame;
    window.styleMask = mask & ~NSWindowStyleMaskTitled;
    [window setFrame:frame display:NO];
  }

  window.hidesOnDeactivate = NO;
}

// --- Frozen cursor ----------------------------------------------------------
// The overlay is invisible to screen share, so anything it changes about the
// *visible* desktop gives it away -- and the cursor is the loudest tell: move
// the pointer over an invisible panel and the I-beam of the text field below it
// turns into an arrow, into a finger over one of the overlay's buttons, or into
// resize arrows along its edges.
//
// macOS has no per-window "leave the cursor alone" switch: the cursor is global
// state, and whichever app the pointer is over sets it (AppKit from cursor
// rects and the window frame, Chromium from the web page's CSS cursor). So this
// blocks every door AppKit has to the cursor for as long as the pointer is
// inside the overlay, which leaves the cursor exactly as the app underneath
// last drew it. Other windows of this process (DevTools) are not in the list
// and keep their normal cursors.
static NSHashTable *gFrozenWindows;  // weak; the overlay, normally just one

// A window's resize zone reaches a few points past its own edges, and that is
// where the frame hands out the double arrows, so suppress a little wider than
// the frame itself.
static const CGFloat kFrozenSlop = 12.0;

static BOOL pointerIsOverFrozenWindow(void) {
  if (gFrozenWindows.count == 0) return NO;
  NSPoint p = [NSEvent mouseLocation];
  for (NSWindow *window in gFrozenWindows) {
    if (!window.isVisible) continue;
    // A resize drag pulls the pointer far past the slop; stay frozen for all of it.
    if (window.inLiveResize) return YES;
    if (NSPointInRect(p, NSInsetRect(window.frame, -kFrozenSlop, -kFrozenSlop))) return YES;
  }
  return NO;
}

// The doors: -set and -forceSet for ordinary cursors, +_setOverrideCursor: for
// the ones the window frame imposes (the resize arrows), -_reallySet as the
// sink they all drain into. -push/+pop are deliberately left alone so the
// cursor stack stays balanced; they just no longer put anything on screen.
static IMP gOrigSet, gOrigForceSet, gOrigReallySet;
static IMP gOrigOverride, gOrigOverrideType, gOrigClearOverride;

static void Cluely_set(id self, SEL _cmd) {
  if (pointerIsOverFrozenWindow()) return;
  ((void (*)(id, SEL))gOrigSet)(self, _cmd);
}

static id Cluely_forceSet(id self, SEL _cmd) {
  if (pointerIsOverFrozenWindow()) return self;
  return ((id (*)(id, SEL))gOrigForceSet)(self, _cmd);
}

static void Cluely_reallySet(id self, SEL _cmd) {
  if (pointerIsOverFrozenWindow()) return;
  ((void (*)(id, SEL))gOrigReallySet)(self, _cmd);
}

static void Cluely_setOverrideCursor(id self, SEL _cmd, id cursor) {
  if (pointerIsOverFrozenWindow()) return;
  ((void (*)(id, SEL, id))gOrigOverride)(self, _cmd, cursor);
}

static void Cluely_setOverrideCursorType(id self, SEL _cmd, id cursor, long long type) {
  if (pointerIsOverFrozenWindow()) return;
  ((void (*)(id, SEL, id, long long))gOrigOverrideType)(self, _cmd, cursor, type);
}

static void Cluely_clearOverrideCursor(id self, SEL _cmd) {
  if (pointerIsOverFrozenWindow()) return;
  ((void (*)(id, SEL))gOrigClearOverride)(self, _cmd);
}

// Class methods are instance methods of the metaclass, so one helper does both.
static void swizzleCursorMethod(Class cls, const char *name, IMP replacement, IMP *original) {
  if (*original) return;
  Method method = class_getInstanceMethod(cls, sel_registerName(name));
  if (!method) return;  // a private selector that this macOS release dropped
  *original = method_setImplementation(method, replacement);
}

static void freezeCursorOver(NSWindow *window) {
  if (!gFrozenWindows) gFrozenWindows = [NSHashTable weakObjectsHashTable];
  [gFrozenWindows addObject:window];

  Class cursor = [NSCursor class];
  Class meta = object_getClass(cursor);
  swizzleCursorMethod(cursor, "set", (IMP)Cluely_set, &gOrigSet);
  swizzleCursorMethod(cursor, "forceSet", (IMP)Cluely_forceSet, &gOrigForceSet);
  swizzleCursorMethod(cursor, "_reallySet", (IMP)Cluely_reallySet, &gOrigReallySet);
  swizzleCursorMethod(meta, "_setOverrideCursor:", (IMP)Cluely_setOverrideCursor, &gOrigOverride);
  swizzleCursorMethod(meta, "_setOverrideCursor:type:", (IMP)Cluely_setOverrideCursorType, &gOrigOverrideType);
  swizzleCursorMethod(meta, "_clearOverrideCursorAndSetArrow", (IMP)Cluely_clearOverrideCursor, &gOrigClearOverride);
}

static napi_value Apply(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_error(env, NULL, "apply(handle) requires the native window handle");
    return NULL;
  }

  void *data = NULL;
  size_t len = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &len) != 0) {
    napi_throw_error(env, NULL, "apply(handle) expected a Buffer");
    return NULL;
  }

  @autoreleasepool {
    NSWindow *window = windowFromHandle(data, len);
    if (!window) {
      napi_throw_error(env, NULL, "native handle is not an NSView with a window");
      return NULL;
    }
    preventActivation(window);
  }

  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

// Become the key window (receive typing) without makeKeyAndOrderFront, which
// activates the app on a non-NSPanel NSWindow.
static napi_value MakeKey(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL;
  size_t len = 0;
  if (argc < 1 || napi_get_buffer_info(env, argv[0], &data, &len) != 0) {
    napi_throw_error(env, NULL, "makeKey(handle) expected a Buffer");
    return NULL;
  }

  @autoreleasepool {
    NSWindow *window = windowFromHandle(data, len);
    if (!window) {
      napi_throw_error(env, NULL, "native handle is not an NSView with a window");
      return NULL;
    }
    preventActivation(window);
    [window orderFrontRegardless];
    [window makeKeyWindow];
  }

  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

// Stop this process from changing the mouse cursor while the pointer is inside
// the given window.
static napi_value FreezeCursor(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL;
  size_t len = 0;
  if (argc < 1 || napi_get_buffer_info(env, argv[0], &data, &len) != 0) {
    napi_throw_error(env, NULL, "freezeCursor(handle) expected a Buffer");
    return NULL;
  }

  @autoreleasepool {
    NSWindow *window = windowFromHandle(data, len);
    if (!window) {
      napi_throw_error(env, NULL, "native handle is not an NSView with a window");
      return NULL;
    }
    freezeCursorOver(window);
  }

  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value applyFn;
  napi_value makeKeyFn;
  napi_create_function(env, "apply", NAPI_AUTO_LENGTH, Apply, NULL, &applyFn);
  napi_set_named_property(env, exports, "apply", applyFn);
  napi_create_function(env, "makeKey", NAPI_AUTO_LENGTH, MakeKey, NULL, &makeKeyFn);
  napi_set_named_property(env, exports, "makeKey", makeKeyFn);
  napi_value freezeCursorFn;
  napi_create_function(env, "freezeCursor", NAPI_AUTO_LENGTH, FreezeCursor, NULL, &freezeCursorFn);
  napi_set_named_property(env, exports, "freezeCursor", freezeCursorFn);
  return exports;
}

napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  return Init(env, exports);
}

int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}
