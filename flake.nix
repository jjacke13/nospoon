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

      # Android dev shell
      androidDevShell = androidPkgs.mkShell {
        name = "nospoon-android";
        buildInputs = with androidPkgs; [
          android-sdk
          androidndk
          openjdk17
          gradle
          maven
          nodejs_24
        ];
        shellHook = ''
          export ANDROID_HOME="${androidPkgs.android-sdk}"
          export ANDROID_SDK_ROOT="$ANDROID_HOME"
          export ANDROID_NDK_HOME="${androidPkgs.androidndk}/libexec/android-ndk"
        '';
      };
    in
    {
      packages = forAllSystems ({ pkgs }: let
        nospoon = pkgs.callPackage ./package.nix { };
      in {
        default = nospoon;
        nospoon = nospoon;
      });

      devShells.x86_64-linux.android = androidDevShell;

      nixosModules = {
        nospoon = import ./module.nix { inherit self; };
        default = self.nixosModules.nospoon;
      };
    };
}
