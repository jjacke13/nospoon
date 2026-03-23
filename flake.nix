{
  description = "nospoon — P2P VPN over HyperDHT";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];

      forAllSystems = f:
        nixpkgs.lib.genAttrs supportedSystems (system: f {
          pkgs = nixpkgs.legacyPackages.${system};
        });

    in
    {
      packages = forAllSystems ({ pkgs }: let
        nospoon = pkgs.callPackage ./package.nix { };
      in {
        default = nospoon;
        nospoon = nospoon;
      });

      devShells.x86_64-linux.android = import ./android/shell.nix {
        pkgs = import nixpkgs {
          system = "x86_64-linux";
          config.allowUnfree = true;
          config.android_sdk.accept_license = true;
        };
      };

      nixosModules = {
        nospoon = import ./module.nix { inherit self; };
        default = self.nixosModules.nospoon;
      };
    };
}
