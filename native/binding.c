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

// --- IPC: fd passing via SCM_RIGHTS (Linux/macOS) ---
// Used on Android to receive TUN fd from the Kotlin parent process
// after DHT connects (two-phase startup).
#if defined(__linux__) || defined(__APPLE__)
#include <unistd.h>
#include <sys/socket.h>
#include <string.h>

// recvFd(socketFd) → int (received fd)
static js_value_t *
nospoon_recv_fd (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  uint32_t sockfd;
  err = js_get_value_uint32(env, argv[0], &sockfd);
  assert(err == 0);

  char dummy;
  struct iovec iov = { .iov_base = &dummy, .iov_len = 1 };

  char cmsgbuf[CMSG_SPACE(sizeof(int))];
  memset(cmsgbuf, 0, sizeof(cmsgbuf));

  struct msghdr msg = {
    .msg_iov = &iov,
    .msg_iovlen = 1,
    .msg_control = cmsgbuf,
    .msg_controllen = sizeof(cmsgbuf)
  };

  ssize_t n = recvmsg((int) sockfd, &msg, 0);
  if (n < 0) {
    js_throw_error(env, NULL, "recvFd: recvmsg failed");
    return NULL;
  }

  struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
  if (!cmsg || cmsg->cmsg_level != SOL_SOCKET || cmsg->cmsg_type != SCM_RIGHTS) {
    js_throw_error(env, NULL, "recvFd: no SCM_RIGHTS in message");
    return NULL;
  }

  int received_fd;
  memcpy(&received_fd, CMSG_DATA(cmsg), sizeof(int));

  js_value_t *result;
  err = js_create_int32(env, received_fd, &result);
  assert(err == 0);
  return result;
}

// writeIpc(socketFd, string) — write a line to the IPC socket
static js_value_t *
nospoon_write_ipc (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  uint32_t sockfd;
  err = js_get_value_uint32(env, argv[0], &sockfd);
  assert(err == 0);

  char buf[1024] = {0};
  size_t len;
  err = js_get_value_string_utf8(env, argv[1], (utf8_t *) buf, sizeof(buf) - 2, &len);
  assert(err == 0);
  buf[len] = '\n';

  write((int) sockfd, buf, len + 1);
  return NULL;
}
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

#if defined(__linux__) || defined(__APPLE__)
  V("recvFd", nospoon_recv_fd)
  V("writeIpc", nospoon_write_ipc)
#endif

#undef V

#ifdef _WIN32
  nospoon_tun_windows_exports(env, exports);
#endif

  return exports;
}

BARE_MODULE(nospoon_tun, nospoon_tun_exports)
