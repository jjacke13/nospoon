#pragma once
// JSONC config parser for nospoon VPN.
// Supports // and /* */ comments (stripped before parsing).
// Schema is fixed and simple — no generic JSON library needed.

#include "validation.hpp"

#include <cstdint>
#include <cstdio>
#include <fstream>
#include <map>
#include <sstream>
#include <string>

namespace nospoon {

struct Config {
    std::string mode;        // "server" or "client"
    std::string ip;          // "10.0.0.1/24"
    std::string ipv6;        // "fd00::1/64" (optional)
    std::string seed;        // 64-char hex (optional)
    std::string seed_file;   // path to file containing 64-hex-char seed (optional)
    std::string server_key;  // client only: server pubkey hex
    int mtu = 1400;
    std::map<std::string, std::string> peers;  // pubkey_hex -> ip

    // Full-tunnel mode: route all traffic through the VPN.
    // Client: split routes (0.0.0.0/1 + 128.0.0.0/1) via TUN, NRPT DNS,
    //         IPv6 blackhole, host exemption for the DHT server's IP.
    // Server: enable IP forwarding + NAT (New-NetNat on Windows).
    bool full_tunnel = false;
    std::string out_iface;   // server full-tunnel: outbound net interface

    // Two-phase mode for Android: when fd_socket >= 0, the client connects
    // DHT first (no TUN), writes "CONNECTED" to fd_socket, then blocks
    // recvmsg(SCM_RIGHTS) on it for the TUN fd to adopt. The Android app
    // (NospoonVpnService.kt) drives this protocol — see android/app/.../jni
    // for the parent-side helper.
    int fd_socket = -1;

    // Parse IP without CIDR prefix
    std::string ip_address() const {
        auto slash = ip.find('/');
        return (slash != std::string::npos) ? ip.substr(0, slash) : ip;
    }
};

// Strip // and /* */ comments from JSONC
inline std::string strip_comments(const std::string& input) {
    std::string out;
    out.reserve(input.size());
    bool in_string = false;
    for (size_t i = 0; i < input.size(); i++) {
        if (in_string) {
            out.push_back(input[i]);
            if (input[i] == '"' && (i == 0 || input[i - 1] != '\\'))
                in_string = false;
            continue;
        }
        if (input[i] == '"') {
            in_string = true;
            out.push_back(input[i]);
        } else if (i + 1 < input.size() && input[i] == '/' && input[i + 1] == '/') {
            // Line comment — skip to newline
            while (i < input.size() && input[i] != '\n') i++;
        } else if (i + 1 < input.size() && input[i] == '/' && input[i + 1] == '*') {
            // Block comment — skip to */
            i += 2;
            while (i + 1 < input.size() && !(input[i] == '*' && input[i + 1] == '/')) i++;
            i++;  // skip closing /
        } else {
            out.push_back(input[i]);
        }
    }
    return out;
}

// Minimal JSON string value extractor — handles JSON backslash escapes so
// the closing quote is found correctly even when the value contains '\"',
// and produces the unescaped UTF-8 string.
//
// Android's org.json.JSONObject.toString() escapes '/' as '\/' (legal JSON;
// see https://cs.android.com/android/platform/superproject/main/+/main:
// libcore/json/src/main/java/org/json/JSONStringer.java). Without unescaping,
// "10.0.0.2/24" arrives as the literal "10.0.0.2\/24" and the CIDR regex
// rejects it. Same hazard for any value containing '"' or '\\'.
inline std::string json_string(const std::string& json, const std::string& key) {
    auto pattern = "\"" + key + "\"";
    auto pos = json.find(pattern);
    if (pos == std::string::npos) return "";
    pos = json.find('"', pos + pattern.size() + 1);
    if (pos == std::string::npos) return "";
    auto start = pos + 1;

    // Walk to the matching close quote, skipping over '\X' pairs so a
    // backslash-escaped quote inside the string doesn't terminate early.
    auto i = start;
    while (i < json.size()) {
        if (json[i] == '\\' && i + 1 < json.size()) { i += 2; continue; }
        if (json[i] == '"') break;
        i++;
    }
    if (i >= json.size()) return "";

    // Unescape the slice [start, i). Only the escape sequences org.json
    // emits (and a few extras for safety) are translated; anything else
    // passes through verbatim.
    std::string out;
    out.reserve(i - start);
    for (auto j = start; j < i; j++) {
        if (json[j] != '\\' || j + 1 >= i) { out += json[j]; continue; }
        char e = json[j + 1];
        switch (e) {
            case '"':  out += '"';  break;
            case '\\': out += '\\'; break;
            case '/':  out += '/';  break;
            case 'b':  out += '\b'; break;
            case 'f':  out += '\f'; break;
            case 'n':  out += '\n'; break;
            case 'r':  out += '\r'; break;
            case 't':  out += '\t'; break;
            default:   out += e;    break;  // \uXXXX not used by our schema
        }
        j++;
    }
    return out;
}

// Minimal JSON integer value extractor
inline int json_int(const std::string& json, const std::string& key, int fallback) {
    auto pattern = "\"" + key + "\"";
    auto pos = json.find(pattern);
    if (pos == std::string::npos) return fallback;
    pos = json.find(':', pos + pattern.size());
    if (pos == std::string::npos) return fallback;
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    return std::atoi(json.c_str() + pos);
}

// Minimal JSON boolean: matches "key": true / "key": false (whitespace-tolerant).
// Returns fallback if key not present or not a bare true/false.
inline bool json_bool(const std::string& json, const std::string& key, bool fallback) {
    auto pattern = "\"" + key + "\"";
    auto pos = json.find(pattern);
    if (pos == std::string::npos) return fallback;
    pos = json.find(':', pos + pattern.size());
    if (pos == std::string::npos) return fallback;
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    if (pos + 4 <= json.size() && json.compare(pos, 4, "true") == 0) return true;
    if (pos + 5 <= json.size() && json.compare(pos, 5, "false") == 0) return false;
    return fallback;
}

// Parse the peers object: {"hex_key": "ip", ...}
inline std::map<std::string, std::string> json_peers(const std::string& json) {
    std::map<std::string, std::string> result;
    auto pos = json.find("\"peers\"");
    if (pos == std::string::npos) return result;
    pos = json.find('{', pos);
    if (pos == std::string::npos) return result;
    auto end = json.find('}', pos);
    if (end == std::string::npos) return result;
    auto block = json.substr(pos + 1, end - pos - 1);

    // Extract key-value pairs from the block
    size_t i = 0;
    while (i < block.size()) {
        auto k_start = block.find('"', i);
        if (k_start == std::string::npos) break;
        auto k_end = block.find('"', k_start + 1);
        if (k_end == std::string::npos) break;
        auto v_start = block.find('"', k_end + 1);
        if (v_start == std::string::npos) break;
        auto v_end = block.find('"', v_start + 1);
        if (v_end == std::string::npos) break;

        auto key = block.substr(k_start + 1, k_end - k_start - 1);
        auto val = block.substr(v_start + 1, v_end - v_start - 1);
        result[key] = val;
        i = v_end + 1;
    }
    return result;
}

// Load and parse config file
inline Config load_config(const std::string& path) {
    std::ifstream f(path);
    if (!f.is_open()) {
        fprintf(stderr, "Error: cannot open %s\n", path.c_str());
        std::exit(1);
    }
    std::stringstream buf;
    buf << f.rdbuf();
    auto json = strip_comments(buf.str());

    Config cfg;
    cfg.mode = json_string(json, "mode");
    cfg.ip = json_string(json, "ip");
    cfg.ipv6 = json_string(json, "ipv6");
    cfg.seed = json_string(json, "seed");
    cfg.seed_file = json_string(json, "seedFile");
    cfg.server_key = json_string(json, "server");
    cfg.mtu = json_int(json, "mtu", 1400);
    cfg.peers = json_peers(json);
    cfg.full_tunnel = json_bool(json, "fullTunnel", false);
    cfg.out_iface = json_string(json, "outInterface");

    if (cfg.mode.empty()) {
        fprintf(stderr, "Error: config must have \"mode\": \"server\" or \"client\"\n");
        std::exit(1);
    }
    if (cfg.ip.empty()) {
        fprintf(stderr, "Error: config must have \"ip\": \"x.x.x.x/y\"\n");
        std::exit(1);
    }

    // Validate fields (matches nospoon/lib/validation.js behavior).
    auto require_ok = [](const validation::Result& r) {
        if (!r.valid) {
            fprintf(stderr, "Error: %s\n", r.error.c_str());
            std::exit(1);
        }
    };
    require_ok(validation::validate_cidr(cfg.ip, "ip"));
    if (!cfg.ipv6.empty())   require_ok(validation::validate_cidr_v6(cfg.ipv6, "ipv6"));
    if (!cfg.seed.empty())   require_ok(validation::validate_hex64(cfg.seed, "seed"));
    if (!cfg.server_key.empty())
        require_ok(validation::validate_hex64(cfg.server_key, "server"));
    require_ok(validation::validate_mtu(cfg.mtu));

    // Load seed from file if seedFile specified (and seed not already set).
    if (cfg.seed.empty() && !cfg.seed_file.empty()) {
        std::ifstream sf(cfg.seed_file);
        if (!sf.is_open()) {
            fprintf(stderr, "Error: cannot open seedFile %s\n", cfg.seed_file.c_str());
            std::exit(1);
        }
        std::stringstream sb;
        sb << sf.rdbuf();
        cfg.seed = sb.str();
        // Strip trailing whitespace/newline.
        while (!cfg.seed.empty() &&
               (cfg.seed.back() == '\n' || cfg.seed.back() == '\r' ||
                cfg.seed.back() == ' '  || cfg.seed.back() == '\t')) {
            cfg.seed.pop_back();
        }
        require_ok(validation::validate_hex64(cfg.seed, "seedFile contents"));
    }

    return cfg;
}

// Parse 64-char hex string to 32 bytes
inline bool hex_to_bytes(const std::string& hex, uint8_t* out, size_t len) {
    if (hex.size() != len * 2) return false;
    for (size_t i = 0; i < len; i++) {
        unsigned byte;
        if (sscanf(hex.c_str() + i * 2, "%02x", &byte) != 1) return false;
        out[i] = static_cast<uint8_t>(byte);
    }
    return true;
}

inline std::string bytes_to_hex(const uint8_t* data, size_t len) {
    std::string out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        char buf[3];
        snprintf(buf, sizeof(buf), "%02x", data[i]);
        out += buf;
    }
    return out;
}

}  // namespace nospoon
