---
layout: default
title: Privacy Policy — nospoon
---

# nospoon Privacy Policy

**Last updated:** 2026-05-27

nospoon does not collect, store, or transmit any personal data to
anyone other than the peer(s) you explicitly configure.

## Data handled on-device

- VPN configurations (cryptographic keys, IP addresses, peer
  public keys) are stored only on your device, in the app's private
  storage.
- No data is sent to the developer or to any third party.
- No analytics, crash reporting, advertising SDKs, or telemetry are
  embedded in the application.

## Permissions

The Android application requests the following permissions and
uses them solely for the stated purposes:

- **VPN service (`android.net.VpnService`)** — required to create
  the TUN interface and route IP packets between your device and
  the peer you configured.
- **Foreground service** — required to keep the tunnel active while
  the app is in the background. The foreground service uses the
  `specialUse` type because no other foreground service type
  precisely matches a peer-to-peer VPN tunnel.
- **Notifications** — required to show the active-tunnel status
  while the foreground service is running.
- **Internet** — required for the encrypted peer-to-peer connection.
- **Camera** — optional, used only by the in-app QR-code scanner when
  you choose to import a configuration via QR code. The app does not
  store or transmit camera frames; QR decoding runs locally via
  Google's on-device ML Kit code scanner.

## Network traffic

When connected, your network traffic is routed to the peer you
configured. The developer of nospoon:

- Has no visibility into this traffic.
- Has no access to the peers you connect to.
- Has no involvement in the connection beyond shipping the app.

The encryption used is the [Noise Protocol](https://noiseprotocol.org/)
IK pattern over [HyperDHT](https://github.com/holepunchto/hyperdht).
Both keys (your local key and the peer's public key) stay on the
respective devices.

## Third-party services

The application uses two services from Google Play Services for
on-device functionality only:

- **Google Code Scanner / ML Kit** — for the optional in-app QR code
  scanner. Runs entirely on-device. Google's privacy notice for ML
  Kit applies if you choose to use the scanner.
- **HyperDHT bootstrap nodes** — to join the distributed hash table.
  These are public infrastructure nodes operated by the HyperDHT
  community; they see only that your device queried for a peer's
  public key.

No analytics, crash reporting, or advertising SDKs are integrated.

## Children

The application is not directed at children under 18. It is targeted
at users who are capable of generating cryptographic keys and
configuring a peer-to-peer network.

## Open source

The full source code is available at
[https://github.com/jjacke13/nospoon](https://github.com/jjacke13/nospoon)
under the GPL-3.0 license. You can verify any claims made in this
policy by inspecting the code, building the application yourself,
and observing its network behavior.

## Changes to this policy

If we change this policy, the updated version will be published at
this URL and the "Last updated" date above will reflect the change.
The policy in effect at the time you install or use the application
applies until you update.

## Contact

For privacy-related questions:
[github.com/jjacke13/nospoon/issues](https://github.com/jjacke13/nospoon/issues)
