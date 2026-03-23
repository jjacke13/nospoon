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

  peersJson = lib.optionalString (cfg.peers != { }) (builtins.toJSON { peers = cfg.peers; });

  peersFileContent = pkgs.writeText "peers.json" peersJson;

  modeAndKey = if isClient then [cfg.serverAddress] else [];

  baseFlags = modeAndKey
    ++ ["--ip" cfg.ip]
    ++ lib.optionals (cfg.ipv6 != null) ["--ipv6" cfg.ipv6]
    ++ lib.optionals (cfg.peersFile != null) ["--config" cfg.peersFile]
    ++ lib.optionals (cfg.peers != { } && cfg.peersFile == null) ["--config" "${cfg.dataDir}/peers.json"]
    ++ lib.optionals (cfg.mtu != 1400) ["--mtu" (toString cfg.mtu)]
    ++ lib.optionals cfg.fullTunnel ["--full-tunnel"]
    ++ lib.optionals (cfg.outInterface != null) ["--out-interface" cfg.outInterface]
  ;

  nospoonWrapper = pkgs.writeScriptBin "nospoon-wrapper" ''
    #!${pkgs.bash}/bin/bash
    set -e

    MODE="$1"
    shift

    ${lib.optionalString (seedFilePath != null) ''
    if [ -f "${seedFilePath}" ]; then
      SEED=$(cat "${seedFilePath}")
      set -- "$@" --seed "$SEED"
    fi
    ''}

    # Capture public key from output and write to file
    ${cfg.package}/bin/nospoon "$MODE" "$@" 2>&1 | while IFS= read -r line; do
      echo "$line"
      case "$line" in
        *"Public key:"*)
          echo "$line" | sed 's/.*Public key:[[:space:]]*//' > "${cfg.dataDir}/public-key"
          ;;
      esac
    done
  '';

  execFlags = lib.concatStringsSep " " baseFlags;

in {
  options.services.nospoon = {
    enable = lib.mkEnableOption "nospoon P2P VPN";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.nospoon;
      description = "The nospoon package to use";
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
        If null, defaults to <literal>${cfg.dataDir}/seed</literal> and will be generated on first boot.
        For server: generates persistent server key.
        For client: use for authenticated mode.
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
        Required for client mode.
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
        Generates peers.json automatically.
      '';
    };

    peersFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to existing peers.json file.
        Use this instead of 'peers' if you want to manage the file manually.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = isClient -> cfg.serverAddress != null;
        message = "services.nospoon.serverAddress is required in client mode";
      }
      {
        assertion = cfg.peers == { } || cfg.peersFile == null;
        message = "services.nospoon.peers and services.nospoon.peersFile are mutually exclusive";
      }
    ];

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0755 root root -"
    ];

    system.activationScripts.nospoon-seed = lib.stringAfter ["users"] ''
      if [ ! -f "${cfg.dataDir}/seed" ]; then
        ${pkgs.openssl}/bin/openssl rand -hex 32 > "${cfg.dataDir}/seed"
        chmod 600 "${cfg.dataDir}/seed"
        echo "nospoon: generated seed file at ${cfg.dataDir}/seed"
      fi
    '';

    systemd.services.nospoon = {
      description = "nospoon P2P VPN (${cfg.mode})";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      path = [ pkgs.iptables pkgs.iproute2 pkgs.procps pkgs.bash ];

      serviceConfig = {
        Type = "simple";
        User = "root";
        Group = "root";
        WorkingDirectory = cfg.dataDir;
        ExecStartPre = lib.optionalString (cfg.peers != { }) ''
          ${pkgs.bash}/bin/bash -c 'cp -f ${peersFileContent} ${cfg.dataDir}/peers.json'
        '';
        ExecStart = "${nospoonWrapper}/bin/nospoon-wrapper ${cfg.mode} ${execFlags}";
        Restart = "on-failure";
        RestartSec = "5s";
        # Runs as root — no capability restrictions needed
      };
    };
  };
}
