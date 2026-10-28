#pragma once

#include <atomic>
#include <functional>
#include <string>
#include <vector>

namespace launcher {

using ProgressFn = std::function<void(
    const std::string& stage,
    double progress,
    const std::string& detail)>;

struct LaunchRequest {
    std::string version;
    std::string loader;
    std::string username;
    std::string gameDir;
    std::string javaPath;
    int ramMb = 4096;

    std::string instanceName;

    std::string authUuid;
    std::string authAccessToken;

    std::string quickPlayServer;

    std::string extraJvmArgs;

    bool fullscreen = false;

    int windowWidth = 0;
    int windowHeight = 0;
};

extern std::atomic<bool> g_paused;
extern std::atomic<bool> g_cancelled;
extern std::atomic<bool> g_gameProcessActive;
extern std::atomic<unsigned long> g_gameProcessId;

bool scheduleLauncherReopenAfterGameExit(std::string& errorOut);

bool launchMinecraft(
    const LaunchRequest& req,
    const ProgressFn& onProgress,
    std::string& errorOut);

bool fetchMinecraftVersionList(
    std::string& jsonOut,
    std::string& errorOut);

bool detectSystemJava(
    std::string& javaPathOut,
    std::string& errorOut);

bool moveGameDirectory(
    const std::string& oldPath,
    const std::string& newPath,
    std::string& errorOut);

// Mod and modpack API.
struct ModEntry {
    std::string slug;
    bool enabled = true;
};

struct ModpackRequest {
    std::string name;
    std::string mcVersion;
    std::string loader;
    std::vector<ModEntry> mods;
    std::string gameDir;
};

bool modrinthSearch(
    const std::string& query,
    const std::string& mcVersion,
    const std::string& loader,
    std::string& jsonOut,
    std::string& errorOut,
    int offset = 0);

bool modrinthProjectDetails(
    const std::string& slug,
    std::string& jsonOut,
    std::string& errorOut);

bool modrinthWarmup();

bool curseforgeSearch(
    const std::string& query,
    const std::string& mcVersion,
    const std::string& loader,
    std::string& jsonOut,
    std::string& errorOut,
    int offset = 0);

bool curseforgeProjectDescription(
    const std::string& modId,
    std::string& htmlOut,
    std::string& errorOut);

bool curseforgeModInfo(
    const std::string& modId,
    std::string& titleOut,
    std::string& iconUrlOut,
    std::string& errorOut);

bool installModCurseForge(
    const std::string& modId,
    const std::string& mcVersion,
    const std::string& loader,
    const std::string& modsDir,
    std::string& fileNameOut,
    std::string& errorOut);

bool curseforgeSearchByClass(
    int classId,
    const std::string& query,
    const std::string& mcVersion,
    std::string& jsonOut,
    std::string& errorOut,
    int offset = 0);

bool installContentCurseForge(
    const std::string& modId,
    const std::string& mcVersion,
    const std::string& targetDir,
    std::string& fileNameOut,
    std::string& errorOut,
    bool asMap = false);

bool installModrinthModpack(
    const std::string& id,
    const std::string& mcVersion,
    const std::string& instanceName,
    const std::string& gameDir,
    const ProgressFn& onProgress,
    std::string& resolvedVersionOut,
    std::string& resolvedLoaderOut,
    std::string& errorOut);

bool installCurseForgeModpack(
    const std::string& id,
    const std::string& mcVersion,
    const std::string& instanceName,
    const std::string& gameDir,
    const ProgressFn& onProgress,
    std::string& resolvedVersionOut,
    std::string& resolvedLoaderOut,
    std::string& errorOut);

bool installModpackFromLocalFile(
    const std::string& localFilePath,
    const std::string& instanceName,
    const std::string& gameDir,
    const ProgressFn& onProgress,
    std::string& resolvedVersionOut,
    std::string& resolvedLoaderOut,
    std::string& errorOut);

bool extractModJarsFromZip(
    const std::string& zipPath,
    const std::string& targetDir,
    int& jarCountOut,
    std::string& errorOut);

bool extractMapZip(
    const std::string& zipPath,
    const std::string& targetDir,
    std::string& errorOut);

bool extractModJarsFromArchive(
    const std::string& archivePath,
    const std::string& targetDir,
    int& jarCountOut,
    std::string& errorOut);

bool extractMapArchive(
    const std::string& archivePath,
    const std::string& targetDir,
    std::string& errorOut);

bool extractZipFromRarArchive(
    const std::string& rarPath,
    const std::string& targetDir,
    std::string& fileNameOut,
    std::string& errorOut);

// Generic Modrinth content search and installation.
bool modrinthSearchByType(
    const std::string& query,
    const std::string& mcVersion,
    const std::string& projectType,
    std::string& jsonOut,
    std::string& errorOut,
    int offset = 0);

bool installContentToDir(
    const std::string& slug,
    const std::string& mcVersion,
    const std::string& projectType,
    const std::string& targetDir,
    std::string& fileNameOut,
    std::string& errorOut);

bool installModToDir(
    const std::string& slug,
    const std::string& mcVersion,
    const std::string& loader,
    const std::string& modsDir,
    std::string& fileNameOut,
    std::string& errorOut);

bool listDirFileNames(
    const std::string& dirPath,
    std::vector<std::string>& namesOut,
    std::string& errorOut);

bool listDirFolderNames(
    const std::string& dirPath,
    std::vector<std::string>& namesOut,
    std::string& errorOut);

bool deleteMapFolder(
    const std::string& dirPath,
    const std::string& folderName,
    std::string& errorOut);

bool createModpack(
    const ModpackRequest& req,
    const ProgressFn& onProgress,
    std::string& errorOut);

bool toggleModEnabled(
    const std::string& dirPath,
    const std::string& fileName,
    std::string& fileNameOut,
    std::string& errorOut);

bool getModsManifestJson(
    const std::string& dirPath,
    std::string& jsonOut,
    std::string& errorOut);

bool deleteModFile(
    const std::string& dirPath,
    const std::string& fileName,
    std::string& errorOut);

bool deleteInstance(
    const std::string& name,
    const std::string& gameDir,
    std::string& errorOut);

bool resetVersionCache(
    const std::string& version,
    const std::string& gameDir,
    std::string& errorOut);

// Discord Rich Presence.
bool discordPresenceStart(
    const std::string& appId,
    std::string& errorOut);

void discordPresenceSetActivity(
    const std::string& details,
    const std::string& state,
    const std::string& largeImageKey,
    const std::string& largeImageText,
    long long startTimestamp);

void discordPresenceClear();
void discordPresenceStop();

bool cleanOldGameLogs(
    const std::string& gameDir,
    int days,
    int& deletedCountOut,
    std::string& errorOut);

struct UpdateInfo {
    std::string version;
    std::string url;
    std::string notes;
    int build = 0;
    bool available = false;
};

bool checkLauncherUpdate(
    const std::string& manifestUrl,
    const std::string& currentVersion,
    UpdateInfo& infoOut,
    std::string& errorOut);

bool downloadAndInstallLauncherUpdate(
    const std::string& url,
    const ProgressFn& onProgress,
    std::string& errorOut);

} // namespace launcher
