#ifdef __ANDROID__

// On Android, VpnService.Builder owns all routing/NAT/DNS plumbing — we
// never invoke any of these from client.cpp / server.cpp because:
//   - client.cpp gates `enable_client_full_tunnel(...)` on fd_socket < 0
//     (the Android path always passes a fd-socket, so the branch is dead)
//   - server.cpp doesn't run on Android (the app forks the binary in
//     client mode only)
//
// These stubs just satisfy the linker. If something here is ever called,
// the warning printed makes it obvious in logcat that something's wrong.

#include "full_tunnel.hpp"

#include <cstdio>

namespace nospoon::full_tunnel {

namespace {
inline void warn(const char* fn) {
    std::fprintf(stderr,
        "full_tunnel::%s called on Android — this should never happen "
        "(VpnService.Builder owns routing). Ignoring.\n", fn);
}
}  // namespace

bool enable_server_forwarding(const std::string&, const std::string&,
                              const std::string&) {
    warn("enable_server_forwarding");
    return false;
}

void disable_server_forwarding() {
    warn("disable_server_forwarding");
}

bool enable_client_full_tunnel(const std::string&, const std::string&) {
    warn("enable_client_full_tunnel");
    return false;
}

void add_host_exemption(const std::string&) {
    warn("add_host_exemption");
}

void disable_client_full_tunnel() {
    warn("disable_client_full_tunnel");
}

}  // namespace nospoon::full_tunnel

#endif  // __ANDROID__
