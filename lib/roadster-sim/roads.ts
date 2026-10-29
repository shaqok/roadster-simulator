type Point = readonly [number, number];

/** A road as stored in the map data: class, width in meters and a centerline of [x, z] points. */
export type RoadInput = { c: string; w: number; p: ReadonlyArray<Point> };

/** Cars drive and lines are painted only on roads at least this wide. */
export const MIN_ROAD_WIDTH = 6;
/** Roads at least this wide get a double center line. */
const DOUBLE_CENTER_WIDTH = 14;
export const LANE_WIDTH = 3.25;

const FAST_CLASSES = new Set(["motorway", "trunk", "primary", "secondary"]);
const FAST_SPEED = 50 / 3.6;
const SLOW_SPEED = 30 / 3.6;

export type LaneLayout = { perDirection: number; laneWidth: number };

/** Lanes per direction from the road width. Every road is two-way with at least one lane each way. */
export function laneLayout(width: number): LaneLayout {
  const total = Math.max(2, Math.floor(width / LANE_WIDTH));
  const perDirection = Math.floor(total / 2);
  return { perDirection, laneWidth: width / 2 / perDirection };
}

/** A stretch of road between two junctions or dead ends. */
export type RoadEdge = {
  id: number;
  roadClass: string;
  width: number;
  points: ReadonlyArray<Point>;
  /** Distance along the centerline at each point, meters. */
  cumulative: number[];
  length: number;
  startNode: number;
  endNode: number;
  lanes: LaneLayout;
  /** Cruising speed in m/s. */
  speed: number;
};

export type RoadNode = {
  x: number;
  z: number;
  ends: Array<{ edge: number; atStart: boolean }>;
};

export type RoadNetwork = { edges: RoadEdge[]; nodes: RoadNode[] };

export const EMPTY_ROADS: RoadNetwork = { edges: [], nodes: [] };

/** A stretch of road where traffic does not drive: a box along `heading` from `from` to `to`. */
export type ClosedZone = {
  x: number;
  z: number;
  heading: number;
  from: number;
  to: number;
  halfWidth: number;
};

export function inZone(zone: ClosedZone, x: number, z: number): boolean {
  const dx = x - zone.x;
  const dz = z - zone.z;
  const sin = Math.sin(zone.heading);
  const cos = Math.cos(zone.heading);
  const along = dx * sin + dz * cos;
  const across = dx * cos - dz * sin;
  return along >= zone.from && along <= zone.to && Math.abs(across) <= zone.halfWidth;
}

/** The driver's right-hand direction when traveling along `heading` (forward is (sin h, cos h)). */
export function rightOf(heading: number) {
  return { x: -Math.cos(heading), z: Math.sin(heading) };
}

function pointKey(p: Point) {
  return `${p[0]},${p[1]}`;
}

export function buildRoadNetwork(roads: readonly RoadInput[]): RoadNetwork {
  const drivable = roads.filter(
    (road) => road.w >= MIN_ROAD_WIDTH && road.c !== "busway" && road.p.length >= 2
  );

  const uses = new Map<string, number>();
  for (const road of drivable) {
    for (const p of road.p) uses.set(pointKey(p), (uses.get(pointKey(p)) ?? 0) + 1);
  }

  const nodes: RoadNode[] = [];
  const nodeIds = new Map<string, number>();
  const nodeAt = (p: Point) => {
    const key = pointKey(p);
    let id = nodeIds.get(key);
    if (id === undefined) {
      id = nodes.length;
      nodeIds.set(key, id);
      nodes.push({ x: p[0], z: p[1], ends: [] });
    }
    return id;
  };

  const edges: RoadEdge[] = [];
  for (const road of drivable) {
    const roadClass = road.c.replace("_link", "");
    let from = 0;
    for (let i = 1; i < road.p.length; i++) {
      const last = i === road.p.length - 1;
      if (!last && (uses.get(pointKey(road.p[i])) ?? 0) < 2) continue;

      const points = road.p
        .slice(from, i + 1)
        .filter((p, index, all) => index === 0 || pointKey(p) !== pointKey(all[index - 1]));
      from = i;
      if (points.length < 2) continue;

      const cumulative = [0];
      for (let k = 1; k < points.length; k++) {
        cumulative.push(
          cumulative[k - 1] + Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1])
        );
      }
      const length = cumulative[cumulative.length - 1];
      if (length < 1) continue;

      const id = edges.length;
      const startNode = nodeAt(points[0]);
      const endNode = nodeAt(points[points.length - 1]);
      nodes[startNode].ends.push({ edge: id, atStart: true });
      nodes[endNode].ends.push({ edge: id, atStart: false });
      edges.push({
        id,
        roadClass,
        width: road.w,
        points,
        cumulative,
        length,
        startNode,
        endNode,
        lanes: laneLayout(road.w),
        speed: FAST_CLASSES.has(roadClass) ? FAST_SPEED : SLOW_SPEED,
      });
    }
  }
  return { edges, nodes };
}

export type EdgeSample = { x: number; z: number; heading: number };

/** Centerline point at distance `s` from the edge start, with the heading of increasing `s`. */
export function sampleEdge(edge: RoadEdge, s: number): EdgeSample {
  const d = Math.max(0, Math.min(edge.length, s));
  let i = 1;
  while (i < edge.cumulative.length - 1 && edge.cumulative[i] < d) i++;
  const [ax, az] = edge.points[i - 1];
  const [bx, bz] = edge.points[i];
  const t = (d - edge.cumulative[i - 1]) / (edge.cumulative[i] - edge.cumulative[i - 1] || 1);
  return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, heading: Math.atan2(bx - ax, bz - az) };
}

/** Center of the `lane`-th lane (0 is next to the center line) on the right of the travel direction. */
export function lanePoint(edge: RoadEdge, s: number, dir: 1 | -1, lane: number): EdgeSample {
  const base = sampleEdge(edge, s);
  const heading = dir > 0 ? base.heading : base.heading + Math.PI;
  const right = rightOf(heading);
  const offset = (lane + 0.5) * edge.lanes.laneWidth;
  return { x: base.x + right.x * offset, z: base.z + right.z * offset, heading };
}

/** Nearest point of the network to a world position. */
export function nearestOnNetwork(network: RoadNetwork, x: number, z: number) {
  let best: { edge: RoadEdge; s: number; distance: number } | undefined;
  for (const edge of network.edges) {
    for (let i = 1; i < edge.points.length; i++) {
      const [ax, az] = edge.points[i - 1];
      const [bx, bz] = edge.points[i];
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      const distance = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
      if (!best || distance < best.distance) {
        best = { edge, s: edge.cumulative[i - 1] + t * (edge.cumulative[i] - edge.cumulative[i - 1]), distance };
      }
    }
  }
  return best;
}

export type MarkingColor = "white" | "yellow";

/** One flat painted line segment on the road surface. */
export type Marking = {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  width: number;
  color: MarkingColor;
  roadClass: string;
};

const LINE_WIDTH = 0.14;
const DASH = 3;
const DASH_PERIOD = 9;
const EDGE_LINE_INSET = 0.3;

/** Painted lines for every road: center line, lane dividers and edge lines, stopping short of junctions. */
export function laneMarkings(network: RoadNetwork): Marking[] {
  const markings: Marking[] = [];

  for (const edge of network.edges) {
    const trimAt = (nodeId: number) => {
      const node = network.nodes[nodeId];
      if (node.ends.length < 3) return 0;
      const widest = Math.max(...node.ends.map((end) => network.edges[end.edge].width));
      return Math.min(edge.length / 3, 6 + widest / 2);
    };
    const from = trimAt(edge.startNode);
    const to = edge.length - trimAt(edge.endNode);
    if (to - from < 1) continue;

    const strip = (a: number, b: number, offset: number, width: number, color: MarkingColor) => {
      for (let i = 1; i < edge.points.length; i++) {
        const segStart = edge.cumulative[i - 1];
        const segEnd = edge.cumulative[i];
        const lo = Math.max(segStart, a);
        const hi = Math.min(segEnd, b);
        if (hi - lo < 0.05) continue;
        const [ax, az] = edge.points[i - 1];
        const ux = (edge.points[i][0] - ax) / (segEnd - segStart);
        const uz = (edge.points[i][1] - az) / (segEnd - segStart);
        // Right of increasing distance is (-uz, ux).
        const rx = -uz * offset;
        const rz = ux * offset;
        markings.push({
          x0: ax + ux * (lo - segStart) + rx,
          z0: az + uz * (lo - segStart) + rz,
          x1: ax + ux * (hi - segStart) + rx,
          z1: az + uz * (hi - segStart) + rz,
          width,
          color,
          roadClass: edge.roadClass,
        });
      }
    };
    const solid = (offset: number, color: MarkingColor) => strip(from, to, offset, LINE_WIDTH, color);
    const dashed = (offset: number) => {
      for (let s = from; s < to; s += DASH_PERIOD) {
        strip(s, Math.min(s + DASH, to), offset, LINE_WIDTH, "white");
      }
    };

    if (edge.width >= DOUBLE_CENTER_WIDTH) {
      solid(-0.15, "yellow");
      solid(0.15, "yellow");
    } else {
      solid(0, "yellow");
    }
    const { perDirection, laneWidth } = edge.lanes;
    for (let k = 1; k < perDirection; k++) {
      dashed(k * laneWidth);
      dashed(-k * laneWidth);
    }
    const edgeOffset = edge.width / 2 - EDGE_LINE_INSET;
    solid(edgeOffset, "white");
    solid(-edgeOffset, "white");
  }
  return markings;
}
