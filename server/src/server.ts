// SPACE WAR multiplayer — PartyKit room handler.
//
// Phase 1+2: authoritative match server.
//   • Match state machine: WAITING → COUNTDOWN → MATCH → END → WAITING
//   • 30 Hz simulation tick (ship kinematics + bullet propagation +
//     hit detection + damage/death/respawn + scoring)
//   • 20 Hz SNAPSHOT broadcast for every connected client to render from
//   • Per-player input buffer (client → server INPUT at 30 Hz)
//   • Match flow: 3-second countdown, 3-minute match or first-to-15
//     kills, 8-second post-match scoreboard, automatic reset to lobby
//
// All ship dynamics live in ../../shared/physics.mjs so client-side
// prediction (Phase 3) will stay in lockstep with this simulation.

import type * as Party from "partykit/server";
import * as C from "../../shared/constants.mjs";
import { stepShip, applyZone, forwardFromQuat, rightFromQuat } from "../../shared/physics.mjs";

// ---- Shared math types (plain structs so they survive JSON over the wire) ----
type Vec3 = { x: number; y: number; z: number };
type Quat = { x: number; y: number; z: number; w: number };

const FALLBACK_COLORS = C.SHIP_COLORS as readonly string[];

// ---- Wire protocol ----
interface PingMsg     { t: "PING"; clientSent: number; }
interface JoinMsg     { t: "JOIN"; callsign: string; color?: string; }
interface ReadyMsg    { t: "READY"; ready: boolean; }
interface StartMsg    { t: "START_MATCH"; }
interface InputMsg {
  t: "INPUT";
  seq: number;
  yawDelta: number;
  pitchDelta: number;
  rollDelta: number;
  thrustX: number;
  thrustZ: number;
  boost: boolean;
  brake: boolean;
  weapon: number;
  fire: boolean;
  targetId: string | null;     // who the client's lead reticle is locked on
  clientTime: number;
}
type ClientMsg = PingMsg | JoinMsg | ReadyMsg | StartMsg | InputMsg | { t: string; [k: string]: unknown };

// ---- Per-connection state stored on the WS itself ----
type ConnState = { callsign: string; color: string; ready: boolean };

// ---- Per-match player state (recreated on respawn) ----
interface PlayerState {
  id: string;
  callsign: string;
  color: string;
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  hull: number;
  shield: number;
  energy: number;
  fireCD: number;
  weapon: number;
  missileAmmo: number;
  alive: boolean;
  respawnAtTick: number;
  invulnUntilTick: number;
  asteroidHitCd: number;     // cooldown so an asteroid can't tick-stack damage
  kills: number;
  deaths: number;
  score: number;
}

interface Asteroid {
  pos: Vec3;
  radius: number;
}

interface Bullet {
  id: number;
  owner: string;
  pos: Vec3;
  vel: Vec3;
  damage: number;
  ttl: number;
  weapon: number;
}

interface Missile {
  id: number;
  owner: string;
  targetId: string | null;
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  damage: number;
  ttl: number;
}

interface LatestInput {
  yawDelta: number;
  pitchDelta: number;
  rollDelta: number;
  thrustX: number;
  thrustZ: number;
  boost: boolean;
  brake: boolean;
  weapon: number;
  fire: boolean;
  targetId: string | null;
  lastSeq: number;
  clientTime: number;
}

type MatchPhase = "WAITING" | "COUNTDOWN" | "MATCH" | "END";

// ---- Helpers ----
const sanitizeCallsign = (raw: unknown): string => {
  const s = typeof raw === "string" ? raw : "";
  const cleaned = s.replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 12);
  return cleaned || "PILOT";
};
const sanitizeColor = (raw: unknown, fallback: string): string =>
  typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const sanitizeNum = (n: unknown, fallback = 0) => (typeof n === "number" && Number.isFinite(n) ? n : fallback);

function randomSpawn(): { pos: Vec3; quat: Quat } {
  // Spawn at zone edge facing origin so respawned players are pulled into the fight.
  const a = Math.random() * Math.PI * 2;
  const r = C.ZONE_RADIUS * 0.55 + Math.random() * 220;
  const pos: Vec3 = {
    x: Math.cos(a) * r,
    y: (Math.random() - 0.5) * 200,
    z: Math.sin(a) * r,
  };
  // Build a yaw-only quaternion so the ship's local -Z forward maps onto
  // the direction-from-pos-to-origin. The Three.js rotateY(θ) matrix takes
  // (0,0,-1) to (-sin θ, 0, -cos θ); we want that to equal -pos/|pos|, so
  //   sin θ = pos.x/|pos|,  cos θ = pos.z/|pos|  →  θ = atan2(pos.x, pos.z).
  const yaw = Math.atan2(pos.x, pos.z);
  const half = yaw * 0.5;
  const quat: Quat = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
  return { pos, quat };
}

// ---- The room ----
export default class SpaceWarRoom implements Party.Server {
  constructor(readonly room: Party.Room) {}

  // Match state — module-level because PartyKit reuses one instance per room.
  private phase: MatchPhase = "WAITING";
  private tick = 0;
  private nextBulletId = 1;
  private nextMissileId = 1;
  private players = new Map<string, PlayerState>();
  private inputs  = new Map<string, LatestInput>();
  private bullets: Bullet[] = [];
  private missiles: Missile[] = [];
  private asteroids: Asteroid[] = [];
  private hitEventBuf: Array<{ shooter: string; victim: string; weapon: number; pos: Vec3 }> = [];
  private fireEventBuf: Array<{ shooter: string; weapon: number; pos: Vec3 }> = [];
  private killEventBuf: Array<{ killer: string | null; victim: string; weapon: number }> = [];
  private respawnEventBuf: Array<{ id: string; pos: Vec3; quat: Quat; invulnUntilTick: number }> = [];
  private simTimer: ReturnType<typeof setInterval> | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownEndsAt = 0;
  private matchEndsAt = 0;
  private postEndsAt = 0;

  // ---------- Peer roster (lobby presentation) ----------
  private peers() {
    return [...this.room.getConnections<ConnState>()].map((c) => ({
      id: c.id,
      callsign: c.state?.callsign ?? "PILOT",
      color: c.state?.color ?? FALLBACK_COLORS[0],
      ready: c.state?.ready ?? false,
    }));
  }

  // ---------- Lifecycle ----------
  onConnect(conn: Party.Connection<ConnState>) {
    const fallback = FALLBACK_COLORS[this.peers().length % FALLBACK_COLORS.length];
    conn.setState({ callsign: "PILOT", color: fallback, ready: false });
    conn.send(
      JSON.stringify({
        t: "WELCOME",
        id: conn.id,
        room: this.room.id,
        serverNow: Date.now(),
        peers: this.peers(),
        phase: this.phase,
      })
    );
    // If a match is already running, the new connection is a spectator until the
    // next lobby cycle. For MVP we don't allow mid-match joins; they sit on the
    // lobby phase event and start playing once the room resets.
  }

  onMessage(message: string, sender: Party.Connection<ConnState>) {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(message) as ClientMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case "PING":
        sender.send(JSON.stringify({ t: "PONG", clientSent: (msg as PingMsg).clientSent, serverNow: Date.now() }));
        return;
      case "JOIN": {
        const j = msg as JoinMsg;
        const callsign = sanitizeCallsign(j.callsign);
        const color = sanitizeColor(j.color, sender.state?.color ?? FALLBACK_COLORS[0]);
        sender.setState({ callsign, color, ready: sender.state?.ready ?? false });
        this.broadcastPeers();
        return;
      }
      case "READY": {
        const r = msg as ReadyMsg;
        sender.setState({
          callsign: sender.state?.callsign ?? "PILOT",
          color: sender.state?.color ?? FALLBACK_COLORS[0],
          ready: !!r.ready,
        });
        this.broadcastPeers();
        return;
      }
      case "START_MATCH": {
        const peers = this.peers();
        console.log(`[${this.room.id}] START_MATCH from ${sender.id} (phase=${this.phase}, peers=${peers.length})`);
        if (this.phase !== "WAITING") {
          sender.send(JSON.stringify({
            t: "START_REJECTED",
            reason: `MATCH ALREADY ${this.phase} — WAIT FOR LOBBY`,
          }));
          return;
        }
        if (peers.length < C.MIN_PLAYERS_TO_START) {
          sender.send(JSON.stringify({
            t: "START_REJECTED",
            reason: `NEED ${C.MIN_PLAYERS_TO_START} PILOTS — HAVE ${peers.length}`,
          }));
          return;
        }
        this.startMatch();
        return;
      }
      case "INPUT":
        this.acceptInput(sender.id, msg as InputMsg);
        return;
    }
  }

  onClose(conn: Party.Connection<ConnState>) {
    this.broadcastPeers();
    if (this.peers().length === 0) {
      // Empty room — tear down any running match.
      this.fullReset();
      return;
    }
    // Mid-match disconnect — drop the leaver from the sim. If the number
    // of still-connected players drops below the start minimum, end the
    // match early so the remaining pilot isn't stranded waiting for the
    // 3-minute timer (which would also block new matches from starting).
    if (this.phase === "MATCH" || this.phase === "COUNTDOWN") {
      this.players.delete(conn.id);
      this.inputs.delete(conn.id);
      const live = new Set([...this.room.getConnections()].map((c) => c.id));
      let active = 0;
      for (const id of this.players.keys()) if (live.has(id)) active++;
      if (active < C.MIN_PLAYERS_TO_START) {
        console.log(`[${this.room.id}] auto-ending match — only ${active} active player(s) left`);
        this.endMatch();
      }
    }
  }

  // ---------- Broadcast helpers ----------
  private broadcast(obj: unknown) {
    this.room.broadcast(JSON.stringify(obj));
  }
  private broadcastPeers() {
    this.broadcast({ t: "PEERS", peers: this.peers(), phase: this.phase });
  }

  // ---------- Match flow ----------
  private startMatch() {
    if (this.phase !== "WAITING") return;
    const peers = this.peers();
    if (peers.length < C.MIN_PLAYERS_TO_START) return;

    this.tick = 0;
    this.nextBulletId = 1;
    this.nextMissileId = 1;
    this.players.clear();
    this.inputs.clear();
    this.bullets = [];
    this.missiles = [];
    // Generate the asteroid field once per match. Static positions —
    // shared identically to every client via MATCH_START so cover is
    // honest for everyone.
    this.asteroids = [];
    for (let i = 0; i < C.ASTEROID_COUNT; i++) {
      const r = Math.cbrt(Math.random()) * C.ASTEROID_FIELD_R;
      const t = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      this.asteroids.push({
        pos: {
          x: r * Math.sin(phi) * Math.cos(t),
          y: r * Math.sin(phi) * Math.sin(t) * 0.4,   // flatten the field vertically
          z: r * Math.cos(phi),
        },
        radius: C.ASTEROID_MIN_RADIUS + Math.random() * (C.ASTEROID_MAX_RADIUS - C.ASTEROID_MIN_RADIUS),
      });
    }
    this.hitEventBuf = [];
    this.fireEventBuf = [];
    this.killEventBuf = [];
    this.respawnEventBuf = [];

    for (const p of peers) {
      const spawn = randomSpawn();
      this.players.set(p.id, {
        id: p.id,
        callsign: p.callsign,
        color: p.color,
        pos: spawn.pos,
        vel: { x: 0, y: 0, z: 0 },
        quat: spawn.quat,
        hull: C.SHIP_HULL,
        shield: C.SHIP_SHIELD,
        energy: C.SHIP_ENERGY,
        fireCD: 0,
        weapon: 0,
        missileAmmo: C.MISSILE_AMMO_MAX,
        alive: true,
        respawnAtTick: 0,
        invulnUntilTick: this.tick + Math.floor(C.RESPAWN_INVULN_S * C.SERVER_TICK_HZ),
        asteroidHitCd: 0,
        kills: 0,
        deaths: 0,
        score: 0,
      });
    }

    this.phase = "COUNTDOWN";
    this.countdownEndsAt = Date.now() + C.COUNTDOWN_S * 1000;
    this.matchEndsAt = this.countdownEndsAt + C.MATCH_DURATION_S * 1000;

    this.broadcast({
      t: "MATCH_START",
      countdownEndsAt: this.countdownEndsAt,
      matchEndsAt: this.matchEndsAt,
      killLimit: C.MATCH_KILL_LIMIT,
      players: [...this.players.values()].map((p) => this.playerProfile(p)),
      asteroids: this.asteroids,
    });

    this.simTimer  = setInterval(() => this.tickSim(),  Math.round(1000 / C.SERVER_TICK_HZ));
    this.snapTimer = setInterval(() => this.sendSnapshot(), Math.round(1000 / C.SNAPSHOT_HZ));
  }

  private endMatch() {
    if (this.phase === "END" || this.phase === "WAITING") return;
    this.phase = "END";
    if (this.simTimer)  { clearInterval(this.simTimer);  this.simTimer = null; }
    if (this.snapTimer) { clearInterval(this.snapTimer); this.snapTimer = null; }
    this.postEndsAt = Date.now() + C.POSTMATCH_S * 1000;
    const scores = [...this.players.values()]
      .map((p) => ({ id: p.id, callsign: p.callsign, color: p.color, kills: p.kills, deaths: p.deaths, score: p.score }))
      .sort((a, b) => b.kills - a.kills || b.score - a.score || a.deaths - b.deaths);
    const winner = scores[0]?.id ?? null;
    this.broadcast({ t: "MATCH_END", scores, winner, postEndsAt: this.postEndsAt });
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = setTimeout(() => this.resetToLobby(), C.POSTMATCH_S * 1000);
  }

  private resetToLobby() {
    this.phase = "WAITING";
    this.players.clear();
    this.inputs.clear();
    this.bullets = [];
    this.broadcast({ t: "LOBBY", peers: this.peers() });
  }

  private fullReset() {
    if (this.simTimer)  { clearInterval(this.simTimer);  this.simTimer = null; }
    if (this.snapTimer) { clearInterval(this.snapTimer); this.snapTimer = null; }
    if (this.phaseTimer) { clearTimeout(this.phaseTimer); this.phaseTimer = null; }
    this.phase = "WAITING";
    this.players.clear();
    this.inputs.clear();
    this.bullets = [];
  }

  // ---------- Simulation ----------
  private acceptInput(playerId: string, msg: InputMsg) {
    if (!this.players.has(playerId)) return; // not in match (lobby spectator)
    let cur = this.inputs.get(playerId);
    if (!cur) {
      cur = {
        yawDelta: 0, pitchDelta: 0, rollDelta: 0,
        thrustX: 0, thrustZ: 0,
        boost: false, brake: false,
        weapon: 0, fire: false,
        targetId: null,
        lastSeq: -1, clientTime: 0,
      };
      this.inputs.set(playerId, cur);
    }
    // Rotation deltas are CUMULATIVE — server zeros them after each tick.
    // Drop bursts that would overshoot a sane rotation budget per message
    // (~half a rev) so a flooded message can't spin the ship.
    const ROT_CAP = Math.PI;
    cur.yawDelta   += clamp(sanitizeNum(msg.yawDelta),   -ROT_CAP, ROT_CAP);
    cur.pitchDelta += clamp(sanitizeNum(msg.pitchDelta), -ROT_CAP, ROT_CAP);
    cur.rollDelta  += clamp(sanitizeNum(msg.rollDelta),  -ROT_CAP, ROT_CAP);
    cur.thrustX = clamp(sanitizeNum(msg.thrustX), -1, 1);
    cur.thrustZ = clamp(sanitizeNum(msg.thrustZ), -1, 1);
    cur.boost   = !!msg.boost;
    cur.brake   = !!msg.brake;
    cur.fire    = !!msg.fire;
    const w = Math.floor(sanitizeNum(msg.weapon));
    cur.weapon = w >= 0 && w < C.WEAPONS.length ? w : 0;
    cur.targetId = (typeof msg.targetId === "string" && msg.targetId.length <= 64) ? msg.targetId : null;
    cur.lastSeq = sanitizeNum(msg.seq, cur.lastSeq);
    cur.clientTime = sanitizeNum(msg.clientTime, cur.clientTime);
  }

  private tickSim() {
    const now = Date.now();

    // Phase transitions
    if (this.phase === "COUNTDOWN" && now >= this.countdownEndsAt) {
      this.phase = "MATCH";
    }
    if (this.phase === "MATCH" && now >= this.matchEndsAt) {
      this.endMatch();
      return;
    }
    if (this.phase !== "MATCH") return; // freeze during countdown / end

    const dt = 1 / C.SERVER_TICK_HZ;

    // ---- Per-player update ----
    for (const ps of this.players.values()) {
      if (!ps.alive) {
        if (this.tick >= ps.respawnAtTick) this.respawn(ps);
        continue;
      }
      const inp = this.inputs.get(ps.id);
      stepShip(
        ps,
        inp || {
          yawDelta: 0, pitchDelta: 0, rollDelta: 0,
          thrustX: 0, thrustZ: 0,
          boost: false, brake: false,
        },
        dt
      );
      if (inp) {
        // Zero rotation deltas after one tick of consumption so they don't
        // re-apply if the next input arrives late.
        inp.yawDelta = 0;
        inp.pitchDelta = 0;
        inp.rollDelta = 0;
      }
      // Combat zone enforcement.
      const zoneState = applyZone(ps, dt);
      if (zoneState === "critical") {
        this.applyDamage(ps, C.ZONE_DAMAGE_DPS * dt, null, -1);
      }
      if (!ps.alive) continue;

      // Asteroid collision — same model as single-player: a cooldown
      // prevents tick-stacked damage, and the ship is shoved outward.
      ps.asteroidHitCd = Math.max(0, ps.asteroidHitCd - dt);
      for (const a of this.asteroids) {
        const dx = ps.pos.x - a.pos.x;
        const dy = ps.pos.y - a.pos.y;
        const dz = ps.pos.z - a.pos.z;
        const minDist = a.radius + C.SHIP_HIT_RADIUS;
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq < minDist * minDist) {
          if (ps.asteroidHitCd <= 0) {
            this.applyDamage(ps, C.ASTEROID_DAMAGE, null, -1);
            ps.asteroidHitCd = C.ASTEROID_HIT_CD_S;
          }
          const d = Math.sqrt(dSq) || 1;
          const push = 30;
          ps.vel.x += (dx / d) * push * dt;
          ps.vel.y += (dy / d) * push * dt;
          ps.vel.z += (dz / d) * push * dt;
          if (!ps.alive) break;
        }
      }
      if (!ps.alive) continue;

      // System regen.
      ps.shield = Math.min(C.SHIP_SHIELD, ps.shield + C.SHIP_SHIELD_REGEN * dt);
      ps.energy = Math.min(C.SHIP_ENERGY, ps.energy + C.SHIP_ENERGY_REGEN * dt);
      ps.fireCD = Math.max(0, ps.fireCD - dt);

      // Fire
      if (inp && inp.fire && ps.fireCD <= 0) {
        const w = C.WEAPONS[inp.weapon] ?? C.WEAPONS[0];
        if (w && w.isMissile) {
          // Missile: needs ammo + a still-alive locked target. Lock isn't
          // strictly required (we'll fire a dumb dud if absent), but for
          // PvP we mandate it so missiles aren't a free spam weapon.
          const tgt = inp.targetId ? this.players.get(inp.targetId) : null;
          const validTarget = tgt && tgt.id !== ps.id && tgt.alive;
          if (ps.missileAmmo > 0 && validTarget) {
            ps.missileAmmo--;
            ps.fireCD = w.cooldown;
            ps.weapon = inp.weapon;
            this.spawnMissile(ps, w, inp.weapon, inp.targetId);
          }
        } else if (w && ps.energy >= w.energy) {
          ps.energy -= w.energy;
          ps.fireCD = w.cooldown;
          ps.weapon = inp.weapon;
          this.spawnBullets(ps, w, inp.weapon);
        }
      }
    }

    // ---- Bullet propagation + hit detection ----
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.pos.z += b.vel.z * dt;
      b.ttl -= dt;

      let consumed = false;
      // Asteroid block — projectiles can't punch through cover.
      for (const a of this.asteroids) {
        const dx = a.pos.x - b.pos.x;
        const dy = a.pos.y - b.pos.y;
        const dz = a.pos.z - b.pos.z;
        if (dx * dx + dy * dy + dz * dz < a.radius * a.radius) {
          consumed = true;
          break;
        }
      }
      if (!consumed) {
        for (const ps of this.players.values()) {
          if (ps.id === b.owner || !ps.alive) continue;
          if (this.tick < ps.invulnUntilTick) continue;
          const dx = ps.pos.x - b.pos.x;
          const dy = ps.pos.y - b.pos.y;
          const dz = ps.pos.z - b.pos.z;
          const r = C.SHIP_HIT_RADIUS + C.BULLET_HIT_RADIUS;
          if (dx * dx + dy * dy + dz * dz < r * r) {
            this.hitEventBuf.push({ shooter: b.owner, victim: ps.id, weapon: b.weapon, pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z } });
            this.applyDamage(ps, b.damage, b.owner, b.weapon);
            consumed = true;
            break;
          }
        }
      }
      if (consumed || b.ttl <= 0) {
        this.bullets.splice(i, 1);
      }
    }

    // ---- Missiles ----
    this.tickMissiles(dt);

    this.tick++;
  }

  private tickMissiles(dt: number) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.ttl -= dt;
      // Re-validate the target. If gone/dead, missile goes ballistic
      // along its current heading.
      const tgt = m.targetId ? this.players.get(m.targetId) : null;
      const targetValid = !!tgt && tgt.alive;
      const w = C.WEAPONS[2];
      const accel = w.accel ?? 320;
      const maxSpeed = w.projSpeed;
      const turn = w.turnRate ?? 5.0;
      if (targetValid) {
        // Steer velocity toward the lead-predicted intercept point.
        const target = tgt!;
        // Iterative lead prediction (same algo as client lead indicator).
        let aimX = target.pos.x, aimY = target.pos.y, aimZ = target.pos.z;
        for (let k = 0; k < 3; k++) {
          const dx = aimX - m.pos.x, dy = aimY - m.pos.y, dz = aimZ - m.pos.z;
          const td = Math.hypot(dx, dy, dz) / maxSpeed;
          aimX = target.pos.x + target.vel.x * td;
          aimY = target.pos.y + target.vel.y * td;
          aimZ = target.pos.z + target.vel.z * td;
        }
        const dx = aimX - m.pos.x, dy = aimY - m.pos.y, dz = aimZ - m.pos.z;
        const dl = Math.hypot(dx, dy, dz) || 1;
        const desiredX = dx / dl, desiredY = dy / dl, desiredZ = dz / dl;
        // Blend velocity direction toward desired by turn * dt.
        const vlen = Math.hypot(m.vel.x, m.vel.y, m.vel.z) || 1;
        const cx = m.vel.x / vlen, cy = m.vel.y / vlen, cz = m.vel.z / vlen;
        const a = Math.min(1, turn * dt);
        const nx = cx + (desiredX - cx) * a;
        const ny = cy + (desiredY - cy) * a;
        const nz = cz + (desiredZ - cz) * a;
        const nlen = Math.hypot(nx, ny, nz) || 1;
        const speed = Math.min(maxSpeed, vlen + accel * dt);
        m.vel.x = (nx / nlen) * speed;
        m.vel.y = (ny / nlen) * speed;
        m.vel.z = (nz / nlen) * speed;
      } else {
        // Coast: accelerate along current heading, clamped.
        const vlen = Math.hypot(m.vel.x, m.vel.y, m.vel.z) || 1;
        const speed = Math.min(maxSpeed, vlen + accel * dt);
        m.vel.x = (m.vel.x / vlen) * speed;
        m.vel.y = (m.vel.y / vlen) * speed;
        m.vel.z = (m.vel.z / vlen) * speed;
      }
      m.pos.x += m.vel.x * dt;
      m.pos.y += m.vel.y * dt;
      m.pos.z += m.vel.z * dt;
      // Update quaternion so the client can render the missile pointed
      // along its trajectory.
      const vlen = Math.hypot(m.vel.x, m.vel.y, m.vel.z) || 1;
      const fx = m.vel.x / vlen, fy = m.vel.y / vlen, fz = m.vel.z / vlen;
      // Quaternion from (0,0,-1) to (fx,fy,fz)
      const dotF = -fz;                  // (0,0,-1) · (fx,fy,fz)
      const ang  = Math.acos(Math.max(-1, Math.min(1, dotF)));
      let axX = -fy, axY = fx, axZ = 0;  // cross((0,0,-1),(fx,fy,fz))
      const axLen = Math.hypot(axX, axY, axZ);
      if (axLen > 1e-5) {
        axX /= axLen; axY /= axLen; axZ /= axLen;
        const s = Math.sin(ang * 0.5);
        m.quat.x = axX * s;
        m.quat.y = axY * s;
        m.quat.z = axZ * s;
        m.quat.w = Math.cos(ang * 0.5);
      }
      // Hit detection: asteroids first (explode on contact), then ships.
      let hit = false;
      for (const a of this.asteroids) {
        const dx = a.pos.x - m.pos.x;
        const dy = a.pos.y - m.pos.y;
        const dz = a.pos.z - m.pos.z;
        if (dx * dx + dy * dy + dz * dz < (a.radius + C.MISSILE_HIT_RADIUS) * (a.radius + C.MISSILE_HIT_RADIUS)) {
          this.hitEventBuf.push({ shooter: m.owner, victim: m.owner, weapon: 2, pos: { x: m.pos.x, y: m.pos.y, z: m.pos.z } });
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const ps of this.players.values()) {
          if (ps.id === m.owner || !ps.alive) continue;
          if (this.tick < ps.invulnUntilTick) continue;
          const dx = ps.pos.x - m.pos.x, dy = ps.pos.y - m.pos.y, dz = ps.pos.z - m.pos.z;
          const r = C.SHIP_HIT_RADIUS + C.MISSILE_HIT_RADIUS;
          if (dx * dx + dy * dy + dz * dz < r * r) {
            this.hitEventBuf.push({ shooter: m.owner, victim: ps.id, weapon: 2, pos: { x: m.pos.x, y: m.pos.y, z: m.pos.z } });
            this.applyDamage(ps, m.damage, m.owner, 2);
            hit = true;
            break;
          }
        }
      }
      if (hit || m.ttl <= 0) {
        this.missiles.splice(i, 1);
      }
    }
  }

  private spawnMissile(ps: PlayerState, w: typeof C.WEAPONS[number], weaponIdx: number, targetId: string | null) {
    const fwd: Vec3 = { x: 0, y: 0, z: 0 };
    forwardFromQuat(fwd, ps.quat);
    const launchSpeed = 120; // starts slow, accelerates while homing
    const m: Missile = {
      id: this.nextMissileId++,
      owner: ps.id,
      targetId,
      pos: { x: ps.pos.x, y: ps.pos.y, z: ps.pos.z },
      vel: { x: ps.vel.x + fwd.x * launchSpeed, y: ps.vel.y + fwd.y * launchSpeed, z: ps.vel.z + fwd.z * launchSpeed },
      quat: { x: ps.quat.x, y: ps.quat.y, z: ps.quat.z, w: ps.quat.w },
      damage: w.damage,
      ttl: w.ttl,
    };
    this.missiles.push(m);
    this.fireEventBuf.push({ shooter: ps.id, weapon: weaponIdx, pos: { x: ps.pos.x, y: ps.pos.y, z: ps.pos.z } });
  }

  private spawnBullets(ps: PlayerState, w: typeof C.WEAPONS[number], weaponIdx: number) {
    const fwd: Vec3 = { x: 0, y: 0, z: 0 };
    forwardFromQuat(fwd, ps.quat);
    const right: Vec3 = { x: 0, y: 0, z: 0 };
    rightFromQuat(right, ps.quat);
    // Bullet velocity is pure projSpeed along forward — we deliberately
    // do NOT inherit the shooter's velocity, so the client-side lead
    // indicator (which assumes projSpeed) stays accurate. Same model as
    // single-player.
    const v = w.projSpeed;
    const baseVx = fwd.x * v;
    const baseVy = fwd.y * v;
    const baseVz = fwd.z * v;
    const positions: Vec3[] = w.dual
      ? [
          { x: ps.pos.x + right.x * 0.7, y: ps.pos.y + right.y * 0.7, z: ps.pos.z + right.z * 0.7 },
          { x: ps.pos.x - right.x * 0.7, y: ps.pos.y - right.y * 0.7, z: ps.pos.z - right.z * 0.7 },
        ]
      : [{ x: ps.pos.x, y: ps.pos.y, z: ps.pos.z }];
    for (const p of positions) {
      this.bullets.push({
        id: this.nextBulletId++,
        owner: ps.id,
        pos: p,
        vel: { x: baseVx, y: baseVy, z: baseVz },
        damage: w.damage,
        ttl: w.ttl,
        weapon: weaponIdx,
      });
    }
    this.fireEventBuf.push({ shooter: ps.id, weapon: weaponIdx, pos: { x: ps.pos.x, y: ps.pos.y, z: ps.pos.z } });
  }

  private applyDamage(victim: PlayerState, amount: number, shooterId: string | null, weapon: number) {
    if (!victim.alive) return;
    let remaining = amount;
    if (victim.shield > 0) {
      const absorb = Math.min(victim.shield, remaining);
      victim.shield -= absorb;
      remaining -= absorb;
    }
    if (remaining > 0) victim.hull -= remaining;
    if (victim.hull <= 0) {
      victim.hull = 0;
      victim.alive = false;
      victim.deaths++;
      victim.respawnAtTick = this.tick + Math.floor(C.RESPAWN_DELAY_S * C.SERVER_TICK_HZ);
      if (shooterId && shooterId !== victim.id) {
        const k = this.players.get(shooterId);
        if (k) {
          k.kills++;
          k.score += 100;
        }
      }
      this.killEventBuf.push({ killer: shooterId, victim: victim.id, weapon });
      // Kill-limit win condition.
      for (const ps of this.players.values()) {
        if (ps.kills >= C.MATCH_KILL_LIMIT) {
          this.endMatch();
          return;
        }
      }
    }
  }

  private respawn(ps: PlayerState) {
    const spawn = randomSpawn();
    ps.pos = spawn.pos;
    ps.vel = { x: 0, y: 0, z: 0 };
    ps.quat = spawn.quat;
    ps.hull = C.SHIP_HULL;
    ps.shield = C.SHIP_SHIELD;
    ps.energy = C.SHIP_ENERGY;
    ps.missileAmmo = C.MISSILE_AMMO_MAX;
    ps.fireCD = 0;
    ps.alive = true;
    ps.invulnUntilTick = this.tick + Math.floor(C.RESPAWN_INVULN_S * C.SERVER_TICK_HZ);
    this.respawnEventBuf.push({ id: ps.id, pos: ps.pos, quat: ps.quat, invulnUntilTick: ps.invulnUntilTick });
  }

  private playerProfile(p: PlayerState) {
    return { id: p.id, callsign: p.callsign, color: p.color };
  }

  // ---------- Snapshot ----------
  private sendSnapshot() {
    if (this.phase !== "MATCH" && this.phase !== "COUNTDOWN") return;
    const snap = {
      t: "SNAPSHOT",
      phase: this.phase,
      tick: this.tick,
      time: Date.now(),
      countdownEndsAt: this.phase === "COUNTDOWN" ? this.countdownEndsAt : null,
      matchEndsAt: this.phase === "MATCH" ? this.matchEndsAt : null,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        pos: p.pos,
        vel: p.vel,
        quat: p.quat,
        hull: p.hull,
        shield: p.shield,
        energy: p.energy,
        missileAmmo: p.missileAmmo,
        alive: p.alive,
        invulnUntilTick: p.invulnUntilTick,
        kills: p.kills,
        deaths: p.deaths,
        score: p.score,
        // Last input seq the server has applied — lets the client
        // reconcile its predicted state without re-applying acked inputs.
        ackSeq: this.inputs.get(p.id)?.lastSeq ?? -1,
      })),
      bullets: this.bullets.map((b) => ({
        id: b.id,
        owner: b.owner,
        pos: b.pos,
        vel: b.vel,
        weapon: b.weapon,
      })),
      missiles: this.missiles.map((m) => ({
        id: m.id,
        owner: m.owner,
        targetId: m.targetId,
        pos: m.pos,
        vel: m.vel,
        quat: m.quat,
      })),
      fires: this.fireEventBuf,
      hits: this.hitEventBuf,
      kills: this.killEventBuf,
      respawns: this.respawnEventBuf,
    };
    this.broadcast(snap);
    // Event buffers are one-shot — clear after the snapshot ships.
    this.fireEventBuf = [];
    this.hitEventBuf = [];
    this.killEventBuf = [];
    this.respawnEventBuf = [];
  }
}

SpaceWarRoom satisfies Party.Worker;
