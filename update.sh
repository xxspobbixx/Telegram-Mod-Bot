#!/usr/bin/env bash
# Update aus einer ZIP-Datei – .env, data.json und backups/ bleiben unangetastet.
#   bash update.sh                      sucht tgmod.zip in Downloads / Home / hier
#   bash update.sh /pfad/zur/tgmod.zip
cd "$(dirname "$0")" || exit 1
ZIP="${1:-}"
if [ -z "$ZIP" ]; then
  for c in "$HOME/storage/downloads/tgmod.zip" "$HOME/tgmod.zip" "./tgmod.zip"; do
    [ -f "$c" ] && ZIP="$c" && break
  done
fi
[ -n "$ZIP" ] && [ -f "$ZIP" ] || { echo "ZIP nicht gefunden. Nutzung: bash update.sh /pfad/zur/tgmod.zip"; echo "(Download-Ordner freigeben: termux-setup-storage)"; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "Bitte zuerst: pkg install unzip"; exit 1; }
TMP="$(mktemp -d)"
unzip -q "$ZIP" -d "$TMP" || { echo "ZIP konnte nicht entpackt werden."; exit 1; }
SRC="$TMP/tgmod"; [ -d "$SRC" ] || SRC="$TMP"
[ -f "$SRC/bot.js" ] || { echo "In der ZIP fehlt bot.js – falsche Datei?"; rm -rf "$TMP"; exit 1; }
mkdir -p backups
[ -f data.json ] && cp data.json "backups/pre-update-$(date +%Y%m%d-%H%M%S).json" && echo "Sicherung von data.json angelegt (backups/)."
for f in bot.js dashboard.js dashboard.html package.json start.sh env.example README.md; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "./$f"
done
[ -f "$SRC/update.sh" ] && cp "$SRC/update.sh" ./update.sh.new && mv ./update.sh.new ./update.sh
rm -rf "$TMP"
npm install --no-audit --no-fund
echo "✔ Update fertig."
if command -v tmux >/dev/null 2>&1 && tmux has-session -t bot 2>/dev/null; then
  echo "Der Bot läuft noch mit der alten Version – neu starten mit:  bash start.sh restart"
else
  echo "Starten mit:  bash start.sh bg"
fi
