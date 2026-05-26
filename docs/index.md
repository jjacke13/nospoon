---
layout: default
title: nospoon
---

# nospoon

A peer-to-peer encrypted VPN over a distributed hash table.

No central servers. No accounts. No data collection. No ads.
Free and open source under GPL-3.0.

## How it works

Two devices each generate a keypair. You add each other's public
key to a config file. They find each other through
[HyperDHT](https://github.com/holepunchto/hyperdht) (a distributed
hash table — the same one used by Hypercore / Pear), do a Noise IK
handshake, and tunnel IP packets over an encrypted stream.

NAT doesn't matter — HyperDHT handles hole punching. No port
forwarding. No public IP needed. No third-party servers handling
your traffic.

## Available on

- **Linux, macOS, Windows** — single-binary C++ implementation
  (also a Node.js implementation for reference)
- **Android** — Kotlin client (Play Store submission in progress)
- **NixOS** — flake + module

## Get it

- Source: [github.com/jjacke13/nospoon](https://github.com/jjacke13/nospoon)
- Releases: [github.com/jjacke13/nospoon/releases](https://github.com/jjacke13/nospoon/releases)
- Documentation: see the `README.md` and `ARCHITECTURE.md` in the repo

## Privacy

[Privacy Policy](privacy.html)

## License

GPL-3.0-only. See `LICENSE` in the repository.
