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
  # Pinned to 6a2d62c. Two field bugs found on 2026-07-27 are fixed here:
  #
  #   c3bfc60  Finding I — advertise local addresses live instead of a
  #            bind-time snapshot. Previously an interface that appeared after
  #            bind() (DHCP completing late, a flap, an address renewal) was
  #            never advertised again, so same-LAN clients failed PERMANENTLY
  #            with -6 until a restart. Keeps `exclude_local_address()` in the
  #            path, which is what stops nospoon's TUN address being announced.
  #   3345fe3  Finding J — never re-destroy a udx stream whose teardown is
  #            already in flight. Fixes the SIGABRT in ~ConnState on the
  #            connect-failure path (libuv `!uv__is_closing(handle)` assert).
  #
  # Also in range, not used by nospoon: a C-API firewall polarity fix (we use
  # the C++ API; Android is client-only), stream read backpressure, and a
  # client `reusable_socket` option.
  # Bump together with `rev` + `hash` when upstream advances.
  version = "0-unstable-2026-07-29";

  src = fetchFromGitHub {
    owner = "jjacke13";
    repo = "hyperdht-cpp";
    rev = "6a2d62cde80cdf18217fd99b6fd49aa78164b7b2";
    hash = "sha256-ZHdo/wsipEKVQpWYnzZsRDteJgDR4N/2Nmpdtf5pQ3g=";
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
