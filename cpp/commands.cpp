// Non-tunnel CLI verbs: genkey, inspect, check, init, addclient.
// None of these open a TUN or need root.

#include "commands.hpp"
#include "config.hpp"
#include "connect_error.hpp"

#include <hyperdht/dht.hpp>
#include <sodium.h>
#include <uv.h>

#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#ifndef _WIN32
#include <sys/stat.h>
#endif

using namespace hyperdht;

namespace nospoon {
namespace {

// --- small shared helpers -------------------------------------------------

std::string read_file(const std::string& path, bool* ok) {
    std::ifstream f(path);
    if (!f.is_open()) { *ok = false; return ""; }
    std::stringstream b;
    b << f.rdbuf();
    *ok = true;
    return b.str();
}

std::string trim(std::string s) {
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r' ||
                          s.back() == ' '  || s.back() == '\t')) s.pop_back();
    size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' ||
                            s[i] == '\n' || s[i] == '\r')) i++;
    return s.substr(i);
}

// These files carry private seeds. Owner-only, always.
bool write_secret(const std::string& path, const std::string& body) {
    std::ofstream f(path, std::ios::trunc);
    if (!f.is_open()) {
        fprintf(stderr, "Error: cannot write %s\n", path.c_str());
        return false;
    }
    f << body;
    f.close();
#ifndef _WIN32
    if (chmod(path.c_str(), 0600) != 0) {
        fprintf(stderr, "Error: cannot chmod 600 %s — refusing to leave a "
                        "world-readable seed behind\n", path.c_str());
        std::remove(path.c_str());
        return false;
    }
#endif
    return true;
}

std::string pubkey_of(const std::string& seed_hex) {
    uint8_t seed[32], pk[32], sk[64];
    if (!hex_to_bytes(seed_hex, seed, 32)) return "";
    crypto_sign_seed_keypair(pk, sk, seed);
    sodium_memzero(sk, sizeof(sk));
    sodium_memzero(seed, sizeof(seed));
    return bytes_to_hex(pk, 32);
}

std::string new_seed_hex() {
    uint8_t seed[32];
    randombytes_buf(seed, sizeof(seed));
    auto hex = bytes_to_hex(seed, 32);
    sodium_memzero(seed, sizeof(seed));
    return hex;
}

// The seed a config actually resolves to: inline "seed", else "seedFile".
// load_config() has already done this resolution and validated the result.
std::string config_seed(const Config& cfg) { return cfg.seed; }

// Parse "-n N" out of argv. Returns false on a malformed value.
bool parse_count(int argc, char** argv, int start, int* n) {
    for (int i = start; i < argc - 1; i++) {
        if (std::strcmp(argv[i], "-n") == 0) {
            char* end = nullptr;
            long v = std::strtol(argv[i + 1], &end, 10);
            if (!end || *end != '\0' || v < 1 || v > 253) {
                fprintf(stderr, "Error: -n must be 1..253\n");
                return false;
            }
            *n = static_cast<int>(v);
        }
    }
    return true;
}

// --- /24 host allocation ---------------------------------------------------

struct Subnet {
    std::string base;      // "10.0.0"
    int prefix = 24;
    std::set<int> used;    // host octets already taken
};

// Split "10.0.0.1/24" into base + prefix, seeding `used` with .1.
bool parse_subnet(const std::string& cidr, Subnet* out) {
    auto slash = cidr.find('/');
    auto addr = (slash == std::string::npos) ? cidr : cidr.substr(0, slash);
    if (slash != std::string::npos) out->prefix = std::atoi(cidr.c_str() + slash + 1);
    auto dot = addr.rfind('.');
    if (dot == std::string::npos) {
        fprintf(stderr, "Error: cannot parse address %s\n", cidr.c_str());
        return false;
    }
    out->base = addr.substr(0, dot);
    out->used.insert(std::atoi(addr.c_str() + dot + 1));
    if (out->prefix != 24) {
        fprintf(stderr, "Warning: only /24 is supported for allocation, got /%d — "
                        "assigned addresses may be outside the subnet\n", out->prefix);
    }
    return true;
}

// Next free host octet, .2 upward. Returns 0 when the /24 is exhausted.
int next_host(Subnet* s) {
    for (int h = 2; h <= 254; h++) {
        if (s->used.insert(h).second) return h;
    }
    return 0;
}

std::string client_config(const std::string& server_pk, const std::string& ip,
                          int prefix, const std::string& seed, int mtu) {
    return "{\n"
           "  \"mode\": \"client\",\n"
           "  \"server\": \"" + server_pk + "\",\n"
           "  \"ip\": \"" + ip + "/" + std::to_string(prefix) + "\",\n"
           "  \"seed\": \"" + seed + "\",\n"
           "  \"mtu\": " + std::to_string(mtu) + "\n"
           "}\n";
}

// "client-007" — zero-padded so shell globs sort correctly.
std::string client_name(int index) {
    auto s = std::to_string(index);
    return "client-" + std::string(s.size() < 3 ? 3 - s.size() : 0, '0') + s;
}

// Generate `n` clients into `dir`, writing each config and returning the
// "pubkey" -> "ip" pairs the server needs in its peers map.
//
// Addresses are reserved up front: a partial run would leave client files on
// disk holding seeds the server was never told about, and those clients would
// be silently rejected.
bool make_clients(int n, const std::string& dir, const std::string& server_pk,
                  Subnet* net, int mtu, int first_index,
                  std::vector<std::pair<std::string, std::string>>* peers) {
    std::vector<int> hosts;
    for (int i = 0; i < n; i++) {
        int host = next_host(net);
        if (host == 0) {
            fprintf(stderr, "Error: subnet %s.0/%d has room for %zu more "
                            "client(s), not %d\n",
                    net->base.c_str(), net->prefix, hosts.size(), n);
            return false;
        }
        hosts.push_back(host);
    }

    printf("clients:\n");
    for (int i = 0; i < n; i++) {
        int host = hosts[i];
        auto seed = new_seed_hex();
        auto pk = pubkey_of(seed);
        auto ip = net->base + "." + std::to_string(host);

        // Never clobber an existing client file — it holds that client's
        // only copy of its seed. Skip past any name already taken.
        std::string name;
        do {
            name = dir + "/" + client_name(first_index++) + ".jsonc";
        } while (std::ifstream(name).good());

        if (!write_secret(name, client_config(server_pk, ip, net->prefix, seed, mtu)))
            return false;

        printf("  %s  ip=%s  pubkey=%s\n", name.c_str(), ip.c_str(), pk.c_str());
        peers->emplace_back(pk, ip);
    }
    return true;
}

// --- check ----------------------------------------------------------------

struct CheckCtx {
    uv_loop_t* loop = nullptr;
    HyperDHT* dht = nullptr;
    bool bootstrapped = false;
    bool dialed = false;
    bool have_server = false;
    int connect_error = 0;
    int exit_code = 2;   // pessimistic until proven otherwise
};

}  // namespace

// --- genkey ---------------------------------------------------------------

int cmd_genkey(int argc, char** argv) {
    std::string seed;

    if (argc >= 3) {
        // Argument is either the seed itself or a file holding it.
        bool ok = false;
        auto from_file = read_file(argv[2], &ok);
        seed = ok ? trim(from_file) : std::string(argv[2]);

        auto v = validation::validate_hex64(seed, "seed");
        if (!v.valid) {
            fprintf(stderr, "Error: %s\n", v.error.c_str());
            return 1;
        }
    } else {
        seed = new_seed_hex();
    }

    printf("seed:       %s\n", seed.c_str());
    printf("public_key: %s\n", pubkey_of(seed).c_str());
    return 0;
}

// --- inspect --------------------------------------------------------------

int cmd_inspect(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr, "Usage: nospoon inspect <config>\n");
        return 1;
    }
    // load_config validates every field and exits(1) with a precise message,
    // which is exactly what inspect should do on a bad file.
    auto cfg = load_config(argv[2]);

    printf("config:      %s\n", argv[2]);
    printf("mode:        %s\n", cfg.mode.c_str());
    printf("ip:          %s\n", cfg.ip.c_str());
    if (!cfg.ipv6.empty()) printf("ipv6:        %s\n", cfg.ipv6.c_str());
    printf("mtu:         %d\n", cfg.mtu);

    auto seed = config_seed(cfg);
    if (seed.empty()) {
        printf("identity:    none — a random key is generated at each start\n");
    } else {
        printf("seed:        %s\n", cfg.seed_file.empty()
                   ? "inline in config" : ("from " + cfg.seed_file).c_str());
        printf("public_key:  %s\n", pubkey_of(seed).c_str());
    }

    if (cfg.mode == "client") {
        printf("server:      %s\n", cfg.server_key.empty()
                   ? "(missing!)" : cfg.server_key.c_str());
    } else {
        if (cfg.peers.empty()) {
            printf("peers:       none — OPEN MODE, any key may connect\n");
        } else {
            printf("peers:       %zu\n", cfg.peers.size());
            for (const auto& [pk, ip] : cfg.peers)
                printf("             %s  %s\n", ip.c_str(), pk.c_str());
        }
    }

    printf("full_tunnel: %s\n", cfg.full_tunnel ? "yes" : "no");
    if (!cfg.out_iface.empty()) printf("out_iface:   %s\n", cfg.out_iface.c_str());
    return 0;
}

// --- check ----------------------------------------------------------------

int cmd_check(int argc, char** argv) {
    CheckCtx ctx;
    Config cfg;
    noise::PubKey server_pk{};

    if (argc >= 3) {
        cfg = load_config(argv[2]);
        if (cfg.mode != "client") {
            fprintf(stderr, "Error: check needs a CLIENT config (this one is "
                            "\"%s\"). Without one, run `nospoon check` to probe "
                            "the DHT only.\n", cfg.mode.c_str());
            return 1;
        }
        if (!hex_to_bytes(cfg.server_key, server_pk.data(), 32)) {
            fprintf(stderr, "Error: config has no valid \"server\" public key\n");
            return 1;
        }
        ctx.have_server = true;
    }

    uv_loop_t loop;
    uv_loop_init(&loop);
    ctx.loop = &loop;

    // Same identity the tunnel would use. A throwaway key would be silently
    // rejected by a server with a peers allowlist, and the failure would look
    // identical to a real one.
    DhtOptions opts;
    opts.bootstrap = HyperDHT::default_bootstrap_nodes();
    auto seed_hex = config_seed(cfg);
    if (!seed_hex.empty()) {
        noise::Seed seed{};
        if (!hex_to_bytes(seed_hex, seed.data(), 32)) {
            fprintf(stderr, "Error: invalid seed hex\n");
            return 1;
        }
        opts.default_keypair = noise::generate_keypair(seed);
        sodium_memzero(seed.data(), seed.size());
    }

    printf("bootstrap:   %zu nodes\n", opts.bootstrap.size());
    for (const auto& n : opts.bootstrap)
        printf("             %s:%u\n", n.host_string().c_str(), n.port);
    if (!seed_hex.empty())
        printf("identity:    %s\n", pubkey_of(seed_hex).c_str());

    HyperDHT dht(&loop, opts);
    ctx.dht = &dht;
    uint64_t t0 = uv_hrtime();

    dht.on_bootstrapped([&ctx, &dht, &server_pk, t0]() {
        ctx.bootstrapped = true;
        printf("bootstrap:   OK (%.2fs)\n", (uv_hrtime() - t0) / 1e9);
        if (!ctx.have_server) {
            ctx.exit_code = 0;
            uv_stop(ctx.loop);
            return;
        }
        // server.cpp keys connected peers by public key, so a second
        // connection with this identity replaces the first — dialing a
        // config whose tunnel is currently up will drop that tunnel.
        printf("dialing... (if a tunnel is already up with this identity, "
               "the server will drop it)\n");
        uint64_t t1 = uv_hrtime();
        dht.connect(server_pk, [&ctx, t1](int error, const ConnectResult& r) {
            ctx.dialed = true;
            ctx.connect_error = error;
            printf("dial:        %s (%d) in %.2fs\n",
                   connect_error_name(error), error, (uv_hrtime() - t1) / 1e9);
            if (error == ConnectError::NONE) {
                printf("peer:        %s:%u%s\n",
                       r.peer_address.host_string().c_str(), r.peer_address.port,
                       r.upgrade ? "  (via blind relay)" : "  (direct)");
                ctx.exit_code = 0;
            } else {
                if (const char* h = connect_error_hint(error))
                    printf("             %s\n", h);
                ctx.exit_code = 3;
            }
            uv_stop(ctx.loop);
        });
    });
    dht.bind();

    // Hard deadline so this is safe in a monitoring script.
    uv_timer_t deadline;
    uv_timer_init(&loop, &deadline);
    deadline.data = &ctx;
    uv_timer_start(&deadline, [](uv_timer_t* t) {
        auto* c = static_cast<CheckCtx*>(t->data);
        if (!c->bootstrapped) {
            printf("bootstrap:   TIMEOUT — no reply from any bootstrap node.\n"
                   "             This network appears to block the DHT "
                   "(UDP :49737).\n");
            c->exit_code = 2;
        } else if (!c->dialed) {
            printf("dial:        TIMEOUT\n");
            c->exit_code = 3;
        }
        uv_stop(c->loop);
    }, ctx.have_server ? 30000 : 15000, 0);

    uv_run(&loop, UV_RUN_DEFAULT);

    // The process is exiting; skip the deferred-teardown dance that
    // client.cpp needs only because its loop keeps running afterwards.
    return ctx.exit_code;
}

// --- init / addclient -----------------------------------------------------

int cmd_init(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr,
            "Usage: nospoon init <dir> [-n N] [--subnet 10.0.0.0/24] [--mtu 1400]\n");
        return 1;
    }
    std::string dir = argv[2];
    int n = 1, mtu = 1400;
    std::string subnet = "10.0.0.0/24";

    if (!parse_count(argc, argv, 3, &n)) return 1;
    for (int i = 3; i < argc - 1; i++) {
        if (std::strcmp(argv[i], "--subnet") == 0) subnet = argv[i + 1];
        if (std::strcmp(argv[i], "--mtu") == 0)    mtu = std::atoi(argv[i + 1]);
    }
    auto v = validation::validate_mtu(mtu);
    if (!v.valid) { fprintf(stderr, "Error: %s\n", v.error.c_str()); return 1; }

    Subnet net;
    if (!parse_subnet(subnet, &net)) return 1;
    net.used.clear();               // "10.0.0.0/24" seeds .0; the server takes .1
    net.used.insert(0);
    net.used.insert(1);
    std::string server_ip = net.base + ".1";

    // create_directories, not mkdir: Windows is a shipped target and a
    // POSIX-only guard here would leave the directory uncreated, failing at
    // the first file write. The 0700 tightening below is POSIX-only.
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    if (ec && !std::filesystem::is_directory(dir)) {
        fprintf(stderr, "Error: cannot create %s: %s\n",
                dir.c_str(), ec.message().c_str());
        return 1;
    }
#ifndef _WIN32
    if (chmod(dir.c_str(), 0700) != 0) {
        fprintf(stderr, "Error: cannot chmod 700 %s — refusing to write seeds "
                        "into a directory others can read\n", dir.c_str());
        return 1;
    }
#endif

    auto server_seed = new_seed_hex();
    auto server_pk = pubkey_of(server_seed);

    std::vector<std::pair<std::string, std::string>> peers;
    if (!make_clients(n, dir, server_pk, &net, mtu, 1, &peers)) return 1;

    std::string s =
        "{\n"
        "  \"mode\": \"server\",\n"
        "  \"ip\": \"" + server_ip + "/" + std::to_string(net.prefix) + "\",\n"
        "  \"seed\": \"" + server_seed + "\",\n"
        "  \"mtu\": " + std::to_string(mtu) + ",\n"
        "  // Allowlist: only these public keys may connect. Remove the block\n"
        "  // to accept any key (open mode). `nospoon addclient` appends here.\n"
        "  \"peers\": {\n";
    for (size_t i = 0; i < peers.size(); i++) {
        s += "    \"" + peers[i].first + "\": \"" + peers[i].second + "\"";
        s += (i + 1 < peers.size()) ? ",\n" : "\n";
    }
    s += "  }\n}\n";

    auto server_path = dir + "/server.jsonc";
    if (!write_secret(server_path, s)) return 1;

    printf("server:\n  %s  ip=%s  pubkey=%s\n",
           server_path.c_str(), server_ip.c_str(), server_pk.c_str());
    printf("\nCopy each client-NNN.jsonc to its machine. Keep every file "
           "private — each one contains a seed.\n");
    return 0;
}

int cmd_addclient(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr, "Usage: nospoon addclient <server-config> [-n N]\n");
        return 1;
    }
    std::string path = argv[2];
    int n = 1;
    if (!parse_count(argc, argv, 3, &n)) return 1;

    auto cfg = load_config(path);
    if (cfg.mode != "server") {
        fprintf(stderr, "Error: %s is a \"%s\" config, not a server config\n",
                path.c_str(), cfg.mode.c_str());
        return 1;
    }
    auto server_seed = config_seed(cfg);
    if (server_seed.empty()) {
        fprintf(stderr, "Error: %s has no seed, so its public key is not fixed "
                        "and clients cannot be pointed at it\n", path.c_str());
        return 1;
    }

    bool ok = false;
    auto raw = read_file(path, &ok);
    if (!ok) { fprintf(stderr, "Error: cannot read %s\n", path.c_str()); return 1; }

    // Refuse to convert an open-mode server into an allowlisted one: that
    // would lock out every client currently connecting without a peers entry.
    auto key_pos = find_key(strip_comments(raw), "peers");
    if (key_pos == std::string::npos) {
        fprintf(stderr, "Error: %s has no \"peers\" block (open mode — any key "
                        "may connect). Adding one would lock out existing "
                        "clients. Add an empty \"peers\": {} block first if "
                        "that is what you want.\n", path.c_str());
        return 1;
    }
    // Locate the block in the RAW text so comments are preserved verbatim.
    auto brace = raw.find('{', raw.find("\"peers\""));
    if (brace == std::string::npos) {
        fprintf(stderr, "Error: malformed \"peers\" block in %s\n", path.c_str());
        return 1;
    }

    Subnet net;
    if (!parse_subnet(cfg.ip, &net)) return 1;
    for (const auto& [pk, ip] : cfg.peers) {
        auto dot = ip.rfind('.');
        if (dot != std::string::npos) net.used.insert(std::atoi(ip.c_str() + dot + 1));
    }

    auto server_pk = pubkey_of(server_seed);
    std::string dir = ".";
    auto slash = path.find_last_of('/');
    if (slash != std::string::npos) dir = path.substr(0, slash);

    std::vector<std::pair<std::string, std::string>> peers;
    if (!make_clients(n, dir, server_pk, &net, cfg.mtu,
                      static_cast<int>(cfg.peers.size()) + 1, &peers)) return 1;

    // Insert right after '{'. Entries land at the head of the block, each with
    // a trailing comma, so the existing last entry is never touched and no
    // trailing-comma repair is needed.
    std::string ins;
    for (const auto& [pk, ip] : peers)
        ins += "\n    \"" + pk + "\": \"" + ip + "\",";
    auto updated = raw.substr(0, brace + 1) + ins + raw.substr(brace + 1);

    // Back up, then replace atomically.
    if (!write_secret(path + ".bak", raw)) return 1;
    auto tmp = path + ".tmp";
    if (!write_secret(tmp, updated)) return 1;
    if (std::rename(tmp.c_str(), path.c_str()) != 0) {
        fprintf(stderr, "Error: cannot replace %s\n", path.c_str());
        std::remove(tmp.c_str());
        return 1;
    }

    printf("server:\n  %s  +%d peers (backup: %s.bak, comments preserved)\n",
           path.c_str(), n, path.c_str());
    return 0;
}

}  // namespace nospoon
