import { normalize, vec, type Vec3 } from "./vec";
import { buildingHeightAt, type BuildingIndex } from "./world";

/** Half-size of the playable square, in meters. Beyond it the car is lost. */
export const MAP_HALF_SIZE = 700;

/** Ramp rising along +z from `z0`, `length` long, `height` tall at its far edge, then a sheer drop. */
export type Ramp = { x: number; z0: number; length: number; width: number; height: number };

/** Axis-aligned parked vehicle that can be driven onto from above but not through. */
export type Obstacle = { x: number; z: number; sizeX: number; sizeZ: number; height: number };

/** A parked vehicle that can be shoved: it slides in a straight line and is slowed by friction. */
export type ObstacleState = Obstacle & { vx: number; vz: number };

/** Everything solid that the ground height and collisions depend on. */
export type Solids = { obstacles: readonly Obstacle[]; buildings: BuildingIndex };

export function createObstacles(): ObstacleState[] {
  return OBSTACLES.map((o) => ({ ...o, vx: 0, vz: 0 }));
}

export const RAMPS: readonly Ramp[] = [
  { x: 0, z0: 40, length: 20, width: 9, height: 4 },
];

const PARKED_CAR = { sizeX: 2, sizeZ: 4.5, height: 1.5 };

/** Five parked vehicles end to end, straight beyond the ramp. */
export const OBSTACLES: readonly Obstacle[] = Array.from({ length: 5 }, (_, i) => ({
  x: 0,
  z: 80 + i * 5,
  ...PARKED_CAR,
}));

export function rampHeightAt(x: number, z: number): number {
  let height = 0;
  for (const ramp of RAMPS) {
    if (Math.abs(x - ramp.x) <= ramp.width / 2 && z >= ramp.z0 && z <= ramp.z0 + ramp.length) {
      height = Math.max(height, (ramp.height * (z - ramp.z0)) / ramp.length);
    }
  }
  return height;
}

export function obstacleAt(
  x: number,
  z: number,
  obstacles: readonly Obstacle[]
): Obstacle | undefined {
  return obstacles.find(
    (o) => Math.abs(x - o.x) <= o.sizeX / 2 && Math.abs(z - o.z) <= o.sizeZ / 2
  );
}

export function groundHeightAt(x: number, z: number, solids: Solids): number {
  return Math.max(
    rampHeightAt(x, z),
    obstacleAt(x, z, solids.obstacles)?.height ?? 0,
    buildingHeightAt(solids.buildings, x, z)
  );
}

export function groundNormalAt(x: number, z: number, solids: Solids): Vec3 {
  if (obstacleAt(x, z, solids.obstacles) || buildingHeightAt(solids.buildings, x, z) > 0) {
    return vec(0, 1, 0);
  }
  for (const ramp of RAMPS) {
    if (Math.abs(x - ramp.x) <= ramp.width / 2 && z >= ramp.z0 && z <= ramp.z0 + ramp.length) {
      return normalize(vec(0, 1, -ramp.height / ramp.length));
    }
  }
  return vec(0, 1, 0);
}

const OBSTACLE_FRICTION_DECELERATION = 4;
const OBSTACLE_BOUNCE = 0.1;

/** Slides every shoved vehicle, slows it with ground friction and keeps neighbors from overlapping. */
export function advanceObstacles(obstacles: readonly ObstacleState[], dt: number): ObstacleState[] {
  const next = obstacles.map((o) => {
    const speed = Math.hypot(o.vx, o.vz);
    const slowed = speed > 0 ? Math.max(0, speed - OBSTACLE_FRICTION_DECELERATION * dt) / speed : 0;
    const vx = o.vx * slowed;
    const vz = o.vz * slowed;
    return { ...o, vx, vz, x: o.x + vx * dt, z: o.z + vz * dt };
  });

  for (let i = 0; i < next.length; i++) {
    for (let j = i + 1; j < next.length; j++) {
      const a = next[i];
      const b = next[j];
      const overlapX = (a.sizeX + b.sizeX) / 2 - Math.abs(a.x - b.x);
      const overlapZ = (a.sizeZ + b.sizeZ) / 2 - Math.abs(a.z - b.z);
      if (overlapX <= 0 || overlapZ <= 0) continue;

      const alongX = overlapX < overlapZ;
      const direction = Math.sign(alongX ? a.x - b.x : a.z - b.z) || 1;
      const push = (alongX ? overlapX : overlapZ) / 2;
      const closing = alongX ? (b.vx - a.vx) * direction : (b.vz - a.vz) * direction;
      const exchange = closing > 0 ? ((1 + OBSTACLE_BOUNCE) * closing) / 2 : 0;
      if (alongX) {
        a.x += direction * push;
        b.x -= direction * push;
        a.vx += direction * exchange;
        b.vx -= direction * exchange;
      } else {
        a.z += direction * push;
        b.z -= direction * push;
        a.vz += direction * exchange;
        b.vz -= direction * exchange;
      }
    }
  }
  return next;
}
