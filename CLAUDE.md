# nospoon

P2P VPN over HyperDHT. Creates TUN interfaces, routes IP packets through Noise-encrypted DHT streams.

## Quick reference

- **Two implementations**, one wire protocol:
  - `js/`  — Node.js + koffi (FFI) + HyperDHT
  - `cpp/` — C++ single binary on hyperdht-cpp (default; recommended)
- **Platforms**: Linux, macOS, Android (Kotlin/JNI under `android/`), Windows
- **Nix flake**: `packages.nospoon-js`, `packages.nospoon-cpp` (default), `nixosModules.default`, `devShells.android`
- **CLI** (both impls ship a `nospoon` binary): `nospoon up [config.jsonc]` / `nospoon genkey`

## Repo layout

```
js/         Node.js implementation (bin/, lib/, test/, package.{json,nix}, Dockerfile)
cpp/        C++ port (sources, CMakeLists.txt, package.nix, hyperdht-cpp.nix, bin/win32-*/wintun.dll)
android/    Kotlin VPN client + build.sh that fetches libhyperdht_jni.so from hyperdht-cpp CI
flake.nix   Exposes nospoon-js + nospoon-cpp; default = nospoon-cpp
module.nix  Unified services.nospoon — `package` option picks impl
config.example.jsonc, README.md, ARCHITECTURE.md, LICENSE
.github/workflows/release.yml — 4-target CI for nospoon-cpp release binaries
```

## Architecture

```
js/lib/tun.js                — dispatcher → tun-linux.js | tun-darwin.js | tun-windows.js
js/lib/full-tunnel.js        — dispatcher → full-tunnel-{linux,darwin,windows}.js
js/lib/{server,client}.js    — HyperDHT server / client (auto-reconnect, DHT restart on N failures)
js/lib/{config,validation}.js — JSONC parser + input validation
js/lib/{framing,routing}.js  — Length-prefix framing (25s keepalive); IP packet routing table

cpp/main.cpp                 — entry (signal handlers, sodium_init, dispatch to server/client)
cpp/{server,client}.cpp      — HyperDHT server / client
cpp/{config,framing,routing,validation}.hpp
cpp/tun_{linux,macos,windows}.{hpp,cpp}
cpp/full_tunnel.hpp + full_tunnel_{linux,macos,windows}.cpp
```

## Build commands

**One-command builds (end-user):**

```bash
# JS impl (Node.js, requires Node 18+)
cd js && sudo npm install -g .

# C++ impl (Linux / macOS — Ubuntu shown)
sudo apt install -y build-essential cmake ninja-build pkg-config libsodium-dev libuv1-dev git
cmake -S cpp -B cpp/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build cpp/build

# Nix (either impl)
nix build .#nospoon-cpp   # default
nix build .#nospoon-js

# Android
nix develop .#android && cd android && ./build.sh
```

## Key patterns

- Platform-specific code isolated in `*-linux.*` / `*-darwin.*` / `*-windows.*` files (both impls).
- TUN devices expose roughly the same shape in both: `data` callback, `write(buf)`, `close()`, `name`.
- All TUN I/O is raw Layer 3 IP packets (no headers, no wrappers).
- Full-tunnel uses split routes (0.0.0.0/1 + 128.0.0.0/1) + /32 host route exemption + kill-switch behavior.
- JS uses koffi FFI for native calls; C++ uses platform syscalls directly.
- `cpp/main.cpp:53` `signal(SIGPIPE, SIG_IGN)` is `#ifndef _WIN32` guarded.

## Build system internals (cpp/)

`cpp/CMakeLists.txt` has option `NOSPOON_FETCH_HYPERDHT` (default ON):
- ON  → FetchContent pulls hyperdht-cpp pinned at commit `b8a0ab5` (incl. libudx submodule), forces `BUILD_SHARED_LIBS=OFF` and `HYPERDHT_EXPORT_CXX=ON`. End-user gets a one-command build with hyperdht-cpp + libudx statically absorbed.
- OFF → `find_package(hyperdht CONFIG REQUIRED)`. Used by Nix (sandbox blocks network) — `cpp/package.nix` passes `-DNOSPOON_FETCH_HYPERDHT=OFF` and depends on `cpp/hyperdht-cpp.nix` which builds hyperdht-cpp statically.

Result: nospoon binary embeds hyperdht-cpp + libudx; libsodium + libuv remain dynamic system libs. ~1.3 MB on Linux.

## CI release binaries (.github/workflows/release.yml)

Fires on `push: tags: ['v*']` or manual workflow_dispatch. Four-target matrix:
| Target | Runner | Compiler |
|---|---|---|
| linux-x86_64 | ubuntu-22.04 | gcc |
| linux-aarch64 | ubuntu-22.04-arm | gcc |
| macos-aarch64 | macos-14 | clang |
| windows-x86_64 | windows-latest | **clang-cl** (libudx uses GCC `x ?: 1` extension which MSVC rejects) |

Tag-push run also publishes a GitHub release with all archives via `softprops/action-gh-release@v2`.

## NixOS module

`module.nix` provides `services.nospoon`. `services.nospoon.package` defaults to `self.packages.${pkgs.system}.default` (= nospoon-cpp). Override to `pkgs.nospoon-js` (or any package that ships `bin/nospoon`) to pin.

Server: auto-generates seed at `dataDir/seed` via activation script.

## Dependencies

- JS impl: hyperdht (P2P), koffi (FFI). Only 2 runtime deps.
- C++ impl: hyperdht-cpp (statically linked), libsodium + libuv (dynamic system libs).
- Android: hyperdht-cpp via JNI wrapper (`libhyperdht_jni.so` fetched from hyperdht-cpp CI).

## Branches

- `main` — primary. Contains everything: js/, cpp/, android/.
- `nospoon-cpp` — historical, merged into main on 2026-05-25 via `d07159e`. Kept on origin for reference.
