---
layout: default
title: Use the Android app
permalink: /android.html
---

<p class="eyebrow">Android</p>
# Connect your phone

Install [nospoon from Google Play](https://play.google.com/store/apps/details?id=com.nospoon.vpn). You need a running nospoon server and a client configuration, or the settings provided by its administrator.

## Import a configuration

1. Tap **+** to open **Add Configuration**.
2. Choose **Import config from QR** or **Import config from file**. Files can be `.json` or `.jsonc`.
3. Give the configuration a friendly name, such as “Home”.
4. Check the server key, client IP and **Route all traffic** setting.
5. Tap **Save**.

A complete configuration contains a private seed. Treat its file and QR code as private credentials. Give each phone its own configuration rather than sharing one identity between devices.

## Enter settings manually

| Field | What to enter |
|---|---|
| Name | Any name that helps you recognize the connection. |
| Server public key | The 64-character public key of the server you want to reach. |
| Client seed | Your device's private 64-character seed. Use the one assigned to you, or tap **Generate** to make a new identity. |
| Client IP | The address assigned to this device, including the subnet prefix, for example `10.0.0.2/24`. |
| Route all traffic | Leave off for private-network access; see the limitation below before enabling it. |

If you generate a new seed, copy the displayed **Public key (share with server admin)** to the administrator. They must authorize that key and assign your VPN address before an allowlisted server will accept you. Share the public key, not the seed.

## Connect and disconnect

Tap the saved configuration. Approve nospoon's explanation and Android's VPN connection request when prompted. The status changes through **Connecting…** to **Connected**.

Use **Disconnect** in the app to stop the tunnel. Tapping the connected configuration also disconnects it. The edit button beside a configuration opens its saved settings.

You can now access services using their VPN addresses. With the default server address, a website listening on port 8080 is at `http://10.0.0.1:8080`.

## Route all traffic

With the switch **off**, only traffic to your VPN subnet goes through nospoon. With it **on**, the app routes IPv4 internet traffic through the server; the server must also be set up for full tunnel.

<div class="notice warning"><strong>Connecting to a Windows server?</strong> Leave <strong>Route all traffic</strong> off. Windows servers do not support full-tunnel mode, including for Android clients.</div>

See [routing](routing.html) before using full tunnel. The app's current configuration is IPv4-based; desktop clients have an additional optional IPv6 setting.

## QR scanning does not open

The scanner uses Google Play Services. Make sure Play Services is available and give the first scan time to download its scanning component. You can use file import or manual entry instead.

More help: [Troubleshooting](troubleshooting.html) · [Privacy policy](privacy.html)
