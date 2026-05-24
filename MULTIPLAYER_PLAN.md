# SPACE WAR — Multiplayer Implementation Plan

A staged plan for adding 2–4 player free-for-all PvP to SPACE WAR.
The single-player game continues to ship from GitHub Pages unchanged;
multiplayer adds an authoritative WebSocket server living on PartyKit.

---

## Goals

- **2–4 player free-for-all deathmatch.** First to N kills (default 15) or
  highest score after a 5-minute timer, whichever comes first.
- **Server-authoritative netcode.** Cheating the client is pointless — the
  server owns the world state and arbitrates every hit.
- **Production-grade feel from day one.** Client-side prediction for the
  player's own ship, entity interpolation for remote ships, lag compensation
  for hit detection. No "wait, I shot first" arguments.
- **Equal loadout in PvP.** Campaign upgrades are ignored — every player
  enters with the baseline ship. Skill decides matches, not grind hours.
- **No regression to single-player.** The campaign, missions, shop, achievements
  and existing controls keep working exactly as they do today.

## Locked-in tech choices

| | |
|---|---|
| Server runtime | **PartyKit** (Cloudflare Workers + Durable Objects under the hood) |
| Wire transport | **WebSocket** with JSON messages (2–4 players doesn't warrant binary yet) |
| Server tick | **30 Hz** (physics + collision) |
| Snapshot rate | **20 Hz** (broadcast to clients) |
| Netcode model | Server-authoritative + client-side prediction + entity interpolation + lag compensation |
| Match format | FFA deathmatch — first to 15 kills or 5 minutes |
| Loadout | Fixed baseline ship for all players, all 3 weapons available |
| Player count | 2–4 per room |
| Static client | Stays on GitHub Pages, connects out to PartyKit via WSS |

## Architecture

```
   ┌───────────────┐                   ┌──────────────────────┐
   │   Browser A   │◀── WebSocket ────▶│                      │
   ├───────────────┤                   │  PartyKit Room       │
   │   Browser B   │◀── WebSocket ────▶│  ─────────────       │
   ├───────────────┤                   │  • 30 Hz sim         │
   │   Browser C   │◀── WebSocket ────▶│  • 20 Hz snapshot    │
   ├───────────────┤                   │  • lag compensation  │
   │   Browser D   │◀── WebSocket ────▶│  • match state       │
   └───────────────┘                   └──────────────────────┘
```

- The browser hosts the renderer, input, UI, audio, prediction, interpolation.
- The PartyKit Worker hosts the simulation, hit arbitration, match flow.
- Both sides share a JS physics module so client prediction stays in lockstep
  with server simulation.

### Repo structure (planned)

```
space-war/
├── index.html              ← unchanged; single-player game (GitHub Pages)
├── shared/
│   └── physics.mjs         ← ship dynamics, used by both sides
├── server/                 ← PartyKit project
│   ├── partykit.json
│   ├── src/server.ts
│   └── ...
├── README.md
└── MULTIPLAYER_PLAN.md
```

The browser continues to import physics from `./shared/physics.mjs`; the
PartyKit Worker imports the same file as a regular module.

## Wire protocol (sketch)

Every message is JSON `{ t: <type>, ... }`. Client → server:

- `JOIN`     – `{ name, color }` once after socket opens
- `INPUT`    – `{ seq, dt, keys, aim, weapon, fire, time }` at 30 Hz
- `READY`    – `{ ready: true|false }` in lobby
- `LEAVE`

Server → client:

- `WELCOME`    – room state, your `id`, other players, match config
- `LOBBY`      – `{ players: [...] }`
- `MATCH_START` – `{ endsAt, killLimit }`
- `SNAPSHOT`   – at 20 Hz: `{ tick, ackSeq, players, bullets, missiles, pickups }`
- `HIT`        – instantaneous: `{ shooter, victim, weapon, dmg, hp, shield }`
- `KILL`       – `{ killer, victim, weapon }`
- `RESPAWN`    – `{ player, pos, quat, invulnUntil }`
- `MATCH_END`  – `{ scores, winner }`

## Phased delivery

Each phase ends in a checkpoint that's at least demonstrable, even if not
shippable. Rough effort assumes solo work.

### Phase 0 — Foundations (1–2 days)

- Scaffold `server/` with PartyKit (`npx partykit init`).
- Extract player physics from `index.html` into `shared/physics.mjs`
  (no behavior change — just a refactor).
- Deploy a "hello world" PartyKit room and verify the browser can open a
  WebSocket to it.
- **Checkpoint:** client connects, sends a heartbeat, server echoes back.

### Phase 1 — Wire protocol & match scaffold (3 days)

- Define all message types as TS interfaces in `server/src/types.ts`.
- Server: room state machine (`LOBBY → COUNTDOWN → MATCH → END → LOBBY`),
  player join/leave, broadcast snapshots (empty world, just connected players).
- Client: a separate "Multiplayer" entry point that opens the lobby UI,
  joins a room and renders other players as dummy ships drifting in space.
- **Checkpoint:** 2+ browsers connect, see each other's ships moving (no
  physics yet — just dummy snapshots).

### Phase 2 — Server-authoritative simulation (4–5 days)

- Server runs the shared physics at 30 Hz per player from their latest input.
- Bullets / missiles spawn server-side from `INPUT.fire` and propagate.
- Collision: bullet vs player, bullet vs asteroid (static map).
- Damage, death, respawn (3s delay, invuln 2s, spawn at zone edge away
  from other players).
- Snapshot broadcast at 20 Hz with full world state.
- **Checkpoint:** unpredicted, uninterpolated PvP works — laggy but playable.
  This is the floor of "real netcode."

### Phase 3 — Client-side prediction (3 days)

- Client simulates its own ship locally with `physics.mjs` on each input.
- Inputs are tagged with a monotonically increasing `seq`.
- When `SNAPSHOT` arrives with `ackSeq`, client rewinds to that state,
  replays all inputs > `ackSeq`, and smooths the visual delta over ~100 ms.
- **Checkpoint:** your own ship feels instantaneous; remote ships still
  jitter on packet loss.

### Phase 4 — Entity interpolation (2 days)

- Buffer the last 3 snapshots client-side.
- Render remote players, bullets and missiles at `serverNow - 100 ms`,
  interpolating between adjacent snapshots.
- Handle out-of-order / late packets gracefully.
- **Checkpoint:** remote ships look smooth even under packet jitter.

### Phase 5 — Lag compensation (3 days)

- Server keeps a 1-second ring buffer of player positions per tick.
- `INPUT.fire` carries the client's perceived server time (`serverNow - 100 ms`
  + transport latency estimate).
- On a shot, server rewinds *all* potential victims to that time and runs
  hit detection at that historical state.
- **Checkpoint:** "I clearly hit them" reliably counts.

### Phase 6 — Match flow + scoring (3 days)

- Kill / death tracking, scoreboard, kill feed.
- Match end conditions: kill limit or timer.
- Match-end overlay with leaderboard, "PLAY AGAIN" / "BACK TO LOBBY".
- **Checkpoint:** complete matches start to finish with a clean reset.

### Phase 7 — Lobby UX (3–4 days)

- **Start-menu entry:** add a `★ MULTIPLAYER` button on the title screen.
- Lobby screen: create-room (host gets a 4-letter code) / join-by-code.
- Callsign entry (persisted in `save.callsign`).
- Player list with ready states and color swatches.
- Start match when host hits GO (need ≥2 players ready).
- **Checkpoint:** friends can play a full match end-to-end with no devtools.

### Phase 8 — PvP polish (3 days)

- Per-player ship colors (4-color palette: green / blue / orange / magenta).
- HUD: opponent name + hull bar above each visible enemy ship.
- Map pickups respawn on a timer (no AI enemies to drop them).
- Disable the docking shop in PvP rooms (station is just cover).
- Spectator mode during respawn delay.
- **Checkpoint:** ship looks and feels like a proper PvP build.

### Phase 9 — Test & harden (~1 week)

- Real geographic latency tests (US / EU).
- Mid-match disconnect, reconnect, rejoin.
- Mobile cross-play sanity check.
- Server CPU budget on PartyKit free tier under 4-player load.
- Save the live PartyKit URL in `index.html` and ship.

**Total realistic estimate: 4–6 weeks of focused solo work.**

## Open decisions (defaults assumed)

These are small and I'll go with the default unless overruled later:

- **Kill limit:** 15.
- **Match timer:** 5 minutes.
- **Respawn delay:** 3 s + 2 s invulnerability.
- **Ship colors:** auto-assigned from `[green, blue, orange, magenta]` in
  join order.
- **Callsign:** required, 1–12 chars, persisted to `localStorage`.
- **PvP map:** the existing combat zone (asteroids + station as cover, no
  enemy AI, no loot drops from kills; only timed map pickups).
- **Zone radiation:** unchanged — keeps players in the arena.
- **Repo layout:** monorepo, `server/` subdir alongside `index.html`.

## What I need from you before Phase 0 starts

1. **PartyKit account.** Sign up at https://partykit.io (GitHub OAuth, free).
2. **CLI login** on your machine: `npx partykit login`.
3. **Confirm the repo layout** above is fine (I'll add `server/` next to
   `index.html`; GitHub Pages keeps serving the root, unchanged).

Once those three are done I'll scaffold Phase 0, push it for review, and
work the phases in order with checkpoints between each.
