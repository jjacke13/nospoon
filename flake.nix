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
          pkgs = nixpkgs.legacyPackages.${system};
        });

    in
    {
      packages = forAllSystems ({ pkgs }: let
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
      } // nixpkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
        # Fully-static aarch64 build (musl) for NON-Nix ARM boxes — Raspberry Pi
        # OS / Debian on a Pi Zero 2 W, Pi 4/5, etc. `ldd` says "not a dynamic
        # executable": libsodium, libuv and hyperdht-cpp are all folded in, so
        # the deploy is ONE file with zero runtime deps and no glibc-version
        # risk. Unwrapped by design (enableWrapper=false): the target resolves
        # `ip` from its own /usr/sbin. Build + deploy:
        #   nix build .#nospoon-cpp-aarch64-static
        #   scp -L result/bin/nospoon pi:/usr/local/bin/
        nospoon-cpp-aarch64-static =
          pkgs.pkgsCross.aarch64-multiplatform.pkgsStatic.callPackage ./cpp/package.nix { };
      });

      devShells = nixpkgs.lib.genAttrs
        [ "x86_64-linux" "x86_64-darwin" "aarch64-darwin" ]
        (system: {
          android = import ./android/shell.nix {
            pkgs = import nixpkgs {
              inherit system;
              config.allowUnfree = true;
              config.android_sdk.accept_license = true;
            };
          };
        });

      nixosModules = {
        nospoon = import ./module.nix { inherit self; };
        default = self.nixosModules.nospoon;
      };
    };
}
