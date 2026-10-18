cmake_minimum_required(VERSION 3.21)

project(MagmaLauncher CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ============================================================
# BUILD TYPE
# ============================================================

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

# CEF must be added exactly ONCE.
add_subdirectory(
    "${CEF_ROOT}"
    "${CMAKE_CURRENT_BINARY_DIR}/cef"
)

# ============================================================
# DEPENDENCIES
# ============================================================

find_package(CURL REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(ZLIB REQUIRED)

# ============================================================
# MAGMA LAUNCHER
# ============================================================

add_executable(MagmaLauncher WIN32
    main.cpp
    launcher_core.cpp
)

# ============================================================
# WINDOWS UTF-8 MANIFEST
# ============================================================

if(WIN32 AND MSVC)
    set(MAGMA_APP_MANIFEST
        "${CMAKE_CURRENT_SOURCE_DIR}/../app.manifest"
    )

    if(NOT EXISTS "${MAGMA_APP_MANIFEST}")
        message(FATAL_ERROR
            "UTF-8 manifest not found: ${MAGMA_APP_MANIFEST}"
        )
    endif()

    target_link_options(MagmaLauncher PRIVATE
        "/MANIFEST:EMBED"
        "/MANIFESTINPUT:${MAGMA_APP_MANIFEST}"
    )
endif()

set_source_files_properties(app.rc PROPERTIES
    OBJECT_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/../assets/magmalauncher.ico")

set_property(
    TARGET MagmaLauncher
    PROPERTY MSVC_RUNTIME_LIBRARY
    "MultiThreaded$<$<CONFIG:Debug>:Debug>"
)
# ============================================================
# INCLUDE DIRECTORIES
# ============================================================

target_include_directories(MagmaLauncher PRIVATE
    "${CEF_ROOT}"
)

# ============================================================
# LIBRARIES
# ============================================================

target_link_libraries(MagmaLauncher PRIVATE

    libcef_dll_wrapper

    "$<$<CONFIG:Debug>:${CEF_ROOT}/Debug/libcef.lib>"
    "$<$<CONFIG:Release>:${CEF_ROOT}/Release/libcef.lib>"

    CURL::libcurl
    nlohmann_json::nlohmann_json
    ZLIB::ZLIB

    ws2_32
    shell32
    ole32
)

# ============================================================
# CEF FILES
# ============================================================

COPY_FILES(
    "MagmaLauncher"
    "${CEF_BINARY_FILES}"
    "${CEF_BINARY_DIR}"
    "$<TARGET_FILE_DIR:MagmaLauncher>"
)

COPY_FILES(
    "MagmaLauncher"
    "${CEF_RESOURCE_FILES}"
    "${CEF_RESOURCE_DIR}"
    "$<TARGET_FILE_DIR:MagmaLauncher>"
)

# ============================================================
# FRONTEND / ASSETS
# ============================================================

target_compile_definitions(MagmaLauncher PRIVATE
    NOMINMAX
    WIN32_LEAN_AND_MEAN
    PROJECT_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../frontend"
)

add_custom_command(
    TARGET MagmaLauncher
    POST_BUILD

    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/../frontend"
        "$<TARGET_FILE_DIR:MagmaLauncher>/frontend"

    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/../assets"
        "$<TARGET_FILE_DIR:MagmaLauncher>/assets"

    VERBATIM
)

# ============================================================
# DISABLE CEF DEMO TARGETS
# ============================================================

foreach(_cef_demo_target
    cefsimple
    cefsimple_capi
    cefclient
    ceftests
    libcef_dll_wrapper_capi
)

    if(TARGET ${_cef_demo_target})

        set_target_properties(
            ${_cef_demo_target}
            PROPERTIES
            EXCLUDE_FROM_ALL TRUE
        )

    endif()

endforeach()

# ============================================================
# CEF RUNTIME
# ============================================================

set(CEF_RUNTIME_DIR
    "${CEF_ROOT}/$<CONFIG>"
)

set(CEF_RESOURCES_DIR
    "${CEF_ROOT}/Resources"
)

add_custom_command(
    TARGET MagmaLauncher
    POST_BUILD

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

# ============================================================
# CEF RESOURCES
# ============================================================

if(EXISTS "${CEF_RESOURCES_DIR}")

    add_custom_command(
        TARGET MagmaLauncher
        POST_BUILD

        COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CEF_RESOURCES_DIR}"
            "$<TARGET_FILE_DIR:MagmaLauncher>"

        VERBATIM
    )

endif()

# ============================================================
# DISTRIBUTION
# ============================================================

set(MAGMA_DIST_DIR
    "${CMAKE_CURRENT_BINARY_DIR}/dist"
)

add_custom_command(
    TARGET MagmaLauncher
    POST_BUILD

    COMMAND ${CMAKE_COMMAND} -E make_directory
        "${MAGMA_DIST_DIR}"

    COMMAND ${CMAKE_COMMAND} -E copy
        "$<TARGET_FILE:MagmaLauncher>"
        "${MAGMA_DIST_DIR}/MagmaLauncher.exe"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/libcef.dll"
        "${MAGMA_DIST_DIR}/libcef.dll"

    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_BINARY_DIR}/frontend"
        "${MAGMA_DIST_DIR}/frontend"

    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_BINARY_DIR}/assets"
        "${MAGMA_DIST_DIR}/assets"

    COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${CMAKE_CURRENT_BINARY_DIR}/locales"
        "${MAGMA_DIST_DIR}/locales"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/chrome_100_percent.pak"
        "${MAGMA_DIST_DIR}/chrome_100_percent.pak"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/chrome_200_percent.pak"
        "${MAGMA_DIST_DIR}/chrome_200_percent.pak"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/chrome_elf.dll"
        "${MAGMA_DIST_DIR}/chrome_elf.dll"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/d3dcompiler_47.dll"
        "${MAGMA_DIST_DIR}/d3dcompiler_47.dll"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/dxcompiler.dll"
        "${MAGMA_DIST_DIR}/dxcompiler.dll"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/dxil.dll"
        "${MAGMA_DIST_DIR}/dxil.dll"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/icudtl.dat"
        "${MAGMA_DIST_DIR}/icudtl.dat"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/libcurl.dll"
        "${MAGMA_DIST_DIR}/libcurl.dll"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/libEGL.dll"
        "${MAGMA_DIST_DIR}/libEGL.dll"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/libGLESv2.dll"
        "${MAGMA_DIST_DIR}/libGLESv2.dll"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/resources.pak"
        "${MAGMA_DIST_DIR}/resources.pak"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/v8_context_snapshot.bin"
        "${MAGMA_DIST_DIR}/v8_context_snapshot.bin"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/vk_swiftshader.dll"
        "${MAGMA_DIST_DIR}/vk_swiftshader.dll"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/vk_swiftshader_icd.json"
        "${MAGMA_DIST_DIR}/vk_swiftshader_icd.json"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/vulkan-1.dll"
        "${MAGMA_DIST_DIR}/vulkan-1.dll"

    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/z.dll"
        "${MAGMA_DIST_DIR}/z.dll"

    VERBATIM
)

# ============================================================
# END
# ============================================================

message(STATUS "")
message(STATUS "========================================")
message(STATUS " Magma Launcher")
message(STATUS "========================================")
message(STATUS " Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS " C++ standard: C++${CMAKE_CXX_STANDARD}")
message(STATUS " CEF: ${CEF_ROOT}")
message(STATUS "========================================")
message(STATUS "")
