import { vec, type Vec3 } from "./vec";

/** A building footprint extruded to a flat roof. Points are [x, z] in meters. */
export type Building = { height: number; points: ReadonlyArray<readonly [number, number]> };

type Edge = { ax: number; az: number; bx: number; bz: number; nx: number; nz: number };

type IndexedBuilding = {
  height: number;
  points: ReadonlyArray<readonly [number, number]>;
  edges: Edge[];
};

/** Buildings bucketed into a coarse grid so a lookup only touches the few that are nearby. */
export type BuildingIndex = { cells: Map<number, IndexedBuilding[]> };

export type BuildingContact = { normal: Vec3; penetration: number };

const CELL_SIZE = 40;

function cellKey(cellX: number, cellZ: number) {
  return (cellX + 4096) * 8192 + (cellZ + 4096);
}

function signedArea(points: Building["points"]) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    sum += x1 * z2 - x2 * z1;
  }
  return sum / 2;
}

export function createBuildingIndex(buildings: readonly Building[]): BuildingIndex {
  const cells = new Map<number, IndexedBuilding[]>();

  for (const building of buildings) {
    const { points } = building;
    if (points.length < 3) continue;
    const counterClockwise = signedArea(points) > 0;

    const edges: Edge[] = points.map(([ax, az], i) => {
      const [bx, bz] = points[(i + 1) % points.length];
      const length = Math.hypot(bx - ax, bz - az) || 1;
      const dx = (bx - ax) / length;
      const dz = (bz - az) / length;
      // Outward normal of a counter-clockwise ring is the edge direction turned a quarter clockwise.
      return counterClockwise
        ? { ax, az, bx, bz, nx: dz, nz: -dx }
        : { ax, az, bx, bz, nx: -dz, nz: dx };
    });
    const indexed: IndexedBuilding = { height: building.height, points, edges };

    const xs = points.map(([x]) => x);
    const zs = points.map(([, z]) => z);
    const fromX = Math.floor(Math.min(...xs) / CELL_SIZE);
    const toX = Math.floor(Math.max(...xs) / CELL_SIZE);
    const fromZ = Math.floor(Math.min(...zs) / CELL_SIZE);
    const toZ = Math.floor(Math.max(...zs) / CELL_SIZE);
    for (let cx = fromX; cx <= toX; cx++) {
      for (let cz = fromZ; cz <= toZ; cz++) {
        const key = cellKey(cx, cz);
        const bucket = cells.get(key);
        if (bucket) bucket.push(indexed);
        else cells.set(key, [indexed]);
      }
    }
  }
  return { cells };
}

export const NO_BUILDINGS: BuildingIndex = createBuildingIndex([]);

function containsPoint(building: IndexedBuilding, x: number, z: number) {
  const { points } = building;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i];
    const [xj, zj] = points[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** The tallest building whose footprint covers the point. */
function buildingAt(index: BuildingIndex, x: number, z: number): IndexedBuilding | undefined {
  const bucket = index.cells.get(cellKey(Math.floor(x / CELL_SIZE), Math.floor(z / CELL_SIZE)));
  let tallest: IndexedBuilding | undefined;
  if (!bucket) return tallest;
  for (const building of bucket) {
    if ((!tallest || building.height > tallest.height) && containsPoint(building, x, z)) {
      tallest = building;
    }
  }
  return tallest;
}

export function buildingHeightAt(index: BuildingIndex, x: number, z: number): number {
  return buildingAt(index, x, z)?.height ?? 0;
}

function distanceToEdge(edge: Edge, x: number, z: number) {
  const dx = edge.bx - edge.ax;
  const dz = edge.bz - edge.az;
  const lengthSquared = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - edge.ax) * dx + (z - edge.az) * dz) / lengthSquared));
  return Math.hypot(x - (edge.ax + t * dx), z - (edge.az + t * dz));
}

/**
 * If the point is inside a building, the nearest face to push it out through. Buildings are large
 * and solid, so the shallowest face is the one it just crossed. That also holds on the bounce back,
 * when the car is already moving away from that face.
 */
export function buildingContact(index: BuildingIndex, p: Vec3): BuildingContact | undefined {
  const building = buildingAt(index, p.x, p.z);
  if (!building || p.y >= building.height) return undefined;

  const faces: BuildingContact[] = [
    { normal: vec(0, 1, 0), penetration: building.height - p.y },
    ...building.edges.map((edge) => ({
      normal: vec(edge.nx, 0, edge.nz),
      penetration: distanceToEdge(edge, p.x, p.z),
    })),
  ];
  return faces.reduce((best, face) => (face.penetration < best.penetration ? face : best));
}
