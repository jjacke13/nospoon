{
  lib,
  stdenv,
  buildNpmPackage,
  makeWrapper,
  iptables ? null,
  iproute2 ? null,
  procps ? null,
}:

buildNpmPackage rec {
  pname = "nospoon";
  version = "0.4.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./bin
      ./lib
      ./prebuilds
      ./package.json
      ./package-lock.json
    ];
  };

  npmDepsHash = "sha256-8XOZ7UZhkJQ68s+OYb1Me2+BTXePg6Hnfh1gAYBvciU=";

  # require-addon auto-loads the correct prebuilt .node from prebuilds/
  # based on detected platform + arch at runtime — no native build needed
  makeCacheWritable = true;
  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  # Linux: wrap with iptables, ip, sysctl — Nix store paths not on system PATH
  # macOS: pfctl, route, networksetup, sysctl are in /usr/sbin already on PATH
  postInstall = lib.optionalString stdenv.isLinux ''
    wrapProgram "$out/bin/${pname}" \
      --prefix PATH : "${lib.makeBinPath [ iptables iproute2 procps ]}"
  '';

  meta = {
    description = "P2P VPN over HyperDHT — WireGuard-like interface using Hyperswarm";
    license = lib.licenses.gpl3Only;
    mainProgram = "nospoon";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
