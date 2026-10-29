export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

export const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const scale = (a: Vec3, s: number): Vec3 => vec(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a.x, a.y, a.z);
  return length === 0 ? vec(0, 0, 0) : scale(a, 1 / length);
}

export const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatNormalize(q: Quat): Quat {
  const length = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

/** Rotation of `angle` radians about a local axis, to be post-multiplied onto an orientation. */
export function quatFromRotationVector(rv: Vec3): Quat {
  const angle = Math.hypot(rv.x, rv.y, rv.z);
  if (angle < 1e-9) return IDENTITY;
  const s = Math.sin(angle / 2) / angle;
  return { x: rv.x * s, y: rv.y * s, z: rv.z * s, w: Math.cos(angle / 2) };
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  const u = vec(q.x, q.y, q.z);
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q.w)), cross(u, t));
}

/** Shortest-arc normalized lerp; `t` is clamped to [0, 1]. */
export function quatNlerp(a: Quat, b: Quat, t: number): Quat {
  const k = Math.min(1, Math.max(0, t));
  const sign = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  return quatNormalize({
    x: a.x + (b.x * sign - a.x) * k,
    y: a.y + (b.y * sign - a.y) * k,
    z: a.z + (b.z * sign - a.z) * k,
    w: a.w + (b.w * sign - a.w) * k,
  });
}

/** Orientation whose local axes are x = left, y = up, z = forward (unit, mutually perpendicular). */
export function quatFromAxes(left: Vec3, up: Vec3, forward: Vec3): Quat {
  const m00 = left.x, m01 = up.x, m02 = forward.x;
  const m10 = left.y, m11 = up.y, m12 = forward.y;
  const m20 = left.z, m21 = up.z, m22 = forward.z;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return quatNormalize({ w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s });
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return quatNormalize({ w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s });
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return quatNormalize({ w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s });
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return quatNormalize({ w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 });
}

export const sub = (a: Vec3, b: Vec3): Vec3 => vec(a.x - b.x, a.y - b.y, a.z - b.z);

export const quatConjugate = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
