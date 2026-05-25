// Nospoon VPN — Client mode
// Connects to a nospoon server over HyperDHT, forwards IP packets
// between local TUN device and encrypted P2P stream.

#include "config.hpp"
#include "framing.hpp"
#include "full_tunnel.hpp"
#include "routing.hpp"
#include "tun.hpp"

#include <hyperdht/dht.hpp>
#include <hyperdht/secret_stream.hpp>

#include <algorithm>
#include <csignal>
#include <cstdio>
#include <memory>

using namespace hyperdht;
using namespace nospoon;

namespace {

struct ClientCtx {
    // The DHT is owned via unique_ptr so we can destroy and recreate it on
    // persistent failures (e.g. Wi-Fi → mobile-data network switch leaves
    // the UDP socket bound to a dead interface). dht_opts is stashed at
    // startup so the rebuild has the same bootstrap nodes / keypair.
    std::unique_ptr<HyperDHT> dht;
    DhtOptions dht_opts;
    // Generation token: incremented every time we rebuild dht. In-flight
    // connect callbacks check this and bail out if their dht is stale.
    uint64_t dht_generation = 0;

    uv_loop_t* loop = nullptr;        // needed by on_connect_result for deferred tun.start()
    Tun tun;
    Config config;
    noise::Keypair keypair;
    noise::PubKey server_pk{};
    std::unique_ptr<secret_stream::SecretStreamDuplex> duplex;
    FrameDecoder decoder;
    uv_timer_t keepalive_timer{};
    uv_timer_t reconnect_timer{};
    int backoff_ms = 1000;
    int failures = 0;
    bool connected = false;
    bool running = true;
    bool full_tunnel_active = false;  // tracks whether routes/DNS are installed
};

void do_connect(ClientCtx& ctx);

void send_framed(secret_stream::SecretStreamDuplex* duplex,
                 const uint8_t* data, size_t len) {
    auto frame = frame_encode(data, len);
    duplex->write(frame.data(), frame.size(), nullptr);
}

void on_tun_packet(ClientCtx& ctx, const uint8_t* data, size_t len) {
    if (!ctx.duplex || !ctx.duplex->is_connected()) return;
    send_framed(ctx.duplex.get(), data, len);
}

void keepalive_tick(uv_timer_t* handle) {
    auto* ctx = static_cast<ClientCtx*>(handle->data);
    if (ctx->duplex && ctx->duplex->is_connected()) {
        auto ka = frame_keepalive();
        ctx->duplex->write(ka.data(), ka.size(), nullptr);
    }
}

// SIGINT/SIGTERM watcher: flip ctx.running so the main loop exits naturally
// and the cleanup block runs (full-tunnel teardown, DHT destroy, TUN close).
// Without this, Ctrl+C terminated the process immediately and full-tunnel
// mode left stale iptables rules / split routes / DNS overrides.
void on_signal(uv_signal_t* handle, int signum) {
    auto* ctx = static_cast<ClientCtx*>(handle->data);
    fprintf(stderr, "\n  Received signal %d — shutting down...\n", signum);
    ctx->running = false;
    uv_signal_stop(handle);
}

// After this many consecutive failures, restart the DHT (rebind socket).
// Matches the JS impl's MAX_FAILURES_BEFORE_RESTART (3).
constexpr int MAX_FAILURES_BEFORE_RESTART = 3;

void restart_dht(ClientCtx& ctx);  // forward decl

void schedule_reconnect(ClientCtx& ctx) {
    if (!ctx.running) return;
    ctx.failures++;

    // After repeated failures, the most likely cause is a stale UDP socket
    // — either Linux full-tunnel routes have killed DHT bootstrap, or the
    // device's network just changed (Wi-Fi → mobile data). Drop tunnel
    // routes if active, then rebuild the DHT entirely so it binds to a
    // working interface.
    if (ctx.failures >= MAX_FAILURES_BEFORE_RESTART) {
        if (ctx.full_tunnel_active) {
            fprintf(stderr,
                    "  Dropping tunnel routes to let DHT recover\n");
            full_tunnel::disable_client_full_tunnel();
            ctx.full_tunnel_active = false;
        }
        restart_dht(ctx);
        return;
    }

    // Exponential backoff: 1s -> 2s -> 4s -> ... -> 30s max
    ctx.backoff_ms = std::min(ctx.backoff_ms * 2, 30000);

    fprintf(stderr, "  Reconnecting in %d ms (attempt %d)\n",
            ctx.backoff_ms, ctx.failures);

    ctx.reconnect_timer.data = &ctx;
    uv_timer_start(&ctx.reconnect_timer,
        [](uv_timer_t* t) {
            auto* c = static_cast<ClientCtx*>(t->data);
            do_connect(*c);
        },
        ctx.backoff_ms, 0);
}

void on_connect_result(ClientCtx& ctx, int error,
                       const ConnectResult& result) {
    if (error != 0) {
        fprintf(stderr, "  Connect failed: %d\n", error);
        schedule_reconnect(ctx);
        return;
    }

    fprintf(stderr, "  Connected to server at %s:%u\n",
            result.peer_address.host_string().c_str(),
            result.peer_address.port);

    // Reset backoff on success
    ctx.backoff_ms = 1000;
    ctx.failures = 0;
    ctx.connected = true;

    // Build SecretStream handshake
    secret_stream::DuplexHandshake hs{};
    hs.tx_key = result.tx_key;
    hs.rx_key = result.rx_key;
    hs.handshake_hash = result.handshake_hash;
    std::memcpy(hs.remote_public_key.data(),
                result.remote_public_key.data(), 32);
    hs.public_key = ctx.keypair.public_key;
    hs.is_initiator = true;

    // Connect raw stream
    if (result.peer_address.port != 0 && result.raw_stream) {
        struct sockaddr_in dest{};
        uv_ip4_addr(result.peer_address.host_string().c_str(),
                     result.peer_address.port, &dest);
        udx_socket_t* sock = result.udx_socket
            ? result.udx_socket
            : ctx.dht->socket().socket_handle();
        udx_stream_connect(result.raw_stream, sock,
                           result.remote_udx_id,
                           reinterpret_cast<const struct sockaddr*>(&dest));
    }

    ctx.duplex = std::make_unique<secret_stream::SecretStreamDuplex>(
        result.raw_stream, hs, ctx.dht->loop(),
        ctx.dht->make_duplex_options());

    auto* duplex_ptr = ctx.duplex.get();

    duplex_ptr->on_connect([]() {
        fprintf(stderr, "  Encrypted tunnel established\n");
    });

    duplex_ptr->on_message([&ctx](const uint8_t* data, size_t len) {
        ctx.decoder.feed(data, len, [&ctx](const uint8_t* pkt, size_t pkt_len) {
            ctx.tun.write(pkt, pkt_len);
        });
    });

    duplex_ptr->on_end([duplex_ptr]() {
        if (duplex_ptr) duplex_ptr->end();
    });

    duplex_ptr->on_close([&ctx](int) {
        fprintf(stderr, "  Server disconnected\n");
        // Lambda captures (&ctx) are stored INSIDE SecretStreamDuplex via
        // its on_close_ std::function. Calling ctx.duplex.reset() here frees
        // the SecretStreamDuplex — and with it the closure we're running
        // from. Any access to `ctx` after that point loads the captured
        // reference from freed memory (UAF caught by ASAN, 2026-05-20).
        // Workaround: stash &ctx on the stack, reorder so duplex.reset()
        // happens last (after we no longer touch the closure).
        auto* c = &ctx;
        c->connected = false;
        c->decoder.reset();
        schedule_reconnect(*c);
        c->duplex.reset();
    });

    duplex_ptr->start();

    // Start keepalive
    uv_timer_start(&ctx.keepalive_timer, keepalive_tick, 25000, 25000);

    // Full-tunnel: install routes the first time we connect; on subsequent
    // reconnects (e.g. server moved hosts) just refresh the host exemption.
    if (ctx.config.full_tunnel) {
        std::string server_ip = result.peer_address.host_string();
        if (!ctx.full_tunnel_active) {
            if (full_tunnel::enable_client_full_tunnel(ctx.tun.name(), server_ip)) {
                ctx.full_tunnel_active = true;
            }
        } else {
            full_tunnel::add_host_exemption(server_ip);
        }
    }
}

void do_connect(ClientCtx& ctx) {
    if (!ctx.running || !ctx.dht) return;
    fprintf(stderr, "  Connecting to server...\n");

    // Snapshot the generation so a callback fired by an old (now-destroyed)
    // DHT bails out instead of running against the new one.
    auto gen = ctx.dht_generation;
    ctx.dht->connect(ctx.server_pk,
        [&ctx, gen](int error, const ConnectResult& result) {
            if (gen != ctx.dht_generation) {
                fprintf(stderr, "  Stale connect result (DHT was restarted) — ignoring\n");
                return;
            }
            on_connect_result(ctx, error, result);
        });
}

// Tear down the current DHT and rebuild it on the same loop. Used when
// reconnect attempts repeatedly fail — typically because a network change
// (Wi-Fi → mobile, sleep/wake) left our UDP socket bound to a now-dead
// interface. The new DHT binds afresh and gets a working socket on the
// current interface. Mirrors the JS impl's `restartDht`
// (nospoon/lib/client.js + nospoon-bare/android/worklet/client.js).
void restart_dht(ClientCtx& ctx) {
    if (!ctx.running) return;
    fprintf(stderr,
            "  Restarting DHT after %d consecutive failures (network may have switched)\n",
            ctx.failures);

    // Bump generation so any in-flight callback against the old DHT is
    // discarded when it eventually fires.
    ctx.dht_generation++;

    // Hand the old DHT off to async destroy. The library's destroy()
    // callback fires SYNCHRONOUSLY (it signals "destruction started",
    // not "fully done" — see SECURITY-AUDIT.md C9). Deleting the
    // HyperDHT inside the callback runs ~RpcSocket while libuv still
    // has pending uv_close callbacks for the embedded sockets — when
    // on_uv_close (libudx udx.c:140) later derefs socket->udx it hits
    // freed memory (ASAN-caught 2026-05-20). Defer the actual delete
    // via a uv_timer so the loop has time to drain.
    auto old = std::move(ctx.dht);
    if (old) {
        HyperDHT* raw = old.release();
        raw->destroy(nullptr);
        auto* timer = new uv_timer_t;
        uv_timer_init(ctx.loop, timer);
        timer->data = raw;
        uv_timer_start(timer, [](uv_timer_t* t) {
            delete static_cast<HyperDHT*>(t->data);
            uv_close(reinterpret_cast<uv_handle_t*>(t),
                     [](uv_handle_t* h) { delete reinterpret_cast<uv_timer_t*>(h); });
        }, 5000, 0);
    }

    // Drop any lingering duplex from the dead connection.
    ctx.duplex.reset();
    ctx.decoder.reset();
    ctx.connected = false;

    // Build a fresh DHT bound to whatever the current default interface is.
    ctx.dht = std::make_unique<HyperDHT>(ctx.loop, ctx.dht_opts);
    ctx.dht->bind();

    ctx.failures = 0;
    ctx.backoff_ms = 1000;

    do_connect(ctx);
}

}  // namespace

int run_client(const Config& config) {
    uv_loop_t loop;
    uv_loop_init(&loop);

    // Derive keypair from seed
    noise::Keypair kp;
    if (!config.seed.empty()) {
        noise::Seed seed{};
        if (!hex_to_bytes(config.seed, seed.data(), 32)) {
            fprintf(stderr, "Error: invalid seed hex\n");
            return 1;
        }
        kp = noise::generate_keypair(seed);
    } else {
        kp = noise::generate_keypair();
    }

    // Parse server public key
    noise::PubKey server_pk{};
    if (config.server_key.empty() ||
        !hex_to_bytes(config.server_key, server_pk.data(), 32)) {
        fprintf(stderr, "Error: client config needs \"server\" (64-char hex pubkey)\n");
        return 1;
    }

    // Build DHT — use the seed-derived keypair as the default identity.
    // Owned via unique_ptr so restart_dht() can swap in a fresh instance
    // after a network change (Wi-Fi → mobile-data).
    DhtOptions opts;
    opts.bootstrap = HyperDHT::default_bootstrap_nodes();
    opts.default_keypair = kp;

    ClientCtx ctx;
    ctx.loop = &loop;
    ctx.config = config;
    ctx.keypair = kp;
    ctx.server_pk = server_pk;
    ctx.dht_opts = opts;
    ctx.dht = std::make_unique<HyperDHT>(&loop, opts);
    ctx.dht->bind();

    // Open TUN (IPv4 + optional IPv6)
    if (ctx.tun.open(config.ip, config.mtu, config.ipv6) != 0) {
        fprintf(stderr, "Error: failed to open TUN device\n");
        return 1;
    }
    ctx.tun.start(&loop, [&ctx](const uint8_t* data, size_t len) {
        on_tun_packet(ctx, data, len);
    });

    // Init timers
    uv_timer_init(&loop, &ctx.keepalive_timer);
    ctx.keepalive_timer.data = &ctx;
    uv_timer_init(&loop, &ctx.reconnect_timer);

    // Graceful shutdown on SIGINT (Ctrl+C) and SIGTERM (systemd stop).
    uv_signal_t sigint{}, sigterm{};
    uv_signal_init(&loop, &sigint);
    uv_signal_init(&loop, &sigterm);
    sigint.data  = &ctx;
    sigterm.data = &ctx;
    uv_signal_start(&sigint,  on_signal, SIGINT);
    uv_signal_start(&sigterm, on_signal, SIGTERM);

    fprintf(stderr, R"(
  nospoon client — P2P VPN powered by hyperdht-cpp
  -------------------------------------------------

  TUN:         %s (%s, MTU %d)
  DHT port:    %u
  Our key:     %s
  Server key:  %s

  Connecting...

)",
        ctx.tun.name().c_str(), config.ip.c_str(), config.mtu,
        ctx.dht->port(),
        bytes_to_hex(kp.public_key.data(), 32).c_str(),
        config.server_key.c_str());

    // Start connection
    do_connect(ctx);

    // Run event loop (UV_RUN_ONCE loop for signal handling)
    while (ctx.running && uv_run(&loop, UV_RUN_ONCE)) {}

    // Cleanup
    if (ctx.full_tunnel_active) {
        full_tunnel::disable_client_full_tunnel();
        ctx.full_tunnel_active = false;
    }
    uv_signal_stop(&sigint);
    uv_signal_stop(&sigterm);
    uv_close(reinterpret_cast<uv_handle_t*>(&sigint),  nullptr);
    uv_close(reinterpret_cast<uv_handle_t*>(&sigterm), nullptr);
    uv_timer_stop(&ctx.keepalive_timer);
    uv_timer_stop(&ctx.reconnect_timer);
    ctx.tun.close();
    if (ctx.dht) ctx.dht->destroy();
    uv_run(&loop, UV_RUN_DEFAULT);
    ctx.dht.reset();  // free the HyperDHT after destroy callbacks have flushed
    uv_loop_close(&loop);
    return 0;
}
