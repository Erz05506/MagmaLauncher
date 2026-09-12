#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>

#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_menu_model.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_message_router.h"

#include <shlobj.h>
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <iostream>
#include <string>
#include <sstream>
#include <thread>
#include <vector>
#include <list>
#include <functional>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <shobjidl.h>

#include "secret.h"
#include "launcher_core.h"

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "ole32.lib")

using json = nlohmann::json;
using Callback = CefMessageRouterBrowserSide::Callback;

static const int GOOGLE_REDIRECT_PORT = 53682;
static const char* MAGMA_LAUNCHER_VERSION = "Alpha 1"; 

static void showErrorBox(const std::string& utf8Message, const std::string& utf8Title) {
    int wideLen = MultiByteToWideChar(CP_UTF8, 0, utf8Message.c_str(), -1, nullptr, 0);
    std::wstring wideMessage(wideLen, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8Message.c_str(), -1, wideMessage.data(), wideLen);

    int wideTitleLen = MultiByteToWideChar(CP_UTF8, 0, utf8Title.c_str(), -1, nullptr, 0);
    std::wstring wideTitle(wideTitleLen, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8Title.c_str(), -1, wideTitle.data(), wideTitleLen);

    MessageBoxW(nullptr, wideMessage.c_str(), wideTitle.c_str(), MB_OK | MB_ICONERROR);
}

static size_t writeCallback(char* ptr, size_t size, size_t nmemb, std::string* data) {
    data->append(ptr, size * nmemb);
    return size * nmemb;
}

static std::string urlEncode(CURL* curl, const std::string& value) {
    char* encoded = curl_easy_escape(curl, value.c_str(), (int)value.length());
    std::string result = encoded ? encoded : value;
    if (encoded) curl_free(encoded);
    return result;
}

static std::wstring utf8ToWide(const std::string& utf8) {
    if (utf8.empty()) return std::wstring();
    int len = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
    std::wstring wide(len, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, wide.data(), len);
    if (!wide.empty() && wide.back() == L'\0') wide.pop_back();
    return wide;
}

static std::string wideToUtf8(const std::wstring& wide) {
    if (wide.empty()) return std::string();
    int len = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string utf8(len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, utf8.data(), len, nullptr, nullptr);
    if (!utf8.empty() && utf8.back() == '\0') utf8.pop_back();
    return utf8;
}

// Общий IFileOpenDialog-хелпер: pickFolders=true — диалог выбора папки
// (FOS_PICKFOLDERS), иначе — диалог выбора файла с фильтром по имени/маске
// (например, "java.exe" для выбора именно java.exe). Вызывается всегда из
// отдельного потока (см. ApiHandler ниже) — сам диалог модальный и блокирует
// вызывающий поток, поэтому вызывать его прямо на CEF UI thread нельзя.
static bool showNativePickerDialog(bool pickFolders, const std::wstring& filterName,
                                    const std::wstring& filterSpec, const std::wstring& initialDir,
                                    std::wstring& pathOut) {
    HRESULT initHr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    bool comInitializedHere = SUCCEEDED(initHr);

    bool ok = false;
    IFileOpenDialog* pDialog = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_ALL,
                                   IID_IFileOpenDialog, reinterpret_cast<void**>(&pDialog));
    if (SUCCEEDED(hr) && pDialog) {
        if (pickFolders) {
            DWORD opts = 0;
            pDialog->GetOptions(&opts);
            pDialog->SetOptions(opts | FOS_PICKFOLDERS | FOS_PATHMUSTEXIST | FOS_FORCEFILESYSTEM);
        } else if (!filterSpec.empty()) {
            COMDLG_FILTERSPEC filter[] = { { filterName.c_str(), filterSpec.c_str() } };
            pDialog->SetFileTypes(1, filter);
            pDialog->SetFileTypeIndex(1);
        }

        // Открываем диалог сразу в нужной папке (последняя выбранная папка
        // игры/Java), а не там, где Windows открыл его в прошлый раз (обычно
        // "Документы") — раньше initialDir никак не передавался, и обзор
        // всегда стартовал непонятно откуда.
        if (!initialDir.empty()) {
            IShellItem* pFolderItem = nullptr;
            if (SUCCEEDED(SHCreateItemFromParsingName(initialDir.c_str(), nullptr, IID_PPV_ARGS(&pFolderItem)))) {
                pDialog->SetFolder(pFolderItem);
                pFolderItem->Release();
            }
        }

        hr = pDialog->Show(nullptr);
        if (SUCCEEDED(hr)) {
            IShellItem* pItem = nullptr;
            hr = pDialog->GetResult(&pItem);
            if (SUCCEEDED(hr) && pItem) {
                PWSTR resultPath = nullptr;
                hr = pItem->GetDisplayName(SIGDN_FILESYSPATH, &resultPath);
                if (SUCCEEDED(hr) && resultPath) {
                    pathOut = resultPath;
                    CoTaskMemFree(resultPath);
                    ok = true;
                }
                pItem->Release();
            }
        }
        pDialog->Release();
    }

    if (comInitializedHere) CoUninitialize();
    return ok;
}

static std::vector<unsigned char> base64Decode(const std::string& in) {
    static const std::string chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::vector<int> table(256, -1);
    for (int i = 0; i < 64; i++) table[(unsigned char)chars[i]] = i;
    std::vector<unsigned char> out;
    int val = 0, valb = -8;
    for (unsigned char c : in) {
        if (table[c] == -1) continue;
        val = (val << 6) + table[c];
        valb += 6;
        if (valb >= 0) {
            out.push_back((unsigned char)((val >> valb) & 0xFF));
            valb -= 8;
        }
    }
    return out;
}

static std::string base64Encode(const std::string& in) {
    static const char* chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    int val = 0, valb = -6;
    for (unsigned char c : in) {
        val = (val << 8) + c;
        valb += 8;
        while (valb >= 0) {
            out.push_back(chars[(val >> valb) & 0x3F]);
            valb -= 6;
        }
    }
    if (valb > -6) out.push_back(chars[((val << 8) >> (valb + 8)) & 0x3F]);
    while (out.size() % 4) out.push_back('=');
    return out;
}

static bool httpGetBinary(const std::string& url, std::string& out, std::string& errorOut) {
    CURL* curl = curl_easy_init();
    if (!curl) { errorOut = "curl_easy_init failed"; return false; }
    out.clear();
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &out);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_IPRESOLVE, CURL_IPRESOLVE_V4);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_easy_cleanup(curl);
    if (res != CURLE_OK) { errorOut = curl_easy_strerror(res); return false; }
    if (httpCode < 200 || httpCode >= 300) { errorOut = "HTTP " + std::to_string(httpCode); return false; }
    return true;
}

bool waitForGoogleAuthCode(std::string& authCode, std::string& errorOut) {
    CURL* curlTmp = curl_easy_init();
    if (!curlTmp) { errorOut = "curl_easy_init failed"; return false; }

    std::string redirectUri = "http://127.0.0.1:" + std::to_string(GOOGLE_REDIRECT_PORT) + "/callback";
    std::string authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth"
        "?client_id=" + urlEncode(curlTmp, GOOGLE_CLIENT_ID) +
        "&redirect_uri=" + urlEncode(curlTmp, redirectUri) +
        "&response_type=code"
        "&scope=" + urlEncode(curlTmp, "openid email profile") +
        "&access_type=online"
        "&prompt=select_account";
    curl_easy_cleanup(curlTmp);

    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        errorOut = "WSAStartup failed";
        return false;
    }

    SOCKET listenSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listenSocket == INVALID_SOCKET) {
        errorOut = "socket() failed";
        WSACleanup();
        return false;
    }

    BOOL reuse = TRUE;
    setsockopt(listenSocket, SOL_SOCKET, SO_REUSEADDR, (const char*)&reuse, sizeof(reuse));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(GOOGLE_REDIRECT_PORT);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

    if (bind(listenSocket, (sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR) {
        errorOut = "bind() failed — порт " + std::to_string(GOOGLE_REDIRECT_PORT) + " уже занят?";
        closesocket(listenSocket);
        WSACleanup();
        return false;
    }
    listen(listenSocket, 1);

    ShellExecuteA(nullptr, "open", authUrl.c_str(), nullptr, nullptr, SW_SHOWNORMAL);

    fd_set readSet;
    FD_ZERO(&readSet);
    FD_SET(listenSocket, &readSet);
    timeval timeout{ 120, 0 };

    bool gotRequest = false;
    std::string requestLine;

    if (select(0, &readSet, nullptr, nullptr, &timeout) > 0) {
        SOCKET clientSocket = accept(listenSocket, nullptr, nullptr);
        if (clientSocket != INVALID_SOCKET) {
            char buf[4096] = {};
            int received = recv(clientSocket, buf, sizeof(buf) - 1, 0);
            if (received > 0) {
                requestLine.assign(buf, received);
                gotRequest = true;
            }

            std::string html =
                "<html><body style='font-family:sans-serif;text-align:center;margin-top:80px;'>"
                "<h2>Вход выполнен</h2><p>Можно закрыть эту вкладку и вернуться в MagmaLauncher.</p>"
                "</body></html>";
            std::string httpResponse =
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " +
                std::to_string(html.size()) + "\r\nConnection: close\r\n\r\n" + html;
            send(clientSocket, httpResponse.c_str(), (int)httpResponse.size(), 0);
            closesocket(clientSocket);
        }
    }

    closesocket(listenSocket);
    WSACleanup();

    if (!gotRequest) {
        errorOut = "Не получили ответ от браузера (таймаут или окно было закрыто)";
        return false;
    }

    size_t pathStart = requestLine.find(' ');
    size_t pathEnd = requestLine.find(' ', pathStart + 1);
    if (pathStart == std::string::npos || pathEnd == std::string::npos) {
        errorOut = "Не удалось разобрать редирект от Google";
        return false;
    }
    std::string path = requestLine.substr(pathStart + 1, pathEnd - pathStart - 1);

    if (path.find("error=") != std::string::npos) {
        errorOut = "Пользователь отменил вход через Google";
        return false;
    }

    size_t codePos = path.find("code=");
    if (codePos == std::string::npos) {
        errorOut = "В редиректе от Google нет параметра code";
        return false;
    }
    size_t codeStart = codePos + 5;
    size_t codeEnd = path.find('&', codeStart);
    std::string rawCode = (codeEnd == std::string::npos)
        ? path.substr(codeStart)
        : path.substr(codeStart, codeEnd - codeStart);

    CURL* curlDecode = curl_easy_init();
    int outLen = 0;
    char* decoded = curl_easy_unescape(curlDecode, rawCode.c_str(), (int)rawCode.length(), &outLen);
    authCode.assign(decoded, outLen);
    curl_free(decoded);
    curl_easy_cleanup(curlDecode);

    return true;
}

bool exchangeGoogleCode(const std::string& authCode, std::string& accessToken, std::string& idToken, std::string& errorOut) {
    CURL* curl = curl_easy_init();
    if (!curl) { errorOut = "curl_easy_init failed"; return false; }

    std::string redirectUri = "http://127.0.0.1:" + std::to_string(GOOGLE_REDIRECT_PORT) + "/callback";

    std::ostringstream body;
    body << "code=" << urlEncode(curl, authCode)
         << "&client_id=" << urlEncode(curl, GOOGLE_CLIENT_ID)
         << "&client_secret=" << urlEncode(curl, GOOGLE_CLIENT_SECRET)
         << "&redirect_uri=" << urlEncode(curl, redirectUri)
         << "&grant_type=authorization_code";

    std::string bodyStr = body.str();

    std::string response;
    curl_easy_setopt(curl, CURLOPT_URL, "https://oauth2.googleapis.com/token");
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, bodyStr.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)bodyStr.size());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_IPRESOLVE, CURL_IPRESOLVE_V4);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 20L);

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        errorOut = curl_easy_strerror(res);
        return false;
    }
    if (httpCode < 200 || httpCode >= 300) {
        errorOut = "Google token endpoint HTTP " + std::to_string(httpCode) + ": " + response;
        std::cerr << "[MagmaLauncher] " << errorOut << std::endl;
        return false;
    }

    try {
        json parsed = json::parse(response);
        accessToken = parsed.at("access_token").get<std::string>();
        idToken = parsed.value("id_token", "");
    } catch (const std::exception& e) {
        errorOut = std::string("Не удалось разобрать ответ Google: ") + e.what();
        return false;
    }
    if (idToken.empty()) {
        errorOut = "Google не вернул id_token (проверьте, что scope включает openid)";
        return false;
    }
    return true;
}

bool fetchGoogleUserInfo(const std::string& accessToken, std::string& email, std::string& name, std::string& errorOut) {
    CURL* curl = curl_easy_init();
    if (!curl) { errorOut = "curl_easy_init failed"; return false; }

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, ("Authorization: Bearer " + accessToken).c_str());

    std::string response;
    curl_easy_setopt(curl, CURLOPT_URL, "https://www.googleapis.com/oauth2/v3/userinfo");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_IPRESOLVE, CURL_IPRESOLVE_V4);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 20L);

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        errorOut = curl_easy_strerror(res);
        return false;
    }
    if (httpCode < 200 || httpCode >= 300) {
        errorOut = "Google userinfo endpoint HTTP " + std::to_string(httpCode) + ": " + response;
        return false;
    }

    try {
        json parsed = json::parse(response);
        email = parsed.value("email", "");
        name = parsed.value("name", "");
        if (email.empty()) {
            errorOut = "Google не вернул email (возможно, не выдан scope email)";
            return false;
        }
    } catch (const std::exception& e) {
        errorOut = std::string("Не удалось разобрать userinfo: ") + e.what();
        return false;
    }
    return true;
}

bool googleOAuthFlow(std::string& email, std::string& name, std::string& idToken, std::string& errorOut) {
    std::string authCode;
    if (!waitForGoogleAuthCode(authCode, errorOut)) return false;

    std::string accessToken;
    if (!exchangeGoogleCode(authCode, accessToken, idToken, errorOut)) return false;

    return fetchGoogleUserInfo(accessToken, email, name, errorOut);
}

static bool g_launcherFullscreen = false;
static WINDOWPLACEMENT g_launcherSavedPlacement{ sizeof(WINDOWPLACEMENT) };

static void applyLauncherFullscreen(HWND hwnd, bool enable) {
    if (!hwnd || enable == g_launcherFullscreen) return;

    if (enable) {
        GetWindowPlacement(hwnd, &g_launcherSavedPlacement);

        MONITORINFO mi{ sizeof(MONITORINFO) };
        HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
        GetMonitorInfo(monitor, &mi);

        LONG style = GetWindowLongA(hwnd, GWL_STYLE);
        SetWindowLongA(hwnd, GWL_STYLE, style & ~(WS_CAPTION | WS_THICKFRAME));
        SetWindowPos(hwnd, HWND_TOP,
            mi.rcMonitor.left, mi.rcMonitor.top,
            mi.rcMonitor.right - mi.rcMonitor.left,
            mi.rcMonitor.bottom - mi.rcMonitor.top,
            SWP_NOOWNERZORDER | SWP_FRAMECHANGED);

        g_launcherFullscreen = true;
    } else {
        LONG style = GetWindowLongA(hwnd, GWL_STYLE);
        SetWindowLongA(hwnd, GWL_STYLE, style | WS_CAPTION | WS_THICKFRAME);
        SetWindowPlacement(hwnd, &g_launcherSavedPlacement);
        SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);

        g_launcherFullscreen = false;
    }
}

static void applyLauncherWindowSize(HWND hwnd, int width, int height) {
    if (!hwnd) return;
    if (g_launcherFullscreen) applyLauncherFullscreen(hwnd, false);

    RECT workArea{};
    if (!SystemParametersInfoA(SPI_GETWORKAREA, 0, &workArea, 0)) {
        workArea.left = 0;
        workArea.top = 0;
        workArea.right = GetSystemMetrics(SM_CXSCREEN);
        workArea.bottom = GetSystemMetrics(SM_CYSCREEN);
    }
    int areaW = workArea.right - workArea.left;
    int areaH = workArea.bottom - workArea.top;

    if (width <= 0 || height <= 0) {
        SetWindowPos(hwnd, nullptr, workArea.left, workArea.top, areaW, areaH,
            SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
        return;
    }

    width = std::min(width, areaW);
    height = std::min(height, areaH);
    int x = workArea.left + std::max(0, (areaW - width) / 2);
    int y = workArea.top + std::max(0, (areaH - height) / 2);
    SetWindowPos(hwnd, nullptr, x, y, width, height,
        SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
}

class FuncTask : public CefTask {
public:
    explicit FuncTask(std::function<void()> fn) : fn_(std::move(fn)) {}
    void Execute() override { fn_(); }
    IMPLEMENT_REFCOUNTING(FuncTask);
private:
    std::function<void()> fn_;
};

void PostUi(std::function<void()> fn) {
    CefPostTask(TID_UI, new FuncTask(std::move(fn)));
}

void PushJs(CefRefPtr<CefBrowser> browser, const std::string& code) {
    PostUi([browser, code]() {
        if (browser && browser->GetMainFrame())
            browser->GetMainFrame()->ExecuteJavaScript(code, browser->GetMainFrame()->GetURL(), 0);
    });
}

class ApiHandler : public CefMessageRouterBrowserSide::Handler {
public:
    bool OnQuery(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int64_t query_id,
                 const CefString& request,
                 bool persistent,
                 CefRefPtr<Callback> callback) override {
        json req;
        try { req = json::parse(request.ToString()); }
        catch (...) { callback->Failure(0, "bad request json"); return true; }

        std::string name = req.value("name", "");
        json args = req.value("args", json::array());
        json arg0 = args.empty() ? json::object() : args[0];

        try {
            if (name == "fetchSkinBytes") {
    std::string url = arg0.value("url", "");
    std::thread([callback, url]() {
        json result;
        bool allowed = url.rfind("https://skinsystem.ely.by/", 0) == 0;
        if (!allowed) {
            result["success"] = false;
            result["error"] = "URL не разрешён";
        } else {
            std::string bytes, err;
            bool ok = false;
            for (int attempt = 0; attempt < 3 && !ok; attempt++) {
                if (attempt > 0) Sleep(300);
                ok = httpGetBinary(url, bytes, err);
            }
            result["success"] = ok;
            if (ok) result["dataBase64"] = base64Encode(bytes);
            else result["error"] = err;
        }
                std::string payload = result.dump();
        PostUi([callback, payload]() { callback->Success(payload); });
                }).detach();
                return true;
            }
              
            if (name == "fetchLocalAsset") {
    std::string relPath = arg0.value("path", "");
    std::thread([callback, relPath]() {
        json result;
        bool safe = !relPath.empty() && relPath.find("..") == std::string::npos && relPath.find(":") == std::string::npos;
        if (!safe) {
            result["success"] = false;
            result["error"] = "Недопустимый путь";
        } else {
            std::filesystem::path fullPath = std::filesystem::path(PROJECT_DIR) / ".." / "assets" / relPath;
            std::ifstream in(fullPath, std::ios::binary);
            if (!in) {
                result["success"] = false;
                result["error"] = "Файл не найден: " + fullPath.string();
            } else {
                std::stringstream ss; ss << in.rdbuf();
                std::string bytes = ss.str();
                result["success"] = true;
                result["dataBase64"] = base64Encode(bytes);
            }
        }
        std::string payload = result.dump();
        PostUi([callback, payload]() { callback->Success(payload); });
    }).detach();
    return true;
}
if (name == "getLauncherVersion") {
    json r; r["version"] = MAGMA_LAUNCHER_VERSION;
    callback->Success(r.dump());
    return true;
}

if (name == "checkLauncherUpdate") {
    std::string manifestUrl = arg0.value("manifestUrl", "");
    std::thread([callback, manifestUrl]() {
        launcher::UpdateInfo info; std::string err;
        bool ok = launcher::checkLauncherUpdate(manifestUrl, MAGMA_LAUNCHER_VERSION, info, err);
        json r; r["success"] = ok;
        if (ok) { r["available"] = info.available; r["version"] = info.version; r["url"] = info.url; r["notes"] = info.notes; }
        else r["error"] = err;
        std::string payload = r.dump();
        PostUi([callback, payload]() { callback->Success(payload); });
    }).detach();
    return true;
}

if (name == "installLauncherUpdate") {
    std::string url = arg0.value("url", "");
    std::thread([browser, url]() {
        std::string err;
        bool ok = launcher::downloadAndInstallLauncherUpdate(url,
            [browser](const std::string& stage, double progress, const std::string& detail) {
                json p; p["stage"] = stage; p["progress"] = progress; p["detail"] = detail;
                PushJs(browser, "window.__updateProgress && window.__updateProgress(" + p.dump() + ");");
            }, err);
        json done; done["success"] = ok; if (!ok) done["error"] = err;
        PushJs(browser, "window.__updateDone && window.__updateDone(" + done.dump() + ");");
        if (ok) PostUi([]() { CefQuitMessageLoop(); }); // закрываем лаунчер, .bat подхватит
    }).detach();
    json started; started["started"] = true;
    callback->Success(started.dump());
    return true;
}
            if (name == "googleOAuthSignIn") {
                std::thread([callback]() {
                    std::string email, nick, idToken, error;
                    bool ok = googleOAuthFlow(email, nick, idToken, error);
                    json result;
                    result["success"] = ok;
                    if (ok) { result["email"] = email; result["name"] = nick; result["idToken"] = idToken; }
                    else {
                        result["error"] = error;
                        showErrorBox(error, "MagmaLauncher — ошибка входа через Google");
                    }
                    std::string payload = result.dump();
                    PostUi([callback, payload]() { callback->Success(payload); });
                }).detach();
                return true;
            }

            if (name == "openExternalUrl") {
                json result;
                std::string url = arg0.value("url", "");
                bool isHttp = url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0;
                if (!isHttp) { result["success"] = false; result["error"] = "Разрешены только http/https ссылки"; }
                else { ShellExecuteA(nullptr, "open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL); result["success"] = true; }
                callback->Success(result.dump());
                return true;
            }

            if (name == "warmupModrinth") {
                // Не блокируем CEF UI thread DNS/TLS запросом к Modrinth.
                std::thread([callback]() {
                    bool ok = launcher::modrinthWarmup();
                    json result; result["success"] = ok;
                    std::string payload = result.dump();
                    PostUi([callback, payload]() {
                        callback->Success(payload);
                    });
                }).detach();
                return true;
            }

            if (name == "deleteInstance") {
                std::string nameV = arg0.value("name", "");
                std::string gameDir = arg0.value("gameDir", "");
                std::string err;
                bool ok = launcher::deleteInstance(nameV, gameDir, err);
                json result; result["success"] = ok;
                if (!ok) result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "resetVersionCache") {
                std::string version = arg0.value("version", "");
                std::string gameDir = arg0.value("gameDir", "");
                std::string err;
                bool ok = launcher::resetVersionCache(version, gameDir, err);
                json result; result["success"] = ok;
                if (!ok) result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "browseJavaExe") {
                std::wstring initialDir = utf8ToWide(arg0.value("initialDir", ""));
                std::thread([callback, initialDir]() {
                    std::wstring picked;
                    bool ok = showNativePickerDialog(false, L"java.exe", L"java.exe", initialDir, picked);
                    json result;
                    result["success"] = ok;
                    if (ok) result["path"] = wideToUtf8(picked);
                    std::string payload = result.dump();
                    PostUi([callback, payload]() { callback->Success(payload); });
                }).detach();
                return true;
            }

            if (name == "browseFolder") {
                std::wstring initialDir = utf8ToWide(arg0.value("initialDir", ""));
                std::thread([callback, initialDir]() {
                    std::wstring picked;
                    bool ok = showNativePickerDialog(true, L"", L"", initialDir, picked);
                    json result;
                    result["success"] = ok;
                    if (ok) result["path"] = wideToUtf8(picked);
                    std::string payload = result.dump();
                    PostUi([callback, payload]() { callback->Success(payload); });
                }).detach();
                return true;
            }

            if (name == "autoDetectJava") {
                std::thread([callback]() {
                    std::string path, err;
                    bool ok = launcher::detectSystemJava(path, err);
                    json result;
                    result["success"] = ok;
                    if (ok) result["path"] = path; else result["error"] = err;
                    std::string payload = result.dump();
                    PostUi([callback, payload]() { callback->Success(payload); });
                }).detach();
                return true;
            }

            if (name == "moveGameFolder") {
                std::string oldPath = arg0.value("oldPath", "");
                std::string newPath = arg0.value("newPath", "");
                std::thread([callback, oldPath, newPath]() {
                    std::string err;
                    bool ok = launcher::moveGameDirectory(oldPath, newPath, err);
                    json result;
                    result["success"] = ok;
                    if (!ok) result["error"] = err;
                    std::string payload = result.dump();
                    PostUi([callback, payload]() { callback->Success(payload); });
                }).detach();
                return true;
            }

            if (name == "openGameFolder") {
                json result;
                std::string dir = arg0.value("dir", "");
                if (dir.empty()) { result["success"] = false; result["error"] = "Папка игры не задана"; }
                else {
                    std::error_code ec;
                    std::filesystem::create_directories(dir, ec);
                    ShellExecuteA(nullptr, "open", dir.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
                    result["success"] = true;
                }
                callback->Success(result.dump());
                return true;
            }

            if (name == "installArchiveMods" || name == "installArchiveMap" || name == "installArchiveContent" || name == "installLocalFile") {
                json result;
                std::string filename = arg0.value("filename", "");
                std::string dataBase64 = arg0.value("dataBase64", "");
                std::string targetDir = arg0.value("targetDir", "");

                if (filename.empty() || targetDir.empty()) {
                    result["success"] = false;
                    result["error"] = "Пустое имя файла или папка назначения";
                    callback->Success(result.dump());
                    return true;
                }

                if (name == "installLocalFile") {
                    size_t slashPos = filename.find_last_of("/\\");
                    std::string safeName = (slashPos == std::string::npos) ? filename : filename.substr(slashPos + 1);
                    std::filesystem::path dir(targetDir);
                    std::error_code ec;
                    std::filesystem::create_directories(dir, ec);
                    std::filesystem::path dest = dir / safeName;
                    auto bytes = base64Decode(dataBase64);
                    std::ofstream out(dest, std::ios::binary | std::ios::trunc);
                    if (!out) { result["success"] = false; result["error"] = "Не удалось создать файл " + dest.string(); }
                    else {
                        out.write((const char*)bytes.data(), (std::streamsize)bytes.size());
                        out.close();
                        result["success"] = true;
                        result["filename"] = safeName;
                    }
                    callback->Success(result.dump());
                    return true;
                }

                std::filesystem::path tmpDir = std::filesystem::path(targetDir) / "manual_import_tmp";
                std::error_code ec;
                std::filesystem::create_directories(tmpDir, ec);
                std::filesystem::path tmpFile = tmpDir / filename;

                auto bytes = base64Decode(dataBase64);
                {
                    std::ofstream out(tmpFile, std::ios::binary | std::ios::trunc);
                    if (!out) {
                        result["success"] = false; result["error"] = "Не удалось создать временный файл";
                        callback->Success(result.dump());
                        return true;
                    }
                    out.write((const char*)bytes.data(), (std::streamsize)bytes.size());
                }

                std::string err;
                bool ok = false;
                if (name == "installArchiveMods") {
                    int jarCount = 0;
                    ok = launcher::extractModJarsFromArchive(tmpFile.string(), targetDir, jarCount, err);
                    if (ok) result["count"] = jarCount;
                } else if (name == "installArchiveMap") {
                    ok = launcher::extractMapArchive(tmpFile.string(), targetDir, err);
                } else {
                    std::string outFileName;
                    ok = launcher::extractZipFromRarArchive(tmpFile.string(), targetDir, outFileName, err);
                    if (ok) result["filename"] = outFileName;
                }

                std::error_code ec2;
                std::filesystem::remove_all(tmpDir, ec2);

                result["success"] = ok;
                if (!ok) result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "getMinecraftVersions") {
                // Получение version_manifest_v2.json — сетевой запрос, поэтому
                // выполняем его вне CEF UI thread, иначе окно визуально подвисает.
                std::thread([callback]() {
                    std::string raw, err;
                    bool ok = launcher::fetchMinecraftVersionList(raw, err);
                    json result; result["success"] = ok;
                    if (ok) {
                        try {
                            result["versions"] = json::parse(raw);
                        } catch (const std::exception& e) {
                            result["success"] = false;
                            result["error"] = std::string("Не удалось разобрать список версий: ") + e.what();
                        }
                    } else {
                        result["error"] = err;
                    }

                    std::string payload = result.dump();
                    PostUi([callback, payload]() {
                        callback->Success(payload);
                    });
                }).detach();
                return true;
            }

            if (name == "pauseLaunch") {
                launcher::g_paused = true;
                json result; result["paused"] = true;
                callback->Success(result.dump());
                return true;
            }

            if (name == "resumeLaunch") {
                launcher::g_paused = false;
                json result; result["paused"] = false;
                callback->Success(result.dump());
                return true;
            }

            if (name == "cancelLaunch") {
                launcher::g_cancelled = true;
                launcher::g_paused = false;
                json result; result["cancelled"] = true;
                callback->Success(result.dump());
                return true;
            }

            if (name == "launchGame") {
                launcher::LaunchRequest lr;
                lr.version  = arg0.value("version", "");
                lr.loader   = arg0.value("loader", "vanilla");
                lr.username = arg0.value("username", "Player");
                lr.gameDir  = arg0.value("gameDir", "");
                lr.javaPath = arg0.value("javaPath", "");
                lr.ramMb    = arg0.value("ramMb", 4096);
                lr.authUuid = arg0.value("authUuid", "");
                lr.authAccessToken = arg0.value("authAccessToken", "");
                lr.instanceName = arg0.value("instanceName", "");
                lr.quickPlayServer = arg0.value("quickPlayServer", "");
                lr.extraJvmArgs = arg0.value("extraJvmArgs", "");
                lr.fullscreen = arg0.value("fullscreen", false);
                lr.windowWidth = arg0.value("windowWidth", 0);
                lr.windowHeight = arg0.value("windowHeight", 0);

                launcher::g_paused = false;
                launcher::g_cancelled = false;

                std::thread([browser, lr]() {
                    std::string errorOut;
                    bool ok = launcher::launchMinecraft(lr,
                        [browser](const std::string& stage, double progress, const std::string& detail) {
                            json p; p["stage"] = stage; p["progress"] = progress; p["detail"] = detail;
                            std::string payload = p.dump();
                            PushJs(browser, "window.__launchProgress && window.__launchProgress(" + payload + ");");
                        },
                        errorOut);

                    bool wasCancelled = (!ok && errorOut == "CANCELLED");
                    json done;
                    done["success"] = ok;
                    done["cancelled"] = wasCancelled;
                    done["error"] = wasCancelled ? "" : errorOut;
                    std::string payload = done.dump();
                    PushJs(browser, "window.__launchDone && window.__launchDone(" + payload + ");");
                }).detach();

                json started; started["started"] = true;
                callback->Success(started.dump());
                return true;
            }

            if (name == "getModDetails") {
                std::string slug = arg0.value("slug", "");
                std::string raw, err;
                bool ok = launcher::modrinthProjectDetails(slug, raw, err);
                json result; result["success"] = ok;
                if (ok) result["project"] = json::parse(raw); else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "searchMods") {
                std::string query = arg0.value("query", "");
                std::string mcVersion = arg0.value("version", "");
                std::string loader = arg0.value("loader", "fabric");
                int offset = arg0.value("offset", 0);

                std::string raw, err;
                bool ok = launcher::modrinthSearch(query, mcVersion, loader, raw, err, offset);

                json result; result["success"] = ok;
                if (ok) {
                    json parsed = json::parse(raw);
                    result["hits"] = parsed.value("hits", json::array());
                    result["total"] = parsed.value("total_hits", 0);
                } else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "searchContent") {
                std::string query = arg0.value("query", "");
                std::string mcVersion = arg0.value("version", "");
                std::string projectType = arg0.value("projectType", "resourcepack");
                int offset = arg0.value("offset", 0);

                std::string raw, err;
                bool ok = launcher::modrinthSearchByType(query, mcVersion, projectType, raw, err, offset);

                json result; result["success"] = ok;
                if (ok) {
                    json parsed = json::parse(raw);
                    result["hits"] = parsed.value("hits", json::array());
                    result["total"] = parsed.value("total_hits", 0);
                } else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "installContent") {
                std::string slug = arg0.value("slug", "");
                std::string mcVersion = arg0.value("version", "");
                std::string projectType = arg0.value("projectType", "resourcepack");
                std::string targetDir = arg0.value("targetDir", "");
                std::string fileName, err;
                bool ok = launcher::installContentToDir(slug, mcVersion, projectType, targetDir, fileName, err);
                json result; result["success"] = ok;
                if (ok) result["filename"] = fileName; else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "searchContentCurseForge") {
                std::string query = arg0.value("query", "");
                std::string mcVersion = arg0.value("version", "");
                int classId = arg0.value("classId", 6);
                int offset = arg0.value("offset", 0);

                std::string raw, err;
                bool ok = launcher::curseforgeSearchByClass(classId, query, mcVersion, raw, err, offset);

                json result; result["success"] = ok;
                if (ok) {
                    json parsed = json::parse(raw);
                    result["hits"] = parsed.value("hits", json::array());
                    result["total"] = parsed.value("total_hits", 0);
                } else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "installContentCurseForge") {
                std::string modId = arg0.value("modId", "");
                std::string mcVersion = arg0.value("version", "");
                std::string targetDir = arg0.value("targetDir", "");
                std::string fileName, err;
                bool ok = launcher::installContentCurseForge(modId, mcVersion, targetDir, fileName, err);
                json result; result["success"] = ok;
                if (ok) result["filename"] = fileName; else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "installModpackFromCatalog") {
                std::string source = arg0.value("source", "modrinth");
                std::string id = arg0.value("id", "");
                std::string mcVersion = arg0.value("version", "");
                std::string instanceName = arg0.value("instanceName", "");
                std::string gameDir = arg0.value("gameDir", "");

                launcher::g_cancelled = false;
                launcher::g_paused = false;

                std::thread([browser, source, id, mcVersion, instanceName, gameDir]() {
                    std::string errorOut, resolvedVersion, resolvedLoader;
                    auto progressFn = [browser](const std::string& stage, double progress, const std::string& detail) {
                        json p; p["stage"] = stage; p["progress"] = progress; p["detail"] = detail;
                        std::string payload = p.dump();
                        PushJs(browser, "window.__modpackProgress && window.__modpackProgress(" + payload + ");");
                    };

                    bool ok = source == "curseforge"
                        ? launcher::installCurseForgeModpack(id, mcVersion, instanceName, gameDir, progressFn, resolvedVersion, resolvedLoader, errorOut)
                        : launcher::installModrinthModpack(id, mcVersion, instanceName, gameDir, progressFn, resolvedVersion, resolvedLoader, errorOut);

                    json done;
                    done["success"] = ok;
                    done["instanceName"] = instanceName;
                    done["mcVersion"] = resolvedVersion;
                    done["loader"] = resolvedLoader;
                    if (!ok) done["error"] = errorOut;
                    std::string payload = done.dump();
                    PushJs(browser, "window.__catalogModpackDone && window.__catalogModpackDone(" + payload + ");");
                }).detach();

                json started; started["started"] = true;
                callback->Success(started.dump());
                return true;
            }

            if (name == "installModpackFromLocalFile") {
                std::string filename = arg0.value("filename", "");
                std::string dataBase64 = arg0.value("dataBase64", "");
                std::string instanceName = arg0.value("instanceName", "");
                std::string gameDir = arg0.value("gameDir", "");

                launcher::g_cancelled = false;
                launcher::g_paused = false;

                std::filesystem::path tmpRoot = std::filesystem::path(gameDir) / "modpack_tmp";
                std::error_code ec;
                std::filesystem::create_directories(tmpRoot, ec);
                std::filesystem::path tmpFile = tmpRoot / ("import_" + instanceName + "_" + filename);

                auto bytes = base64Decode(dataBase64);
                {
                    std::ofstream out(tmpFile, std::ios::binary | std::ios::trunc);
                    if (!out) {
                        json r; r["started"] = false; r["error"] = "Не удалось создать временный файл";
                        callback->Success(r.dump());
                        return true;
                    }
                    out.write((const char*)bytes.data(), (std::streamsize)bytes.size());
                }

                std::thread([browser, tmpFile, instanceName, gameDir]() {
                    std::string errorOut, resolvedVersion, resolvedLoader;
                    bool ok = launcher::installModpackFromLocalFile(tmpFile.string(), instanceName, gameDir,
                        [browser](const std::string& stage, double progress, const std::string& detail) {
                            json p; p["stage"] = stage; p["progress"] = progress; p["detail"] = detail;
                            std::string payload = p.dump();
                            PushJs(browser, "window.__modpackProgress && window.__modpackProgress(" + payload + ");");
                        },
                        resolvedVersion, resolvedLoader, errorOut);

                    std::error_code ec2;
                    std::filesystem::remove(tmpFile, ec2);

                    json done;
                    done["success"] = ok;
                    done["instanceName"] = instanceName;
                    done["mcVersion"] = resolvedVersion;
                    done["loader"] = resolvedLoader;
                    if (!ok) done["error"] = errorOut;
                    std::string payload = done.dump();
                    PushJs(browser, "window.__catalogModpackDone && window.__catalogModpackDone(" + payload + ");");
                }).detach();

                json started; started["started"] = true;
                callback->Success(started.dump());
                return true;
            }

            if (name == "searchModsCurseForge") {
                std::string query = arg0.value("query", "");
                std::string mcVersion = arg0.value("version", "");
                std::string loader = arg0.value("loader", "fabric");
                int offset = arg0.value("offset", 0);

                std::string raw, err;
                bool ok = launcher::curseforgeSearch(query, mcVersion, loader, raw, err, offset);

                json result; result["success"] = ok;
                if (ok) {
                    json parsed = json::parse(raw);
                    result["hits"] = parsed.value("hits", json::array());
                    result["total"] = parsed.value("total_hits", 0);
                } else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "getModDetailsCurseForge") {
                std::string modId = arg0.value("modId", "");
                std::string html, err;
                bool ok = launcher::curseforgeProjectDescription(modId, html, err);
                json result; result["success"] = ok;
                if (ok) result["html"] = html; else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "getModInfoCurseForge") {
                std::string modId = arg0.value("modId", "");
                std::string title, iconUrl, err;
                bool ok = launcher::curseforgeModInfo(modId, title, iconUrl, err);
                json result; result["success"] = ok;
                if (ok) { result["title"] = title; result["icon_url"] = iconUrl; } else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "installModCurseForge") {
                std::string modId = arg0.value("modId", "");
                std::string mcVersion = arg0.value("version", "");
                std::string loader = arg0.value("loader", "fabric");
                std::string modsDir = arg0.value("modsDir", "");
                std::string fileName, err;
                bool ok = launcher::installModCurseForge(modId, mcVersion, loader, modsDir, fileName, err);
                json result; result["success"] = ok;
                if (ok) result["filename"] = fileName; else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "installMod") {
                std::string slug = arg0.value("slug", "");
                std::string mcVersion = arg0.value("version", "");
                std::string loader = arg0.value("loader", "fabric");
                std::string modsDir = arg0.value("modsDir", "");
                std::string fileName, err;
                bool ok = launcher::installModToDir(slug, mcVersion, loader, modsDir, fileName, err);
                json result; result["success"] = ok;
                if (ok) result["filename"] = fileName; else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "listModsInDir") {
                std::string dir = arg0.value("dir", "");
                std::vector<std::string> files;
                std::string err;
                bool ok = launcher::listDirFileNames(dir, files, err);
                json result; result["success"] = ok;
                if (ok) result["files"] = files; else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "listMapFolders") {
    std::string dir = arg0.value("dir", "");
    std::vector<std::string> folders;
    std::string err;
    bool ok = launcher::listDirFolderNames(dir, folders, err);
    json result; result["success"] = ok;
    if (ok) result["folders"] = folders; else result["error"] = err;
    callback->Success(result.dump());
    return true;
}

            if (name == "toggleModFile") {
                std::string dir = arg0.value("dir", "");
                std::string filename = arg0.value("filename", "");
                std::string newName, err;
                bool ok = launcher::toggleModEnabled(dir, filename, newName, err);
                json result; result["success"] = ok;
                if (ok) result["filename"] = newName; else result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "deleteModFile") {
                std::string dir = arg0.value("dir", "");
                std::string filename = arg0.value("filename", "");
                std::string err;
                bool ok = launcher::deleteModFile(dir, filename, err);
                json result; result["success"] = ok;
                if (!ok) result["error"] = err;
                callback->Success(result.dump());
                return true;
            }

            if (name == "deleteMapFolder") {
    std::string dir = arg0.value("dir", "");
    std::string folder = arg0.value("folder", "");
    std::string err;
    bool ok = launcher::deleteMapFolder(dir, folder, err);
    json result; result["success"] = ok;
    if (!ok) result["error"] = err;
    callback->Success(result.dump());
    return true;
}

            if (name == "createModpack") {
                launcher::ModpackRequest mr;
                mr.name = arg0.value("name", "");
                mr.mcVersion = arg0.value("version", "");
                mr.loader = arg0.value("loader", "fabric");
                mr.gameDir = arg0.value("gameDir", "");
                for (auto& m : arg0.value("mods", json::array())) {
                    launcher::ModEntry entry;
                    entry.slug = m.value("slug", "");
                    entry.enabled = m.value("enabled", true);
                    if (!entry.slug.empty()) mr.mods.push_back(entry);
                }

                launcher::g_cancelled = false;

                std::thread([browser, mr]() {
                    std::string errorOut;
                    bool ok = launcher::createModpack(mr,
                        [browser](const std::string& stage, double progress, const std::string& detail) {
                            json p; p["stage"] = stage; p["progress"] = progress; p["detail"] = detail;
                            std::string payload = p.dump();
                            PushJs(browser, "window.__modpackProgress && window.__modpackProgress(" + payload + ");");
                        },
                        errorOut);

                    json done;
                    done["success"] = ok;
                    if (!ok) done["error"] = errorOut;
                    std::string payload = done.dump();
                    PushJs(browser, "window.__modpackDone && window.__modpackDone(" + payload + ");");
                }).detach();

                json started; started["started"] = true;
                callback->Success(started.dump());
                return true;
            }

            if (name == "toggleFullscreen") {
                HWND hwnd = browser->GetHost()->GetWindowHandle();
                applyLauncherFullscreen(hwnd, !g_launcherFullscreen);
                json result; result["fullscreen"] = g_launcherFullscreen;
                callback->Success(result.dump());
                return true;
            }

            if (name == "setLauncherFullscreen") {
                HWND hwnd = browser->GetHost()->GetWindowHandle();
                bool enable = arg0.value("fullscreen", false);
                applyLauncherFullscreen(hwnd, enable);
                json result; result["fullscreen"] = g_launcherFullscreen;
                callback->Success(result.dump());
                return true;
            }

            if (name == "setLauncherWindowSize") {
                HWND hwnd = browser->GetHost()->GetWindowHandle();
                int width = arg0.value("width", 0);
                int height = arg0.value("height", 0);
                applyLauncherWindowSize(hwnd, width, height);
                json result; result["success"] = true;
                callback->Success(result.dump());
                return true;
            }
        } catch (const std::exception& e) {
            json result; result["success"] = false; result["error"] = e.what();
            callback->Success(result.dump());
            return true;
        }

                    if (name == "discordPresenceStart") {
                std::string appId = arg0.value("appId", "1234567890123456");
                std::thread([callback, appId]() {
                    std::string err;
                    bool ok = launcher::discordPresenceStart(appId, err);
                    json result; result["success"] = ok;
                    if (!ok) result["error"] = err;
                    std::string payload = result.dump();
                    PostUi([callback, payload]() { callback->Success(payload); });
                }).detach();
                return true;
            }

            if (name == "discordPresenceSetActivity") {
                std::string details = arg0.value("details", "");
                std::string state = arg0.value("state", "");
                std::string largeImageKey = arg0.value("largeImageKey", "magma_logo");
                std::string largeImageText = arg0.value("largeImageText", "MagmaLauncher");
                long long startTimestamp = arg0.value("startTimestamp", 0LL);
                launcher::discordPresenceSetActivity(details, state, largeImageKey, largeImageText, startTimestamp);
                json result; result["success"] = true;
                callback->Success(result.dump());
                return true;
            }

            if (name == "discordPresenceClear") {
                launcher::discordPresenceClear();
                json result; result["success"] = true;
                callback->Success(result.dump());
                return true;
            }

            if (name == "discordPresenceStop") {
                launcher::discordPresenceStop();
                json result; result["success"] = true;
                callback->Success(result.dump());
                return true;
            }

            if (name == "cleanOldGameLogs") {
                std::string gameDir = arg0.value("gameDir", "");
                int days = arg0.value("days", 14);
                std::thread([callback, gameDir, days]() {
                    int deleted = 0;
                    std::string err;
                    bool ok = launcher::cleanOldGameLogs(gameDir, days, deleted, err);
                    json result; result["success"] = ok; result["deleted"] = deleted;
                    if (!ok) result["error"] = err;
                    std::string payload = result.dump();
                    PostUi([callback, payload]() { callback->Success(payload); });
                }).detach();
                return true;
            }

        return false;
    }

};

class MagmaClient : public CefClient, public CefLifeSpanHandler, public CefDisplayHandler, public CefContextMenuHandler {
public:
    MagmaClient() {
        CefMessageRouterConfig config;
        message_router_ = CefMessageRouterBrowserSide::Create(config);
        message_router_->AddHandler(new ApiHandler(), false);
    }

    CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
    CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
    CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override { return this; }

     void OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                             CefRefPtr<CefFrame> frame,
                             CefRefPtr<CefContextMenuParams> params,
                             CefRefPtr<CefMenuModel> model) override {
        CEF_REQUIRE_UI_THREAD();
        model->Clear();
    }

        void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
        CEF_REQUIRE_UI_THREAD();
        browser_list_.push_back(browser);

        HWND hwnd = browser->GetHost()->GetWindowHandle();
        if (hwnd) {
            ShowWindow(hwnd, SW_MAXIMIZE);
            // CEF иногда не синхронизирует внутренний размер браузера с
            // реальным размером окна сразу после раннего SW_MAXIMIZE —
            // контент рисуется под старый (немаксимизированный) размер,
            // и сверху остаётся чёрная полоса. Принудительно пересчитываем.
            RECT rc{};
            GetClientRect(hwnd, &rc);
            SetWindowPos(hwnd, nullptr, 0, 0, rc.right, rc.bottom,
                         SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED);
            browser->GetHost()->WasResized();
        }
    }

    // Блокирует создание попап-окон CEF (target="_blank", window.open и т.п.)
    // на уровне самого браузерного движка — JS-перехват в app.js работает
    // только для случаев, которые доходят до скрипта страницы, а анкоры с
    // target="_blank" (например в описаниях модов с CurseForge/Modrinth)
    // CEF обрабатывает раньше и сам открывает новое нативное окно, минуя JS.
    // Раньше это создавало отдельное окно (иногда с ERR_FILE_NOT_FOUND, если
    // ссылка была относительной), и закрытие этого окна могло утащить за
    // собой весь message loop приложения. Вместо попапа просто открываем
    // ссылку в системном браузере пользователя — тем же способом, что и
    // openExternalUrl в ApiHandler — и возвращаем true, чтобы CEF вообще не
    // создавал новое окно.
    bool OnBeforePopup(CefRefPtr<CefBrowser> browser,
                    CefRefPtr<CefFrame> frame,
                    int popup_id,                             
                    const CefString& target_url,
                    const CefString& target_frame_name,
                    CefLifeSpanHandler::WindowOpenDisposition target_disposition,  
                    bool user_gesture,
                    const CefPopupFeatures& popupFeatures,
                    CefWindowInfo& windowInfo,
                    CefRefPtr<CefClient>& client,
                    CefBrowserSettings& settings,
                    CefRefPtr<CefDictionaryValue>& extra_info,
                    bool* no_javascript_access) override {
        CEF_REQUIRE_UI_THREAD();

        std::string url = target_url.ToString();
        bool isHttp = url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0;
        if (isHttp) {
            ShellExecuteA(nullptr, "open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        }

        return true; // отменяем создание попапа полностью
    }

    bool DoClose(CefRefPtr<CefBrowser> browser) override {
        CEF_REQUIRE_UI_THREAD();
        return false;
    }

    void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
        CEF_REQUIRE_UI_THREAD();
        message_router_->OnBeforeClose(browser);
        for (auto it = browser_list_.begin(); it != browser_list_.end(); ++it) {
            if ((*it)->IsSame(browser)) {
                browser_list_.erase(it);
                break;
            }
        }
        if (browser_list_.empty()) {
            CefQuitMessageLoop();
        }
    }

    bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                   CefRefPtr<CefFrame> frame,
                                   CefProcessId source_process,
                                   CefRefPtr<CefProcessMessage> message) override {
        return message_router_->OnProcessMessageReceived(browser, frame, source_process, message);
    }

    IMPLEMENT_REFCOUNTING(MagmaClient);

private:
    std::list<CefRefPtr<CefBrowser>> browser_list_;
    CefRefPtr<CefMessageRouterBrowserSide> message_router_;
};

class MagmaApp : public CefApp, public CefBrowserProcessHandler, public CefRenderProcessHandler {
public:
    CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
    CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override { return this; }

    void OnBeforeCommandLineProcessing(const CefString& process_type,
                                        CefRefPtr<CefCommandLine> command_line) override {
        command_line->AppendSwitch("allow-file-access-from-files");
    }

    void OnContextInitialized() override {
    CEF_REQUIRE_UI_THREAD();

    CefWindowInfo windowInfo;
    windowInfo.runtime_style = CEF_RUNTIME_STYLE_ALLOY;

    POINT cursorPos{};
    GetCursorPos(&cursorPos);
    HMONITOR targetMonitor = MonitorFromPoint(cursorPos, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO mi{ sizeof(MONITORINFO) };
    GetMonitorInfo(targetMonitor, &mi);

    windowInfo.SetAsPopup(nullptr, "MagmaLauncher");
    windowInfo.bounds = CefRect(mi.rcWork.left, mi.rcWork.top,
                                 mi.rcWork.right - mi.rcWork.left,
                                 mi.rcWork.bottom - mi.rcWork.top);

    CefBrowserSettings browserSettings;
    browserSettings.background_color = CefColorSetARGB(255, 10, 10, 12);
    CefRefPtr<MagmaClient> handler(new MagmaClient());
    CefRefPtr<CefClient> client = handler.get();

    std::string url = "file:///" + std::string(PROJECT_DIR) + "/index.html";

    CefBrowserHost::CreateBrowser(windowInfo, client, url, browserSettings, nullptr, nullptr);
}

    void OnContextCreated(CefRefPtr<CefBrowser> browser,
                           CefRefPtr<CefFrame> frame,
                           CefRefPtr<CefV8Context> context) override {
        if (!message_router_renderer_) {
            CefMessageRouterConfig config;
            message_router_renderer_ = CefMessageRouterRendererSide::Create(config);
        }
        message_router_renderer_->OnContextCreated(browser, frame, context);
        frame->ExecuteJavaScript(BuildBridgeJs(), frame->GetURL(), 0);
    }

    void OnContextReleased(CefRefPtr<CefBrowser> browser,
                            CefRefPtr<CefFrame> frame,
                            CefRefPtr<CefV8Context> context) override {
        if (message_router_renderer_) message_router_renderer_->OnContextReleased(browser, frame, context);
    }

    bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                   CefRefPtr<CefFrame> frame,
                                   CefProcessId source_process,
                                   CefRefPtr<CefProcessMessage> message) override {
        return message_router_renderer_ && message_router_renderer_->OnProcessMessageReceived(browser, frame, source_process, message);
    }

    IMPLEMENT_REFCOUNTING(MagmaApp);

private:
    static std::string BuildBridgeJs() {
        static const char* names[] = {
            "googleOAuthSignIn", "openExternalUrl", "warmupModrinth", "deleteInstance", "resetVersionCache",
            "browseJavaExe", "browseFolder", "autoDetectJava", "moveGameFolder",
            "openGameFolder", "getLauncherVersion", "checkLauncherUpdate", "installLauncherUpdate","fetchSkinBytes", "fetchLocalAsset", "installArchiveMods", "installArchiveMap", "installArchiveContent", "installLocalFile",
            "getMinecraftVersions", "pauseLaunch", "resumeLaunch", "cancelLaunch", "launchGame", "listMapFolders", "deleteMapFolder",
            "getModDetails", "searchMods", "searchContent", "installContent", "searchContentCurseForge",
            "installContentCurseForge", "installModpackFromCatalog", "installModpackFromLocalFile",
            "searchModsCurseForge", "getModDetailsCurseForge", "getModInfoCurseForge", "installModCurseForge",
            "installMod", "listModsInDir", "toggleModFile", "deleteModFile", "createModpack", "toggleFullscreen",
            "setLauncherFullscreen", "setLauncherWindowSize",
            "discordPresenceStart", "discordPresenceSetActivity", "discordPresenceClear", "discordPresenceStop",
            "cleanOldGameLogs"
        };
        
        std::ostringstream js;
        js << "(function(){";
        for (const char* n : names) {
            js << "window['" << n << "'] = function(){"
               << "var callArgs = Array.prototype.slice.call(arguments);"
               << "var req = JSON.stringify({name:'" << n << "', args: callArgs});"
               << "return new Promise(function(resolve, reject){"
               << "window.cefQuery({request: req, persistent: false,"
               << "onSuccess: function(response){ try { resolve(JSON.parse(response)); } catch(e){ resolve(response); } },"
               << "onFailure: function(code, message){ reject(new Error(message)); }"
               << "});"
               << "});"
               << "};";
        }
        js << "})();";
        return js.str();
    }

    CefRefPtr<CefMessageRouterRendererSide> message_router_renderer_;
};

int APIENTRY wWinMain(HINSTANCE hInstance, HINSTANCE, LPWSTR, int) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    CefMainArgs main_args(hInstance);
    CefRefPtr<MagmaApp> app(new MagmaApp());

    int exit_code = CefExecuteProcess(main_args, app.get(), nullptr);
    if (exit_code >= 0) {
        return exit_code;
    }

    HANDLE singleInstanceMutex = CreateMutexA(nullptr, TRUE, "MagmaLauncherSingleInstanceMutex");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        HWND existing = FindWindowA(nullptr, "MagmaLauncher");
        if (existing) {
            if (IsIconic(existing)) ShowWindow(existing, SW_RESTORE);
            SetForegroundWindow(existing);
        }
        if (singleInstanceMutex) CloseHandle(singleInstanceMutex);
        return 0;
    }

    SetCurrentProcessExplicitAppUserModelID(L"MagmaLauncher.Launcher");

    curl_global_init(CURL_GLOBAL_DEFAULT);
    CefSettings settings;
    settings.no_sandbox = true;
    settings.background_color = CefColorSetARGB(255, 10, 10, 12);

    const char* appDataEnv = std::getenv("APPDATA");
    if (appDataEnv) {
        std::string cachePath = std::string(appDataEnv) + "\\MagmaLauncher\\cef_cache";
        std::error_code ec;
        std::filesystem::create_directories(cachePath, ec);
        CefString(&settings.cache_path).FromString(cachePath);
    }

    CefInitialize(main_args, settings, app.get(), nullptr);
    CefRunMessageLoop();
    CefShutdown();

    curl_global_cleanup();
    return 0;
}