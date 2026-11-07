$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\")).Path
$Dist = Join-Path $RepoRoot "backend\build\dist"
$OutDir = Join-Path $PSScriptRoot "out"
$ZipPath = Join-Path $OutDir "MagmaLauncher-Windows-x64.zip"

if (-not (Test-Path -LiteralPath $Dist -PathType Container)) {
    throw "Папка сборки не найдена: $Dist. Сначала соберите MagmaLauncher в Release."
}

$RequiredFiles = @(
    "MagmaLauncher.exe",
    "libcef.dll",
    "chrome_elf.dll",
    "d3dcompiler_47.dll",
    "dxcompiler.dll",
    "dxil.dll",
    "libEGL.dll",
    "libGLESv2.dll",
    "vk_swiftshader.dll",
    "vulkan-1.dll",
    "vk_swiftshader_icd.json",
    "v8_context_snapshot.bin",
    "icudtl.dat",
    "resources.pak",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "frontend\index.html"
)

$Missing = @(
    foreach ($RelativePath in $RequiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $Dist $RelativePath) -PathType Leaf)) {
            $RelativePath
        }
    }
)

if ($Missing.Count -gt 0) {
    throw ("В dist отсутствуют обязательные файлы:" + [Environment]::NewLine + ($Missing -join [Environment]::NewLine) + [Environment]::NewLine + "Пересоберите проект после обновления CMakeLists.txt.")
}

if (-not (Test-Path -LiteralPath (Join-Path $Dist "locales") -PathType Container)) {
    throw "В dist отсутствует папка locales."
}

if (-not (Test-Path -LiteralPath (Join-Path $Dist "assets") -PathType Container)) {
    throw "В dist отсутствует папка assets."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}

Compress-Archive -Path (Join-Path $Dist "*") -DestinationPath $ZipPath -CompressionLevel Optimal

$ZipInfo = Get-Item -LiteralPath $ZipPath
$Hash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash

Write-Host ""
Write-Host "ZIP обновления успешно собран." -ForegroundColor Green
Write-Host "Файл: $ZipPath"
Write-Host ("Размер: {0:N2} MB" -f ($ZipInfo.Length / 1MB))
Write-Host "SHA-256: $Hash"
