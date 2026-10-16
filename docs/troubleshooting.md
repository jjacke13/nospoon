---
layout: default
title: Troubleshooting
permalink: /troubleshooting.html
---

<p class="eyebrow">Help</p>
# When something does not connect

Start with the basics: the server is running, both devices have internet access, and each client has its own configuration.

## It stays on Connecting or Reconnecting

- Check the server public key. Do not paste a client public key or a seed into the server field.
- For an allowlisted server, check that the client public key is in `peers` and that its assigned IP matches the client configuration.
- Make sure another device is not using the same client seed.
- Try a different network, such as Wi-Fi instead of mobile data. Some networks block UDP or have NAT behavior that prevents a connection.

**Peer not found / PEER_NOT_FOUND:** discovery did not find a usable record for that server key. Check the key, the running server and discovery connectivity.

**Holepunch failed / HOLEPUNCH_ABORTED:** discovery or handshake may have progressed, but establishing the connection failed. Trying a different network can help; this is not fixed simply by changing the VPN IP address.

## Connected, but I cannot open a service

Use the server's VPN address, such as `10.0.0.1`, and the correct service port. Confirm that the service is running, is listening on an address reachable through the VPN, and is allowed by the server's firewall.

Check that the VPN subnet does not overlap the network your client is already using. A failed ping alone does not prove the tunnel is down: a firewall may block ping while allowing the service you need.

## Connected, but internet access does not work

If you only want private-network access, leave `fullTunnel` false or **Route all traffic** off.

For full tunnel, both sides must be configured for it, and the server must have internet access and working forwarding/NAT. **A Windows server does not support this mode. Turn full tunnel off on clients connecting to it.**

If IP-address destinations work but names do not, investigate DNS. See [routing](routing.html) for the DNS defaults and recovery limitations.

## One device connects and another disconnects

They may share the same seed/configuration. The server identifies clients by public key, so another connection using that identity can replace the first. Generate a separate client configuration for each device.

## Android VPN permission was denied

Tap the configuration again and allow the Android VPN request. If another VPN app is active, disconnect it first; Android normally allows one active VPN per user/profile.

## Android QR scan or file import fails

QR scanning needs Google Play Services; its first launch may need to download a component. Try file import or manual entry if scanning is unavailable.

Import a complete client configuration with a `server` field. Check that the server key and seed have 64 hexadecimal characters and that the IP has its prefix, such as `10.0.0.2/24`.

## Desktop permission or TUN errors

Run `up` with root privileges on Linux/macOS or from an Administrator terminal on Windows. Linux needs `/dev/net/tun`; containers need the device and network-administration capability. On Windows, keep the bundled `wintun.dll` beside the executable.

## It stopped working after a network change

The clients attempt to reconnect. Desktop recovery can rebuild the discovery connection after repeated failures; full-tunnel routes may be temporarily removed during that recovery. If it remains stuck, disconnect and reconnect when you can safely interrupt the VPN.

For a desktop discovery-only check, use `nospoon check`. A check with a client configuration also dials the server and can replace an existing tunnel using that identity.

## Ask for help

[Open an issue on GitHub](https://github.com/jjacke13/nospoon/issues). Include your operating system, nospoon version, whether the problem is discovery, connection or service access, and a short sanitized error message.

Do not include seeds, private configuration files or configuration QR codes. Review logs before sharing them; they may contain network addresses or other details you do not want public.
