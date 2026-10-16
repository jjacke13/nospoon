---
layout: default
title: Choose what goes through the VPN
permalink: /routing.html
---

<p class="eyebrow">Routing</p>
# Private network or full tunnel?

A VPN does not have to carry everything your device sends. Choose the mode that matches what you want to do.

| | Private-network mode | Full-tunnel mode |
|---|---|---|
| Best for | Reaching devices and services on your nospoon network. | Sending internet traffic through your server's connection. |
| Client setting | `fullTunnel: false`, or **Route all traffic** off. | `fullTunnel: true`, or **Route all traffic** on. |
| Server setting | The default private-network configuration. | Internet forwarding/NAT enabled with `fullTunnel: true`. |
| Windows server | Supported for private-network access. | **Not supported.** |

## Private-network mode

This is the default and the best place to start. With a client address such as `10.0.0.2/24`, traffic for that VPN subnet goes through nospoon. Other traffic continues using your ordinary internet connection.

A VPN address identifies a device inside the tunnel. It is different from that device's public key and from its home Wi-Fi address.

Clients registered on the same server can also communicate using their assigned VPN addresses. This is a server-centered network; it does not mean every pair of clients creates a separate direct tunnel.

## Full-tunnel mode

Use a supported Linux or macOS server with internet access. Set `fullTunnel` to `true` in **both** the server and desktop client configurations. On Android, enable **Route all traffic** for the client instead.

```json
"fullTunnel": true
```

This is a field to add to your existing JSON configuration, not a complete configuration by itself. Restart the relevant processes to apply desktop configuration changes.

The server forwards client traffic to its internet connection. Its network must allow forwarding and NAT. An optional server `outInterface` selects the outbound interface; otherwise nospoon attempts to detect it.

<div class="notice warning"><strong>Windows servers cannot provide full tunnel.</strong> Keep <code>fullTunnel</code> false on a Windows server and its clients. On Android, leave <strong>Route all traffic</strong> off when connecting to that server.</div>

Desktop full-tunnel mode configures DNS automatically using `1.1.1.1` and `8.8.8.8`; the Android app uses those DNS addresses too. Custom DNS is not currently a configuration option.

Full tunnel changes system routes and DNS. Desktop clients have recovery logic that can temporarily remove tunnel routes after repeated failures so they can reconnect. Do not treat it as an unconditional, permanent kill switch. IPv6 handling differs by platform; verify the traffic you intend to route rather than assuming the Android IPv4 configuration covers every protocol.

## Avoid overlapping networks

If your home Wi-Fi already uses the same subnet as the VPN, your device may send packets to the wrong network. Choose a different VPN subnet and update the server, client addresses and peer assignments together.

The provisioning command accepts a custom /24 subnet:

```sh
nospoon init my-network -n 2 --subnet 10.42.0.0/24
```

Use this when creating a **new** deployment. Do not overwrite a working deployment to change its subnet.

Next: [Configuration reference](configuration.html) · [Troubleshooting](troubleshooting.html)
