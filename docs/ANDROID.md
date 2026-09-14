# Android client

The Android app lives in its own repository:
**[nospoon-android](https://github.com/jjacke13/nospoon-android)**.

It was split out of this repo's `android/` directory on 2026-09-14 with
`git subtree split`, so its history is intact there. Everything about
building, signing and publishing the app is in that repo's README.

## What stays here

The app is only a client; the contract it implements is defined in this repo:

- **Client config format** — [README § Config Reference](../README.md#config-reference),
  [`config.example.jsonc`](../config.example.jsonc). The app reads the same
  JSON (`server`, `seed`, `ip`, `mtu`, `fullTunnel`); the QR codes and
  config files it imports are this format with JSONC comments stripped.
  Validation rules: [`cpp/validation.hpp`](../cpp/validation.hpp),
  [`js/lib/validation.js`](../js/lib/validation.js).
- **Wire protocol** — length-prefix framing with a zero-length keepalive
  every 25 s: [`cpp/framing.hpp`](../cpp/framing.hpp),
  [`js/lib/framing.js`](../js/lib/framing.js). The app's `Framing.kt` is a
  port of these.
- **Transport** — HyperDHT + Noise + SecretStream via
  [hyperdht-cpp](https://github.com/jjacke13/hyperdht-cpp). The app loads
  `libhyperdht_jni.so`, built by hyperdht-cpp's CI; the desktop C++ client
  pins the same library in `cpp/CMakeLists.txt` / `cpp/hyperdht-cpp.nix`.
- **Bulk client provisioning** — `scripts/mkclients.sh` generates client
  configs and patches the server's `peers` map; feed its output to
  `qrencode` for the app's scanner.
- **Privacy policy** — [`docs/privacy.md`](privacy.md), served by this
  repo's GitHub Pages; it is the URL the Play listing points at.

A wire-protocol or config-format change made here must be mirrored in
nospoon-android.
