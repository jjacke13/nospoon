import NetworkExtension

class VpnManager: ObservableObject {
    @Published var status: NEVPNStatus = .disconnected
    private var manager: NETunnelProviderManager?
    private var observer: Any?

    func load() async throws {
        let managers = try await NETunnelProviderManager.loadAllFromPreferences()
        let existing = managers.first

        if let existing = existing {
            manager = existing
        } else {
            let fresh = NETunnelProviderManager()
            let proto = NETunnelProviderProtocol()
            proto.providerBundleIdentifier = Constants.bundleIdTunnel
            proto.serverAddress = "HyperDHT" // display only
            fresh.protocolConfiguration = proto
            fresh.isEnabled = true
            try await fresh.saveToPreferences()
            manager = fresh
        }

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
        defaults?.set(String(data: data, encoding: .utf8), forKey: Constants.activeConfigKey)

        try manager?.connection.startVPNTunnel()
    }

    func disconnect() {
        manager?.connection.stopVPNTunnel()
    }

    deinit {
        if let observer = observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}
