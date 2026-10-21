---
layout: default
title: Install nospoon
permalink: /install.html
---

<p class="eyebrow">Installation</p>
# Choose your platform

The desktop C++ version, **nospoon-cpp**, is recommended. The Node.js version is an alternative with the same basic configuration format and network protocol.

## Android

Install the APK from [nospoon Android releases](https://github.com/jjacke13/nospoon-android/releases), then follow the [Android guide](android.html). The app connects to an existing nospoon server; it does not host one.

## Linux

Download the archive for your computer's architecture from [GitHub Releases](https://github.com/jjacke13/nospoon/releases), extract it and make the binary executable:

```sh
chmod +x nospoon
./nospoon --help
```

You can run it as `./nospoon`, or place it in a directory on your `PATH` to use the name `nospoon` shown throughout these guides. Starting a VPN requires root privileges and access to `/dev/net/tun`.

### Nix

On Linux or macOS with Nix installed:

```sh
nix run github:jjacke13/nospoon -- --help
```

To start with a configuration, first build the package and then run the resulting binary with the privileges needed to create a tunnel:

```sh
nix build github:jjacke13/nospoon#nospoon-cpp
sudo ./result/bin/nospoon up client.jsonc
```

### NixOS service

The project provides a `services.nospoon` module. Add the nospoon flake input and module to your system configuration as shown in the [repository's NixOS example](https://github.com/jjacke13/nospoon#nix-flake-linux--macos).

The module supports server and client mode, a private seed file, peer assignments and full-tunnel settings. Review the [module options](https://github.com/jjacke13/nospoon/blob/main/module.nix) before enabling the service. Keep secret seeds outside the public Nix store.

## macOS

Use Nix as above, or build the C++ client with Homebrew dependencies:

```sh
brew install cmake ninja pkg-config libsodium libuv
git clone --recurse-submodules https://github.com/jjacke13/nospoon.git
cd nospoon
cmake -S cpp -B cpp/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build cpp/build
sudo ./cpp/build/nospoon up client.jsonc
```

The full [build instructions](https://github.com/jjacke13/nospoon#build-c-from-source) also cover Linux. Use libuv 1.51.x; the project documents a connection-stalling regression with 1.52.0 and 1.52.1.

## Windows

1. Download the Windows archive from [GitHub Releases](https://github.com/jjacke13/nospoon/releases).
2. Extract the entire archive. Keep the bundled `wintun.dll` beside `nospoon.exe`.
3. Open PowerShell **as Administrator** and change to the extracted folder.
4. Run `./nospoon.exe --help`, then follow [getting started](getting-started.html).

**Windows server limitation:** use private-network mode. A server running on Windows cannot provide full-tunnel internet access to clients. This is a limitation of the server, including when the connecting client is Android.

## Node.js alternative

Requires Node.js 18 or newer:

```sh
npm install -g nospoon
```

Depending on how Node.js is installed, installing globally may require elevated permissions. Starting the VPN still needs root or Administrator privileges. Use `nospoon up config.jsonc` and `nospoon genkey`; the extra provisioning and diagnostic commands in the [command reference](configuration.html#commands) are C++ features.

## Docker on Linux

The repository contains a Dockerfile for the Node.js implementation:

```sh
git clone https://github.com/jjacke13/nospoon.git
cd nospoon/js
docker build -t nospoon .
docker run --network=host --cap-add=NET_ADMIN --device /dev/net/tun \
  -v /absolute/path/to/config.jsonc:/etc/nospoon/config.jsonc:ro \
  nospoon up
```

Replace the configuration path with your own. This recipe is for a Linux host with TUN support, not Docker Desktop on macOS or Windows.
