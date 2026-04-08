#ifdef __linux__

#include <js.h>
#include <assert.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <linux/if.h>
#include <linux/if_tun.h>

// tunCreateLinux(name?) → { fd, name }
js_value_t *
nospoon_tun_create_linux (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];
  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  // Optional name argument
  char name[IFNAMSIZ] = {0};
  if (argc > 0) {
    size_t len;
    err = js_get_value_string_utf8(env, argv[0], (utf8_t *) name, IFNAMSIZ - 1, &len);
    if (err != 0) name[0] = '\0';
  }

  // Open TUN clone device
  int fd = open("/dev/net/tun", O_RDWR);
  if (fd < 0) {
    js_throw_error(env, NULL, "Failed to open /dev/net/tun");
    return NULL;
  }

  // Build ifreq: name + IFF_TUN | IFF_NO_PI
  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));
  ifr.ifr_flags = IFF_TUN | IFF_NO_PI;
  if (name[0]) strncpy(ifr.ifr_name, name, IFNAMSIZ - 1);

  if (ioctl(fd, TUNSETIFF, &ifr) < 0) {
    close(fd);
    js_throw_error(env, NULL, "ioctl TUNSETIFF failed");
    return NULL;
  }

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
  err = js_create_string_utf8(env, (utf8_t *) ifr.ifr_name, -1, &name_val);
  assert(err == 0);
  err = js_set_named_property(env, result, "name", name_val);
  assert(err == 0);

  return result;
}

#endif
