#include "launcher_core.h"
#include "secret.h"

#include <windows.h>
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <zlib.h>

#include <fstream>
#include <sstream>
#include <vector>
#include <cstring>
#include <cstdio>
#include <cstdint>
#include <algorithm>
#include <optional>
#include <filesystem>
#include <map>
#include <chrono>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace launcher {

// Определение флага паузы, объявленного в launcher_core.h.
std::atomic<bool> g_paused{false};
// Определение флага отмены, объявленного в launcher_core.h.
std::atomic<bool> g_cancelled{false};

// ============================================
// Мелкие HTTP-хелперы
// ============================================
namespace {
// ============================================
// Discord Rich Presence / IPC
// Объявляем и реализуем IPC-хелперы ДО первого использования.
// ============================================
HANDLE g_discordPipe = INVALID_HANDLE_VALUE;
std::atomic<bool> g_discordConnected{false};

bool discordWriteFrame(uint32_t opcode, const std::string& payload) {
    if (g_discordPipe == INVALID_HANDLE_VALUE) return false;
    uint32_t len = (uint32_t)payload.size();
    std::vector<char> buf(8 + payload.size());
    std::memcpy(buf.data(), &opcode, 4);
    std::memcpy(buf.data() + 4, &len, 4);
    std::memcpy(buf.data() + 8, payload.data(), payload.size());
    DWORD written = 0;
    bool ok = WriteFile(g_discordPipe, buf.data(), (DWORD)buf.size(), &written, nullptr) &&
              written == buf.size();
    if (!ok) {
        CloseHandle(g_discordPipe);
        g_discordPipe = INVALID_HANDLE_VALUE;
        g_discordConnected.store(false);
    }
    return ok;
}
bool waitForPipeData(HANDLE pipe, DWORD timeoutMs) {
    DWORD waited = 0;
    while (waited < timeoutMs) {
        DWORD bytesAvail = 0;
        if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &bytesAvail, nullptr)) return false;
        if (bytesAvail >= 8) return true;
        Sleep(50);
        waited += 50;
    }
    return false;
}

bool discordReadFrame(std::string& payloadOut) {
    if (g_discordPipe == INVALID_HANDLE_VALUE) return false;
    if (!waitForPipeData(g_discordPipe, 5000)) return false;
    char header[8];
    DWORD read = 0;
    if (!ReadFile(g_discordPipe, header, 8, &read, nullptr) || read != 8) return false;
    uint32_t len = 0;
    std::memcpy(&len, header + 4, 4);
    if (len == 0) {
        payloadOut.clear();
        return true;
    }
    std::vector<char> buf(len);
    if (!ReadFile(g_discordPipe, buf.data(), len, &read, nullptr) || read != len) return false;
    payloadOut.assign(buf.data(), len);
    return true;
}

bool discordConnectPipe() {
    for (int i = 0; i < 10; i++) {
        std::string pipeName = "\\\\.\\pipe\\discord-ipc-" + std::to_string(i);
        HANDLE h = CreateFileA(
            pipeName.c_str(),
            GENERIC_READ | GENERIC_WRITE,
            0, nullptr, OPEN_EXISTING, 0, nullptr
        );
        if (h != INVALID_HANDLE_VALUE) {
            g_discordPipe = h;
            return true;
        }
    }
    return false;
}


// Блокирует поток закачки, пока стоит пауза, и сообщает, была ли за это
// время (или до него) запрошена отмена — тогда вызывающий код должен сразу
// прекратить текущий шаг с errorOut == "CANCELLED".
bool waitWhilePausedOrCancelled(std::string& errorOut) {
    while (g_paused.load()) {
        if (g_cancelled.load()) { errorOut = "CANCELLED"; return false; }
        Sleep(200);
    }
    if (g_cancelled.load()) { errorOut = "CANCELLED"; return false; }
    return true;
}

size_t writeToString(char* ptr, size_t size, size_t nmemb, std::string* out) {
    out->append(ptr, size * nmemb);
    return size * nmemb;
}

size_t writeToFile(char* ptr, size_t size, size_t nmemb, std::ofstream* out) {
    out->write(ptr, (std::streamsize)(size * nmemb));
    return size * nmemb;
}

// Возвращая ненулевое значение, curl прерывает текущую передачу — используем
// это, чтобы отмена срабатывала мгновенно даже посреди скачивания одного
// большого файла (client.jar, ассеты, Java runtime), а не только между ними.
//
// ВАЖНО: раньше пауза проверялась только между файлами (waitWhilePausedOrCancelled
// вызывался в начале каждой итерации цикла) — если пользователь ставил на паузу
// во время закачки одного большого файла (client.jar, крупная библиотека,
// Java runtime, установщик Forge), ничего не происходило, пока этот файл не
// докачается полностью. На медленной сети это могло занимать минуты — с точки
// зрения игрока пауза выглядела просто нерабочей. curl дёргает этот колбэк
// прямо во время передачи, поэтому блокировка здесь реально останавливает
// именно приём байтов, а не просто откладывает следующий файл.
int abortIfCancelledCallback(void*, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    while (g_paused.load()) {
        if (g_cancelled.load()) return 1;
        Sleep(200);
    }
    return g_cancelled.load() ? 1 : 0;
}

template <typename Fn>
bool withRetries(Fn&& operation, int maxAttempts, std::string& errorOut,
                  const std::function<void(int attempt, int maxAttempts)>& onRetry = nullptr) {
    for (int attempt = 1; attempt <= maxAttempts; attempt++) {
        if (g_cancelled.load()) { errorOut = "CANCELLED"; return false; }
        if (onRetry) onRetry(attempt, maxAttempts);
        std::string attemptError;
        if (operation(attemptError)) return true;
        errorOut = attemptError;
        if (g_cancelled.load()) { errorOut = "CANCELLED"; return false; }
        if (attempt < maxAttempts) Sleep(300 * attempt);
    }
    return false;
}

// Общие опции, применяемые к КАЖДОМУ curl-запросу в файле (GET, download,
// прогрев) — вынесены в одно место, чтобы не повторять и не забыть где-то.
// CURLOPT_IPRESOLVE=V4 — главная причина добавления: "Could not resolve
// hostname" на части сетей на самом деле означает не то, что хост реально не
// резолвится, а что резолвер вернул AAAA (IPv6) запись, а исходящего IPv6
// на машине/провайдере по факту нет — curl пытается достучаться по нему и
// падает с ошибкой резолва/подключения. Принудительный IPv4 — стандартный
// обходной путь для этого (тот же приём использует и curl.exe -4).
void applyCommonCurlOpts(CURL* curl) {
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "MagmaLauncher/1.0");
    curl_easy_setopt(curl, CURLOPT_IPRESOLVE, CURL_IPRESOLVE_V4);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 1L);
}

bool httpGetStringOnce(const std::string& url, std::string& out, std::string& errorOut) {
    CURL* curl = curl_easy_init();
    if (!curl) { errorOut = "curl_easy_init failed"; return false; }

    out.clear();
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeToString);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &out);
    applyCommonCurlOpts(curl);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) { errorOut = std::string("ERR_NETWORK||") + curl_easy_strerror(res); return false; }
    if (httpCode < 200 || httpCode >= 300) {
        errorOut = "ERR_HTTP_STATUS||HTTP " + std::to_string(httpCode) + " (" + url + ")";
        return false;
    }
    return true;
}

bool httpGetString(const std::string& url, std::string& out, std::string& errorOut) {
    return withRetries([&](std::string& attemptError) {
        return httpGetStringOnce(url, out, attemptError);
    }, 4, errorOut);
}

// Отдельная, более "нервная" версия для интерактивных запросов к Modrinth API
// (поиск модов, описание мода, разрешение файла для установки) — эти вызовы
// напрямую блокируют UI (модалка "О моде" висит на "Загружаем описание...",
// список модов висит на "Ищем моды..."), поэтому им нужен короткий таймаут и
// мало попыток: лучше быстро показать понятную ошибку, чем держать игрока
// перед замёрзшим экраном до 2 минут (как было бы с httpGetString: 4 попытки
// по 30 секунд). Для скачивания больших файлов (client.jar, библиотеки,
// ассеты) по-прежнему используется терпеливый httpGetString/httpDownloadFile.
bool httpGetStringOnceFast(const std::string& url, std::string& out, std::string& errorOut) {
    CURL* curl = curl_easy_init();
    if (!curl) { errorOut = "curl_easy_init failed"; return false; }

    out.clear();
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeToString);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &out);
    applyCommonCurlOpts(curl);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 8L);

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) { errorOut = std::string("ERR_NETWORK||") + curl_easy_strerror(res); return false; }
    if (httpCode < 200 || httpCode >= 300) {
        errorOut = "ERR_HTTP_STATUS||HTTP " + std::to_string(httpCode) + " (" + url + ")";
        return false;
    }
    return true;
}

bool httpGetStringFast(const std::string& url, std::string& out, std::string& errorOut) {
    // Было 2 попытки — увеличено до 4: DNS-сбои ("Could not resolve hostname")
    // валятся почти мгновенно (никакого реального ожидания таймаута), так что
    // пара лишних попыток не делает "быстрый" путь заметно медленнее для
    // игрока, зато переживает кратковременные сбои локального резолвера.
    return withRetries([&](std::string& attemptError) {
        return httpGetStringOnceFast(url, out, attemptError);
    }, 4, errorOut);
}

bool httpGetStringOnceWithHeader(const std::string& url, const std::string& headerLine,
                                  std::string& out, std::string& errorOut) {
    CURL* curl = curl_easy_init();
    if (!curl) { errorOut = "curl_easy_init failed"; return false; }

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, headerLine.c_str());
    headers = curl_slist_append(headers, "Accept: application/json");

    out.clear();
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeToString);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &out);
    applyCommonCurlOpts(curl);
    // Было 10с — на некоторых сетях запрос к CurseForge (за Cloudflare) не
    // укладывался в этот срок и валился по таймауту ещё до получения ответа,
    // хотя сервер в итоге бы ответил. 15с даёт больше шансов дождаться ответа,
    // а withRetries ниже всё равно переспрашивает при неудаче.
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) { errorOut = std::string("ERR_NETWORK||") + curl_easy_strerror(res); return false; }
    if (httpCode < 200 || httpCode >= 300) {
        // ВАЖНО: раньше в ошибку попадал только код ответа, без тела — а тело
        // как раз обычно содержит причину ("Invalid API Key", "Forbidden",
        // "Rate limit exceeded" и т.п.). Без этого текста бэкенд молча
        // "терял" моды с CurseForge (фронтенд просто получал пустой список),
        // и было невозможно отличить "мода правда нет" от "ключ/лимит
        // сломаны". Добавляем короткий фрагмент тела ответа в текст ошибки.
        std::string bodySnippet = out.size() > 200 ? out.substr(0, 200) : out;
        errorOut = "ERR_HTTP_STATUS||HTTP " + std::to_string(httpCode) + " (" + url + ")" +
                   (bodySnippet.empty() ? "" : (": " + bodySnippet));
        return false;
    }
    return true;
}

bool httpGetStringWithHeader(const std::string& url, const std::string& headerLine,
                              std::string& out, std::string& errorOut) {
    return withRetries([&](std::string& attemptError) {
        return httpGetStringOnceWithHeader(url, headerLine, out, attemptError);
    }, 4, errorOut);
}

// resumeFrom > 0 — докачиваем уже частично скачанный .part-файл с того места,
// где оборвались, вместо того чтобы начинать заново. Особенно важно для
// больших файлов (ассеты, JDK, Java runtime): раньше любой сетевой сбой типа
// "Failure when receiving data from the peer" на 190-мегабайтном файле
// заставлял качать его с нуля заново все 4 попытки — на нестабильной сети
// это могло вообще никогда не завершиться. httpDownloadFile (обёртка ниже)
// сама определяет, сколько уже лежит в .part, и передаёт это сюда.
//
// lowSpeedTimeSec — сколько секунд подряд скорость может держаться ниже
// ~200 байт/с, прежде чем curl решит, что соединение зависло, и оборвёт
// попытку. Значение по умолчанию (90с) специально очень терпеливое — это
// нужно для ассетов/библиотек Mojang, которые часть провайдеров реально
// дросселирует (но закачка всё равно ползёт и в итоге доедет). Для менее
// критичных источников (например, зеркала вроде BMCLAPI/Adoptium, у которых
// есть разумная альтернатива в виде повторной попытки) стоит передавать
// значение поменьше, чтобы не создавать впечатление "зависания" на 15+ минут.
// absoluteTimeoutSec — жёсткий потолок на ОДНУ попытку целиком (0 = без
// потолка, как раньше — нужно для больших файлов вроде ассетов/библиотек
// Mojang, где длинная, но живая закачка — это нормально). CONNECTTIMEOUT и
// LOW_SPEED_TIME в теории должны сами обрывать все "зависшие" случаи, но на
// практике попадались отчёты про соединения, которые не попадают ни под
// одно из этих условий (например, TLS-хендшейк подвисает уже после того,
// как TCP-коннект технически установился) — тогда закачка просто "висела"
// без ошибки и без прогресса. absoluteTimeoutSec — предохранитель именно от
// этого: используется для небольших файлов с известным разумным потолком
// времени (установщик OptiFine, portable JDK), где долгая закачка и так не
// ожидается.
bool httpDownloadFileOnce(const std::string& url, const fs::path& destPath, std::string& errorOut,
                           curl_off_t resumeFrom = 0, long connectTimeoutSec = 30, long lowSpeedTimeSec = 90,
                           long absoluteTimeoutSec = 0) {
    std::error_code ec;
    fs::create_directories(destPath.parent_path(), ec);

    fs::path tmpPath = destPath;
    tmpPath += ".part";

    {
        std::ios::openmode mode = std::ios::binary | (resumeFrom > 0 ? std::ios::app : std::ios::trunc);
        std::ofstream out(tmpPath, mode);
        if (!out) { errorOut = "Не удалось создать файл " + tmpPath.string(); return false; }

        CURL* curl = curl_easy_init();
        if (!curl) { errorOut = "curl_easy_init failed"; return false; }

        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeToFile);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &out);
        applyCommonCurlOpts(curl);
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, connectTimeoutSec);
        curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
        curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, abortIfCancelledCallback);
        // Некоторые зеркала (BMCLAPI, GitHub releases за Adoptium) время от
        // времени рвут HTTP/2-стримы посреди передачи — это и проявлялось как
        // "Failure when receiving data from the peer". HTTP/1.1 стабильнее
        // именно для длинных однопоточных закачек больших файлов.
        curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
        // Вместо жёсткого потолка на всю передачу (раньше CURLOPT_TIMEOUT=120с —
        // на медленной сети большой файл мог не успеть докачаться и посреди
        // прогресса) прерываем только настоящий "зависший" коннект.
        curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 200L);
        curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, lowSpeedTimeSec);
        if (absoluteTimeoutSec > 0) {
            curl_easy_setopt(curl, CURLOPT_TIMEOUT, absoluteTimeoutSec);
        }

        if (resumeFrom > 0) {
            curl_easy_setopt(curl, CURLOPT_RESUME_FROM_LARGE, resumeFrom);
        }

        CURLcode res = curl_easy_perform(curl);
        long httpCode = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
        curl_easy_cleanup(curl);

        if (res != CURLE_OK) { errorOut = std::string("ERR_NETWORK||") + curl_easy_strerror(res); return false; }

        // Докачку просили (Range), а сервер её не поддержал и прислал файл
        // заново с нуля (код 200 вместо 206) — то, что мы дописали поверх
        // старого .part, теперь битый мусор. Удаляем .part целиком, чтобы
        // следующая попытка (уже без resumeFrom, raз файла больше нет)
        // началась честно с чистого листа, а не продолжила портить файл.
        if (resumeFrom > 0 && httpCode == 200) {
            out.close();
            fs::remove(tmpPath, ec);
            errorOut = "Сервер не поддержал докачку файла, начинаем заново";
            return false;
        }
        // 416 Range Not Satisfiable — офсет в .part не совпадает с тем, что
        // реально есть на сервере (например, .part остался от давней неудачной
        // попытки и уже не соответствует текущему файлу, или его размер
        // почему-то оказался БОЛЬШЕ настоящего). Раньше это просто валило
        // загрузку с голым "HTTP 416" — на деле это всегда чинится тем же
        // способом: выкинуть подозрительный .part и красиво перекачать с нуля.
        if (resumeFrom > 0 && httpCode == 416) {
            out.close();
            fs::remove(tmpPath, ec);
            errorOut = "Докачка не подошла (416), начинаем закачку заново";
            return false;
        }
        if (httpCode < 200 || httpCode >= 300) {
            errorOut = "ERR_HTTP_STATUS||HTTP " + std::to_string(httpCode) + " (" + url + ")";
            return false;
        }
    }

    fs::remove(destPath, ec);
    fs::rename(tmpPath, destPath, ec);
    if (ec) { errorOut = "Не удалось переименовать временный файл: " + ec.message(); return false; }
    return true;
}

bool httpDownloadFile(const std::string& url, const fs::path& destPath, std::string& errorOut,
                       int maxAttempts = 8, const std::function<void(int, int)>& onRetry = nullptr,
                       long connectTimeoutSec = 30, long lowSpeedTimeSec = 90, long absoluteTimeoutSec = 0) {
    fs::path tmpPath = destPath;
    tmpPath += ".part";

    return withRetries([&](std::string& attemptError) {
        std::error_code sizeEc;
        curl_off_t resumeFrom = 0;
        if (fs::exists(tmpPath, sizeEc)) {
            resumeFrom = (curl_off_t)fs::file_size(tmpPath, sizeEc);
            if (sizeEc) resumeFrom = 0;
        }
        return httpDownloadFileOnce(url, destPath, attemptError, resumeFrom, connectTimeoutSec, lowSpeedTimeSec, absoluteTimeoutSec);
    }, maxAttempts, errorOut, onRetry);
}

// ============================================
// Диагностика запуска java.exe
// ============================================

std::string winErrorMessage(DWORD code) {
    LPSTR buf = nullptr;
    DWORD len = FormatMessageA(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT), (LPSTR)&buf, 0, nullptr);
    std::string msg = (len && buf) ? std::string(buf, len) : "";
    if (buf) LocalFree(buf);
    while (!msg.empty() && (msg.back() == '\n' || msg.back() == '\r')) msg.pop_back();
    return msg;
}

// Ищет java.exe уже установленную в системе: сначала через PATH, потом по
// типовым папкам установки JDK.
std::optional<fs::path> findFallbackJava() {
    char buf[MAX_PATH];
    if (SearchPathA(nullptr, "java.exe", nullptr, MAX_PATH, buf, nullptr) > 0) {
        return fs::path(buf);
    }

    const char* roots[] = {
        "C:\\Program Files\\Java",
        "C:\\Program Files\\Eclipse Adoptium",
        "C:\\Program Files\\Microsoft",
        "C:\\Program Files (x86)\\Java",
    };

    std::optional<fs::path> best;
    for (const char* root : roots) {
        std::error_code ec;
        if (!fs::exists(root, ec)) continue;
        for (auto& entry : fs::directory_iterator(root, ec)) {
            fs::path candidate = entry.path() / "bin" / "java.exe";
            std::error_code existsEc;
            if (fs::exists(candidate, existsEc)) {
                best = candidate;
            }
        }
    }
    return best;
}

// Запускает "java -version" и парсит major-версию из stderr (java пишет
// версию именно туда, не в stdout). Нужно, чтобы не подсунуть игре, скажем,
// системную Java 8 вместо требуемой Java 21/25 — иначе игра просто не
// запустится с невнятной ошибкой JVM про несовместимую версию класса.
// Возвращает -1, если версию определить не удалось.
//
// ВАЖНО: раньше это делалось через _popen(), а не через CreateProcessA —
// _popen на Windows в GUI-приложении (сабсистем WINDOWS, без своей консоли)
// сам создаёт для дочернего процесса новую консоль и никак не даёт её
// скрыть, поэтому при каждой проверке версии Java на долю секунды мелькало
// чёрное окно. CreateProcessA с CREATE_NO_WINDOW/SW_HIDE и перенаправлением
// вывода в анонимный pipe даёт тот же результат (текст "java -version"),
// но без какого-либо видимого окна — тем же способом, каким уже запускаются
// javac/java для установки OptiFine и инсталлятор Forge (см. выше).
int detectJavaMajorVersion(const fs::path& javaExe) {
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(SECURITY_ATTRIBUTES);
    sa.bInheritHandle = TRUE;
    sa.lpSecurityDescriptor = nullptr;

    HANDLE hReadPipe = nullptr, hWritePipe = nullptr;
    if (!CreatePipe(&hReadPipe, &hWritePipe, &sa, 0)) return -1;
    // Читающий конец не должен наследоваться дочерним процессом — иначе он
    // никогда не закроет свою копию хэндла и ReadFile ниже не дождётся EOF.
    SetHandleInformation(hReadPipe, HANDLE_FLAG_INHERIT, 0);

    std::string cmdLine = "\"" + javaExe.string() + "\" -version";
    std::vector<char> cmdBuf(cmdLine.begin(), cmdLine.end());
    cmdBuf.push_back('\0');

    STARTUPINFOA si{}; si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = hWritePipe;
    si.hStdError = hWritePipe;
    si.hStdInput = nullptr;

    PROCESS_INFORMATION pi{};
    BOOL ok = CreateProcessA(nullptr, cmdBuf.data(), nullptr, nullptr, TRUE,
                              CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
    CloseHandle(hWritePipe); // родителю больше не нужен пишущий конец — иначе ReadFile не увидит EOF

    if (!ok) { CloseHandle(hReadPipe); return -1; }

    std::string output;
    char buf[512];
    DWORD bytesRead = 0;
    while (ReadFile(hReadPipe, buf, sizeof(buf), &bytesRead, nullptr) && bytesRead > 0) {
        output.append(buf, bytesRead);
    }
    WaitForSingleObject(pi.hProcess, 5000);
    CloseHandle(hReadPipe);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    size_t verPos = output.find("version \"");
    if (verPos == std::string::npos) return -1;
    verPos += 9;
    size_t verEnd = output.find('"', verPos);
    if (verEnd == std::string::npos) return -1;
    std::string verStr = output.substr(verPos, verEnd - verPos);

    try {
        // Старый формат версий: "1.8.0_411" -> Java 8.
        if (verStr.rfind("1.", 0) == 0) {
            size_t dotPos = verStr.find('.', 2);
            if (dotPos == std::string::npos) return -1;
            return std::stoi(verStr.substr(2, dotPos - 2));
        }
        // Новый формат: "21.0.4" -> Java 21, "25" -> Java 25.
        size_t dotPos = verStr.find('.');
        std::string majorStr = (dotPos == std::string::npos) ? verStr : verStr.substr(0, dotPos);
        return std::stoi(majorStr);
    } catch (...) {
        return -1;
    }
}

// ============================================
// Автозагрузка portable Java runtime от Mojang — то же самое, что делает
// официальный лаунчер и TLauncher: скачивает готовую сборку JRE под нужную
// версию игры (component берётся из version.json -> javaVersion.component)
// в свою изолированную папку внутри gameDir/runtime, без установки в систему.
// Индекс всех доступных рантаймов Mojang публикует по постоянному URL:
// https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json
// ============================================
bool ensureBundledJavaRuntime(const std::string& component, const fs::path& runtimeRoot,
                               const ProgressFn& onProgress, fs::path& javaExeOut, std::string& errorOut) {
    fs::path componentDir = runtimeRoot / component;
    fs::path javaExe = componentDir / "bin" / "java.exe";
    fs::path markerFile = componentDir / ".installed";

    // Уже скачано раньше — переиспользуем, не качаем повторно (маркер
    // ставится только после успешной полной загрузки всех файлов рантайма).
    if (fs::exists(javaExe) && fs::exists(markerFile)) {
        javaExeOut = javaExe;
        return true;
    }

    onProgress("java", 0.0, "Определяем нужную версию Java...");

    std::string indexRaw;
    if (!httpGetString(
        "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json",
        indexRaw, errorOut)) return false;

    json index;
    try { index = json::parse(indexRaw); }
    catch (const std::exception& e) { errorOut = std::string("ERR_JAVA_INDEX||") + e.what(); return false; }

    // Windows x64 — единственная целевая платформа этой сборки лаунчера (см. CMakeLists.txt).
    if (!index.contains("windows-x64") || !index["windows-x64"].contains(component) ||
        index["windows-x64"][component].empty()) {
        errorOut = "ERR_JAVA_NO_BUILD||" + component;
        return false;
    }

    std::string manifestUrl = index["windows-x64"][component][0]["manifest"].value("url", "");
    if (manifestUrl.empty()) { errorOut = "ERR_JAVA_INDEX||empty manifest url"; return false; }

    onProgress("java", 0.0, "Загружаем список файлов Java...");
    std::string manifestRaw;
    if (!httpGetString(manifestUrl, manifestRaw, errorOut)) return false;

    json manifest;
    try { manifest = json::parse(manifestRaw); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать манифест Java: ") + e.what(); return false; }

    if (!manifest.contains("files")) { errorOut = "В манифесте Java нет списка файлов"; return false; }

    size_t total = manifest["files"].size();
    size_t idx = 0;
    for (auto it = manifest["files"].begin(); it != manifest["files"].end(); ++it) {
        idx++;
        if (!waitWhilePausedOrCancelled(errorOut)) return false;

        std::string relPath = it.key();
        const json& entry = it.value();
        std::string type = entry.value("type", "file");
        fs::path dest = componentDir / relPath;

        if (type == "directory") {
            fs::create_directories(dest);
            continue;
        }
        if (type == "link") {
            // Символические ссылки в манифестах Windows-рантаймов практически
            // не встречаются (это в основном macOS/Linux-специфика) — пропускаем.
            continue;
        }

        if ((idx % 15) == 0 || idx == total) {
            onProgress("java", (double)idx / (double)std::max<size_t>(1, total), "Загружаем Java...");
        }

        if (!entry.contains("downloads") || !entry["downloads"].contains("raw")) continue;
        const auto& raw = entry["downloads"]["raw"];

        fs::path tmpDest = dest;
        if (fs::exists(tmpDest)) continue; // уже скачан этот конкретный файл — не перекачиваем

        if (!httpDownloadFile(raw.value("url", ""), dest, errorOut)) return false;
    }

    if (!fs::exists(javaExe)) {
        errorOut = "ERR_JAVA_MISSING_EXE||" + javaExe.string();
        return false;
    }

    { std::ofstream marker(markerFile, std::ios::binary); marker << "ok"; }

    javaExeOut = javaExe;
    return true;
}

// ============================================
// SHA1 — нужен для проверки целостности уже скачанных файлов (Mojang для
// каждого файла в манифестах присылает эталонный sha1).
// ============================================
struct Sha1Ctx {
    uint32_t state[5];
    uint32_t count[2];
    uint8_t buffer[64];
};

void sha1Transform(uint32_t state[5], const uint8_t buffer[64]) {
    uint32_t a, b, c, d, e, block[80];
    for (int i = 0; i < 16; i++)
        block[i] = (uint32_t)buffer[i*4] << 24 | (uint32_t)buffer[i*4+1] << 16 |
                   (uint32_t)buffer[i*4+2] << 8 | (uint32_t)buffer[i*4+3];
    for (int i = 16; i < 80; i++) {
        uint32_t v = block[i-3] ^ block[i-8] ^ block[i-14] ^ block[i-16];
        block[i] = (v << 1) | (v >> 31);
    }
    a = state[0]; b = state[1]; c = state[2]; d = state[3]; e = state[4];
    auto rol = [](uint32_t v, int s) { return (v << s) | (v >> (32 - s)); };
    for (int i = 0; i < 80; i++) {
        uint32_t f, k;
        if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        uint32_t temp = rol(a, 5) + f + e + k + block[i];
        e = d; d = c; c = rol(b, 30); b = a; a = temp;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e;
}

std::string sha1HexOfFile(const fs::path& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return "";

    Sha1Ctx ctx;
    ctx.state[0]=0x67452301; ctx.state[1]=0xEFCDAB89; ctx.state[2]=0x98BADCFE;
    ctx.state[3]=0x10325476; ctx.state[4]=0xC3D2E1F0;
    ctx.count[0]=ctx.count[1]=0;

    uint64_t totalBits = 0;
    uint8_t buf[64];
    size_t bufLen = 0;

    char chunk[8192];
    while (in.read(chunk, sizeof(chunk)) || in.gcount() > 0) {
        std::streamsize got = in.gcount();
        totalBits += (uint64_t)got * 8;
        size_t offset = 0;
        while (offset < (size_t)got) {
            size_t toCopy = std::min((size_t)64 - bufLen, (size_t)got - offset);
            std::memcpy(buf + bufLen, chunk + offset, toCopy);
            bufLen += toCopy; offset += toCopy;
            if (bufLen == 64) { sha1Transform(ctx.state, buf); bufLen = 0; }
        }
    }

    // ВАЖНО: здесь раньше происходило переполнение stack-buffer.
    // Если остаток файла был >= 56 байт, padLen мог быть до 64, а buf имел
    // только 64 байта. В итоге запись выходила за границы buf и повреждала
    // соседние локальные переменные (в Debug это проявлялось как:
    // "Run-Time Check Failure #2 - Stack around the variable 'chunk' was corrupted").
    //
    // Для финального блока SHA-1 нужен максимум 128 байт: текущий остаток +
    // padding + 64-битная длина.
    uint8_t finalBuf[128] = {};
    std::memcpy(finalBuf, buf, bufLen);

    size_t finalLen = bufLen;
    finalBuf[finalLen++] = 0x80;

    while ((finalLen % 64) != 56)
        finalBuf[finalLen++] = 0;

    for (int i = 0; i < 8; i++)
        finalBuf[finalLen++] = (uint8_t)(totalBits >> (56 - 8*i));

    for (size_t off = 0; off < finalLen; off += 64)
        sha1Transform(ctx.state, finalBuf + off);

    char hex[41];
    for (int i = 0; i < 5; i++)
        snprintf(hex + i*8, 9, "%08x", ctx.state[i]);
    return std::string(hex, 40);
}

bool fileMatchesSha1(const fs::path& path, const std::string& expectedSha1) {
    if (expectedSha1.empty()) return fs::exists(path);
    if (!fs::exists(path)) return false;
    std::string actual = sha1HexOfFile(path);
    std::string exp = expectedSha1;
    std::transform(exp.begin(), exp.end(), exp.begin(), ::tolower);
    std::transform(actual.begin(), actual.end(), actual.begin(), ::tolower);
    return actual == exp;
}

bool ensureFile(const std::string& url, const fs::path& destPath, const std::string& expectedSha1, std::string& errorOut) {
    if (fileMatchesSha1(destPath, expectedSha1)) return true;
    return httpDownloadFile(url, destPath, errorOut);
}

// ============================================
// Мини-ZIP-ридер (только чтение) — извлекает нативные .dll из библиотек LWJGL.
// ============================================
bool extractZipFlatIgnoringDirsAndMeta(const fs::path& zipPath, const fs::path& outDir) {
    std::ifstream in(zipPath, std::ios::binary);
    if (!in) return false;

    in.seekg(0, std::ios::end);
    std::streamoff fileSize = in.tellg();
    if (fileSize < 22) return false;

    std::streamoff searchStart = std::max<std::streamoff>(0, fileSize - 66000);
    in.seekg(searchStart);
    std::vector<char> tail((size_t)(fileSize - searchStart));
    in.read(tail.data(), (std::streamsize)tail.size());

    int eocdPos = -1;
    for (int i = (int)tail.size() - 22; i >= 0; i--) {
        if ((uint8_t)tail[i] == 0x50 && (uint8_t)tail[i+1] == 0x4b &&
            (uint8_t)tail[i+2] == 0x05 && (uint8_t)tail[i+3] == 0x06) { eocdPos = i; break; }
    }
    if (eocdPos < 0) return false;

    auto readU16 = [&](int off) { return (uint16_t)((uint8_t)tail[off] | ((uint8_t)tail[off+1] << 8)); };
    auto readU32 = [&](int off) { return (uint32_t)((uint8_t)tail[off] | ((uint8_t)tail[off+1] << 8) |
                                                      ((uint8_t)tail[off+2] << 16) | ((uint8_t)tail[off+3] << 24)); };

    uint16_t entryCount = readU16(eocdPos + 10);
    uint32_t cdOffset = readU32(eocdPos + 16);

    in.seekg((std::streamoff)cdOffset);
    fs::create_directories(outDir);

    for (uint16_t i = 0; i < entryCount; i++) {
        char hdr[46];
        in.read(hdr, 46);
        if (in.gcount() != 46) break;
        if (!(hdr[0]==0x50 && hdr[1]==0x4b && hdr[2]==0x01 && hdr[3]==0x02)) break;

        uint16_t method = (uint16_t)((uint8_t)hdr[10] | ((uint8_t)hdr[11] << 8));
        uint32_t compSize = (uint32_t)((uint8_t)hdr[20] | ((uint8_t)hdr[21]<<8) | ((uint8_t)hdr[22]<<16) | ((uint8_t)hdr[23]<<24));
        uint32_t uncompSize = (uint32_t)((uint8_t)hdr[24] | ((uint8_t)hdr[25]<<8) | ((uint8_t)hdr[26]<<16) | ((uint8_t)hdr[27]<<24));
        uint16_t nameLen = (uint16_t)((uint8_t)hdr[28] | ((uint8_t)hdr[29]<<8));
        uint16_t extraLen = (uint16_t)((uint8_t)hdr[30] | ((uint8_t)hdr[31]<<8));
        uint16_t commentLen = (uint16_t)((uint8_t)hdr[32] | ((uint8_t)hdr[33]<<8));
        uint32_t localHeaderOffset = (uint32_t)((uint8_t)hdr[42] | ((uint8_t)hdr[43]<<8) | ((uint8_t)hdr[44]<<16) | ((uint8_t)hdr[45]<<24));

        std::string name(nameLen, '\0');
        in.read(name.data(), nameLen);
        in.seekg(extraLen + commentLen, std::ios::cur);

        bool isDir = !name.empty() && name.back() == '/';
        bool isMeta = name.rfind("META-INF/", 0) == 0;

        if (!isDir && !isMeta) {
            std::streamoff cdReturnPos = in.tellg();

            in.seekg((std::streamoff)localHeaderOffset);
            char lhdr[30];
            in.read(lhdr, 30);
            uint16_t lNameLen = (uint16_t)((uint8_t)lhdr[26] | ((uint8_t)lhdr[27]<<8));
            uint16_t lExtraLen = (uint16_t)((uint8_t)lhdr[28] | ((uint8_t)lhdr[29]<<8));
            in.seekg(lNameLen + lExtraLen, std::ios::cur);

            std::vector<char> compData(compSize);
            if (compSize > 0) in.read(compData.data(), compSize);

            fs::path flatName = fs::path(name).filename();
            fs::path outPath = outDir / flatName;

            std::vector<char> outData;
            if (method == 0) {
                outData.assign(compData.begin(), compData.end());
            } else if (method == 8) {
                outData.resize(uncompSize);
                z_stream zs{};
                inflateInit2(&zs, -MAX_WBITS);
                zs.next_in = (Bytef*)compData.data();
                zs.avail_in = (uInt)compData.size();
                zs.next_out = (Bytef*)outData.data();
                zs.avail_out = (uInt)outData.size();
                inflate(&zs, Z_FINISH);
                inflateEnd(&zs);
            } else {
                in.seekg(cdReturnPos);
                continue;
            }

            std::ofstream outFile(outPath, std::ios::binary | std::ios::trunc);
            if (outFile) outFile.write(outData.data(), (std::streamsize)outData.size());

            in.seekg(cdReturnPos);
        }
    }
    return true;
}

// ============================================
// Полная распаковка zip с сохранением структуры каталогов — в отличие от
// extractZipFlatIgnoringDirsAndMeta (которая специально "плющит" всё в одну
// папку, это нужно для нативных .dll из библиотек LWJGL), тут нужен честный
// vендерево — используется для распаковки скачанного portable JDK
// (см. ensureJdkForOptifineStub ниже), у которого важна структура bin/, lib/ и т.п.
// ============================================
bool extractZipPreservingStructure(const fs::path& zipPath, const fs::path& outDir, std::string& errorOut) {
    std::ifstream in(zipPath, std::ios::binary);
    if (!in) { errorOut = "Не удалось открыть архив " + zipPath.string(); return false; }

    in.seekg(0, std::ios::end);
    std::streamoff fileSize = in.tellg();
    if (fileSize < 22) { errorOut = "Архив повреждён (слишком маленький файл)"; return false; }

    std::streamoff searchStart = std::max<std::streamoff>(0, fileSize - 66000);
    in.seekg(searchStart);
    std::vector<char> tail((size_t)(fileSize - searchStart));
    in.read(tail.data(), (std::streamsize)tail.size());

    int eocdPos = -1;
    for (int i = (int)tail.size() - 22; i >= 0; i--) {
        if ((uint8_t)tail[i] == 0x50 && (uint8_t)tail[i+1] == 0x4b &&
            (uint8_t)tail[i+2] == 0x05 && (uint8_t)tail[i+3] == 0x06) { eocdPos = i; break; }
    }
    if (eocdPos < 0) { errorOut = "Не найден конец центрального каталога zip (EOCD)"; return false; }

    auto readU16 = [&](int off) { return (uint16_t)((uint8_t)tail[off] | ((uint8_t)tail[off+1] << 8)); };
    auto readU32 = [&](int off) { return (uint32_t)((uint8_t)tail[off] | ((uint8_t)tail[off+1] << 8) |
                                                      ((uint8_t)tail[off+2] << 16) | ((uint8_t)tail[off+3] << 24)); };

    uint16_t entryCount = readU16(eocdPos + 10);
    uint32_t cdOffset = readU32(eocdPos + 16);

    in.seekg((std::streamoff)cdOffset);
    fs::create_directories(outDir);

    for (uint16_t i = 0; i < entryCount; i++) {
        char hdr[46];
        in.read(hdr, 46);
        if (in.gcount() != 46) break;
        if (!(hdr[0]==0x50 && hdr[1]==0x4b && hdr[2]==0x01 && hdr[3]==0x02)) break;

        uint16_t method = (uint16_t)((uint8_t)hdr[10] | ((uint8_t)hdr[11] << 8));
        uint32_t compSize = (uint32_t)((uint8_t)hdr[20] | ((uint8_t)hdr[21]<<8) | ((uint8_t)hdr[22]<<16) | ((uint8_t)hdr[23]<<24));
        uint32_t uncompSize = (uint32_t)((uint8_t)hdr[24] | ((uint8_t)hdr[25]<<8) | ((uint8_t)hdr[26]<<16) | ((uint8_t)hdr[27]<<24));
        uint16_t nameLen = (uint16_t)((uint8_t)hdr[28] | ((uint8_t)hdr[29]<<8));
        uint16_t extraLen = (uint16_t)((uint8_t)hdr[30] | ((uint8_t)hdr[31]<<8));
        uint16_t commentLen = (uint16_t)((uint8_t)hdr[32] | ((uint8_t)hdr[33]<<8));
        uint32_t localHeaderOffset = (uint32_t)((uint8_t)hdr[42] | ((uint8_t)hdr[43]<<8) | ((uint8_t)hdr[44]<<16) | ((uint8_t)hdr[45]<<24));

        std::string name(nameLen, '\0');
        in.read(name.data(), nameLen);
        in.seekg(extraLen + commentLen, std::ios::cur);

        // Zip-слеши всегда '/', даже на Windows — приводим к нативному разделителю.
        std::string normalized = name;
        std::replace(normalized.begin(), normalized.end(), '\\', '/');
        bool isDir = !normalized.empty() && normalized.back() == '/';

        fs::path outPath = outDir / fs::path(normalized);

        if (isDir) {
            std::error_code ec;
            fs::create_directories(outPath, ec);
            continue;
        }

        std::streamoff cdReturnPos = in.tellg();

        in.seekg((std::streamoff)localHeaderOffset);
        char lhdr[30];
        in.read(lhdr, 30);
        uint16_t lNameLen = (uint16_t)((uint8_t)lhdr[26] | ((uint8_t)lhdr[27]<<8));
        uint16_t lExtraLen = (uint16_t)((uint8_t)lhdr[28] | ((uint8_t)lhdr[29]<<8));
        in.seekg(lNameLen + lExtraLen, std::ios::cur);

        std::vector<char> compData(compSize);
        if (compSize > 0) in.read(compData.data(), compSize);

        std::vector<char> outData;
        if (method == 0) {
            outData.assign(compData.begin(), compData.end());
        } else if (method == 8) {
            outData.resize(uncompSize);
            z_stream zs{};
            inflateInit2(&zs, -MAX_WBITS);
            zs.next_in = (Bytef*)compData.data();
            zs.avail_in = (uInt)compData.size();
            zs.next_out = (Bytef*)outData.data();
            zs.avail_out = (uInt)outData.size();
            inflate(&zs, Z_FINISH);
            inflateEnd(&zs);
        } else {
            in.seekg(cdReturnPos);
            continue; // неизвестный метод сжатия — пропускаем этот файл, не валим всю распаковку
        }

        std::error_code ec;
        fs::create_directories(outPath.parent_path(), ec);
        std::ofstream outFile(outPath, std::ios::binary | std::ios::trunc);
        if (outFile) outFile.write(outData.data(), (std::streamsize)outData.size());

        in.seekg(cdReturnPos);
    }
    return true;
}

// ============================================
// Оценка "rules" (allow/disallow по ОС)
// ============================================
bool rulesAllowWindows(const json& rules) {
    if (!rules.is_array()) return true;
    bool allowed = false;
    for (const auto& rule : rules) {
        bool applies = true;
        if (rule.contains("os")) {
            std::string osName = rule["os"].value("name", "");
            if (!osName.empty() && osName != "windows") applies = false;
        }
        if (rule.contains("features")) {
            applies = false;
        }
        if (applies) {
            std::string action = rule.value("action", "allow");
            allowed = (action == "allow");
        }
    }
    return allowed;
}

std::string substitutePlaceholders(const std::string& tmpl, const std::vector<std::pair<std::string,std::string>>& vars) {
    std::string result = tmpl;
    for (const auto& [key, val] : vars) {
        std::string placeholder = "${" + key + "}";
        size_t pos;
        while ((pos = result.find(placeholder)) != std::string::npos)
            result.replace(pos, placeholder.size(), val);
    }
    return result;
}

std::string md5Hex(const std::string& input) {
    auto LEFTROTATE = [](uint32_t x, uint32_t c) { return (x << c) | (x >> (32 - c)); };
    static const uint32_t K[64] = {
        0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
        0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
        0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
        0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
        0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
        0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
        0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
        0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391
    };
    static const uint32_t S[64] = {
        7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
        5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
        4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
        6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
    };
    uint32_t a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;

    std::vector<uint8_t> msg(input.begin(), input.end());
    uint64_t bitLen = (uint64_t)msg.size() * 8;
    msg.push_back(0x80);
    while (msg.size() % 64 != 56) msg.push_back(0);
    for (int i = 0; i < 8; i++) msg.push_back((uint8_t)(bitLen >> (8*i)));

    for (size_t chunk = 0; chunk < msg.size(); chunk += 64) {
        uint32_t M[16];
        for (int i = 0; i < 16; i++)
            M[i] = (uint32_t)msg[chunk+i*4] | ((uint32_t)msg[chunk+i*4+1]<<8) |
                   ((uint32_t)msg[chunk+i*4+2]<<16) | ((uint32_t)msg[chunk+i*4+3]<<24);

        uint32_t A=a0,B=b0,C=c0,D=d0;
        for (uint32_t i = 0; i < 64; i++) {
            uint32_t F; uint32_t g;
            if (i < 16) { F = (B & C) | (~B & D); g = i; }
            else if (i < 32) { F = (D & B) | (~D & C); g = (5*i + 1) % 16; }
            else if (i < 48) { F = B ^ C ^ D; g = (3*i + 5) % 16; }
            else { F = C ^ (B | ~D); g = (7*i) % 16; }
            F = F + A + K[i] + M[g];
            A = D; D = C; C = B;
            B = B + LEFTROTATE(F, S[i]);
        }
        a0+=A; b0+=B; c0+=C; d0+=D;
    }
    uint8_t digest[16];
    uint32_t vals[4] = {a0,b0,c0,d0};
    for (int i = 0; i < 4; i++)
        for (int j = 0; j < 4; j++)
            digest[i*4+j] = (uint8_t)(vals[i] >> (8*j));

    char hex[33];
    for (int i = 0; i < 16; i++) snprintf(hex + i*2, 3, "%02x", digest[i]);
    return std::string(hex, 32);
}

std::string offlineUuidFromUsername(const std::string& username) {
    std::string input = "OfflinePlayer:" + username;
    std::string hex = md5Hex(input);
    std::vector<char> h(hex.begin(), hex.end());
    h[12] = '4';
    int variantNibble = (std::stoi(std::string(1, h[16]), nullptr, 16) & 0x3) | 0x8;
    char variantHexChar = "0123456789abcdef"[variantNibble];
    h[16] = variantHexChar;
    std::string fixedHex(h.begin(), h.end());
    return fixedHex.substr(0,8) + "-" + fixedHex.substr(8,4) + "-" + fixedHex.substr(12,4) + "-" +
           fixedHex.substr(16,4) + "-" + fixedHex.substr(20,12);
}

// ============================================
// Fabric — подтягиваем готовый профиль запуска через официальный
// Fabric Meta API (meta.fabricmc.net).
// ============================================
fs::path mavenCoordToPath(const std::string& coord) {
    std::vector<std::string> parts;
    std::stringstream ss(coord);
    std::string part;
    while (std::getline(ss, part, ':')) parts.push_back(part);
    if (parts.size() < 3) return {};
    std::string group = parts[0], artifact = parts[1], version = parts[2];
    std::string classifier = parts.size() > 3 ? parts[3] : "";
    std::replace(group.begin(), group.end(), '.', '/');
    std::string fileName = artifact + "-" + version + (classifier.empty() ? "" : ("-" + classifier)) + ".jar";
    return fs::path(group) / artifact / version / fileName;
}

bool prepareFabric(const std::string& mcVersion, const fs::path& librariesDir,
                    std::vector<std::string>& classpathEntries, std::string& mainClassOut,
                    std::string& errorOut) {
    std::string loaderListRaw;
    if (!httpGetString("https://meta.fabricmc.net/v2/versions/loader/" + mcVersion, loaderListRaw, errorOut))
        return false;

    json loaderList;
    try { loaderList = json::parse(loaderListRaw); }
    catch (const std::exception& e) { errorOut = std::string("Fabric meta: ") + e.what(); return false; }

    if (!loaderList.is_array() || loaderList.empty()) {
        errorOut = "Fabric не поддерживает версию " + mcVersion + " (пока нет сборки лоадера под неё)";
        return false;
    }

    std::string loaderVersion;
    for (const auto& entry : loaderList) {
        if (entry.contains("loader") && entry["loader"].value("stable", true)) {
            loaderVersion = entry["loader"].value("version", "");
            break;
        }
    }
    if (loaderVersion.empty()) loaderVersion = loaderList[0]["loader"].value("version", "");
    if (loaderVersion.empty()) { errorOut = "Не удалось определить версию Fabric Loader"; return false; }

    std::string profileUrl = "https://meta.fabricmc.net/v2/versions/loader/" + mcVersion + "/" + loaderVersion + "/profile/json";
    std::string profileRaw;
    if (!httpGetString(profileUrl, profileRaw, errorOut)) return false;

    json profile;
    try { profile = json::parse(profileRaw); }
    catch (const std::exception& e) { errorOut = std::string("Fabric profile: ") + e.what(); return false; }

    mainClassOut = profile.value("mainClass", "net.fabricmc.loader.impl.launch.knot.KnotClient");

    if (profile.contains("libraries")) {
        for (const auto& lib : profile["libraries"]) {
            if (!waitWhilePausedOrCancelled(errorOut)) return false;

            std::string name = lib.value("name", "");
            std::string repoUrl = lib.value("url", "https://maven.fabricmc.net/");
            if (name.empty()) continue;
            if (!repoUrl.empty() && repoUrl.back() != '/') repoUrl += "/";

            fs::path relPath = mavenCoordToPath(name);
            if (relPath.empty()) continue;

            fs::path dest = librariesDir / relPath;
            std::string url = repoUrl + relPath.generic_string();

            if (!ensureFile(url, dest, "", errorOut)) return false;
            classpathEntries.push_back(dest.string());
        }
    }
    return true;
}

bool prepareQuilt(const std::string& mcVersion, const fs::path& librariesDir,
                   std::vector<std::string>& classpathEntries, std::string& mainClassOut,
                   std::string& errorOut) {
    std::string loaderListRaw;
    if (!httpGetString("https://meta.quiltmc.org/v3/versions/loader/" + mcVersion, loaderListRaw, errorOut))
        return false;

    json loaderList;
    try { loaderList = json::parse(loaderListRaw); }
    catch (const std::exception& e) { errorOut = std::string("Quilt meta: ") + e.what(); return false; }

    if (!loaderList.is_array() || loaderList.empty()) {
        errorOut = "Quilt не поддерживает версию " + mcVersion + " (пока нет сборки лоадера под неё)";
        return false;
    }

    const json& best = loaderList[0];
    std::string loaderMaven = best["loader"].value("maven", "");
    if (loaderMaven.empty()) { errorOut = "Не удалось определить версию Quilt Loader"; return false; }

    fs::path loaderRelPath = mavenCoordToPath(loaderMaven);
    if (!loaderRelPath.empty()) {
        fs::path loaderDest = librariesDir / loaderRelPath;
        std::string loaderUrl = "https://maven.quiltmc.org/repository/release/" + loaderRelPath.generic_string();
        if (!ensureFile(loaderUrl, loaderDest, "", errorOut)) return false;
        classpathEntries.push_back(loaderDest.string());
    }

    mainClassOut = "org.quiltmc.loader.impl.launch.knot.KnotClient";
    if (best.contains("launcherMeta")) {
        const auto& lm = best["launcherMeta"];
        if (lm.contains("mainClass")) {
            if (lm["mainClass"].is_string()) mainClassOut = lm["mainClass"].get<std::string>();
            else if (lm["mainClass"].is_object()) mainClassOut = lm["mainClass"].value("client", mainClassOut);
        }
        if (lm.contains("libraries")) {
            for (const char* group : {"common", "client"}) {
                if (!lm["libraries"].contains(group)) continue;
                for (const auto& lib : lm["libraries"][group]) {
                    if (!waitWhilePausedOrCancelled(errorOut)) return false;

                    std::string name = lib.value("name", "");
                    std::string repoUrl = lib.value("url", "https://maven.quiltmc.org/repository/release/");
                    if (name.empty()) continue;
                    if (!repoUrl.empty() && repoUrl.back() != '/') repoUrl += "/";

                    fs::path relPath = mavenCoordToPath(name);
                    if (relPath.empty()) continue;

                    fs::path dest = librariesDir / relPath;
                    std::string url = repoUrl + relPath.generic_string();

                    if (!ensureFile(url, dest, "", errorOut)) return false;
                    classpathEntries.push_back(dest.string());
                }
            }
        }
    }
    return true;
}

// ============================================
// Простой синхронный запуск процесса с ожиданием короткими интервалами
// (чтобы "Отмена" могла прервать и его), плюс перенаправление stdout/stderr
// в лог-файл — используется установщиком Forge и (ниже) хелпером OptiFine.
// ============================================
bool runProcessSyncWithLog(const std::string& cmdLine, const fs::path& workDir, const fs::path& logPath,
                            DWORD& exitCodeOut, std::string& errorOut, DWORD maxWaitMs = 120000) {
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    HANDLE hLog = CreateFileA(logPath.string().c_str(), GENERIC_WRITE, FILE_SHARE_READ,
                               &sa, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);

    std::vector<char> cmdBuf(cmdLine.begin(), cmdLine.end());
    cmdBuf.push_back('\0');

    STARTUPINFOA si{}; si.cb = sizeof(si);
    bool haveLog = (hLog != INVALID_HANDLE_VALUE);
    if (haveLog) {
        si.dwFlags |= STARTF_USESTDHANDLES;
        si.hStdOutput = hLog;
        si.hStdError = hLog;
    }
    // CREATE_NO_WINDOW само по себе иногда не до конца подавляет консоль у
    // консольных приложений (javac.exe/java.exe оба собраны под консольный
    // сабсистем) — на некоторых системах она всё равно мелькает на долю
    // секунды перед закрытием. STARTF_USESHOWWINDOW + SW_HIDE — стандартная
    // "подстраховка" поверх CREATE_NO_WINDOW, убирающая и это мелькание.
    si.dwFlags |= STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi{};
    BOOL ok = CreateProcessA(nullptr, cmdBuf.data(), nullptr, nullptr, haveLog ? TRUE : FALSE,
                              CREATE_NO_WINDOW, nullptr, workDir.string().c_str(), &si, &pi);
    if (haveLog) CloseHandle(hLog);

    if (!ok) {
        DWORD err = GetLastError();
        errorOut = "Не удалось запустить процесс: " + winErrorMessage(err) + " (код " + std::to_string(err) + ")";
        return false;
    }

    DWORD waited = 0;
    for (;;) {
        DWORD waitResult = WaitForSingleObject(pi.hProcess, 300);
        if (waitResult == WAIT_OBJECT_0) { GetExitCodeProcess(pi.hProcess, &exitCodeOut); break; }
        if (g_cancelled.load()) {
            TerminateProcess(pi.hProcess, 1);
            WaitForSingleObject(pi.hProcess, 2000);
            CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
            errorOut = "CANCELLED";
            return false;
        }
        waited += 300;
        if (maxWaitMs > 0 && waited >= maxWaitMs) {
            TerminateProcess(pi.hProcess, 1);
            WaitForSingleObject(pi.hProcess, 2000);
            CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
            errorOut = "ERR_PROCESS_TIMEOUT";
            return false;
        }
    }
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    return true;
}

std::string readLogTail(const fs::path& logPath, size_t maxChars = 2000) {
    std::ifstream logFile(logPath, std::ios::binary);
    if (!logFile) return "";
    std::stringstream ss; ss << logFile.rdbuf();
    std::string full = ss.str();
    return full.size() > maxChars ? full.substr(full.size() - maxChars) : full;
}

// ============================================
// Forge — используем ОФИЦИАЛЬНЫЙ инсталлятор Forge в тихом режиме
// (--installClient <dir>), а не пытаемся переизобретать его "processors"
// (бинарные патчи клиента, генерацию SRG-имён и т.п. для 1.13+) — это именно
// то, что делает сам инсталлятор внутри себя. Мы просто скачиваем jar
// инсталлятора с maven.minecraftforge.net и запускаем его как процесс.
//
// ОГРАНИЧЕНИЕ: тихий флаг --installClient есть у инсталляторов начиная
// примерно с Forge под MC 1.6 — у совсем древних версий (1.1–1.5.x) единого
// формата инсталлятора с CLI ещё не было, и автоматическая установка для них
// может не сработать. Пользователю в этом случае вернётся понятная ошибка.
// ============================================

// Читает содержимое одного файла (entryName) внутри zip/jar без распаковки
// всего архива на диск — нужен, чтобы достать install_profile.json.
std::optional<std::string> readZipEntryToString(const fs::path& zipPath, const std::string& entryName) {
    std::ifstream in(zipPath, std::ios::binary);
    if (!in) return std::nullopt;

    in.seekg(0, std::ios::end);
    std::streamoff fileSize = in.tellg();
    if (fileSize < 22) return std::nullopt;

    std::streamoff searchStart = std::max<std::streamoff>(0, fileSize - 66000);
    in.seekg(searchStart);
    std::vector<char> tail((size_t)(fileSize - searchStart));
    in.read(tail.data(), (std::streamsize)tail.size());

    int eocdPos = -1;
    for (int i = (int)tail.size() - 22; i >= 0; i--) {
        if ((uint8_t)tail[i] == 0x50 && (uint8_t)tail[i+1] == 0x4b &&
            (uint8_t)tail[i+2] == 0x05 && (uint8_t)tail[i+3] == 0x06) { eocdPos = i; break; }
    }
    if (eocdPos < 0) return std::nullopt;

    auto readU16 = [&](int off) { return (uint16_t)((uint8_t)tail[off] | ((uint8_t)tail[off+1] << 8)); };
    auto readU32 = [&](int off) { return (uint32_t)((uint8_t)tail[off] | ((uint8_t)tail[off+1] << 8) |
                                                      ((uint8_t)tail[off+2] << 16) | ((uint8_t)tail[off+3] << 24)); };

    uint16_t entryCount = readU16(eocdPos + 10);
    uint32_t cdOffset = readU32(eocdPos + 16);

    in.seekg((std::streamoff)cdOffset);

    for (uint16_t i = 0; i < entryCount; i++) {
        char hdr[46];
        in.read(hdr, 46);
        if (in.gcount() != 46) break;
        if (!(hdr[0]==0x50 && hdr[1]==0x4b && hdr[2]==0x01 && hdr[3]==0x02)) break;

        uint16_t method = (uint16_t)((uint8_t)hdr[10] | ((uint8_t)hdr[11] << 8));
        uint32_t compSize = (uint32_t)((uint8_t)hdr[20] | ((uint8_t)hdr[21]<<8) | ((uint8_t)hdr[22]<<16) | ((uint8_t)hdr[23]<<24));
        uint32_t uncompSize = (uint32_t)((uint8_t)hdr[24] | ((uint8_t)hdr[25]<<8) | ((uint8_t)hdr[26]<<16) | ((uint8_t)hdr[27]<<24));
        uint16_t nameLen = (uint16_t)((uint8_t)hdr[28] | ((uint8_t)hdr[29]<<8));
        uint16_t extraLen = (uint16_t)((uint8_t)hdr[30] | ((uint8_t)hdr[31]<<8));
        uint16_t commentLen = (uint16_t)((uint8_t)hdr[32] | ((uint8_t)hdr[33]<<8));
        uint32_t localHeaderOffset = (uint32_t)((uint8_t)hdr[42] | ((uint8_t)hdr[43]<<8) | ((uint8_t)hdr[44]<<16) | ((uint8_t)hdr[45]<<24));

        std::string name(nameLen, '\0');
        in.read(name.data(), nameLen);
        in.seekg(extraLen + commentLen, std::ios::cur);

        if (name == entryName) {
            in.seekg((std::streamoff)localHeaderOffset);
            char lhdr[30];
            in.read(lhdr, 30);
            uint16_t lNameLen = (uint16_t)((uint8_t)lhdr[26] | ((uint8_t)lhdr[27]<<8));
            uint16_t lExtraLen = (uint16_t)((uint8_t)lhdr[28] | ((uint8_t)lhdr[29]<<8));
            in.seekg(lNameLen + lExtraLen, std::ios::cur);

            std::vector<char> compData(compSize);
            if (compSize > 0) in.read(compData.data(), compSize);

            std::string result;
            if (method == 0) {
                result.assign(compData.begin(), compData.end());
            } else if (method == 8) {
                result.resize(uncompSize);
                z_stream zs{};
                inflateInit2(&zs, -MAX_WBITS);
                zs.next_in = (Bytef*)compData.data();
                zs.avail_in = (uInt)compData.size();
                zs.next_out = (Bytef*)result.data();
                zs.avail_out = (uInt)result.size();
                inflate(&zs, Z_FINISH);
                inflateEnd(&zs);
            } else {
                return std::nullopt;
            }
            return result;
        }
    }
    return std::nullopt;
}

// Официальный Forge публикует "рекомендованную"/"последнюю" сборку под
// каждую версию MC в этом json — берём оттуда, чтобы не гадать номер сборки.
bool resolveForgeVersion(const std::string& mcVersion, std::string& forgeVersionOut, std::string& errorOut) {
    std::string raw;
    if (!httpGetString("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json", raw, errorOut))
        return false;

    json data;
    try { data = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать promotions_slim.json: ") + e.what(); return false; }

    if (!data.contains("promos")) { errorOut = "В promotions_slim.json нет поля promos"; return false; }
    const auto& promos = data["promos"];

    std::string recKey = mcVersion + "-recommended";
    std::string latKey = mcVersion + "-latest";

    if (promos.contains(recKey)) { forgeVersionOut = promos[recKey].get<std::string>(); return true; }
    if (promos.contains(latKey)) { forgeVersionOut = promos[latKey].get<std::string>(); return true; }

    errorOut = "ERR_FORGE_NO_BUILD||" + mcVersion;
    return false;
}

bool resolveNeoForgeVersion(const std::string& mcVersion, std::string& neoforgeVersionOut, std::string& errorOut) {
    std::string raw;
    if (!httpGetString("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge", raw, errorOut))
        return false;

    json data;
    try { data = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать список версий NeoForge: ") + e.what(); return false; }

    if (!data.contains("versions") || !data["versions"].is_array()) {
        errorOut = "ERR_NEOFORGE_NO_BUILD||" + mcVersion;
        return false;
    }

    std::string prefix = mcVersion.rfind("1.", 0) == 0 ? mcVersion.substr(2) : mcVersion;
    if (prefix.empty()) { errorOut = "ERR_NEOFORGE_NO_BUILD||" + mcVersion; return false; }
    prefix += ".";

    std::string best;
    for (const auto& v : data["versions"]) {
        if (!v.is_string()) continue;
        std::string ver = v.get<std::string>();
        if (ver.rfind(prefix, 0) == 0) best = ver;
    }

    if (best.empty()) { errorOut = "ERR_NEOFORGE_NO_BUILD||" + mcVersion; return false; }
    neoforgeVersionOut = best;
    return true;
}

// Официальный инсталлятор Forge (net.minecraftforge.installer) перед установкой
// проверяет, что в целевой папке есть launcher_profiles.json — так он убеждается,
// что это действительно рабочая папка Minecraft-лаунчера, а не случайная папка.
// Если файла нет, он падает с "There is no Minecraft launcher profile in ...,
// you need to run the launcher first!" (код возврата 1) — именно эту ошибку
// ловил игрок. Наш лаунчер никогда такой файл не создавал, потому что сам
// ведёт список версий/инстансов по-своему и обычно он ему не нужен — но
// инсталлятору Forge он нужен просто как признак "это папка лаунчера".
// Создаём минимальный валидный файл, если его ещё нет — большего инсталлятору
// не требуется.
void ensureLauncherProfilesFile(const fs::path& root) {
    fs::path profilesPath = root / "launcher_profiles.json";
    if (fs::exists(profilesPath)) return;

    std::error_code ec;
    fs::create_directories(root, ec);

    json profiles;
    profiles["profiles"] = json::object();
    profiles["settings"] = {
        {"enableAdvanced", false},
        {"enableSnapshots", false},
        {"keepLauncherOpen", false},
        {"profileSorting", "ByLastPlayed"},
        {"showGameLog", false},
        {"showMenu", false},
        {"soundOn", false}
    };
    profiles["version"] = 3;

    std::ofstream out(profilesPath, std::ios::binary);
    if (out) out << profiles.dump(2);
}

// Скачивает и запускает официальный инсталлятор Forge в тихом режиме, затем
// вливает получившиеся библиотеки/аргументы/mainClass в ванильный vjson —
// дальше по общему циклу их скачает и запустит как обычно.
bool prepareForge(const std::string& mcVersion, const fs::path& root, const std::string& javaPath,
                   json& vjson, const ProgressFn& onProgress, std::string& errorOut) {
    onProgress("libraries", 0.0, "Определяем версию Forge...");

    // См. комментарий у ensureLauncherProfilesFile выше — без этого файла
    // инсталлятор Forge стабильно отказывался ставиться с кодом 1.
    ensureLauncherProfilesFile(root);

    std::string forgeVersion;
    if (!resolveForgeVersion(mcVersion, forgeVersion, errorOut)) return false;

    std::string installerUrl = "https://maven.minecraftforge.net/net/minecraftforge/forge/" +
        mcVersion + "-" + forgeVersion + "/forge-" + mcVersion + "-" + forgeVersion + "-installer.jar";

    fs::path installerDir = root / "forge_installers";
    fs::path installerPath = installerDir / ("forge-" + mcVersion + "-" + forgeVersion + "-installer.jar");

    onProgress("libraries", 0.05, "Загружаем установщик Forge...");
    if (!fs::exists(installerPath)) {
        if (!httpDownloadFile(installerUrl, installerPath, errorOut)) return false;
    }

    // Современные инсталляторы Forge кладут id итоговой версии в
    // install_profile.json -> "version" — оттуда узнаём, куда он всё установит.
    auto profileRaw = readZipEntryToString(installerPath, "install_profile.json");
    if (!profileRaw) {
        errorOut = "ERR_FORGE_OLD_INSTALLER||" + mcVersion;
        return false;
    }

    std::string forgeId;
    try {
        json profileJson = json::parse(*profileRaw);
        forgeId = profileJson.value("version", "");
    } catch (const std::exception& e) {
        errorOut = std::string("Не удалось разобрать install_profile.json: ") + e.what();
        return false;
    }
    if (forgeId.empty()) { errorOut = "install_profile.json не содержит id версии Forge"; return false; }

    fs::path forgeVersionJsonPath = root / "versions" / forgeId / (forgeId + ".json");

    if (!fs::exists(forgeVersionJsonPath)) {
        onProgress("libraries", 0.1, "Устанавливаем Forge (может занять пару минут)...");

        // javaw.exe — GUI-подсистема Java, у неё в принципе нет консоли, поэтому
        // ни сам инсталлятор, ни его дочерние java-процессы (processors, которые
        // патчат клиент под 1.13+) не мигают чёрным окном. Если рядом с java.exe
        // нет javaw.exe (совсем нестандартная сборка JDK) — используем обычный.
        fs::path javaExePath(javaPath);
        fs::path javawPath = javaExePath.parent_path() / "javaw.exe";
        std::error_code javawEc;
        std::string installerJava = fs::exists(javawPath, javawEc) ? javawPath.string() : javaPath;

        // Пишем stdout/stderr инсталлятора в лог-файл — если он упадёт, показываем
        // хвост лога вместо голого кода возврата, чтобы было понятно, что чинить.
        fs::path logPath = installerDir / (forgeId + "_install.log");
        SECURITY_ATTRIBUTES sa{};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        HANDLE hLog = CreateFileA(logPath.string().c_str(), GENERIC_WRITE, FILE_SHARE_READ,
                                   &sa, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);

        std::ostringstream cmd;
        cmd << "\"" << installerJava << "\" -jar \"" << installerPath.string() << "\" --installClient \"" << root.string() << "\"";
        std::string cmdLine = cmd.str();
        std::vector<char> cmdBuf(cmdLine.begin(), cmdLine.end());
        cmdBuf.push_back('\0');

        STARTUPINFOA si{}; si.cb = sizeof(si);
        bool haveLog = (hLog != INVALID_HANDLE_VALUE);
        if (haveLog) {
            si.dwFlags |= STARTF_USESTDHANDLES;
            si.hStdOutput = hLog;
            si.hStdError = hLog;
        }
        // См. комментарий в runProcessSyncWithLog — та же подстраховка от
        // мелькания консоли поверх CREATE_NO_WINDOW.
        si.dwFlags |= STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION pi{};
        BOOL ok = CreateProcessA(
            nullptr, cmdBuf.data(), nullptr, nullptr, haveLog ? TRUE : FALSE,
            CREATE_NO_WINDOW, nullptr, installerDir.string().c_str(), &si, &pi);

        if (haveLog) CloseHandle(hLog);

        if (!ok) {
            DWORD err = GetLastError();
            errorOut = "ERR_PROCESS_LAUNCH||" + winErrorMessage(err) + " (" + std::to_string(err) + ")";
            return false;
        }

        // Ждём завершения инсталлятора короткими интервалами вместо INFINITE,
        // чтобы можно было прервать его через кнопку "Отмена".
        DWORD exitCode = STILL_ACTIVE;
        for (;;) {
            DWORD waitResult = WaitForSingleObject(pi.hProcess, 300);
            if (waitResult == WAIT_OBJECT_0) {
                GetExitCodeProcess(pi.hProcess, &exitCode);
                break;
            }
            if (g_cancelled.load()) {
                TerminateProcess(pi.hProcess, 1);
                WaitForSingleObject(pi.hProcess, 2000);
                CloseHandle(pi.hProcess);
                CloseHandle(pi.hThread);
                errorOut = "CANCELLED";
                return false;
            }
        }
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);

        if (exitCode != 0 || !fs::exists(forgeVersionJsonPath)) {
            std::string logTail;
            std::ifstream logFile(logPath, std::ios::binary);
            if (logFile) {
                std::stringstream ss; ss << logFile.rdbuf();
                std::string full = ss.str();
                logTail = full.size() > 2000 ? full.substr(full.size() - 2000) : full;
            }

            // Установщик мог упасть из-за повреждённого/недокачанного .jar,
            // оставшегося от прошлой неудачной попытки (мы качаем его только
            // если fs::exists(installerPath) == false, поэтому битый файл иначе
            // так и остался бы навсегда и следующая попытка ломалась бы точно
            // так же, даже после выбора другой версии). Удаляем кэш инсталлятора
            // и любую недоустановленную папку версии Forge, чтобы следующая
            // попытка начиналась с чистого, свежескачанного файла.
            std::error_code cleanupEc;
            fs::remove(installerPath, cleanupEc);
            fs::remove_all(root / "versions" / forgeId, cleanupEc);

            errorOut = "ERR_FORGE_INSTALL_FAILED||exit " + std::to_string(exitCode) + "; log: " + logPath.string() +
                       (logTail.empty() ? "" : ("; " + logTail));
            return false;
        }
    }

    onProgress("libraries", 0.15, "Применяем профиль Forge...");

    std::ifstream forgeJsonFile(forgeVersionJsonPath, std::ios::binary);
    std::stringstream ss; ss << forgeJsonFile.rdbuf();
    json forgeVjson;
    try { forgeVjson = json::parse(ss.str()); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать версию Forge: ") + e.what(); return false; }

    // Библиотеки Forge добавляем к ванильным — их скачает общий цикл ниже.
    if (forgeVjson.contains("libraries")) {
        if (!vjson.contains("libraries")) vjson["libraries"] = json::array();
        for (const auto& lib : forgeVjson["libraries"]) vjson["libraries"].push_back(lib);
    }

    // Аргументы JVM/игры Forge (современный формат arguments.jvm/game) добавляем к ванильным.
    if (forgeVjson.contains("arguments")) {
        if (!vjson.contains("arguments")) vjson["arguments"] = json::object();
        for (const std::string key : {"jvm", "game"}) {
            if (forgeVjson["arguments"].contains(key)) {
                if (!vjson["arguments"].contains(key)) vjson["arguments"][key] = json::array();
                for (const auto& a : forgeVjson["arguments"][key]) vjson["arguments"][key].push_back(a);
            }
        }
    }

    if (forgeVjson.contains("mainClass")) vjson["mainClass"] = forgeVjson["mainClass"];

    return true;
}

bool prepareNeoForge(const std::string& mcVersion, const fs::path& root, const std::string& javaPath,
                      json& vjson, const ProgressFn& onProgress, std::string& errorOut) {
    onProgress("libraries", 0.0, "Определяем версию NeoForge...");

    ensureLauncherProfilesFile(root);

    std::string neoforgeVersion;
    if (!resolveNeoForgeVersion(mcVersion, neoforgeVersion, errorOut)) return false;

    std::string installerUrl = "https://maven.neoforged.net/releases/net/neoforged/neoforge/" +
        neoforgeVersion + "/neoforge-" + neoforgeVersion + "-installer.jar";

    fs::path installerDir = root / "neoforge_installers";
    fs::path installerPath = installerDir / ("neoforge-" + neoforgeVersion + "-installer.jar");

    onProgress("libraries", 0.05, "Загружаем установщик NeoForge...");
    if (!fs::exists(installerPath)) {
        if (!httpDownloadFile(installerUrl, installerPath, errorOut)) return false;
    }

    auto profileRaw = readZipEntryToString(installerPath, "install_profile.json");
    if (!profileRaw) {
        errorOut = "ERR_NEOFORGE_OLD_INSTALLER||" + mcVersion;
        return false;
    }

    std::string neoforgeId;
    try {
        json profileJson = json::parse(*profileRaw);
        neoforgeId = profileJson.value("version", "");
    } catch (const std::exception& e) {
        errorOut = std::string("Не удалось разобрать install_profile.json NeoForge: ") + e.what();
        return false;
    }
    if (neoforgeId.empty()) { errorOut = "install_profile.json NeoForge не содержит id версии"; return false; }

    fs::path neoforgeVersionJsonPath = root / "versions" / neoforgeId / (neoforgeId + ".json");

    if (!fs::exists(neoforgeVersionJsonPath)) {
        onProgress("libraries", 0.1, "Устанавливаем NeoForge (может занять пару минут)...");

        fs::path javaExePath(javaPath);
        fs::path javawPath = javaExePath.parent_path() / "javaw.exe";
        std::error_code javawEc;
        std::string installerJava = fs::exists(javawPath, javawEc) ? javawPath.string() : javaPath;

        fs::path logPath = installerDir / (neoforgeId + "_install.log");
        SECURITY_ATTRIBUTES sa{};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        HANDLE hLog = CreateFileA(logPath.string().c_str(), GENERIC_WRITE, FILE_SHARE_READ,
                                   &sa, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);

        std::ostringstream cmd;
        cmd << "\"" << installerJava << "\" -jar \"" << installerPath.string() << "\" --installClient \"" << root.string() << "\"";
        std::string cmdLine = cmd.str();
        std::vector<char> cmdBuf(cmdLine.begin(), cmdLine.end());
        cmdBuf.push_back('\0');

        STARTUPINFOA si{}; si.cb = sizeof(si);
        bool haveLog = (hLog != INVALID_HANDLE_VALUE);
        if (haveLog) {
            si.dwFlags |= STARTF_USESTDHANDLES;
            si.hStdOutput = hLog;
            si.hStdError = hLog;
        }
        si.dwFlags |= STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION pi{};
        BOOL ok = CreateProcessA(
            nullptr, cmdBuf.data(), nullptr, nullptr, haveLog ? TRUE : FALSE,
            CREATE_NO_WINDOW, nullptr, installerDir.string().c_str(), &si, &pi);

        if (haveLog) CloseHandle(hLog);

        if (!ok) {
            DWORD err = GetLastError();
            errorOut = "ERR_PROCESS_LAUNCH||" + winErrorMessage(err) + " (" + std::to_string(err) + ")";
            return false;
        }

        DWORD exitCode = STILL_ACTIVE;
        for (;;) {
            DWORD waitResult = WaitForSingleObject(pi.hProcess, 300);
            if (waitResult == WAIT_OBJECT_0) {
                GetExitCodeProcess(pi.hProcess, &exitCode);
                break;
            }
            if (g_cancelled.load()) {
                TerminateProcess(pi.hProcess, 1);
                WaitForSingleObject(pi.hProcess, 2000);
                CloseHandle(pi.hProcess);
                CloseHandle(pi.hThread);
                errorOut = "CANCELLED";
                return false;
            }
        }
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);

        if (exitCode != 0 || !fs::exists(neoforgeVersionJsonPath)) {
            std::string logTail;
            std::ifstream logFile(logPath, std::ios::binary);
            if (logFile) {
                std::stringstream ss; ss << logFile.rdbuf();
                std::string full = ss.str();
                logTail = full.size() > 2000 ? full.substr(full.size() - 2000) : full;
            }

            std::error_code cleanupEc;
            fs::remove(installerPath, cleanupEc);
            fs::remove_all(root / "versions" / neoforgeId, cleanupEc);

            errorOut = "ERR_NEOFORGE_INSTALL_FAILED||exit " + std::to_string(exitCode) + "; log: " + logPath.string() +
                       (logTail.empty() ? "" : ("; " + logTail));
            return false;
        }
    }

    onProgress("libraries", 0.15, "Применяем профиль NeoForge...");

    std::ifstream neoforgeJsonFile(neoforgeVersionJsonPath, std::ios::binary);
    std::stringstream ss; ss << neoforgeJsonFile.rdbuf();
    json neoforgeVjson;
    try { neoforgeVjson = json::parse(ss.str()); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать версию NeoForge: ") + e.what(); return false; }

    if (neoforgeVjson.contains("libraries")) {
        if (!vjson.contains("libraries")) vjson["libraries"] = json::array();
        for (const auto& lib : neoforgeVjson["libraries"]) vjson["libraries"].push_back(lib);
    }

    if (neoforgeVjson.contains("arguments")) {
        if (!vjson.contains("arguments")) vjson["arguments"] = json::object();
        for (const std::string key : {"jvm", "game"}) {
            if (neoforgeVjson["arguments"].contains(key)) {
                if (!vjson["arguments"].contains(key)) vjson["arguments"][key] = json::array();
                for (const auto& a : neoforgeVjson["arguments"][key]) vjson["arguments"][key].push_back(a);
            }
        }
    }

    if (neoforgeVjson.contains("mainClass")) vjson["mainClass"] = neoforgeVjson["mainClass"];

    return true;
}

// Объявлена ниже (рядом с Modrinth API) — маленький urlencode на базе curl,
// переиспользуем его и для BMCLAPI (нужен и здесь, выше по файлу).
std::string urlEncodeForModrinth(const std::string& value);

// ============================================
// OptiFine / Forge+OptiFine — через зеркало BMCLAPI (bmclapi2.bangbang93.com).
//
// У официального optifine.net нет публичного API: файлы отдаются только со
// страницы с рекламой, а прямая ссылка на скачивание собирается на лету
// JS-кодом страницы и содержит одноразовый токен — автоматически скачивать
// оттуда ненадёжно (и по сути означало бы эмулировать браузер). BMCLAPI
// зеркалит те же файлы OptiFine 1:1 (это открытый и давно используемый
// сообществом мираж — им пользуются HMCL, PCL и другие лаунчеры) и отдаёт
// их по стабильному прямому API без какой-либо авторизации.
//
// API: GET https://bmclapi2.bangbang93.com/optifine/<mcVersion>
//   -> JSON-массив { mcversion, patch, type, version, filename, ... },
//      от старых сборок к новым.
// Скачивание: GET https://bmclapi2.bangbang93.com/optifine/<mcVersion>/<type>/<patch>
// ============================================
bool bmclapiFetchOptifineList(const std::string& mcVersion, json& listOut, std::string& errorOut) {
    std::string raw;
    if (!httpGetStringFast("https://bmclapi2.bangbang93.com/optifine/" + urlEncodeForModrinth(mcVersion), raw, errorOut))
        return false;

    try { listOut = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать список OptiFine с BMCLAPI: ") + e.what(); return false; }

    if (!listOut.is_array() || listOut.empty()) {
        errorOut = "BMCLAPI не нашёл сборок OptiFine под версию " + mcVersion;
        return false;
    }
    return true;
}

// ============================================
// FastMinecraftMirror (fastmcmirror.org) — второе зеркало OptiFine, используется
// как fallback, если BMCLAPI недоступен/слишком медленный в сети пользователя.
// У него единый эндпоинт со списком ВСЕХ версий сразу (не отфильтрованных по
// mcVersion), поэтому фильтруем на своей стороне. Ссылка на файл в ответе уже
// готовая (прямая), никакого второго запроса для скачивания не нужно.
// API: GET https://optifine.fastmcmirror.org/versionList
//   -> [{ name, mcversion, type, version, file, url }, ...]
// ============================================
struct OptifineBuild {
    std::string mcversion;
    std::string type;
    std::string patch;      // "patch" у BMCLAPI == "version" у FastMCMirror
    std::string filename;
    std::string directUrl;  // непусто только для FastMCMirror — там сразу готовая прямая ссылка
    bool fromFastMirror = false;
};

bool fastMcMirrorFetchOptifineList(const std::string& mcVersion, std::vector<OptifineBuild>& listOut, std::string& errorOut) {
    std::string raw;
    if (!httpGetStringFast("https://optifine.fastmcmirror.org/versionList", raw, errorOut))
        return false;

    json parsed;
    try { parsed = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать список OptiFine с FastMCMirror: ") + e.what(); return false; }

    if (!parsed.is_array()) { errorOut = "FastMCMirror вернул неожиданный формат списка OptiFine"; return false; }

    for (const auto& entry : parsed) {
        if (entry.value("mcversion", "") != mcVersion) continue;
        OptifineBuild b;
        b.mcversion = mcVersion;
        b.type = entry.value("type", "");
        b.patch = entry.value("version", "");
        b.filename = entry.value("file", "");
        b.directUrl = entry.value("url", "");
        b.fromFastMirror = true;
        if (!b.directUrl.empty()) listOut.push_back(b);
    }

    if (listOut.empty()) {
        errorOut = "FastMCMirror не нашёл сборок OptiFine под версию " + mcVersion;
        return false;
    }
    return true;
}

// Единая точка входа: сперва пробуем BMCLAPI (у него обычно самая полная
// история версий), и только если он совсем не ответил (пустой список) —
// переключаемся на FastMCMirror.
bool fetchOptifineListWithFallback(const std::string& mcVersion, std::vector<OptifineBuild>& listOut, std::string& errorOut) {
    json bmclapiList;
    std::string bmclapiError;
    if (bmclapiFetchOptifineList(mcVersion, bmclapiList, bmclapiError)) {
        for (const auto& entry : bmclapiList) {
            OptifineBuild b;
            b.mcversion = entry.value("mcversion", mcVersion);
            b.type = entry.value("type", "");
            b.patch = entry.value("patch", "");
            b.filename = entry.value("filename", "");
            b.fromFastMirror = false;
            listOut.push_back(b);
        }
        if (!listOut.empty()) return true;
    }

    std::string fastMirrorError;
    if (fastMcMirrorFetchOptifineList(mcVersion, listOut, fastMirrorError)) return true;

    errorOut = "ERR_OPTIFINE_NO_MIRROR||BMCLAPI: " + (bmclapiError.empty() ? std::string("no builds") : bmclapiError) +
               "; FastMCMirror: " + fastMirrorError;
    return false;
}

// Выбирает "лучшую" сборку из списка: самую свежую стабильную (список идёт
// от старых к новым, поэтому идём с конца; pre/beta-сборки пропускаем, если
// есть более свежая стабильная — а если их нет, всё равно берём последнюю,
// чтобы не остаться совсем без варианта на редких версиях).
const OptifineBuild& pickBestOptifineBuild(const std::vector<OptifineBuild>& list) {
    for (auto it = list.rbegin(); it != list.rend(); ++it) {
        std::string patch = it->patch;
        std::transform(patch.begin(), patch.end(), patch.begin(), ::tolower);
        if (patch.find("pre") == std::string::npos && patch.find("beta") == std::string::npos) {
            return *it;
        }
    }
    return list.back();
}

// Список кандидатов на скачивание, от самой предпочтительной сборки к менее
// предпочтительной: сначала все стабильные (не pre/beta) от новой к старой,
// затем, если стабильных не было вообще, все остальные от новой к старой.
std::vector<const OptifineBuild*> rankOptifineBuildCandidates(const std::vector<OptifineBuild>& list) {
    std::vector<const OptifineBuild*> stable, rest;
    for (auto it = list.rbegin(); it != list.rend(); ++it) {
        std::string patch = it->patch;
        std::transform(patch.begin(), patch.end(), patch.begin(), ::tolower);
        bool isPreOrBeta = patch.find("pre") != std::string::npos || patch.find("beta") != std::string::npos;
        (isPreOrBeta ? rest : stable).push_back(&(*it));
    }
    if (!stable.empty()) return stable;
    return rest;
}

// Скачивает выбранную сборку с её "родного" зеркала; если оно не ответило —
// сама пытается получить список у ВТОРОГО зеркала и скачать оттуда, прежде
// чем окончательно сдаться. Раньше при отказе BMCLAPI ошибка сразу летела
// пользователю с советом "включите VPN" — теперь второе зеркало пробуется
// автоматически, и VPN предлагается только если оба варианта не сработали.
bool downloadOptifineBuildWithFallback(const OptifineBuild& entry, const fs::path& destDir, fs::path& jarOut,
                                        const ProgressFn& onProgress, std::string& errorOut) {
    std::string filename = entry.filename.empty()
        ? ("OptiFine_" + entry.mcversion + "_" + entry.type + "_" + entry.patch + ".jar")
        : entry.filename;
    fs::path dest = destDir / filename;

    std::string primaryName = entry.fromFastMirror ? "FastMCMirror" : "BMCLAPI";

    // ИСПРАВЛЕНО: раньше здесь стоял жёсткий потолок absoluteTimeoutSec=45 —
    // на медленных/зарубежных сетях (особенно на macOS/Linux без локальных
    // зеркал) BMCLAPI/FastMCMirror реально может отдавать файл дольше 45с,
    // оставаясь при этом ЖИВЫМ соединением (скорость выше 200 байт/с) — но
    // curl всё равно обрывал такую попытку по абсолютному таймауту, и после
    // 5 попыток игрок видел "Timeout was reached", хотя загрузка на самом
    // деле шла и просто не успевала. Теперь, как и для обычных
    // библиотек/ассетов (см. httpDownloadFile ниже по файлу), потолка на всю
    // попытку нет — соединение обрывается только если оно РЕАЛЬНО зависло
    // (скорость ниже 200 байт/с дольше lowSpeedTimeSec секунд).
    auto onRetry = [&](int attempt, int maxAttempts) {
        std::string suffix = (attempt > 1) ? (" (попытка " + std::to_string(attempt) + " из " + std::to_string(maxAttempts) + ")") : "";
        onProgress("libraries", 0.1, "Загружаем установщик OptiFine с " + primaryName + "..." + suffix);
    };

    std::string url = entry.fromFastMirror
        ? entry.directUrl
        : ("https://bmclapi2.bangbang93.com/optifine/" + urlEncodeForModrinth(entry.mcversion) +
           "/" + urlEncodeForModrinth(entry.type) + "/" + urlEncodeForModrinth(entry.patch));

    if (httpDownloadFile(url, dest, errorOut, 6, onRetry, /*connectTimeoutSec*/20, /*lowSpeedTimeSec*/60, /*absoluteTimeoutSec*/100)) {
        jarOut = dest;
        return true;
    }

    std::string primaryError = errorOut;

    // Основное зеркало не ответило (или отвалилось посреди скачивания) —
    // если это был BMCLAPI, пробуем достать ту же сборку через FastMCMirror.
    if (!entry.fromFastMirror) {
        std::vector<OptifineBuild> altList;
        std::string altError;
        if (fastMcMirrorFetchOptifineList(entry.mcversion, altList, altError) && !altList.empty()) {
            const OptifineBuild& altEntry = pickBestOptifineBuild(altList);
            fs::path altDest = destDir / (altEntry.filename.empty()
                ? ("OptiFine_" + altEntry.mcversion + "_" + altEntry.type + "_" + altEntry.patch + ".jar")
                : altEntry.filename);

            auto onRetryAlt = [&](int attempt, int maxAttempts) {
                std::string suffix = (attempt > 1) ? (" (попытка " + std::to_string(attempt) + " из " + std::to_string(maxAttempts) + ")") : "";
                onProgress("libraries", 0.15, "Пробуем резервное зеркало FastMCMirror..." + suffix);
            };

            if (httpDownloadFile(altEntry.directUrl, altDest, errorOut, 6, onRetryAlt, 20, 60, 100)) {
                jarOut = altDest;
                return true;
            }

            errorOut = "ERR_OPTIFINE_DOWNLOAD_FAILED||BMCLAPI: " + primaryError + "; FastMCMirror: " + errorOut;
            return false;
        }
    }

    errorOut = "ERR_OPTIFINE_DOWNLOAD_FAILED||" + primaryName + ": " + primaryError;
    return false;
}

// ============================================
// "Железобетонная" загрузка OptiFine: раньше при неудаче с обоими зеркалами
// для ОДНОЙ конкретной (самой новой стабильной) сборки лаунчер сразу сдавался
// с ERR_OPTIFINE_DOWNLOAD_FAILED — даже если файл для этой сборки просто
// битый/удалён на обоих зеркалах, а остальные сборки той же версии Minecraft
// прекрасно доступны. Теперь при неудаче автоматически пробуются ещё
// несколько сборок той же версии (от новой к старой, с приоритетом
// стабильных) — это резко повышает шанс успеха и не требует ручного участия
// игрока (например, ручного выбора другой версии OptiFine).
// ============================================
bool downloadBestAvailableOptifine(const std::vector<OptifineBuild>& list, const fs::path& destDir,
                                    fs::path& jarOut, OptifineBuild& chosenOut,
                                    const ProgressFn& onProgress, std::string& errorOut) {
    std::vector<const OptifineBuild*> candidates = rankOptifineBuildCandidates(list);
    if (candidates.empty()) { errorOut = "ERR_OPTIFINE_NO_MIRROR||empty list"; return false; }

    const int MAX_BUILDS_TO_TRY = 5;
    std::string lastError;
    int tried = 0;

    for (const OptifineBuild* candPtr : candidates) {
        if (tried >= MAX_BUILDS_TO_TRY) break;
        if (g_cancelled.load()) { errorOut = "CANCELLED"; return false; }
        tried++;

        if (tried > 1) {
            onProgress("libraries", 0.12, "Пробуем другую сборку OptiFine (" +
                std::to_string(tried) + " из " + std::to_string(std::min((size_t)MAX_BUILDS_TO_TRY, candidates.size())) + ")...");
        }

        std::string attemptError;
        if (downloadOptifineBuildWithFallback(*candPtr, destDir, jarOut, onProgress, attemptError)) {
            chosenOut = *candPtr;
            return true;
        }
        lastError = attemptError;
    }

    errorOut = "ERR_OPTIFINE_DOWNLOAD_FAILED||перепробовали " + std::to_string(tried) +
               " сборок(-у) под эту версию, ни одна не скачалась. Последняя ошибка: " + lastError;
    return false;
}

// Ищет файл с заданным именем рекурсивно внутри директории — нужен, чтобы
// найти java.exe/javac.exe внутри распакованного JDK-архива, у которого
// корневая папка называется по-разному в зависимости от версии
// (например "jdk-21.0.5+11"), и заранее её имя не известно.
std::optional<fs::path> findFileRecursive(const fs::path& root, const std::string& filename) {
    std::error_code ec;
    if (!fs::exists(root, ec)) return std::nullopt;
    for (auto it = fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied, ec);
         it != fs::recursive_directory_iterator(); it.increment(ec)) {
        if (ec) break;
        std::error_code fileEc;
        if (!it->is_regular_file(fileEc)) continue;
        if (it->path().filename() == filename) return it->path();
    }
    return std::nullopt;
}

// ============================================
// Автозагрузка portable JDK (не JRE!) — нужен только затем, чтобы скомпилировать
// и запустить крошечный java-хелпер для тихой установки standalone OptiFine
// (см. runOptifineHeadlessInstall ниже). Обычная Java, которую скачивает
// ensureBundledJavaRuntime для самого запуска игры — это JRE от Mojang, в
// ней принципиально нет javac. Раньше в этом случае мы просто показывали
// игроку ошибку "нужен JDK, укажите путь в настройках" — теперь вместо этого
// сами скачиваем свободный portable JDK (Eclipse Temurin, сборки Adoptium)
// в свою изолированную папку gameDir/runtime/jdk-temurin, не трогая систему,
// точно так же, как ensureBundledJavaRuntime делает для JRE.
// ============================================
bool ensureJdkForOptifineStub(const fs::path& gameRoot, const ProgressFn& onProgress,
                               fs::path& javaExeOut, fs::path& javacExeOut, std::string& errorOut) {
    fs::path jdkRoot = gameRoot / "runtime" / "jdk-temurin";
    fs::path marker = jdkRoot / ".installed";

    if (fs::exists(marker)) {
        auto java = findFileRecursive(jdkRoot, "java.exe");
        auto javac = findFileRecursive(jdkRoot, "javac.exe");
        if (java && javac) { javaExeOut = *java; javacExeOut = *javac; return true; }
        // Маркер есть, а файлов нет (например, папку кто-то почистил вручную) —
        // качаем заново ниже, как будто маркера не было.
    }

    onProgress("java", 0.0, "Скачиваем JDK для установки OptiFine...");

    // Публичный стабильный редирект-эндпоинт Adoptium: всегда отдаёт zip
    // последней доступной сборки нужного major-релиза для Windows x64.
    // Версия 21 (LTS) взята с запасом — сама Minecraft/OptiFine запускаются
    // отдельно на своей Java, эта JDK нужна только ради самого javac.
    std::string url = "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse";

    fs::path zipPath = gameRoot / "runtime" / "jdk-temurin.zip";
    auto onRetry = [&](int attempt, int maxAttempts) {
        std::string suffix = (attempt > 1) ? (" (попытка " + std::to_string(attempt) + " из " + std::to_string(maxAttempts) + ")") : "";
        onProgress("java", 0.1, "Скачиваем JDK для установки OptiFine..." + suffix);
    };
    // ИСПРАВЛЕНО: раньше был жёсткий потолок 240с на ~180МБ архив — на
    // медленной сети это обрывало ЖИВУЮ, но небыструю закачку с ошибкой
    // таймаута. Как и для остальных крупных файлов — без абсолютного
    // потолка, только детектор реального зависания (LOW_SPEED).
    if (!httpDownloadFile(url, zipPath, errorOut, 5, onRetry, /*connectTimeoutSec*/15, /*lowSpeedTimeSec*/60, /*absoluteTimeoutSec*/0)) {
        errorOut = "ERR_OPTIFINE_JDK_DOWNLOAD||" + errorOut;
        return false;
    }

    onProgress("java", 0.5, "Распаковываем JDK...");
    std::error_code ec;
    fs::remove_all(jdkRoot, ec); // на случай недоустановленного JDK с прошлой попытки
    if (!extractZipPreservingStructure(zipPath, jdkRoot, errorOut)) return false;
    fs::remove(zipPath, ec);

    auto java = findFileRecursive(jdkRoot, "java.exe");
    auto javac = findFileRecursive(jdkRoot, "javac.exe");
    if (!java || !javac) {
        errorOut = "ERR_OPTIFINE_JDK_MISSING||" + jdkRoot.string();
        return false;
    }

    { std::ofstream m(marker, std::ios::binary); m << "ok"; }
    javaExeOut = *java;
    javacExeOut = *javac;
    return true;
}

// Тихая установка standalone OptiFine (без Forge). У джарника OptiFine нет
// документированного консольного флага для установки без GUI, но метод
// класса optifine.Installer, который дёргает кнопка "Install" в его окне —
// тот же самый код, и сам по себе он ничего не рисует (окно открывает только
// main(), который мы не вызываем). Этим приёмом (рефлексия по внутренним
// классам инсталлятора) пользуются открытые лаунчеры вроде HMCL.
//
// ВАЖНО: точное имя/сигнатура метода отличаются между версиями OptiFine
// (например, "installClient(File)" в одних сборках и другая сигнатура в
// других — жёстко зашитое имя однажды привело к NoSuchMethodException на
// вполне рабочем инсталляторе). Поэтому вместо одного жёстко заданного
// метода java-хелпер сам сканирует все public static методы класса
// optifine.Installer и берёт первый, чьё имя содержит "install" и который
// принимает один или два параметра типа File — этому шаблону соответствуют
// все известные версии инсталлятора. Если подходящего метода всё равно не
// нашлось, хелпер печатает полный список методов класса в лог, чтобы было
// видно, что реально доступно, вместо голого "метод не найден".
bool runOptifineHeadlessInstall(const fs::path& installerJar, const fs::path& gameRoot,
                                 const std::string& javaPath, const ProgressFn& onProgress, std::string& errorOut) {
    fs::path stubDir = installerJar.parent_path() / "stub";
    std::error_code ec;
    fs::create_directories(stubDir, ec);

    // Java для компиляции/запуска хелпера: сперва пробуем javac рядом с уже
    // выбранной в настройках Java (вдруг это полноценный JDK) — и только
    // если его там нет, автоматически скачиваем отдельный portable JDK.
    fs::path stubJava = javaPath;
    fs::path stubJavac = fs::path(javaPath).parent_path() / "javac.exe";

    if (!fs::exists(stubJavac)) {
        fs::path autoJava, autoJavac;
        if (!ensureJdkForOptifineStub(gameRoot, onProgress, autoJava, autoJavac, errorOut)) return false;
        stubJava = autoJava;
        stubJavac = autoJavac;
    }

    fs::path javaSrc = stubDir / "OfInstall.java";
    {
        std::ofstream out(javaSrc, std::ios::binary | std::ios::trunc);
        out <<
            "import java.io.File;\n"
            "import java.lang.reflect.Method;\n"
            "public class OfInstall {\n"
            "    public static void main(String[] args) throws Exception {\n"
            "        File gameDir = new File(args[0]);\n"
            "        Class<?> c = Class.forName(\"optifine.Installer\");\n"
            "        Method chosen = null;\n"
            "        for (Method m : c.getMethods()) {\n"
            "            if (m.getName().toLowerCase().indexOf(\"install\") < 0) continue;\n"
            "            Class<?>[] params = m.getParameterTypes();\n"
            "            if (params.length < 1 || params.length > 2) continue;\n"
            "            boolean allFile = true;\n"
            "            for (Class<?> p : params) if (p != File.class) allFile = false;\n"
            "            if (!allFile) continue;\n"
            "            chosen = m;\n"
            "            break;\n"
            "        }\n"
            "        if (chosen == null) {\n"
            "            System.out.println(\"OF_NO_METHOD. Доступные методы optifine.Installer:\");\n"
            "            for (Method m : c.getMethods()) System.out.println(\"  \" + m);\n"
            "            throw new RuntimeException(\"Не нашли подходящий метод установки в optifine.Installer\");\n"
            "        }\n"
            "        Object[] callArgs = (chosen.getParameterTypes().length == 1)\n"
            "            ? new Object[]{gameDir} : new Object[]{gameDir, gameDir};\n"
            "        System.out.println(\"OF_CALLING: \" + chosen);\n"
            "        chosen.invoke(null, callArgs);\n"
            "        System.out.println(\"OF_INSTALL_OK\");\n"
            "    }\n"
            "}\n";
    }

    // 1) компилируем хелпер
    fs::path compileLog = stubDir / "compile.log";
    std::ostringstream compileCmd;
    compileCmd << "\"" << stubJavac.string() << "\" -d \"" << stubDir.string() << "\" \"" << javaSrc.string() << "\"";

    DWORD compileExit = 0;
    if (!runProcessSyncWithLog(compileCmd.str(), stubDir, compileLog, compileExit, errorOut)) return false;
    if (compileExit != 0) {
        errorOut = "ERR_OPTIFINE_STUB_COMPILE||exit " + std::to_string(compileExit) + "; " + readLogTail(compileLog);
        return false;
    }

    // 2) запускаем его, подсунув в classpath и сам инсталлятор OptiFine
    fs::path runLog = stubDir / "install.log";
    std::ostringstream runCmd;
    runCmd << "\"" << stubJava.string() << "\" -cp \"" << stubDir.string() << ";" << installerJar.string()
           << "\" OfInstall \"" << gameRoot.string() << "\"";

    DWORD runExit = 0;
    if (!runProcessSyncWithLog(runCmd.str(), stubDir, runLog, runExit, errorOut, 60000)) return false;

    std::string logTail = readLogTail(runLog);
    if (runExit != 0 || logTail.find("OF_INSTALL_OK") == std::string::npos) {
        errorOut = "ERR_OPTIFINE_INSTALL_FAILED||exit " + std::to_string(runExit) + "; " + logTail;
        return false;
    }
    return true;
}

// Стандартный (без Forge) OptiFine: скачиваем инсталлятор с BMCLAPI, тихо
// устанавливаем его в gameRoot (см. runOptifineHeadlessInstall выше) — он
// создаёт versions/<mcVersion>-OptiFine_<edition>/ с собственным профилем —
// и подмешиваем этот профиль (библиотеки/аргументы/mainClass) в ванильный
// vjson, ровно как это делает prepareForge для Forge.
bool prepareOptifineStandalone(const std::string& mcVersion, const fs::path& root, const std::string& javaPath,
                                json& vjson, const ProgressFn& onProgress, std::string& errorOut) {
    onProgress("libraries", 0.0, "Ищем сборку OptiFine...");

    std::vector<OptifineBuild> list;
    if (!fetchOptifineListWithFallback(mcVersion, list, errorOut)) return false;

    fs::path installerDir = root / "optifine_installers";
    fs::path installerJar;
    OptifineBuild chosen;
    onProgress("libraries", 0.1, "Загружаем установщик OptiFine...");
    if (!downloadBestAvailableOptifine(list, installerDir, installerJar, chosen, onProgress, errorOut)) return false;

    // Угадываем id профиля по имени скачанного файла — OptiFine называет его
    // "<mcVersion>-OptiFine_<edition>" (edition — это хвост имени файла без
    // "OptiFine_<mcVersion>_" и расширения, например "HD_U_J6").
    std::string stem = installerJar.stem().string();
    std::string edition = (stem.rfind("OptiFine_", 0) == 0) ? stem.substr(9) : stem;
    if (edition.rfind(mcVersion + "_", 0) == 0) edition = edition.substr(mcVersion.size() + 1);
    std::string ofId = mcVersion + "-OptiFine_" + edition;
    fs::path ofVersionJsonPath = root / "versions" / ofId / (ofId + ".json");

    if (!fs::exists(ofVersionJsonPath)) {
        onProgress("libraries", 0.2, "Устанавливаем OptiFine (тихий режим)...");
        if (!waitWhilePausedOrCancelled(errorOut)) return false;
        if (!runOptifineHeadlessInstall(installerJar, root, javaPath, onProgress, errorOut)) return false;
    }

    if (!fs::exists(ofVersionJsonPath)) {
        // Угадали неточно (бывают нестандартные имена файлов) — ищем среди
        // папок versions/ ту, что реально появилась и содержит "OptiFine" в имени.
        fs::path versionsRoot = root / "versions";
        std::error_code fec;
        for (auto& entry : fs::directory_iterator(versionsRoot, fec)) {
            std::string name = entry.path().filename().string();
            if (name.find("OptiFine") != std::string::npos) {
                fs::path candidate = entry.path() / (name + ".json");
                if (fs::exists(candidate)) { ofVersionJsonPath = candidate; break; }
            }
        }
    }

    if (!fs::exists(ofVersionJsonPath)) {
        errorOut = "ERR_OPTIFINE_PROFILE_MISSING||" + (root / "versions").string();
        return false;
    }

    std::ifstream ofJsonFile(ofVersionJsonPath, std::ios::binary);
    std::stringstream ss; ss << ofJsonFile.rdbuf();
    json ofVjson;
    try { ofVjson = json::parse(ss.str()); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать версию OptiFine: ") + e.what(); return false; }

    if (ofVjson.contains("libraries")) {
        if (!vjson.contains("libraries")) vjson["libraries"] = json::array();
        for (const auto& lib : ofVjson["libraries"]) vjson["libraries"].push_back(lib);
    }
    if (ofVjson.contains("arguments")) {
        if (!vjson.contains("arguments")) vjson["arguments"] = json::object();
        for (const std::string key : {"jvm", "game"}) {
            if (ofVjson["arguments"].contains(key)) {
                if (!vjson["arguments"].contains(key)) vjson["arguments"][key] = json::array();
                for (const auto& a : ofVjson["arguments"][key]) vjson["arguments"][key].push_back(a);
            }
        }
    } else if (ofVjson.contains("minecraftArguments")) {
        // Совсем старые версии OptiFine (до JSON-формата аргументов) кладут
        // готовую строку — на этих версиях ванильный vjson тоже в старом
        // формате, поэтому просто целиком используем аргументы OptiFine.
        vjson["minecraftArguments"] = ofVjson["minecraftArguments"];
    }
    if (ofVjson.contains("mainClass")) vjson["mainClass"] = ofVjson["mainClass"];

    return true;
}

// Forge+OptiFine: отдельная установка OptiFine тут не нужна — начиная с
// версий, которые вообще поддерживает Forge, OptiFine работает как обычный
// мод. Просто кладём jar, скачанный с BMCLAPI, в mods/ уже поставленного
// Forge-инстанса (вызывается после prepareForge и после создания instanceDir).
bool installOptifineAsForgeMod(const std::string& mcVersion, const fs::path& root, const fs::path& modsDir,
                                const ProgressFn& onProgress, std::string& errorOut) {
    onProgress("libraries", 0.9, "Загружаем OptiFine для Forge...");

    std::vector<OptifineBuild> list;
    if (!fetchOptifineListWithFallback(mcVersion, list, errorOut)) return false;

    fs::path cacheDir = root / "optifine_installers";
    fs::path jarPath;
    OptifineBuild chosen;
    if (!downloadBestAvailableOptifine(list, cacheDir, jarPath, chosen, onProgress, errorOut)) return false;

    std::error_code ec;
    fs::create_directories(modsDir, ec);
    fs::path dest = modsDir / jarPath.filename();
    fs::copy_file(jarPath, dest, fs::copy_options::overwrite_existing, ec);
    if (ec) { errorOut = "Не удалось скопировать OptiFine в mods/: " + ec.message(); return false; }
    return true;
}

// ============================================
// Modrinth API (api.modrinth.com/v2) — публичный, ключ не нужен.
// ============================================

// Спрашивает у Modrinth файл для скачивания конкретного мода под нужную
// версию Minecraft и загрузчик. Берём самую свежую подходящую
// сборку (Modrinth отдаёт версии уже отсортированными от новых к старым).
std::string urlEncodeForModrinth(const std::string& value) {
    CURL* curl = curl_easy_init();
    if (!curl) return value;
    char* encoded = curl_easy_escape(curl, value.c_str(), (int)value.length());
    std::string result = encoded ? encoded : value;
    if (encoded) curl_free(encoded);
    curl_easy_cleanup(curl);
    return result;
}

bool resolveModrinthDownload(const std::string& slug, const std::string& mcVersion,
                              const std::string& loader, std::string& urlOut,
                              std::string& sha1Out, std::string& fileNameOut, std::string& errorOut) {
    // ВАЖНО: скобки и кавычки внутри game_versions/loaders — часть JSON-массива,
    // который Modrinth ожидает как query-параметр, но это всё равно спецсимволы
    // URL — без urlencode сервер отвечает HTTP 400 (ровно то, что ловил игрок).
    std::string gameVersionsParam = urlEncodeForModrinth("[\"" + mcVersion + "\"]");
    std::string loadersParam = urlEncodeForModrinth("[\"" + loader + "\"]");
    std::string url = "https://api.modrinth.com/v2/project/" + slug + "/version"
        "?game_versions=" + gameVersionsParam + "&loaders=" + loadersParam;

    std::string raw;
    if (!httpGetStringFast(url, raw, errorOut)) return false;

    json versions;
    try { versions = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать ответ Modrinth: ") + e.what(); return false; }

    if (!versions.is_array() || versions.empty()) {
        errorOut = "ERR_MOD_INCOMPATIBLE||" + slug + " " + mcVersion + " " + loader;
        return false;
    }

    const auto& files = versions[0]["files"];
    if (!files.is_array() || files.empty()) {
        errorOut = "ERR_MOD_NO_FILES||" + slug;
        return false;
    }

    // Если файлов несколько (например, отдельно sources.jar), берём помеченный
    // primary — это и есть основной jar мода.
    const json* chosen = &files[0];
    for (const auto& f : files) {
        if (f.value("primary", false)) { chosen = &f; break; }
    }

    urlOut = chosen->value("url", "");
    fileNameOut = chosen->value("filename", slug + ".jar");
    if (chosen->contains("hashes")) sha1Out = (*chosen)["hashes"].value("sha1", "");
    return !urlOut.empty();
}

// Тот же принцип, что и resolveModrinthDownload, но БЕЗ фильтра по loaders —
// у ресурс-паков/дата-паков/шейдеров на Modrinth загрузчика не бывает вовсе,
// а передача пустого/неверного loaders-фильтра просто обнулила бы выдачу.
bool resolveModrinthDownloadByType(const std::string& slug, const std::string& mcVersion,
                                    std::string& urlOut, std::string& sha1Out,
                                    std::string& fileNameOut, std::string& errorOut) {
    std::string gameVersionsParam = urlEncodeForModrinth("[\"" + mcVersion + "\"]");
    std::string url = "https://api.modrinth.com/v2/project/" + slug + "/version"
        "?game_versions=" + gameVersionsParam;

    std::string raw;
    if (!httpGetStringFast(url, raw, errorOut)) return false;

    json versions;
    try { versions = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать ответ Modrinth: ") + e.what(); return false; }

    if (!versions.is_array() || versions.empty()) {
        errorOut = "ERR_MOD_INCOMPATIBLE||" + slug + " " + mcVersion;
        return false;
    }

    const auto& files = versions[0]["files"];
    if (!files.is_array() || files.empty()) {
        errorOut = "ERR_MOD_NO_FILES||" + slug;
        return false;
    }

    const json* chosen = &files[0];
    for (const auto& f : files) {
        if (f.value("primary", false)) { chosen = &f; break; }
    }

    urlOut = chosen->value("url", "");
    fileNameOut = chosen->value("filename", slug + ".zip");
    if (chosen->contains("hashes")) sha1Out = (*chosen)["hashes"].value("sha1", "");
    return !urlOut.empty();
}

bool modrinthSearchByTypeImpl(const std::string& query, const std::string& mcVersion,
                               const std::string& projectType, std::string& jsonOut,
                               std::string& errorOut, int offset) {
    std::string facets = mcVersion.empty()
        ? ("[[\"project_type:" + projectType + "\"]]")
        : ("[[\"project_type:" + projectType + "\"],[\"versions:" + mcVersion + "\"]]");

    if (offset < 0) offset = 0;
    std::string url = "https://api.modrinth.com/v2/search?query=" + urlEncodeForModrinth(query) +
                       "&facets=" + urlEncodeForModrinth(facets) +
                       "&limit=20&offset=" + std::to_string(offset);

    return httpGetStringFast(url, jsonOut, errorOut);
}

bool installContentToDirImpl(const std::string& slug, const std::string& mcVersion,
                              const fs::path& targetDir, std::string& fileNameOut, std::string& errorOut) {
    std::error_code ec;
    fs::create_directories(targetDir, ec);

    std::string url, sha1, fileName;
    if (!resolveModrinthDownloadByType(slug, mcVersion, url, sha1, fileName, errorOut)) return false;

    fs::path dest = targetDir / fileName;
    if (!ensureFile(url, dest, sha1, errorOut)) return false;
    fileNameOut = fileName;
    return true;
}

bool modrinthSearchImpl(const std::string& query, const std::string& mcVersion,
                        const std::string& loader, std::string& jsonOut, std::string& errorOut,
                        int offset) {
    // facets сразу фильтруют результаты под тип "mod" + нужную версию/загрузчик —
    // во фронтенд не прилетают моды, которые всё равно нельзя поставить.
    std::string facets =
        "[[\"project_type:mod\"],"
        "[\"versions:" + mcVersion + "\"],"
        "[\"categories:" + loader + "\"]]";

    // limit=20 — тот же размер страницы, что показывает сам modrinth.com.
    // Offset честно прокидывается с фронта (см. "Моды" в app.js): каждая
    // страница — отдельный запрос к Modrinth, а не нарезка одного большого
    // ответа на клиенте. Modrinth возвращает "total_hits" в самом ответе —
    // именно по нему фронтенд считает настоящее число страниц (как в
    // оригинале, могут быть тысячи), а не выдуманное ограниченное число.
    if (offset < 0) offset = 0;
    std::string url = "https://api.modrinth.com/v2/search?query=" + urlEncodeForModrinth(query) +
                       "&facets=" + urlEncodeForModrinth(facets) +
                       "&limit=20&offset=" + std::to_string(offset);

    return httpGetStringFast(url, jsonOut, errorOut);
}

// Полная карточка мода (для модалки "подробнее"): описание (body, markdown),
// количество скачиваний, подписчиков и т.п. — как раз то, что показывает сам Modrinth.
bool modrinthProjectDetailsImpl(const std::string& slug, std::string& jsonOut, std::string& errorOut) {
    std::string url = "https://api.modrinth.com/v2/project/" + urlEncodeForModrinth(slug);
    return httpGetStringFast(url, jsonOut, errorOut);
}

// ============================================
// Манифест совместимости модов (mods/.magma_mods.json) — для каждого файла
// мода, установленного через лаунчер, запоминаем версию/загрузчик, под
// который он был поставлен. Благодаря этому при запуске другой версии
// Minecraft лаунчер сам временно отключает моды, которые ей не подходят
// (переименовывая файл в *.disabled — Minecraft просто не видит такие
// файлы), и включает обратно те, что подходят — ровно так, чтобы игрок не
// упирался в краш из-за несовместимого мода. Игрок может отключить мод
// вручную (кнопка "Отключить" в "Моих модах") — такое отключение запоминается
// отдельным флагом userDisabled и НЕ переключается автоматически обратно,
// пока игрок сам его снова не включит.
// ============================================
struct ModManifestEntry {
    std::string version;
    std::string loader;
    bool userDisabled = false;
};

fs::path modsManifestPath(const fs::path& modsDir) { return modsDir / ".magma_mods.json"; }

std::map<std::string, ModManifestEntry> readModsManifest(const fs::path& modsDir) {
    std::map<std::string, ModManifestEntry> result;
    std::ifstream f(modsManifestPath(modsDir), std::ios::binary);
    if (!f) return result;
    try {
        json j; f >> j;
        for (auto it = j.begin(); it != j.end(); ++it) {
            ModManifestEntry e;
            e.version = it.value().value("version", "");
            e.loader = it.value().value("loader", "");
            e.userDisabled = it.value().value("userDisabled", false);
            result[it.key()] = e;
        }
    } catch (...) {
        // Повреждённый/отсутствующий манифест — просто ведём себя так, будто
        // о совместимости модов ничего не известно (никого не трогаем).
    }
    return result;
}

void writeModsManifest(const fs::path& modsDir, const std::map<std::string, ModManifestEntry>& data) {
    json j = json::object();
    for (auto& kv : data) {
        j[kv.first] = {
            {"version", kv.second.version},
            {"loader", kv.second.loader},
            {"userDisabled", kv.second.userDisabled}
        };
    }
    std::error_code ec;
    fs::create_directories(modsDir, ec);
    std::ofstream f(modsManifestPath(modsDir), std::ios::binary | std::ios::trunc);
    if (f) f << j.dump(2);
}

// baseFilename — имя файла БЕЗ суффикса ".disabled" (так, как мод называется
// когда включён) — ключ манифеста всегда в этом виде, независимо от текущего
// состояния файла на диске.
void recordModInManifest(const fs::path& modsDir, const std::string& baseFilename,
                          const std::string& version, const std::string& loader) {
    auto data = readModsManifest(modsDir);
    ModManifestEntry e;
    e.version = version;
    e.loader = loader;
    e.userDisabled = false; // свежеустановленный мод включён и не был отключён игроком
    data[baseFilename] = e;
    writeModsManifest(modsDir, data);
}

// Вызывается перед каждым запуском игры (см. launchMinecraft) для общей
// mods/ (не для модпаков — там моды и так все совместимы, потому что
// весь модпак собран под одну версию). Проходит по манифесту и:
//   - включает мод, если его version совпадает с запускаемой (или version в
//     манифесте пуст — например, для очень старых записей) и он не был
//     отключён игроком вручную;
//   - иначе отключает.
// Моды, которых нет в манифесте (докинутые игроком вручную извне лаунчера,
// без установки через каталог) не трогаем вообще — мы не знаем их
// совместимость и не должны молча их выключать.
void reconcileModsForVersion(const fs::path& modsDir, const std::string& mcVersion) {
    std::error_code ec;
    if (!fs::exists(modsDir, ec)) return;

    auto manifest = readModsManifest(modsDir);
    if (manifest.empty()) return;

    for (auto& kv : manifest) {
        const std::string& baseFilename = kv.first;
        ModManifestEntry& entry = kv.second;

        fs::path enabledPath = modsDir / baseFilename;
        fs::path disabledPath = modsDir / (baseFilename + ".disabled");

        bool existsEnabled = fs::exists(enabledPath, ec);
        bool existsDisabled = fs::exists(disabledPath, ec);
        if (!existsEnabled && !existsDisabled) continue; // файл вообще удалён с диска — нечего переключать

        bool matchesVersion = entry.version.empty() || entry.version == mcVersion;
        bool shouldBeEnabled = matchesVersion && !entry.userDisabled;

        if (shouldBeEnabled && existsDisabled) {
            fs::rename(disabledPath, enabledPath, ec);
        } else if (!shouldBeEnabled && existsEnabled) {
            fs::rename(enabledPath, disabledPath, ec);
        }
    }
}

bool installModToDirImpl(const std::string& slug, const std::string& mcVersion,
                          const std::string& loader, const fs::path& modsDir,
                          std::string& fileNameOut, std::string& errorOut) {
    std::error_code ec;
    fs::create_directories(modsDir, ec);

    std::string url, sha1, fileName;
    if (!resolveModrinthDownload(slug, mcVersion, loader, url, sha1, fileName, errorOut)) return false;

    fs::path dest = modsDir / fileName;
    if (!ensureFile(url, dest, sha1, errorOut)) return false;
    recordModInManifest(modsDir, fileName, mcVersion, loader);
    fileNameOut = fileName;
    return true;
}

int curseforgeModLoaderType(const std::string& loader) {
    if (loader == "forge") return 1;
    if (loader == "fabric") return 4;
    if (loader == "quilt") return 5;
    if (loader == "neoforge") return 6;
    return 0;
}

std::string curseforgeAuthHeader() {
    return std::string("x-api-key: ") + CURSEFORGE_API_KEY;
}

// CurseForge, в отличие от Modrinth, у многих модов хранит версию совместимости
// как общую "1.21", а не как точный патч "1.21.4" — при фильтрации по точной
// патч-версии такие моды (а их немало) просто не проходили фильтр и пропадали
// из выдачи, хотя на сайте curseforge.com они прекрасно находятся. Усекаем
// версию до major.minor (как это по факту делает сам сайт в своём фильтре
// версий) — это не теряет точность (Minecraft всё равно грузит любой патч
// внутри одной "минорной" линейки одинаково), но резко увеличивает охват.
std::string curseforgeVersionParam(const std::string& mcVersion) {
    size_t firstDot = mcVersion.find('.');
    if (firstDot == std::string::npos) return mcVersion;
    size_t secondDot = mcVersion.find('.', firstDot + 1);
    if (secondDot == std::string::npos) return mcVersion;
    return mcVersion.substr(0, secondDot);
}

bool curseforgeSearchImpl(const std::string& query, const std::string& mcVersion,
                           const std::string& loader, std::string& jsonOut, std::string& errorOut,
                           int offset) {
    if (offset < 0) offset = 0;
    std::string url = "https://api.curseforge.com/v1/mods/search"
        "?gameId=432&classId=6"
        "&searchFilter=" + urlEncodeForModrinth(query) +
        "&gameVersion=" + urlEncodeForModrinth(curseforgeVersionParam(mcVersion)) +
        "&modLoaderType=" + std::to_string(curseforgeModLoaderType(loader)) +
        "&sortField=2&sortOrder=desc&pageSize=20&index=" + std::to_string(offset);

    std::string raw;
    if (!httpGetStringWithHeader(url, curseforgeAuthHeader(), raw, errorOut)) return false;

    json parsed;
    try { parsed = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("ERR_NETWORK||") + e.what(); return false; }

    json hits = json::array();
    for (const auto& mod : parsed.value("data", json::array())) {
        json hit;
        hit["curseforge_id"] = mod.value("id", 0);
        hit["title"] = mod.value("name", "");
        hit["slug"] = mod.value("slug", "");
        hit["description"] = mod.value("summary", "");
        hit["downloads"] = mod.value("downloadCount", 0);
        std::string iconUrl;
        if (mod.contains("logo") && mod["logo"].is_object()) iconUrl = mod["logo"].value("thumbnailUrl", "");
        hit["icon_url"] = iconUrl;
        hits.push_back(hit);
    }

    json out;
    out["hits"] = hits;
    out["total_hits"] = parsed.contains("pagination") ? parsed["pagination"].value("totalCount", (int)hits.size()) : (int)hits.size();
    jsonOut = out.dump();
    return true;
}

bool curseforgeProjectDescriptionImpl(const std::string& modId, std::string& htmlOut, std::string& errorOut) {
    std::string url = "https://api.curseforge.com/v1/mods/" + urlEncodeForModrinth(modId) + "/description";
    std::string raw;
    if (!httpGetStringWithHeader(url, curseforgeAuthHeader(), raw, errorOut)) return false;

    try {
        json parsed = json::parse(raw);
        htmlOut = parsed.value("data", "");
    } catch (const std::exception& e) {
        errorOut = std::string("ERR_NETWORK||") + e.what();
        return false;
    }
    return true;
}

bool curseforgeModInfoImpl(const std::string& modId, std::string& titleOut, std::string& iconUrlOut, std::string& errorOut) {
    std::string url = "https://api.curseforge.com/v1/mods/" + urlEncodeForModrinth(modId);
    std::string raw;
    if (!httpGetStringWithHeader(url, curseforgeAuthHeader(), raw, errorOut)) return false;

    try {
        json parsed = json::parse(raw);
        const auto& data = parsed.value("data", json::object());
        titleOut = data.value("name", "");
        if (data.contains("logo") && data["logo"].is_object()) iconUrlOut = data["logo"].value("thumbnailUrl", "");
    } catch (const std::exception& e) {
        errorOut = std::string("ERR_NETWORK||") + e.what();
        return false;
    }
    return true;
}

bool installModCurseForgeImpl(const std::string& modId, const std::string& mcVersion,
                               const std::string& loader, const fs::path& modsDir,
                               std::string& fileNameOut, std::string& errorOut) {
    // См. curseforgeVersionParam выше: часть файлов помечена общей "1.21", а не
    // точным патчем "1.21.4" — берём с запасом (pageSize побольше) под усечённую
    // версию, а затем среди пришедших файлов предпочитаем тот, что явно
    // указывает точный патч в своём списке gameVersions, если такой найдётся.
    std::string url = "https://api.curseforge.com/v1/mods/" + urlEncodeForModrinth(modId) + "/files"
        "?gameVersion=" + urlEncodeForModrinth(curseforgeVersionParam(mcVersion)) +
        "&modLoaderType=" + std::to_string(curseforgeModLoaderType(loader)) +
        "&pageSize=20";

    std::string raw;
    if (!httpGetStringWithHeader(url, curseforgeAuthHeader(), raw, errorOut)) return false;

    json parsed;
    try { parsed = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("ERR_NETWORK||") + e.what(); return false; }

    const auto& files = parsed.value("data", json::array());
    if (files.empty()) { errorOut = "ERR_MOD_INCOMPATIBLE||" + modId + " " + mcVersion + " " + loader; return false; }

    const json* bestFile = &files[0];
    for (const auto& f : files) {
        if (!f.contains("gameVersions")) continue;
        for (const auto& gv : f["gameVersions"]) {
            if (gv.is_string() && gv.get<std::string>() == mcVersion) { bestFile = &f; break; }
        }
    }
    const auto& file = *bestFile;
    std::string downloadUrl = file.value("downloadUrl", "");
    std::string fileName = file.value("fileName", modId + ".jar");
    if (downloadUrl.empty()) { errorOut = "ERR_MOD_NO_FILES||" + modId; return false; }

    std::error_code ec;
    fs::create_directories(modsDir, ec);
    fs::path dest = modsDir / fileName;
    if (!httpDownloadFile(downloadUrl, dest, errorOut)) return false;
    recordModInManifest(modsDir, fileName, mcVersion, loader);
    fileNameOut = fileName;
    return true;
}
bool curseforgeSearchByClassImpl(int classId, const std::string& query, const std::string& mcVersion,
                                  std::string& jsonOut, std::string& errorOut, int offset) {
    if (offset < 0) offset = 0;
    std::string versionParam = mcVersion.empty() ? "" :
        ("&gameVersion=" + urlEncodeForModrinth(curseforgeVersionParam(mcVersion)));
    std::string url = "https://api.curseforge.com/v1/mods/search"
        "?gameId=432&classId=" + std::to_string(classId) +
        "&searchFilter=" + urlEncodeForModrinth(query) +
        versionParam +
        "&sortField=2&sortOrder=desc&pageSize=20&index=" + std::to_string(offset);
    std::string raw;
    if (!httpGetStringWithHeader(url, curseforgeAuthHeader(), raw, errorOut)) return false;

    json parsed;
    try { parsed = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("ERR_NETWORK||") + e.what(); return false; }

    json hits = json::array();
    for (const auto& mod : parsed.value("data", json::array())) {
        json hit;
        hit["curseforge_id"] = mod.value("id", 0);
        hit["title"] = mod.value("name", "");
        hit["slug"] = mod.value("slug", "");
        hit["description"] = mod.value("summary", "");
        hit["downloads"] = mod.value("downloadCount", 0);
        std::string iconUrl;
        if (mod.contains("logo") && mod["logo"].is_object()) iconUrl = mod["logo"].value("thumbnailUrl", "");
        hit["icon_url"] = iconUrl;
        hits.push_back(hit);
    }

    json out;
    out["hits"] = hits;
    out["total_hits"] = parsed.contains("pagination") ? parsed["pagination"].value("totalCount", (int)hits.size()) : (int)hits.size();
    jsonOut = out.dump();
    return true;
}

bool installContentCurseForgeImpl(const std::string& modId, const std::string& mcVersion,
                                   const fs::path& targetDir, std::string& fileNameOut, std::string& errorOut) {
    std::string url = "https://api.curseforge.com/v1/mods/" + urlEncodeForModrinth(modId) + "/files"
        "?gameVersion=" + urlEncodeForModrinth(curseforgeVersionParam(mcVersion)) +
        "&pageSize=20";

    std::string raw;
    if (!httpGetStringWithHeader(url, curseforgeAuthHeader(), raw, errorOut)) return false;

    json parsed;
    try { parsed = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("ERR_NETWORK||") + e.what(); return false; }

    const auto& files = parsed.value("data", json::array());
    if (files.empty()) { errorOut = "ERR_MOD_INCOMPATIBLE||" + modId + " " + mcVersion; return false; }

    const json* bestFile = &files[0];
    for (const auto& f : files) {
        if (!f.contains("gameVersions")) continue;
        for (const auto& gv : f["gameVersions"]) {
            if (gv.is_string() && gv.get<std::string>() == mcVersion) { bestFile = &f; break; }
        }
    }
    const auto& file = *bestFile;
    std::string downloadUrl = file.value("downloadUrl", "");
    std::string fileName = file.value("fileName", modId + ".zip");
    if (downloadUrl.empty()) { errorOut = "ERR_MOD_NO_FILES||" + modId; return false; }

    std::error_code ec;
    fs::create_directories(targetDir, ec);
    fs::path dest = targetDir / fileName;
    if (!httpDownloadFile(downloadUrl, dest, errorOut)) return false;
    fileNameOut = fileName;
    return true;
}

bool installModrinthModpackImpl(const std::string& id, const std::string& mcVersion,
                                 const std::string& instanceName, const std::string& gameDir,
                                 const ProgressFn& onProgress, std::string& resolvedVersionOut,
                                 std::string& resolvedLoaderOut, std::string& errorOut) {
    onProgress("manifest", 0.0, "Ищем сборку на Modrinth...");

    std::string url = "https://api.modrinth.com/v2/project/" + urlEncodeForModrinth(id) + "/version";
    if (!mcVersion.empty()) url += "?game_versions=" + urlEncodeForModrinth("[\"" + mcVersion + "\"]");

    std::string raw;
    if (!httpGetStringFast(url, raw, errorOut)) return false;

    json versions;
    try { versions = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать ответ Modrinth: ") + e.what(); return false; }

    if (!versions.is_array() || versions.empty()) {
        errorOut = "ERR_MOD_INCOMPATIBLE||" + id + " " + mcVersion;
        return false;
    }

    const auto& chosenVersion = versions[0];
    const auto& files = chosenVersion["files"];
    if (!files.is_array() || files.empty()) { errorOut = "ERR_MOD_NO_FILES||" + id; return false; }

    const json* chosenFile = &files[0];
    for (const auto& f : files) {
        if (f.value("primary", false)) { chosenFile = &f; break; }
    }

    std::string packUrl = chosenFile->value("url", "");
    if (packUrl.empty()) { errorOut = "ERR_MOD_NO_FILES||" + id; return false; }

    fs::path root(gameDir);
    fs::path tmpDir = root / "modpack_tmp" / instanceName;
    std::error_code ec;
    fs::remove_all(tmpDir, ec);
    fs::create_directories(tmpDir, ec);

    fs::path mrpackPath = tmpDir / "pack.mrpack";
    onProgress("manifest", 0.1, "Загружаем сборку...");
    if (!httpDownloadFile(packUrl, mrpackPath, errorOut)) return false;

    fs::path extractDir = tmpDir / "extracted";
    if (!extractZipPreservingStructure(mrpackPath, extractDir, errorOut)) return false;

    fs::path indexPath = extractDir / "modrinth.index.json";
    if (!fs::exists(indexPath)) { errorOut = "modrinth.index.json не найден в сборке"; return false; }

    json index;
    {
        std::ifstream f(indexPath, std::ios::binary);
        std::stringstream ss; ss << f.rdbuf();
        try { index = json::parse(ss.str()); }
        catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать modrinth.index.json: ") + e.what(); return false; }
    }

    std::string resolvedMcVersion = mcVersion;
    std::string resolvedLoader = "fabric";
    if (index.contains("dependencies")) {
        const auto& deps = index["dependencies"];
        if (deps.contains("minecraft")) resolvedMcVersion = deps.value("minecraft", mcVersion);
        if (deps.contains("fabric-loader")) resolvedLoader = "fabric";
        else if (deps.contains("forge")) resolvedLoader = "forge";
        else if (deps.contains("quilt-loader")) resolvedLoader = "quilt";
        else if (deps.contains("neoforge")) resolvedLoader = "neoforge";
    }

    fs::path instanceDir = root / "instances" / instanceName;
    fs::create_directories(instanceDir, ec);

    if (index.contains("files")) {
        size_t total = index["files"].size();
        size_t idx = 0;
        for (const auto& entry : index["files"]) {
            idx++;
            if (!waitWhilePausedOrCancelled(errorOut)) return false;

            if (entry.contains("env") && entry["env"].contains("client")) {
                std::string clientEnv = entry["env"].value("client", "required");
                if (clientEnv == "unsupported") continue;
            }

            std::string relPath = entry.value("path", "");
            if (relPath.empty()) continue;
            std::string sha1 = entry.contains("hashes") ? entry["hashes"].value("sha1", "") : "";

            std::string fileUrl;
            if (entry.contains("downloads") && entry["downloads"].is_array() && !entry["downloads"].empty()) {
                fileUrl = entry["downloads"][0].get<std::string>();
            }
            if (fileUrl.empty()) continue;

            fs::path dest = instanceDir / relPath;
            onProgress("mods", (double)idx / (double)std::max<size_t>(1, total), relPath);
            if (!ensureFile(fileUrl, dest, sha1, errorOut)) return false;
        }
    }

    for (const char* overridesDir : {"overrides", "client-overrides"}) {
        fs::path src = extractDir / overridesDir;
        if (fs::exists(src, ec)) {
            fs::copy(src, instanceDir, fs::copy_options::recursive | fs::copy_options::overwrite_existing, ec);
        }
    }

    fs::path metaDir = root / "versions" / instanceName;
    fs::create_directories(metaDir, ec);
    json meta;
    meta["name"] = instanceName;
    meta["mcVersion"] = resolvedMcVersion;
    meta["loader"] = resolvedLoader;
    meta["mods"] = json::array();
    { std::ofstream f(metaDir / "modpack.json", std::ios::binary); f << meta.dump(2); }

    fs::remove_all(tmpDir, ec);

    resolvedVersionOut = resolvedMcVersion;
    resolvedLoaderOut = resolvedLoader;
    onProgress("mods", 1.0, "Сборка установлена");
    return true;
}

bool installCurseForgeModpackImpl(const std::string& id, const std::string& mcVersion,
                                   const std::string& instanceName, const std::string& gameDir,
                                   const ProgressFn& onProgress, std::string& resolvedVersionOut,
                                   std::string& resolvedLoaderOut, std::string& errorOut) {
    onProgress("manifest", 0.0, "Ищем сборку на CurseForge...");

    std::string versionParam = mcVersion.empty() ? "" :
        ("&gameVersion=" + urlEncodeForModrinth(curseforgeVersionParam(mcVersion)));
    std::string url = "https://api.curseforge.com/v1/mods/" + urlEncodeForModrinth(id) + "/files"
        "?pageSize=20" + versionParam;

    std::string raw;
    if (!httpGetStringWithHeader(url, curseforgeAuthHeader(), raw, errorOut)) return false;

    json parsed;
    try { parsed = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("ERR_NETWORK||") + e.what(); return false; }

    const auto& files = parsed.value("data", json::array());
    if (files.empty()) { errorOut = "ERR_MOD_INCOMPATIBLE||" + id + " " + mcVersion; return false; }

    const json& chosenFile = files[0];
    std::string packUrl = chosenFile.value("downloadUrl", "");
    if (packUrl.empty()) { errorOut = "ERR_MOD_NO_FILES||" + id; return false; }

    fs::path root(gameDir);
    fs::path tmpDir = root / "modpack_tmp" / instanceName;
    std::error_code ec;
    fs::remove_all(tmpDir, ec);
    fs::create_directories(tmpDir, ec);

    fs::path packZipPath = tmpDir / "pack.zip";
    onProgress("manifest", 0.1, "Загружаем сборку...");
    if (!httpDownloadFile(packUrl, packZipPath, errorOut)) return false;

    fs::path extractDir = tmpDir / "extracted";
    if (!extractZipPreservingStructure(packZipPath, extractDir, errorOut)) return false;

    fs::path manifestPath = extractDir / "manifest.json";
    if (!fs::exists(manifestPath)) { errorOut = "manifest.json не найден в сборке"; return false; }

    json manifest;
    {
        std::ifstream f(manifestPath, std::ios::binary);
        std::stringstream ss; ss << f.rdbuf();
        try { manifest = json::parse(ss.str()); }
        catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать manifest.json: ") + e.what(); return false; }
    }

    std::string resolvedMcVersion = manifest.contains("minecraft") ? manifest["minecraft"].value("version", mcVersion) : mcVersion;
    std::string resolvedLoader = "forge";
    if (manifest.contains("minecraft") && manifest["minecraft"].contains("modLoaders")) {
        for (const auto& loaderEntry : manifest["minecraft"]["modLoaders"]) {
            std::string loaderId = loaderEntry.value("id", "");
            size_t dashPos = loaderId.find('-');
            if (dashPos != std::string::npos) { resolvedLoader = loaderId.substr(0, dashPos); break; }
        }
    }

    fs::path instanceDir = root / "instances" / instanceName;
    fs::path modsDir = instanceDir / "mods";
    fs::create_directories(modsDir, ec);

    if (manifest.contains("files")) {
        size_t total = manifest["files"].size();
        size_t idx = 0;
        for (const auto& entry : manifest["files"]) {
            idx++;
            if (!waitWhilePausedOrCancelled(errorOut)) return false;

            std::string projectId = std::to_string(entry.value("projectID", 0));
            std::string fileId = std::to_string(entry.value("fileID", 0));
            if (projectId == "0" || fileId == "0") continue;

            std::string fileInfoUrl = "https://api.curseforge.com/v1/mods/" + projectId + "/files/" + fileId;
            std::string fileRaw;
            std::string fileErr;
            if (!httpGetStringWithHeader(fileInfoUrl, curseforgeAuthHeader(), fileRaw, fileErr)) {
                onProgress("mods", (double)idx / (double)std::max<size_t>(1, total), "Пропускаем недоступный файл...");
                continue;
            }

            json fileInfo;
            try { fileInfo = json::parse(fileRaw); }
            catch (...) { continue; }

            if (!fileInfo.contains("data")) continue;
            std::string downloadUrl = fileInfo["data"].value("downloadUrl", "");
            std::string fileName = fileInfo["data"].value("fileName", projectId + ".jar");
            if (downloadUrl.empty()) continue;

            onProgress("mods", (double)idx / (double)std::max<size_t>(1, total), fileName);
            fs::path dest = modsDir / fileName;
            if (!httpDownloadFile(downloadUrl, dest, errorOut)) return false;
        }
    }

    std::string overridesFolder = manifest.value("overrides", "overrides");
    fs::path overridesSrc = extractDir / overridesFolder;
    if (fs::exists(overridesSrc, ec)) {
        fs::copy(overridesSrc, instanceDir, fs::copy_options::recursive | fs::copy_options::overwrite_existing, ec);
    }

    fs::path metaDir = root / "versions" / instanceName;
    fs::create_directories(metaDir, ec);
    json meta;
    meta["name"] = instanceName;
    meta["mcVersion"] = resolvedMcVersion;
    meta["loader"] = resolvedLoader;
    meta["mods"] = json::array();
    { std::ofstream f(metaDir / "modpack.json", std::ios::binary); f << meta.dump(2); }

    fs::remove_all(tmpDir, ec);

    resolvedVersionOut = resolvedMcVersion;
    resolvedLoaderOut = resolvedLoader;
    onProgress("mods", 1.0, "Сборка установлена");
    return true;
}

bool installModpackFromLocalFileImpl(const std::string& localPath, const std::string& instanceName,
                                      const std::string& gameDir, const ProgressFn& onProgress,
                                      std::string& resolvedVersionOut, std::string& resolvedLoaderOut,
                                      std::string& errorOut) {
    fs::path srcFile(localPath);
    std::error_code ec;
    if (!fs::exists(srcFile, ec)) { errorOut = "Файл не найден: " + localPath; return false; }

    fs::path root(gameDir);
    fs::path tmpDir = root / "modpack_tmp" / instanceName;
    fs::remove_all(tmpDir, ec);
    fs::create_directories(tmpDir, ec);

    fs::path extractDir = tmpDir / "extracted";
    onProgress("manifest", 0.05, "Распаковываем архив...");
    if (!extractZipPreservingStructure(srcFile, extractDir, errorOut)) return false;

    fs::path mrpackIndex = extractDir / "modrinth.index.json";
    fs::path cfManifest = extractDir / "manifest.json";

    fs::path instanceDir = root / "instances" / instanceName;
    fs::create_directories(instanceDir, ec);

    std::string resolvedMcVersion, resolvedLoader;

    if (fs::exists(mrpackIndex)) {
        json index;
        {
            std::ifstream f(mrpackIndex, std::ios::binary);
            std::stringstream ss; ss << f.rdbuf();
            try { index = json::parse(ss.str()); }
            catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать modrinth.index.json: ") + e.what(); return false; }
        }

        resolvedMcVersion = "";
        resolvedLoader = "fabric";
        if (index.contains("dependencies")) {
            const auto& deps = index["dependencies"];
            if (deps.contains("minecraft")) resolvedMcVersion = deps.value("minecraft", "");
            if (deps.contains("fabric-loader")) resolvedLoader = "fabric";
            else if (deps.contains("forge")) resolvedLoader = "forge";
            else if (deps.contains("quilt-loader")) resolvedLoader = "quilt";
            else if (deps.contains("neoforge")) resolvedLoader = "neoforge";
        }
        if (resolvedMcVersion.empty()) { errorOut = "Не удалось определить версию Minecraft из сборки"; return false; }

        if (index.contains("files")) {
            size_t total = index["files"].size();
            size_t idx = 0;
            for (const auto& entry : index["files"]) {
                idx++;
                if (!waitWhilePausedOrCancelled(errorOut)) return false;

                if (entry.contains("env") && entry["env"].contains("client")) {
                    std::string clientEnv = entry["env"].value("client", "required");
                    if (clientEnv == "unsupported") continue;
                }

                std::string relPath = entry.value("path", "");
                if (relPath.empty()) continue;
                std::string sha1 = entry.contains("hashes") ? entry["hashes"].value("sha1", "") : "";

                std::string fileUrl;
                if (entry.contains("downloads") && entry["downloads"].is_array() && !entry["downloads"].empty()) {
                    fileUrl = entry["downloads"][0].get<std::string>();
                }
                if (fileUrl.empty()) continue;

                fs::path dest = instanceDir / relPath;
                onProgress("mods", (double)idx / (double)std::max<size_t>(1, total), relPath);
                if (!ensureFile(fileUrl, dest, sha1, errorOut)) return false;
            }
        }

        for (const char* overridesDir : {"overrides", "client-overrides"}) {
            fs::path src = extractDir / overridesDir;
            if (fs::exists(src, ec)) {
                fs::copy(src, instanceDir, fs::copy_options::recursive | fs::copy_options::overwrite_existing, ec);
            }
        }
    } else if (fs::exists(cfManifest)) {
        json manifest;
        {
            std::ifstream f(cfManifest, std::ios::binary);
            std::stringstream ss; ss << f.rdbuf();
            try { manifest = json::parse(ss.str()); }
            catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать manifest.json: ") + e.what(); return false; }
        }

        resolvedMcVersion = manifest.contains("minecraft") ? manifest["minecraft"].value("version", "") : "";
        resolvedLoader = "forge";
        if (manifest.contains("minecraft") && manifest["minecraft"].contains("modLoaders")) {
            for (const auto& loaderEntry : manifest["minecraft"]["modLoaders"]) {
                std::string loaderId = loaderEntry.value("id", "");
                size_t dashPos = loaderId.find('-');
                if (dashPos != std::string::npos) { resolvedLoader = loaderId.substr(0, dashPos); break; }
            }
        }
        if (resolvedMcVersion.empty()) { errorOut = "Не удалось определить версию Minecraft из сборки"; return false; }

        fs::path modsDir = instanceDir / "mods";
        fs::create_directories(modsDir, ec);

        if (manifest.contains("files")) {
            size_t total = manifest["files"].size();
            size_t idx = 0;
            for (const auto& entry : manifest["files"]) {
                idx++;
                if (!waitWhilePausedOrCancelled(errorOut)) return false;

                std::string projectId = std::to_string(entry.value("projectID", 0));
                std::string fileId = std::to_string(entry.value("fileID", 0));
                if (projectId == "0" || fileId == "0") continue;

                std::string fileInfoUrl = "https://api.curseforge.com/v1/mods/" + projectId + "/files/" + fileId;
                std::string fileRaw, fileErr;
                if (!httpGetStringWithHeader(fileInfoUrl, curseforgeAuthHeader(), fileRaw, fileErr)) {
                    onProgress("mods", (double)idx / (double)std::max<size_t>(1, total), "Пропускаем недоступный файл...");
                    continue;
                }

                json fileInfo;
                try { fileInfo = json::parse(fileRaw); } catch (...) { continue; }
                if (!fileInfo.contains("data")) continue;
                std::string downloadUrl = fileInfo["data"].value("downloadUrl", "");
                std::string fileName = fileInfo["data"].value("fileName", projectId + ".jar");
                if (downloadUrl.empty()) continue;

                onProgress("mods", (double)idx / (double)std::max<size_t>(1, total), fileName);
                fs::path dest = modsDir / fileName;
                if (!httpDownloadFile(downloadUrl, dest, errorOut)) return false;
            }
        }

        std::string overridesFolder = manifest.value("overrides", "overrides");
        fs::path overridesSrc = extractDir / overridesFolder;
        if (fs::exists(overridesSrc, ec)) {
            fs::copy(overridesSrc, instanceDir, fs::copy_options::recursive | fs::copy_options::overwrite_existing, ec);
        }
    } else {
        errorOut = "Это не похоже на модпак (нет modrinth.index.json или manifest.json)";
        return false;
    }

    fs::path metaDir = root / "versions" / instanceName;
    fs::create_directories(metaDir, ec);
    json meta;
    meta["name"] = instanceName;
    meta["mcVersion"] = resolvedMcVersion;
    meta["loader"] = resolvedLoader;
    meta["mods"] = json::array();
    { std::ofstream f(metaDir / "modpack.json", std::ios::binary); f << meta.dump(2); }

    fs::remove_all(tmpDir, ec);

    resolvedVersionOut = resolvedMcVersion;
    resolvedLoaderOut = resolvedLoader;
    onProgress("mods", 1.0, "Сборка установлена");
    return true;
}

bool extractModJarsFromZipImpl(const fs::path& zipPath, const fs::path& outDir, int& jarCountOut, std::string& errorOut) {
    std::ifstream in(zipPath, std::ios::binary);
    if (!in) { errorOut = "Не удалось открыть архив " + zipPath.string(); return false; }

    in.seekg(0, std::ios::end);
    std::streamoff fileSize = in.tellg();
    if (fileSize < 22) { errorOut = "Архив повреждён (слишком маленький файл)"; return false; }

    std::streamoff searchStart = std::max<std::streamoff>(0, fileSize - 66000);
    in.seekg(searchStart);
    std::vector<char> tail((size_t)(fileSize - searchStart));
    in.read(tail.data(), (std::streamsize)tail.size());

    int eocdPos = -1;
    for (int i = (int)tail.size() - 22; i >= 0; i--) {
        if ((uint8_t)tail[i] == 0x50 && (uint8_t)tail[i+1] == 0x4b &&
            (uint8_t)tail[i+2] == 0x05 && (uint8_t)tail[i+3] == 0x06) { eocdPos = i; break; }
    }
    if (eocdPos < 0) { errorOut = "Не найден конец центрального каталога zip (EOCD)"; return false; }

    auto readU16 = [&](int off) { return (uint16_t)((uint8_t)tail[off] | ((uint8_t)tail[off+1] << 8)); };
    auto readU32 = [&](int off) { return (uint32_t)((uint8_t)tail[off] | ((uint8_t)tail[off+1] << 8) |
                                                      ((uint8_t)tail[off+2] << 16) | ((uint8_t)tail[off+3] << 24)); };

    uint16_t entryCount = readU16(eocdPos + 10);
    uint32_t cdOffset = readU32(eocdPos + 16);

    in.seekg((std::streamoff)cdOffset);
    std::error_code ec;
    fs::create_directories(outDir, ec);

    int jarCount = 0;

    for (uint16_t i = 0; i < entryCount; i++) {
        char hdr[46];
        in.read(hdr, 46);
        if (in.gcount() != 46) break;
        if (!(hdr[0]==0x50 && hdr[1]==0x4b && hdr[2]==0x01 && hdr[3]==0x02)) break;

        uint16_t method = (uint16_t)((uint8_t)hdr[10] | ((uint8_t)hdr[11] << 8));
        uint32_t compSize = (uint32_t)((uint8_t)hdr[20] | ((uint8_t)hdr[21]<<8) | ((uint8_t)hdr[22]<<16) | ((uint8_t)hdr[23]<<24));
        uint32_t uncompSize = (uint32_t)((uint8_t)hdr[24] | ((uint8_t)hdr[25]<<8) | ((uint8_t)hdr[26]<<16) | ((uint8_t)hdr[27]<<24));
        uint16_t nameLen = (uint16_t)((uint8_t)hdr[28] | ((uint8_t)hdr[29]<<8));
        uint16_t extraLen = (uint16_t)((uint8_t)hdr[30] | ((uint8_t)hdr[31]<<8));
        uint16_t commentLen = (uint16_t)((uint8_t)hdr[32] | ((uint8_t)hdr[33]<<8));
        uint32_t localHeaderOffset = (uint32_t)((uint8_t)hdr[42] | ((uint8_t)hdr[43]<<8) | ((uint8_t)hdr[44]<<16) | ((uint8_t)hdr[45]<<24));

        std::string name(nameLen, '\0');
        in.read(name.data(), nameLen);
        in.seekg(extraLen + commentLen, std::ios::cur);

        std::string lowerName = name;
        std::transform(lowerName.begin(), lowerName.end(), lowerName.begin(), ::tolower);
        bool isJar = lowerName.size() > 4 && lowerName.compare(lowerName.size() - 4, 4, ".jar") == 0;

        if (isJar) {
            std::streamoff cdReturnPos = in.tellg();

            in.seekg((std::streamoff)localHeaderOffset);
            char lhdr[30];
            in.read(lhdr, 30);
            uint16_t lNameLen = (uint16_t)((uint8_t)lhdr[26] | ((uint8_t)lhdr[27]<<8));
            uint16_t lExtraLen = (uint16_t)((uint8_t)lhdr[28] | ((uint8_t)lhdr[29]<<8));
            in.seekg(lNameLen + lExtraLen, std::ios::cur);

            std::vector<char> compData(compSize);
            if (compSize > 0) in.read(compData.data(), compSize);

            std::vector<char> outData;
            bool ok = true;
            if (method == 0) {
                outData.assign(compData.begin(), compData.end());
            } else if (method == 8) {
                outData.resize(uncompSize);
                z_stream zs{};
                inflateInit2(&zs, -MAX_WBITS);
                zs.next_in = (Bytef*)compData.data();
                zs.avail_in = (uInt)compData.size();
                zs.next_out = (Bytef*)outData.data();
                zs.avail_out = (uInt)outData.size();
                inflate(&zs, Z_FINISH);
                inflateEnd(&zs);
            } else {
                ok = false;
            }

            if (ok) {
                fs::path flatName = fs::path(name).filename();
                fs::path outPath = outDir / flatName;
                std::ofstream outFile(outPath, std::ios::binary | std::ios::trunc);
                if (outFile) { outFile.write(outData.data(), (std::streamsize)outData.size()); jarCount++; }
            }

            in.seekg(cdReturnPos);
        }
    }

    jarCountOut = jarCount;
    if (jarCount == 0) {
        errorOut = "ERR_ARCHIVE_NO_JARS||";
        return false;
    }
    return true;
}

bool extractMapZipImpl(const fs::path& zipPath, const fs::path& outDir, std::string& errorOut) {
    fs::path tmpDir = outDir / (".map_tmp_" + zipPath.stem().string());
    std::error_code ec;
    fs::remove_all(tmpDir, ec);
    if (!extractZipPreservingStructure(zipPath, tmpDir, errorOut)) {
        fs::remove_all(tmpDir, ec);
        return false;
    }

    bool hasLevelDat = false;
    for (auto it = fs::recursive_directory_iterator(tmpDir, fs::directory_options::skip_permission_denied, ec);
         it != fs::recursive_directory_iterator(); it.increment(ec)) {
        if (ec) break;
        std::error_code fileEc;
        if (!it->is_regular_file(fileEc)) continue;
        if (it->path().filename() == "level.dat") { hasLevelDat = true; break; }
    }

    if (!hasLevelDat) {
        fs::remove_all(tmpDir, ec);
        errorOut = "ERR_MAP_NO_LEVEL_DAT||";
        return false;
    }

    fs::create_directories(outDir, ec);
    for (auto& entry : fs::directory_iterator(tmpDir, ec)) {
        fs::path dest = outDir / entry.path().filename();
        std::error_code moveEc;
        fs::remove_all(dest, moveEc);
        fs::rename(entry.path(), dest, moveEc);
        if (moveEc) {
            fs::copy(entry.path(), dest, fs::copy_options::recursive | fs::copy_options::overwrite_existing, moveEc);
        }
    }
    fs::remove_all(tmpDir, ec);
    return true;
}

std::optional<fs::path> findRarExtractorTool() {
    const char* candidates[] = {
        "C:\\Program Files\\7-Zip\\7z.exe",
        "C:\\Program Files (x86)\\7-Zip\\7z.exe",
        "C:\\Program Files\\WinRAR\\UnRAR.exe",
        "C:\\Program Files (x86)\\WinRAR\\UnRAR.exe",
        "C:\\Program Files\\WinRAR\\Rar.exe",
        "C:\\Program Files (x86)\\WinRAR\\Rar.exe",
    };
    for (const char* c : candidates) {
        std::error_code ec;
        if (fs::exists(c, ec)) return fs::path(c);
    }
    return std::nullopt;
}

bool extractRarToDir(const fs::path& rarPath, const fs::path& outDir, std::string& errorOut) {
    auto tool = findRarExtractorTool();
    if (!tool) { errorOut = "ERR_RAR_NO_TOOL||"; return false; }

    std::error_code ec;
    fs::create_directories(outDir, ec);

    std::string toolName = tool->filename().string();
    std::transform(toolName.begin(), toolName.end(), toolName.begin(), ::tolower);
    bool is7z = toolName.find("7z") != std::string::npos;

    std::ostringstream cmd;
    if (is7z) {
        cmd << "\"" << tool->string() << "\" x \"" << rarPath.string() << "\" -o\"" << outDir.string() << "\" -y -bd";
    } else {
        cmd << "\"" << tool->string() << "\" x -y -inul \"" << rarPath.string() << "\" \"" << outDir.string() << "\\\"";
    }

    fs::path logPath = outDir / "_extract.log";
    DWORD exitCode = 0;
    if (!runProcessSyncWithLog(cmd.str(), outDir, logPath, exitCode, errorOut, 60000)) return false;

    if (exitCode != 0) {
        errorOut = "ERR_RAR_EXTRACT_FAILED||exit " + std::to_string(exitCode) + "; " + readLogTail(logPath);
        return false;
    }
    fs::remove(logPath, ec);
    return true;
}

bool extractModJarsFromArchiveImpl(const fs::path& archivePath, const fs::path& targetDir, int& jarCountOut, std::string& errorOut) {
    std::string ext = archivePath.extension().string();
    std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);

    if (ext == ".zip") return extractModJarsFromZipImpl(archivePath, targetDir, jarCountOut, errorOut);
    if (ext != ".rar") { errorOut = "Неподдерживаемый формат архива"; return false; }

    fs::path tmpDir = targetDir / (".rar_tmp_" + archivePath.stem().string());
    std::error_code ec;
    fs::remove_all(tmpDir, ec);
    if (!extractRarToDir(archivePath, tmpDir, errorOut)) { fs::remove_all(tmpDir, ec); return false; }

    int count = 0;
    std::error_code fec;
    for (auto it = fs::recursive_directory_iterator(tmpDir, fs::directory_options::skip_permission_denied, fec);
         it != fs::recursive_directory_iterator(); it.increment(fec)) {
        if (fec) break;
        std::error_code fileEc;
        if (!it->is_regular_file(fileEc)) continue;
        std::string lower = it->path().extension().string();
        std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
        if (lower != ".jar") continue;

        std::error_code copyEc;
        fs::copy_file(it->path(), targetDir / it->path().filename(), fs::copy_options::overwrite_existing, copyEc);
        if (!copyEc) count++;
    }

    fs::remove_all(tmpDir, ec);
    jarCountOut = count;
    if (count == 0) { errorOut = "ERR_ARCHIVE_NO_JARS||"; return false; }
    return true;
}

bool extractMapArchiveImpl(const fs::path& archivePath, const fs::path& outDir, std::string& errorOut) {
    std::string ext = archivePath.extension().string();
    std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);

    if (ext == ".zip") return extractMapZipImpl(archivePath, outDir, errorOut);
    if (ext != ".rar") { errorOut = "Неподдерживаемый формат архива"; return false; }

    fs::path tmpDir = outDir / (".rar_map_tmp_" + archivePath.stem().string());
    std::error_code ec;
    fs::remove_all(tmpDir, ec);
    if (!extractRarToDir(archivePath, tmpDir, errorOut)) { fs::remove_all(tmpDir, ec); return false; }

    bool hasLevelDat = false;
    fs::path levelDatDir;
    std::error_code fec;
    for (auto it = fs::recursive_directory_iterator(tmpDir, fs::directory_options::skip_permission_denied, fec);
         it != fs::recursive_directory_iterator(); it.increment(fec)) {
        if (fec) break;
        std::error_code fileEc;
        if (!it->is_regular_file(fileEc)) continue;
        if (it->path().filename() == "level.dat") { hasLevelDat = true; levelDatDir = it->path().parent_path(); break; }
    }

    if (!hasLevelDat) { fs::remove_all(tmpDir, ec); errorOut = "ERR_MAP_NO_LEVEL_DAT||"; return false; }

    fs::create_directories(outDir, ec);
    for (auto& entry : fs::directory_iterator(levelDatDir, ec)) {
        fs::path dest = outDir / entry.path().filename();
        std::error_code moveEc;
        fs::remove_all(dest, moveEc);
        fs::rename(entry.path(), dest, moveEc);
        if (moveEc) fs::copy(entry.path(), dest, fs::copy_options::recursive | fs::copy_options::overwrite_existing, moveEc);
    }
    fs::remove_all(tmpDir, ec);
    return true;
}

bool extractZipFromRarArchiveImpl(const fs::path& rarPath, const fs::path& targetDir, std::string& fileNameOut, std::string& errorOut) {
    fs::path tmpDir = targetDir / (".rar_content_tmp_" + rarPath.stem().string());
    std::error_code ec;
    fs::remove_all(tmpDir, ec);
    if (!extractRarToDir(rarPath, tmpDir, errorOut)) { fs::remove_all(tmpDir, ec); return false; }

    std::optional<fs::path> foundZip;
    std::error_code fec;
    for (auto it = fs::recursive_directory_iterator(tmpDir, fs::directory_options::skip_permission_denied, fec);
         it != fs::recursive_directory_iterator(); it.increment(fec)) {
        if (fec) break;
        std::error_code fileEc;
        if (!it->is_regular_file(fileEc)) continue;
        std::string lower = it->path().extension().string();
        std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
        if (lower == ".zip") { foundZip = it->path(); break; }
    }

    if (!foundZip) { fs::remove_all(tmpDir, ec); errorOut = "ERR_RAR_NO_ZIP_INSIDE||"; return false; }

    fs::create_directories(targetDir, ec);
    std::error_code copyEc;
    fs::copy_file(*foundZip, targetDir / foundZip->filename(), fs::copy_options::overwrite_existing, copyEc);
    std::string resultName = foundZip->filename().string();
    fs::remove_all(tmpDir, ec);
    if (copyEc) { errorOut = "Не удалось скопировать файл: " + copyEc.message(); return false; }

    fileNameOut = resultName;
    return true;
}
} // anonymous namespace

// ============================================
// Основной пайплайн
// ============================================
bool launchMinecraft(const LaunchRequest& req, const ProgressFn& onProgress, std::string& errorOut) {
    // ВАЖНО: g_paused/g_cancelled — глобальные флаги на весь процесс. Если их не
    // сбрасывать в начале КАЖДОГО нового запуска, то один раз нажатая "Отмена"
    // (или отмена в другой операции, например при установке мода) навсегда
    // оставляла g_cancelled == true, и все последующие запуски — даже другой
    // версии/загрузчика — мгновенно падали с "CANCELLED" на первой же проверке
    // waitWhilePausedOrCancelled(), что выглядело как "ошибка не пропадает" и
    // как "кнопка отмены не работает".
    g_cancelled.store(false);
    g_paused.store(false);

    // OptiFine и Forge+OptiFine временно отключены (см. LOADERS в app.js) —
    // зависели от сторонних зеркал (BMCLAPI/FastMCMirror) и оказались слишком
    // нестабильными для стабильного релиза. Отклоняем сразу, до тяжёлых
    // загрузок, понятной ошибкой на случай, если фронтенд всё же прислал
    // такой запрос (например, из старого сохранённого выбора).
    if (req.loader != "vanilla" && req.loader != "fabric" && req.loader != "forge" &&
        req.loader != "neoforge" && req.loader != "quilt") {
        errorOut = "Загрузчик \"" + req.loader + "\" временно недоступен.";
        return false;
    }

    fs::path root(req.gameDir);
    fs::path versionsDir = root / "versions" / req.version;
    fs::path librariesDir = root / "libraries";
    fs::path assetsDir = root / "assets";
    fs::path nativesDir = versionsDir / "natives";

    // --- 1. Version manifest ---
    onProgress("manifest", 0.0, "Получаем список версий...");
    std::string manifestRaw;
    if (!httpGetString("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json", manifestRaw, errorOut))
        return false;

    json manifest;
    try { manifest = json::parse(manifestRaw); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать version manifest: ") + e.what(); return false; }

    std::string versionJsonUrl;
    for (const auto& v : manifest["versions"]) {
        if (v.value("id", "") == req.version) { versionJsonUrl = v.value("url", ""); break; }
    }
    if (versionJsonUrl.empty()) { errorOut = "ERR_VERSION_NOT_FOUND||" + req.version; return false; }

    // --- 2. Version JSON ---
    onProgress("manifest", 0.5, "Загружаем описание версии " + req.version + "...");
    std::string versionJsonRaw;
    if (!httpGetString(versionJsonUrl, versionJsonRaw, errorOut)) return false;

    json vjson;
    try { vjson = json::parse(versionJsonRaw); }
    catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать version.json: ") + e.what(); return false; }

    fs::create_directories(versionsDir);
    { std::ofstream f(versionsDir / (req.version + ".json"), std::ios::binary); f << versionJsonRaw; }

    // --- 3. Java: решаем, чем запускать, ДО тяжёлых закачек, чтобы не
    // тратить время на client.jar/библиотеки/ассеты, если Java в итоге
    // не найдётся и не скачается.
    onProgress("java", 0.0, "Проверяем Java...");

    std::string requiredComponent = "jre-legacy";
    int requiredMajor = 8;
    if (vjson.contains("javaVersion")) {
        requiredComponent = vjson["javaVersion"].value("component", "jre-legacy");
        requiredMajor = vjson["javaVersion"].value("majorVersion", 8);
    }

    std::string javaPath;
    bool manualPathValid = !req.javaPath.empty() && fs::exists(req.javaPath);

    if (manualPathValid) {
        // Уважаем явный выбор пользователя в настройках, не переопределяем его —
        // он мог специально указать нужную ему сборку JDK.
        javaPath = req.javaPath;
    } else {
        auto fallback = findFallbackJava();
        int fallbackMajor = fallback ? detectJavaMajorVersion(*fallback) : -1;

        if (fallback && (fallbackMajor == requiredMajor || fallbackMajor == -1)) {
            // Нашли Java в системе и её major-версия совпадает с требуемой
            // (или не удалось определить версию — тогда пробуем как есть).
            javaPath = fallback->string();
        } else {
            // Ничего подходящего не нашли — скачиваем portable JRE от Mojang,
            // как это делает официальный лаунчер и TLauncher: изолированно,
            // в свою папку, без установки в систему.
            fs::path runtimeRoot = root / "runtime";
            fs::path bundledJava;
            if (!ensureBundledJavaRuntime(requiredComponent, runtimeRoot, onProgress, bundledJava, errorOut)) {
                return false;
            }
            javaPath = bundledJava.string();
        }
    }

    // --- 4. client.jar ---
    onProgress("client", 0.0, "Загружаем client.jar...");
    fs::path clientJarPath = versionsDir / (req.version + ".jar");
    {
        auto dl = vjson["downloads"]["client"];
        if (!waitWhilePausedOrCancelled(errorOut)) return false;
        if (!ensureFile(dl.value("url",""), clientJarPath, dl.value("sha1",""), errorOut)) return false;
    }

    // --- 4.5. Forge (если выбран) ---
    // Важно делать это ДО общего цикла скачивания библиотек (шаг 5): мы
    // просто добавляем библиотеки/аргументы Forge в vjson, и дальше их
    // скачает тот же самый цикл, что качает ванильные.
    if (req.loader == "forge") {
        onProgress("libraries", 0.0, "Готовим Forge...");
        if (!prepareForge(req.version, root, javaPath, vjson, onProgress, errorOut)) return false;
    }
    if (req.loader == "neoforge") {
        onProgress("libraries", 0.0, "Готовим NeoForge...");
        if (!prepareNeoForge(req.version, root, javaPath, vjson, onProgress, errorOut)) return false;
    }

    // --- 5. Библиотеки (+ извлечение natives) ---
    std::vector<std::string> classpathEntries;
    std::vector<fs::path> nativesJarsToExtract;

    if (vjson.contains("libraries")) {
        size_t total = vjson["libraries"].size();
        size_t idx = 0;
        for (const auto& lib : vjson["libraries"]) {
            idx++;
            if (!waitWhilePausedOrCancelled(errorOut)) return false;
            onProgress("libraries", (double)idx / (double)std::max<size_t>(1,total), "");

            if (lib.contains("rules") && !rulesAllowWindows(lib["rules"])) continue;

            if (lib.contains("downloads")) {
                const auto& downloads = lib["downloads"];

                if (downloads.contains("artifact")) {
                    const auto& art = downloads["artifact"];
                    fs::path dest = librariesDir / fs::path(art.value("path",""));
                    if (!ensureFile(art.value("url",""), dest, art.value("sha1",""), errorOut)) return false;
                    classpathEntries.push_back(dest.string());
                }

                if (lib.contains("natives") && downloads.contains("classifiers")) {
                    std::string classifierKey = lib["natives"].value("windows", "");
                    size_t archPos = classifierKey.find("${arch}");
                    if (archPos != std::string::npos) classifierKey.replace(archPos, 7, "64");

                    if (!classifierKey.empty() && downloads["classifiers"].contains(classifierKey)) {
                        const auto& art = downloads["classifiers"][classifierKey];
                        fs::path dest = librariesDir / fs::path(art.value("path",""));
                        if (!ensureFile(art.value("url",""), dest, art.value("sha1",""), errorOut)) return false;
                        nativesJarsToExtract.push_back(dest);
                    }
                }
            }
        }
    }

    onProgress("libraries", 1.0, "Распаковываем нативные библиотеки...");
    fs::create_directories(nativesDir);
    for (const auto& jarPath : nativesJarsToExtract) {
        extractZipFlatIgnoringDirsAndMeta(jarPath, nativesDir);
    }

    // --- 5.5. Fabric (если выбран) ---
    std::string fabricMainClass;
    if (req.loader == "fabric") {
        onProgress("libraries", 1.0, "Загружаем Fabric Loader...");
        if (!prepareFabric(req.version, librariesDir, classpathEntries, fabricMainClass, errorOut)) return false;
    }
    if (req.loader == "quilt") {
        onProgress("libraries", 1.0, "Загружаем Quilt Loader...");
        if (!prepareQuilt(req.version, librariesDir, classpathEntries, fabricMainClass, errorOut)) return false;
    }
    // --- 6. Ассеты ---
    if (vjson.contains("assetIndex")) {
        onProgress("assets", 0.0, "Загружаем индекс ассетов...");
        auto assetIndexInfo = vjson["assetIndex"];
        fs::path indexDir = assetsDir / "indexes";
        fs::path indexPath = indexDir / (assetIndexInfo.value("id","") + ".json");
        if (!ensureFile(assetIndexInfo.value("url",""), indexPath, assetIndexInfo.value("sha1",""), errorOut)) return false;

        std::ifstream indexFile(indexPath, std::ios::binary);
        std::stringstream ss; ss << indexFile.rdbuf();
        json assetIndex;
        try { assetIndex = json::parse(ss.str()); }
        catch (const std::exception& e) { errorOut = std::string("Не удалось разобрать asset index: ") + e.what(); return false; }

        if (assetIndex.contains("objects")) {
            size_t total = assetIndex["objects"].size();
            size_t idx = 0;
            for (auto it = assetIndex["objects"].begin(); it != assetIndex["objects"].end(); ++it) {
                idx++;
                if (!waitWhilePausedOrCancelled(errorOut)) return false;
                std::string hash = it.value().value("hash", "");
                if (hash.size() < 2) continue;
                std::string prefix = hash.substr(0, 2);
                fs::path dest = assetsDir / "objects" / prefix / hash;
                std::string url = "https://resources.download.minecraft.net/" + prefix + "/" + hash;

                if ((idx % 25) == 0 || idx == total) {
                    onProgress("assets", (double)idx / (double)std::max<size_t>(1,total), "");
                }

                if (!ensureFile(url, dest, hash, errorOut)) return false;
            }
        }
    }

    // --- 7. Java-аргументы и запуск ---
    onProgress("launch", 0.0, "Готовим запуск...");

    bool isOnlineAuth = !req.authUuid.empty() && !req.authAccessToken.empty();
    std::string uuid = isOnlineAuth ? req.authUuid : offlineUuidFromUsername(req.username);
    std::string accessToken = isOnlineAuth ? req.authAccessToken : "0";
    std::string userType = isOnlineAuth ? "msa" : "legacy";

    // Обычная игра (не модпак): используем корень gameDir напрямую — единая
    // общая mods/saves/resourcepacks для всего, как ставит "Моды" во вкладке
    // "Моды" (см. app.js). Раньше тут всегда была instances/<version>, но
    // версия ничего не знала о загрузчике — из-за этого Fabric и Forge на
    // одной и той же версии Minecraft писали моды в одну и ту же папку и
    // конфликтовали. instances/<name> оставлен ТОЛЬКО для реальных модпаков
    // (req.instanceName непустой, задаётся при "+ Создать модпак") — у них
    // осознанная изоляция мода от мода как раз и есть весь смысл модпака.
    fs::path instanceDir = req.instanceName.empty() ? root : (root / "instances" / req.instanceName);
    fs::create_directories(instanceDir);

    // Автоматически отключаем моды, несовместимые с запускаемой версией, и
    // включаем обратно совместимые (кроме отключённых игроком вручную) — см.
    // reconcileModsForVersion выше. Для модпаков это не нужно: там все моды
    // и так собраны под одну версию из instances/<name>/mods.
    if (req.instanceName.empty()) {
        reconcileModsForVersion(instanceDir / "mods", req.version);
    }

    int ramMb = req.ramMb;
    if (ramMb < 512) ramMb = 512;
    if (ramMb > 65536) ramMb = 65536;

    std::string classpath = clientJarPath.string();
    for (const auto& e : classpathEntries) classpath += ";" + e;

    std::vector<std::pair<std::string,std::string>> vars = {
        {"auth_player_name", req.username},
        {"version_name", req.version},
        {"game_directory", instanceDir.string()},
        {"assets_root", assetsDir.string()},
        {"assets_index_name", vjson.value("assets", req.version)},
        {"auth_uuid", uuid},
        {"auth_access_token", accessToken},
        {"user_type", userType},
        {"version_type", vjson.value("type", "release")},
        {"natives_directory", nativesDir.string()},
        {"launcher_name", "MagmaLauncher"},
        {"launcher_version", "1.0"},
        {"classpath", classpath},
        {"auth_session", "0"},
        {"game_assets", (assetsDir / "virtual" / "legacy").string()},
        {"user_properties", "{}"},
    };

    std::vector<std::string> jvmArgs;
    std::vector<std::string> gameArgs;

    if (vjson.contains("arguments")) {
        auto collect = [&](const json& arr, std::vector<std::string>& out) {
            for (const auto& item : arr) {
                if (item.is_string()) {
                    out.push_back(substitutePlaceholders(item.get<std::string>(), vars));
                } else if (item.is_object()) {
                    if (item.contains("rules") && !rulesAllowWindows(item["rules"])) continue;
                    if (item["value"].is_string()) {
                        out.push_back(substitutePlaceholders(item["value"].get<std::string>(), vars));
                    } else if (item["value"].is_array()) {
                        for (const auto& v : item["value"])
                            out.push_back(substitutePlaceholders(v.get<std::string>(), vars));
                    }
                }
            }
        };
        if (vjson["arguments"].contains("jvm")) collect(vjson["arguments"]["jvm"], jvmArgs);
        if (vjson["arguments"].contains("game")) collect(vjson["arguments"]["game"], gameArgs);
    } else if (vjson.contains("minecraftArguments")) {
        jvmArgs = { "-Djava.library.path=" + nativesDir.string(), "-cp", classpath };
        std::istringstream iss(vjson["minecraftArguments"].get<std::string>());
        std::string tok;
        while (iss >> tok) gameArgs.push_back(substitutePlaceholders(tok, vars));
    }

    // Прямое подключение к серверу (см. LaunchRequest::quickPlayServer) —
    // тот же механизм "Quick Play", которым официальный лаунчер открывает
    // игру сразу в мире/на сервере по клику извне. Поддерживается начиная
    // с версий, где он вообще существует (1.20+); на более старых версиях
    // игра просто не узнает этот аргумент и откроется на обычном меню.
    if (!req.quickPlayServer.empty()) {
        gameArgs.push_back("--quickPlayMultiplayer");
        gameArgs.push_back(req.quickPlayServer);
    }

    // Дополнительные флаги JVM из настроек лаунчера — добавляются как есть,
    // разделённые пробелами (ничего не валидируем, это осознанный выбор
    // игрока в разделе "для опытных пользователей").
    if (!req.extraJvmArgs.empty()) {
        std::istringstream extraJvmIss(req.extraJvmArgs);
        std::string extraTok;
        while (extraJvmIss >> extraTok) jvmArgs.push_back(extraTok);
    }

    // Полноэкранный режим — не launch-аргумент самой игры, а её собственная
    // настройка (options.txt), поэтому патчим файл настроек инстанса прямо
    // перед запуском, сохраняя все остальные уже существующие ключи как есть.
    if (req.fullscreen) {
        fs::path optionsPath = instanceDir / "options.txt";
        std::vector<std::pair<std::string, std::string>> optionLines;
        bool fullscreenLineFound = false;
        if (fs::exists(optionsPath)) {
            std::ifstream optionsIn(optionsPath);
            std::string line;
            while (std::getline(optionsIn, line)) {
                size_t sep = line.find(':');
                if (sep == std::string::npos) continue;
                std::string key = line.substr(0, sep);
                if (key == "fullscreen") {
                    optionLines.push_back({key, "true"});
                    fullscreenLineFound = true;
                } else {
                    optionLines.push_back({key, line.substr(sep + 1)});
                }
            }
        }
        if (!fullscreenLineFound) optionLines.push_back({"fullscreen", "true"});

        std::ofstream optionsOut(optionsPath, std::ios::binary | std::ios::trunc);
        for (auto& kv : optionLines) optionsOut << kv.first << ":" << kv.second << "\n";
    } else if (req.windowWidth > 0 && req.windowHeight > 0) {
        gameArgs.push_back("--width");
        gameArgs.push_back(std::to_string(req.windowWidth));
        gameArgs.push_back("--height");
        gameArgs.push_back(std::to_string(req.windowHeight));
    }

    bool hasCp = false, hasLibPath = false;
    for (auto& a : jvmArgs) {
        if (a == "-cp" || a == "-classpath") hasCp = true;
        if (a.rfind("-Djava.library.path", 0) == 0) hasLibPath = true;
    }
    if (!hasLibPath) jvmArgs.insert(jvmArgs.begin(), "-Djava.library.path=" + nativesDir.string());
    if (!hasCp) { jvmArgs.push_back("-cp"); jvmArgs.push_back(classpath); }

    std::string mainClass = ((req.loader == "fabric" || req.loader == "quilt") && !fabricMainClass.empty())
        ? fabricMainClass
        : vjson.value("mainClass", "net.minecraft.client.main.Main");

    std::ostringstream cmd;
    cmd << "\"" << javaPath << "\" -Xmx" << ramMb << "M -Xms" << std::min(ramMb, 1024) << "M ";
    for (auto& a : jvmArgs) cmd << a << " ";
    cmd << mainClass << " ";
    for (auto& a : gameArgs) cmd << a << " ";

    onProgress("launch", 0.5, "Запускаем Java...");

    std::string cmdLine = cmd.str();
    std::vector<char> cmdBuf(cmdLine.begin(), cmdLine.end());
    cmdBuf.push_back('\0');

    STARTUPINFOA si{}; si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    BOOL ok = CreateProcessA(
        nullptr, cmdBuf.data(), nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW, nullptr, instanceDir.string().c_str(), &si, &pi);

    if (!ok) {
        DWORD err = GetLastError();
        errorOut = "ERR_JAVA_LAUNCH_FAILED||" + winErrorMessage(err) + " (" + std::to_string(err) + "); " + javaPath;
        return false;
    }
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    onProgress("launch", 1.0, "Игра запущена");
    return true;
}

bool detectSystemJava(std::string& javaPathOut, std::string& errorOut) {
    auto found = findFallbackJava();
    if (!found) {
        errorOut = "Java не найдена в системе (PATH или стандартные папки установки JDK)";
        return false;
    }
    javaPathOut = found->string();
    return true;
}

bool discordPresenceStart(const std::string& appId, std::string& errorOut) {
    if (g_discordConnected.load()) return true;
    if (!discordConnectPipe()) { errorOut = "Discord не запущен или IPC-канал недоступен"; return false; }

    json handshake;
    handshake["v"] = 1;
    handshake["client_id"] = appId;
    if (!discordWriteFrame(0, handshake.dump())) {
        CloseHandle(g_discordPipe); g_discordPipe = INVALID_HANDLE_VALUE;
        errorOut = "Не удалось отправить handshake";
        return false;
    }

    std::string response;
    if (!discordReadFrame(response)) {
        CloseHandle(g_discordPipe); g_discordPipe = INVALID_HANDLE_VALUE;
        errorOut = "Discord не ответил на handshake";
        return false;
    }

    g_discordConnected.store(true);
    return true;
}

void discordPresenceSetActivity(const std::string& details, const std::string& state,
                                 const std::string& largeImageKey, const std::string& largeImageText,
                                 long long startTimestamp) {
    if (!g_discordConnected.load()) return;

    json activity;
    activity["details"] = details;
    activity["state"] = state;
    if (startTimestamp > 0) activity["timestamps"] = { {"start", startTimestamp} };
    json assets;
    if (!largeImageKey.empty()) assets["large_image"] = largeImageKey;
    if (!largeImageText.empty()) assets["large_text"] = largeImageText;
    if (!assets.empty()) activity["assets"] = assets;

    json args;
    args["pid"] = (int)GetCurrentProcessId();
    args["activity"] = activity;

    json frame;
    frame["cmd"] = "SET_ACTIVITY";
    frame["args"] = args;
    frame["nonce"] = std::to_string(GetTickCount64());

    discordWriteFrame(1, frame.dump());
}

void discordPresenceClear() {
    if (!g_discordConnected.load()) return;
    json args;
    args["pid"] = (int)GetCurrentProcessId();
    args["activity"] = nullptr;
    json frame;
    frame["cmd"] = "SET_ACTIVITY";
    frame["args"] = args;
    frame["nonce"] = std::to_string(GetTickCount64());
    discordWriteFrame(1, frame.dump());
}

void discordPresenceStop() {
    if (g_discordPipe != INVALID_HANDLE_VALUE) { CloseHandle(g_discordPipe); g_discordPipe = INVALID_HANDLE_VALUE; }
    g_discordConnected.store(false);
}

bool cleanOldGameLogs(const std::string& gameDir, int days, int& deletedCountOut, std::string& errorOut) {
    deletedCountOut = 0;
    fs::path root(gameDir);
    std::error_code ec;
    auto cutoff = std::chrono::system_clock::now() - std::chrono::hours(24 * std::max(1, days));

    auto scanDir = [&](const fs::path& logsDir) {
        if (!fs::exists(logsDir, ec)) return;
        for (auto it = fs::recursive_directory_iterator(logsDir, fs::directory_options::skip_permission_denied, ec);
             it != fs::recursive_directory_iterator(); it.increment(ec)) {
            if (ec) break;
            std::error_code fileEc;
            if (!it->is_regular_file(fileEc)) continue;
            std::string ext = it->path().extension().string();
            std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
            if (ext != ".log" && ext != ".gz") continue;

            std::error_code timeEc;
            auto ftime = fs::last_write_time(it->path(), timeEc);
            if (timeEc) continue;
            auto sctp = std::chrono::time_point_cast<std::chrono::system_clock::duration>(
                ftime - fs::file_time_type::clock::now() + std::chrono::system_clock::now());
            if (sctp < cutoff) {
                std::error_code removeEc;
                if (fs::remove(it->path(), removeEc)) deletedCountOut++;
            }
        }
    };

    scanDir(root / "logs");
    fs::path instancesDir = root / "instances";
    if (fs::exists(instancesDir, ec)) {
        for (auto& entry : fs::directory_iterator(instancesDir, ec)) {
            if (entry.is_directory()) scanDir(entry.path() / "logs");
        }
    }
    return true;
}

bool moveGameDirectory(const std::string& oldPathStr, const std::string& newPathStr, std::string& errorOut) {
    fs::path from(oldPathStr);
    fs::path to(newPathStr);
    std::error_code ec;

    if (!fs::exists(from, ec)) {
        errorOut = "Исходная папка не найдена: " + oldPathStr;
        return false;
    }
    if (fs::exists(to, ec) && !fs::is_empty(to, ec)) {
        errorOut = "Папка назначения уже существует и не пуста: " + newPathStr;
        return false;
    }

    fs::create_directories(to.parent_path(), ec);

    // Быстрый путь: rename работает мгновенно, если оба пути на одном томе.
    ec.clear();
    fs::rename(from, to, ec);
    if (!ec) return true;

    // Разные тома (например C: -> D:) — rename так не умеет, копируем
    // рекурсивно и затем удаляем исходную папку.
    ec.clear();
    fs::create_directories(to, ec);
    fs::copy(from, to, fs::copy_options::recursive | fs::copy_options::overwrite_existing, ec);
    if (ec) {
        errorOut = "Не удалось скопировать папку игры: " + ec.message();
        return false;
    }

    fs::remove_all(from, ec);
    if (ec) {
        errorOut = "Папка скопирована на новое место, но не удалось удалить старую папку: " + ec.message();
        return false;
    }
    return true;
}

bool fetchMinecraftVersionList(std::string& jsonOut, std::string& errorOut) {
    std::string raw;
    if (!httpGetStringFast("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json", raw, errorOut))
        return false;

    json manifest;
    try { manifest = json::parse(raw); }
    catch (const std::exception& e) { errorOut = std::string("ERR_NETWORK||") + e.what(); return false; }

    json out = json::array();
    if (manifest.contains("versions")) {
        for (const auto& v : manifest["versions"]) {
            json entry;
            entry["id"] = v.value("id", "");
            entry["type"] = v.value("type", "");
            out.push_back(entry);
        }
    }
    jsonOut = out.dump();
    return true;
}

// ============================================
// Публичные обёртки для модов/модпаков — вызываются из main.cpp через w.bind(...).
// ============================================

bool installModToDir(const std::string& slug, const std::string& mcVersion,
                      const std::string& loader, const std::string& modsDir,
                      std::string& fileNameOut, std::string& errorOut) {
    g_cancelled.store(false);
    return installModToDirImpl(slug, mcVersion, loader, fs::path(modsDir), fileNameOut, errorOut);
}

bool listDirFileNames(const std::string& dirPath, std::vector<std::string>& namesOut, std::string& errorOut) {
    namesOut.clear();
    std::error_code ec;
    fs::path dir(dirPath);
    if (!fs::exists(dir, ec)) return true; // папки ещё нет — это не ошибка, просто пусто

    for (auto& entry : fs::directory_iterator(dir, fs::directory_options::skip_permission_denied, ec)) {
        if (ec) break;
        std::error_code fileEc;
        if (!entry.is_regular_file(fileEc)) continue;
        namesOut.push_back(entry.path().filename().string());
    }
    if (ec) { errorOut = "Не удалось прочитать содержимое " + dirPath + ": " + ec.message(); return false; }
    return true;
}

bool listDirFolderNames(const std::string& dirPath, std::vector<std::string>& namesOut, std::string& errorOut) {
    namesOut.clear();
    std::error_code ec;
    fs::path dir(dirPath);
    if (!fs::exists(dir, ec)) return true; // папки ещё нет — не ошибка, просто пусто

    for (auto& entry : fs::directory_iterator(dir, fs::directory_options::skip_permission_denied, ec)) {
        if (ec) break;
        std::error_code dirEc;
        if (!entry.is_directory(dirEc)) continue;
        namesOut.push_back(entry.path().filename().string());
    }
    if (ec) { errorOut = "Не удалось прочитать содержимое " + dirPath + ": " + ec.message(); return false; }
    return true;
}

bool deleteMapFolder(const std::string& dirPath, const std::string& folderName, std::string& errorOut) {
    fs::path target = fs::path(dirPath) / folderName;
    std::error_code ec;
    fs::remove_all(target, ec);
    if (ec) { errorOut = "Не удалось удалить папку карты: " + ec.message(); return false; }
    return true;
}

bool modrinthSearch(const std::string& query, const std::string& mcVersion,
                     const std::string& loader, std::string& jsonOut, std::string& errorOut,
                     int offset) {
    g_cancelled.store(false);
    return modrinthSearchImpl(query, mcVersion, loader, jsonOut, errorOut, offset);
}

bool modrinthProjectDetails(const std::string& slug, std::string& jsonOut, std::string& errorOut) {
    g_cancelled.store(false);
    return modrinthProjectDetailsImpl(slug, jsonOut, errorOut);
}

bool modrinthSearchByType(const std::string& query, const std::string& mcVersion,
                           const std::string& projectType, std::string& jsonOut,
                           std::string& errorOut, int offset) {
    g_cancelled.store(false);
    return modrinthSearchByTypeImpl(query, mcVersion, projectType, jsonOut, errorOut, offset);
}

bool installContentToDir(const std::string& slug, const std::string& mcVersion,
                          const std::string& projectType, const std::string& targetDir,
                          std::string& fileNameOut, std::string& errorOut) {
    g_cancelled.store(false);
    (void)projectType; // резерв на будущее (сейчас логика одинакова для всех типов)
    return installContentToDirImpl(slug, mcVersion, fs::path(targetDir), fileNameOut, errorOut);
}

bool toggleModEnabled(const std::string& dirPath, const std::string& fileName,
                      std::string& fileNameOut, std::string& errorOut) {
    fs::path dir(dirPath);
    fs::path src = dir / fileName;
    if (!fs::exists(src)) { errorOut = "Файл мода не найден: " + fileName; return false; }

    const std::string suffix = ".disabled";
    bool wasDisabled = fileName.size() > suffix.size() &&
        fileName.compare(fileName.size() - suffix.size(), suffix.size(), suffix) == 0;
    // baseName — имя мода БЕЗ ".disabled", ровно тот вид, под которым он
    // хранится ключом в манифесте совместимости (см. recordModInManifest).
    std::string baseName = wasDisabled ? fileName.substr(0, fileName.size() - suffix.size()) : fileName;
    std::string newName = wasDisabled ? baseName : (fileName + suffix);

    fs::path dest = dir / newName;
    std::error_code ec;
    fs::rename(src, dest, ec);
    if (ec) { errorOut = "Не удалось переключить мод: " + ec.message(); return false; }

    // Это осознанное действие игрока — automatic reconcile по версии (см.
    // reconcileModsForVersion) больше не должен "отменять" его при следующем
    // запуске игры, пока игрок сам снова не включит мод руками.
    auto manifest = readModsManifest(dir);
    auto it = manifest.find(baseName);
    if (it != manifest.end()) {
        it->second.userDisabled = !wasDisabled; // wasDisabled==true значит мы его сейчас ВКЛЮЧАЕМ
        writeModsManifest(dir, manifest);
    }

    fileNameOut = newName;
    return true;
}

bool deleteModFile(const std::string& dirPath, const std::string& fileName, std::string& errorOut) {
    fs::path target = fs::path(dirPath) / fileName;
    std::error_code ec;
    fs::remove(target, ec);
    if (ec) { errorOut = "Не удалось удалить файл: " + ec.message(); return false; }

    // Убираем запись из манифеста совместимости — иначе после удаления файла
    // мод остался бы "призраком" в .magma_mods.json (безвредно, но незачем
    // копить мусор, и на всякий случай — вдруг игрок позже создаст файл с тем
    // же именем вручную, тогда старая запись была бы неправильной).
    const std::string suffix = ".disabled";
    std::string baseName = (fileName.size() > suffix.size() &&
        fileName.compare(fileName.size() - suffix.size(), suffix.size(), suffix) == 0)
        ? fileName.substr(0, fileName.size() - suffix.size()) : fileName;

    auto manifest = readModsManifest(fs::path(dirPath));
    if (manifest.erase(baseName) > 0) {
        writeModsManifest(fs::path(dirPath), manifest);
    }

    return true;
}

bool modrinthWarmup() {
    // Обычный httpGetString() тут не годится: у него несколько повторных
    // попыток и куда более долгий таймаут — если сеть плохая, это надолго
    // задержит и без того короткий boot-splash. Прогрев должен быть
    // "best effort": одна попытка, короткий таймаут, результат вообще
    // никого не интересует.
    CURL* curl = curl_easy_init();
    if (!curl) return false;

    std::string dummy;
    curl_easy_setopt(curl, CURLOPT_URL, "https://api.modrinth.com/v2/tag/loader");
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeToString);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &dummy);
    applyCommonCurlOpts(curl);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_easy_cleanup(curl);

    return res == CURLE_OK && httpCode >= 200 && httpCode < 300;
}

bool curseforgeSearch(const std::string& query, const std::string& mcVersion,
                       const std::string& loader, std::string& jsonOut, std::string& errorOut,
                       int offset) {
    g_cancelled.store(false);
    return curseforgeSearchImpl(query, mcVersion, loader, jsonOut, errorOut, offset);
}

bool curseforgeModInfo(const std::string& modId, std::string& titleOut, std::string& iconUrlOut, std::string& errorOut) {
    g_cancelled.store(false);
    return curseforgeModInfoImpl(modId, titleOut, iconUrlOut, errorOut);
}

bool curseforgeProjectDescription(const std::string& modId, std::string& htmlOut, std::string& errorOut) {
    g_cancelled.store(false);
    return curseforgeProjectDescriptionImpl(modId, htmlOut, errorOut);
}

bool installModCurseForge(const std::string& modId, const std::string& mcVersion,
                           const std::string& loader, const std::string& modsDir,
                           std::string& fileNameOut, std::string& errorOut) {
    g_cancelled.store(false);
    return installModCurseForgeImpl(modId, mcVersion, loader, fs::path(modsDir), fileNameOut, errorOut);
}

bool curseforgeSearchByClass(int classId, const std::string& query, const std::string& mcVersion,
                              std::string& jsonOut, std::string& errorOut, int offset) {
    g_cancelled.store(false);
    return curseforgeSearchByClassImpl(classId, query, mcVersion, jsonOut, errorOut, offset);
}

bool installContentCurseForge(const std::string& modId, const std::string& mcVersion,
                               const std::string& targetDir, std::string& fileNameOut, std::string& errorOut) {
    g_cancelled.store(false);
    return installContentCurseForgeImpl(modId, mcVersion, fs::path(targetDir), fileNameOut, errorOut);
}

bool installModrinthModpack(const std::string& id, const std::string& mcVersion,
                             const std::string& instanceName, const std::string& gameDir,
                             const ProgressFn& onProgress, std::string& resolvedVersionOut,
                             std::string& resolvedLoaderOut, std::string& errorOut) {
    g_cancelled.store(false);
    g_paused.store(false);
    return installModrinthModpackImpl(id, mcVersion, instanceName, gameDir, onProgress,
                                       resolvedVersionOut, resolvedLoaderOut, errorOut);
}

bool installCurseForgeModpack(const std::string& id, const std::string& mcVersion,
                               const std::string& instanceName, const std::string& gameDir,
                               const ProgressFn& onProgress, std::string& resolvedVersionOut,
                               std::string& resolvedLoaderOut, std::string& errorOut) {
    g_cancelled.store(false);
    g_paused.store(false);
    return installCurseForgeModpackImpl(id, mcVersion, instanceName, gameDir, onProgress,
                                         resolvedVersionOut, resolvedLoaderOut, errorOut);
}

bool installModpackFromLocalFile(const std::string& localFilePath, const std::string& instanceName,
                                  const std::string& gameDir, const ProgressFn& onProgress,
                                  std::string& resolvedVersionOut, std::string& resolvedLoaderOut,
                                  std::string& errorOut) {
    g_cancelled.store(false);
    g_paused.store(false);
    return installModpackFromLocalFileImpl(localFilePath, instanceName, gameDir, onProgress,
                                            resolvedVersionOut, resolvedLoaderOut, errorOut);
}

bool extractModJarsFromZip(const std::string& zipPath, const std::string& targetDir, int& jarCountOut, std::string& errorOut) {
    return extractModJarsFromZipImpl(fs::path(zipPath), fs::path(targetDir), jarCountOut, errorOut);
}

bool extractMapZip(const std::string& zipPath, const std::string& targetDir, std::string& errorOut) {
    return extractMapZipImpl(fs::path(zipPath), fs::path(targetDir), errorOut);
}

bool extractModJarsFromArchive(const std::string& archivePath, const std::string& targetDir, int& jarCountOut, std::string& errorOut) {
    return extractModJarsFromArchiveImpl(fs::path(archivePath), fs::path(targetDir), jarCountOut, errorOut);
}

bool extractMapArchive(const std::string& archivePath, const std::string& targetDir, std::string& errorOut) {
    return extractMapArchiveImpl(fs::path(archivePath), fs::path(targetDir), errorOut);
}

bool extractZipFromRarArchive(const std::string& rarPath, const std::string& targetDir, std::string& fileNameOut, std::string& errorOut) {
    return extractZipFromRarArchiveImpl(fs::path(rarPath), fs::path(targetDir), fileNameOut, errorOut);
}

bool createModpack(const ModpackRequest& req, const ProgressFn& onProgress, std::string& errorOut) {
    // См. комментарий в начале launchMinecraft — та же защита от "залипшего" g_cancelled.
    g_cancelled.store(false);
    g_paused.store(false);

    fs::path instanceDir = fs::path(req.gameDir) / "instances" / req.name;
    fs::path modsDir = instanceDir / "mods";
    std::error_code ec;
    fs::create_directories(modsDir, ec);

    // Метаданные модпака сохраняются в versions/<name>/modpack.json — именно их читает
    // фронтенд, чтобы отрисовать карточку модпака в разделе "Сборки".
    fs::path metaDir = fs::path(req.gameDir) / "versions" / req.name;
    fs::create_directories(metaDir, ec);

    json meta;
    meta["name"] = req.name;
    meta["mcVersion"] = req.mcVersion;
    meta["loader"] = req.loader;
    json modsJson = json::array();
    for (auto& m : req.mods) if (m.enabled) modsJson.push_back(m.slug);
    meta["mods"] = modsJson;
    { std::ofstream f(metaDir / "modpack.json", std::ios::binary); f << meta.dump(2); }

    std::vector<ModEntry> enabledMods;
    for (auto& m : req.mods) if (m.enabled) enabledMods.push_back(m);

    size_t total = enabledMods.size();
    for (size_t i = 0; i < total; i++) {
        if (g_cancelled.load()) { errorOut = "CANCELLED"; return false; }
        onProgress("mods", (double)i / (double)std::max<size_t>(1, total),
                   "Скачиваем " + enabledMods[i].slug + "...");
        std::string installedFileName; // не используется для модпаков — тут нет индивидуального бейджа "Добавлено"
        if (!installModToDir(enabledMods[i].slug, req.mcVersion, req.loader, modsDir.string(), installedFileName, errorOut)) return false;
    }
    onProgress("mods", 1.0, "Модпак создан");
    return true;
}

bool deleteInstance(const std::string& name, const std::string& gameDir, std::string& errorOut) {
    std::error_code ec;
    fs::path root(gameDir);
    fs::remove_all(root / "instances" / name, ec);
    fs::remove_all(root / "versions" / name, ec);
    if (ec) { errorOut = "Не удалось удалить файлы сборки: " + ec.message(); return false; }
    return true;
}

bool resetVersionCache(const std::string& version, const std::string& gameDir, std::string& errorOut) {
    std::error_code ec;
    fs::remove_all(fs::path(gameDir) / "versions" / version, ec);
    if (ec) { errorOut = "Не удалось очистить кэш версии: " + ec.message(); return false; }
    return true;
}

namespace {
int cmpVersionStrings(const std::string& a, const std::string& b) {
    auto extractTrailingNumber = [](const std::string& s) -> int {
        int i = (int)s.size() - 1;
        while (i >= 0 && !isdigit((unsigned char)s[i])) i--;
        int end = i;
        while (i >= 0 && isdigit((unsigned char)s[i])) i--;
        std::string digits = s.substr(i + 1, end - i);
        if (digits.empty()) return 0;
        try { return std::stoi(digits); } catch (...) { return 0; }
    };
    return extractTrailingNumber(a) - extractTrailingNumber(b);
}
}

bool checkLauncherUpdate(const std::string& manifestUrl, const std::string& currentVersion, UpdateInfo& infoOut, std::string& errorOut) {
    std::string raw;
    if (!httpGetStringFast(manifestUrl, raw, errorOut)) return false;
    try {
        json j = json::parse(raw);
        infoOut.version = j.value("version", "");
        infoOut.url = j.value("url", "");
        infoOut.notes = j.value("notes", "");
        infoOut.available = !infoOut.version.empty() && cmpVersionStrings(infoOut.version, currentVersion) > 0;
        return true;
    } catch (const std::exception& e) {
        errorOut = std::string("Не удалось разобрать манифест обновления: ") + e.what();
        return false;
    }
}

bool downloadAndInstallLauncherUpdate(const std::string& url, const ProgressFn& onProgress, std::string& errorOut) {
    char tempDirBuf[MAX_PATH];
    GetTempPathA(MAX_PATH, tempDirBuf);
    fs::path tempDir = fs::path(tempDirBuf) / "MagmaLauncherUpdate";
    std::error_code ec;
    fs::create_directories(tempDir, ec);
    fs::path newExePath = tempDir / "MagmaLauncher_new.exe";

    onProgress("update", 0.0, "Загружаем обновление...");
    if (!httpDownloadFile(url, newExePath, errorOut)) return false;

    char selfPathBuf[MAX_PATH];
    GetModuleFileNameA(nullptr, selfPathBuf, MAX_PATH);
    std::string selfPath = selfPathBuf;
    DWORD pid = GetCurrentProcessId();

    fs::path batPath = tempDir / "apply_update.bat";
    {
        std::ofstream bat(batPath, std::ios::binary | std::ios::trunc);
        bat << "@echo off\r\n"
            << ":wait\r\n"
            << "tasklist /FI \"PID eq " << pid << "\" | find \"" << pid << "\" >nul\r\n"
            << "if not errorlevel 1 (\r\n"
            << "  timeout /t 1 /nobreak >nul\r\n"
            << "  goto wait\r\n"
            << ")\r\n"
            << "copy /y \"" << newExePath.string() << "\" \"" << selfPath << "\"\r\n"
            << "start \"\" \"" << selfPath << "\"\r\n"
            << "del \"%~f0\"\r\n";
    }

    std::string cmdLine = "cmd.exe /c \"" + batPath.string() + "\"";
    std::vector<char> cmdBuf(cmdLine.begin(), cmdLine.end());
    cmdBuf.push_back('\0');
    STARTUPINFOA si{}; si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessA(nullptr, cmdBuf.data(), nullptr, nullptr, FALSE,
                         DETACHED_PROCESS | CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        errorOut = "Не удалось запустить процесс обновления";
        return false;
    }
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);

    onProgress("update", 1.0, "Перезапуск...");
    return true; // main.cpp должен после этого закрыть лаунчер (CefQuitMessageLoop)
}

} // namespace launcher