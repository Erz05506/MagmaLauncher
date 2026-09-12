cmake_minimum_required(VERSION 3.21)

project(MagmaLauncher CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Release is the normal runtime configuration for the launcher.
# Debug builds are useful for diagnosing native crashes, but CEF/Chromium
# itself is substantially heavier in Debug.
if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# ============================================================
# CEF
# ============================================================

set(CEF_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/cef")

if(NOT EXISTS "${CEF_ROOT}/CMakeLists.txt")
    message(FATAL_ERROR
        "CEF not found!\n"
        "Expected CEF at: ${CEF_ROOT}\n"
    )
endif()

# CEF's CMake configuration
set(USE_SANDBOX OFF)
add_subdirectory("${CEF_ROOT}" "${CMAKE_CURRENT_BINARY_DIR}/cef")

# ============================================================
# Other dependencies
# ============================================================

find_package(CURL REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(ZLIB REQUIRED)

# ============================================================
# Magma Launcher
# ============================================================

add_executable(MagmaLauncher WIN32
    main.cpp
    launcher_core.cpp
)

set_property(TARGET MagmaLauncher PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# ============================================================
# Include directories
# ============================================================

target_include_directories(MagmaLauncher PRIVATE
    "${CEF_ROOT}"
)

# ============================================================
# Libraries
# ============================================================

target_link_libraries(MagmaLauncher PRIVATE
    libcef_dll_wrapper
    "$<$<CONFIG:Debug>:${CEF_ROOT}/Debug/libcef.lib>$<$<CONFIG:Release>:${CEF_ROOT}/Release/libcef.lib>"

    CURL::libcurl
    nlohmann_json::nlohmann_json
    ZLIB::ZLIB

    ws2_32
    shell32
    ole32
)

COPY_FILES("MagmaLauncher" "${CEF_BINARY_FILES}" "${CEF_BINARY_DIR}" "$<TARGET_FILE_DIR:MagmaLauncher>")
COPY_FILES("MagmaLauncher" "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "$<TARGET_FILE_DIR:MagmaLauncher>")

# ============================================================
# Frontend
# ============================================================

target_compile_definitions(MagmaLauncher PRIVATE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
    PROJECT_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../frontend"
)
foreach(_cef_demo_target
    cefsimple
    cefsimple_capi
    cefclient
    ceftests
    libcef_dll_wrapper_capi
)
    if(TARGET ${_cef_demo_target})
        set_target_properties(${_cef_demo_target} PROPERTIES EXCLUDE_FROM_ALL TRUE)
    endif()
endforeach()

set(CEF_RUNTIME_DIR "${CEF_ROOT}/$<CONFIG>")
set(CEF_RESOURCES_DIR "${CEF_ROOT}/Resources")

add_custom_command(TARGET MagmaLauncher POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CEF_RUNTIME_DIR}/libcef.dll"
        "${CEF_RUNTIME_DIR}/chrome_elf.dll"
        "${CEF_RUNTIME_DIR}/d3dcompiler_47.dll"
        "${CEF_RUNTIME_DIR}/dxcompiler.dll"
        "${CEF_RUNTIME_DIR}/dxil.dll"
        "${CEF_RUNTIME_DIR}/libEGL.dll"
        "${CEF_RUNTIME_DIR}/libGLESv2.dll"
        "${CEF_RUNTIME_DIR}/vk_swiftshader.dll"
        "${CEF_RUNTIME_DIR}/vulkan-1.dll"
        "${CEF_RUNTIME_DIR}/vk_swiftshader_icd.json"
        "${CEF_RUNTIME_DIR}/v8_context_snapshot.bin"
        "$<TARGET_FILE_DIR:MagmaLauncher>"
    COMMAND_EXPAND_LISTS
    VERBATIM
)

if(EXISTS "${CEF_RESOURCES_DIR}")
    add_custom_command(TARGET MagmaLauncher POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CEF_RESOURCES_DIR}"
            "$<TARGET_FILE_DIR:MagmaLauncher>"
        VERBATIM
    )
endif()