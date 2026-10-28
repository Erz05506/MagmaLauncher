#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-1.0.0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="${DIST:-$ROOT/backend/build/dist}"
OUT="$ROOT/packaging/linux/out"
PKG="magmalauncher"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -a "$DIST"/. "$ROOT/opt/$NAME/"
chmod 0755 "$ROOT/opt/$NAME/MagmaLauncher"
install -m 0755 packaging/linux/magmalauncher.sh      "$ROOT/usr/bin/magmalauncher"
install -m 0644 packaging/linux/magmalauncher.desktop "$ROOT/usr/share/applications/magmalauncher.desktop"
for S in 16 32 48 64 128 256 512; do
  mkdir -p "$ROOT/usr/share/icons/hicolor/${S}x${S}/apps"
  "$IM" assets/magmalauncher.png -resize ${S}x${S} \
        "$ROOT/usr/share/icons/hicolor/${S}x${S}/apps/magmalauncher.png"
done
mkdir -p "$ROOT/usr/share/pixmaps"
"$IM" assets/magmalauncher.png -resize 256x256 "$ROOT/usr/share/pixmaps/magmalauncher.png"
install -m 0755 packaging/linux/postinst "$ROOT/DEBIAN/postinst"

ICON_SRC="$ROOT/assets/magmalauncher.png"
[ -f "$ICON_SRC" ] || { echo "Не найден $ICON_SRC"; exit 1; }

IM="$(command -v magick || command -v convert || true)"
[ -n "$IM" ] || { echo "Установи ImageMagick: sudo apt install imagemagick"; exit 1; }

install -d "$STAGE/DEBIAN" "$STAGE/opt/$PKG" \
    "$STAGE/usr/bin" "$STAGE/usr/share/applications" \
    "$STAGE/usr/share/pixmaps"

cp -a "$DIST/." "$STAGE/opt/$PKG/"
install -d "$STAGE/opt/$PKG/assets"
install -m 644 "$ICON_SRC" "$STAGE/opt/$PKG/assets/magmalauncher.png"

find "$STAGE/opt/$PKG" -type f \( \
    -name '*.so' -o -name '*.so.*' \
    -o -name 'MagmaLauncher' -o -name 'chrome-sandbox' \
\) -exec strip --strip-unneeded {} + 2>/dev/null || true

find "$STAGE/opt/$PKG" -type f \( \
    -name '*.debug' -o -name '*.pdb' -o -name '*.lib' -o -name '*.a' \
\) -delete

# Права доступа
find "$STAGE/opt/$PKG" -type d -exec chmod 755 {} +
find "$STAGE/opt/$PKG" -type f -exec chmod 644 {} +
chmod 755 "$STAGE/opt/$PKG/MagmaLauncher"
if [ -f "$STAGE/opt/$PKG/chrome-sandbox" ]; then
    chmod 4755 "$STAGE/opt/$PKG/chrome-sandbox"
fi

cat > "$STAGE/usr/bin/magmalauncher" <<'EOF'
#!/bin/sh
exec /opt/magmalauncher/MagmaLauncher "$@"
EOF
chmod 755 "$STAGE/usr/bin/magmalauncher"

for s in 16 24 32 48 64 128 256 512; do
    d="$STAGE/usr/share/icons/hicolor/${s}x${s}/apps"
    mkdir -p "$d"
    "$IM" "$ICON_SRC" -resize "${s}x${s}" "$d/magmalauncher.png"
done

"$IM" "$ICON_SRC" -resize 128x128 "$STAGE/usr/share/pixmaps/magmalauncher.png"

# Ярлык приложения
cat > "$STAGE/usr/share/applications/magmalauncher.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=MagmaLauncher
Comment=Minecraft launcher
Exec=/usr/bin/magmalauncher %U
Icon=magmalauncher
Terminal=false
Categories=Game;
StartupNotify=true
StartupWMClass=MagmaLauncher
EOF
chmod 644 "$STAGE/usr/share/applications/magmalauncher.desktop"

cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q || true
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postinst"

SIZE_KB=$(du -sk "$STAGE/opt/$PKG" | cut -f1)

cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Section: games
Priority: optional
Architecture: amd64
Installed-Size: $SIZE_KB
Maintainer: MagmaLauncher <noreply@example.com>
Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libnspr4, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libgbm1, libxkbcommon0, libasound2t64 | libasound2, libcups2 | libcups2t64, libatk1.0-0t64 | libatk1.0-0, libatk-bridge2.0-0t64 | libatk-bridge2.0-0, libpango-1.0-0, libcairo2, libdrm2, libcurl4 | libcurl4t64, zlib1g, xdg-utils, zenity | kdialog
Description: Unofficial Minecraft: Java Edition launcher
 Vanilla, Fabric, Forge, NeoForge, Quilt. Modrinth and CurseForge support.
EOF

mkdir -p "$OUT"

dpkg-deb -Zgzip -z1 --build --root-owner-group "$STAGE" "$OUT/${PKG}_${VERSION}_amd64.deb"

echo "Готово: $OUT/${PKG}_${VERSION}_amd64.deb"
```
