#!/usr/bin/env bash
# Exercises the libuv version guard in cpp/CMakeLists.txt.
#
# The guard is the only thing standing between a bad libuv and a binary that
# wedges "connected" in the field. It cannot be covered by a normal test run:
# the regression it blocks does not reproduce on loopback, so every unit test
# passes on a libuv that would fail in production. v0.5.0 shipped Windows
# binaries built against libuv 1.52.1 because nothing checked.
#
# Rather than restate the logic, this extracts the real block from
# cpp/CMakeLists.txt between its `libuv-version-guard` markers and runs it
# against fabricated uv/version.h headers, so the test cannot drift from the
# code it covers.
#
#   ./scripts/test-libuv-guard.sh        (needs cmake on PATH)

set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cmakelists="$root/cpp/CMakeLists.txt"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

guard="$work/guard.cmake"
awk '/^# >>> libuv-version-guard/{f=1;next} /^# <<< libuv-version-guard/{f=0} f' \
    "$cmakelists" > "$guard"

if [ ! -s "$guard" ]; then
    echo "FAIL: could not extract the guard — are the markers still in $cmakelists?" >&2
    exit 1
fi

# version -> expected exit status (0 = build allowed, 1 = build refused)
cases="1.50.0:1 1.51.0:0 1.51.9:0 1.52.0:1 1.52.1:1 1.53.0:0"

fails=0
for case in $cases; do
    version=${case%:*}
    want=${case#*:}
    IFS=. read -r major minor patch <<<"$version"

    mkdir -p "$work/$version/uv"
    cat > "$work/$version/uv/version.h" <<EOF
#define UV_VERSION_MAJOR $major
#define UV_VERSION_MINOR $minor
#define UV_VERSION_PATCH $patch
EOF

    script="$work/run-$version.cmake"
    echo "set(NOSPOON_UV_INCLUDE_DIR \"$work/$version\")" > "$script"
    cat "$guard" >> "$script"

    set +e
    output=$(cmake -P "$script" 2>&1)
    got=$?
    set -e
    [ "$got" -ne 0 ] && got=1

    if [ "$got" = "$want" ]; then
        printf 'ok    libuv %-7s -> %s\n' "$version" \
            "$([ "$want" = 0 ] && echo allowed || echo refused)"
    else
        printf 'FAIL  libuv %-7s -> got %s, wanted %s\n%s\n' "$version" \
            "$([ "$got" = 0 ] && echo allowed || echo refused)" \
            "$([ "$want" = 0 ] && echo allowed || echo refused)" "$output"
        fails=$((fails + 1))
    fi
done

# The guard must also parse the version correctly, not merely pick a branch.
if ! cmake -P "$work/run-1.51.0.cmake" 2>&1 | grep -q 'libuv version: 1.51.0'; then
    echo "FAIL: guard did not report the parsed version as 1.51.0"
    fails=$((fails + 1))
fi

if [ "$fails" -ne 0 ]; then
    echo "$fails check(s) failed"
    exit 1
fi
echo "all libuv guard checks passed"
