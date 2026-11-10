#!/usr/bin/env bash
# Start-Skript für Termux
#   bash start.sh            Bot im Vordergrund (mit Auto-Neustart)
#   bash start.sh bg         Bot im Hintergrund (tmux)
#   bash start.sh stop       Bot stoppen
#   bash start.sh restart    Bot neu starten
#   bash start.sh log        Log ansehen (verlassen: Strg+B, dann D)
#   bash start.sh status     Läuft der Bot?
cd "$(dirname "$0")" || exit 1
SESSION=bot
need_tmux() { command -v tmux >/dev/null 2>&1 || { echo "Bitte zuerst: pkg install tmux"; exit 1; }; }
case "${1:-run}" in
  bg)
    need_tmux
    if tmux has-session -t "$SESSION" 2>/dev/null; then echo "Bot läuft schon. Log: bash start.sh log"; exit 0; fi
    tmux new-session -d -s "$SESSION" "bash start.sh run"
    echo "Bot läuft jetzt im Hintergrund. Log: bash start.sh log"
    exit 0 ;;
  stop)
    need_tmux
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "Bot gestoppt." || echo "Bot läuft nicht."
    exit 0 ;;
  restart)
    need_tmux
    tmux kill-session -t "$SESSION" 2>/dev/null
    exec bash start.sh bg ;;
  log|attach)
    need_tmux
    exec tmux attach -t "$SESSION" ;;
  status)
    need_tmux
    if tmux has-session -t "$SESSION" 2>/dev/null; then echo "Bot läuft."; else echo "Bot läuft nicht."; fi
    exit 0 ;;
esac

if [ ! -f .env ]; then
  cp env.example .env
  echo ".env wurde angelegt. Bitte Token eintragen:  nano .env  – danach erneut: bash start.sh"
  exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund
termux-wake-lock 2>/dev/null
while true; do
  node bot.js
  echo "Bot beendet – Neustart in 5 Sekunden (Strg+C zum Stoppen)"
  sleep 5
done
