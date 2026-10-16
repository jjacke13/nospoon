---
layout: default
title: Meet nospoon
permalink: /
---

<section class="hero" aria-labelledby="hero-title">
<p class="eyebrow">Free. Open source. Peer to peer.</p>
<h1 id="hero-title">Your network.<br><span>Wherever you are.</span></h1>
<p class="lead">Home computer. Remote server. Phone in your pocket. Bring them together with nospoon—your own encrypted, private network.</p>
<div class="hero-actions">
<a class="hero-button" href="getting-started.html">Get started <span aria-hidden="true">↗</span></a>
<a class="play-badge" href="https://play.google.com/store/apps/details?id=com.nospoon.vpn"><img src="{{ '/assets/images/google-play-badge.png' | relative_url }}" width="210" height="81" alt="Get nospoon on Google Play"></a>
</div>
<p class="hero-platforms">Android · Linux · macOS · Windows</p>
<p class="hero-tagline"><em>nospoon: If you stop believing in boundaries, they disappear.</em><br><span>Inspired by <cite>The Matrix</cite></span></p>
</section>

<div class="notice"><strong>New here?</strong> You do not need to know how peer-to-peer networking works. Start with the explanation below, then choose whether you want to join a network or create one.</div>

<div class="paths">
<a class="path" href="getting-started.html"><span class="eyebrow">I have a configuration</span><h2>Connect to a network <span aria-hidden="true">↗</span></h2><p>Join from Android, Linux, macOS or Windows.</p></a>
<a class="path" href="server.html"><span class="eyebrow">I want my own network</span><h2>Set up a server <span aria-hidden="true">↗</span></h2><p>Connect your devices and decide who can join.</p></a>
</div>

## What can I use it for?

- Reach a service on your home computer while you are away.
- Connect your phone, laptop and another computer on a private network.
- Access a device behind a router without manually opening a port.
- With a supported server, send internet traffic through that server's connection.

You still need a device running the nospoon server. The Android app is a client: it connects to a server you run, or one someone has invited you to use. nospoon does not supply a shared VPN service or a list of countries to connect to.

## What does “peer-to-peer” mean?

A **peer** is simply a device taking part in the connection. In a peer-to-peer network, devices find each other and establish a connection rather than relying on a single central VPN service to connect everyone.

nospoon uses a distributed discovery network to help devices find one another. Their VPN traffic is encrypted. Where the network allows it, they connect directly—even if they are on different Wi-Fi or mobile networks.

<div class="network-diagram" role="img" aria-label="Your phone connects through an encrypted tunnel to a computer running your nospoon server. Discovery helps them find each other.">
<div><span class="device-icon" aria-hidden="true">01</span><strong>Your phone or laptop</strong><small>nospoon client</small></div>
<div class="tunnel"><span aria-hidden="true">↔</span><strong>Encrypted tunnel</strong><small>Discovery helps devices meet</small></div>
<div><span class="device-icon" aria-hidden="true">02</span><strong>Your computer</strong><small>nospoon server</small></div>
</div>

Routers often hide devices behind a shared internet address. nospoon tries to establish a path through those routers automatically. You usually do not need a public IP address or port forwarding. Some restrictive networks can still prevent a connection; see [troubleshooting](troubleshooting.html).

## A few words you will see

| Term | Plain-language meaning |
|---|---|
| Server | The device that stays available for your clients to connect to. It can be at home or elsewhere. |
| Client | A device joining that server, such as your Android phone. |
| Public key | A device's public identifier. Share it to identify the device or allow it to connect. |
| Seed | The private secret that creates a device's identity. Keep it private. |
| Tunnel | The encrypted connection carrying traffic between devices. |
| Subnet | The range of private VPN addresses assigned to your devices. |

## Which guide do I need?

[Getting started](getting-started.html) walks through your first connection. [Installation](install.html) covers desktop platforms, NixOS, Node.js and Docker. [Server setup](server.html) covers creating a network and adding devices. [Android](android.html) explains the app's screens. [Routing](routing.html) explains what goes through the VPN.

**Windows servers do not support full-tunnel mode.** They can be used for private-network access; clients connecting to a Windows server must leave full tunnel off.
