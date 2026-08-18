#!/usr/bin/env bash
#
# Build a clean, shareable zip of the extension.
#
# The repo root doubles as the unpacked extension folder, which is handy
# for development but means it also holds .git, tests and CI config.
# Those must not reach anyone you send this to, so packaging copies only
# what the extension actually needs rather than zipping the folder.
#
#   ./package.sh          -> dist/link-decrypt-v<version>.zip
#
set -euo pipefail
cd "$(dirname "$0")"

# Everything the extension needs at runtime. Anything not listed here is
# deliberately excluded from the shared zip.
CONTENTS=(manifest.json src icons)

VERSION="$(node -p "require('./manifest.json').version")"
NAME="link-decrypt"
STAGE="$(mktemp -d)"
OUT="dist/${NAME}-v${VERSION}.zip"

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

echo "Packaging ${NAME} v${VERSION}"

# Never ship something that won't load. Checks the manifest's references
# resolve and that nothing is named in a way Chrome rejects.
node test/test_layout.mjs > /dev/null

mkdir -p "$STAGE/$NAME" dist
for item in "${CONTENTS[@]}"; do
  cp -R "$item" "$STAGE/$NAME/"
done

# Strip anything that shouldn't travel (editor leftovers, Finder junk).
find "$STAGE" \( -name '.DS_Store' -o -name '*.swp' -o -name '*~' \) -delete

# A plain-text note so whoever you send this to isn't left guessing.
cat > "$STAGE/$NAME/INSTALL.txt" <<EOF
link-decrypt v${VERSION}
========================

INSTALL (about 30 seconds)

  1. Move this "${NAME}" folder somewhere permanent -- NOT Downloads.
     Chrome reloads it from this exact path every time it starts, so
     moving it later breaks the extension.

  2. Open Chrome and go to:   chrome://extensions

  3. Turn on "Developer mode" (toggle, top right).

  4. Click "Load unpacked" and pick this folder
     (the one containing manifest.json).


SET UP JDOWNLOADER

  In JDownloader 2:
    Settings -> Advanced Settings -> search "externinterface"
    -> tick "Remote Control / External Interface"

  In the extension:
    click its icon -> Settings -> Test connection
    (you want: jdownloader=true)

  The first time you send links, JDownloader asks whether to allow an
  external application to add links. Click "Allow it!" -- it remembers.


USING IT

  Browse a page with shortened links. They get decoded in place and
  badged with an arrow. Click a badge to send that download to
  JDownloader, or click the extension icon to pick from everything it
  found.

  Chrome may mention developer-mode extensions on startup. Harmless.
EOF

# Build the archive in the staging dir and copy it into place, rather
# than zipping straight to dist/. zip writes a temp file and renames over
# the target, which some filesystems (network mounts, synced folders)
# refuse; a plain copy works everywhere.
(cd "$STAGE" && zip -q -r -X "$STAGE/out.zip" "$NAME")
cp -f "$STAGE/out.zip" "$OUT"

echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo
echo "Contents:"
unzip -Z1 "$OUT" | sed 's/^/  /'
