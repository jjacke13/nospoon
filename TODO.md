# TODO

## Bugs

- [x] **Slow shutdown (Linux only)** — Fixed: keepalive timers now cleared
      on shutdown, route/NAT cleanup uses async `execFile` instead of blocking
      `execFileSync`, `dht.destroy()` awaited with 2s fallback `process.exit`.

## Needs Testing

- [ ] **IPv6** — Dual-stack is implemented (`ip` config field accepts IPv6 CIDR,
      routing auto-detects IP version from packet header) but hasn't been tested
      end-to-end.

## Networking

- [x] **DNS switching in full-tunnel mode** — DNS is automatically set to
      1.1.1.1 / 8.8.8.8 when full-tunnel activates. Original DNS restored
      on disconnect.

- [ ] **Server-assigned IPs in open mode** — Instead of clients picking their
      own IP (collision-prone), the server should assign IPs from the subnet
      pool when a client connects without a pre-configured peer entry.

- [ ] **Custom DNS** — Allow a `dns` config field to specify a custom DNS
      server (e.g. a Pi-hole). Requires adding a host route exemption for
      the DNS server IP so queries bypass the tunnel and reach the DNS
      server directly, similar to the DHT server exemption.

- [ ] **Split tunneling helpers** — Allow a `routes` config field to only
      send specific subnets through the tunnel (e.g. `"routes": ["192.168.1.0/24"]`).

- [ ] **Upstream fwmark support (udx-native)** — Add a `fwmark` option to
      [udx-native](https://github.com/holepunchto/udx-native) so every UDP
      socket gets `setsockopt(SO_MARK)` at creation time. Then HyperDHT can
      do `new HyperDHT({ fwmark: 51820 })` — same as WireGuard. This would
      replace the split routes + DHT restart with proper policy routing and
      eliminate the brief leak window during reconnection. ~10 lines of C++
      in udx-native + plumbing through dht-rpc and hyperdht.

## Security

- [x] **`--seed-file` flag** — Replaced by `seedFile` in config file.
      Seed no longer visible in process listings.

- [ ] **Key rotation** — Allow rotating the server seed without reconfiguring
      all clients. Could use a "key announcement" protocol.

- [ ] **Rate limiting** — Limit connection attempts per public key to prevent
      abuse in open mode.

- [ ] **Peer banning** — Allow the server to block specific client keys at
      runtime.

## Performance

- [ ] **Backpressure handling** — If the TUN device or HyperDHT stream can't
      keep up, apply backpressure instead of buffering indefinitely. Use
      Node.js stream `.pause()` / `.resume()`.

- [ ] **MTU discovery** — Auto-detect optimal MTU based on path MTU instead
      of using a fixed default.

- [ ] **Benchmark** — Measure throughput and latency vs WireGuard and plain
      holesail to quantify overhead.

## Android Battery Optimization

Quick wins (< 1 day each):
- [ ] **Increase DHT keepalive on battery** — Pass `connectionKeepAlive: 30000`
      to HyperDHT when on battery (default 5000ms). 6x reduction in UDP traffic.
- [ ] **Dynamic framing keepalive** — 55s on cellular, 25s on WiFi (currently
      fixed 25s). Most NAT timeouts are 60s+ for UDP.
- [ ] **Skip redundant keepalives** — Track last-packet-sent time, only send
      keepalive if no traffic within the interval.
- [ ] **Request battery optimization exemption** — Prompt user via
      `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (acceptable for VPN apps).
- [ ] **`setUnderlyingNetworks()`** — Call on network change for correct battery
      attribution.
- [ ] **`.unref()` all timers** — Audit DHT/worklet timers so the JS event loop
      can reach true idle between keepalives.

Medium effort (1-3 days):
- [ ] **Network-aware adaptation** — `ConnectivityManager.NetworkCallback` to
      detect WiFi/cellular, adjust keepalive intervals and debounce reconnection.
- [ ] **Charging-aware mode** — `BatteryManager` listener: aggressive keepalives
      when charging, conservative on battery.
- [ ] **Doze-aware reconnection** — Detect Doze via
      `ACTION_DEVICE_IDLE_MODE_CHANGED`, pause keepalives during Doze, reset
      backoff on Doze exit.
- [ ] **Write coalescing** — Batch TUN packets before encryption to reduce UDP
      datagrams and radio wakeups.

Major (1+ week):
- [ ] **"Silent when idle" mode** — Once tunnel is established, stop DHT routing
      maintenance. Send keepalives only at NAT timeout threshold. Reconnect via
      DHT only when needed. This is how WireGuard achieves <1% battery/day.

## Usability

- [x] **systemd service** — Provided by the NixOS module (`services.nospoon`).

- [x] **NixOS module** — Declarative NixOS configuration
      (`services.nospoon.server.enable = true`).

- [x] **Config file** — JSONC config replaces CLI flags. `nospoon up [config]`
      for both server and client. See `config.example.jsonc`.

- [ ] **Logging** — Structured logging with verbosity levels (e.g. `logLevel`
      config field). Currently all output goes to console.log.

- [ ] **Status command** — `nospoon status` to show connected peers,
      traffic stats, uptime.

## Platform Support

- [x] **Android** — Kotlin VpnService + Bare worklet + bare-kit IPC.
      See `android-support` branch.

- [x] **macOS** — utun via Koffi, platform dispatchers for tun and full-tunnel.
      Merged to main.

- [ ] **Windows server NAT (full-tunnel)** — `New-NetNat` (`MSFT_NetNat` WMI class)
      is broken/missing on some Windows 11 Pro installs and all VMs. `NetNat.dll`
      and `NetNat.mof` don't exist. `netsh routing ip nat` (RRAS) also unavailable.
      Need to research: reinstalling the NetNat provider, or alternative NAT methods
      (ICS, WinDivert). Windows client full-tunnel works fine — this only affects
      running a server on Windows. Low priority since Linux is the recommended
      server platform.

## Documentation

- [ ] **Architecture diagram** — Visual overview of the protocol stack
      (TUN → framing → HyperDHT → UDP → internet).

- [ ] **Security audit** — Document the threat model. What is encrypted, what
      isn't. What happens if the seed leaks. Trust model.

## Build & Distribution

- [ ] **Single binary** — Package as a standalone Linux binary. Best options:
      - **esbuild + node tarball**: bundle JS, ship with `.node` files and a
        Node binary in a tarball. Not single-file but works.
      - **Bun `--compile`**: can embed `.node` files directly, but
        `require-addon` pattern (used by sodium-native, udx-native) is
        untested with Bun. Needs a proof-of-concept.

- [ ] **Strip non-target prebuilds** — sodium-native and udx-native ship
      prebuilds for 13 platforms (18 MB + 5 MB). Keeping only linux-x64 and
      linux-arm64 saves ~19 MB. Can be done in Nix fixup phase or a
      post-install script.

- [ ] **Android: replace `gh` with `curl` in build.sh** — Use `curl -L`
      to download bare-kit prebuilds instead of `gh release download`.
      Removes the `gh` auth requirement and the `gh` dependency from
      `shell.nix`. Already tested and working on macOS.

- [ ] **Android: arm64-only APK** — Build only for `arm64-v8a` instead of
      all 4 architectures to reduce APK size. Requires: `bare-link --host
      android-arm64`, `bare-pack --host android-arm64`, extracting only
      `arm64-v8a` from bare-kit prebuilds, and adding `abiFilters += "arm64-v8a"`
      in `build.gradle.kts`.
