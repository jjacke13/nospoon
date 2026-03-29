import NetworkExtension
import BareKit

class PacketTunnelProvider: NEPacketTunnelProvider {

    private var worklet: Worklet?
    private var ipc: IPC?
    private var ipcReadTask: Task<Void, Never>?
    private var startCompletion: ((Error?) -> Void)?
    private var startTimeoutTask: Task<Void, Never>?
    private var running = false

    // MARK: - Lifecycle

    override func startTunnel(
        options: [String: NSObject]?,
        completionHandler: @escaping (Error?) -> Void
    ) {
        startCompletion = completionHandler

        // Read config from App Group shared storage
        guard let defaults = UserDefaults(suiteName: Constants.appGroup),
              let configJson = defaults.string(forKey: Constants.activeConfigKey),
              let configData = configJson.data(using: .utf8),
              let configObj = try? JSONSerialization.jsonObject(with: configData)
                  as? [String: Any] else {
            completionHandler(NSError(domain: "nospoon", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No config found"]))
            return
        }

        // Start Bare worklet (JSC variant, 32MB limit for extension headroom)
        let config = Worklet.Configuration(
            memoryLimit: 32 * 1024 * 1024
        )
        worklet = Worklet(configuration: config)
        worklet?.start(name: "client", ofType: "bundle")

        ipc = IPC(worklet: worklet!)
        running = true

        // Start reading IPC messages from worklet
        startIPCReadLoop()

        // Send start message with parsed config object (not stringified JSON)
        Task { await sendToWorklet(["type": "start", "config": configObj]) }

        // Timeout: if worklet doesn't connect within 30s, fail
        startTimeoutTask = Task {
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            if let completion = self.startCompletion {
                self.startCompletion = nil
                completion(NSError(domain: "nospoon", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "Connection timeout"]))
                self.cleanup()
            }
        }
    }

    override func stopTunnel(
        with reason: NEProviderStopReason,
        completionHandler: @escaping () -> Void
    ) {
        running = false
        Task {
            await sendToWorklet(["type": "stop"])

            // Give worklet 2s to clean up, then force terminate
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            cleanup()
            completionHandler()
        }
    }

    private func cleanup() {
        running = false
        startTimeoutTask?.cancel()
        startTimeoutTask = nil
        ipcReadTask?.cancel()
        ipcReadTask = nil
        ipc?.close()
        ipc = nil
        worklet?.terminate()
        worklet = nil
    }

    // MARK: - Tunnel network settings

    private func configureTunnel() async throws {
        guard let defaults = UserDefaults(suiteName: Constants.appGroup),
              let configJson = defaults.string(forKey: Constants.activeConfigKey),
              let configData = configJson.data(using: .utf8),
              let config = try? JSONSerialization.jsonObject(with: configData)
                  as? [String: Any] else {
            throw NSError(domain: "nospoon", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Cannot parse config"])
        }

        let ipStr = (config["ip"] as? String) ?? "10.0.0.2/24"
        let parts = ipStr.split(separator: "/")
        let ip = String(parts[0])
        let prefix = parts.count >= 2 ? (Int(parts[1]) ?? 24) : 24
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

        try await setTunnelNetworkSettings(settings)
    }

    // MARK: - Packet read loop (TUN -> worklet)

    private func startPacketReadLoop() {
        guard running else { return }
        packetFlow.readPackets { [weak self] packets, protocols in
            guard let self = self, self.running else { return }
            Task {
                for packet in packets {
                    let b64 = packet.base64EncodedString()
                    await self.sendToWorklet(["type": "packet", "data": b64])
                }
            }
            // Re-register for next batch
            self.startPacketReadLoop()
        }
    }

    // MARK: - IPC (async/await based — from bare-kit-swift)

    private func sendToWorklet(_ msg: [String: Any]) async {
        guard let ipc = ipc,
              let data = try? JSONSerialization.data(withJSONObject: msg),
              let json = String(data: data, encoding: .utf8) else { return }
        let line = json + "\n"
        do {
            try await ipc.write(data: line.data(using: .utf8)!)
        } catch {
            NSLog("nospoon IPC write failed: %@", error.localizedDescription)
        }
    }

    // IPC conforms to AsyncSequence — iterate with for-await
    private func startIPCReadLoop() {
        ipcReadTask = Task { [weak self] in
            guard let self = self, let ipc = self.ipc else { return }
            var buffer = Data()

            for await data in ipc {
                buffer.append(data)

                // Split on newlines
                while let range = buffer.range(of: Data("\n".utf8)) {
                    let line = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
                    buffer.removeSubrange(buffer.startIndex...range.lowerBound)

                    guard let msg = try? JSONSerialization.jsonObject(with: line)
                              as? [String: Any],
                          let type = msg["type"] as? String else { continue }

                    await self.handleWorkletMessage(type, msg)
                }
            }
        }
    }

    private func handleWorkletMessage(_ type: String, _ msg: [String: Any]) async {
        switch type {
        case "ready":
            break // worklet is up, start message already sent

        case "connected":
            // DHT connected — configure tunnel and start packet loop
            // Guard: only call startCompletion once (ignore reconnect "connected" messages)
            guard let completion = startCompletion else {
                // Reconnection — tunnel already configured
                return
            }
            startCompletion = nil
            startTimeoutTask?.cancel()
            startTimeoutTask = nil

            do {
                try await configureTunnel()
                completion(nil)
                startPacketReadLoop()
            } catch {
                completion(error)
                cleanup()
            }

        case "packet":
            // Inbound packet from server — write to TUN
            if let b64 = msg["data"] as? String,
               let packet = Data(base64Encoded: b64) {
                let version = packet.first.map { $0 >> 4 } ?? 4
                let proto = NSNumber(value: version == 6 ? AF_INET6 : AF_INET)
                packetFlow.writePackets([packet], withProtocols: [proto])
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

private func prefixToNetmask(_ prefix: Int) -> String {
    let clamped = min(max(prefix, 0), 32)
    let mask: UInt32 = clamped == 0 ? 0 : (~UInt32(0)) << (32 - clamped)
    return "\(mask >> 24 & 0xff).\(mask >> 16 & 0xff).\(mask >> 8 & 0xff).\(mask & 0xff)"
}
