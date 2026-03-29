import Foundation

struct VpnConfig: Identifiable, Codable {
    let id: UUID
    var name: String
    var server: String      // 64-char hex public key
    var ip: String           // e.g. "10.0.0.2/24"
    var seed: String?        // 64-char hex seed (optional, for stable identity)
    var mtu: Int
    var fullTunnel: Bool

    init(
        id: UUID = UUID(),
        name: String = "",
        server: String = "",
        ip: String = "10.0.0.2/24",
        seed: String? = nil,
        mtu: Int = 1400,
        fullTunnel: Bool = false
    ) {
        self.id = id
        self.name = name
        self.server = server
        self.ip = ip
        self.seed = seed
        self.mtu = mtu
        self.fullTunnel = fullTunnel
    }

    // Convert to the JSON format the worklet expects
    func toWorkletConfig() -> [String: Any] {
        var config: [String: Any] = [
            "server": server,
            "ip": ip,
            "mtu": mtu,
            "fullTunnel": fullTunnel
        ]
        if let seed = seed, !seed.isEmpty {
            config["seed"] = seed
        }
        return config
    }
}

// Persistence via App Group UserDefaults
extension VpnConfig {
    static func loadAll() -> [VpnConfig] {
        guard let defaults = UserDefaults(suiteName: Constants.appGroup),
              let data = defaults.data(forKey: "configs"),
              let configs = try? JSONDecoder().decode([VpnConfig].self, from: data) else {
            return []
        }
        return configs
    }

    static func saveAll(_ configs: [VpnConfig]) {
        guard let defaults = UserDefaults(suiteName: Constants.appGroup),
              let data = try? JSONEncoder().encode(configs) else { return }
        defaults.set(data, forKey: "configs")
    }
}
