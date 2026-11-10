# Telegram Supergruppen-Manager (Bot + Web-Dashboard)

Läuft komplett in Termux – nur Node.js, keine nativen Pakete.

## Installation (Termux)
    pkg update && pkg upgrade
    pkg install nodejs tmux unzip
    unzip tgmod.zip && cd tgmod
    bash start.sh          # legt .env an
    nano .env              # BOT_TOKEN und OWNER_IDS eintragen
    bash start.sh bg       # startet den Bot im Hintergrund

## Bot steuern
    bash start.sh bg        im Hintergrund starten (tmux)
    bash start.sh log       Log ansehen (verlassen: Strg+B, dann D)
    bash start.sh restart   neu starten
    bash start.sh stop      stoppen
    bash start.sh status    läuft er?
    bash start.sh           im Vordergrund (Auto-Neustart)

## Update (ohne Datenverlust)
Neue tgmod.zip herunterladen, dann in Termux:

    termux-setup-storage            # einmalig
    cd ~/tgmod
    bash update.sh                  # findet tgmod.zip im Download-Ordner
    bash start.sh restart

`.env`, `data.json` und `backups/` bleiben erhalten, vorher wird eine Sicherung angelegt.

## Telegram einrichten
1. @BotFather: /setprivacy -> Disable
2. Bot in die Supergruppe holen und zum Admin machen
   (Nachrichten löschen, Mitglieder sperren/einschränken, anheften)
3. In der Gruppe /setup oder /menu senden (Menü: Schutz · Inhalte · Nachtmodus · Statistik · Hilfe)
4. /help zeigt die Befehle nach Bereichen; der „/“-Button in Telegram zeigt je nach Rolle passende Befehle

## Web-Dashboard
Starten: in der `.env` mindestens eins davon setzen
- `WEB_PASSWORD=...`   Owner-Passwort (voller Zugriff)
- `WEB_TELEGRAM=on`    nur Telegram-Anmeldung (ohne Passwort)

Öffnen im Handy-Browser: **http://127.0.0.1:3000**

### Anmeldung
- **Mit Telegram:** Button „Mit Telegram anmelden“ → Bot öffnen → im Bot die Zahl antippen, die im Browser
  angezeigt wird. Jeder Gruppen-Admin sieht danach **nur die Gruppen, in denen er selbst Admin ist**.
- **Passwort / OWNER_IDS:** voller Zugriff auf alle Gruppen, Rundnachricht, Globale Bann-Liste,
  Backups (inkl. Wiederherstellen) und Web-Sitzungen.
- Gruppen-Besitzer können unter „Mehr → Einstellungen“ festlegen, ob alle Admins oder nur sie selbst
  die Gruppe im Web-Panel verwalten dürfen.
- Im WLAN erreichbar machen: `WEB_HOST=0.0.0.0` (HTTP unverschlüsselt – nur im eigenen Netz!).

### Menüführung
Untere Leiste: **Übersicht · Schutz · Inhalte · Mitglieder · Mehr**, darüber Unter-Reiter
- Übersicht: Dashboard (Charts), Log
- Schutz: Regeln · Beitritt · Strafen · Listen · Sperren
- Inhalte: Willkommen · Automatik (Notizen, Trigger, Zeitpläne)
- Mitglieder: Suche, Aktionen, Notizen, CSV-Export
- Mehr: Nachtmodus · Berichte · Einstellungen

## Funktionen (Auswahl)
Link-/Wort-/Flood-/Wiederholungs-/CAPS-/Erwähnungs-/Kontaktdaten-Filter (je eigene Aktion),
Domain-Whitelist und -Blacklist, Regex-Wörter (`re:muster|zweites`), Slow-Modus, Auto-Löschen,
Verwarnsystem mit Ablauf, Captcha, Raid-Schutz, Namens-Filter, CAS-Check, Globaler Bann,
Beitrittsanfragen automatisch prüfen, Willkommen/Abschied mit Buttons, Nachtmodus,
Tagesbericht, Zeitpläne, Notizen/Trigger, Mod-Notizen zu Usern, Statistik, Log, Backups.

Owner-Befehle: /gban /ungban /gbans /broadcast /backup /status

## Dateien
- bot.js, dashboard.js, dashboard.html – Programm
- start.sh, update.sh – Termux-Skripte
- env.example – Vorlage für .env
- data.json – Einstellungen (automatisch), backups/ – Tages-Backups (7 Tage)
