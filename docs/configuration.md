---
layout: default
title: Configuration and commands
permalink: /configuration.html
---

<p class="eyebrow">Reference</p>
# Configuration and commands

Desktop nospoon reads JSONC: JSON with comments. Server and client configurations are separate files. The Android app imports the client fields it supports through its editor.

The easiest way to create a matching server/client set is the C++ `nospoon init` command. The templates below explain the fields; replace every `<placeholder>` before using them.

## Server template

```json
{
  "mode": "server",
  "ip": "10.0.0.1/24",
  "seed": "<server-private-seed-64-hex-characters>",
  "mtu": 1400,
  "fullTunnel": false,
  "peers": {
    "<client-public-key-64-hex-characters>": "10.0.0.2"
  }
}
```

## Client template

```json
{
  "mode": "client",
  "server": "<server-public-key-64-hex-characters>",
  "seed": "<client-private-seed-64-hex-characters>",
  "ip": "10.0.0.2/24",
  "mtu": 1400,
  "fullTunnel": false
}
```

## Fields

| Field | Used by | Meaning |
|---|---|---|
| `mode` | Desktop | `server` or `client`. Required. |
| `server` | Clients | Server's 64-character hexadecimal public key. Required for clients. |
| `seed` | Both | Private 64-character hexadecimal identity seed. Keep it stable and private. |
| `seedFile` | Desktop | Read the private seed from a file instead of putting it inline. Do not combine with `seed`. |
| `ip` | Both | Device's VPN IPv4 address and prefix. Defaults: server `10.0.0.1/24`, client `10.0.0.2/24`. |
| `ipv6` | Desktop | Optional VPN IPv6 address and prefix. |
| `mtu` | Both | Largest tunnel packet size. Default `1400`; desktop validation accepts `576`–`65535`. Start with the default. |
| `fullTunnel` | Both | Default `false`. Server enables internet forwarding; client redirects internet traffic. Windows servers do not support it. |
| `outInterface` | Desktop server | Optional outbound network interface for full tunnel; otherwise automatically detected. |
| `peers` | Server | Map client public keys to their assigned VPN IPv4 addresses, without the prefix. |

For an allowlisted server, the client's seed must derive the public key listed in `peers`, and its `ip` must match the assigned address. Omitting the seed creates a new identity rather than restoring the identity the server authorized.

## Commands

`up` and `genkey` are available in both implementations. The remaining utility commands below are features of **nospoon-cpp**.

| Command | What it does |
|---|---|
| `nospoon up config.jsonc` | Starts the VPN. Requires root or Administrator privileges. |
| `nospoon genkey` | Generates a seed and its public key. The seed printed by this command is private. |
| `nospoon genkey <seed-or-file>` | C++: derives the public key for an existing seed or seed file. |
| `nospoon init my-network -n 2` | Creates a new server and two separately identified clients. Optional `--subnet` and `--mtu` customize a new deployment. |
| `nospoon addclient my-network/server.jsonc -n 1` | Adds a client to an existing allowlisted deployment and writes its configuration. |
| `nospoon inspect client.jsonc` | Validates and displays resolved configuration; does not open a tunnel. |
| `nospoon check` | Tests whether DHT discovery/bootstrap is reachable; does not create a TUN interface. |
| `nospoon check client.jsonc` | Also attempts a connection to that client's server. |

**Do not run `check client.jsonc` using the identity of an already connected device.** Its connection attempt can replace the working tunnel. Use a separate test client identity, or disconnect that client first when interruption is acceptable.

Without an explicit filename, `up` uses `/etc/nospoon/config.jsonc` on Linux/macOS and `%PROGRAMDATA%\nospoon\config.jsonc` on Windows. Passing the filename explicitly is recommended in these guides.

## Keep identities private

Public keys can be shared. Seeds, seed files, full configurations and configuration QR codes must be kept private. Back up your server identity so a reinstall does not change the key your clients use.

See [server setup](server.html) for adding or removing access, and [routing](routing.html) for full-tunnel behavior.
