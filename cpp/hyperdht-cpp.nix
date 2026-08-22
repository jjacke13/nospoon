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
  # Pinned to 9580f99 (upstream 0.5.0) — the 2026-08-22 server punch-socket
  # batch, 36 commits. In order of impact on nospoon:
  #
  #   a0641c9  WINDOWS BUILD FIX — the highest-impact commit here for us.
  #   367e48c  `relay_upgrade.{hpp,cpp}` included <netinet/in.h>
  #            unconditionally, which does not exist under the MSVC toolchain,
  #            so EVERY Windows build has failed since that header landed on
  #            2026-07-11 (`5460cfa`). nospoon's release CI builds
  #            windows-x86_64 with clang-cl, which targets the same MSVC
  #            headers — so our Windows target has been broken for six weeks.
  #            Verify the next tag build actually produces the archive.
  #
  #   91ec103  Server holepunch sessions ride a PER-SESSION punch socket
  #   +follow  (JS parity: server.js:436 → holepuncher.js:14). Noise msg2, the
  #   -ups     client's PEER_HOLEPUNCH rounds, their answers and every probe
  #            all leave that socket, and the session's NAT view is that
  #            socket's sampler instead of the DHT's. Rounds are held until
  #            the socket's NAT campaign concludes (JS `await p.analyze(false)`)
  #            — before this the first round answered FIREWALL_UNKNOWN and the
  #            client acted on it. Direct/OPEN/known-public/EMBEDDED paths keep
  #            the old main-socket route byte for byte.
  #
  #            *** This is NOT a fix for Finding Q. *** Upstream A/B'd it on
  #            real mobile CGNAT with fast-mode ping suppressed: main 3/12
  #            black holes (25%) vs branch 1/10 (10%), p≈0.6 — noise. The
  #            branch's one failure used the entire new path and still died.
  #            That KILLS the "shared announce-socket mapping goes stale/busy"
  #            mechanism — i.e. the hypothesis this repo's own Finding Q
  #            parity note proposed. Merged on parity grounds plus the real
  #            bugs the review turned up (below). Do not tell the field it
  #            fixes the -5s.
  #
  #   4226f8e  SECURITY — the session NAT sampler is fed only by authenticated
  #   eeac0cf  rounds. PoolSocket sampled any decodable inbound REQUEST before
  #            the mode/id/decrypt gates; NatSampler dedups by source and flips
  #            CONSISTENT at three hits, so three spoofed datagrams carrying a
  #            chosen `to` could pin a session's advertised address and
  #            firewall, which the next round reply then froze and shipped to
  #            the client. JS only calls `p.nat.add` after decrypt succeeds.
  #            eeac0cf closes the same hole on the RESPONSE branch (sampled
  #            ahead of the tid match).
  #   eeac0cf  Also: fd + udx_socket_t leak on stream adoption —
  #            `udx_socket_close` returned UV_EBUSY, the return was discarded
  #            and `socket_` nulled, leaving a live uv_udp_t that stops the
  #            loop draining. ConnectionInfo now carries `socket_keepalive`.
  #   e8fd86c  Dropping a Holepuncher releases its holders and the punch
  #   4d67452  throttle; NAT discovery settles on classification instead of
  #   78eb2c0  dropping live pins; relay_token survives moves.
  #
  # What the upstream A/B taught us about Finding Q (worth keeping):
  # the failure is strictly BIMODAL — across 22 sessions every one either
  # landed on probe #1 or lost all 10, never 2-9. Binary reachability of one
  # 4-tuple, decided before the first probe. Base rate 10-25%, reproducible
  # on demand by disabling the fast-mode ping (which otherwise masks the punch
  # path entirely — why this was never reproducible before). Server-side
  # causes are now largely excluded. Remaining suspect: the CLIENT's round-1
  # fast-open TTL-5 priming packet not leaving its carrier NAT. Next test is a
  # capture at client egress (laptop tethered to mobile data; an unrooted
  # phone cannot tcpdump).
  #
  # Earlier batches, still in the pin (detail in `git log`):
  #   f6608b7  Finding B2 — round 2 gossips the full sampled address set.
  #   3421264  protomux re-entrancy (shared_ptr channels + guards).
  #   82d3c55  Finding O — rebuild the advertised relay set every announce
  #            cycle; it used to be write-once, so only a restart could cure a
  #            bad set. Explains every "a restart fixed it" in the field notes.
  #   6ef85e6  Split the holepunch token gate from the advertised relay list.
  #   d5988ec  Finding M — fail Round 1 over to the other announce relays.
  #   3345fe3  Finding J — NOT fully closed; the `!uv__is_closing(handle)`
  #            assert still fires under heavy connect-failure churn.
  #   c3bfc60  Finding I — advertise local addresses live, not a bind-time
  #            snapshot. Keeps `exclude_local_address()` in the path, which is
  #            what stops nospoon's TUN address being announced.
  #
  # Bump together with `rev` + `hash` when upstream advances.
  version = "0.5.0-unstable-2026-08-22";

  src = fetchFromGitHub {
    owner = "jjacke13";
    repo = "hyperdht-cpp";
    rev = "9580f99b5ce410448163a264e0207e3f825f83c8";
    hash = "sha256-nvHZGgRfCu/C97KBpl6Hm6HFTzD+BQr2z1mMyIMqyMU=";
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
