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

  nativeBuildInputs = [ cmake ninja pkg-config makeWrapper ];
  buildInputs = [ hyperdht-cpp libsodium libuv ];

  cmakeFlags = [
    "-DCMAKE_BUILD_TYPE=Release"
  ];

  # Linux: wrap with iptables, ip, sysctl — same as js/package.nix.
  # macOS: pfctl, route, networksetup, sysctl are already on /usr/sbin.
  postInstall = lib.optionalString stdenv.isLinux ''
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
