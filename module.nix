{ self }:

{ config, lib, pkgs, ... }:

let
  cfg = config.services.nospoon;

  isServer = cfg.mode == "server";
  isClient = cfg.mode == "client";

  defaultIp = if isServer then "10.0.0.1/24" else "10.0.0.2/24";

  seedFilePath = if cfg.seedFile != null then cfg.seedFile
                  else if isServer then "${cfg.dataDir}/seed"
                  else null;

  generatedConfig = builtins.toJSON ({
    mode = cfg.mode;
    ip = cfg.ip;
    mtu = cfg.mtu;
    fullTunnel = cfg.fullTunnel;
  }
  // lib.optionalAttrs (cfg.ipv6 != null) { ipv6 = cfg.ipv6; }
  // lib.optionalAttrs (seedFilePath != null) { seedFile = seedFilePath; }
  // lib.optionalAttrs isClient { server = cfg.serverAddress; }
  // lib.optionalAttrs (cfg.outInterface != null) { outInterface = cfg.outInterface; }
  // lib.optionalAttrs (cfg.peers != { }) { peers = cfg.peers; }
  );

  generatedConfigFile = pkgs.writeText "nospoon-config.json" generatedConfig;

  configFilePath = if cfg.configFile != null then cfg.configFile
                   else generatedConfigFile;

in {
  options.services.nospoon = {
    enable = lib.mkEnableOption "nospoon P2P VPN";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.nospoon;
      description = "The nospoon package to use";
    };

    configFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to a user-managed nospoon config file (JSONC format).
        When set, all other nospoon options except 'package' are ignored.
        Use this to keep secrets (seed) out of the Nix store.
      '';
    };

    mode = lib.mkOption {
      type = lib.types.enum [ "server" "client" ];
      default = "server";
      description = "Operation mode";
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/nospoon";
      description = "State directory for nospoon";
    };

    ip = lib.mkOption {
      type = lib.types.str;
      default = defaultIp;
      description = "TUN interface IPv4 address in CIDR notation";
    };

    ipv6 = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "TUN interface IPv6 address in CIDR notation";
    };

    seedFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to file containing 64-char hex seed for deterministic key.
        If null and mode is server, defaults to dataDir/seed (auto-generated on first boot).
      '';
    };

    mtu = lib.mkOption {
      type = lib.types.int;
      default = 1400;
      description = "TUN interface MTU";
    };

    fullTunnel = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Enable full tunnel mode. For server: acts as NAT for clients.
        For client: routes all internet traffic through the VPN.
      '';
    };

    outInterface = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Outgoing network interface for NAT (auto-detected if null)";
    };

    serverAddress = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Server public key (64-char hex) to connect to.
        Required for client mode when configFile is not set.
      '';
    };

    peers = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        "abc123def456789012345678901234567890123456789012345678901234" = "10.0.0.2";
        "fedcba987654321098765432109876543210987654321098765432109876" = "10.0.0.3";
      };
      description = ''
        Map of client public keys to IP addresses for authenticated mode.
        Embedded directly in the generated config file.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.configFile != null || !isClient || cfg.serverAddress != null;
        message = "services.nospoon.serverAddress is required in client mode when configFile is not set";
      }
      {
        assertion = cfg.configFile == null || (cfg.peers == { } && cfg.seedFile == null);
        message = "services.nospoon: configFile is mutually exclusive with peers and seedFile — those options are ignored when configFile is set";
      }
    ];

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0755 root root -"
    ];

    system.activationScripts.nospoon-seed = lib.mkIf (cfg.configFile == null && isServer) (
      lib.stringAfter ["users"] ''
        if [ ! -f "${cfg.dataDir}/seed" ]; then
          ${pkgs.openssl}/bin/openssl rand -hex 32 > "${cfg.dataDir}/seed"
          chmod 600 "${cfg.dataDir}/seed"
          echo "nospoon: generated seed file at ${cfg.dataDir}/seed"
        fi
      ''
    );

    systemd.services.nospoon = {
      description = "nospoon P2P VPN (${cfg.mode})";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      path = [ pkgs.iptables pkgs.iproute2 pkgs.procps ];

      serviceConfig = {
        Type = "simple";
        User = "root";
        Group = "root";
        WorkingDirectory = cfg.dataDir;
        ExecStart = "${cfg.package}/bin/nospoon up ${configFilePath}";
        Restart = "on-failure";
        RestartSec = "5s";
      };
    };
  };
}
