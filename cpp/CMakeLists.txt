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
# Consumed via the CMake config package that hyperdht-cpp installs as
# `hyperdht-config.cmake` under <prefix>/lib/cmake/hyperdht/. Pass
# -DCMAKE_PREFIX_PATH=<install-prefix> if it's not on a standard path.
find_package(hyperdht CONFIG REQUIRED)

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
