# nospoon

> *"There is no spoon."* — The Matrix (1999)

A peer-to-peer VPN that **eliminates the need for a publicly reachable server**. Built on [HyperDHT](https://github.com/holepunchto/hyperdht) for NAT hole-punching and Noise-encrypted tunnels. No public IP, no port forwarding, no central infrastructure — just a key.

## Two implementations, one wire protocol

nospoon ships in two interchangeable implementations:

- **nospoon-cpp** — single-binary C++ port built on [hyperdht-cpp](https://github.com/jjacke13/hyperdht-cpp). Smaller, faster, no Node.js runtime needed. **Recommended.**
- **nospoon-js** — Node.js implementation, the original. Multi-year track record.

Both speak the same framing + DHT protocol, so a JS server can talk to a C++ client and vice-versa. Pick either; the config files are byte-for-byte compatible.

## Install

### npm (JS implementation)

```bash
sudo npm install -g nospoon
```

Requires Node.js 18+. Root/admin needed for TUN device creation.

### Nix flake (Linux + macOS)

```bash
# C++ binary (default — recommended)
nix run github:jjacke13/nospoon

# JS implementation
nix run github:jjacke13/nospoon#nospoon-js

# Explicit selection
nix build github:jjacke13/nospoon#nospoon-cpp
nix build github:jjacke13/nospoon#nospoon-js
```

NixOS module:

```nix
{
  inputs.nospoon.url = "github:jjacke13/nospoon";

  outputs = { self, nixpkgs, nospoon }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      modules = [
        nospoon.nixosModules.default
        ({ pkgs, ... }: {
          # Default is the C++ binary. To pin to JS:
          # services.nospoon.package = nospoon.packages.${pkgs.system}.nospoon-js;
          services.nospoon = {
            enable = true;
            mode = "client";
            serverAddress = "<server-pubkey-hex>";
            seedFile = "/etc/nospoon/seed";
          };
        })
      ];
    };
  };
}
```

### Build C++ from source

CMake's `FetchContent` pulls hyperdht-cpp + libudx from GitHub at build
time and links them statically into the nospoon binary. Single-step
build, no separate hyperdht install needed.

**Ubuntu / Debian:**

```bash
sudo apt install -y build-essential cmake ninja-build pkg-config \
    libsodium-dev libuv1-dev git
cmake -S cpp -B cpp/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    && cmake --build cpp/build
sudo cpp/build/nospoon up config.jsonc
```

**Fedora / RHEL:**

```bash
sudo dnf install -y gcc-c++ cmake ninja-build pkg-config \
    libsodium-devel libuv-devel git
cmake -S cpp -B cpp/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    && cmake --build cpp/build
```

**Arch:**

```bash
sudo pacman -S --needed base-devel cmake ninja pkg-config libsodium libuv git
cmake -S cpp -B cpp/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    && cmake --build cpp/build
```

**macOS (Homebrew):**

```bash
brew install cmake ninja pkg-config libsodium libuv
cmake -S cpp -B cpp/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    && cmake --build cpp/build
```

To skip the FetchContent path and link against a pre-built hyperdht-cpp
install (e.g. for offline builds or vendor pinning), pass
`-DNOSPOON_FETCH_HYPERDHT=OFF -DCMAKE_PREFIX_PATH=<install-prefix>`.

### Docker (Linux only)

```bash
cd js
docker build -t nospoon .
docker run --network=host --cap-add=NET_ADMIN --device /dev/net/tun \
  -v /path/to/config.jsonc:/etc/nospoon/config.jsonc \
  nospoon up
```

`--network=host` shares the host's network stack. Not supported on macOS (Docker runs in a VM).

### Android

A Kotlin VPN client lives under `android/`. Build via Android Studio or:

```bash
nix develop .#android
cd android && ./build.sh
```

The `libhyperdht_jni.so` is downloaded from hyperdht-cpp CI by the build script. See `android/FRONTEND-TODO.md` for upcoming work.

## Use Cases

### 1. Expose any service through NAT

Like [HoleSail](https://holesail.io/) but at Layer 3 — instead of forwarding a single port, nospoon creates a full network interface. Every service on the server is reachable by IP, as if you were on the same LAN.

```bash
# Generate a client identity
nospoon genkey
# Output: Seed (keep secret): abc123...
#         Public key (share): def456...
```

Server config (`/etc/nospoon/config.jsonc`):
```jsonc
{
  "mode": "server",
  "peers": {
    "<client-public-key>": "10.0.0.2"
  }
}
```

Client config:
```jsonc
{
  "mode": "client",
  "server": "<server-public-key>",
  "seed": "<client-seed>",
  "ip": "10.0.0.2/24"
}
```

```bash
# Server (behind NAT, no port forwarding needed)
sudo nospoon up /etc/nospoon/config.jsonc

# Client (anywhere in the world)
sudo nospoon up client.jsonc

# Access anything on the server
curl http://10.0.0.1:8080       # web app
ssh user@10.0.0.1               # SSH
ping 10.0.0.1                   # ICMP
```

Using `peers` is recommended — it authenticates clients and assigns fixed IPs. Open mode (omitting `peers`) is available for quick testing but has no authentication and only supports a single client.

### 2. Full tunnel — access the internet from home

Route all your internet traffic through your home connection. When you're abroad, your traffic exits from your home IP — access geo-restricted content, use your home network's DNS, or just browse as if you were home.

Server config:
```jsonc
{
  "mode": "server",
  "fullTunnel": true,
  "peers": { "<client-key>": "10.0.0.2" }
}
```

Client config:
```jsonc
{
  "mode": "client",
  "server": "<server-key>",
  "seed": "<client-seed>",
  "fullTunnel": true
}
```

Kill switch included: if the tunnel drops, traffic fails instead of leaking.

## Config Reference

nospoon uses JSONC config files (JSON with `//` comments). The schema is identical between the JS and C++ implementations. See `config.example.jsonc` for all options.

```bash
sudo nospoon up [config]     # default: /etc/nospoon/config.jsonc
nospoon genkey               # generate a key pair (no root needed)
```

### Server config fields

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | — | `"server"` (required) |
| `ip` | `10.0.0.1/24` | TUN interface IP |
| `ipv6` | none | TUN IPv6 address |
| `seed` | random | 64-char hex seed for deterministic key |
| `seedFile` | none | Read seed from file (mutually exclusive with `seed`) |
| `mtu` | `1400` | TUN MTU (576–65535) |
| `fullTunnel` | `false` | Enable NAT for client internet access |
| `outInterface` | auto | Outgoing interface for NAT |
| `peers` | none | Map of `"<pubkey>": "<ip>"` for auth mode |

### Client config fields

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | — | `"client"` (required) |
| `server` | — | Server public key, 64 hex chars (required) |
| `ip` | `10.0.0.2/24` | TUN interface IP |
| `ipv6` | none | TUN IPv6 address |
| `seed` | none | 64-char hex client seed (for auth mode) |
| `seedFile` | none | Read seed from file (mutually exclusive with `seed`) |
| `mtu` | `1400` | TUN MTU (576–65535) |
| `fullTunnel` | `false` | Route all traffic through VPN |

## How It Works

1. Server announces its public key on the HyperDHT distributed hash table
2. Client looks up the key, HyperDHT performs UDP hole-punching through both NATs
3. A Noise-encrypted stream is established (X25519 + ChaCha20-Poly1305 + BLAKE2b)
4. IP packets flow through TUN devices on both sides, length-framed over the encrypted stream

All traffic is end-to-end encrypted. No data passes through the DHT — it's only used for peer discovery and hole-punching. In authenticated mode, unauthorized peers are rejected during the Noise handshake before a connection is established.

## Repo layout

```
js/        Node.js implementation (bin/, lib/, test/, package.nix, Dockerfile)
cpp/       C++ port (CMakeLists.txt, *.cpp, *.hpp, package.nix, hyperdht-cpp.nix)
android/   Kotlin VPN client (uses hyperdht-cpp via JNI wrapper)
flake.nix  Exposes packages.nospoon-js + packages.nospoon-cpp
module.nix Unified NixOS module — services.nospoon.package picks impl
```

## Platforms

| Platform | Status |
|----------|--------|
| Linux | Stable (x86_64, aarch64) — both impls |
| macOS | Stable (Apple Silicon, Intel) — both impls |
| Windows | Stable (x64, arm64) — both impls, via [Wintun](https://www.wintun.net) |
| Android | Stable (Kotlin VpnService + hyperdht-cpp JNI) |
| Docker | Stable (any Linux distro, `--network=host`) — JS impl |
| NixOS | Module: `services.nospoon` — defaults to C++ binary |

## Windows

Requires an **Administrator** terminal. nospoon uses [Wintun](https://www.wintun.net) v0.14.1 (bundled) to create the TUN adapter — no separate driver install needed. Both implementations ship the DLL alongside their binaries.

```powershell
# Run as Administrator
nospoon up config.jsonc
```

Default config path: `%PROGRAMDATA%\nospoon\config.jsonc`

Full-tunnel mode works (IPv4 + IPv6 leak prevention). The Wintun prebuilt DLLs are distributed under a [permissive license](js/bin/win32-x64/LICENSE.txt) by WireGuard LLC.

## Limitations

- **Symmetric NAT** — both peers behind symmetric NAT may fail to connect
- **DNS in full-tunnel mode** — DNS is automatically switched to `1.1.1.1` / `8.8.8.8` when full-tunnel is active. Custom DNS servers are not yet configurable.

## License

GPL-3.0 — See [LICENSE](LICENSE)

## Credits

- [HyperDHT](https://github.com/holepunchto/hyperdht) — DHT and hole-punching (JS reference)
- [hyperdht-cpp](https://github.com/jjacke13/hyperdht-cpp) — C++ port underlying nospoon-cpp + the Android client
- [koffi](https://koffi.dev/) — FFI for TUN device creation (JS impl only)
- [Wintun](https://www.wintun.net) — Windows TUN driver by WireGuard LLC
- [Noise Protocol](https://noiseprotocol.org/) — Encryption framework
- [HoleSail](https://holesail.io/) — The original Layer 4 project
