#pragma once
#include <string>
#include <functional>
#include <atomic>
#include <vector>

// ============================================
// launcher_core — скачивание и запуск Minecraft (Vanilla + Fabric).
//
// ЧТО УЖЕ РЕАЛИЗОВАНО:
//   - version_manifest_v2.json -> находим нужную версию
//   - скачиваем client.jar, все нужные для Windows библиотеки, ассеты
//   - извлекаем нативные .dll из библиотек (LWJGL и т.п.)
//   - собираем classpath и launch-аргументы (поддержаны и новый JSON-формат
//     "arguments" с 1.13+, и старый "minecraftArguments" для версий 1.0–1.12.2)
//   - запускаем java.exe в offline-режиме (гость / Magma-ник) либо в
//     онлайн-режиме, если передан настоящий Microsoft/Xbox токен
//   - Fabric: подтягиваем профиль лоадера через Fabric Meta API и добавляем
//     его библиотеки на classpath, меняем mainClass
//   - Forge: скачиваем официальный инсталлятор с maven.minecraftforge.net
//     (версию берём из promotions_slim.json) и запускаем его в тихом режиме
//     (--installClient) — это тот же способ, каким инсталлятор ставит Forge
//     в официальном лаунчере, поэтому все "processors"/патчи клиента (актуально
//     для 1.13+) выполняет сам инсталлятор, а не наш код. Дальше подмешиваем
//     получившиеся библиотеки/аргументы/mainClass в ванильный профиль версии.
//     Ограничение: тихий CLI-флаг есть у инсталляторов начиная примерно с
//     Forge под MC 1.6 — для совсем древних версий (1.1–1.5.x) автоматическая
//     установка может не сработать (вернётся понятная ошибка)
//   - OptiFine / Forge+OptiFine: у самого optifine.net нет публичного API —
//     файлы отдаются только через сайт с рекламой и одноразовыми токенами в
//     ссылке, которые генерирует JS на странице, так что скачивать напрямую
//     оттуда автоматически ненадёжно. Вместо этого используем BMCLAPI
//     (bmclapi2.bangbang93.com) — открытое зеркало тех же файлов 1:1,
//     раздающее их по стабильному прямому API (им же пользуются открытые
//     лаунчеры HMCL/PCL). Для "Forge+OptiFine" скачанный jar OptiFine просто
//     кладётся в mods/ уже поставленного Forge — начиная с версий, которые
//     вообще поддерживает Forge, OptiFine и так грузится как обычный мод.
//     Для чистого "OptiFine" (без Forge) инсталлятор запускается тихо через
//     рефлексию (сканируем методы optifine.Installer и сами находим нужный —
//     точное имя/сигнатура отличаются между версиями OptiFine), для чего на
//     лету компилируется крошечный java-хелпер. Для этого нужен javac —
//     если рядом с выбранной в настройках Java его нет (например, это
//     JRE от Mojang, скачанная автоматически для самого запуска игры), мы
//     сами скачиваем отдельный portable JDK (Eclipse Temurin) в изолированную
//     папку gameDir/runtime/jdk-temurin — так же, как это уже делается для
//     обычной Java запуска игры, без установки чего-либо в систему.
//   - пауза загрузки (g_paused) — проверяется перед каждым файлом в циклах
//     библиотек и ассетов
//   - Java решается в три шага, как у официального лаунчера и TLauncher:
//       1) путь из настроек, если существует
//       2) уже установленная в системе Java (PATH / Program Files), но
//          только если её major-версия совпадает с требуемой (проверяется
//          запуском "java -version")
//       3) если ничего не подошло — автоматически скачивается portable
//          JRE от Mojang (launchermeta.mojang.com/.../java-runtime/...),
//          изолированно в папку "runtime" внутри gameDir, без установки в
//          систему — точно так же, как делает официальный лаунчер
//   - расшифровка кода ошибки Windows при неудачном запуске java.exe
//   - установка готовых сборок из каталога (Modrinth .mrpack и CurseForge
//     zip+manifest.json) прямо в instances/<name>, с подтягиванием версии/
//     загрузчика из самой сборки
//
// ЧТО ПОКА НЕ РЕАЛИЗОВАНО (следующие итерации):
//   - параллельная закачка ассетов (сейчас последовательно — для версий с
//     тысячами мелких файлов первый запуск может быть не быстрым)
//   - legacy-формат ассетов для очень старых версий (1.6 и раньше, где
//     ассеты кладутся ещё и в virtual/legacy папку)
//   - настоящий вход через Microsoft/Xbox (OAuth device code flow) —
//     сейчас поддерживается только передача уже готовых authUuid/authAccessToken,
//     если они появятся из другого источника
// ============================================

namespace launcher {

// stage — короткий машинный тег этапа ("manifest" | "java" | "libraries" |
// "assets" | "client" | "launch"), progress — 0.0..1.0 в рамках текущего
// этапа, detail — человекочитаемая деталь для UI.
using ProgressFn = std::function<void(const std::string& stage, double progress, const std::string& detail)>;

struct LaunchRequest {
    std::string version;    // "1.21.4", "26.1" и т.п. — версия Minecraft, качается в versions/<version>
    std::string loader;     // "vanilla", "fabric" или "forge" (optifine — заглушка с понятной ошибкой)
    std::string username;   // ник игрока (гость, Magma-аккаунт или лицензионный Microsoft-ник)
    std::string gameDir;    // корневая папка (versions/libraries/assets/instances/runtime)
    std::string javaPath;   // путь к java.exe из настроек (может быть пустым/несуществующим —
                             // тогда используется автопоиск/автозагрузка, см. описание выше)
    int ramMb = 4096;

    // Имя папки инстанса внутри instances/. Если пусто — используется version
    // (старое поведение, один инстанс на версию). Для модпаков сюда передаётся
    // имя модпака, чтобы у каждого модпака была своя папка mods/saves/options
    // (instances/<instanceName>/mods), даже если несколько модпаков собраны
    // на одной и той же версии Minecraft.
    std::string instanceName;

    // Данные лицензионного входа через Microsoft/Xbox. Если authUuid и
    // authAccessToken оба непустые — запуск идёт в "msa" (онлайн) режиме
    // с реальным Mojang-токеном вместо оффлайн-режима с фейковым UUID.
    std::string authUuid;
    std::string authAccessToken;

    // Непусто, если игрок нажал "Играть" на карточке сервера во вкладке
    // "Моды" -> "Серверы" (см. connectToServer в app.js) — тогда после
    // запуска игра сразу подключается к этому адресу (host:port) через
    // Quick Play (--quickPlayMultiplayer), без захода в меню "Мультиплеер"
    // руками. Поддерживается начиная с версий Minecraft, где вообще есть
    // Quick Play (1.20+) — на более старых версиях аргумент будет просто
    // проигнорирован игрой, и игрок попадёт на обычный экран меню.
    std::string quickPlayServer;

    // Дополнительные флаги JVM из настроек лаунчера (Настройки -> Настройки
    // игры -> Аргументы JVM), разделённые пробелами — добавляются к
    // автоматически сгенерированным аргументам как есть.
    std::string extraJvmArgs;

    // Полноэкранный режим — не launch-аргумент, а настройка самой игры,
    // поэтому реализуется патчем options.txt инстанса перед запуском.
    bool fullscreen = false;

    // Разрешение окна игры (--width/--height). 0 — использовать значение по
    // умолчанию из самой игры. Игнорируется, если fullscreen == true.
    int windowWidth = 0;
    int windowHeight = 0;
};

// Пауза текущей загрузки. Ставится/снимается из UI (кнопка паузы) через
// main.cpp -> w.bind("pauseLaunch"/"resumeLaunch"). Глобальный флаг, потому
// что launchMinecraft в любой момент времени выполняется только в одном
// фоновом потоке (см. std::thread(...).detach() в main.cpp).
extern std::atomic<bool> g_paused;

// Отмена текущей загрузки/установки. Ставится из UI (кнопка "Отмена") через
// main.cpp -> w.bind("cancelLaunch"). Проверяется во всех циклах закачки
// (библиотеки/ассеты/Java/Fabric), внутри retry-обёртки HTTP-запросов и во
// время ожидания завершения установщика Forge — как только флаг взведён,
// текущая операция прерывается с errorOut == "CANCELLED", и main.cpp
// сообщает фронтенду про отмену отдельным полем, а не как об ошибке.
extern std::atomic<bool> g_cancelled;

// Полный цикл: скачать всё необходимое (пропуская уже скачанное и валидное
// по SHA1) и запустить java-процесс с игрой. Выполняется синхронно —
// вызывающая сторона должна сама увести это в отдельный поток, чтобы не
// блокировать UI. Возвращает true, если процесс игры успешно запущен
// (дальнейшую жизнь процесса игры launcher_core не отслеживает).
bool launchMinecraft(const LaunchRequest& req, const ProgressFn& onProgress, std::string& errorOut);


bool fetchMinecraftVersionList(std::string& jsonOut, std::string& errorOut);

// Ищет уже установленную в системе Java (PATH / типовые папки установки JDK) —
// та же логика, что launchMinecraft использует как fallback, вынесена в
// отдельную публичную функцию для кнопки "Автоопределение" в настройках.
bool detectSystemJava(std::string& javaPathOut, std::string& errorOut);

// Переносит папку игры (gameDir) на новое место: пробует быстрый fs::rename,
// а если это невозможно (например, целевой путь на другом диске) — копирует
// рекурсивно и затем удаляет исходную папку.
bool moveGameDirectory(const std::string& oldPath, const std::string& newPath, std::string& errorOut);

// ============================================
// Моды / модпаки через Modrinth API (api.modrinth.com/v2, публичный, без ключа).
// ============================================

// Один мод в составе модпака. enabled=false — мод пропускается при создании
// (используется для чекбоксов "Fabric API" / "Sodium" и т.п. в UI).
struct ModEntry {
    std::string slug;
    bool enabled = true;
};

struct ModpackRequest {
    std::string name;              // имя модпака -> instances/<name> и versions/<name>/modpack.json
    std::string mcVersion;         // "1.21.4"
    std::string loader;            // "fabric" | "forge"
    std::vector<ModEntry> mods;
    std::string gameDir;
};

// Ищет моды на Modrinth по тексту запроса, отфильтрованные под версию/загрузчик.
// jsonOut — сырой ответ Modrinth (объект с полями "hits" и "total_hits"),
// фронтенд парсит сам. offset — сдвиг для постраничной навигации (см.
// "Моды" в app.js): каждая страница — это отдельный запрос с limit=20 и
// соответствующим offset, ровно как делает сам modrinth.com, поэтому и
// количество страниц у нас теперь настоящее, а не подрезанное до 100 хитов.
bool modrinthSearch(const std::string& query, const std::string& mcVersion,
                     const std::string& loader, std::string& jsonOut, std::string& errorOut,
                     int offset = 0);

// Полная карточка мода (описание, кол-во скачиваний и т.п.) для модалки "подробнее".
bool modrinthProjectDetails(const std::string& slug, std::string& jsonOut, std::string& errorOut);

// Лёгкий "прогрев" соединения с Modrinth API — вызывается один раз во время
// экрана загрузки лаунчера (см. bootSequence в app.js), чтобы DNS/TLS-хендшейк
// с api.modrinth.com уже был сделан к моменту, когда игрок откроет вкладку
// "Моды" — тогда первый реальный поиск не тормозит и не падает по таймауту.
// Ошибки прогрева игнорируются вызывающей стороной — это не критично.
bool modrinthWarmup();

bool curseforgeSearch(const std::string& query, const std::string& mcVersion,
                       const std::string& loader, std::string& jsonOut, std::string& errorOut,
                       int offset = 0);

bool curseforgeProjectDescription(const std::string& modId, std::string& htmlOut, std::string& errorOut);

// Короткая карточка мода/контента с CurseForge (только название и иконка) —
// нужна, чтобы во вкладке "Мои моды"/"Мои карты"/"Мои ресурс-паки" файлы,
// скачанные с CurseForge, показывались так же красиво, как с Modrinth
// (нормальное название + аватарка), а не как сырое имя файла без иконки.
bool curseforgeModInfo(const std::string& modId, std::string& titleOut, std::string& iconUrlOut, std::string& errorOut);

bool installModCurseForge(const std::string& modId, const std::string& mcVersion,
                           const std::string& loader, const std::string& modsDir,
                           std::string& fileNameOut, std::string& errorOut);

// Поиск на CurseForge по произвольному classId (6 = моды, 12 = ресурс-паки,
// 6552 = шейдеры, 4471 = модпаки и т.п.) — используется вкладками "Ресурс-паки"/
// "Шейдеры" и каталогом готовых сборок, без привязки к загрузчику.
bool curseforgeSearchByClass(int classId, const std::string& query, const std::string& mcVersion,
                              std::string& jsonOut, std::string& errorOut, int offset = 0);

// Скачивает контент с CurseForge (ресурс-пак/шейдер) по modId в targetDir —
// подбирает файл под версию без фильтра по загрузчику.
bool installContentCurseForge(const std::string& modId, const std::string& mcVersion,
                               const std::string& targetDir, std::string& fileNameOut,
                               std::string& errorOut);

// Устанавливает ГОТОВУЮ сборку с Modrinth (.mrpack) в instances/<instanceName>:
// качает пак, распаковывает, читает modrinth.index.json, скачивает все файлы
// (mods/resourcepacks/...), копирует overrides/client-overrides, определяет
// реальную версию Minecraft и загрузчик из зависимостей пака и возвращает их
// вызывающей стороне (фронтенд сохраняет это как метаданные модпака).
bool installModrinthModpack(const std::string& id, const std::string& mcVersion,
                             const std::string& instanceName, const std::string& gameDir,
                             const ProgressFn& onProgress, std::string& resolvedVersionOut,
                             std::string& resolvedLoaderOut, std::string& errorOut);

// То же самое, но для сборки с CurseForge (zip с manifest.json + overrides):
// качает файл сборки под нужную версию, распаковывает, резолвит каждый мод
// из manifest.files через CurseForge API (projectID+fileID -> downloadUrl),
// копирует overrides, определяет версию/загрузчик из manifest.minecraft.
bool installCurseForgeModpack(const std::string& id, const std::string& mcVersion,
                               const std::string& instanceName, const std::string& gameDir,
                               const ProgressFn& onProgress, std::string& resolvedVersionOut,
                               std::string& resolvedLoaderOut, std::string& errorOut);

bool installModpackFromLocalFile(const std::string& localFilePath, const std::string& instanceName,
                                  const std::string& gameDir, const ProgressFn& onProgress,
                                  std::string& resolvedVersionOut, std::string& resolvedLoaderOut,
                                  std::string& errorOut);

bool extractModJarsFromZip(const std::string& zipPath, const std::string& targetDir, int& jarCountOut, std::string& errorOut);

bool extractMapZip(const std::string& zipPath, const std::string& targetDir, std::string& errorOut);

bool extractModJarsFromArchive(const std::string& archivePath, const std::string& targetDir, int& jarCountOut, std::string& errorOut);
bool extractMapArchive(const std::string& archivePath, const std::string& targetDir, std::string& errorOut);
bool extractZipFromRarArchive(const std::string& rarPath, const std::string& targetDir, std::string& fileNameOut, std::string& errorOut);

// ============================================
// Обобщённый поиск/установка контента с Modrinth по произвольному
// project_type ("resourcepack" | "datapack" | "shader") — используется
// вкладками "Ресурс-паки" / "Дата-паки" / "Шейдеры" в разделе "Моды".
// В отличие от modrinthSearch (только для type=mod), здесь нет фильтра по
// loaders — у ресурс-паков/дата-паков/шейдеров загрузчика не бывает,
// фильтруется только по версии Minecraft.
// ============================================
bool modrinthSearchByType(const std::string& query, const std::string& mcVersion,
                           const std::string& projectType, std::string& jsonOut,
                           std::string& errorOut, int offset = 0);

// Скачивает контент (ресурс-пак/дата-пак/шейдер) по слагу в targetDir —
// та же логика подбора файла, что и installModToDir, но без фильтра по
// загрузчику.
bool installContentToDir(const std::string& slug, const std::string& mcVersion,
                          const std::string& projectType, const std::string& targetDir,
                          std::string& fileNameOut, std::string& errorOut);

// Скачивает один мод по слагу Modrinth в указанную папку mods (создаёт её, если нет).
// fileNameOut — реальное имя скачанного файла (например "sodium-fabric-0.6.jar").
// Фронтенд сохраняет его вместе со slug, чтобы позже проверить, не удалил ли
// игрок файл вручную из mods/ — тогда бейдж "Добавлено" не должен врать.
bool installModToDir(const std::string& slug, const std::string& mcVersion,
                      const std::string& loader, const std::string& modsDir,
                      std::string& fileNameOut, std::string& errorOut);

// Список имён файлов (не путей) внутри директории — используется, чтобы
// сверить localStorage-статус "мод установлен" с тем, что реально лежит в
// mods/ на диске (см. комментарий у installModToDir выше). Если директории
// не существует, возвращает true с пустым namesOut (это не ошибка — просто
// ещё ничего не установлено).
bool listDirFileNames(const std::string& dirPath, std::vector<std::string>& namesOut, std::string& errorOut);
// То же самое, что listDirFileNames, но для ПОДПАПОК — нужен для карт:
// установленная карта — это папка (level.dat и другие файлы мира), а не
// единичный файл, поэтому listDirFileNames её никогда не увидит.
bool listDirFolderNames(const std::string& dirPath, std::vector<std::string>& namesOut, std::string& errorOut);

// Удаляет папку карты целиком (рекурсивно) — deleteModFile тут не подходит,
// он умеет удалять только один файл.
bool deleteMapFolder(const std::string& dirPath, const std::string& folderName, std::string& errorOut);

// Создаёт новый модпак: instances/<name>/mods + скачивает туда все mods с enabled=true,
// плюс versions/<name>/modpack.json с метаданными для отображения в UI.
bool createModpack(const ModpackRequest& req, const ProgressFn& onProgress, std::string& errorOut);

// Переключает мод между "включён"/"отключён" — добавляет/убирает суффикс
// ".disabled" в имени файла (Minecraft грузит из mods/ только *.jar, поэтому
// файл остаётся на диске, но просто перестаёт подхватываться игрой).
// fileNameOut — новое имя файла после переключения (нужно фронтенду, чтобы
// обновить список без повторного похода в listDirFileNames).
bool toggleModEnabled(const std::string& dirPath, const std::string& fileName,
                      std::string& fileNameOut, std::string& errorOut);

// Удаляет файл мода из папки насовсем (используется кнопкой "Удалить" во
// вкладке "Мои моды").
bool deleteModFile(const std::string& dirPath, const std::string& fileName, std::string& errorOut);

bool deleteModFile(const std::string& dirPath, const std::string& fileName, std::string& errorOut);

// Полностью удаляет модпак: instances/<name> и versions/<name> (метаданные).
bool deleteInstance(const std::string& name, const std::string& gameDir, std::string& errorOut);

// Чистит закешированные файлы версии (versions/<version>) — используется кнопкой
// "Обновить клиент", чтобы при следующем запуске всё скачалось заново
// (библиотеки/ассеты не трогаются, они и так проверяются по SHA1).
bool resetVersionCache(const std::string& version, const std::string& gameDir, std::string& errorOut);

bool discordPresenceStart(const std::string& appId, std::string& errorOut);
void discordPresenceSetActivity(const std::string& details, const std::string& state,
                                 const std::string& largeImageKey, const std::string& largeImageText,
                                 long long startTimestamp);
void discordPresenceClear();
void discordPresenceStop();

bool cleanOldGameLogs(const std::string& gameDir, int days, int& deletedCountOut, std::string& errorOut);

struct UpdateInfo { std::string version; std::string url; std::string notes; bool available = false; };
bool checkLauncherUpdate(const std::string& manifestUrl, const std::string& currentVersion, UpdateInfo& infoOut, std::string& errorOut);
bool downloadAndInstallLauncherUpdate(const std::string& url, const ProgressFn& onProgress, std::string& errorOut);

} // namespace launcher