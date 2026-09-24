# nospoon-cpp — single-binary C++ implementation of nospoon.
#
# Built on top of hyperdht-cpp (the P2P DHT layer) which is itself a Nix
# derivation defined in `./hyperdht-cpp.nix`. The binary is wire-
# compatible with the Node.js implementation under `../js/`.

{
  lib,
  stdenv,
  callPackage,
  cmake,
  ninja,
  pkg-config,
  libsodium,
  libuv,
  makeWrapper,
  iptables ? null,
  iproute2 ? null,
  procps ? null,
  # Debug logging in the DHT layer. Threaded down to hyperdht-cpp.nix so the
  # `*-debug` flake outputs are one argument, not a separate derivation file.
  debug ? false,
  hyperdht-cpp ? callPackage ./hyperdht-cpp.nix { inherit debug; },
  # Wrap the binary so iptables/ip/sysctl are on PATH. Only meaningful when the
  # result runs on a Nix machine: a fully-static cross build gets scp'd to a
  # plain Debian/Pi box where the wrapper's /nix/store shebang and PATH entries
  # do not exist, so it must ship the BARE binary and rely on the target's
  # /usr/sbin:/sbin (Debian always has iproute2; `ip` is all client mode needs).
  enableWrapper ? (stdenv.hostPlatform.isLinux && !stdenv.hostPlatform.isStatic),
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "nospoon-cpp";
  version = "0.5.1";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./CMakeLists.txt
      ./main.cpp
      ./commands.cpp
      ./commands.hpp
      ./server.cpp
      ./client.cpp
      ./config.hpp
      ./connect_error.hpp
      ./framing.hpp
      ./routing.hpp
      ./validation.hpp
      ./full_tunnel.hpp
      ./full_tunnel_linux.cpp
      ./full_tunnel_macos.cpp
      ./tun.hpp
      ./tun_linux.hpp
      ./tun_macos.hpp
      ./tun_macos.cpp
    ];
  };

  nativeBuildInputs = [ cmake ninja pkg-config ] ++ lib.optional enableWrapper makeWrapper;
  buildInputs = [ hyperdht-cpp libsodium libuv ];

  cmakeFlags = [
    "-DCMAKE_BUILD_TYPE=Release"
    # Nix sandbox blocks network. Use the pre-built hyperdht-cpp from the
    # `hyperdht-cpp` derivation above (find_package) instead of letting
    # cpp/CMakeLists.txt fetch it via FetchContent.
    "-DNOSPOON_FETCH_HYPERDHT=OFF"
  ];

  # Pair with -ffunction-sections/-fdata-sections in hyperdht-cpp.nix: drop
  # every section nothing references. Matters most for the static
  # single-file outputs, where the whole library is folded into the binary.
  env.NIX_CFLAGS_COMPILE = "-ffunction-sections -fdata-sections";
  NIX_LDFLAGS = "--gc-sections";

  # pkgsStatic leaves the binary unstripped — 6.8k symbols, ~580 KB of a
  # 2.7 MB single-file deploy. --strip-all (not the default --strip-debug)
  # because nothing dlopens into this binary and no one profiles the shipped
  # artifact; a backtrace from a release build is a job for the debug output.
  dontStrip = false;
  stripAllList = [ "bin" ];

  # Linux: wrap with iptables, ip, sysctl — same as js/package.nix.
  # macOS: pfctl, route, networksetup, sysctl are already on /usr/sbin.
  # Static cross builds skip this entirely (see enableWrapper above).
  postInstall = lib.optionalString enableWrapper ''
    wrapProgram "$out/bin/nospoon" \
      --prefix PATH : "${lib.makeBinPath [ iptables iproute2 procps ]}"
  '';

  meta = {
    description = "P2P VPN over HyperDHT — C++ single-binary implementation";
    homepage = "https://github.com/jjacke13/nospoon";
    license = lib.licenses.gpl3Only;
    mainProgram = "nospoon";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
