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
  hyperdht-cpp ? callPackage ./hyperdht-cpp.nix { },
  # Wrap the binary so iptables/ip/sysctl are on PATH. Only meaningful when the
  # result runs on a Nix machine: a fully-static cross build gets scp'd to a
  # plain Debian/Pi box where the wrapper's /nix/store shebang and PATH entries
  # do not exist, so it must ship the BARE binary and rely on the target's
  # /usr/sbin:/sbin (Debian always has iproute2; `ip` is all client mode needs).
  enableWrapper ? (stdenv.hostPlatform.isLinux && !stdenv.hostPlatform.isStatic),
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "nospoon-cpp";
  version = "0.4.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./CMakeLists.txt
      ./main.cpp
      ./server.cpp
      ./client.cpp
      ./config.hpp
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
