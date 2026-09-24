{
  description = "nospoon — P2P VPN over HyperDHT";

  inputs = {
    # Pinned to nixos-25.11 DELIBERATELY: it ships libuv 1.51.x, and the
    # cpp impl (via libudx) MUST NOT run on libuv 1.52.0/1.52.1 — those have
    # a UDP POLLERR regression (libuv #4902/#5030) that silently wedges
    # established connections on real NAT/CGNAT/mobile paths ("connected"
    # but no data, no self-heal). See hyperdht-cpp docs/LIBUV-VERSION.md.
    # CONSUMERS: do NOT set `inputs.nospoon.inputs.nixpkgs.follows` — that
    # rebuilds nospoon against your (possibly newer) nixpkgs and reintroduces
    # the bug. Let nospoon keep its own nixpkgs.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];

      forAllSystems = f:
        nixpkgs.lib.genAttrs supportedSystems (system: f {
          inherit system;
          pkgs = nixpkgs.legacyPackages.${system};
        });

    in
    {
      packages = forAllSystems ({ pkgs, system }: let
        nospoon-js = pkgs.callPackage ./js/package.nix { };
        nospoon-cpp = pkgs.callPackage ./cpp/package.nix { };
      in {
        # Two interchangeable implementations of the same wire protocol:
        #   nospoon-js  — Node.js + koffi   (lives under js/)
        #   nospoon-cpp — C++ single binary (smaller, faster; under cpp/)
        # Both ship `bin/nospoon`. The NixOS module reads
        # `services.nospoon.package`, which defaults to `default` below.
        inherit nospoon-js nospoon-cpp;
        default = nospoon-cpp;
      } // nixpkgs.lib.optionalAttrs pkgs.stdenv.isLinux (
        # Fully-static single-binary builds (musl) for NON-Nix Linux boxes —
        # Debian, Raspberry Pi OS, Alpine, a distroless container, anything.
        # `ldd` says "not a dynamic executable": libsodium, libuv, libstdc++
        # and hyperdht-cpp are all folded in, so the deploy is ONE file with
        # zero runtime deps and no glibc-version risk.
        #
        # Unwrapped by design (enableWrapper=false): the target resolves `ip`
        # from its own /usr/sbin. Debian always ships iproute2, and `ip` is all
        # client mode needs.
        #
        #   nix build .#nospoon-static            # this machine's arch
        #   nix build .#nospoon-static-aarch64    # cross to ARM64
        #   scp -L result/bin/nospoon pi:/usr/local/bin/
        #
        # `-debug` variants are identical but build hyperdht-cpp with
        # HYPERDHT_DEBUG=ON (verbose DHT_LOG to stderr: holepunch rounds,
        # announce cycles, peer addresses). Use them to diagnose a field
        # failure, then put the plain build back — the debug one prints peer
        # addresses and is noisy enough to matter on a slow box.
        let
          static = system': debug':
            (import nixpkgs {
              inherit system;
              crossSystem = { config = system'; };
            }).pkgsStatic.callPackage ./cpp/package.nix { debug = debug'; };
          musl = {
            x86_64 = "x86_64-unknown-linux-musl";
            aarch64 = "aarch64-unknown-linux-musl";
          };
        in {
          nospoon-static               = static musl.x86_64  false;
          nospoon-static-debug         = static musl.x86_64  true;
          nospoon-static-aarch64       = static musl.aarch64 false;
          nospoon-static-aarch64-debug = static musl.aarch64 true;

          # Previous name for the ARM64 release build. Kept so existing
          # deploy scripts and notes do not break.
          nospoon-cpp-aarch64-static = static musl.aarch64 false;
        }));

      nixosModules = {
        nospoon = import ./module.nix { inherit self; };
        default = self.nixosModules.nospoon;
      };
    };
}
