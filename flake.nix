{
  description = "nospoon — P2P VPN over HyperDHT";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    bare-nix.url = "path:/home/jacke/Desktop/repos/bare-nix";
  };

  outputs = { self, nixpkgs, bare-nix }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];

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
      } // (
        # nospoon-bare only available where bare-nix provides a package
        if bare-nix.packages ? ${pkgs.system}
        then {
          nospoon-bare = pkgs.callPackage ./package-bare.nix {
            bare = bare-nix.packages.${pkgs.system}.bare;
          };
        }
        else { }
      ));

      devShells = nixpkgs.lib.genAttrs
        [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ]
        (system: let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [ cmake gcc clang lld ninja nodejs_22 nasm ];
          };

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
