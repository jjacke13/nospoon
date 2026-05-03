// Nospoon — P2P VPN powered by hyperdht-cpp
//
// Usage:
//   nospoon up <config.jsonc> [--fd-socket=N]   Start VPN
//   nospoon <config.jsonc>                      Same (legacy form)
//   nospoon genkey                              Generate seed + public key pair
//
// Requires root/CAP_NET_ADMIN for TUN device creation, except on Android
// where the TUN fd is supplied by VpnService and passed in via --fd-socket.

#include "config.hpp"

#include <sodium.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

// Defined in server.cpp / client.cpp
int run_server(const nospoon::Config& config);
int run_client(const nospoon::Config& config);

static void genkey() {
    uint8_t seed[32];
    randombytes_buf(seed, sizeof(seed));

    // Derive keypair from seed (same as HyperDHT.keyPair(seed))
    uint8_t pk[32], sk[64];
    crypto_sign_seed_keypair(pk, sk, seed);

    printf("seed:       %s\n", nospoon::bytes_to_hex(seed, 32).c_str());
    printf("public_key: %s\n", nospoon::bytes_to_hex(pk, 32).c_str());
}

static void usage() {
    fprintf(stderr,
        "nospoon — P2P VPN powered by hyperdht-cpp\n"
        "\n"
        "Usage:\n"
        "  nospoon up <config.jsonc> [--fd-socket=N]   Start VPN\n"
        "  nospoon genkey                              Generate keypair\n"
        "\n"
        "Flags:\n"
        "  --fd-socket=N   Two-phase mode: connect DHT first, then receive\n"
        "                  TUN fd via SCM_RIGHTS over Unix socket fd N\n"
        "                  (used by the Android VpnService bridge).\n"
        "\n"
        "Config (server):\n"
        "  { \"mode\": \"server\", \"ip\": \"10.0.0.1/24\", \"seed\": \"...\",\n"
        "    \"peers\": { \"<pubkey>\": \"10.0.0.2\" } }\n"
        "\n"
        "Config (client):\n"
        "  { \"mode\": \"client\", \"server\": \"<pubkey>\",\n"
        "    \"ip\": \"10.0.0.2/24\", \"seed\": \"...\" }\n");
}

// Look for --fd-socket=N starting at start_index. Returns the parsed fd or -1
// if absent. Errors out on invalid values.
static int parse_fd_socket(int argc, char** argv, int start_index) {
    for (int i = start_index; i < argc; i++) {
        const char* prefix = "--fd-socket=";
        size_t plen = std::strlen(prefix);
        if (std::strncmp(argv[i], prefix, plen) == 0) {
            const char* val = argv[i] + plen;
            char* endp = nullptr;
            long n = std::strtol(val, &endp, 10);
            if (endp == val || *endp != '\0' || n < 0 || n > 65535) {
                fprintf(stderr, "Error: --fd-socket must be a non-negative integer\n");
                std::exit(1);
            }
            return static_cast<int>(n);
        }
    }
    return -1;
}

int main(int argc, char** argv) {
    if (sodium_init() < 0) {
        fprintf(stderr, "Error: sodium_init failed\n");
        return 1;
    }

    if (argc < 2) {
        usage();
        return 1;
    }

    if (std::strcmp(argv[1], "genkey") == 0) {
        genkey();
        return 0;
    }

    if (std::strcmp(argv[1], "--help") == 0 || std::strcmp(argv[1], "-h") == 0) {
        usage();
        return 0;
    }

    // Accept both `nospoon up [flags] <config> [flags]` (matches the JS CLI
    // and the Android NospoonVpnService — which puts --fd-socket *before*
    // the config path) and the legacy `nospoon <config>`. Flag args start
    // with '-'; the first non-flag is the config path.
    const char* config_path = nullptr;
    int flags_start = 0;
    if (std::strcmp(argv[1], "up") == 0) {
        flags_start = 2;
        for (int i = 2; i < argc; i++) {
            if (argv[i][0] != '-') {
                config_path = argv[i];
                break;
            }
        }
        if (!config_path) {
            usage();
            return 1;
        }
    } else {
        config_path = argv[1];
        flags_start = 2;
    }

    auto config = nospoon::load_config(config_path);
    config.fd_socket = parse_fd_socket(argc, argv, flags_start);

    if (config.mode == "server") {
        if (config.fd_socket >= 0) {
            fprintf(stderr,
                "Error: --fd-socket is only supported in client mode (server "
                "owns its own TUN device)\n");
            return 1;
        }
        return run_server(config);
    } else if (config.mode == "client") {
        return run_client(config);
    } else {
        fprintf(stderr, "Error: unknown mode \"%s\" (use \"server\" or \"client\")\n",
                config.mode.c_str());
        return 1;
    }
}
