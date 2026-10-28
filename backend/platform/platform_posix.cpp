#include "platform.h"

#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <thread>

#include <fcntl.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

namespace platform {

void sleepMs(unsigned int milliseconds) {
    std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
}

bool commandExists(const std::string& name) {
    const char* pathEnv = std::getenv("PATH");
    if (!pathEnv) return false;
    std::stringstream ss(pathEnv);
    std::string dir;
    while (std::getline(ss, dir, ':')) {
        if (dir.empty()) continue;
        std::filesystem::path candidate = std::filesystem::path(dir) / name;
        if (access(candidate.c_str(), X_OK) == 0) return true;
    }
    return false;
}

unsigned long spawnDetached(
    const std::vector<std::string>& args,
    const std::filesystem::path& workingDirectory,
    const std::filesystem::path& logFile
) {
    if (args.empty() || args[0].empty()) return 0;

    std::vector<char*> argv;
    for (const auto& a : args) argv.push_back(const_cast<char*>(a.c_str()));
    argv.push_back(nullptr);

    std::string logPath;
    if (!logFile.empty()) {
        std::error_code ec;
        std::filesystem::create_directories(logFile.parent_path(), ec);
        logPath = logFile.string();
    }
    std::string cwd = workingDirectory.string();

    int errPipe[2];
    if (pipe(errPipe) != 0) return 0;
    fcntl(errPipe[0], F_SETFD, FD_CLOEXEC);
    fcntl(errPipe[1], F_SETFD, FD_CLOEXEC);

    pid_t pid = fork();
    if (pid < 0) {
        close(errPipe[0]);
        close(errPipe[1]);
        return 0;
    }

    if (pid == 0) {
        setsid();
        if (!cwd.empty() && chdir(cwd.c_str()) != 0) {
            int e = errno;
            (void)!write(errPipe[1], &e, sizeof(e));
            _exit(126);
        }
        int out = logPath.empty()
            ? open("/dev/null", O_WRONLY)
            : open(logPath.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (out >= 0) { dup2(out, 1); dup2(out, 2); if (out > 2) close(out); }
        int in = open("/dev/null", O_RDONLY);
        if (in >= 0) { dup2(in, 0); if (in > 2) close(in); }
        execvp(argv[0], argv.data());
        int e = errno;
        (void)!write(errPipe[1], &e, sizeof(e));
        _exit(127);
    }

    close(errPipe[1]);
    int childErrno = 0;
    ssize_t n;
    do { n = read(errPipe[0], &childErrno, sizeof(childErrno)); } while (n < 0 && errno == EINTR);
    close(errPipe[0]);

    if (n > 0) {           
        int st = 0;
        waitpid(pid, &st, 0);
        return 0;
    }
    return static_cast<unsigned long>(pid);
}

void waitProcessExit(unsigned long pid) {
    for (;;) {
        int status = 0;
        pid_t r = waitpid(static_cast<pid_t>(pid), &status, 0);
        if (r == static_cast<pid_t>(pid)) return;
        if (r < 0 && errno == EINTR) continue;
        while (kill(static_cast<pid_t>(pid), 0) == 0 || errno == EPERM) sleepMs(500);
        return;
    }
}

bool runAndCapture(const std::vector<std::string>& args, std::string& output, unsigned int timeoutMs) {
    output.clear();
    if (args.empty()) return false;

    std::error_code ec;
    auto tmp = std::filesystem::temp_directory_path(ec);
    if (ec) tmp = "/tmp";
    static std::atomic<unsigned> counter{0};
    auto logFile = tmp / ("magma_capture_" + std::to_string(getpid()) + "_" +
                          std::to_string(counter++) + ".txt");

    ProcessResult r = runProcess(args, {}, logFile, timeoutMs);

    {
        std::ifstream in(logFile, std::ios::binary);
        std::stringstream ss;
        ss << in.rdbuf();
        output = ss.str();
    }
    std::filesystem::remove(logFile, ec);

    return r.started && !r.timedOut && !r.cancelled && r.exitCode == 0;
}

} // namespace platform