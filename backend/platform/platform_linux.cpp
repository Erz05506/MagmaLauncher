#include "platform.h"

#include <climits>
#include <cstdio>
#include <cstdlib>
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
}

std::filesystem::path executableDir() {
    char buf[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (n <= 0) return std::filesystem::current_path();
    buf[n] = '\0';
    return std::filesystem::path(buf).parent_path();
}

std::filesystem::path resourceDir() {
    return executableDir();
}

std::filesystem::path userDataDir() {
    const char* xdg = std::getenv("XDG_DATA_HOME");
    std::filesystem::path base = (xdg && *xdg) ? std::filesystem::path(xdg)
                                               : homeDir() / ".local" / "share";
    auto dir = base / "MagmaLauncher";
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    return dir;
}

std::filesystem::path defaultGameDir() {
    return userDataDir();
}

bool openUrl(const std::string& url) {
    if (url.empty()) return false;
    return spawnDetached({"xdg-open", url}, {}, {}) != 0;
}

void showError(const std::string& title, const std::string& message) {
    std::string out;
    if (commandExists("zenity")) {
        runAndCapture({"zenity", "--error", "--no-markup", "--title", title, "--text", message}, out);
    } else if (commandExists("kdialog")) {
        runAndCapture({"kdialog", "--title", title, "--error", message}, out);
    } else {
        std::fprintf(stderr, "[%s] %s\n", title.c_str(), message.c_str());
    }
}

bool pickFolder(const std::filesystem::path& initialDir, std::filesystem::path& out) {
    std::string output;
    std::string initial = initialDir.string();
    bool ok = false;

    if (commandExists("zenity")) {
        std::vector<std::string> a{"zenity", "--file-selection", "--directory", "--title=MagmaLauncher"};
        if (!initial.empty()) a.push_back("--filename=" + initial + "/");
        ok = runAndCapture(a, output);
    } else if (commandExists("kdialog")) {
        ok = runAndCapture({"kdialog", "--getexistingdirectory", initial.empty() ? "." : initial}, output);
    }

    std::string line = lastNonEmptyLine(output);
    if (!ok || line.empty()) return false;
    out = line;
    return true;
}

bool pickFile(const std::filesystem::path& initialDir, std::filesystem::path& out) {
    std::string output;
    std::string initial = initialDir.string();
    bool ok = false;

    if (commandExists("zenity")) {
        std::vector<std::string> a{"zenity", "--file-selection", "--title=MagmaLauncher"};
        if (!initial.empty()) a.push_back("--filename=" + initial + "/");
        ok = runAndCapture(a, output);
    } else if (commandExists("kdialog")) {
        ok = runAndCapture({"kdialog", "--getopenfilename", initial.empty() ? "." : initial}, output);
    }

    std::string line = lastNonEmptyLine(output);
    if (!ok || line.empty()) return false;
    out = line;
    return true;
}

} // namespace platform