#pragma once

#include <atomic>
#include <filesystem>
#include <string>
#include <vector>
#include <cstdint>

namespace platform {

#if defined(_WIN32)
inline constexpr const char* kOsName = "windows";
inline constexpr const char* kPathListSep = ";";
#elif defined(__APPLE__)
inline constexpr const char* kOsName = "osx";
inline constexpr const char* kPathListSep = ":";
#else
inline constexpr const char* kOsName = "linux";
inline constexpr const char* kPathListSep = ":";
#endif

#if defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)
inline constexpr const char* kOsArch = "arm64";
#else
inline constexpr const char* kOsArch = "x86_64";
#endif

std::filesystem::path executableDir();
std::filesystem::path resourceDir();     
std::filesystem::path userDataDir();
std::filesystem::path defaultGameDir();

bool openUrl(const std::string& url);
void showError(const std::string& title, const std::string& message);
void sleepMs(unsigned int milliseconds);

struct ProcessResult {
    bool started = false;
    bool timedOut = false;
    bool cancelled = false;
    int exitCode = -1;
    std::string error;
};

ProcessResult runProcess(
    const std::vector<std::string>& arguments,
    const std::filesystem::path& workingDirectory,
    const std::filesystem::path& logFile,
    unsigned int timeoutMs = 120000,
    const std::atomic<bool>* cancelFlag = nullptr
);

#ifndef _WIN32
unsigned long spawnDetached(
    const std::vector<std::string>& arguments,
    const std::filesystem::path& workingDirectory,
    const std::filesystem::path& logFile
);
void waitProcessExit(unsigned long pid);
bool commandExists(const std::string& name);
bool runAndCapture(const std::vector<std::string>& arguments, std::string& output,
                   unsigned int timeoutMs = 600000);

bool pickFolder(const std::filesystem::path& initialDir, std::filesystem::path& out);
bool pickFile(const std::filesystem::path& initialDir, std::filesystem::path& out);

inline std::string lastNonEmptyLine(const std::string& text) {
    std::string last, cur;
    auto flush = [&]() {
        size_t b = cur.find_first_not_of(" \t\r");
        size_t e = cur.find_last_not_of(" \t\r");
        if (b != std::string::npos) last = cur.substr(b, e - b + 1);
        cur.clear();
    };
    for (char c : text) { if (c == '\n') flush(); else cur += c; }
    flush();
    return last;
}
#endif

#if defined(__APPLE__)
void macInitApplication();
#endif

#if defined(__linux__)
struct IconImage {
    int width = 0, height = 0;
    std::vector<uint32_t> argb;  
};

bool applyX11WindowIdentity(unsigned long xwindow,
                            const std::vector<IconImage>& icons,
                            const std::string& wmClass,
                            const std::string& desktopFileId);

void guardX11WindowIdentity(unsigned long xwindow,
                            const std::vector<IconImage>& icons,
                            const std::string& wmClass,
                            const std::string& desktopFileId);

#endif
}