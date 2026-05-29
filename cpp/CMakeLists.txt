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

if(NOSPOON_FETCH_HYPERDHT)
    include(FetchContent)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(HYPERDHT_EXPORT_CXX ON CACHE BOOL "" FORCE)
    set(HYPERDHT_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(hyperdht
        GIT_REPOSITORY https://github.com/jjacke13/hyperdht-cpp.git
        GIT_TAG 452e7ab390ae95ffa547b104a3aa275b7360eb3c
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
