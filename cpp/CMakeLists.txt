# Nospoon C++ — P2P VPN built on hyperdht-cpp.
#
# Prerequisite: install hyperdht-cpp somewhere first.
#
#   cd /path/to/hyperdht-cpp
#   cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DHYPERDHT_BUILD_TESTS=OFF
#   cmake --build build
#   cmake --install build --prefix $HOME/opt/hyperdht
#
# Then build nospoon, pointing CMake at the install:
#
#   cd cpp
#   cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
#       -DCMAKE_PREFIX_PATH=$HOME/opt/hyperdht
#   cmake --build build
#
# Windows (vcpkg + MSVC):
#
#   cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
#       -DCMAKE_PREFIX_PATH=C:\opt\hyperdht \
#       -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
#       -DVCPKG_TARGET_TRIPLET=x64-windows-static-md
#   cmake --build build

cmake_minimum_required(VERSION 3.20)
project(nospoon LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(nospoon
    main.cpp
    commands.cpp
    server.cpp
    client.cpp)

if(WIN32)
    target_sources(nospoon PRIVATE
        tun_windows.cpp
        full_tunnel_windows.cpp)
elseif(APPLE)
    target_sources(nospoon PRIVATE
        tun_macos.cpp
        full_tunnel_macos.cpp)
else()
    target_sources(nospoon PRIVATE
        full_tunnel_linux.cpp)
endif()

target_include_directories(nospoon PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

# Suppress libudx debug_printf noise (TLP, congestion control chatter)
target_compile_definitions(nospoon PRIVATE NDEBUG)

# === hyperdht-cpp (the DHT + transport library) ===
#
# Two ways to obtain hyperdht-cpp:
#
#   1. `NOSPOON_FETCH_HYPERDHT=ON` (default) — CMake's FetchContent fetches
#      the pinned commit from GitHub and builds it inline as a static
#      archive. End-users get a one-command build:
#           cmake -B build && cmake --build build
#
#   2. `NOSPOON_FETCH_HYPERDHT=OFF` — assume hyperdht-cpp is already
#      installed (e.g. by a Nix derivation, vcpkg, or a manual
#      `cmake --install`). Discovered via the CMake config package
#      `hyperdht-config.cmake` under <prefix>/lib/cmake/hyperdht/. Pass
#      `-DCMAKE_PREFIX_PATH=<install-prefix>` if it's not on a standard
#      path. The Nix builds in cpp/package.nix use this mode so the
#      sandbox doesn't need network access.
#
# Pin the FetchContent rev together with the rev in cpp/hyperdht-cpp.nix
# so end-user builds and Nix builds use the same upstream commit.
option(NOSPOON_FETCH_HYPERDHT
    "Fetch hyperdht-cpp via CMake FetchContent (one-command build)" ON)

# Verbose DHT_LOG to stderr in hyperdht-cpp. Declared HERE, by name, rather
# than left to hyperdht's own option() picking up a -D from the command line:
# the v0.5.0 Windows *release* binary shipped with the debug strings compiled
# in (17 "[announcer]" format literals, including peer-address formats) even
# though the job passed -DHYPERDHT_DEBUG=OFF, while Linux and macOS came out
# clean from the same flag. Owning the variable and FORCE-ing it into the
# cache below removes the ambiguity. The CI jobs assert the result on the
# artifact, which is what actually catches a regression here.
option(HYPERDHT_DEBUG "Build hyperdht-cpp with verbose DHT_LOG to stderr" OFF)
message(STATUS "HYPERDHT_DEBUG: ${HYPERDHT_DEBUG}")

# Reject a value that is not a boolean. CMake treats ANY string that is not
# a false-constant as true, so a shell that failed to expand a variable —
# passing the literal `-DHYPERDHT_DEBUG=$dbg`, which is exactly what the
# Windows CI job did through v0.5.0 — silently turns debug logging ON in a
# build labelled "release", and that logging prints peer IP addresses.
if(NOT HYPERDHT_DEBUG MATCHES "^(ON|OFF|TRUE|FALSE|YES|NO|Y|N|1|0|)$")
    message(FATAL_ERROR
        "HYPERDHT_DEBUG must be a boolean, got '${HYPERDHT_DEBUG}'. "
        "An unexpanded shell variable will be read as TRUE and compile "
        "debug logging into a release build.")
endif()

if(NOSPOON_FETCH_HYPERDHT)
    include(FetchContent)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(HYPERDHT_EXPORT_CXX ON CACHE BOOL "" FORCE)
    set(HYPERDHT_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(HYPERDHT_DEBUG ${HYPERDHT_DEBUG} CACHE BOOL "" FORCE)
    FetchContent_Declare(hyperdht
        GIT_REPOSITORY https://github.com/jjacke13/hyperdht-cpp.git
        GIT_TAG 95cb5d94c119f654b83bb3a91a0cdc5db2355c65
        GIT_SUBMODULES_RECURSE ON
        GIT_SHALLOW OFF)
    FetchContent_MakeAvailable(hyperdht)
    # FetchContent uses the bare target names defined by hyperdht-cpp's
    # CMakeLists. find_package would expose them under the `hyperdht::`
    # namespace via the installed config package. Bridge the two by
    # declaring the aliases ourselves so the link line below works for
    # either mode.
    if(NOT TARGET hyperdht::hyperdht)
        add_library(hyperdht::hyperdht ALIAS hyperdht)
    endif()
    if(NOT TARGET hyperdht::udx)
        add_library(hyperdht::udx ALIAS udx)
    endif()
else()
    find_package(hyperdht CONFIG REQUIRED)
endif()

# === libsodium + libuv ===
# Linux/macOS: system packages via find_library. Windows: vcpkg config packages.
if(WIN32)
    find_package(unofficial-sodium CONFIG REQUIRED)
    find_package(libuv CONFIG REQUIRED)
    set(SODIUM_TARGET unofficial-sodium::sodium)
    if(TARGET libuv::uv_a)
        set(UV_TARGET libuv::uv_a)
    elseif(TARGET libuv::uv)
        set(UV_TARGET libuv::uv)
    else()
        message(FATAL_ERROR "libuv vcpkg target not found")
    endif()

    target_compile_definitions(nospoon PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
        _CRT_SECURE_NO_WARNINGS)
else()
    find_library(SODIUM_LIB sodium REQUIRED)
    find_library(UV_LIB uv REQUIRED)
    set(SODIUM_TARGET ${SODIUM_LIB})
    set(UV_TARGET ${UV_LIB})
endif()

# === libuv version guard ===
#
# hyperdht-cpp requires libuv 1.51.x. libuv 1.52.0 (PR #4902, commit 80a5e3ba)
# rewrote uv__udp_io()'s POLLERR handling to drain only MSG_ERRQUEUE, which is
# empty on a socket that never set IP_RECVERR. libudx sets IP_PMTUDISC_PROBE
# but not IP_RECVERR, so an ICMP frag-needed on a smaller-MTU path latches an
# error that is never cleared: send() keeps failing, no RTO fires, and the
# stream wedges "connected" forever with no self-heal. Full write-up in
# hyperdht-cpp/docs/LIBUV-VERSION.md.
#
# This is checked here rather than in CI because every build path lands on
# this file — Nix, the CI jobs, and a plain end-user `cmake`. It must be a
# hard failure: the bug is path-MTU and NAT-timing dependent, does NOT
# reproduce on loopback, and every libudx unit test passes on a bad libuv.
# A green test run is not evidence. v0.5.0 shipped Windows binaries built
# against 1.52.1 precisely because nothing asserted this.
find_path(NOSPOON_UV_INCLUDE_DIR uv/version.h)
if(NOT NOSPOON_UV_INCLUDE_DIR)
    message(FATAL_ERROR
        "Cannot find uv/version.h — needed to verify the libuv version. "
        "Install the libuv development headers.")
endif()
# >>> libuv-version-guard (exercised by scripts/test-libuv-guard.sh — keep markers)
foreach(_uv_part MAJOR MINOR PATCH)
    file(STRINGS "${NOSPOON_UV_INCLUDE_DIR}/uv/version.h" _uv_line
        REGEX "^#define[ \t]+UV_VERSION_${_uv_part}[ \t]+[0-9]+")
    string(REGEX MATCH "[0-9]+$" _uv_${_uv_part} "${_uv_line}")
endforeach()
set(NOSPOON_UV_VERSION "${_uv_MAJOR}.${_uv_MINOR}.${_uv_PATCH}")
message(STATUS "libuv version: ${NOSPOON_UV_VERSION} (from ${NOSPOON_UV_INCLUDE_DIR})")

if(NOSPOON_UV_VERSION VERSION_LESS 1.51.0)
    message(FATAL_ERROR
        "libuv ${NOSPOON_UV_VERSION} is too old; hyperdht-cpp needs 1.51.x.")
elseif(NOSPOON_UV_VERSION VERSION_EQUAL 1.52.0 OR NOSPOON_UV_VERSION VERSION_EQUAL 1.52.1)
    message(FATAL_ERROR
        "libuv ${NOSPOON_UV_VERSION} has the UDP POLLERR regression that silently "
        "wedges established connections (libuv #4902 / #5030). Build against "
        "1.51.x instead. See hyperdht-cpp/docs/LIBUV-VERSION.md.\n"
        "  Nix:     already pinned via nixos-25.11 — do not override nixpkgs.\n"
        "  vcpkg:   use cpp/vcpkg.json (manifest mode), which pins 1.51.0.\n"
        "  Homebrew/distro: install libuv 1.51.x, or point CMAKE_PREFIX_PATH at one.")
elseif(NOSPOON_UV_VERSION VERSION_GREATER 1.52.1)
    # Newer than anything that has been validated. Upstream may have fixed the
    # regression; nobody has checked. Warn rather than block.
    message(WARNING
        "libuv ${NOSPOON_UV_VERSION} is newer than the validated 1.51.x and has "
        "not been checked against the UDP POLLERR regression (libuv #4902). "
        "Verify on a real NAT/mobile path before shipping.")
endif()
# <<< libuv-version-guard

target_link_libraries(nospoon PRIVATE
    hyperdht::hyperdht
    hyperdht::udx
    ${SODIUM_TARGET}
    ${UV_TARGET})

if(WIN32)
    # Winsock + IP-helper (used by hyperdht and the full-tunnel module).
    target_link_libraries(nospoon PRIVATE Ws2_32 Iphlpapi)
endif()

# === Install ===
# Lets `cmake --install build --prefix $out` ship the binary into a Nix
# (or Linux distro) output directory. The runtime needs libhyperdht.so on
# the dynamic-linker search path; the Nix wrapper handles that via
# rpath / autoPatchelfHook.
include(GNUInstallDirs)
install(TARGETS nospoon
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})

# Windows: ship wintun.dll alongside nospoon.exe. tun_windows.cpp loads
# it at runtime via LoadLibraryW; without this the binary can't open a
# TUN device. Same DLL we ship for the JS impl under js/bin/win32-*.
if(WIN32)
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "ARM64|aarch64")
        set(_WINTUN_ARCH "win32-arm64")
    else()
        set(_WINTUN_ARCH "win32-x64")
    endif()
    install(FILES
        "${CMAKE_CURRENT_SOURCE_DIR}/bin/${_WINTUN_ARCH}/wintun.dll"
        "${CMAKE_CURRENT_SOURCE_DIR}/bin/${_WINTUN_ARCH}/LICENSE.txt"
        DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()
