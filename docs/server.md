---
layout: default
title: Create your network
permalink: /server.html
---

<p class="eyebrow">Server setup</p>
# Create your own network

Choose a computer that can remain running and connected to the internet. Install nospoon on it first. A server can sit behind a normal home router; you usually do not need to open a port.

For your first setup, use private-network mode. Full-tunnel internet access is an optional next step; **Windows servers do not support it**.

## 1. Create the server and client files

With the C++ version, run this in a new directory:

```sh
nospoon init my-network -n 2
```

This creates one `server.jsonc` and two client files, `client-001.jsonc` and `client-002.jsonc`, inside `my-network`. It generates separate identities and VPN addresses, and adds the clients' public keys to the server's allowed `peers` list.

Keep these files private: they contain identity seeds. Do not rerun `init` over an existing deployment to add a device; use `addclient` below.

The defaults assign `10.0.0.1/24` to the server and addresses starting at `10.0.0.2/24` to clients. If that range overlaps a network you already use, select a different private /24 range with `--subnet` when creating the files.

## 2. Start the server

On Linux or macOS:

```sh
sudo nospoon up my-network/server.jsonc
```

On Windows, in an Administrator PowerShell:

```powershell
./nospoon.exe up .\my-network\server.jsonc
```

Keep the process running while clients connect. A NixOS service can run it in the background; see [installation](install.html#nixos-service).

## 3. Connect your devices

Copy **one client file to each device**, using a private transfer method. Keep the server file on the server.

- On a desktop, run `nospoon up` with that device's client file, using root or Administrator privileges.
- On Android, import the file from the app's **+** screen, save it, then tap the configuration to connect.

See [your first connection](getting-started.html) for a service-access example.

## Add another device

With the C++ version:

```sh
nospoon addclient my-network/server.jsonc -n 1
```

This updates the server's peer list and writes a new numbered client configuration beside it. Give that file to the new device. The running server reads its configuration at startup, so arrange a server restart when you are ready for it to use the updated list; existing clients will need to reconnect.

For manual provisioning, generate a client seed/public key with `nospoon genkey`, add its public key and assigned VPN address to the server's `peers`, and create the matching client configuration. On Android, **Generate** creates the seed and displays the public key you can give to the server administrator.

## Remove a device

Remove its public-key entry from the server's `peers` map and restart the server when convenient. Keep an explicit allowlist with at least one authorized peer; **an empty or missing `peers` map enables open mode**, rather than denying everyone.

## A few practical rules

- Each device needs its own seed and assigned VPN address.
- Keep a stable server seed so the server's public key does not change after restarting.
- Keep the server awake; sleeping or shutting it down makes its services unavailable.
- nospoon connects devices, but it does not start a web, SSH or file-sharing service for you. Configure those services and their firewalls separately.
- Open mode accepts any connecting key and is intended for quick testing. Use a `peers` allowlist for your own network.

Next: [Routing and full tunnel](routing.html) · [Configuration reference](configuration.html)
