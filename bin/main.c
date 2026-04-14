#include <assert.h>
#include <bare.h>
#include <js.h>
#include <rlimit.h>
#include <signal.h>
#include <uv.h>

#include "nospoon.bundle.h"

static uv_sem_t nospoon__platform_ready;
static uv_async_t nospoon__platform_shutdown;
static js_platform_t *nospoon__platform;

static void
nospoon__on_platform_shutdown (uv_async_t *handle) {
  uv_close((uv_handle_t *) handle, NULL);
}

static void
nospoon__on_platform_thread (void *data) {
  int err;

  uv_loop_t loop;
  err = uv_loop_init(&loop);
  assert(err == 0);

  err = uv_async_init(&loop, &nospoon__platform_shutdown, nospoon__on_platform_shutdown);
  assert(err == 0);

  err = js_create_platform(&loop, NULL, &nospoon__platform);
  assert(err == 0);

  uv_sem_post(&nospoon__platform_ready);

  err = uv_run(&loop, UV_RUN_DEFAULT);
  assert(err == 0);

  err = js_destroy_platform(nospoon__platform);
  assert(err == 0);

  err = uv_run(&loop, UV_RUN_DEFAULT);
  assert(err == 0);

  err = uv_loop_close(&loop);
  assert(err == 0);
}

int
main (int argc, char *argv[]) {
  int err;

#ifdef SIGPIPE
  signal(SIGPIPE, SIG_IGN);
#endif

  err = rlimit_set(rlimit_open_files, rlimit_infer);
  assert(err == 0);

  uv_disable_stdio_inheritance();

  argv = uv_setup_args(argc, argv);

  err = uv_sem_init(&nospoon__platform_ready, 0);
  assert(err == 0);

  uv_thread_t thread;
  err = uv_thread_create(&thread, nospoon__on_platform_thread, NULL);
  assert(err == 0);

  uv_sem_wait(&nospoon__platform_ready);

  uv_sem_destroy(&nospoon__platform_ready);

  uv_loop_t *loop = uv_default_loop();

  bare_t *bare;
  err = bare_setup(loop, nospoon__platform, NULL, argc, (const char **) argv, NULL, &bare);
  assert(err == 0);

  uv_buf_t source = uv_buf_init((char *) nospoon_bundle, nospoon_bundle_len);

  err = bare_load(bare, "bare:/nospoon.bundle", &source, NULL);
  (void) err;

  err = bare_run(bare, UV_RUN_DEFAULT);
  assert(err == 0);

  int exit_code;
  err = bare_teardown(bare, UV_RUN_DEFAULT, &exit_code);
  assert(err == 0);

  err = uv_loop_close(loop);
  assert(err == 0);

  err = uv_async_send(&nospoon__platform_shutdown);
  assert(err == 0);

  uv_thread_join(&thread);

  return exit_code;
}
