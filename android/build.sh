#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check environment
check_env() {
    log_info "Checking environment..."

    if [ -z "$ANDROID_HOME" ]; then
        log_error "ANDROID_HOME not set. Run: nix-shell"
        exit 1
    fi

    if [ ! -d "$ANDROID_HOME" ]; then
        log_error "Android SDK not found at $ANDROID_HOME"
        exit 1
    fi

    # Set JAVA_HOME if not set
    if [ -z "$JAVA_HOME" ]; then
        JAVA_BIN=$(which java 2>/dev/null || echo "")
        if [ -n "$JAVA_BIN" ]; then
            JAVA_HOME=$(dirname $(dirname $(readlink -f $JAVA_BIN)))
            export JAVA_HOME
            log_info "Detected JAVA_HOME=$JAVA_HOME"
        fi
    fi

    log_info "Environment OK"
    log_info "  ANDROID_HOME=$ANDROID_HOME"
}

# Download nospoon binary from GitHub Actions or releases
download_binary() {
    local BINARY_PATH="app/src/main/jniLibs/arm64-v8a/libnospoon.so"

    if [ -f "$BINARY_PATH" ]; then
        log_info "libnospoon.so already exists, skipping download"
        return
    fi

    log_info "Downloading nospoon android-arm64 binary..."

    mkdir -p app/src/main/jniLibs/arm64-v8a

    # Try GitHub release first
    local tmpdir="/tmp/nospoon-android-$$"
    mkdir -p "$tmpdir"
    if gh release download v0.5.0-bare-test \
        --repo jjacke13/nospoon \
        --pattern "nospoon-android-arm64.tar.gz" \
        --dir "$tmpdir" 2>/dev/null; then
        tar xzf "$tmpdir/nospoon-android-arm64.tar.gz" -C "$tmpdir"
        cp "$tmpdir/bin/nospoon" "$BINARY_PATH"
        chmod +x "$BINARY_PATH"
        rm -rf "$tmpdir"
        log_info "Binary installed from release"
        return
    fi

    # Fallback: download from latest CI artifacts
    log_warn "Release not found, trying CI artifacts..."
    local RUN_ID
    RUN_ID=$(gh run list --repo jjacke13/nospoon --branch nospoon-bare --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null)
    if [ -n "$RUN_ID" ]; then
        gh run download "$RUN_ID" --repo jjacke13/nospoon -n binary-android-arm64 -D "$tmpdir" 2>/dev/null || true
        if [ -f "$tmpdir/bin/nospoon" ]; then
            cp "$tmpdir/bin/nospoon" "$BINARY_PATH"
            chmod +x "$BINARY_PATH"
            rm -rf "$tmpdir"
            log_info "Binary installed from CI artifacts"
            return
        fi
    fi

    rm -rf "$tmpdir"
    log_error "Could not download nospoon binary."
    log_error "Place the android-arm64 binary at: $BINARY_PATH"
    exit 1
}

# Build debug APK
build_apk() {
    log_info "Building debug APK..."

    # Generate gradle wrapper if not present
    if [ ! -f "gradlew" ]; then
        log_info "Generating Gradle wrapper..."
        gradle wrapper
        chmod +x gradlew
    fi

    ./gradlew assembleDebug

    APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
    if [ -f "$APK_PATH" ]; then
        log_info "Build successful!"
        log_info "APK: $(realpath $APK_PATH)"
        cp "$APK_PATH" ./nospoon-debug.apk
        log_info "Copied to: $(realpath ./nospoon-debug.apk)"
    else
        log_error "APK not found at $APK_PATH"
        exit 1
    fi
}

# Main
main() {
    log_info "nospoon Android build script"
    log_info "================================"

    check_env
    download_binary
    build_apk

    log_info "Done!"
}

main "$@"
