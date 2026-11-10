# Ayran Mini Factory Simulation

**Türkçe:** [README.tr.md](README.tr.md)

**A 3D ayran (yogurt drink) factory driven by real IEC 61131-3 PLC code over Modbus TCP**, from the tank to the cup, and from the pallet to the cold store and the truck.

![The whole factory, the filling machine and the palletizing robot, running on a CODESYS PLC](docs/tanitim.gif)

*Recording: the line running on the CODESYS Control Win V3 soft PLC. It shows the whole factory, then the filling machine, then the palletizing robot. The UI labels are in Turkish.*

## Highlights

- **A full line, six cells:** a tank with CIP cleaning, an 8-pocket fill-and-seal machine, 6-packs in shrink wrap, robot palletizing with stretch wrapping, an AGV, and a 36-slot automated cold store (AS/RS).
- **A real PLC program:** the control logic is IEC 61131-3 Structured Text. The simulator behaves like the field sensors and motors and talks to the PLC over Modbus TCP.
- **Tested on two real runtimes:** OpenPLC v3, both as one PLC and as three separate PLCs (process / packaging / logistics), and CODESYS Control Win V3.
- **Survives a PLC power loss:**
  - On startup the PLC moves nothing and waits for START from the operator.
  - The pack count on the pallet is kept in retained memory and checked against the robot's own record.
  - Product that was in the shrink tunnel during the outage is quarantined.
  - The tank asks for a new CIP.
- **A monitoring layer (SCADA/MES-like):**
  - A traceability chain: pallet label → pack → cup → fill weight → product batch → last CIP.
  - OEE per cell, stop reasons, alarm history and a Pareto chart.
- **Fault scenarios:** 37 faults can be injected from the UI (a stuck piston, a broken film, a robot collision, a person in the AGV's path, a cut Modbus cable…), and the PLC's reaction shows live in the alarms and cell states.
- **217 automated tests:** 96 fault and flow scenarios, plus restart and monitoring unit tests.

## Quick start

```bash
npm install
npm run demo
```

The 3D factory opens at http://localhost:8080 and the monitoring dashboard at http://localhost:8081. Press **START**: the sealing head reaches temperature in about 20 s, then production starts. The demo runs a JavaScript port of the PLC program; running it on a real PLC is described below. Node.js 22.13 or newer is needed (the monitoring layer uses the built-in `node:sqlite`).

If port 8080 is taken (for example by OpenPLC in WSL): `PORT=8086 MODBUS_PORT=5021 MON_PORT=8087 npm run demo`.

Keys: `H` hides the panel (for recording video), and `1`–`9` switch camera views (5 tank and CIP, 6 packaging, 7 palletizing, 8 AGV and store, 9 the whole factory). The "Test feeder" button in the palletizing panel puts a ready pack on the pickup point every 5 s, so the cell can be shown without waiting ~12 minutes for a pallet to fill.

## Lessons learned

- **Network latency breaks control.** The filling valve's close lead time (pre-act) oscillated with Modbus latency: one fill over, the next under. Going from a 20 ms to a 10 ms PLC task cut the reject rate.
- **Short pulses get lost.** With a 0.5 s Modbus round trip, a one-scan signal may never be seen. The robot, the AGV and the stacker crane use job-numbered handshakes: a job can't run twice, and its result record is retained.
- **"Power came back" is its own state.** The PLC's memory and the real state of the field can differ. On startup the PLC reads the sensors first, reconciles its records, and only then waits for START.
- **Cell contracts split the complexity.** Each machine only knows its neighbours' signals. That is what let the single-PLC program be split later into three PLCs (process, packaging, logistics), with the signals between cells carried over Modbus.

## Overview

The simulator acts as a Modbus TCP server (slave), and OpenPLC or any other PLC connects to it as the client (master). The factory has six parts:
- a tank and transfer line, with CIP cleaning;
- an 8-pocket indexed fill-and-seal machine with an accumulation conveyor;
- 2×3 grouping, sleeve shrink wrapping and a shrink tunnel;
- a robot palletizing cell: a 4-axis robot, a pallet line, a stretch wrapper, a fence, a door and a light curtain;
- an AGV that carries full pallets from the palletizing cell to the store, and charges itself;
- an automated cold store (AS/RS): 36 slots, a stacker crane, an infeed check, FIFO dispatch and a truck dock.

On top of that sits a monitoring layer. The factory can run on one PLC or on three. Each station has its own PLC function block and its own 16-register Modbus block.

```
 Simulator (field) ──Modbus──► Process PLC    (filling + tank, blocks 0-2)  ──┐
   │  line tracking events ──► Packaging PLC  (shrink + pallet, blocks 3-4) ─┼─Modbus (each PLC's own slave)─► Monitoring ─► SQLite ─► dashboard
   │                      ──► Logistics PLC  (AGV + store, blocks 5-6)     ──┘                                     ▲
   └──────────── /api/events (identified product movements: cup, pack, pallet, slot, shipment) ──────────────────┘
```

```
 T1 production tank ──V_PROD──┐                                     ┌──V_FILL (mix-proof)──► filling tank
 Water ───────────────V_WATER─┼──► P1 pump ──► FT1 flow ──► QT1 ────┼──V_DRAIN──► drain
 CIP caustic tank ───V_CAUSTIC┘                 conductivity         └──V_CIPRET──► back to the caustic tank

 Filling machine:
 Cup         Fill          Foil      Heat       Check-     Reject    Out
 feed        (on a scale)            seal       weigher
  [0]   [1]    [2]          [3]       [4]        [5]        [6]   [7] ──►
   ▲            │            ▲         │          │          │
 magazine    coarse+fine   vacuum arm  195 °C    gross      piston → reject bin
             flow                      0.8 s     weight
```

## What it shows

- **Indexed cycle with parallel stations.** The chain moves one step, six stations work at the same time, and the next step starts when all of them are done.
- **Product tracking with shift registers.** A "cup present / defective" bit is shifted with the chain for every pocket, so the reject decision lands on the right cup 4 pockets later.
- **Two-stage filling on a scale, with two self-tuning parameters.** Coarse flow first, then fine flow.
  - The pre-act is corrected by half of the last error after every cup.
  - The coarse cutoff margin grows by 10 g when the fine flow lasts under 0.5 s (the coarse flow overshot), and shrinks by 2 g when it lasts over 2.5 s.
  - This keeps fills within ±4 g both at 20 ms latency and with OpenPLC v3's ~0.5 s Modbus round trip.
- **Heater thermostat:** ±2 °C hysteresis, waiting for warm-up, and a heater-fault alarm if it isn't warm after 45 s.
- **Route manager and mix-proof line.** On every route change the pump stops, the limit switches prove that every valve not in the new route is closed, the new route opens, the valve stroke time passes, and the pump restarts. If a valve outside the route reads open, the pump stops. The filling-tank valve is double-seated (mix-proof): a leaking seal drains through the leakage chamber and trips a sensor. Caustic can never reach the product.
- **Push-out and phase separation.** Water or stale product in the line goes to drain until the conductivity is inside the product window (8.5–9.5 mS/cm, compensated to 25 °C). During CIP, caustic goes to drain until it is strong enough, then returns to its tank.
- **CIP:** preparation → caustic heating → pre-rinse (30 kg of water) → caustic (65 mS/cm, 70 °C and 1.5 kg/s held together for 30 s; if any one drops, the timer restarts) → final rinse (30 kg, and until the conductivity is within 0.5 mS/cm of the incoming water). Every CIP is logged: result, duration, the lowest temperature and flow in the hold window, and the final-rinse conductivity. Times are demo-scaled (real caustic contact is 10–20 minutes).
- **CIP scheduling:** one CIP every 50 kg of production. At the limit, transfer stops and the filling machine keeps going from its own buffer for a while.
- **Shrink tunnel:** 160 °C for POF film, ±3 °C. A pack only enters when the tunnel is hot, the exit is clear and the belt is running. The heater can't run without the fan or after the independent over-temperature cutout trips. After 2 minutes without cups the setpoint drops to 120 °C to save energy.
- **Controlled emptying on STOP:** no new packs enter, the packs inside are run out, then the fan cools the tunnel to 60 °C and stops.
- **Product quarantine on startup:** if the first valid image shows product in the tunnel, the wrapper or on the plate, the PLC diverts that group to quarantine. Rejected packs never reach the robot.
- **Cell state (PackML-like):** ready for a pack, running, warming up, emptying, fault, exit blocked and waiting for cups are published as bits in a separate word, for OEE.
- **Robot job handshake.** The PLC doesn't drive the robot axis by axis. As in real cells, it sends jobs to the robot controller (pick, place, cardboard sheet, go home). A job starts when the job number (SEQ) changes, and the same number never runs twice. The robot writes back the number of the last job it accepted and finished, a result code and a slot. That record is retained, so the PLC can read the last result after a communication loss. A timed-out job raises an alarm instead of being blindly repeated.
- **Pallet ledger.** 3 layers × 6 packs on a half pallet, with cardboard at the bottom and top. The count only increases after the robot reports "done", or "placed, then aborted". A dropped pack's slot stays empty and the next pack goes there. The tests compare the PLC's count with the real packs on the pallet every second.
- **Zone interlock and an independent safety controller.** The door lock, the light curtain with muting and the e-stop are evaluated by a separate safety controller in the simulator (in reality a safety relay or safety PLC). It cuts robot power and cell motors; OpenPLC only reads its state. This is a teaching model, not a certified safety design.
- **AGV and station handshakes.** Like a simple master control, the PLC gives the AGV jobs (move, drop the load, charge, park), and the vehicle finds its own path. A station's permission is held until the load is picked or dropped, and that station's conveyor can't run while the forks are inside. The laser scanner is on the vehicle: it stops at an obstacle and continues after 2 s of clear field. This is not VDA 5050.
- **Store infeed, slot table and inventory reconciliation.** An infeed check (contour and label) rejects bad pallets, so no unidentified stock exists. The PLC keeps a state per slot (empty, reserved, full, unknown) and a pallet number. An interrupted job, a double store or a PLC restart marks a slot "unknown", and the crane goes there and reads the label to fix the table. Dispatch is FIFO.
- **Cold store:** 2–6 °C, with a warning if a cooling failure keeps it above 6 °C for 30 s.
- **Safety and supervision:** an NC e-stop chain, an NC stop button, a communication heartbeat watchdog, a timeout alarm for every movement, alarm acknowledgement and a horn.
- **Fault injection.** The simulator separately tracks the real quality of every cup, pack and pallet (fill, seal, dilution with water, caustic contamination, film, missing packs, cardboard, wrapping) and a hidden line-soil score. That shows whether the PLC program let a bad product through, or product through a dirty line.

## Monitoring layer

![Monitoring dashboard: overview](docs/izleme-genel.jpg)

Only what can be measured in the field goes into the monitoring database:
- **From the PLC's own Modbus slave** (OpenPLC v3: port 502, `%QW100..`): cell states, alarm words, production counters and CIP records.
- **From the simulator's line-tracking event stream** (`GET /api/events?after=<seq>`): identified product movements, as a checkweigher, label printer, robot controller, pallet reader or WMS would report them.

The simulator's hidden truth (`sim_defect`) is kept in a separate column and greyed out, and it never enters the calculations; the tests use it to measure what monitoring missed.

- **Traceability:** pallet → pack → cup → transfer → batch → CIP, queried by pallet label. "Which pallets carry product made after this CIP?" is computed in the query, and a forward recall lists those pallets and where they are now.
- **OEE:** the denominator is the shift's calendar time, and only "no data" time is subtracted. The line OEE is the bottleneck's (the filler's). Micro-stops, a loss tree, an alarm Pareto and a printable shift report are included.
- **Reconciliation:** PLC counters vs. line-tracking events from the same counting point.

The dashboard opens with `npm run demo` at http://localhost:8081. It uses no external libraries (SVG) and refreshes every 2 s. API (JSON): `/api/overview`, `/api/timeline`, `/api/stops`, `/api/alarms`, `/api/pallets`, `/api/trace?label=`, `/api/recall?cip=`, `/api/cips`, `/api/lots`, `/api/report`.

## Three PLCs

| PLC | Blocks | Read (FC4) | Write (FC16) | Heartbeat |
|---|---|---|---|---|
| Process | 1 filling, 2 tank (+ owner of block 0) | IR 0–47 | HR 0–47 | `FAB_QW_PLC_HB` |
| Packaging | 3 shrink, 4 palletizing | IR 0–79 | HR 48–79 | `SHR_QW_PLC_HB` |
| Logistics | 5 AGV, 6 store | IR 0–111 | HR 80–111 | `AGV_QW_PLC_HB` |
| Single PLC | all | IR 0–111 | HR 0–111 | all three |

There is one source: `plc/src/Ortak.st` (the part shared by every PLC: panel, e-stop, watchdog, heartbeat) plus `Proses.st`, `Paketleme.st` and `Lojistik.st`. `npm run build:plc` generates `plc/build/fabrika.st` (single PLC) and `proses.st`, `paketleme.st`, `lojistik.st`. The simulator's watchdog is per PLC: if one PLC's heartbeat stops for 1.5 s, only that PLC's cells drop their outputs, and the others wait starved or blocked without damage. Demo: `npm run demo:3plc`.

![Process PLC restarted: filling stopped, tank asks for CIP](docs/yeniden-baslama.jpg)

## Running on a real PLC

### OpenPLC v3

```bash
npm run build:plc     # plc/src → plc/build/*.st, addresses generated from public/iomap.js
npm start             # simulator only (Modbus TCP slave on port 5020)
```

On Windows, install OpenPLC v3 in WSL (`wsl --install -d Ubuntu-24.04`, then clone `thiagoralves/OpenPLC_v3` and run `./install.sh linux`, which takes 15–25 min). Then, inside Ubuntu:

```bash
./plc/openplc/run_ayran.sh                  # compiles, adds the simulator as a slave device, starts the PLC
ROLE=paketleme ./plc/openplc/run_ayran.sh   # or just one role of the three-PLC factory
```

`plc/openplc/oplc3.sh` runs three OpenPLC v3 instances on one WSL machine, each in its own network namespace, and `scripts/oplc3-run.mjs` drives a full-line run that restarts each PLC in turn.

To set it up by hand in the web UI: upload `plc/build/fabrika.st`, then add a Generic Modbus TCP slave device (ID 1, port 5020, Input Registers start 0 size 112, Holding Registers - Write start 0 size 112).

Things to know:
- matiec (OpenPLC's ST compiler) crashes **without an error message** on non-ASCII characters in comments and on a long list of TON instances declared on one line. That is why the ST comments are ASCII-only and every timer is on its own line. `npm run build:plc` catches both cases, and the reserved words `STEP` and `RS`, before compiling.
- WSL shuts Ubuntu down a few seconds after the last session closes, and the PLC stops with it. Keep an Ubuntu terminal open.

### CODESYS Control Win V3

The same ST program (single-PLC role) is built with CODESYS 3.5 SP22 Patch 4 and downloaded to the CODESYS Control Win V3 x64 soft PLC. It connects to the simulator as a Modbus TCP client through the ModbusFB library (`codesys/modbus-io.st`). The OpenPLC `%IW/%QW` addresses become plain variables, and the `%MW` retained area becomes `VAR_GLOBAL PERSISTENT`. The program logic is unchanged.

```bash
npm run build:codesys    # plc/src → codesys/build/pous.json
```

Then run `codesys/create_project.py` and `codesys/download_run.py` with `CODESYS.exe --runscript=... --noUI`. Start the soft PLC first, from the tray icon → "Start PLC".

The result (4 Nov 2026): 0 errors and 0 warnings, then download, RUN and boot application. After RESET + START + CIP, in 4 minutes: CIP done, 37 good cups, 5 packs on the pallet, no alarms. In a power-loss test the service was stopped with 14 packs on the pallet. The persistent ledger came back as 14, matching the real count, and the pallet was closed at 18/18 after restart.

### OpenPLC v4, or another PLC

OpenPLC v4 needs per-register FC6 write groups (it has no FC16) and editor addresses; see the Turkish README. Any Modbus TCP master can connect (Siemens S7 `MB_CLIENT`, a CODESYS Modbus TCP master…), and the simulator accepts any slave ID.

## Signal map (version 7)

One source: [`public/iomap.js`](public/iomap.js), used by the simulator, the UI, the JS test PLC and the ST generator. Each station has a 16-register block: input register `block×16 + n` goes simulator → PLC, and holding register `block×16 + n` goes PLC → simulator. Seven blocks (112 registers) fit in one FC4 read and one FC16 write. Digital signals are packed into 16-bit words.

| Block | Registers | Station |
|---|---|---|
| 0 | 0–15 | Factory: operator panel, e-stop, heartbeats, map version |
| 1 | 16–31 | Fill and seal |
| 2 | 32–47 | Tank, pump, flowmeter, CIP |
| 3 | 48–63 | Grouping, shrink wrapper, tunnel |
| 4 | 64–79 | Robot palletizing, pallet line, stretch wrapper |
| 5 | 80–95 | AGV |
| 6 | 96–111 | Automated cold store (AS/RS) |

The register-by-register tables are in the [Turkish README](README.tr.md#sinyal-haritası-sürüm-7), and the names and bit meanings are in `public/iomap.js`.

## Product spec

| | Value |
|---|---|
| Target fill | 206.0 g net (200 ml, density 1.03) |
| Tolerance | ±4.0 g |
| Cup tare | 4.5 g, foil 0.4 g |
| Sealing | 0.8 s contact at 170–220 °C |
| Speed | ~13 cups/min (4.5 s; ~6 s with OpenPLC v3 latency) |

## Tests

```bash
npm test
```

The simulator and the PLC logic run in the same process, in accelerated time, with emulated Modbus latency. There are 28 monitoring unit tests, 85 PLC/startup unit tests, 8 CODESYS generator tests and 96 scenarios. Scenarios can run with a single PLC or three, and with the monitoring layer in the same process. Every second of every scenario, two ledgers are checked: the PLC's pack count on the pallet, and its slot table, against the real pallet and rack in the simulator. Run one group with, for example, `node test/smoke.js "Tank:"` or `node test/smoke.js FAZ6`.

The scenarios include normal production at 20 ms and at OpenPLC v3 latency, a drifting scale, a jammed indexer, an empty foil magazine, a cut Modbus cable, CIP during production, a stuck-open fill valve, a seal leak, a broken film, a stopped tunnel fan, a blocked exit, a door opened while the robot places a pack, a dropped pack, a robot collision, someone walking through the light curtain, an obstacle in the AGV's path, a contour or label failure at the store infeed, a store door opened during a crane move, a PLC restart, a low AGV battery, a cooling failure, and monitoring checks (OEE, Pareto, recall, data gaps).

## Code layout

```
public/iomap.js        Shared signal map (16 registers per block), the single source
plc/src/Ortak.st       Shared by every PLC: panel, e-stop, comms watchdog, heartbeat
plc/src/Proses.st      Process PLC: filling + tank, factory summary (block 0)
plc/src/Paketleme.st   Packaging PLC: shrink + palletizing
plc/src/Lojistik.st    Logistics PLC: store + AGV
plc/src/FB_Dolum.st    Fill-and-seal function block
plc/src/FB_Tank.st     Tank, transfer, route manager and CIP
plc/src/FB_Shrink.st   Grouping, wrapping and shrink tunnel
plc/src/FB_Pallet.st   Robot job handshake, pallet line, stretch wrapper and ledger
plc/src/FB_Agv.st      AGV master control: job choice, station permissions, battery
plc/src/FB_Asrs.st     Store: infeed check, crane jobs, slot table, inventory reconciliation, FIFO
plc/build/*.st         Generated files for OpenPLC (npm run build:plc)
plc/fb_*.js, fabrika.js  Line-by-line JavaScript ports of the ST code
plc/js-plc.js          Runs the JS port as a Modbus TCP client
plc/openplc/           run_ayran.sh (one OpenPLC v3), oplc3.sh (three in one WSL)
codesys/               CODESYS project and download scripts, Modbus I/O program
tools/gen-plc.js       ST merger and address generator; tools/gen-codesys.js for CODESYS
server/                Simulator: factory model, cells (filling, tank, shrink, pallet, AGV, AS/RS), Modbus + HTTP + WebSocket
public/                three.js scene and the operator panel
monitor/               Monitoring: SQLite schema, PLC polling, event ingest, OEE, traceability, dashboard
test/                  Accelerated end-to-end scenarios and unit tests
docs/tasarim/          Design notes and review reports (Turkish)
```

A note on names: the ST comments are in English, but the function blocks and the role programs carry Turkish names (Dolum = filling, Paketleme = packaging, Lojistik = logistics, Ortak = common). The comments in the JavaScript ports and the simulator are still mostly Turkish. Almost all variable and signal names are English (signal prefixes such as `DOL_` for the filler are short Turkish cell names).

## Built with

three.js · Node.js · Modbus TCP (`modbus-serial`) · WebSocket (`ws`) · SQLite (`node:sqlite`) · OpenPLC · CODESYS · IEC 61131-3 Structured Text

## License

MIT, see [LICENSE](LICENSE).
