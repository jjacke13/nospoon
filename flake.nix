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
      # Two interchangeable implementations of the same wire protocol:
      #   nospoon-js  — Node.js + koffi   (lives under js/)
      #   nospoon-cpp — C++ single binary (smaller, faster; under cpp/)
      # Both ship `bin/nospoon`. The NixOS module reads
      # `services.nospoon.package`, which defaults to `default` below.
      #
      # On Linux every C++ output is a fully-static musl binary: libsodium,
      # libuv, libstdc++ and hyperdht-cpp are folded in, so `ldd` says "not a
      # dynamic executable" and the deploy is ONE file with zero runtime deps
      # and no glibc-version risk. That includes `nospoon-cpp` itself — there
      # is deliberately no dynamically-linked Linux output any more. The
      # binary is unwrapped, which is fine in both directions: module.nix puts
      # iptables/iproute2/procps on the service PATH, and a non-Nix target
      # resolves `ip` from its own /usr/sbin.
      #
      # macOS keeps the dynamic build — there is no musl-static equivalent,
      # and libsodium/libuv come from nixpkgs anyway.
      #
      # Every Linux output is NATIVE: `packages.<system>` builds for that
      # system's own architecture and nothing else. There are deliberately no
      # cross-compiled attributes. To get an ARM64 binary from an x86_64 box,
      # ask for the aarch64-linux output and let binfmt/qemu run the build —
      # register the handler once (NixOS: `boot.binfmt.emulatedSystems =
      # [ "aarch64-linux" ];`, which also adds the nix `extra-platforms`).
      #
      #   nix build .#nospoon-cpp                         # this machine, release
      #   nix build .#nospoon-cpp-debug                   # this machine, debug
      #   nix build .#packages.aarch64-linux.nospoon-cpp  # ARM64, via qemu
      #   scp -L result/bin/nospoon pi:/usr/local/bin/
      #
      # `-debug` variants build hyperdht-cpp with HYPERDHT_DEBUG=ON: verbose
      # DHT_LOG to stderr (holepunch rounds, announce cycles, peer addresses).
      # For diagnosing a field failure — put the plain build back afterwards,
      # since it prints peer addresses and is noisy enough to matter on a slow
      # box. It is NOT smaller-vs-larger: the two differ by ~30 KB.
      packages = forAllSystems ({ pkgs, system }: let
        nospoon-js = pkgs.callPackage ./js/package.nix { };

        static = target: debug:
          (import nixpkgs {
            inherit system;
            crossSystem = { config = target; };
          }).pkgsStatic.callPackage ./cpp/package.nix { inherit debug; };

        # Always the builder's own architecture. `crossSystem` below only
        # swaps glibc for musl; it never changes arch.
        hostMusl = if pkgs.stdenv.hostPlatform.isAarch64
                   then "aarch64-unknown-linux-musl"
                   else "x86_64-unknown-linux-musl";

        linux = rec {
          nospoon-cpp       = static hostMusl false;
          nospoon-cpp-debug = static hostMusl true;
          default = nospoon-cpp;
        };

        darwin = rec {
          nospoon-cpp = pkgs.callPackage ./cpp/package.nix { };
          nospoon-cpp-debug = pkgs.callPackage ./cpp/package.nix { debug = true; };
          default = nospoon-cpp;
        };
      in
        { inherit nospoon-js; }
        // (if pkgs.stdenv.isLinux then linux else darwin));

      nixosModules = {
        nospoon = import ./module.nix { inherit self; };
        default = self.nixosModules.nospoon;
      };
    };
}
