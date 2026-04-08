#ifdef __APPLE__

#include <js.h>
#include <assert.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/kern_control.h>
#include <sys/sys_domain.h>
#include <net/if_utun.h>

// macOS constants
#define UTUN_CONTROL_NAME "com.apple.net.utun_control"

// tunCreateDarwin() → { fd, name }
js_value_t *
nospoon_tun_create_darwin (js_env_t *env, js_callback_info_t *info) {
  int err;

  // Create PF_SYSTEM socket
  int fd = socket(PF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL);
  if (fd < 0) {
    js_throw_error(env, NULL, "Failed to create PF_SYSTEM socket");
    return NULL;
  }

  // Get control ID for utun
  struct ctl_info ctl = {0};
  strncpy(ctl.ctl_name, UTUN_CONTROL_NAME, sizeof(ctl.ctl_name) - 1);
  if (ioctl(fd, CTLIOCGINFO, &ctl) < 0) {
    close(fd);
    js_throw_error(env, NULL, "ioctl CTLIOCGINFO failed");
    return NULL;
  }

  // Connect with auto-assigned unit
  struct sockaddr_ctl addr = {0};
  addr.sc_len = sizeof(addr);
  addr.sc_family = AF_SYSTEM;
  addr.ss_sysaddr = AF_SYS_CONTROL;
  addr.sc_id = ctl.ctl_id;
  addr.sc_unit = 0; // auto-assign

  if (connect(fd, (struct sockaddr *) &addr, sizeof(addr)) < 0) {
    close(fd);
    js_throw_error(env, NULL, "Failed to create utun device (connect failed)");
    return NULL;
  }

  // Get assigned interface name
  char name[16] = {0};
  socklen_t name_len = sizeof(name);
  getsockopt(fd, SYSPROTO_CONTROL, UTUN_OPT_IFNAME, name, &name_len);

  // Return { fd, name }
  js_value_t *result;
  err = js_create_object(env, &result);
  assert(err == 0);

  js_value_t *fd_val;
  err = js_create_int32(env, fd, &fd_val);
  assert(err == 0);
  err = js_set_named_property(env, result, "fd", fd_val);
  assert(err == 0);

  js_value_t *name_val;
  err = js_create_string_utf8(env, (utf8_t *) name, -1, &name_val);
  assert(err == 0);
  err = js_set_named_property(env, result, "name", name_val);
  assert(err == 0);

  return result;
}

#endif
