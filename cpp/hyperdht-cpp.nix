# hyperdht-cpp — C++ port of HyperDHT, the P2P DHT layer below nospoon.
#
# Built as a shared library with the full C++ API exported (not just the
# C FFI) so that nospoon-cpp can link against internal classes like
# `HyperDHT`, `Server`, `SecretStreamDuplex` etc.
#
# The repo bundles libudx as a git submodule under `deps/libudx`. We
# pull it in with `fetchSubmodules = true`; CMake builds it statically
# and folds it into libhyperdht.

{
  lib,
  stdenv,
  fetchFromGitHub,
  cmake,
  ninja,
  pkg-config,
  libsodium,
  libuv,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "hyperdht-cpp";
  # Pinned to 3421264. Newest batch first, then the 2026-07-30 field batch;
  # within each, ordered by impact on nospoon.
  #
  #   f6608b7  Finding B2 — the punching round now gossips the full sampled
  #            address set instead of the relay's single observation of our
  #            pool socket, matching round 1 and JS (connect.js:567/654/684).
  #            The server probes what this round names, so one address left it
  #            with no fallback when that mapping wasn't reachable from it —
  #            which is what a symmetric NAT produces. Upstream does NOT claim
  #            causality (the same capture shows connects succeeding with one
  #            address); taken on parity grounds. Candidate explanation for the
  #            laptop punch exhaustion that Finding O left open.
  #   3421264  protomux — own channels by shared_ptr and guard every re-entrant
  #            method, so a frame arriving inside user code can't free the
  #            channel mid-call. NOT field-reachable from nospoon: the
  #            production write path is SecretStream over UDX (async), each Mux
  #            holds one channel, and nothing outside protomux sets
  #            Channel::on_open. Taken because it fixes a real ASAN abort in
  #            the layer under dht-rpc, not because we can trigger it.
  #
  #   82d3c55  Finding O — rebuild the advertised relay set every announce
  #            cycle. The published set was WRITE-ONCE: `active_relays_` was
  #            cleared only on stop, so once three slots filled it was pinned
  #            for the process lifetime. A relay that died — or that was never
  #            reachable from third parties (symmetric NAT) — was advertised to
  #            every client forever and no healthier node could replace it.
  #            Restarting was the only cure, which is exactly what the field
  #            kept seeing. Proven by A/B: same server, restart alone swapped
  #            an all-dead relay set for a healthy one and the client connected.
  #   6ef85e6  Split the holepunch token gate from the advertised relay list,
  #            so a client arriving with a record from an earlier cycle still
  #            gets a token. Prerequisite for the rebuild above. Also re-arms
  #            the `alive_` sentinel on start() — a suspended+resumed server
  #            was previously inert forever (not reachable from nospoon, which
  #            never calls suspend/resume, but real).
  #   d5988ec  Finding M — fail Round 1 over to the other announce relays.
  #            One unreachable relay used to be a permanent -5; both impls
  #            bailed without trying the rest, and upstream JS carries the TODO
  #            asking for this. Field-validated on laptop and Android.
  #   3345fe3  Finding J — do not re-destroy a udx stream whose teardown is in
  #            flight. NOTE: field-observed 2026-07-30 that this does NOT fully
  #            close the SIGABRT — the same `!uv__is_closing(handle)` assert
  #            still fires under heavy connect-failure churn.
  #   c3bfc60  Finding I — advertise local addresses live, not a bind-time
  #            snapshot, so an interface appearing after bind() is picked up.
  #            Keeps `exclude_local_address()` in the path, which is what stops
  #            nospoon's TUN address being announced.
  #
  # Bump together with `rev` + `hash` when upstream advances.
  version = "0-unstable-2026-08-03";

  src = fetchFromGitHub {
    owner = "jjacke13";
    repo = "hyperdht-cpp";
    rev = "3421264d61eac5f992d72c4eaa195cf8f9632e06";
    hash = "sha256-FGQRrMJZ1DRDVbTwOEUDzS79d/jnbGxG/6yuvweox60=";
    fetchSubmodules = true;
  };

  nativeBuildInputs = [ cmake ninja pkg-config ];
  buildInputs = [ libsodium libuv ];

  # Build as a static archive so the consumer (nospoon-cpp) can fold all
  # of hyperdht-cpp + libudx into a single, self-contained executable.
  # libsodium + libuv stay as dynamic system libraries (typical for
  # crypto / event-loop deps — security updates apply automatically).
  cmakeFlags = [
    "-DBUILD_SHARED_LIBS=OFF"
    "-DHYPERDHT_EXPORT_CXX=ON"
    "-DHYPERDHT_BUILD_TESTS=OFF"
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON"
    "-DHYPERDHT_DEBUG=ON"
  ];

  meta = {
    description = "C++ port of HyperDHT — Distributed Hash Table for peer-to-peer connections";
    homepage = "https://github.com/jjacke13/hyperdht-cpp";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
})
