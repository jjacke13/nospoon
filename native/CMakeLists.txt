cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS ../node_modules/cmake-bare)
find_package(cmake-napi REQUIRED PATHS ../node_modules/cmake-napi)

project(nospoon_tun C)

bare_target(target)

# Sources — platform files are empty behind #ifdef on wrong platform
set(sources
  binding.c
  tun-linux.c
  tun-darwin.c
  tun-windows.c
)

# Bare module → nospoon-tun.bare
add_bare_module(nospoon_tun_bare)
target_sources(${nospoon_tun_bare} PRIVATE ${sources})

# Node.js N-API module → nospoon-tun.node
add_napi_module(nospoon_tun_node)
target_sources(${nospoon_tun_node} PRIVATE ${sources})
target_compile_definitions(${nospoon_tun_node} PRIVATE NAPI_VERSION=9)

resolve_node_module(bare-compat-napi compat WORKING_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/..")
target_include_directories(${nospoon_tun_node} PRIVATE "${compat}/include")
