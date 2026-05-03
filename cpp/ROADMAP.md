# TODO

Loose threads from the initial port, in rough priority order.

## High

- **Graceful shutdown via SIGINT/SIGTERM handler.** Currently Ctrl+C
  terminates the process immediately — the kernel closes the TUN fd,
  but our cleanup block never runs. Full-tunnel mode leaves stale
  iptables / split routes / NRPT DNS rules / IPv6 blackholes that
  require manual `ip route del ...` (or reboot) to clear.
  Fix: install `uv_signal_t` watchers on SIGINT and SIGTERM that flip
  `ctx.running = false`, so the `while (ctx.running && uv_run(...))`
  loop exits naturally and reaches `disable_client_full_tunnel()` /
  `disable_server_forwarding()`. ~10 lines per side.

- **Validate system dependencies at startup.** Right now if you set
  `fullTunnel: true` on a Linux host without `iptables` / `resolvectl`
  installed, the failure shows up as cryptic shell-out exit codes
  mid-connection. Probe for required binaries during `enable_*` and
  refuse to start with a useful error message.

## Medium

- **Actual IPv6 routing through the tunnel.** Today the IPv6 fields
  configure the TUN address, but full-tunnel mode just black-holes
  IPv6 (`::/1` + `8000::/1` via TUN with no peer to receive it).
  Either route IPv6 packets between peers (server side needs IPv6
  forwarding rules + per-peer v6 assignment), or document that
  IPv6-over-tunnel is not supported and the IPv6 TUN address is
  local-only.

- **Restart the DHT after persistent failures, not just drop routes.**
  Today we drop full-tunnel routes after 3 consecutive failures so
  DHT can reach bootstrap again. JS impl additionally destroys the
  whole HyperDHT instance and creates a fresh one. Closer to JS
  behavior, but adds lifetime complexity (DHT lives behind a
  unique_ptr, lambdas need to handle the swap).

## Low / nice-to-have

- **Static-build option for single-file distribution.** Add a
  `HYPERDHT_STATIC` CMake flag that switches from `find_package(hyperdht
  CONFIG)` to linking the static archive + udx.a, plus
  `-ffunction-sections -Wl,--gc-sections -flto` for size. Drops the
  runtime `libhyperdht.so` dependency. Useful when shipping nospoon
  as a single binary to users who don't have hyperdht-cpp installed.

- **Per-connection keepalive timer instead of one global tick.** JS
  starts a keepalive interval per connection. We have one global 25s
  timer that broadcasts to all peers — slightly less responsive on
  asymmetric peer load, slightly less code. Probably never matters in
  practice.

- **GitHub Actions CI.** No workflow shipped yet for this repo —
  Linux + macOS builds + a Windows build (the Windows artifact is
  currently produced by hyperdht-cpp's CI; should move here).
