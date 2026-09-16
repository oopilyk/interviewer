// Node-API addon: keep an Electron panel from activating this app (and
// therefore from taking focus away from whatever the user is working in).
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

static napi_value Init(napi_env env, napi_value exports) {
  napi_value applyFn;
  napi_value makeKeyFn;
  napi_create_function(env, "apply", NAPI_AUTO_LENGTH, Apply, NULL, &applyFn);
  napi_set_named_property(env, exports, "apply", applyFn);
  napi_create_function(env, "makeKey", NAPI_AUTO_LENGTH, MakeKey, NULL, &makeKeyFn);
  napi_set_named_property(env, exports, "makeKey", makeKeyFn);
  return exports;
}

napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  return Init(env, exports);
}

int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}
