{
  lib,
  stdenv,
  buildNpmPackage,
  makeWrapper,
  bare,
  iptables ? null,
  iproute2 ? null,
  procps ? null,
}:

buildNpmPackage rec {
  pname = "nospoon-bare";
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

  makeCacheWritable = true;
  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  # Replace the node shebang with bare
  postInstall = ''
    # Remove the node wrapper npm creates
    rm "$out/bin/${pname}"

    # Create a wrapper that runs bare with our cli.js
    makeWrapper "${bare}/bin/bare" "$out/bin/nospoon" \
      --add-flags "$out/lib/node_modules/nospoon/bin/cli.js" \
      ${lib.optionalString stdenv.isLinux
        ''--prefix PATH : "${lib.makeBinPath [ iptables iproute2 procps ]}"''
      }
  '';

  meta = {
    description = "P2P VPN over HyperDHT — WireGuard-like interface using Hyperswarm (Bare runtime)";
    license = lib.licenses.gpl3Only;
    mainProgram = "nospoon";
    platforms = lib.platforms.linux;
  };
}
