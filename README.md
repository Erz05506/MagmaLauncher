# MagmaLauncher

An unofficial, open-source launcher for **Minecraft: Java Edition**, built with C++ (CEF/Chromium) on the backend and plain HTML/CSS/JavaScript on the frontend.

MagmaLauncher takes care of the parts of running modded Minecraft that are normally tedious: it downloads the right Java runtime automatically, fetches game files and assets, and installs mod loaders and modpacks with a couple of clicks — no manual folder juggling required.

## Features

- **Vanilla, Fabric, Forge, NeoForge and Quilt** support, with automatic Java version detection/download
- **Mod, resource pack, shader and map browsing** straight from the Modrinth and CurseForge catalogs, with install/uninstall/enable/disable from inside the launcher
- **One-click modpack creation** and installation of existing `.mrpack` / CurseForge modpacks
- **Multiple accounts**: guest nicknames, Magma accounts (email/Google via Supabase), with Microsoft/Xbox login planned
- **Skins via Ely.by**, rendered with a live 3D preview (skinview3d)
- **Discord Rich Presence**, customizable JVM arguments, RAM allocation, custom game/launcher folders
- **12 interface languages** and a dozen built-in color themes
- **Privacy controls**: telemetry blocking, streamer mode, launcher PIN lock, log auto-cleanup
- **Self-updating**: the launcher checks a remote manifest and can download/install new versions on its own

## Tech stack

- **Backend:** C++20, CMake + Ninja, MSVC, [CEF](https://bitbucket.org/chromiumembedded/cef) (Chromium Embedded Framework) for the UI shell, libcurl for networking, nlohmann/json
- **Frontend:** vanilla HTML/CSS/JavaScript, bridged to the C++ backend through `CefMessageRouter`
- **Auth:** [Supabase](https://supabase.com/) for Magma accounts, [Ely.by](https://ely.by/) for skins
- **Mod sources:** [Modrinth](https://modrinth.com/) API and [CurseForge](https://www.curseforge.com/) Core API

## Building from source

1. Install Visual Studio Build Tools (MSVC), CMake, Ninja and [vcpkg](https://github.com/microsoft/vcpkg)
2. Download a [CEF binary distribution](https://cef-builds.spotifycdn.com/index.html) and place it in `backend/cef`
3. `vcpkg install curl[core,ssl,sspi] nlohmann-json zlib`
4. Configure and build:
```bash
   cmake -B build -S backend -DCMAKE_TOOLCHAIN_FILE=<path-to-vcpkg>/scripts/buildsystems/vcpkg.cmake
   cmake --build build --config Release
```

## Status

MagmaLauncher is in active early development (currently **Alpha**). Things will break, change, and get rebuilt — bug reports and feedback are welcome in [Discord](https://discord.gg/R7DCtQBYs) or as GitHub issues.

## License

MagmaLauncher is released under the [MIT License](LICENSE) — use it, modify it, fork it.

## Links

- 💬 [Discord](https://discord.gg/R7DCtQBYs)
- ▶️ [YouTube](https://www.youtube.com/@Erz05)
- ✈️ [Telegram](https://t.me/magma_launcher)
- ❤️ [Support the project](https://www.donationalerts.com/r/erzz05)
