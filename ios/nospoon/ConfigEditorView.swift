import SwiftUI
import AVFoundation

struct ConfigEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State var config: VpnConfig
    let isNew: Bool
    let onSave: (VpnConfig) -> Void

    @State private var showScanner = false

    var body: some View {
        NavigationView {
            Form {
                Section("General") {
                    TextField("Name", text: $config.name)
                    TextField("IP Address (e.g. 10.0.0.2/24)", text: $config.ip)
                        .keyboardType(.numbersAndPunctuation)
                        .autocapitalization(.none)
                }

                Section("Server") {
                    TextField("Server Public Key (64 hex)", text: $config.server)
                        .font(.system(.body, design: .monospaced))
                        .autocapitalization(.none)
                        .disableAutocorrection(true)

                    Button(action: { showScanner = true }) {
                        Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                    }
                }

                Section("Identity (Optional)") {
                    TextField("Seed (64 hex, for stable identity)", text: Binding(
                        get: { config.seed ?? "" },
                        set: { config.seed = $0.isEmpty ? nil : $0 }
                    ))
                    .font(.system(.body, design: .monospaced))
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                }

                Section("Advanced") {
                    Stepper("MTU: \(config.mtu)", value: $config.mtu, in: 576...1500, step: 100)
                    Toggle("Full Tunnel (route all traffic)", isOn: $config.fullTunnel)
                }
            }
            .navigationTitle(isNew ? "New Config" : "Edit Config")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Save") {
                        onSave(config)
                        dismiss()
                    }
                    .disabled(!isValid)
                }
            }
            .sheet(isPresented: $showScanner) {
                QRScannerView { scanned in
                    // Accept raw hex key or nospoon:// URL
                    let key = parseServerKey(scanned)
                    if let key = key {
                        config.server = key
                    }
                }
            }
        }
    }

    private var isValid: Bool {
        let hexPattern = /^[0-9a-fA-F]{64}$/
        guard config.server.wholeMatch(of: hexPattern) != nil else { return false }
        guard config.ip.contains("/") else { return false }
        if let seed = config.seed, !seed.isEmpty {
            guard seed.wholeMatch(of: hexPattern) != nil else { return false }
        }
        return true
    }

    private func parseServerKey(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let hexPattern = /^[0-9a-fA-F]{64}$/

        // Raw hex key
        if trimmed.wholeMatch(of: hexPattern) != nil {
            return trimmed
        }

        // nospoon://connect?key=<hex>
        if let url = URL(string: trimmed),
           let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let key = components.queryItems?.first(where: { $0.name == "key" })?.value,
           key.wholeMatch(of: hexPattern) != nil {
            return key
        }

        return nil
    }
}
