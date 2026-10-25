#!/usr/bin/env bash
set -euo pipefail
VERSION="${1:?укажи версию, например 1.0.0}"
DIST="${2:-backend/build/dist}"
ARCH="$(dpkg --print-architecture)"
NAME="magmalauncher"
ROOT="packaging/linux/out/${NAME}_${VERSION}_${ARCH}"
IM="$(command -v magick || command -v convert)"

rm -rf "$ROOT"
mkdir -p "$ROOT/DEBIAN" "$ROOT/opt/$NAME" "$ROOT/usr/bin" \
         "$ROOT/usr/share/applications" "$ROOT/usr/share/icons/hicolor/256x256/apps"

cp -a "$DIST"/. "$ROOT/opt/$NAME/"
chmod 0755 "$ROOT/opt/$NAME/MagmaLauncher"
install -m 0755 packaging/linux/magmalauncher.sh      "$ROOT/usr/bin/magmalauncher"
install -m 0644 packaging/linux/magmalauncher.desktop "$ROOT/usr/share/applications/magmalauncher.desktop"
"$IM" assets/magmalauncher.png -resize 256x256 "$ROOT/usr/share/icons/hicolor/256x256/apps/magmalauncher.png"
install -m 0755 packaging/linux/postinst "$ROOT/DEBIAN/postinst"

sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" packaging/linux/control.in > "$ROOT/DEBIAN/control"
echo "Installed-Size: $(du -sk "$ROOT/opt" | cut -f1)" >> "$ROOT/DEBIAN/control"

dpkg-deb --build --root-owner-group "$ROOT"
