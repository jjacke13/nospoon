// Nospoon — P2P VPN powered by hyperdht-cpp
//
// Usage:
//   nospoon <config.jsonc>     Start VPN (server or client mode)
//   nospoon genkey             Generate seed + public key pair
//
// Requires root/CAP_NET_ADMIN for TUN device creation.

#include "commands.hpp"
#include "config.hpp"

#include <sodium.h>

#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

// Defined in server.cpp / client.cpp
int run_server(const nospoon::Config& config);
int run_client(const nospoon::Config& config);

static void usage() {
    fprintf(stderr,
        "nospoon — P2P VPN powered by hyperdht-cpp\n"
        "\n"
        "Usage:\n"
        "  nospoon up [config]      Start VPN (default: /etc/nospoon/config.jsonc)\n"
        "  nospoon <config.jsonc>   Start VPN (legacy)\n"
        "\n"
        "Utilities (no root, no TUN):\n"
        "  nospoon genkey [seed]    Generate a keypair, or derive one from a\n"
        "                           seed (hex, or a file holding it)\n"
        "  nospoon inspect <config> Validate a config, show what it resolves to\n"
        "  nospoon check [config]   Probe the DHT bootstrap; with a client\n"
        "                           config, also dial its server\n"
        "  nospoon init <dir> [-n N]          New deployment: server + N clients\n"
        "  nospoon addclient <server> [-n N]  Add N clients to a deployment\n"
        "\n"
        "Config (server):\n"
        "  { \"mode\": \"server\", \"ip\": \"10.0.0.1/24\", \"seed\": \"...\",\n"
        "    \"peers\": { \"<pubkey>\": \"10.0.0.2\" } }\n"
        "\n"
        "Config (client):\n"
        "  { \"mode\": \"client\", \"server\": \"<pubkey>\",\n"
        "    \"ip\": \"10.0.0.2/24\", \"seed\": \"...\" }\n");
}

int main(int argc, char** argv) {
#ifndef _WIN32
    // Don't die on EPIPE: when the underlying network goes away (Wi-Fi →
    // mobile-data switch) writes to UDP/IPC sockets can fail with SIGPIPE,
    // which by default kills the process. We handle the EPIPE return value
    // ourselves and recover via DHT restart.
    //
    // Windows sockets never raise SIGPIPE — failed sends return WSAECONNRESET
    // / WSAENETRESET via WSAGetLastError(). No signal handler needed.
    std::signal(SIGPIPE, SIG_IGN);
#endif

    if (sodium_init() < 0) {
        fprintf(stderr, "Error: sodium_init failed\n");
        return 1;
    }

    if (argc < 2) {
        usage();
        return 1;
    }

    if (std::strcmp(argv[1], "--help") == 0 || std::strcmp(argv[1], "-h") == 0) {
        usage();
        return 0;
    }

    // Utility verbs — none of these touch a TUN (see commands.cpp).
    if (std::strcmp(argv[1], "genkey") == 0)    return nospoon::cmd_genkey(argc, argv);
    if (std::strcmp(argv[1], "inspect") == 0)   return nospoon::cmd_inspect(argc, argv);
    if (std::strcmp(argv[1], "check") == 0)     return nospoon::cmd_check(argc, argv);
    if (std::strcmp(argv[1], "init") == 0)      return nospoon::cmd_init(argc, argv);
    if (std::strcmp(argv[1], "addclient") == 0) return nospoon::cmd_addclient(argc, argv);

    // Match the JS CLI contract: `nospoon up [config]` with a default
    // config path. Bare `nospoon <config>` still works for back-compat.
    const char* config_path = argv[1];
    if (std::strcmp(argv[1], "up") == 0) {
        config_path = (argc >= 3) ? argv[2] : "/etc/nospoon/config.jsonc";
    }

    auto config = nospoon::load_config(config_path);

    if (config.mode == "server") {
        return run_server(config);
    } else if (config.mode == "client") {
        return run_client(config);
    } else {
        fprintf(stderr, "Error: unknown mode \"%s\" (use \"server\" or \"client\")\n",
                config.mode.c_str());
        return 1;
    }
}
