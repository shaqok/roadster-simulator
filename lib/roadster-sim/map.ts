import { normalize, vec, type Vec3 } from "./vec";

/** Half-size of the playable square, in meters. Beyond it the car is lost. */
export const MAP_HALF_SIZE = 400;

/** Ramp rising along +z from `z0`, `length` long, `height` tall at its far edge, then a sheer drop. */
export type Ramp = { x: number; z0: number; length: number; width: number; height: number };

/** Axis-aligned parked vehicle that can be driven onto from above but not through. */
export type Obstacle = { x: number; z: number; sizeX: number; sizeZ: number; height: number };

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

export function obstacleAt(x: number, z: number): Obstacle | undefined {
  return OBSTACLES.find(
    (o) => Math.abs(x - o.x) <= o.sizeX / 2 && Math.abs(z - o.z) <= o.sizeZ / 2
  );
}

export function groundHeightAt(x: number, z: number): number {
  return Math.max(rampHeightAt(x, z), obstacleAt(x, z)?.height ?? 0);
}

export function groundNormalAt(x: number, z: number): Vec3 {
  if (obstacleAt(x, z)) return vec(0, 1, 0);
  for (const ramp of RAMPS) {
    if (Math.abs(x - ramp.x) <= ramp.width / 2 && z >= ramp.z0 && z <= ramp.z0 + ramp.length) {
      return normalize(vec(0, 1, -ramp.height / ramp.length));
    }
  }
  return vec(0, 1, 0);
}
