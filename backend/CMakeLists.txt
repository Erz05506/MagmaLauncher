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

# Platform-specific CEF distribution.
# Keep the existing Windows directory unchanged.
if(WIN32)
    set(CEF_DEFAULT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/cef")
elseif(APPLE)
    set(CEF_DEFAULT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/cef-macos")
elseif(UNIX)
    set(CEF_DEFAULT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/cef-linux")
endif()

set(CEF_ROOT "${CEF_DEFAULT_ROOT}" CACHE PATH
    "Path to the CEF distribution for the target platform")

message(STATUS "Target OS: ${CMAKE_SYSTEM_NAME}")
message(STATUS "CEF root: ${CEF_ROOT}")

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

if(WIN32)
    set(MAGMA_PLATFORM_SOURCE
        platform/platform_windows.cpp
    )
elseif(APPLE)
    set(MAGMA_PLATFORM_SOURCE
        platform/platform_macos.cpp
    )
elseif(UNIX)
    set(MAGMA_PLATFORM_SOURCE
        platform/platform_linux.cpp
        platform/platform_x11.cpp
    )
    find_package(X11 REQUIRED)
else()
    message(FATAL_ERROR "Unsupported operating system")
endif()

if(NOT WIN32)
    set(MAGMA_PLATFORM_COMMON platform/platform_posix.cpp)
endif()

add_executable(MagmaLauncher
    main.cpp
    launcher_core.cpp
    platform/platform_process.cpp
    ${MAGMA_PLATFORM_COMMON}
    ${MAGMA_PLATFORM_SOURCE}
)

if(WIN32)
    set_target_properties(MagmaLauncher PROPERTIES
        WIN32_EXECUTABLE TRUE
        MSVC_RUNTIME_LIBRARY
        "MultiThreaded$<$<CONFIG:Debug>:Debug>"
    )
endif()

target_include_directories(MagmaLauncher PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/platform"
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
    CURL::libcurl
    nlohmann_json::nlohmann_json
    ZLIB::ZLIB
)

if(WIN32)
    target_link_libraries(MagmaLauncher PRIVATE
        "$<$<CONFIG:Debug>:${CEF_ROOT}/Debug/libcef.lib>"
        "$<$<CONFIG:Release>:${CEF_ROOT}/Release/libcef.lib>"
        ws2_32
        shell32
        ole32
    )
endif()

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

if(WIN32)
    set(CEF_RUNTIME_DIR "${CEF_ROOT}/$<CONFIG>")
    set(CEF_RESOURCES_DIR "${CEF_ROOT}/Resources")

    add_custom_command(
        TARGET MagmaLauncher
        POST_BUILD

        COMMAND "${CMAKE_COMMAND}" -E copy_if_different
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
        add_custom_command(
            TARGET MagmaLauncher
            POST_BUILD

            COMMAND "${CMAKE_COMMAND}" -E copy_directory
                "${CEF_RESOURCES_DIR}"
                "$<TARGET_FILE_DIR:MagmaLauncher>"

            VERBATIM
        )
    endif()
endif()

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

set(MAGMA_DIST_DIR "${CMAKE_CURRENT_BINARY_DIR}/dist")
file(MAKE_DIRECTORY "${MAGMA_DIST_DIR}")

if(UNIX AND NOT APPLE)
target_link_libraries(MagmaLauncher PRIVATE X11::X11)
    target_link_libraries(MagmaLauncher PRIVATE
        "${CEF_ROOT}/Release/libcef.so" pthread dl)
    set_target_properties(MagmaLauncher PROPERTIES
        BUILD_RPATH "\$ORIGIN"
        INSTALL_RPATH "\$ORIGIN")
    COPY_FILES("MagmaLauncher" "${CEF_BINARY_FILES}" "${CEF_BINARY_DIR}" "${MAGMA_DIST_DIR}")
    COPY_FILES("MagmaLauncher" "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "${MAGMA_DIST_DIR}")
endif()

if(WIN32)
    set(MAGMA_DIST_EXECUTABLE "MagmaLauncher.exe")
else()
    set(MAGMA_DIST_EXECUTABLE "MagmaLauncher")
endif()

add_custom_command(
    TARGET MagmaLauncher
    POST_BUILD

    COMMAND "${CMAKE_COMMAND}" -E make_directory
        "${MAGMA_DIST_DIR}"

    COMMAND "${CMAKE_COMMAND}" -E copy
        "$<TARGET_FILE:MagmaLauncher>"
        "${MAGMA_DIST_DIR}/${MAGMA_DIST_EXECUTABLE}"

    COMMAND "${CMAKE_COMMAND}" -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/../frontend"
        "${MAGMA_DIST_DIR}/frontend"

    COMMAND "${CMAKE_COMMAND}" -E copy_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/../assets"
        "${MAGMA_DIST_DIR}/assets"

    VERBATIM
)

if(WIN32)
    add_custom_command(
        TARGET MagmaLauncher
        POST_BUILD

        COMMAND "${CMAKE_COMMAND}" -E copy_if_different
            "${CMAKE_CURRENT_BINARY_DIR}/libcef.dll"
            "${MAGMA_DIST_DIR}/libcef.dll"

        COMMAND "${CMAKE_COMMAND}" -E copy_directory
            "${CMAKE_CURRENT_BINARY_DIR}/locales"
            "${MAGMA_DIST_DIR}/locales"

        VERBATIM
    )
endif()


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
