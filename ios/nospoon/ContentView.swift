import SwiftUI
import NetworkExtension

struct ContentView: View {
    @EnvironmentObject var vpnManager: VpnManager
    @State private var configs: [VpnConfig] = []
    @State private var showEditor = false
    @State private var editingConfig: VpnConfig?
    @State private var activeConfigId: UUID?

    var body: some View {
        NavigationView {
            List {
                Section {
                    StatusRow(status: vpnManager.status)
                }

                Section("Configurations") {
                    ForEach(configs) { config in
                        ConfigRow(
                            config: config,
                            isActive: activeConfigId == config.id
                                && vpnManager.status == .connected,
                            onConnect: { connectWith(config) },
                            onDisconnect: {
                                vpnManager.disconnect()
                                activeConfigId = nil
                            },
                            onEdit: {
                                editingConfig = config
                                showEditor = true
                            }
                        )
                    }
                    .onDelete(perform: deleteConfigs)
                }
            }
            .navigationTitle("nospoon")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: {
                        editingConfig = nil
                        showEditor = true
                    }) {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $showEditor) {
                ConfigEditorView(
                    config: editingConfig ?? VpnConfig(),
                    isNew: editingConfig == nil
                ) { saved in
                    if let idx = configs.firstIndex(where: { $0.id == saved.id }) {
                        configs[idx] = saved
                    } else {
                        configs.append(saved)
                    }
                    VpnConfig.saveAll(configs)
                }
            }
            .task {
                configs = VpnConfig.loadAll()
                try? await vpnManager.load()
            }
        }
    }

    private func connectWith(_ config: VpnConfig) {
        do {
            activeConfigId = config.id
            try vpnManager.connect(config: config.toWorkletConfig())
        } catch {
            activeConfigId = nil
            NSLog("nospoon connect error: %@", error.localizedDescription)
        }
    }

    private func deleteConfigs(at offsets: IndexSet) {
        configs.remove(atOffsets: offsets)
        VpnConfig.saveAll(configs)
    }
}

// MARK: - Subviews

struct StatusRow: View {
    let status: NEVPNStatus

    var body: some View {
        HStack {
            Circle()
                .fill(statusColor)
                .frame(width: 12, height: 12)
            Text(statusText)
                .font(.headline)
        }
    }

    private var statusColor: Color {
        switch status {
        case .connected: return .green
        case .connecting, .reasserting: return .orange
        case .disconnecting: return .orange
        default: return .red
        }
    }

    private var statusText: String {
        switch status {
        case .connected: return "Connected"
        case .connecting: return "Connecting..."
        case .disconnecting: return "Disconnecting..."
        case .reasserting: return "Reconnecting..."
        case .invalid: return "Not Configured"
        default: return "Disconnected"
        }
    }
}

struct ConfigRow: View {
    let config: VpnConfig
    let isActive: Bool
    let onConnect: () -> Void
    let onDisconnect: () -> Void
    let onEdit: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(config.name.isEmpty ? "Unnamed" : config.name)
                    .font(.body)
                Text(config.ip)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer()

            Button(action: onEdit) {
                Image(systemName: "pencil")
            }
            .buttonStyle(.borderless)

            if isActive {
                Button("Disconnect", action: onDisconnect)
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
            } else {
                Button("Connect", action: onConnect)
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}
