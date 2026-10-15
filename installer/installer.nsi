Unicode true
; IMPORTANT: this file must be saved as UTF-8 with BOM.
; NSIS otherwise may read non-ASCII language names as the system ACP.

;--------------------------------
; MagmaLauncher installer
; Requires NSIS 3.x (Unicode)
;--------------------------------

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!insertmacro GetSize
!insertmacro GetTime
!insertmacro GetParameters
!insertmacro GetOptions

Name "MagmaLauncher"
BrandingText " "
OutFile "MagmaLauncherSetup.exe"
InstallDir "$LOCALAPPDATA\Programs\MagmaLauncher"
InstallDirRegKey HKCU "Software\MagmaLauncher" "InstallDir"
RequestExecutionLevel user

SetCompressor /SOLID lzma
SetDatablockOptimize on

; Do not show NSIS's file-by-file details window.
; The installer UI itself still shows normal progress.
ShowInstDetails nevershow

Var AppLang
Var SystemUILang
Var SystemPrimaryLang
Var GameDirMode
Var GameDirPath
Var GameDirText
Var CreateDesktopShortcutCheckbox
Var CreateDesktopShortcut
Var RadioMagma
Var RadioVanilla
Var BrowseBtn
Var GameDirLabel
Var Relaunched

!define MUI_ICON "..\assets\magmalauncher.ico"
!define MUI_UNICON "..\assets\magmalauncher.ico"
!define MUI_CUSTOMFUNCTION_GUIINIT RemoveTitleIcon

!define MUI_FINISHPAGE_NOAUTOCLOSE

!define MUI_WELCOMEFINISHPAGE_BITMAP "..\assets\installer_side.bmp"
; ============================================================
; IMPORTANT:
; MUI_LANGUAGE declarations MUST come BEFORE custom LangString
; declarations. Otherwise ${LANG_*} values are undefined and
; NSIS puts the strings into English, producing warnings.
; ============================================================


; ============================================================
; Pages
; ============================================================

!insertmacro MUI_PAGE_WELCOME
Page custom GameDirPageCreate GameDirPageLeave
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_RUN "$INSTDIR\MagmaLauncher.exe"
!define MUI_FINISHPAGE_RUN_TEXT "$(STR_RUN)"
!define MUI_FINISHPAGE_RUN_CHECKED
!insertmacro MUI_PAGE_FINISH

!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmPageShow
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; ============================================================
; MUI languages MUST be declared after all MUI_PAGE/MUI_UNPAGE macros.
; ============================================================

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "Ukrainian"
!insertmacro MUI_LANGUAGE "French"
!insertmacro MUI_LANGUAGE "German"
!insertmacro MUI_LANGUAGE "Spanish"
!insertmacro MUI_LANGUAGE "Italian"
!insertmacro MUI_LANGUAGE "PortugueseBR"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "Hindi"
!insertmacro MUI_LANGUAGE "Indonesian"

; ============================================================
; Localized strings
; ============================================================

LangString STR_LANG_TITLE ${LANG_ENGLISH} "Select language"
LangString STR_LANG_TITLE ${LANG_RUSSIAN} "Выберите язык"
LangString STR_LANG_TITLE ${LANG_UKRAINIAN} "Виберіть мову інтерфейсу MagmaLauncher:"
LangString STR_LANG_TITLE ${LANG_FRENCH} "Choisissez la langue de l'interface de MagmaLauncher :"
LangString STR_LANG_TITLE ${LANG_GERMAN} "Wählen Sie die Sprache der MagmaLauncher-Oberfläche:"
LangString STR_LANG_TITLE ${LANG_SPANISH} "Elige el idioma de la interfaz de MagmaLauncher:"
LangString STR_LANG_TITLE ${LANG_ITALIAN} "Scegli la lingua dell'interfaccia di MagmaLauncher:"
LangString STR_LANG_TITLE ${LANG_PORTUGUESEBR} "Escolha o idioma da interface do MagmaLauncher:"
LangString STR_LANG_TITLE ${LANG_JAPANESE} "MagmaLauncher のインターフェース言語を選択してください:"
LangString STR_LANG_TITLE ${LANG_KOREAN} "MagmaLauncher 인터페이스 언어를 선택하세요:"
LangString STR_LANG_TITLE ${LANG_HINDI} "MagmaLauncher इंटरफ़ेस की भाषा चुनें:"
LangString STR_LANG_TITLE ${LANG_INDONESIAN} "Pilih bahasa antarmuka MagmaLauncher:"

LangString STR_GAME_DIR_TITLE ${LANG_ENGLISH} "Where should instances, mods and saves be stored?"
LangString STR_GAME_DIR_TITLE ${LANG_RUSSIAN} "Где хранить сборки, моды и сохранения:"
LangString STR_GAME_DIR_TITLE ${LANG_UKRAINIAN} "Де зберігати збірки, моди та збереження:"
LangString STR_GAME_DIR_TITLE ${LANG_FRENCH} "Où stocker les instances, mods et sauvegardes :"
LangString STR_GAME_DIR_TITLE ${LANG_GERMAN} "Wo sollen Instanzen, Mods und Spielstände gespeichert werden?"
LangString STR_GAME_DIR_TITLE ${LANG_SPANISH} "¿Dónde se deben guardar las instancias, mods y partidas guardadas?"
LangString STR_GAME_DIR_TITLE ${LANG_ITALIAN} "Dove devono essere salvate istanze, mod e salvataggi?"
LangString STR_GAME_DIR_TITLE ${LANG_PORTUGUESEBR} "Onde armazenar instâncias, mods e salvamentos?"
LangString STR_GAME_DIR_TITLE ${LANG_JAPANESE} "インスタンス、Mod、セーブデータの保存場所:"
LangString STR_GAME_DIR_TITLE ${LANG_KOREAN} "인스턴스, 모드 및 저장 파일을 저장할 위치:"
LangString STR_GAME_DIR_TITLE ${LANG_HINDI} "इंस्टेंस, मॉड और सेव कहाँ संग्रहीत करें:"
LangString STR_GAME_DIR_TITLE ${LANG_INDONESIAN} "Di mana instance, mod, dan penyimpanan akan disimpan?"

LangString STR_MAGMA_OPTION ${LANG_ENGLISH} "MagmaLauncher (recommended) — %APPDATA%\MagmaLauncher"
LangString STR_MAGMA_OPTION ${LANG_RUSSIAN} "MagmaLauncher (рекомендуется) — %APPDATA%\MagmaLauncher"
LangString STR_MAGMA_OPTION ${LANG_UKRAINIAN} "MagmaLauncher (рекомендовано) — %APPDATA%\MagmaLauncher"
LangString STR_MAGMA_OPTION ${LANG_FRENCH} "MagmaLauncher (recommandé) — %APPDATA%\MagmaLauncher"
LangString STR_MAGMA_OPTION ${LANG_GERMAN} "MagmaLauncher (empfohlen) — %APPDATA%\MagmaLauncher"
LangString STR_MAGMA_OPTION ${LANG_SPANISH} "MagmaLauncher (recomendado) — %APPDATA%\MagmaLauncher"
LangString STR_MAGMA_OPTION ${LANG_ITALIAN} "MagmaLauncher (consigliato) — %APPDATA%\MagmaLauncher"
LangString STR_MAGMA_OPTION ${LANG_PORTUGUESEBR} "MagmaLauncher (recomendado) — %APPDATA%\MagmaLauncher"
LangString STR_MAGMA_OPTION ${LANG_JAPANESE} "MagmaLauncher（推奨）— %APPDATA%\MagmaLauncher"
LangString STR_MAGMA_OPTION ${LANG_KOREAN} "MagmaLauncher (권장) — %APPDATA%\MagmaLauncher"
LangString STR_MAGMA_OPTION ${LANG_HINDI} "MagmaLauncher (अनुशंसित) — %APPDATA%\MagmaLauncher"
LangString STR_MAGMA_OPTION ${LANG_INDONESIAN} "MagmaLauncher (disarankan) — %APPDATA%\MagmaLauncher"

LangString STR_VANILLA_OPTION ${LANG_ENGLISH} ".minecraft — official Minecraft Launcher folder"
LangString STR_VANILLA_OPTION ${LANG_RUSSIAN} ".minecraft — папка официального лаунчера"
LangString STR_VANILLA_OPTION ${LANG_UKRAINIAN} ".minecraft — папка офіційного лаунчера"
LangString STR_VANILLA_OPTION ${LANG_FRENCH} ".minecraft — dossier du launcher officiel"
LangString STR_VANILLA_OPTION ${LANG_GERMAN} ".minecraft — Ordner des offiziellen Launchers"
LangString STR_VANILLA_OPTION ${LANG_SPANISH} ".minecraft — carpeta del launcher oficial"
LangString STR_VANILLA_OPTION ${LANG_ITALIAN} ".minecraft — cartella del launcher ufficiale"
LangString STR_VANILLA_OPTION ${LANG_PORTUGUESEBR} ".minecraft — pasta do launcher oficial"
LangString STR_VANILLA_OPTION ${LANG_JAPANESE} ".minecraft — 公式ランチャーのフォルダー"
LangString STR_VANILLA_OPTION ${LANG_KOREAN} ".minecraft — 공식 런처 폴더"
LangString STR_VANILLA_OPTION ${LANG_HINDI} ".minecraft — आधिकारिक लॉन्चर का फ़ोल्डर"
LangString STR_VANILLA_OPTION ${LANG_INDONESIAN} ".minecraft — folder launcher resmi"

LangString STR_BROWSE ${LANG_ENGLISH} "Browse..."
LangString STR_BROWSE ${LANG_RUSSIAN} "Обзор..."
LangString STR_BROWSE ${LANG_UKRAINIAN} "Огляд..."
LangString STR_BROWSE ${LANG_FRENCH} "Parcourir..."
LangString STR_BROWSE ${LANG_GERMAN} "Durchsuchen..."
LangString STR_BROWSE ${LANG_SPANISH} "Examinar..."
LangString STR_BROWSE ${LANG_ITALIAN} "Sfoglia..."
LangString STR_BROWSE ${LANG_PORTUGUESEBR} "Procurar..."
LangString STR_BROWSE ${LANG_JAPANESE} "参照..."
LangString STR_BROWSE ${LANG_KOREAN} "찾아보기..."
LangString STR_BROWSE ${LANG_HINDI} "ब्राउज़ करें..."
LangString STR_BROWSE ${LANG_INDONESIAN} "Telusuri..."

LangString STR_DESKTOP ${LANG_ENGLISH} "Create a desktop shortcut"
LangString STR_DESKTOP ${LANG_RUSSIAN} "Создать ярлык на рабочем столе"
LangString STR_DESKTOP ${LANG_UKRAINIAN} "Створити ярлик на робочому столі"
LangString STR_DESKTOP ${LANG_FRENCH} "Créer un raccourci sur le bureau"
LangString STR_DESKTOP ${LANG_GERMAN} "Desktop-Verknüpfung erstellen"
LangString STR_DESKTOP ${LANG_SPANISH} "Crear un acceso directo en el escritorio"
LangString STR_DESKTOP ${LANG_ITALIAN} "Crea un collegamento sul desktop"
LangString STR_DESKTOP ${LANG_PORTUGUESEBR} "Criar um atalho na área de trabalho"
LangString STR_DESKTOP ${LANG_JAPANESE} "デスクトップにショートカットを作成"
LangString STR_DESKTOP ${LANG_KOREAN} "바탕 화면에 바로 가기 만들기"
LangString STR_DESKTOP ${LANG_HINDI} "डेस्कटॉप शॉर्टकट बनाएं"
LangString STR_DESKTOP ${LANG_INDONESIAN} "Buat pintasan desktop"

LangString STR_RUN ${LANG_ENGLISH} "Launch MagmaLauncher"
LangString STR_RUN ${LANG_RUSSIAN} "Запустить MagmaLauncher"
LangString STR_RUN ${LANG_UKRAINIAN} "Запустити MagmaLauncher"
LangString STR_RUN ${LANG_FRENCH} "Lancer MagmaLauncher"
LangString STR_RUN ${LANG_GERMAN} "MagmaLauncher starten"
LangString STR_RUN ${LANG_SPANISH} "Iniciar MagmaLauncher"
LangString STR_RUN ${LANG_ITALIAN} "Avvia MagmaLauncher"
LangString STR_RUN ${LANG_PORTUGUESEBR} "Iniciar MagmaLauncher"
LangString STR_RUN ${LANG_JAPANESE} "MagmaLauncher を起動"
LangString STR_RUN ${LANG_KOREAN} "MagmaLauncher 실행"
LangString STR_RUN ${LANG_HINDI} "MagmaLauncher लॉन्च करें"
LangString STR_RUN ${LANG_INDONESIAN} "Jalankan MagmaLauncher"

LangString STR_INSTALLING ${LANG_ENGLISH} "Installing..."
LangString STR_INSTALLING ${LANG_RUSSIAN} "Установка..."
LangString STR_INSTALLING ${LANG_UKRAINIAN} "Встановлення..."
LangString STR_INSTALLING ${LANG_FRENCH} "Installation..."
LangString STR_INSTALLING ${LANG_GERMAN} "Installation..."
LangString STR_INSTALLING ${LANG_SPANISH} "Instalando..."
LangString STR_INSTALLING ${LANG_ITALIAN} "Installazione..."
LangString STR_INSTALLING ${LANG_PORTUGUESEBR} "Instalando..."
LangString STR_INSTALLING ${LANG_JAPANESE} "インストール中..."
LangString STR_INSTALLING ${LANG_KOREAN} "설치 중..."
LangString STR_INSTALLING ${LANG_HINDI} "इंस्टॉल हो रहा है..."
LangString STR_INSTALLING ${LANG_INDONESIAN} "Menginstal..."


; ============================================================
; Remove the small icon from the installer window title bar
; ============================================================

Function RemoveTitleIcon
    ; WM_SETICON (0x80), ICON_SMALL = 0, ICON_BIG = 1
    SendMessage $HWNDPARENT 0x80 0 0
    SendMessage $HWNDPARENT 0x80 1 0
    ; Extended window style WS_EX_DLGMODALFRAME (0x1) hides the title-bar icon
    System::Call 'user32::GetWindowLong(i $HWNDPARENT, i -20) i .r0'
    IntOp $0 $0 | 0x1
    System::Call 'user32::SetWindowLong(i $HWNDPARENT, i -20, i r0)'
    System::Call 'user32::SetWindowPos(i $HWNDPARENT, i 0, i 0, i 0, i 0, i 0, i 0x27)'
FunctionEnd

; ============================================================
; Startup / automatic Windows language detection
; ============================================================

Function .onInit
    ; Get Windows UI language.
    System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
    StrCpy $SystemUILang $0

    ; Keep only the primary language ID.
    ; Examples:
    ; 1049 (Russian-Russia) -> 25
    ; 1033 (English-US)     -> 9
    ; 1058 (Ukrainian)      -> 34
    IntOp $0 $0 & 0x03FF
    StrCpy $SystemPrimaryLang $0

    ; English is the fallback for unsupported Windows languages.
    StrCpy $LANGUAGE ${LANG_ENGLISH}

    ${If} $SystemPrimaryLang == 25
        StrCpy $LANGUAGE ${LANG_RUSSIAN}
    ${ElseIf} $SystemPrimaryLang == 34
        StrCpy $LANGUAGE ${LANG_UKRAINIAN}
    ${ElseIf} $SystemPrimaryLang == 12
        StrCpy $LANGUAGE ${LANG_FRENCH}
    ${ElseIf} $SystemPrimaryLang == 7
        StrCpy $LANGUAGE ${LANG_GERMAN}
    ${ElseIf} $SystemPrimaryLang == 10
        StrCpy $LANGUAGE ${LANG_SPANISH}
    ${ElseIf} $SystemPrimaryLang == 16
        StrCpy $LANGUAGE ${LANG_ITALIAN}
    ${ElseIf} $SystemPrimaryLang == 22
        StrCpy $LANGUAGE ${LANG_PORTUGUESEBR}
    ${ElseIf} $SystemPrimaryLang == 17
        StrCpy $LANGUAGE ${LANG_JAPANESE}
    ${ElseIf} $SystemPrimaryLang == 18
        StrCpy $LANGUAGE ${LANG_KOREAN}
    ${ElseIf} $SystemPrimaryLang == 57
        StrCpy $LANGUAGE ${LANG_HINDI}
    ${ElseIf} $SystemPrimaryLang == 33
        StrCpy $LANGUAGE ${LANG_INDONESIAN}
    ${ElseIf} $SystemPrimaryLang == 9
        StrCpy $LANGUAGE ${LANG_ENGLISH}
    ${EndIf}

    Call SetAppLangFromLanguage
FunctionEnd

; ============================================================
; Language page
; ============================================================

Function SetAppLangFromLanguage
    StrCpy $AppLang "en"
    ${If} $LANGUAGE == ${LANG_RUSSIAN}
        StrCpy $AppLang "ru"
    ${ElseIf} $LANGUAGE == ${LANG_UKRAINIAN}
        StrCpy $AppLang "uk"
    ${ElseIf} $LANGUAGE == ${LANG_FRENCH}
        StrCpy $AppLang "fr"
    ${ElseIf} $LANGUAGE == ${LANG_GERMAN}
        StrCpy $AppLang "de"
    ${ElseIf} $LANGUAGE == ${LANG_SPANISH}
        StrCpy $AppLang "es"
    ${ElseIf} $LANGUAGE == ${LANG_ITALIAN}
        StrCpy $AppLang "it"
    ${ElseIf} $LANGUAGE == ${LANG_PORTUGUESEBR}
        StrCpy $AppLang "pt"
    ${ElseIf} $LANGUAGE == ${LANG_JAPANESE}
        StrCpy $AppLang "ja"
    ${ElseIf} $LANGUAGE == ${LANG_KOREAN}
        StrCpy $AppLang "ko"
    ${ElseIf} $LANGUAGE == ${LANG_HINDI}
        StrCpy $AppLang "hi"
    ${ElseIf} $LANGUAGE == ${LANG_INDONESIAN}
        StrCpy $AppLang "id"
    ${EndIf}
FunctionEnd

; ============================================================
; Game directory page
; ============================================================

Function UpdateGameDirText
    Pop $0
    ${NSD_GetState} $RadioMagma $0
    ${If} $0 == ${BST_CHECKED}
        StrCpy $GameDirMode "magma"
        StrCpy $GameDirPath "$APPDATA\MagmaLauncher"
    ${Else}
        StrCpy $GameDirMode "vanilla"
        StrCpy $GameDirPath "$APPDATA\.minecraft"
    ${EndIf}

    ${NSD_SetText} $GameDirText $GameDirPath
FunctionEnd

Function GameDirPageCreate
    nsDialogs::Create 1018
    Pop $0

    ${NSD_CreateLabel} 0 0 100% 12u "$(STR_GAME_DIR_TITLE)"
    Pop $GameDirLabel

    ${NSD_CreateRadioButton} 0 16u 100% 10u "$(STR_MAGMA_OPTION)"
    Pop $RadioMagma
    ${NSD_Check} $RadioMagma
    ${NSD_OnClick} $RadioMagma UpdateGameDirText

    ${NSD_CreateRadioButton} 0 28u 100% 10u "$(STR_VANILLA_OPTION)"
    Pop $RadioVanilla
    ${NSD_OnClick} $RadioVanilla UpdateGameDirText

    ${NSD_CreateText} 0 44u 78% 12u "$APPDATA\MagmaLauncher"
    Pop $GameDirText

    ${NSD_CreateButton} 80% 44u 20% 12u "$(STR_BROWSE)"
    Pop $BrowseBtn
    ${NSD_OnClick} $BrowseBtn OnBrowseGameDir

    ${NSD_CreateCheckbox} 0 64u 100% 10u "$(STR_DESKTOP)"
    Pop $CreateDesktopShortcutCheckbox
    ${NSD_Check} $CreateDesktopShortcutCheckbox

    StrCpy $GameDirMode "magma"
    StrCpy $GameDirPath "$APPDATA\MagmaLauncher"

    nsDialogs::Show
FunctionEnd

Function PickFolderModern
    StrCpy $R7 ""
    System::Call 'ole32::CoCreateInstance(g "{DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7}", i 0, i 1, g "{D57C7288-D4AD-4768-BE02-9D969532D960}", *i .r1) i .r0'
    ${If} $0 != 0
        Return
    ${EndIf}

    ; FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
    System::Call '$1->10(*i .r2)'
    IntOp $2 $2 | 0x860
    System::Call '$1->9(i r2)'
    System::Call '$1->17(w r18)'

    ${If} $R9 != ""
    ${AndIf} ${FileExists} "$R9\*.*"
        System::Call 'shell32::SHCreateItemFromParsingName(w r19, i 0, g "{43826D1E-E718-42EE-BC55-A1E261C37BFE}", *i .r3) i .r0'
        ${If} $0 == 0
            System::Call '$1->12(i r3)'
            System::Call '$3->2()'
        ${EndIf}
    ${EndIf}

    System::Call '$1->3(i $HWNDPARENT) i .r0'
    ${If} $0 == 0
        System::Call '$1->20(*i .r4) i .r0'
        ${If} $0 == 0
            System::Call '$4->5(i 0x80058000, *i .r5) i .r0'
            ${If} $0 == 0
                System::Call 'kernel32::lstrcpyW(w .r17, i r5)'
                System::Call 'ole32::CoTaskMemFree(i r5)'
            ${EndIf}
            System::Call '$4->2()'
        ${EndIf}
    ${EndIf}
    System::Call '$1->2()'
FunctionEnd

Function OnBrowseGameDir
    Pop $0
    ${NSD_GetText} $GameDirText $R9
    StrCpy $R8 "$(STR_GAME_DIR_TITLE)"
    Call PickFolderModern

    ${If} $R7 != ""
        StrCpy $1 $R7 1 -1
        ${If} $1 == "\"
            StrCpy $R7 $R7 -1
        ${EndIf}

        StrCpy $1 $R7 "" -14
        StrCpy $2 $R7 "" -11
        ${If} $1 != "\MagmaLauncher"
        ${AndIf} $2 != "\.minecraft"
            StrCpy $R7 "$R7\MagmaLauncher"
        ${EndIf}

        StrCpy $GameDirMode "custom"
        StrCpy $GameDirPath $R7
        ${NSD_Uncheck} $RadioMagma
        ${NSD_Uncheck} $RadioVanilla
        ${NSD_SetText} $GameDirText $GameDirPath
    ${EndIf}
FunctionEnd

Function GameDirPageLeave
    ${NSD_GetText} $GameDirText $GameDirPath
    ${NSD_GetState} $CreateDesktopShortcutCheckbox $CreateDesktopShortcut

    StrCpy $0 $GameDirPath 1 -1
    ${If} $0 == "\"
        StrCpy $GameDirPath $GameDirPath -1
    ${EndIf}
    ${If} $GameDirPath == ""
        StrCpy $GameDirPath "$APPDATA\MagmaLauncher"
    ${EndIf}

    ; режим определяется по итоговому пути, в том числе после ручной правки поля
    ${If} $GameDirPath == "$APPDATA\MagmaLauncher"
        StrCpy $GameDirMode "magma"
    ${ElseIf} $GameDirPath == "$APPDATA\.minecraft"
        StrCpy $GameDirMode "vanilla"
    ${Else}
        StrCpy $GameDirMode "custom"
    ${EndIf}
FunctionEnd

; ============================================================
; Installation
; ============================================================

Section "MagmaLauncher" SecMain
    ; Hide NSIS details entirely, so the user does not see a long
    ; list of every CEF/frontend file being extracted.
    SetDetailsPrint textonly
    DetailPrint "$(STR_INSTALLING)"
    SetDetailsPrint none

    SetOutPath "$INSTDIR"

    ; Main launcher distribution.
    File /r "..\backend\build\dist\*.*"

    ; Installer icon is also placed beside the executable so that
    ; shortcuts and Windows' installed-app entry can use it.
    File "..\assets\magmalauncher.ico"

    CreateDirectory "$GameDirPath"

    ; Escape backslashes for JSON.
    StrCpy $R0 "$GameDirPath"
    Push $R0
    Call EscapeBackslashes
    Pop $R0

    ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
    StrCpy $R1 "$2$1$0$4$5$6"

    FileOpen $4 "$INSTDIR\install_config.json" w
    FileWrite $4 "{$\r$\n"
    FileWrite $4 '  "installId": "$R1",$\r$\n'
    FileWrite $4 '  "lang": "$AppLang",$\r$\n'
    FileWrite $4 '  "gameDir": "$R0",$\r$\n'
    FileWrite $4 '  "gameDirMode": "$GameDirMode"$\r$\n'
    FileWrite $4 "}$\r$\n"
    FileClose $4

    RMDir /r "$SMPROGRAMS\MagmaLauncher"
    Delete "$SMPROGRAMS\MagmaLauncher.lnk"
    Delete "$DESKTOP\MagmaLauncher.lnk"

    CreateShortcut "$SMPROGRAMS\MagmaLauncher.lnk" \
        "$INSTDIR\MagmaLauncher.exe" "" "$INSTDIR\magmalauncher.ico" 0 SW_SHOWNORMAL

    ${If} $CreateDesktopShortcut == ${BST_CHECKED}
        CreateShortcut "$DESKTOP\MagmaLauncher.lnk" \
            "$INSTDIR\MagmaLauncher.exe" "" "$INSTDIR\magmalauncher.ico" 0 SW_SHOWNORMAL
    ${EndIf}

    WriteRegStr HKCU "Software\MagmaLauncher" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\MagmaLauncher" "GameDir" "$GameDirPath"
    WriteRegStr HKCU "Software\MagmaLauncher" "LangId" "$LANGUAGE"

    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MagmaLauncher" "DisplayName" "MagmaLauncher"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MagmaLauncher" "UninstallString" "$INSTDIR\Uninstall.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MagmaLauncher" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MagmaLauncher" "DisplayIcon" "$INSTDIR\magmalauncher.ico"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MagmaLauncher" "DisplayVersion" "Alpha 1"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MagmaLauncher" "Publisher" "MagmaLauncher"
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MagmaLauncher" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MagmaLauncher" "NoRepair" 1

    WriteUninstaller "$INSTDIR\Uninstall.exe"

    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MagmaLauncher" "EstimatedSize" "$0"

    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

    Sleep 600
SectionEnd

; ============================================================
; JSON path escaping
; ============================================================

Function EscapeBackslashes
    Exch $R0
    Push $R1
    Push $R2

    StrCpy $R1 ""
    StrCpy $R2 0

EscapeLoop:
    StrCpy $0 $R0 1 $R2

    ${If} $0 == ""
        Goto EscapeDone
    ${EndIf}

    ${If} $0 == "\"
        StrCpy $R1 "$R1\\"
    ${Else}
        StrCpy $R1 "$R1$0"
    ${EndIf}

    IntOp $R2 $R2 + 1
    Goto EscapeLoop

EscapeDone:
    StrCpy $R0 $R1

    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

; ============================================================
; Uninstaller
; ============================================================

Function un.ConfirmPageShow
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1000
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $0 1019
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $0 1024
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $0 1029
    ShowWindow $1 ${SW_HIDE}
FunctionEnd

Function un.onInit
    ReadRegStr $0 HKCU "Software\MagmaLauncher" "LangId"
    ${If} $0 != ""
        StrCpy $LANGUAGE $0
    ${EndIf}
FunctionEnd

Section "Uninstall"
    RMDir /r "$LOCALAPPDATA\MagmaLauncher\cef_cache"
    RMDir "$LOCALAPPDATA\MagmaLauncher"
    Delete "$INSTDIR\Uninstall.exe"
    Delete "$INSTDIR\magmalauncher.ico"
    RMDir /r "$INSTDIR"

    Delete "$SMPROGRAMS\MagmaLauncher.lnk"
    RMDir /r "$SMPROGRAMS\MagmaLauncher"

    Delete "$DESKTOP\MagmaLauncher.lnk"

    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MagmaLauncher"
    DeleteRegKey HKCU "Software\MagmaLauncher"
SectionEnd
