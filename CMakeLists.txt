cmake_minimum_required(VERSION 3.31)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-bare-bundle REQUIRED PATHS node_modules/cmake-bare-bundle)
find_package(cmake-fetch REQUIRED PATHS node_modules/cmake-fetch)
find_package(cmake-napi REQUIRED PATHS node_modules/cmake-napi)
find_package(cmake-npm REQUIRED PATHS node_modules/cmake-npm)

project(nospoon C CXX)

bare_target(target)

if(target MATCHES "win32")
  find_program(NASM_FOUND nasm)
  if(NASM_FOUND)
    enable_language(ASM_NASM)
  endif()
else()
  enable_language(ASM)
endif()

# Fetch Bare runtime — clones repo, runs npm ci, builds libbare_static.
# Pin to a known-good version matching bare-nix.
fetch_package("github:holepunchto/bare@1.28.1")

# librlimit — for raising open file limits (used in main.c)
fetch_package("github:holepunchto/librlimit#6e4b390")

# Bundle JS entry point into a C header.
# BUILTINS lists addons that will be statically linked (excluded from bundle).
# LINKED tells bundler addons are linked, not loaded from filesystem.
add_bare_bundle(
  nospoon_bundle
  ENTRY bin/cli.js
  OUT bin/nospoon.bundle.h
  BUILTINS bin/builtins.json
  LINKED
)

# Build the nospoon standalone binary
add_executable(nospoon_bin
  bin/main.c
)

set_target_properties(
  nospoon_bin
  PROPERTIES
  OUTPUT_NAME nospoon
  C_STANDARD 11
  ENABLE_EXPORTS ON
  WINDOWS_EXPORT_ALL_SYMBOLS ON
)

# Link Bare runtime statically (includes V8, libuv, napi, core addons).
# WHOLE_ARCHIVE keeps __attribute__((constructor)) addon registration alive.
target_link_libraries(
  nospoon_bin
  PUBLIC
    $<LINK_LIBRARY:WHOLE_ARCHIVE,bare_static>
  PRIVATE
    rlimit_static
)

add_dependencies(nospoon_bin nospoon_bundle)

# --- Statically link native addons ---
# Core bare addons (bare-buffer, bare-os, bare-type, etc.) are already
# in bare_static. We only need to link addons NOT built into bare_static.

# HyperDHT deps
link_bare_module(nospoon_bin sodium-native)
link_bare_module(nospoon_bin udx-native)

# bare-fs — needed by compat.js and config.js
link_bare_module(nospoon_bin bare-fs)

# Our TUN addon — lives in native/, not node_modules.
# link_bare_module needs it discoverable via resolve_node_module,
# so we use add_subdirectory + manual static linking.
add_subdirectory(native)

# Use the same target name that add_bare_module() created inside native/
bare_module_target(
  "${CMAKE_CURRENT_SOURCE_DIR}/native"
  nospoon_tun_target
  NAME nospoon_tun_name
  VERSION nospoon_tun_version
  HASH nospoon_tun_hash
)

# Enable constructor-based self-registration for static linking
target_compile_definitions(
  ${nospoon_tun_target}
  PRIVATE
    BARE_MODULE_REGISTER_CONSTRUCTOR
    BARE_MODULE_CONSTRUCTOR_VERSION=${nospoon_tun_hash}
)

# Link only the object files into the binary (not the shared lib targets)
target_link_libraries(
  nospoon_bin
  PRIVATE
    $<TARGET_OBJECTS:${nospoon_tun_target}>
)

if(TARGET c++)
  target_link_libraries(nospoon_bin PRIVATE c++)
endif()

install(TARGETS nospoon_bin)
