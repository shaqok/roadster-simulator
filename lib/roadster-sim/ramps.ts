import { MAP_HALF_SIZE } from "./bounds";
import { sampleEdge, type ClosedZone, type RoadEdge, type RoadNetwork } from "./roads";
import { buildingHeightAt, type BuildingIndex } from "./world";

/**
 * Ramp rising along its heading from the start point (`x`, `z0`), `length` long, `height` tall at its
 * far edge, then a sheer drop. `heading` is the yaw of the rising direction; 0 rises along +z.
 */
export type Ramp = {
  x: number;
  z0: number;
  length: number;
  width: number;
  height: number;
  heading?: number;
};

export const RAMP_LENGTH = 20;
export const RAMP_WIDTH = 9;
export const RAMP_HEIGHT = 4;
export const JUMP_RAMP_COUNT = 10;

/** Straight, clear road a jump needs: run-up before the ramp, landing road after it. */
const RUN_UP = 30;
const LANDING = 45;
const STEP = 25;
const MIN_SPACING = 150;
const STRAIGHT_TOLERANCE = 0.06;
const EDGE_MARGIN = 5;
const BOUNDS_MARGIN = 150;
/** Traffic stops this far before a ramp and after its landing road. */
const ZONE_BEFORE = 12;
const ZONE_MARGIN = 2.5;

/** Where a point lies in a ramp's own frame, or undefined when it is clearly off the ramp. */
export function rampLocal(ramp: Ramp, x: number, z: number): { along: number; across: number } | undefined {
  const dx = x - ramp.x;
  const dz = z - ramp.z0;
  const reach = ramp.length + ramp.width;
  if (Math.abs(dx) > reach || Math.abs(dz) > reach) return undefined;
  const heading = ramp.heading ?? 0;
  if (heading === 0) return { along: dz, across: dx };
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  return { along: dx * sin + dz * cos, across: dx * cos - dz * sin };
}

export function rampZone(ramp: Ramp): ClosedZone {
  return {
    x: ramp.x,
    z: ramp.z0,
    heading: ramp.heading ?? 0,
    from: -ZONE_BEFORE,
    to: ramp.length + LANDING,
    halfWidth: ramp.width / 2 + ZONE_MARGIN,
  };
}

type Candidate = { edge: RoadEdge; dir: 1 | -1; start: number; x: number; z: number; heading: number };

function wrapAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function insideBounds(x: number, z: number) {
  return Math.abs(x) <= MAP_HALF_SIZE - BOUNDS_MARGIN && Math.abs(z) <= MAP_HALF_SIZE - BOUNDS_MARGIN;
}

function candidatesOn(edge: RoadEdge): Candidate[] {
  const found: Candidate[] = [];
  if (edge.width < RAMP_WIDTH) return found;
  const reach = RUN_UP + RAMP_LENGTH + LANDING;

  for (const dir of [1, -1] as const) {
    for (let distance = RUN_UP; distance + RAMP_LENGTH + LANDING <= edge.length - EDGE_MARGIN; distance += STEP) {
      const start = dir > 0 ? distance : edge.length - distance;
      const first = sampleEdge(edge, start);
      const heading = dir > 0 ? first.heading : first.heading + Math.PI;

      let straight = true;
      let inside = true;
      for (let t = -RUN_UP / 2; t <= reach - RUN_UP; t += 5) {
        const sample = sampleEdge(edge, start + dir * t);
        const sampleHeading = dir > 0 ? sample.heading : sample.heading + Math.PI;
        if (Math.abs(wrapAngle(sampleHeading - heading)) > STRAIGHT_TOLERANCE) straight = false;
        if (!insideBounds(sample.x, sample.z)) inside = false;
      }
      if (straight && inside) found.push({ edge, dir, start, x: first.x, z: first.z, heading });
    }
  }
  return found;
}

function distanceToEdge(edge: RoadEdge, x: number, z: number) {
  let best = Infinity;
  for (let i = 1; i < edge.points.length; i++) {
    const [ax, az] = edge.points[i - 1];
    const [bx, bz] = edge.points[i];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return best;
}

/** True when the ramp and its landing road have no building beside them and no other road crossing. */
function isClear(candidate: Candidate, network: RoadNetwork, buildings: BuildingIndex): boolean {
  const sin = Math.sin(candidate.heading);
  const cos = Math.cos(candidate.heading);
  const half = RAMP_WIDTH / 2;
  const total = RAMP_LENGTH + LANDING;

  for (let t = 0; t <= total; t += 5) {
    for (const across of [-half, 0, half]) {
      const x = candidate.x + sin * t + cos * across;
      const z = candidate.z + cos * t - sin * across;
      if (buildingHeightAt(buildings, x, z) > 0) return false;
    }
    const cx = candidate.x + sin * t;
    const cz = candidate.z + cos * t;
    for (const other of network.edges) {
      if (other.id === candidate.edge.id) continue;
      if (distanceToEdge(other, cx, cz) < other.width / 2 + half + 1) return false;
    }
  }
  return true;
}

/**
 * Jump ramps along the road network, spread out by repeatedly taking the straight, clear stretch
 * farthest from every ramp placed so far. Deterministic for the same map.
 */
export function placeJumpRamps(
  network: RoadNetwork,
  buildings: BuildingIndex,
  existing: readonly Ramp[],
  count: number
): Ramp[] {
  const candidates = network.edges.flatMap(candidatesOn);
  const taken = existing.map((ramp) => ({ x: ramp.x, z: ramp.z0 }));
  const placed: Ramp[] = [];

  const nearestTaken = (c: Candidate) =>
    taken.reduce((nearest, p) => Math.min(nearest, Math.hypot(c.x - p.x, c.z - p.z)), Infinity);

  while (placed.length < count && candidates.length > 0) {
    let bestIndex = -1;
    let bestDistance = MIN_SPACING;
    candidates.forEach((candidate, index) => {
      const distance = nearestTaken(candidate);
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) break;

    const [candidate] = candidates.splice(bestIndex, 1);
    if (!isClear(candidate, network, buildings)) continue;
    taken.push({ x: candidate.x, z: candidate.z });
    placed.push({
      x: candidate.x,
      z0: candidate.z,
      length: RAMP_LENGTH,
      width: RAMP_WIDTH,
      height: RAMP_HEIGHT,
      heading: candidate.heading,
    });
  }
  return placed;
}
