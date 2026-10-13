# TODO

Remaining work from the initial port, in rough priority order.
Reconciled with source on 2026-10-13; implemented items are listed separately below.

## High

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

## Low / nice-to-have

- **Per-connection keepalive timer instead of one global tick.** JS
  starts a keepalive interval per connection. We have one global 25s
  timer that broadcasts to all peers — slightly less responsive on
  asymmetric peer load, slightly less code. Probably never matters in
  practice.

## Implemented

- **Restart the DHT after persistent failures.** `cpp/client.cpp` drops
  active full-tunnel routes after three failures, destroys the old DHT and
  binds a fresh instance. Generation checks reject stale callbacks; old
  instance deletion is deferred while libuv drains close callbacks.
- **Single-file Linux distribution.** `flake.nix` builds native fully-static
  musl `nospoon-cpp` and `nospoon-cpp-debug` outputs with the transport and
  dependencies linked in. macOS remains dynamic; Windows also needs
  `wintun.dll`. No additional `HYPERDHT_STATIC` switch is needed.
- **GitHub Actions release builds.** `.github/workflows/release.yml` builds
  release/debug variants for Linux x86_64/aarch64, macOS arm64 and Windows
  x86_64, with artifact checks. It runs on version tags or manual dispatch;
  this does not provide a push/PR test gate.
