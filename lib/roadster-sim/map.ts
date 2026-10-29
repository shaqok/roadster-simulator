import { MAP_HALF_SIZE } from "./bounds";
import { MAGOK_NETWORK, createMagokBuildings } from "./magok";
import { JUMP_RAMP_COUNT, placeJumpRamps, rampLocal, rampZone, type Ramp } from "./ramps";
import type { ClosedZone } from "./roads";
import { normalize, vec, type Vec3 } from "./vec";
import { buildingHeightAt, type BuildingIndex } from "./world";

export { MAP_HALF_SIZE };
export type { Ramp };

/**
 * A vehicle that can be driven onto from above but not through. `heading` turns its length (`sizeZ`)
 * away from +z; parked cars leave it out.
 */
export type Obstacle = {
  x: number;
  z: number;
  sizeX: number;
  sizeZ: number;
  height: number;
  heading?: number;
};

/** A parked vehicle that can be shoved: it slides in a straight line and is slowed by friction. */
export type ObstacleState = Obstacle & { vx: number; vz: number };

/**
 * Everything solid that the ground height and collisions depend on. Parked cars slide when shoved;
 * traffic cars keep to their own path whatever hits them.
 */
export type Solids = {
  obstacles: readonly Obstacle[];
  traffic?: readonly ObstacleState[];
  buildings: BuildingIndex;
};

export function createObstacles(): ObstacleState[] {
  return OBSTACLES.map((o) => ({ ...o, vx: 0, vz: 0 }));
}

const START_RAMP: Ramp = { x: 0, z0: 40, length: 20, width: 9, height: 4 };

/** The ramp in front of the start, then jump ramps spread along the roads. */
export const RAMPS: readonly Ramp[] = [
  START_RAMP,
  ...placeJumpRamps(MAGOK_NETWORK, createMagokBuildings(), [START_RAMP], JUMP_RAMP_COUNT),
];

export const PARKED_CAR = { sizeX: 2, sizeZ: 4.5, height: 1.5 };

/** Five parked vehicles end to end, straight beyond the ramp. */
export const OBSTACLES: readonly Obstacle[] = Array.from({ length: 5 }, (_, i) => ({
  x: 0,
  z: 80 + i * 5,
  ...PARKED_CAR,
}));

/** Traffic keeps off the start stretch (behind the car, the ramp and the parked cars) and off every ramp. */
const START_ZONE: ClosedZone = { x: 0, z: 0, heading: 0, from: -12, to: 110, halfWidth: 7.5 };
export const CLOSED_ZONES: readonly ClosedZone[] = [START_ZONE, ...RAMPS.map(rampZone)];

function rampAt(x: number, z: number) {
  for (const ramp of RAMPS) {
    const local = rampLocal(ramp, x, z);
    if (local && Math.abs(local.across) <= ramp.width / 2 && local.along >= 0 && local.along <= ramp.length) {
      return { ramp, along: local.along };
    }
  }
  return undefined;
}

export function rampHeightAt(x: number, z: number): number {
  let height = 0;
  for (const ramp of RAMPS) {
    const local = rampLocal(ramp, x, z);
    if (local && Math.abs(local.across) <= ramp.width / 2 && local.along >= 0 && local.along <= ramp.length) {
      height = Math.max(height, (ramp.height * local.along) / ramp.length);
    }
  }
  return height;
}

/** A point in the vehicle's own frame: `across` to one side, `along` its length. */
export function obstacleLocal(o: Obstacle, x: number, z: number): { across: number; along: number } {
  const dx = x - o.x;
  const dz = z - o.z;
  const heading = o.heading ?? 0;
  if (heading === 0) return { across: dx, along: dz };
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  return { across: dx * cos - dz * sin, along: dx * sin + dz * cos };
}

/** Farther than this from a vehicle's center, a point cannot be inside it. */
export const OBSTACLE_REACH = 3;

export function obstacleAt(
  x: number,
  z: number,
  obstacles: readonly Obstacle[]
): Obstacle | undefined {
  return obstacles.find((o) => {
    if (Math.abs(x - o.x) > OBSTACLE_REACH || Math.abs(z - o.z) > OBSTACLE_REACH) return false;
    const { across, along } = obstacleLocal(o, x, z);
    return Math.abs(across) <= o.sizeX / 2 && Math.abs(along) <= o.sizeZ / 2;
  });
}

function solidObstacleAt(x: number, z: number, solids: Solids): Obstacle | undefined {
  return obstacleAt(x, z, solids.obstacles) ?? (solids.traffic && obstacleAt(x, z, solids.traffic));
}

export function groundHeightAt(x: number, z: number, solids: Solids): number {
  return Math.max(
    rampHeightAt(x, z),
    solidObstacleAt(x, z, solids)?.height ?? 0,
    buildingHeightAt(solids.buildings, x, z)
  );
}

export function groundNormalAt(x: number, z: number, solids: Solids): Vec3 {
  if (solidObstacleAt(x, z, solids) || buildingHeightAt(solids.buildings, x, z) > 0) {
    return vec(0, 1, 0);
  }
  const onRamp = rampAt(x, z);
  if (onRamp) {
    const slope = onRamp.ramp.height / onRamp.ramp.length;
    const heading = onRamp.ramp.heading ?? 0;
    return normalize(vec(-slope * Math.sin(heading), 1, -slope * Math.cos(heading)));
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
