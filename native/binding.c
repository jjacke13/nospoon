#include <bare.h>
#include <js.h>
#include <assert.h>

// Platform-specific TUN creation functions (defined in tun-*.c)
#ifdef __linux__
extern js_value_t *nospoon_tun_create_linux(js_env_t *env, js_callback_info_t *info);
#endif

#ifdef __APPLE__
extern js_value_t *nospoon_tun_create_darwin(js_env_t *env, js_callback_info_t *info);
#endif

#ifdef _WIN32
extern void nospoon_tun_windows_exports(js_env_t *env, js_value_t *exports);
#endif

static js_value_t *
nospoon_tun_exports (js_env_t *env, js_value_t *exports) {
  int err;

#define V(name, fn) \
  { \
    js_value_t *val; \
    err = js_create_function(env, name, -1, fn, NULL, &val); \
    assert(err == 0); \
    err = js_set_named_property(env, exports, name, val); \
    assert(err == 0); \
  }

#ifdef __linux__
  V("tunCreateLinux", nospoon_tun_create_linux)
#endif

#ifdef __APPLE__
  V("tunCreateDarwin", nospoon_tun_create_darwin)
#endif

#undef V

#ifdef _WIN32
  nospoon_tun_windows_exports(env, exports);
#endif

  return exports;
}

BARE_MODULE(nospoon_tun, nospoon_tun_exports)
