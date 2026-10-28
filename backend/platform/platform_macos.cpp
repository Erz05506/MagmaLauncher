#include "platform.h"

#include <climits>
#include <cstdlib>
#include <mach-o/dyld.h>
#include <pwd.h>
#include <unistd.h>

namespace platform {

namespace {
std::filesystem::path homeDir() {
    const char* home = std::getenv("HOME");
    if (home && *home) return home;
    if (passwd* pw = getpwuid(getuid())) return pw->pw_dir;
    return "/tmp";
}

std::string appleScriptEscape(const std::string& s) {
    std::string r;
    for (char c : s) {
        if (c == '\\' || c == '"') r += '\\';
        r += c;
    }
    return r;
}

std::string trimTrailingSlash(std::string p) {
    while (p.size() > 1 && p.back() == '/') p.pop_back();
    return p;
}
}

std::filesystem::path executableDir() {
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::string buf(size, '\0');
    if (_NSGetExecutablePath(buf.data(), &size) != 0) return std::filesystem::current_path();
    std::error_code ec;
    auto p = std::filesystem::weakly_canonical(std::filesystem::path(buf.c_str()), ec);
    if (ec) p = std::filesystem::path(buf.c_str());
    return p.parent_path();       // .../MagmaLauncher.app/Contents/MacOS
}

std::filesystem::path resourceDir() {
    auto exe = executableDir();
    auto res = exe.parent_path() / "Resources";
    std::error_code ec;
    if (std::filesystem::exists(res / "frontend", ec)) return res;
    return exe;                   // запуск из папки сборки без .app
}

std::filesystem::path userDataDir() {
    auto dir = homeDir() / "Library" / "Application Support" / "MagmaLauncher";
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    return dir;
}

std::filesystem::path defaultGameDir() {
    return userDataDir();
}

bool openUrl(const std::string& url) {
    if (url.empty()) return false;
    return spawnDetached({"/usr/bin/open", url}, {}, {}) != 0;
}

void showError(const std::string& title, const std::string& message) {
    std::string script = "display dialog \"" + appleScriptEscape(message) +
        "\" with title \"" + appleScriptEscape(title) +
        "\" buttons {\"OK\"} default button \"OK\" with icon stop";
    std::string out;
    runAndCapture({"/usr/bin/osascript", "-e", script}, out);
}

static bool pickWithAppleScript(const char* chooser, const std::filesystem::path& initialDir,
                                std::filesystem::path& out) {
    std::string script = std::string("POSIX path of (") + chooser + " with prompt \"MagmaLauncher\"";
    std::error_code ec;
    if (!initialDir.empty() && std::filesystem::exists(initialDir, ec)) {
        script += " default location POSIX file \"" + appleScriptEscape(initialDir.string()) + "\"";
    }
    script += ")";

    std::string output;
    if (!runAndCapture({"/usr/bin/osascript", "-e", script}, output)) return false;
    std::string line = lastNonEmptyLine(output);
    if (line.empty()) return false;
    out = trimTrailingSlash(line);
    return true;
}

bool pickFolder(const std::filesystem::path& initialDir, std::filesystem::path& out) {
    return pickWithAppleScript("choose folder", initialDir, out);
}

bool pickFile(const std::filesystem::path& initialDir, std::filesystem::path& out) {
    return pickWithAppleScript("choose file", initialDir, out);
}

} // namespace platform