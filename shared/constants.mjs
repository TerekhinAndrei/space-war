// SPACE WAR — shared tuning constants.
//
// Loaded by BOTH the PartyKit server and the browser, so both sides
// agree on ship dynamics, weapon stats and match length. Changing a
// number here changes the game on both sides at the same time.

// ----- Combat zone -----
// Same arena radii as the single-player game so the boundary visual,
// pull-back behaviour and radiation distance feel identical across modes.
export const ZONE_RADIUS    = 900;    // soft pull-back kicks in here
export const CRITICAL_ZONE  = 1100;   // radiation damage past this radius
export const ZONE_DECEL     = 40;     // base outward deceleration
export const ZONE_DECEL_K   = 0.6;    // per-unit overshoot scaling
export const ZONE_DAMAGE_DPS = 12;    // hull/sec past the critical sphere

// ----- Ship dynamics -----
export const SHIP_ACCEL          = 70;
export const SHIP_BOOST_MUL      = 2.4;
export const SHIP_MAX_SPEED      = 95;
export const SHIP_DAMPING        = 0.06;  // per-second multiplier
export const SHIP_BRAKE_DAMPING  = 3.5;
export const SHIP_HIT_RADIUS     = 3.2;

// ----- Ship systems -----
export const SHIP_HULL           = 100;
export const SHIP_SHIELD         = 100;
export const SHIP_ENERGY         = 100;
export const SHIP_SHIELD_REGEN   = 8;     // per second
export const SHIP_ENERGY_REGEN   = 25;

// ----- Weapons -----
// Order matches the player.weapon slot indices (0/1/2 keyboard).
export const WEAPONS = [
  { id: 'laser',   cooldown: 0.14, energy: 8, damage: 9,  projSpeed: 280, ttl: 2.4, dual: true,  color: 0x66ffcc, isMissile: false },
  { id: 'pulse',   cooldown: 0.06, energy: 2, damage: 6,  projSpeed: 340, ttl: 2.0, dual: false, color: 0xffee44, isMissile: false },
  { id: 'missile', cooldown: 1.2,  energy: 0, damage: 65, projSpeed: 230, ttl: 5.0, dual: false, color: 0xffaa44, isMissile: true,  needsLock: true, accel: 320, turnRate: 5.0 },
];

// ----- Bullet -----
export const BULLET_HIT_RADIUS = 1.4;

// ----- Missile -----
export const MISSILE_AMMO_MAX  = 6;
export const MISSILE_HIT_RADIUS = 2.4;
export const MISSILE_LOCK_CONE  = 0.7;    // cos(angle) — wider than aim cone for lasers
export const MISSILE_LOCK_RANGE = 600;

// ----- Match flow -----
export const COUNTDOWN_S       = 3;
export const MATCH_DURATION_S  = 180;   // 3 minutes
export const POSTMATCH_S       = 8;
export const RESPAWN_DELAY_S   = 3;
export const RESPAWN_INVULN_S  = 2;
export const MATCH_KILL_LIMIT  = 15;
export const MIN_PLAYERS_TO_START = 2;
export const MAX_PLAYERS_PER_ROOM = 4;

// ----- Network rates -----
export const SERVER_TICK_HZ    = 30;
export const SNAPSHOT_HZ       = 20;
export const CLIENT_INPUT_HZ   = 30;

// ----- Ship colours -----
// Assigned to players in join order; cycles if >4.
export const SHIP_COLORS = ['#00ff66', '#66aaff', '#ffaa44', '#ff66cc'];
