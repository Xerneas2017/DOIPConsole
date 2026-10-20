# User Guide (English)

DoIP Diagnostic Console — installation, usage and CLI
(简体中文版见 [README](../README.md) · Deutsche Fassung: [GUIDE.de.md](./GUIDE.de.md))

---

## 1. Requirements

| Item | Requirement |
| --- | --- |
| OS | macOS 12+ / Windows 10+ / Linux (x64 or Apple Silicon) |
| Node.js | **20 or newer** (LTS recommended) |
| Browser | Any modern browser (Chrome / Edge / Safari / Firefox) |
| Network | Same subnet as the target ECU for real hardware; no network needed for the built-in simulator |

No Python, native modules or drivers are required.

---

## 2. Install & start

```bash
npm install
npm start          # builds the frontend + starts the backend
```

One process, one address: <http://127.0.0.1:8787>. If the port is busy, the server
automatically tries 8788–8797 and prints the actual address.

### One-click scripts

| Platform | Command |
| --- | --- |
| macOS / Linux | `bash scripts/start.sh` (opens the browser automatically) |
| Windows | double-click `scripts\start.bat`, or run it from cmd |

Both accept `--no-build` to skip the frontend build.

### Development mode (optional)

```bash
node --import tsx server/src/index.ts   # terminal 1: backend on 8787
npm run dev                             # terminal 2: Vite on 5273 (proxies /api and /ws)
```

Open <http://127.0.0.1:5273>.

---

## 3. User interface

The UI is organised into five zones:

- **A — Connection**: simulated-ECU control, discovered entities, SA/TA, routing activation, transport diagnostics, session & security.
- **B — Service request**: form-driven or raw-hex UDS requests, physical/functional addressing, periodic send, favorites.
- **C — Trace**: live message list with virtual scrolling, Wireshark-style filter expressions, recording, export.
- **D — Details**: three-layer decode tree, hex view with bidirectional highlighting, error explanation.
- **E — Status bar**: connection state, routing code, UDS session, security levels, S3 countdown, counters, trace statistics.

### ★ Language switch (Chinese / English / German)

The **中 / EN / DE** toggle is at the top-right of the toolbar (left of the WebSocket status light).
The choice is stored in `localStorage` (`doip.lang`) and restored on the next visit; it does not affect
any diagnostic state or connection.

> Backend-generated messages (protocol error details, NRC code names from the service library) may still
> be Chinese in some deep panels; the core workflow and all controls are fully localised.

### Typical first run (simulator)

1. Select **Simulated ECU** in the toolbar → click **Connect**. If the simulator is not running it is started automatically.
2. Wait for routing activation (response code `0x10`). The routing card turns green.
3. Send `22 F1 90` in zone B to read the VIN.
4. Switch to zone C to inspect the `0x8001 → 0x8002 → 0x8001` transaction and latency.

### Connecting real hardware

Select **Real ECU**, enter the ECU/gateway IP and port (standard DoIP port **13400**), optionally use
**Vehicle discovery** first, then **Connect**.

---

## 4. Command-line interface (`doip`)

The CLI reuses the same protocol stack and does not start the HTTP/WS server.

```bash
npm run cli -- scan --port 13401          # UDP vehicle discovery (0x0001 → 0x0004)
npm run cli -- send 22F190 -p 13401       # connect + routing activation + one UDS request
npm run cli -- alive -p 13401             # active alive check (0x0007 → 0x0008)
npm run cli -- entity-status -p 13401     # entity status (0x4001 → 0x4002)
npm run cli -- power-mode -p 13401        # power mode (0x4003 → 0x4004)

npm link                                  # optional: register the global `doip` command
doip send 22 F1 90 -H 192.168.1.10 --json
```

Common options: `-H/--host`, `-p/--port`, `--sa`, `--ta`, `--protocol 0x02|0x03`,
`--timeout`, `--addressing physical|functional`, `--json`, `--yes`, `--passive`, `--no-color`.

Destructive services (`0x11`, `0x14`, `0x2E`, `0x31`, `0x27` send-key) require `--yes`.

Exit codes: `0` success (including negative UDS responses), `1` communication failure, `2` invalid arguments.

Full reference: [CLI.md](./CLI.md) (Chinese).

---

## 5. Data locations

| Content | Path |
| --- | --- |
| Trace recording | `~/.doip-console/trace-logs/` |
| Backend runtime logs | `~/.doip-console/logs/` |

On Windows these resolve to `C:\Users\<you>\.doip-console\`.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `ECONNREFUSED` when connecting to the simulator | The simulator is not running and auto-start failed; start it in zone A first |
| `node: command not found` | Node.js is not installed or PATH is stale; reinstall and reopen the terminal |
| `npm install` is slow | Use a mirror: `npm config set registry https://registry.npmmirror.com` |
| Vehicle discovery finds nothing | Wrong NIC/subnet, firewall, or ECU not powered; try unicast to the ECU IP |
| CSV shows garbled Chinese in Excel | Not expected — exports contain a UTF-8 BOM. Re-export rather than re-saving from another tool |
| Port already in use | The server auto-increments; use the address printed in the terminal |

---

## 7. Quality gates (for developers)

```bash
npm run typecheck      # strict TypeScript, zero errors
npm run check:timeouts # no hardcoded timeouts outside shared/constants.ts
npm test               # server + web unit tests
npm run smoke          # end-to-end smoke test with real sockets
npm run verify         # all of the above
```

---

*Back to [README](../README.md) · [Deutsche Anleitung](./GUIDE.de.md) · [CLI reference](./CLI.md)*
