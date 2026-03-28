# iOS Implementation Plan

A plan for porting nospoon to iOS using NEPacketTunnelProvider + Bare runtime (JSC variant).

---

## Critical Difference from Android: No Raw TUN fd

Apple does **not expose a raw TUN file descriptor** on iOS. Instead, iOS provides
`NEPacketTunnelFlow`, a high-level Swift API:

- `packetFlow.readPackets(completionHandler:)` — reads IP packets from the virtual interface
- `packetFlow.writePackets(_:withProtocols:)` — injects IP packets into the networking stack

This means the Bare worklet **cannot directly read/write the TUN device**. Packets
must be shuttled through IPC between Swift and the worklet:

```
              Android                                    iOS
         ┌──────────────┐                        ┌──────────────┐
         │  Kotlin       │                        │  Swift        │
         │  VpnService   │                        │  PacketTunnel │
         │               │                        │  Provider     │
         │  creates TUN  │                        │               │
         │  fd ──────────┼──► Bare worklet        │  NEPacketTunnelFlow
         │               │    reads/writes fd     │    ↕ IPC ↕    │
         └──────────────┘    directly             │  Bare worklet │
                                                  │  (no fd)      │
                                                  └──────────────┘
```

This adds per-packet IPC overhead that Android doesn't have.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      iOS App (SwiftUI)                        │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                   Main App Target                        │  │
│  │  - Config management (saved in App Group)                │  │
│  │  - QR code scanning (server key import)                  │  │
│  │  - NETunnelProviderManager (start/stop VPN)              │  │
│  │  - Connection status UI                                  │  │
│  └────────────────────────┬────────────────────────────────┘  │
│                           │ App Group (shared UserDefaults)    │
│  ┌────────────────────────┴────────────────────────────────┐  │
│  │           Packet Tunnel Extension (separate process)     │  │
│  │                                                          │  │
│  │  PacketTunnelProvider : NEPacketTunnelProvider            │  │
│  │    - startTunnel / stopTunnel lifecycle                   │  │
│  │    - NEPacketTunnelFlow for packet I/O                    │  │
│  │    - WorkletBridge: BareWorklet + BareIPC management      │  │
│  │                     │                                     │  │
│  │                     │ IPC (JSON over newlines)             │  │
│  │                     ▼                                     │  │
│  │  Bare Worklet (JavaScript, JSC engine)                    │  │
│  │    - framing.js (reused from android/worklet)             │  │
│  │    - HyperDHT connect + reconnect logic                   │  │
│  │    - Packets via IPC (NOT direct fd access)                │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

---

## Memory Budget

**iOS Network Extension limit: 50MB (iOS 15+), 15MB (iOS 14)**

| Component | Estimated | Notes |
|-----------|-----------|-------|
| BareKit JSC variant | ~8-12MB | 2.6MB binary + runtime heap. Uses system JavaScriptCore |
| HyperDHT + sodium-native | ~3-5MB | DHT routing table, crypto state |
| Worklet JS heap | ~2-4MB | Application code, buffers, framing |
| Swift PacketTunnelProvider | ~2-3MB | Extension code, packet buffers |
| Packet buffers in flight | ~1-2MB | MTU 1400 x batch size |
| **Total** | **~16-26MB** | **Fits within 50MB** |

**CRITICAL:** Must use the **JSC variant** of BareKit. The V8 variant (~31MB binary alone)
would exceed the memory limit. The JSC variant uses the system-provided JavaScriptCore
framework, keeping the binary at ~2.6MB.

**Minimum deployment target: iOS 15+** (the 15MB limit on iOS 14 is too tight).

---

## Packet Flow

```
=== OUTBOUND (app on device → remote server) ===

iOS app sends network request
    │
    ▼
Kernel routes to utun (VPN virtual interface)
    │
    ▼
packetFlow.readPackets { packets, protocols in ... }
    │
    ▼  (IPC: JSON + base64 packet)
Bare worklet receives packet
    │
    ▼
encode(packet)  →  connection.write(framedData)
    │
    ▼
HyperDHT Noise-encrypted stream → UDP to server


=== INBOUND (remote server → app on device) ===

UDP from server  →  HyperDHT stream
    │
    ▼
connection.on('data')  →  createDecoder(onPacket)
    │
    ▼  (IPC: JSON + base64 packet)
PacketTunnelProvider receives packet
    │
    ▼
packetFlow.writePackets([packet], withProtocols: [AF_INET])
    │
    ▼
Kernel delivers to destination app
```

---

## IPC Protocol

Same JSON-over-newline protocol as Android, with changes for the packet shuttle
and removal of Android-specific messages.

| Direction | Type | Purpose | Payload |
|-----------|------|---------|---------|
| Swift → Worklet | `start` | Begin DHT connection | `{config}` |
| Swift → Worklet | `stop` | Graceful shutdown | — |
| Swift → Worklet | `packet` | Outbound IP packet | `{data: "<base64>"}` |
| Worklet → Swift | `ready` | Worklet initialized | — |
| Worklet → Swift | `connected` | DHT stream opened | — |
| Worklet → Swift | `status` | Connection state change | `{connected}` |
| Worklet → Swift | `packet` | Inbound IP packet | `{data: "<base64>"}` |
| Worklet → Swift | `identity` | Client public key | `{publicKey}` |
| Worklet → Swift | `error` | Error report | `{message}` |
| Worklet → Swift | `stopped` | Clean shutdown done | — |

**Removed vs Android:**
- `tun` — no TUN fd to pass
- `protect` / `protected` — not needed; extension sockets bypass tunnel automatically

**Added vs Android:**
- `packet` (both directions) — IPC packet shuttle

### Performance note

Base64 encoding adds ~33% overhead per packet. Start with JSON+base64 for simplicity.
If benchmarking shows IPC is a bottleneck, switch to binary framing:

```
Control: 0x01 + length(4 bytes BE) + JSON bytes + \n
Packet:  0x02 + length(4 bytes BE) + raw IP packet bytes
```

---

## What's Reusable from Android Worklet

| Component | Reusable? | Changes |
|-----------|-----------|---------|
| `framing.js` | 100% | None — pure JS |
| DHT connect logic | ~80% | Remove `protect`/`protected` handling |
| Reconnect + backoff | ~90% | Remove `protectedFd`, simplify `restartDht()` |
| Config validation | 100% | Same JSON structure |
| Keepalive timer | 100% | Identical |
| `setupTun()` | 0% | **Removed** — replaced by IPC packet shuttle |
| `getProtectInfo()` | 0% | **Removed** — not needed on iOS |
| IPC message handler | ~70% | Add `packet` type, remove `tun`/`protect`/`protected` |

---

## Project Structure

```
ios/
  nospoon.xcodeproj/

  # Main app target
  nospoon/
    NospoonApp.swift              # SwiftUI entry point
    ContentView.swift             # Config list + connection status
    ConfigEditorView.swift        # Config create/edit
    QRScannerView.swift           # QR scanning for key import
    VpnConfig.swift               # Config model + persistence
    VpnManager.swift              # NETunnelProviderManager wrapper
    Assets.xcassets/
    Info.plist
    nospoon.entitlements

  # Packet Tunnel Extension target (separate process)
  PacketTunnel/
    PacketTunnelProvider.swift     # NEPacketTunnelProvider subclass
    WorkletBridge.swift            # BareWorklet + BareIPC lifecycle
    Info.plist
    PacketTunnel.entitlements

  # Shared between targets
  Shared/
    Constants.swift                # App Group ID, IPC message types

  # BareKit framework (JSC variant, from prebuilds)
  Frameworks/
    BareKit.xcframework/

  # Worklet JavaScript
  worklet/
    client.js                      # iOS-adapted worklet (no TUN fd)
    framing.js                     # Copied from android/worklet/

  # Build outputs
  Resources/
    client.bundle                  # Output of bare-pack --preset ios

  # Native addon prebuilds
  addons/
    addons.yml
    *.xcframework                  # udx-native, sodium-native, etc.

  package.json                     # Worklet deps + build scripts
  build.sh                         # Build script
```

---

## Step 1: Xcode Project Setup

Create an Xcode project with two targets:

1. **nospoon** (iOS App) — SwiftUI, deployment target iOS 15.0
2. **PacketTunnel** (Network Extension) — type: Packet Tunnel Provider

Both targets need these capabilities:
- Network Extensions (Packet Tunnel)
- App Groups (`group.com.nospoon.vpn`)

### Entitlements (both targets)

```xml
<key>com.apple.developer.networking.networkextension</key>
<array>
    <string>packet-tunnel-provider</string>
</array>
<key>com.apple.security.application-groups</key>
<array>
    <string>group.com.nospoon.vpn</string>
</array>
```

### Apple Developer Portal

- Register App IDs: `com.nospoon.vpn` + `com.nospoon.vpn.PacketTunnel`
- Enable Network Extension + App Groups on both
- Generate provisioning profiles for both targets
- **Note:** App Store VPN distribution requires an **organization** developer account

---

## Step 2: Worklet (`ios/worklet/client.js`)

Adapted from `android/worklet/client.js`. Key differences marked with comments.

```javascript
// iOS VPN worklet — runs inside Bare runtime (JSC) in Network Extension
// Unlike Android, there is NO TUN fd. Packets are shuttled via IPC.

/* global BareKit */

const HyperDHT = require('hyperdht')
const { encode, createDecoder, startKeepalive } = require('./framing')

const INITIAL_RETRY_MS = 1000
const MAX_RETRY_MS = 30000
const MAX_FAILURES_BEFORE_RESTART = 3

const ipc = BareKit.IPC

let dht = null
let activeConnection = null
let shuttingDown = false
let retryDelay = INITIAL_RETRY_MS
let consecutiveFailures = 0

function sendToSwift (msg) {
  ipc.write(Buffer.from(JSON.stringify(msg) + '\n'))
}

// CHANGED: packets arrive via IPC from Swift (NEPacketTunnelFlow),
// not from a TUN fd. No setupTun(), no tunWrite, no tunReady.
function handleOutboundPacket (b64) {
  if (!activeConnection || activeConnection.destroyed) return
  const packet = Buffer.from(b64, 'base64')
  activeConnection.write(encode(packet))
}

function connect (serverKey, connectOpts) {
  const connection = dht.connect(Buffer.from(serverKey, 'hex'), connectOpts)
  activeConnection = connection

  const decode = createDecoder(function (packet) {
    // CHANGED: send to Swift via IPC instead of writing to TUN fd
    sendToSwift({ type: 'packet', data: packet.toString('base64') })
  })

  connection.on('open', function () {
    retryDelay = INITIAL_RETRY_MS
    consecutiveFailures = 0
    // CHANGED: no protect() needed — extension sockets bypass tunnel
    sendToSwift({ type: 'connected' })
    startKeepalive(connection)
  })

  connection.on('data', function (data) {
    decode(data)
  })

  connection.on('error', function (err) {
    sendToSwift({ type: 'error', message: err.message })
  })

  connection.on('close', function () {
    activeConnection = null
    if (shuttingDown) return

    consecutiveFailures++
    sendToSwift({ type: 'status', connected: false })

    if (consecutiveFailures >= MAX_FAILURES_BEFORE_RESTART) {
      restartDht(serverKey, connectOpts)
      return
    }

    const jitter = Math.floor(Math.random() * 1000)
    const delay = retryDelay + jitter

    setTimeout(function () {
      if (!shuttingDown) connect(serverKey, connectOpts)
    }, delay)

    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS)
  })
}

// SIMPLIFIED vs Android: no protect/protected dance needed
function restartDht (serverKey, connectOpts) {
  const oldDht = dht
  dht = new HyperDHT()
  try { oldDht.destroy() } catch (e) {}

  retryDelay = INITIAL_RETRY_MS
  consecutiveFailures = 0

  connect(serverKey, connectOpts)
}

function shutdown () {
  if (shuttingDown) return
  shuttingDown = true

  if (activeConnection) activeConnection.end()
  if (dht) dht.destroy()

  sendToSwift({ type: 'stopped' })
}

// Handle IPC messages from Swift
let ipcBuffer = ''

ipc.on('data', function (data) {
  ipcBuffer += data.toString()
  const lines = ipcBuffer.split('\n')
  ipcBuffer = lines.pop()

  for (const line of lines) {
    if (!line.trim()) continue

    let msg
    try { msg = JSON.parse(line) } catch (e) { continue }

    if (msg.type === 'start') {
      const config = msg.config || {}

      if (!config.server || typeof config.server !== 'string' ||
          !/^[0-9a-fA-F]{64}$/.test(config.server)) {
        sendToSwift({ type: 'error', message: 'Invalid server key' })
        return
      }

      dht = new HyperDHT()

      const connectOpts = {}
      if (config.seed) {
        if (typeof config.seed !== 'string' || !/^[0-9a-fA-F]{64}$/.test(config.seed)) {
          sendToSwift({ type: 'error', message: 'Invalid seed' })
          return
        }
        const seedBuf = Buffer.from(config.seed, 'hex')
        connectOpts.keyPair = HyperDHT.keyPair(seedBuf)
        sendToSwift({ type: 'identity', publicKey: connectOpts.keyPair.publicKey.toString('hex') })
      }

      connect(config.server, connectOpts)
    } else if (msg.type === 'packet') {
      // NEW: outbound packet from Swift (NEPacketTunnelFlow)
      handleOutboundPacket(msg.data)
    } else if (msg.type === 'stop') {
      shutdown()
    }
  }
})

sendToSwift({ type: 'ready' })
```

### `ios/worklet/framing.js`

Identical copy of `android/worklet/framing.js` — no changes needed.

---

## Step 3: PacketTunnelProvider.swift

```swift
import NetworkExtension
import BareKit

class PacketTunnelProvider: NEPacketTunnelProvider {

    private var worklet: BareWorklet?
    private var ipc: BareIPC?
    private var ipcBuffer = Data()
    private var startCompletion: ((Error?) -> Void)?

    // MARK: - Lifecycle

    override func startTunnel(
        options: [String: NSObject]?,
        completionHandler: @escaping (Error?) -> Void
    ) {
        startCompletion = completionHandler

        // Read config from App Group shared storage
        guard let defaults = UserDefaults(suiteName: Constants.appGroup),
              let configJson = defaults.string(forKey: "activeConfig") else {
            completionHandler(NSError(domain: "nospoon", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No config found"]))
            return
        }

        // Start Bare worklet (JSC variant)
        let bundle = Bundle.main.url(forResource: "client", withExtension: "bundle")!
        worklet = BareWorklet()
        worklet?.start(bundle)

        ipc = worklet?.createIPC()
        ipc?.readable = { [weak self] in
            self?.readIPC()
        }

        // Send start message with config
        sendToWorklet(["type": "start", "config": configJson])
    }

    override func stopTunnel(
        with reason: NEProviderStopReason,
        completionHandler: @escaping () -> Void
    ) {
        sendToWorklet(["type": "stop"])

        // Give worklet 2s to clean up, then force terminate
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.cleanup()
            completionHandler()
        }
    }

    private func cleanup() {
        worklet?.terminate()
        worklet = nil
        ipc = nil
    }

    // MARK: - Tunnel network settings

    private func configureTunnel(completion: @escaping (Error?) -> Void) {
        guard let defaults = UserDefaults(suiteName: Constants.appGroup),
              let configJson = defaults.string(forKey: "activeConfig"),
              let config = try? JSONSerialization.jsonObject(with:
                  configJson.data(using: .utf8)!) as? [String: Any] else {
            completion(NSError(domain: "nospoon", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Cannot parse config"]))
            return
        }

        let ipStr = (config["ip"] as? String) ?? "10.0.0.2/24"
        let parts = ipStr.split(separator: "/")
        let ip = String(parts[0])
        let prefix = Int(parts[1]) ?? 24
        let mtu = (config["mtu"] as? Int) ?? 1400
        let fullTunnel = (config["fullTunnel"] as? Bool) ?? false

        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "10.0.0.1")

        // IPv4
        let ipv4 = NEIPv4Settings(addresses: [ip], subnetMasks: [prefixToNetmask(prefix)])
        if fullTunnel {
            ipv4.includedRoutes = [NEIPv4Route.default()]
        } else {
            ipv4.includedRoutes = [NEIPv4Route(destinationAddress: "10.0.0.0",
                                               subnetMask: "255.255.255.0")]
        }
        settings.ipv4Settings = ipv4

        // DNS (full tunnel)
        if fullTunnel {
            settings.dnsSettings = NEDNSSettings(servers: ["1.1.1.1", "8.8.8.8"])
        }

        settings.mtu = NSNumber(value: mtu)

        setTunnelNetworkSettings(settings) { error in
            completion(error)
        }
    }

    // MARK: - Packet read loop

    private func startPacketReadLoop() {
        packetFlow.readPackets { [weak self] packets, protocols in
            guard let self = self else { return }
            for (i, packet) in packets.enumerated() {
                let b64 = packet.base64EncodedString()
                self.sendToWorklet(["type": "packet", "data": b64])
            }
            // Re-register for next batch
            self.startPacketReadLoop()
        }
    }

    // MARK: - IPC

    private func sendToWorklet(_ msg: [String: Any]) {
        guard let ipc = ipc,
              let data = try? JSONSerialization.data(withJSONObject: msg),
              let json = String(data: data, encoding: .utf8) else { return }
        let line = json + "\n"
        ipc.write(line.data(using: .utf8)!)
    }

    private func readIPC() {
        guard let ipc = ipc else { return }
        while let data = ipc.read() {
            ipcBuffer.append(data)
        }
        // Split on newlines
        while let range = ipcBuffer.range(of: Data("\n".utf8)) {
            let line = ipcBuffer.subdata(in: ipcBuffer.startIndex..<range.lowerBound)
            ipcBuffer.removeSubrange(ipcBuffer.startIndex...range.lowerBound)

            guard let msg = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let type = msg["type"] as? String else { continue }

            handleWorkletMessage(type, msg)
        }
    }

    private func handleWorkletMessage(_ type: String, _ msg: [String: Any]) {
        switch type {
        case "ready":
            break // worklet is up, start message already sent

        case "connected":
            // DHT connected — configure tunnel and start packet loop
            configureTunnel { [weak self] error in
                if let error = error {
                    self?.startCompletion?(error)
                } else {
                    self?.startCompletion?(nil)
                    self?.startPacketReadLoop()
                }
                self?.startCompletion = nil
            }

        case "packet":
            // Inbound packet from server — write to TUN
            if let b64 = msg["data"] as? String,
               let packet = Data(base64Encoded: b64) {
                let version = packet.first.map { $0 >> 4 } ?? 4
                let proto = NSNumber(value: version == 6 ? AF_INET6 : AF_INET)
                self.packetFlow.writePackets([packet], withProtocols: [proto])
            }

        case "status":
            // Could update reasserting state here
            break

        case "identity":
            break // could store for display

        case "error":
            let message = msg["message"] as? String ?? "Unknown error"
            NSLog("nospoon worklet error: %@", message)

        case "stopped":
            cleanup()

        default:
            break
        }
    }
}

func prefixToNetmask(_ prefix: Int) -> String {
    let mask: UInt32 = prefix == 0 ? 0 : (~UInt32(0)) << (32 - prefix)
    return "\(mask >> 24 & 0xff).\(mask >> 16 & 0xff).\(mask >> 8 & 0xff).\(mask & 0xff)"
}
```

---

## Step 4: VpnManager.swift (main app)

```swift
import NetworkExtension

class VpnManager: ObservableObject {
    @Published var status: NEVPNStatus = .disconnected
    private var manager: NETunnelProviderManager?
    private var observer: Any?

    func load() async throws {
        let managers = try await NETunnelProviderManager.loadAllFromPreferences()
        manager = managers.first ?? NETunnelProviderManager()

        let proto = NETunnelProviderProtocol()
        proto.providerBundleIdentifier = "com.nospoon.vpn.PacketTunnel"
        proto.serverAddress = "HyperDHT" // display only
        manager?.protocolConfiguration = proto
        manager?.isEnabled = true

        try await manager?.saveToPreferences()

        // Observe status changes
        observer = NotificationCenter.default.addObserver(
            forName: .NEVPNStatusDidChange,
            object: manager?.connection,
            queue: .main
        ) { [weak self] _ in
            self?.status = self?.manager?.connection.status ?? .disconnected
        }
        status = manager?.connection.status ?? .disconnected
    }

    func connect(config: [String: Any]) throws {
        // Save config to App Group for the extension to read
        let defaults = UserDefaults(suiteName: Constants.appGroup)
        let data = try JSONSerialization.data(withJSONObject: config)
        defaults?.set(String(data: data, encoding: .utf8), forKey: "activeConfig")

        try manager?.connection.startVPNTunnel()
    }

    func disconnect() {
        manager?.connection.stopVPNTunnel()
    }
}
```

---

## Step 5: Build Script (`ios/build.sh`)

```bash
#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "=== Installing worklet dependencies ==="
npm install

echo "=== Linking native addons for iOS ==="
npx bare-link --preset ios --out addons

echo "=== Packing worklet bundle ==="
npx bare-pack --preset ios --linked --out Resources/client.bundle worklet/client.js

echo "=== Build complete ==="
echo "Open nospoon.xcodeproj in Xcode to build and run."
```

### `ios/package.json`

```json
{
  "name": "nospoon-ios",
  "version": "0.3.2",
  "private": true,
  "description": "nospoon iOS VPN app - Bare worklet dependencies",
  "scripts": {
    "link": "bare-link --preset ios --out addons",
    "pack": "bare-pack --preset ios --linked --out Resources/client.bundle worklet/client.js"
  },
  "dependencies": {
    "hyperdht": "^6.29.1"
  },
  "devDependencies": {
    "bare-link": "latest",
    "bare-pack": "latest"
  }
}
```

Note: **no `bare-fs` dependency** (unlike Android). iOS worklet doesn't access the
filesystem for TUN I/O.

---

## Android vs iOS Comparison

| Aspect | Android | iOS |
|--------|---------|-----|
| VPN API | `VpnService` (Kotlin) | `NEPacketTunnelProvider` (Swift) |
| TUN creation | `Builder.establish()` returns fd | `setTunnelNetworkSettings()` |
| Packet I/O | Raw fd read/write in worklet | `NEPacketTunnelFlow` in Swift, IPC to worklet |
| TUN fd to worklet | Yes, fd sent via IPC | **No.** No raw fd on iOS |
| Socket protection | `VpnService.protect(fd)` + IPC | Automatic — extension sockets bypass tunnel |
| JS engine | BareKit V8 (~31MB) | BareKit JSC (~2.6MB, system JavaScriptCore) |
| Process model | VpnService in app process | Extension in **separate process** |
| Memory limit | No hard limit | 50MB (iOS 15+) |
| Background | Foreground service + WakeLock | Automatic while tunnel active |
| Full tunnel | `addRoute("0.0.0.0", 0)` | `includedRoutes = [.default()]` |
| App↔Extension | Intent + Broadcast | NETunnelProviderManager + App Group |
| Config storage | SharedPreferences | App Group UserDefaults + Keychain |
| Per-packet overhead | Zero (direct fd) | IPC serialization (base64) |
| Build | Gradle + bare-pack/bare-link | Xcode + bare-pack/bare-link |
| Distribution | APK / Play Store | TestFlight / App Store |
| Developer account | Any | **Organization** required for VPN apps |

---

## Known Risks

### Must validate by prototyping (Phase 0)

1. **BareKit JSC in Network Extension** — proven in app process (Keet is on App Store),
   but **unproven inside a Network Extension**. Memory behavior under the 50MB limit needs
   real-device testing.

2. **IPC packet throughput** — every packet crosses Swift↔JS IPC twice. Must benchmark
   with real traffic (video calls, file transfers). If too slow, switch to binary framing.

3. **HyperDHT UDP in extension** — UDX (custom UDP transport) should work from the
   extension process, but socket lifecycle and iOS networking subtleties need testing.

### High risk

4. **App Store review** — requires organization developer account. P2P VPN apps may
   face additional scrutiny. Can test via TestFlight first.

5. **Memory pressure under load** — packet buffers accumulate during high throughput.
   May need backpressure/flow control to stay under 50MB.

### Medium risk

6. **iOS power management** — iOS may throttle the extension when locked. HyperDHT's
   keepalive should help, but needs testing.

7. **IPv6 protocol detection** — `writePackets` requires `AF_INET` vs `AF_INET6`.
   Worklet must inspect IP header version and include it in IPC messages.

---

## Implementation Order

### Phase 0: Feasibility Prototype

**Goal:** Prove BareKit JSC + HyperDHT can run in a Network Extension under 50MB.

```
1. [ ] Create minimal Xcode project (app + packet tunnel extension)
2. [ ] Embed BareKit.xcframework (ios-javascriptcore variant)
3. [ ] Start minimal BareWorklet in startTunnel() — "hello world" IPC
4. [ ] Measure memory usage
5. [ ] Initialize HyperDHT in worklet, connect to test server
6. [ ] Measure memory with DHT active
7. [ ] DECISION GATE: if memory > 40MB or crashes, investigate alternatives
```

### Phase 1: Working Tunnel

**Goal:** End-to-end VPN connection with packet forwarding.

```
1. [ ] Implement PacketTunnelProvider.swift (lifecycle, settings, packet loop)
2. [ ] Implement WorkletBridge.swift (BareWorklet + BareIPC management)
3. [ ] Create ios/worklet/client.js (adapted from Android)
4. [ ] Copy framing.js from Android worklet
5. [ ] Set up build pipeline (bare-pack/bare-link for iOS)
6. [ ] Test: connect to nospoon server, ping remote IP
7. [ ] Benchmark IPC packet throughput
```

### Phase 2: App UI

**Goal:** Feature parity with Android app.

```
1. [ ] SwiftUI config list + connection status
2. [ ] Config editor (server key, IP, seed, full tunnel)
3. [ ] QR code scanning for key import
4. [ ] NETunnelProviderManager management (load/save/start/stop)
5. [ ] App Group config passing to extension
6. [ ] Keychain storage for seeds
```

### Phase 3: Full Tunnel + Polish

```
1. [ ] Full tunnel: includedRoutes = [.default()] + DNS settings
2. [ ] Reconnection testing (airplane mode, WiFi↔cellular)
3. [ ] Memory profiling under sustained load
4. [ ] Add backpressure if IPC is bottleneck
5. [ ] On-demand VPN rules (optional)
```

### Phase 4: Distribution

```
1. [ ] Apple Developer organization account setup
2. [ ] Privacy policy (no data collection, P2P only)
3. [ ] Provisioning profiles with Network Extension entitlement
4. [ ] TestFlight beta
5. [ ] App Store submission
```

---

## Testing Checklist

- [ ] Worklet starts in Network Extension without exceeding 50MB
- [ ] DHT connects to a nospoon Linux server
- [ ] Packets flow bidirectionally (ping server TUN IP)
- [ ] Full tunnel routes all traffic through VPN
- [ ] DNS resolves through VPN (no leak)
- [ ] Disconnect from app stops tunnel
- [ ] Disconnect from iOS Settings stops tunnel + updates app UI
- [ ] Reconnects after airplane mode toggle
- [ ] Reconnects after WiFi → cellular switch
- [ ] Sustained throughput doesn't trigger jetsam (memory kill)
- [ ] QR code imports server key correctly
- [ ] Config persists across app restarts
