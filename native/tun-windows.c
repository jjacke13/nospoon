#ifdef _WIN32

#include <js.h>
#include <assert.h>
#include <windows.h>
#include <stdint.h>
#include <string.h>

// Wintun types and function pointers (loaded at runtime via LoadLibrary)
typedef void *WINTUN_ADAPTER_HANDLE;
typedef void *WINTUN_SESSION_HANDLE;

typedef WINTUN_ADAPTER_HANDLE (WINAPI *WintunCreateAdapterFn)(const WCHAR *, const WCHAR *, const GUID *);
typedef WINTUN_ADAPTER_HANDLE (WINAPI *WintunOpenAdapterFn)(const WCHAR *);
typedef void (WINAPI *WintunCloseAdapterFn)(WINTUN_ADAPTER_HANDLE);
typedef WINTUN_SESSION_HANDLE (WINAPI *WintunStartSessionFn)(WINTUN_ADAPTER_HANDLE, DWORD);
typedef void (WINAPI *WintunEndSessionFn)(WINTUN_SESSION_HANDLE);
typedef HANDLE (WINAPI *WintunGetReadWaitEventFn)(WINTUN_SESSION_HANDLE);
typedef BYTE *(WINAPI *WintunReceivePacketFn)(WINTUN_SESSION_HANDLE, DWORD *);
typedef void (WINAPI *WintunReleaseReceivePacketFn)(WINTUN_SESSION_HANDLE, const BYTE *);
typedef BYTE *(WINAPI *WintunAllocateSendPacketFn)(WINTUN_SESSION_HANDLE, DWORD);
typedef void (WINAPI *WintunSendPacketFn)(WINTUN_SESSION_HANDLE, const BYTE *);
typedef DWORD (WINAPI *WintunGetRunningDriverVersionFn)(void);

// Global function pointers (loaded once)
static HMODULE wintun_dll = NULL;
static WintunCreateAdapterFn pWintunCreateAdapter;
static WintunOpenAdapterFn pWintunOpenAdapter;
static WintunCloseAdapterFn pWintunCloseAdapter;
static WintunStartSessionFn pWintunStartSession;
static WintunEndSessionFn pWintunEndSession;
static WintunGetReadWaitEventFn pWintunGetReadWaitEvent;
static WintunReceivePacketFn pWintunReceivePacket;
static WintunReleaseReceivePacketFn pWintunReleaseReceivePacket;
static WintunAllocateSendPacketFn pWintunAllocateSendPacket;
static WintunSendPacketFn pWintunSendPacket;
static WintunGetRunningDriverVersionFn pWintunGetRunningDriverVersion;

// wintunLoad(dllPath) → true/false
static js_value_t *
nospoon_wintun_load (js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  char path[MAX_PATH] = {0};
  size_t len;
  err = js_get_value_string_utf8(env, argv[0], (utf8_t *) path, sizeof(path) - 1, &len);
  assert(err == 0);

  // Convert UTF-8 path to wide string
  WCHAR wpath[MAX_PATH];
  MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, MAX_PATH);

  wintun_dll = LoadLibraryW(wpath);
  if (!wintun_dll) {
    js_throw_error(env, NULL, "Failed to load wintun.dll");
    return NULL;
  }

#define LOAD(name) \
  p##name = (name##Fn) GetProcAddress(wintun_dll, #name); \
  if (!p##name) { FreeLibrary(wintun_dll); wintun_dll = NULL; \
    js_throw_error(env, NULL, "Missing wintun function: " #name); return NULL; }

  LOAD(WintunCreateAdapter)
  LOAD(WintunOpenAdapter)
  LOAD(WintunCloseAdapter)
  LOAD(WintunStartSession)
  LOAD(WintunEndSession)
  LOAD(WintunGetReadWaitEvent)
  LOAD(WintunReceivePacket)
  LOAD(WintunReleaseReceivePacket)
  LOAD(WintunAllocateSendPacket)
  LOAD(WintunSendPacket)
  LOAD(WintunGetRunningDriverVersion)
#undef LOAD

  js_value_t *result;
  err = js_get_boolean(env, true, &result);
  assert(err == 0);
  return result;
}

// wintunCreateAdapter(name, type) → adapter handle (as external)
static js_value_t *
nospoon_wintun_create_adapter (js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 2;
  js_value_t *argv[2];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  char name[256] = {0}, type[256] = {0};
  size_t len;
  js_get_value_string_utf8(env, argv[0], (utf8_t *) name, sizeof(name) - 1, &len);
  js_get_value_string_utf8(env, argv[1], (utf8_t *) type, sizeof(type) - 1, &len);

  WCHAR wname[256], wtype[256];
  MultiByteToWideChar(CP_UTF8, 0, name, -1, wname, 256);
  MultiByteToWideChar(CP_UTF8, 0, type, -1, wtype, 256);

  WINTUN_ADAPTER_HANDLE adapter = pWintunCreateAdapter(wname, wtype, NULL);
  if (!adapter) {
    js_throw_error(env, NULL, "Failed to create Wintun adapter");
    return NULL;
  }

  js_value_t *result;
  err = js_create_external(env, adapter, NULL, NULL, &result);
  assert(err == 0);
  return result;
}

// wintunOpenAdapter(name) → adapter handle or null
static js_value_t *
nospoon_wintun_open_adapter (js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  char name[256] = {0};
  size_t len;
  js_get_value_string_utf8(env, argv[0], (utf8_t *) name, sizeof(name) - 1, &len);

  WCHAR wname[256];
  MultiByteToWideChar(CP_UTF8, 0, name, -1, wname, 256);

  WINTUN_ADAPTER_HANDLE adapter = pWintunOpenAdapter(wname);
  if (!adapter) {
    js_value_t *null_val;
    js_get_null(env, &null_val);
    return null_val;
  }

  js_value_t *result;
  err = js_create_external(env, adapter, NULL, NULL, &result);
  assert(err == 0);
  return result;
}

// wintunCloseAdapter(adapter)
static js_value_t *
nospoon_wintun_close_adapter (js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  void *adapter;
  err = js_get_value_external(env, argv[0], &adapter);
  assert(err == 0);

  pWintunCloseAdapter(adapter);
  return NULL;
}

// wintunStartSession(adapter, capacity) → session handle
static js_value_t *
nospoon_wintun_start_session (js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 2;
  js_value_t *argv[2];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  void *adapter;
  err = js_get_value_external(env, argv[0], &adapter);
  assert(err == 0);

  uint32_t capacity;
  err = js_get_value_uint32(env, argv[1], &capacity);
  assert(err == 0);

  WINTUN_SESSION_HANDLE session = pWintunStartSession(adapter, capacity);
  if (!session) {
    js_throw_error(env, NULL, "Failed to start Wintun session");
    return NULL;
  }

  js_value_t *result;
  err = js_create_external(env, session, NULL, NULL, &result);
  assert(err == 0);
  return result;
}

// wintunEndSession(session)
static js_value_t *
nospoon_wintun_end_session (js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  void *session;
  err = js_get_value_external(env, argv[0], &session);
  assert(err == 0);

  pWintunEndSession(session);
  return NULL;
}

// wintunGetReadWaitEvent(session) → event handle (as external)
static js_value_t *
nospoon_wintun_get_read_wait_event (js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  void *session;
  err = js_get_value_external(env, argv[0], &session);
  assert(err == 0);

  HANDLE event = pWintunGetReadWaitEvent(session);

  js_value_t *result;
  err = js_create_external(env, event, NULL, NULL, &result);
  assert(err == 0);
  return result;
}

// wintunReceivePacket(session) → Buffer or null
static js_value_t *
nospoon_wintun_receive_packet (js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  void *session;
  err = js_get_value_external(env, argv[0], &session);
  assert(err == 0);

  DWORD size = 0;
  BYTE *data = pWintunReceivePacket(session, &size);
  if (!data) {
    js_value_t *null_val;
    js_get_null(env, &null_val);
    return null_val;
  }

  // Copy data out of ring buffer into a JS ArrayBuffer
  js_value_t *arraybuffer;
  void *buf;
  err = js_create_arraybuffer(env, size, &buf, &arraybuffer);
  assert(err == 0);
  memcpy(buf, data, size);

  // Release the ring buffer slot
  pWintunReleaseReceivePacket(session, data);

  // Wrap as Uint8Array (Buffer)
  js_value_t *result;
  err = js_create_typedarray(env, js_uint8array, size, arraybuffer, 0, &result);
  assert(err == 0);
  return result;
}

// wintunSendPacket(session, buffer)
static js_value_t *
nospoon_wintun_send_packet (js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 2;
  js_value_t *argv[2];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  void *session;
  err = js_get_value_external(env, argv[0], &session);
  assert(err == 0);

  void *data;
  size_t len;
  err = js_get_typedarray_info(env, argv[1], NULL, &data, &len, NULL, NULL);
  assert(err == 0);

  BYTE *send_buf = pWintunAllocateSendPacket(session, (DWORD) len);
  if (!send_buf) {
    // Ring buffer full or session terminated — return false
    js_value_t *result;
    js_get_boolean(env, false, &result);
    return result;
  }

  memcpy(send_buf, data, len);
  pWintunSendPacket(session, send_buf);

  js_value_t *result;
  js_get_boolean(env, true, &result);
  return result;
}

// wintunGetRunningDriverVersion() → int
static js_value_t *
nospoon_wintun_get_driver_version (js_env_t *env, js_callback_info_t *info) {
  int err;
  DWORD ver = pWintunGetRunningDriverVersion();

  js_value_t *result;
  err = js_create_uint32(env, ver, &result);
  assert(err == 0);
  return result;
}

// wintunGetLastError() → int
static js_value_t *
nospoon_wintun_get_last_error (js_env_t *env, js_callback_info_t *info) {
  int err;
  js_value_t *result;
  err = js_create_uint32(env, GetLastError(), &result);
  assert(err == 0);
  return result;
}

// waitForSingleObject(handle, timeout) → status (sync, for batch loop)
static js_value_t *
nospoon_wait_for_single_object (js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 2;
  js_value_t *argv[2];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  void *handle;
  err = js_get_value_external(env, argv[0], &handle);
  assert(err == 0);

  uint32_t timeout;
  err = js_get_value_uint32(env, argv[1], &timeout);
  assert(err == 0);

  DWORD status = WaitForSingleObject(handle, timeout);

  js_value_t *result;
  err = js_create_uint32(env, status, &result);
  assert(err == 0);
  return result;
}

// Export all Windows functions
void
nospoon_tun_windows_exports (js_env_t *env, js_value_t *exports) {
  int err;

#define V(name, fn) \
  { \
    js_value_t *val; \
    err = js_create_function(env, name, -1, fn, NULL, &val); \
    assert(err == 0); \
    err = js_set_named_property(env, exports, name, val); \
    assert(err == 0); \
  }

  V("wintunLoad", nospoon_wintun_load)
  V("wintunCreateAdapter", nospoon_wintun_create_adapter)
  V("wintunOpenAdapter", nospoon_wintun_open_adapter)
  V("wintunCloseAdapter", nospoon_wintun_close_adapter)
  V("wintunStartSession", nospoon_wintun_start_session)
  V("wintunEndSession", nospoon_wintun_end_session)
  V("wintunGetReadWaitEvent", nospoon_wintun_get_read_wait_event)
  V("wintunReceivePacket", nospoon_wintun_receive_packet)
  V("wintunSendPacket", nospoon_wintun_send_packet)
  V("wintunGetDriverVersion", nospoon_wintun_get_driver_version)
  V("wintunGetLastError", nospoon_wintun_get_last_error)
  V("waitForSingleObject", nospoon_wait_for_single_object)
#undef V
}

#endif
