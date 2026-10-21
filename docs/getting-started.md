---
layout: default
title: Your first connection
permalink: /getting-started.html
---

<p class="eyebrow">Getting started</p>
# Your first connection

There are two ways to begin. If someone has given you a configuration file or QR code, follow the client steps. If you are creating the network yourself, start with [server setup](server.html).

## 1. Get your configuration

Ask the person running the server for a **separate client configuration for each device**. It contains the server's public key, your device's VPN address, and usually a private client seed.

Treat that file or QR code like a password. Do not post it publicly. Using the same client identity on two devices can cause one connection to replace the other.

## 2. Install nospoon

- **Android:** install the APK from [nospoon Android releases](https://github.com/jjacke13/nospoon-android/releases).
- **Linux, macOS or Windows:** follow [installation](install.html).

## 3. Connect

### Android

1. Open nospoon and tap **+**.
2. Choose **Import config from QR** or **Import config from file**.
3. Enter a friendly name and check the imported settings.
4. Tap **Save**, then tap the saved configuration.
5. Allow the Android VPN connection when prompted. Wait for **Connected**.

For manual entry and the routing switch, see the [Android guide](android.html).

### Linux or macOS

Save the client configuration on the device, then run:

```sh
sudo nospoon up client-001.jsonc
```

Use the actual filename you received. Keep the terminal running while connected; press **Ctrl+C** to disconnect.

### Windows

Extract the release archive, keeping `nospoon.exe` and `wintun.dll` together. Open PowerShell **as Administrator**, change to that folder and run:

```powershell
./nospoon.exe up .\client-001.jsonc
```

Keep the terminal open. Press **Ctrl+C** to disconnect.

## 4. Reach your server

Use the server's **VPN address**, not its public key, when opening a service. With the default network, the server is `10.0.0.1`. For example:

```sh
ping 10.0.0.1
```

If the server hosts a website on port 8080, open `http://10.0.0.1:8080` in your browser. Replace the address and port with the ones your server administrator provides. The service must be running and its firewall must allow access.

## Does my internet traffic go through it?

By default, only traffic to the VPN subnet goes through nospoon. Your normal internet connection stays in use for other destinations.

For internet access through the server, read [routing and full tunnel](routing.html). **A Windows server cannot provide full-tunnel internet access.**

Next: [Android guide](android.html) · [Configuration reference](configuration.html) · [Troubleshooting](troubleshooting.html)
