
#include "platform.h"

#include <windows.h>
#include <shellapi.h>

#include <chrono>
#include <cstdlib>
#include <thread>
#include <vector>

namespace platform {

std::filesystem::path executableDir() {
    std::vector<wchar_t> buffer(32768);

    DWORD length = GetModuleFileNameW(
        nullptr,
        buffer.data(),
        static_cast<DWORD>(buffer.size())
    );

    if (length == 0 || length >= buffer.size()) {
        return std::filesystem::current_path();
    }

    return std::filesystem::path(
        std::wstring(buffer.data(), length)
    ).parent_path();
}

std::filesystem::path resourceDir() {
    return executableDir();
}

std::filesystem::path defaultGameDir() {
    const wchar_t* roaming = _wgetenv(L"APPDATA");
    std::filesystem::path base = (roaming && *roaming)
        ? std::filesystem::path(roaming)
        : executableDir();
    return base / L"MagmaLauncher";
}

std::filesystem::path userDataDir() {
    const wchar_t* appData = _wgetenv(L"LOCALAPPDATA");

    std::filesystem::path base;

    if (appData && *appData) {
        base = appData;
    } else {
        base = executableDir();
    }

    auto dir = base / L"MagmaLauncher";

    std::error_code ec;
    std::filesystem::create_directories(dir, ec);

    return dir;
}

bool openUrl(const std::string& url) {
    if (url.empty()) {
        return false;
    }

    auto result = reinterpret_cast<INT_PTR>(
        ShellExecuteA(
            nullptr,
            "open",
            url.c_str(),
            nullptr,
            nullptr,
            SW_SHOWNORMAL
        )
    );

    return result > 32;
}

void showError(
    const std::string& title,
    const std::string& message
) {
    MessageBoxA(
        nullptr,
        message.c_str(),
        title.c_str(),
        MB_OK | MB_ICONERROR
    );
}

void sleepMs(unsigned int milliseconds) {
    std::this_thread::sleep_for(
        std::chrono::milliseconds(milliseconds)
    );
}

} // namespace platform
