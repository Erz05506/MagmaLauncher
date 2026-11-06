#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-1.0.0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="${DIST:-$ROOT/backend/build/dist}"
OUT="$ROOT/packaging/linux/out"
PKG="magmalauncher"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

ICON_SRC="$ROOT/assets/magmalauncher.png"
IM="$(command -v magick || command -v convert || true)"

if [ ! -x "$DIST/MagmaLauncher" ]; then
    echo "Не найдена собранная программа: $DIST/MagmaLauncher" >&2
    exit 1
fi

CEF_ROOT="${CEF_ROOT:-$ROOT/backend/cef-linux}"
CEF_LIB="$CEF_ROOT/Release/libcef.so"

if [ ! -f "$CEF_LIB" ]; then
    echo "Не найден libcef.so: $CEF_LIB. Сначала скачай CEF." >&2
    exit 1
fi

if [ ! -f "$ICON_SRC" ]; then
    echo "Не найден значок: $ICON_SRC" >&2
    exit 1
fi

if [ -z "$IM" ]; then
    echo "Установи ImageMagick: sudo apt install imagemagick" >&2
    exit 1
fi

install -d "$STAGE/DEBIAN" "$STAGE/opt/$PKG" \
    "$STAGE/usr/bin" "$STAGE/usr/share/applications" \
    "$STAGE/usr/share/pixmaps"

cp -a "$DIST/." "$STAGE/opt/$PKG/"
install -m 0755 "$CEF_LIB" "$STAGE/opt/$PKG/libcef.so"
install -m 0644 "$ICON_SRC" "$STAGE/opt/$PKG/assets/magmalauncher.png"

find "$STAGE/opt/$PKG" -type f \( \
    -name '*.so' -o -name '*.so.*' -o -name 'MagmaLauncher' \
\) -exec strip --strip-unneeded {} + 2>/dev/null || true

find "$STAGE/opt/$PKG" -type f \( \
    -name '*.debug' -o -name '*.pdb' -o -name '*.lib' -o -name '*.a' \
\) -delete

find "$STAGE/opt/$PKG" -type d -exec chmod 755 {} +
find "$STAGE/opt/$PKG" -type f -exec chmod 644 {} +
chmod 0755 "$STAGE/opt/$PKG/MagmaLauncher"

cat > "$STAGE/usr/bin/magmalauncher" <<'EOF'
#!/bin/sh
exec /opt/magmalauncher/MagmaLauncher "$@"
EOF
chmod 0755 "$STAGE/usr/bin/magmalauncher"

for size in 16 24 32 48 64 128 256 512; do
    icon_dir="$STAGE/usr/share/icons/hicolor/${size}x${size}/apps"
    install -d "$icon_dir"
    "$IM" "$ICON_SRC" -resize "${size}x${size}" "$icon_dir/magmalauncher.png"
done

"$IM" "$ICON_SRC" -resize 128x128 "$STAGE/usr/share/pixmaps/magmalauncher.png"

cat > "$STAGE/usr/share/applications/magmalauncher.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=MagmaLauncher
Comment=Minecraft launcher
Exec=/usr/bin/magmalauncher %U
Icon=magmalauncher
Terminal=false
Categories=Game;
MimeType=x-scheme-handler/magma;
StartupNotify=true
StartupWMClass=MagmaLauncher
EOF
chmod 0644 "$STAGE/usr/share/applications/magmalauncher.desktop"

cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q || true
exit 0
EOF
chmod 0755 "$STAGE/DEBIAN/postinst"

SIZE_KB="$(du -sk "$STAGE/opt/$PKG" | cut -f1)"

cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Section: games
Priority: optional
Architecture: amd64
Installed-Size: $SIZE_KB
Maintainer: MagmaLauncher <noreply@example.com>
Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libnspr4, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libgbm1, libxkbcommon0, libasound2 | libasound2t64, libcups2 | libcups2t64, libatk1.0-0 | libatk1.0-0t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libpango-1.0-0, libcairo2, libdrm2, libcurl4 | libcurl4t64, zlib1g, xdg-utils, zenity | kdialog
Description: Unofficial Minecraft Java Edition launcher
 Vanilla, Fabric, Forge, NeoForge and Quilt. Modrinth and CurseForge support.
EOF

mkdir -p "$OUT"
dpkg-deb -Zgzip -z1 --build --root-owner-group "$STAGE" "$OUT/${PKG}_${VERSION}_amd64.deb"

echo "Готово: $OUT/${PKG}_${VERSION}_amd64.deb"
