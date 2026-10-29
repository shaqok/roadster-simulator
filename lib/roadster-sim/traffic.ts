import { MAP_HALF_SIZE } from "./bounds";
import { buildingHeightAt, type BuildingIndex } from "./world";
import type { ObstacleState } from "./map";
import {
  inZone,
  lanePoint,
  nearestOnNetwork,
  sampleEdge,
  type ClosedZone,
  type RoadNetwork,
} from "./roads";

/** Where a car goes after the end of its current stretch of road. */
type NextLeg = { edge: number; dir: 1 | -1; lane: number } | "u-turn";

/**
 * A car driving itself along the roads. Its box (`x`, `z`, `heading`, size) is what the roadster
 * collides with; `edge`, `dir`, `s` and `lane` say which lane of which stretch it is following.
 */
export type TrafficCar = ObstacleState & {
  heading: number;
  speed: number;
  edge: number;
  dir: 1 | -1;
  /** Distance along the edge's centerline, meters. */
  s: number;
  lane: number;
  /** This car's own cruising speed as a fraction of the road's. */
  pace: number;
  seed: number;
  /** Seconds during which the car does not turn around again after a U-turn. */
  turnCooldown: number;
  /** Seconds the car has been held up behind another one. */
  waiting: number;
  next: NextLeg | null;
};

export const TRAFFIC_CAR_SIZE = { sizeX: 2, sizeZ: 4.5, height: 1.5 };
export const TRAFFIC_COUNT = 40;

const TURN_RATE = 2.2;
const ACCELERATION = 2.5;
const BRAKING = 9;
const U_TURN_SPEED = 4.5;
const PREVIEW_DISTANCE = 28;
const BEND_LOOKAHEAD = 18;
const JUNCTION_SPEED = 7;
const JUNCTION_SLOWDOWN_DISTANCE = 16;
const TURN_AROUND_LOOKAHEAD = 7;
const TURN_AROUND_COOLDOWN = 3;
const BOUNDARY = MAP_HALF_SIZE - 12;
const FOLLOW_RANGE = 24;
const FOLLOW_GAP = 5;
const SPAWN_SPACING = 14;
const SPAWN_ZONE_MARGIN = 14;
const EDGE_SPAWN_MARGIN = 10;

function nextRandom(seed: number): [number, number] {
  const next = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return [next / 4294967296, next];
}

function wrapAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

/** A car of the given lane placement, sitting in that lane facing the way it drives. */
function carAt(
  network: RoadNetwork,
  edgeId: number,
  dir: 1 | -1,
  s: number,
  lane: number,
  pace: number,
  seed: number
): TrafficCar {
  const point = lanePoint(network.edges[edgeId], s, dir, lane);
  return {
    ...TRAFFIC_CAR_SIZE,
    x: point.x,
    z: point.z,
    heading: point.heading,
    vx: 0,
    vz: 0,
    speed: 0,
    edge: edgeId,
    dir,
    s,
    lane,
    pace,
    seed,
    turnCooldown: 0,
    waiting: 0,
    next: null,
  };
}

export type TrafficPin = { x: number; z: number; heading: number; lane: number };

function insideBoundary(x: number, z: number) {
  return Math.abs(x) <= BOUNDARY && Math.abs(z) <= BOUNDARY;
}

/**
 * Cars spread over the network, deterministic for a seed. Pinned cars are placed first on the road
 * nearest each pin, driving the way the pin faces.
 */
export function spawnTraffic(
  network: RoadNetwork,
  zones: readonly ClosedZone[],
  options: { count?: number; seed?: number; pins?: readonly TrafficPin[]; buildings?: BuildingIndex } = {}
): TrafficCar[] {
  const { count = TRAFFIC_COUNT, seed: initialSeed = 20260, pins = [], buildings } = options;
  const cars: TrafficCar[] = [];
  let seed = initialSeed;
  const random = () => {
    const [value, next] = nextRandom(seed);
    seed = next;
    return value;
  };

  for (const pin of pins) {
    const nearest = nearestOnNetwork(network, pin.x, pin.z);
    if (!nearest) continue;
    const tangent = sampleEdge(nearest.edge, nearest.s).heading;
    const dir = Math.cos(tangent - pin.heading) >= 0 ? 1 : -1;
    const lane = Math.min(pin.lane, nearest.edge.lanes.perDirection - 1);
    cars.push(carAt(network, nearest.edge.id, dir, nearest.s, lane, 0.95, random() * 4294967296));
  }

  const edges = network.edges.filter((edge) => edge.length > 2 * EDGE_SPAWN_MARGIN + 10);
  const totalLength = edges.reduce((sum, edge) => sum + edge.length, 0);
  if (edges.length === 0) return cars;

  for (let attempt = 0; attempt < count * 60 && cars.length < count + pins.length; attempt++) {
    let pick = random() * totalLength;
    const edge = edges.find((candidate) => (pick -= candidate.length) <= 0) ?? edges[0];
    const s = EDGE_SPAWN_MARGIN + random() * (edge.length - 2 * EDGE_SPAWN_MARGIN);
    const dir = random() < 0.5 ? 1 : -1;
    const lane = Math.floor(random() * edge.lanes.perDirection);
    const pace = 0.85 + random() * 0.25;
    const car = carAt(network, edge.id, dir, s, lane, pace, random() * 4294967296);

    if (!insideBoundary(car.x, car.z)) continue;
    if (buildings && buildingHeightAt(buildings, car.x, car.z) > 0) continue;
    if (
      zones.some(
        (zone) =>
          inZone({ ...zone, from: zone.from - SPAWN_ZONE_MARGIN, to: zone.to + SPAWN_ZONE_MARGIN }, car.x, car.z)
      )
    ) {
      continue;
    }
    if (cars.some((other) => Math.hypot(other.x - car.x, other.z - car.z) < SPAWN_SPACING)) continue;
    cars.push(car);
  }

  // Cars start at their road's pace instead of from a standstill.
  return cars.map((car) => {
    const speed = network.edges[car.edge].speed * car.pace;
    return {
      ...car,
      speed,
      vx: Math.sin(car.heading) * speed,
      vz: Math.cos(car.heading) * speed,
    };
  });
}

function pickNext(
  network: RoadNetwork,
  car: Pick<TrafficCar, "edge" | "dir" | "lane" | "seed">
): { next: NextLeg; seed: number } {
  const edge = network.edges[car.edge];
  const node = network.nodes[car.dir > 0 ? edge.endNode : edge.startNode];
  const options = node.ends.filter((end) => !(end.edge === edge.id && end.atStart === car.dir < 0));
  if (options.length === 0) return { next: "u-turn", seed: car.seed };

  const [value, seed] = nextRandom(car.seed);
  const option = options[Math.min(options.length - 1, Math.floor(value * options.length))];
  const target = network.edges[option.edge];
  return {
    next: {
      edge: option.edge,
      dir: option.atStart ? 1 : -1,
      lane: Math.min(car.lane, target.lanes.perDirection - 1),
    },
    seed,
  };
}

/** Where the car should aim: a point in its lane a little ahead, on the next road when it is close to the end. */
function aimPoint(network: RoadNetwork, car: TrafficCar, look: number) {
  const edge = network.edges[car.edge];
  const remaining = car.dir > 0 ? edge.length - car.s : car.s;
  if (remaining < look && car.next && car.next !== "u-turn") {
    const target = network.edges[car.next.edge];
    const into = look - remaining;
    return lanePoint(target, car.next.dir > 0 ? into : target.length - into, car.next.dir, car.next.lane);
  }
  return lanePoint(edge, clamp(car.s + car.dir * look, 0, edge.length), car.dir, car.lane);
}

function stepTrafficCar(
  car: TrafficCar,
  cars: readonly TrafficCar[],
  network: RoadNetwork,
  zones: readonly ClosedZone[],
  dt: number
): TrafficCar {
  let { edge: edgeId, dir, s, lane, next, seed, turnCooldown, waiting } = car;
  let edge = network.edges[edgeId];
  const forwardX = Math.sin(car.heading);
  const forwardZ = Math.cos(car.heading);

  // Turn around instead of driving into a closed stretch or off the map.
  turnCooldown = Math.max(0, turnCooldown - dt);
  if (turnCooldown === 0) {
    const aheadX = car.x + forwardX * TURN_AROUND_LOOKAHEAD;
    const aheadZ = car.z + forwardZ * TURN_AROUND_LOOKAHEAD;
    const leavingMap =
      (Math.abs(aheadX) > BOUNDARY && Math.abs(aheadX) > Math.abs(car.x)) ||
      (Math.abs(aheadZ) > BOUNDARY && Math.abs(aheadZ) > Math.abs(car.z));
    const enteringClosed = zones.some(
      (zone) => inZone(zone, aheadX, aheadZ) && !inZone(zone, car.x, car.z)
    );
    if (leavingMap || enteringClosed) {
      dir = dir > 0 ? -1 : 1;
      next = null;
      turnCooldown = TURN_AROUND_COOLDOWN;
    }
  }

  const remaining = dir > 0 ? edge.length - s : s;
  if (next === null && remaining < PREVIEW_DISTANCE) {
    const picked = pickNext(network, { edge: edgeId, dir, lane, seed });
    next = picked.next;
    seed = picked.seed;
  }

  const current = { ...car, edge: edgeId, dir, s, lane, next, seed, turnCooldown };
  const look = Math.max(4, car.speed * 0.7);
  const aim = aimPoint(network, current, look);
  const error = wrapAngle(Math.atan2(aim.x - car.x, aim.z - car.z) - car.heading);

  let target = edge.speed * car.pace;
  const bend = Math.abs(
    wrapAngle(
      sampleEdge(edge, clamp(s + dir * BEND_LOOKAHEAD, 0, edge.length)).heading -
        sampleEdge(edge, s).heading
    )
  );
  target = Math.min(target, Math.max(5, target / (1 + bend * 5)));
  if (remaining < JUNCTION_SLOWDOWN_DISTANCE && next && next !== "u-turn") {
    const node = network.nodes[dir > 0 ? edge.endNode : edge.startNode];
    if (node.ends.length >= 3) target = Math.min(target, JUNCTION_SPEED);
  }
  if (next === "u-turn" && remaining < JUNCTION_SLOWDOWN_DISTANCE) target = Math.min(target, U_TURN_SPEED);
  if (Math.abs(error) > 0.7 || turnCooldown > 0) target = Math.min(target, U_TURN_SPEED);

  // Keep a gap to the car ahead in the same direction.
  if (waiting < 4) {
    for (const other of cars) {
      if (other === car) continue;
      const dx = other.x - car.x;
      const dz = other.z - car.z;
      const ahead = dx * forwardX + dz * forwardZ;
      if (ahead <= 0 || ahead > FOLLOW_RANGE) continue;
      if (Math.abs(dx * forwardZ - dz * forwardX) > 2.4) continue;
      if (Math.cos(other.heading - car.heading) < 0.5) continue;
      const gap = ahead - TRAFFIC_CAR_SIZE.sizeZ;
      target = Math.min(target, gap <= 1 ? 0 : Math.max(0, other.speed + (gap - FOLLOW_GAP)));
    }
  }

  let speed = car.speed + clamp(target - car.speed, -BRAKING * dt, ACCELERATION * dt);
  speed = Math.max(0, speed);
  waiting = target < 0.5 && speed < 0.5 ? waiting + dt : 0;

  const heading = wrapAngle(car.heading + clamp(error, -TURN_RATE * dt, TURN_RATE * dt));
  const x = car.x + Math.sin(heading) * speed * dt;
  const z = car.z + Math.cos(heading) * speed * dt;
  s += dir * speed * dt;

  // Reaching the end of the stretch: carry on along the chosen road, or turn back at a dead end.
  if (dir > 0 ? s >= edge.length : s <= 0) {
    const over = dir > 0 ? s - edge.length : -s;
    const leg = next ?? pickNext(network, { edge: edgeId, dir, lane, seed }).next;
    if (leg === "u-turn") {
      dir = dir > 0 ? -1 : 1;
      s = dir > 0 ? over : edge.length - over;
      turnCooldown = TURN_AROUND_COOLDOWN;
    } else {
      edgeId = leg.edge;
      edge = network.edges[edgeId];
      dir = leg.dir;
      lane = leg.lane;
      s = clamp(dir > 0 ? over : edge.length - over, 0, edge.length);
    }
    next = null;
  }

  return {
    ...car,
    x,
    z,
    heading,
    vx: Math.sin(heading) * speed,
    vz: Math.cos(heading) * speed,
    speed,
    edge: edgeId,
    dir,
    s,
    lane,
    seed,
    turnCooldown,
    waiting,
    next,
  };
}

/** Moves every traffic car one step along its lane. The roadster never changes where they go. */
export function advanceTraffic(
  cars: readonly TrafficCar[],
  network: RoadNetwork,
  zones: readonly ClosedZone[],
  dt: number
): TrafficCar[] {
  return cars.map((car) => (network.edges[car.edge] ? stepTrafficCar(car, cars, network, zones, dt) : car));
}
