// SPACE WAR — shared ship kinematics.
//
// Pure functions operating on plain {x,y,z} / {x,y,z,w} structs so the
// PartyKit Worker (no Three.js) and the browser (Three.js Vector3 /
// Quaternion are structurally compatible) can BOTH call into them.
// Determinism between the two sides matters for client-side prediction
// (Phase 3); keep these functions free of state and randomness.

import * as C from './constants.mjs';

// Scratch vectors so the hot path doesn't allocate every call.
const _fwd   = { x: 0, y: 0, z: 0 };
const _right = { x: 0, y: 0, z: 0 };
const _q1    = { x: 0, y: 0, z: 0, w: 1 };
const _q2    = { x: 0, y: 0, z: 0, w: 1 };

// out = a * b
export function quatMul(out, a, b) {
  const ax = a.x, ay = a.y, az = a.z, aw = a.w;
  const bx = b.x, by = b.y, bz = b.z, bw = b.w;
  out.x = aw * bx + ax * bw + ay * bz - az * by;
  out.y = aw * by - ax * bz + ay * bw + az * bx;
  out.z = aw * bz + ax * by - ay * bx + az * bw;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
}

// out = q * v (vector rotated by quaternion)
export function quatApply(out, q, v) {
  const x = v.x, y = v.y, z = v.z;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
}

// Rotate `q` in-place by `angle` rad around its local axis (one of 'x','y','z').
// Matches Three.js Object3D.rotateX/Y/Z (right-multiplication).
export function rotateLocal(q, axis, angle) {
  if (!angle) return;
  const h = angle * 0.5;
  const s = Math.sin(h);
  _q1.x = axis === 'x' ? s : 0;
  _q1.y = axis === 'y' ? s : 0;
  _q1.z = axis === 'z' ? s : 0;
  _q1.w = Math.cos(h);
  quatMul(_q2, q, _q1);
  q.x = _q2.x; q.y = _q2.y; q.z = _q2.z; q.w = _q2.w;
}

export function quatNormalize(q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (n > 0) { q.x /= n; q.y /= n; q.z /= n; q.w /= n; }
}

// Mutates `state.pos`, `state.vel`, `state.quat` from an input bundle
// applied over `dt` seconds. Input fields are all optional; missing
// values are treated as zero/false. Returns nothing.
//
// state: { pos:{x,y,z}, vel:{x,y,z}, quat:{x,y,z,w} }
// input: { yawDelta, pitchDelta, rollDelta, thrustX, thrustZ, boost, brake }
//   yaw/pitch/roll Delta are INSTANTANEOUS rotations in radians
//   (the client accumulates them since the last send; the server applies
//   them once per tick). thrustX/Z are normalized [-1,1] axis values.
export function stepShip(state, input, dt) {
  // Local-space rotations — same order Three.js uses: Y (yaw), X (pitch), Z (roll).
  rotateLocal(state.quat, 'y', input.yawDelta   || 0);
  rotateLocal(state.quat, 'x', input.pitchDelta || 0);
  rotateLocal(state.quat, 'z', input.rollDelta  || 0);
  quatNormalize(state.quat);

  // Basis vectors from the new quaternion.
  _fwd.x = 0; _fwd.y = 0; _fwd.z = -1;
  quatApply(_fwd, state.quat, _fwd);
  _right.x = 1; _right.y = 0; _right.z = 0;
  quatApply(_right, state.quat, _right);

  // Thrust → velocity. thrustZ>0 = forward.
  const boost = input.boost ? C.SHIP_BOOST_MUL : 1;
  const accelMag = C.SHIP_ACCEL * boost;
  let ax = _fwd.x * (input.thrustZ || 0) + _right.x * (input.thrustX || 0);
  let ay = _fwd.y * (input.thrustZ || 0) + _right.y * (input.thrustX || 0);
  let az = _fwd.z * (input.thrustZ || 0) + _right.z * (input.thrustX || 0);
  const aMagSq = ax * ax + ay * ay + az * az;
  if (aMagSq > 1) {
    const inv = 1 / Math.sqrt(aMagSq);
    ax *= inv; ay *= inv; az *= inv;
  }
  if (aMagSq > 0) {
    const f = accelMag * dt;
    state.vel.x += ax * f;
    state.vel.y += ay * f;
    state.vel.z += az * f;
  }

  // Damping (brake amplifies it dramatically).
  const damp = input.brake ? C.SHIP_BRAKE_DAMPING : C.SHIP_DAMPING;
  const dampMul = Math.max(0, 1 - damp * dt);
  state.vel.x *= dampMul;
  state.vel.y *= dampMul;
  state.vel.z *= dampMul;

  // Cap speed.
  const maxSpeed = C.SHIP_MAX_SPEED * boost;
  const speedSq = state.vel.x * state.vel.x + state.vel.y * state.vel.y + state.vel.z * state.vel.z;
  if (speedSq > maxSpeed * maxSpeed) {
    const k = maxSpeed / Math.sqrt(speedSq);
    state.vel.x *= k; state.vel.y *= k; state.vel.z *= k;
  }

  // Integrate position.
  state.pos.x += state.vel.x * dt;
  state.pos.y += state.vel.y * dt;
  state.pos.z += state.vel.z * dt;
}

// Soft pull-back inside the combat zone. Returns 'critical' if the
// ship is past the radiation sphere (caller applies damage).
export function applyZone(state, dt) {
  const dx = state.pos.x, dy = state.pos.y, dz = state.pos.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist <= C.ZONE_RADIUS) return 'inside';
  // Reduce outward velocity component.
  const inv = 1 / dist;
  const nx = dx * inv, ny = dy * inv, nz = dz * inv;
  const outwardComp = state.vel.x * nx + state.vel.y * ny + state.vel.z * nz;
  if (outwardComp > 0) {
    const overshoot = dist - C.ZONE_RADIUS;
    const decel = C.ZONE_DECEL + overshoot * C.ZONE_DECEL_K;
    const reduction = Math.min(outwardComp, decel * dt);
    state.vel.x -= nx * reduction;
    state.vel.y -= ny * reduction;
    state.vel.z -= nz * reduction;
  }
  return dist > C.CRITICAL_ZONE ? 'critical' : 'edge';
}

// Build a forward unit vector from a quat (allocation-free if `out` is provided).
export function forwardFromQuat(out, q) {
  out.x = 0; out.y = 0; out.z = -1;
  quatApply(out, q, out);
  return out;
}

// Build a right unit vector from a quat.
export function rightFromQuat(out, q) {
  out.x = 1; out.y = 0; out.z = 0;
  quatApply(out, q, out);
  return out;
}
