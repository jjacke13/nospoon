#!/usr/bin/env bash
# mkclients.sh — mass-generate nospoon client configs + patch server peers.
# Linux helper. Requires: nospoon binary on PATH, jq, awk, sed.
#
# Example:
#   ./mkclients.sh -n 5 -s server.jsonc -k <server-pubkey-64hex> -o ./clients
#
# Notes:
#   - Server config is rewritten via jq → comments in the server config are LOST.
#     A .bak file is saved next to it before patching.
#   - IP allocation assumes a /24 subnet (warns otherwise).
#   - Client files are written with mode 0600 (contain private seeds).

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: mkclients.sh -n N -s SERVER_CFG -k SERVER_PUBKEY -o OUTDIR [-p PREFIX] [-S START]

  -n N             number of clients to generate (required)
  -s SERVER_CFG    server config file, patched in place (required)
  -k SERVER_PK     server public key, 64 hex chars (required)
  -o OUTDIR        output directory for client configs (created if missing)
  -p PREFIX        client filename prefix (default: client)
  -S START         starting host octet (default: highest used + 1)
  -h               show this help
EOF
  exit 1
}

N=""; CFG=""; PK=""; OUT=""; PREFIX="client"; START=""
while getopts "n:s:k:o:p:S:h" opt; do
  case "$opt" in
    n) N="$OPTARG" ;;
    s) CFG="$OPTARG" ;;
    k) PK="$OPTARG" ;;
    o) OUT="$OPTARG" ;;
    p) PREFIX="$OPTARG" ;;
    S) START="$OPTARG" ;;
    *) usage ;;
  esac
done

[[ -z "$N" || -z "$CFG" || -z "$PK" || -z "$OUT" ]] && usage
[[ ! -f "$CFG" ]] && { echo "server config not found: $CFG" >&2; exit 1; }
[[ ${#PK} -eq 64 ]] || { echo "server pubkey must be 64 hex chars (got ${#PK})" >&2; exit 1; }
[[ "$PK" =~ ^[0-9a-fA-F]+$ ]] || { echo "server pubkey must be hexadecimal" >&2; exit 1; }
[[ "$N" =~ ^[1-9][0-9]*$ ]] || { echo "-n must be a positive integer" >&2; exit 1; }

command -v nospoon >/dev/null || { echo "nospoon binary required on PATH" >&2; exit 1; }
command -v jq      >/dev/null || { echo "jq required"                    >&2; exit 1; }

mkdir -p "$OUT"

# --- strip JSONC (line + block comments + trailing commas) → plain JSON ---
strip_jsonc() {
  awk '
    BEGIN { blk = 0 }
    {
      while (1) {
        if (blk) {
          if (match($0, /\*\//)) { $0 = substr($0, RSTART + 2); blk = 0 }
          else { $0 = ""; break }
        }
        if (match($0, /\/\*/)) {
          s = substr($0, 1, RSTART - 1)
          rest = substr($0, RSTART + 2)
          if (match(rest, /\*\//)) { $0 = s substr(rest, RSTART + 2) }
          else { $0 = s; blk = 1; break }
        } else break
      }
      sub(/\/\/.*$/, "")
      print
    }
  ' "$1" | sed -E ':a;N;$!ba;s/,([[:space:]]*[}\]])/\1/g'
}

JSON_TMP="$(mktemp)"
trap 'rm -f "$JSON_TMP"' EXIT
strip_jsonc "$CFG" > "$JSON_TMP"

# --- read server subnet + existing peer IPs ---
SERVER_IP_CIDR="$(jq -r '.ip // "10.0.0.1/24"' "$JSON_TMP")"
mapfile -t USED_IPS < <(jq -r '(.peers // {}) | values[]' "$JSON_TMP")

IP_ADDR="${SERVER_IP_CIDR%/*}"
PFX="${SERVER_IP_CIDR#*/}"
[[ "$PFX" != "24" ]] && echo "warning: only /24 supported, got /$PFX — IP allocation may be wrong" >&2

IFS=. read -r o1 o2 o3 o4 <<< "$IP_ADDR"
BASE="$o1.$o2.$o3"

# --- determine starting host octet ---
USED=("$o4")
for ip in "${USED_IPS[@]:-}"; do
  [[ -z "$ip" ]] && continue
  USED+=("${ip##*.}")
done

if [[ -z "$START" ]]; then
  hi=0
  for u in "${USED[@]}"; do
    (( u > hi )) && hi=$u
  done
  START=$(( hi + 1 ))
fi

END=$(( START + N - 1 ))
(( END > 254 )) && { echo "subnet exhausted: would need .$END but /24 max is .254" >&2; exit 1; }
(( START < 2 )) && { echo "start octet $START is invalid (must be >= 2)" >&2; exit 1; }

# --- generate clients ---
NEW_PEERS='{}'
host=$START
for (( i=1; i<=N; i++ )); do
  out="$(nospoon genkey)"
  seed="$(awk '/^seed:/ {print $2}'       <<< "$out")"
  pubkey="$(awk '/^public_key:/ {print $2}' <<< "$out")"
  [[ -z "$seed" || -z "$pubkey" ]] && { echo "nospoon genkey returned unexpected output" >&2; exit 1; }

  ip="$BASE.$host"
  fname="$(printf '%s-%03d.jsonc' "$PREFIX" "$i")"
  out_path="$OUT/$fname"

  cat > "$out_path" <<EOF
{
  "mode": "client",
  "server": "$PK",
  "ip": "$ip/$PFX",
  "seed": "$seed",
  "mtu": 1400
}
EOF
  chmod 600 "$out_path"
  echo "wrote $out_path  (ip=$ip pubkey=$pubkey)"

  NEW_PEERS="$(jq --arg pk "$pubkey" --arg ip "$ip" '. + {($pk): $ip}' <<< "$NEW_PEERS")"
  (( host++ ))
done

# --- patch server config (rewrites as plain JSON; .bak preserved) ---
cp -p "$CFG" "$CFG.bak"
jq --argjson new "$NEW_PEERS" '.peers = ((.peers // {}) + $new)' "$JSON_TMP" > "$CFG.tmp"
mv "$CFG.tmp" "$CFG"
echo "patched $CFG  (+$N peers, backup: $CFG.bak — comments may be lost)"
