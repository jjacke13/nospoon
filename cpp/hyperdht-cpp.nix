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
  # Pinned to d4d9d01 = the announcer reannounce-liveness fix (Finding E:
  # Query::visit() tid==0 settle + 60s stuck-cycle watchdog) plus two
  # docs-only commits (libuv 1.51.x requirement / 1.52 POLLERR warning,
  # field Finding F). No code change over f843b4b.
  # Bump together with `rev` + `hash` when upstream advances.
  version = "0-unstable-2026-07-25";

  src = fetchFromGitHub {
    owner = "jjacke13";
    repo = "hyperdht-cpp";
    rev = "d4d9d01f40081181e2f67d77fa2ac48512afb70e";
    hash = "sha256-F69v2YVcw5a0tPWTJUMFrWpOMupqBRnwxG1cD96tqPE=";
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
