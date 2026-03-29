import SwiftUI

@main
struct NospoonApp: App {
    @StateObject private var vpnManager = VpnManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(vpnManager)
        }
    }
}
