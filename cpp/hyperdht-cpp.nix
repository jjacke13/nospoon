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
  # Pinned to d1b9cf4 = the announcer pickBest(3) fix (Finding H: commit the
  # announce record to only the 3 closest replies after the walk — matching
  # JS pickBest = slice(0,3) — so the record lives on the 3 forwarding relays
  # and findPeer converges straight to them; turns ~28s mobile connects into
  # ~1s). Code change is 12c4af6; d1b9cf4 is a docs-only follow-up.
  # Bump together with `rev` + `hash` when upstream advances.
  version = "0-unstable-2026-07-26";

  src = fetchFromGitHub {
    owner = "jjacke13";
    repo = "hyperdht-cpp";
    rev = "d1b9cf40d5628afba06a48156ce68d62e0b91419";
    hash = "sha256-vyMvEDclUjjYI3OLw07M0o0Os6zl7NLouc/p0Y33ErE=";
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
