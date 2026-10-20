# Benutzerhandbuch (Deutsch)

DoIP-Diagnosekonsole — Installation, Bedienung und CLI
(English: [GUIDE.en.md](./GUIDE.en.md) · 简体中文: [README](../README.md))

---

## 1. Voraussetzungen

| Punkt | Anforderung |
| --- | --- |
| Betriebssystem | macOS 12+ / Windows 10+ / Linux (x64 oder Apple Silicon) |
| Node.js | **20 oder neuer** (LTS empfohlen) |
| Browser | Ein moderner Browser (Chrome / Edge / Safari / Firefox) |
| Netzwerk | Gleiches Subnetz wie das Ziel-Steuergerät bei echter Hardware; für die integrierte Simulation kein Netzwerk nötig |

Python, native Module oder Treiber sind **nicht** erforderlich.

---

## 2. Installation und Start

```bash
npm install
npm start          # baut das Frontend und startet das Backend
```

Ein Prozess, eine Adresse: <http://127.0.0.1:8787>. Ist der Port belegt, probiert der Server
automatisch 8788–8797 und gibt die tatsächliche Adresse im Terminal aus.

### Ein-Klick-Skripte

| Plattform | Befehl |
| --- | --- |
| macOS / Linux | `bash scripts/start.sh` (öffnet den Browser automatisch) |
| Windows | `scripts\start.bat` doppelklicken oder in der Eingabeaufforderung starten |

Beide akzeptieren `--no-build`, um den Frontend-Build zu überspringen.

### Entwicklungsmodus (optional)

```bash
node --import tsx server/src/index.ts   # Terminal 1: Backend auf 8787
npm run dev                             # Terminal 2: Vite auf 5273 (Proxy für /api und /ws)
```

Dann <http://127.0.0.1:5273> öffnen.

---

## 3. Benutzeroberfläche

Die Oberfläche ist in fünf Bereiche gegliedert:

- **A — Verbindung**: Steuerung des simulierten Steuergeräts, erkannte Entitäten, SA/TA, Routing-Aktivierung, Transportschicht-Diagnose, Sitzung & Sicherheit.
- **B — Dienstanfrage**: UDS-Anfragen per Formular oder Roh-Hex, physische/funktionale Adressierung, periodisches Senden, Favoriten.
- **C — Trace**: Live-Nachrichtenliste mit virtueller Darstellung, Wireshark-ähnliche Filterausdrücke, Aufzeichnung, Export.
- **D — Details**: dreistufiger Dekodierbaum, Hex-Ansicht mit beidseitiger Hervorhebung, Fehlererklärung.
- **E — Statusleiste**: Verbindungsstatus, Routing-Code, UDS-Sitzung, Sicherheitsstufen, S3-Countdown, Zähler, Trace-Statistik.

### ★ Sprachumschaltung (Chinesisch / Englisch / Deutsch)

Der Umschalter **中 / EN / DE** befindet sich oben rechts in der Symbolleiste (links neben der WebSocket-Statusanzeige).
Die Auswahl wird in `localStorage` (`doip.lang`) gespeichert und beim nächsten Besuch wiederhergestellt;
sie beeinflusst keinen Diagnosezustand und keine Verbindung.

> Vom Backend erzeugte Meldungen (Protokollfehler-Details, NRC-Namen aus der Dienstbibliothek) können in
> einzelnen Detailfenstern noch auf Chinesisch erscheinen; der Kernablauf und alle Bedienelemente sind vollständig lokalisiert.

### Erster Start (Simulation)

1. In der Symbolleiste **Simuliertes Steuergerät** wählen → **Verbinden**. Läuft die Simulation nicht, wird sie automatisch gestartet.
2. Auf die Routing-Aktivierung warten (Antwortcode `0x10`). Die Routing-Karte wird grün.
3. In Bereich B `22 F1 90` senden, um die VIN zu lesen.
4. In Bereich C die Transaktion `0x8001 → 0x8002 → 0x8001` samt Latenz prüfen.

### Echte Hardware verbinden

**Echtes Steuergerät** wählen, IP und Port des Steuergeräts/Gateways eingeben (Standard-DoIP-Port **13400**),
optional zuerst die **Fahrzeugerkennung** nutzen, dann **Verbinden**.

---

## 4. Kommandozeilenwerkzeug (`doip`)

Die CLI nutzt denselben Protokollstapel und startet **keinen** HTTP/WS-Server.

```bash
npm run cli -- scan --port 13401          # UDP-Fahrzeugerkennung (0x0001 → 0x0004)
npm run cli -- send 22F190 -p 13401       # Verbinden + Routing + eine UDS-Anfrage
npm run cli -- alive -p 13401             # aktiver Alive Check (0x0007 → 0x0008)
npm run cli -- entity-status -p 13401     # Entitätsstatus (0x4001 → 0x4002)
npm run cli -- power-mode -p 13401        # Energiemodus (0x4003 → 0x4004)

npm link                                  # optional: globaler Befehl `doip`
doip send 22 F1 90 -H 192.168.1.10 --json
```

Optionen: `-H/--host`, `-p/--port`, `--sa`, `--ta`, `--protocol 0x02|0x03`,
`--timeout`, `--addressing physical|functional`, `--json`, `--yes`, `--passive`, `--no-color`.

Destruktive Dienste (`0x11`, `0x14`, `0x2E`, `0x31`, `0x27` Key senden) erfordern `--yes`.

Exit-Codes: `0` Erfolg (auch bei negativer UDS-Antwort), `1` Kommunikationsfehler, `2` ungültige Argumente.

Vollständige Referenz: [CLI.md](./CLI.md) (Chinesisch).

---

## 5. Speicherorte

| Inhalt | Pfad |
| --- | --- |
| Trace-Aufzeichnung | `~/.doip-console/trace-logs/` |
| Backend-Protokolle | `~/.doip-console/logs/` |

Unter Windows: `C:\Users\<Benutzer>\.doip-console\`.

---

## 6. Fehlerbehebung

| Symptom | Ursache / Lösung |
| --- | --- |
| `ECONNREFUSED` beim Verbinden mit der Simulation | Simulation läuft nicht und Autostart ist fehlgeschlagen; zuerst in Bereich A starten |
| `node: command not found` | Node.js fehlt oder PATH ist veraltet; neu installieren und Terminal neu öffnen |
| `npm install` sehr langsam | Mirror verwenden: `npm config set registry https://registry.npmmirror.com` |
| Fahrzeugerkennung findet nichts | Falsche Netzwerkkarte/Subnetz, Firewall oder Steuergerät stromlos; Unicast auf die ECU-IP versuchen |
| CSV mit chinesischen Zeichen in Excel fehlerhaft | Sollte nicht auftreten — Exporte enthalten UTF-8-BOM. Neu exportieren statt in einem anderen Tool zu speichern |
| Port bereits belegt | Der Server zählt automatisch hoch; die im Terminal ausgegebene Adresse verwenden |

---

## 7. Qualitätsprüfungen (für Entwickler)

```bash
npm run typecheck      # striktes TypeScript, null Fehler
npm run check:timeouts # keine hartkodierten Timeouts außerhalb shared/constants.ts
npm test               # Unit-Tests für Server + Web
npm run smoke          # End-to-End-Smoke-Test mit echten Sockets
npm run verify         # alles zusammen
```

---

*Zurück zur [README](../README.md) · [English guide](./GUIDE.en.md) · [CLI-Referenz](./CLI.md)*
