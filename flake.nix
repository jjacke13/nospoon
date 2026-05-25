{
  description = "nospoon — P2P VPN over HyperDHT";

  inputs = {
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
      in {
        # Two interchangeable implementations of the same wire protocol:
        #   nospoon-js  — Node.js + koffi (mature; matches lib/ source tree)
        #   nospoon-cpp — C++ single binary (smaller, faster; under cpp/)
        # `default` picks the recommended impl. Once the C++ Nix package
        # lands, `default` will point at `nospoon-cpp`.
        inherit nospoon-js;
        default = nospoon-js;
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
