
#include "platform.h"

#include <chrono>
#include <thread>
#include <system_error>
#include <cerrno>
#include <cstring>
#include <exception>
#include <filesystem>
#include <string>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace platform {

#ifdef _WIN32

static std::wstring utf8ToWide(const std::string& value) {
    if (value.empty()) {
        return {};
    }

    int size = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS,
        value.data(), static_cast<int>(value.size()),
        nullptr, 0
    );

    UINT codePage = CP_UTF8;
    DWORD flags = MB_ERR_INVALID_CHARS;

    if (size == 0) {
        codePage = CP_ACP;
        flags = 0;

        size = MultiByteToWideChar(
            codePage, flags,
            value.data(), static_cast<int>(value.size()),
            nullptr, 0
        );
    }

    if (size == 0) {
        return std::filesystem::path(value).wstring();
    }

    std::wstring result(static_cast<size_t>(size), L'\0');

    MultiByteToWideChar(
        codePage, flags,
        value.data(), static_cast<int>(value.size()),
        result.data(), size
    );

    return result;
}

static std::wstring quoteWindowsArgument(const std::wstring& arg) {
    std::wstring result = L"\"";
    size_t backslashes = 0;

    for (wchar_t c : arg) {
        if (c == L'\\') {
            ++backslashes;
        } else if (c == L'"') {
            result.append(backslashes * 2 + 1, L'\\');
            result += L'"';
            backslashes = 0;
        } else {
            result.append(backslashes, L'\\');
            backslashes = 0;
            result += c;
        }
    }

    result.append(backslashes * 2, L'\\');
    result += L'"';

    return result;
}

ProcessResult runProcess(
    const std::vector<std::string>& arguments,
    const std::filesystem::path& workingDirectory,
    const std::filesystem::path& logFile,
    unsigned int timeoutMs,
    const std::atomic<bool>* cancelFlag
) {
    ProcessResult result;

    if (arguments.empty() || arguments[0].empty()) {
        result.error = "No executable specified";
        return result;
    }

    std::wstring executable = utf8ToWide(arguments[0]);
    std::wstring commandLine;

    for (const auto& arg : arguments) {
        if (!commandLine.empty()) {
            commandLine += L' ';
        }

        commandLine += quoteWindowsArgument(utf8ToWide(arg));
    }

    std::vector<wchar_t> commandBuffer(
        commandLine.begin(),
        commandLine.end()
    );
    commandBuffer.push_back(L'\0');

    HANDLE logHandle = INVALID_HANDLE_VALUE;

    try {
        if (!logFile.empty()) {
            const auto parent = logFile.parent_path();

            if (!parent.empty()) {
                std::filesystem::create_directories(parent);
            }

            logHandle = CreateFileW(
                logFile.c_str(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                nullptr,
                CREATE_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                nullptr
            );
        }
    } catch (const std::exception& e) {
        result.error = e.what();
        return result;
    }

    STARTUPINFOW startupInfo{};
    startupInfo.cb = sizeof(startupInfo);

    DWORD creationFlags = CREATE_NO_WINDOW;
    BOOL inheritHandles = FALSE;

    if (logHandle != INVALID_HANDLE_VALUE) {
        startupInfo.dwFlags |= STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        startupInfo.wShowWindow = SW_HIDE;
        startupInfo.hStdOutput = logHandle;
        startupInfo.hStdError = logHandle;
        startupInfo.hStdInput = CreateFileW(
            L"NUL",
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            nullptr
        );

        inheritHandles = TRUE;
    }

    PROCESS_INFORMATION processInfo{};

    std::wstring workingDir = workingDirectory.empty()
        ? std::wstring()
        : workingDirectory.wstring();

    BOOL created = CreateProcessW(
        executable.c_str(),
        commandBuffer.data(),
        nullptr,
        nullptr,
        inheritHandles,
        creationFlags,
        nullptr,
        workingDir.empty() ? nullptr : workingDir.c_str(),
        &startupInfo,
        &processInfo
    );

    if (startupInfo.hStdInput &&
        startupInfo.hStdInput != INVALID_HANDLE_VALUE &&
        logHandle != INVALID_HANDLE_VALUE) {
        CloseHandle(startupInfo.hStdInput);
    }

    if (logHandle != INVALID_HANDLE_VALUE) {
        CloseHandle(logHandle);
    }

    if (!created) {
        result.error = "CreateProcessW failed with code " +
            std::to_string(GetLastError());
        return result;
    }

    result.started = true;
    const auto start = std::chrono::steady_clock::now();

    for (;;) {
        DWORD waitResult = WaitForSingleObject(processInfo.hProcess, 50);

        if (waitResult == WAIT_OBJECT_0) {
            DWORD exitCode = 1;

            if (GetExitCodeProcess(processInfo.hProcess, &exitCode)) {
                result.exitCode = static_cast<int>(exitCode);
            } else {
                result.error = "GetExitCodeProcess failed with code " +
                    std::to_string(GetLastError());
            }

            break;
        }

        if (waitResult == WAIT_FAILED) {
            result.error = "WaitForSingleObject failed with code " +
                std::to_string(GetLastError());

            TerminateProcess(processInfo.hProcess, 1);
            WaitForSingleObject(processInfo.hProcess, 2000);
            break;
        }

        const bool cancelled = cancelFlag && cancelFlag->load();

        const bool timedOut = timeoutMs > 0 &&
            std::chrono::steady_clock::now() - start >=
                std::chrono::milliseconds(timeoutMs);

        if (cancelled || timedOut) {
            result.cancelled = cancelled;
            result.timedOut = timedOut && !cancelled;

            TerminateProcess(processInfo.hProcess, 1);
            WaitForSingleObject(processInfo.hProcess, 2000);

            DWORD exitCode = 1;
            if (GetExitCodeProcess(processInfo.hProcess, &exitCode)) {
                result.exitCode = static_cast<int>(exitCode);
            }

            break;
        }
    }

    CloseHandle(processInfo.hThread);
    CloseHandle(processInfo.hProcess);

    return result;
}

#else

ProcessResult runProcess(
    const std::vector<std::string>& arguments,
    const std::filesystem::path& workingDirectory,
    const std::filesystem::path& logFile,
    unsigned int timeoutMs,
    const std::atomic<bool>* cancelFlag
) {
    ProcessResult result;

    if (arguments.empty() || arguments[0].empty()) {
        result.error = "No executable specified";
        return result;
    }

    std::filesystem::path absoluteLog;

    try {
        if (!logFile.empty()) {
            absoluteLog = std::filesystem::absolute(logFile);

            const auto parent = absoluteLog.parent_path();
            if (!parent.empty()) {
                std::filesystem::create_directories(parent);
            }
        }
    } catch (const std::exception& e) {
        result.error = e.what();
        return result;
    }

    std::vector<char*> argv;
    argv.reserve(arguments.size() + 1);

    for (const auto& arg : arguments) {
        argv.push_back(const_cast<char*>(arg.c_str()));
    }

    argv.push_back(nullptr);

    pid_t pid = fork();

    if (pid < 0) {
        result.error = std::string("fork failed: ") + std::strerror(errno);
        return result;
    }

    if (pid == 0) {
        setpgid(0, 0);

        if (!workingDirectory.empty() &&
            chdir(workingDirectory.c_str()) != 0) {
            _exit(126);
        }

        if (!absoluteLog.empty()) {
            int logFd = open(
                absoluteLog.c_str(),
                O_WRONLY | O_CREAT | O_TRUNC,
                0644
            );

            if (logFd < 0) {
                _exit(126);
            }

            if (dup2(logFd, STDOUT_FILENO) < 0 ||
                dup2(logFd, STDERR_FILENO) < 0) {
                close(logFd);
                _exit(126);
            }

            close(logFd);
        } else {
            int nullFd = open("/dev/null", O_WRONLY);

            if (nullFd >= 0) {
                dup2(nullFd, STDOUT_FILENO);
                dup2(nullFd, STDERR_FILENO);
                close(nullFd);
            }
        }

        execvp(argv[0], argv.data());
        _exit(errno == ENOENT ? 127 : 126);
    }

    setpgid(pid, pid);
    result.started = true;

    const auto start = std::chrono::steady_clock::now();
    int status = 0;

    for (;;) {
        pid_t waitResult = waitpid(pid, &status, WNOHANG);

        if (waitResult == pid) {
            if (WIFEXITED(status)) {
                result.exitCode = WEXITSTATUS(status);
            } else if (WIFSIGNALED(status)) {
                result.exitCode = 128 + WTERMSIG(status);
            }

            break;
        }

        if (waitResult < 0) {
            if (errno == EINTR) {
                continue;
            }

            result.error = std::string("waitpid failed: ") +
                std::strerror(errno);
            break;
        }

        const bool cancelled = cancelFlag && cancelFlag->load();

        const bool timedOut = timeoutMs > 0 &&
            std::chrono::steady_clock::now() - start >=
                std::chrono::milliseconds(timeoutMs);

        if (cancelled || timedOut) {
            result.cancelled = cancelled;
            result.timedOut = timedOut && !cancelled;

            kill(-pid, SIGTERM);

            const auto terminateStart = std::chrono::steady_clock::now();
            bool finished = false;

            while (std::chrono::steady_clock::now() - terminateStart <
                   std::chrono::milliseconds(1000)) {
                waitResult = waitpid(pid, &status, WNOHANG);

                if (waitResult == pid) {
                    finished = true;
                    break;
                }

                if (waitResult < 0 && errno != EINTR) {
                    finished = true;
                    break;
                }

                std::this_thread::sleep_for(
                    std::chrono::milliseconds(25)
                );
            }

            if (!finished) {
                kill(-pid, SIGKILL);

                while (waitpid(pid, &status, 0) < 0) {
                    if (errno == EINTR) {
                        continue;
                    }

                    break;
                }
            }

            if (WIFEXITED(status)) {
                result.exitCode = WEXITSTATUS(status);
            } else if (WIFSIGNALED(status)) {
                result.exitCode = 128 + WTERMSIG(status);
            }

            break;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    return result;
}

#endif

}
