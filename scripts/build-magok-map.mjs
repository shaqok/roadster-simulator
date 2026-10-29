// Downloads OpenStreetMap roads and buildings around Magok, Seoul, and writes the trimmed map the
// simulator loads at runtime. The app itself never calls a map server.
//
//   bun run map:magok                     fetch from the public Overpass server
//   bun run map:magok -- --from raw.json  rebuild from a saved Overpass response
//
// Data © OpenStreetMap contributors, available under the ODbL (https://www.openstreetmap.org/copyright).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CENTER = { lat: 37.5625, lon: 126.83 };
const HALF_SIZE = 700;
const OUTPUT = "lib/roadster-sim/data/magok-map.json";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "roadster-simulator-map-fetch/0.1";

const METERS_PER_LAT = 110540;
const METERS_PER_LON = 111320 * Math.cos((CENTER.lat * Math.PI) / 180);

const DRIVABLE = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "busway",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
]);

const DEFAULT_ROAD_WIDTH = {
  motorway: 16,
  trunk: 16,
  primary: 14,
  secondary: 12,
  tertiary: 9,
  unclassified: 7,
  residential: 7,
  living_street: 5,
  service: 4.5,
  busway: 6,
};
const LANE_WIDTH = 3.3;
const DEFAULT_BUILDING_HEIGHT = 12;
const LEVEL_HEIGHT = 3.2;

// The straight start road must hold the ramp and parked cars, which reach about 120 m ahead.
const START_CORRIDOR = { behind: 15, ahead: 150, halfWidth: 9 };
const START_MIN_ROAD_WIDTH = 12;

const round = (value) => Math.round(value * 10) / 10;

function project({ lat, lon }) {
  // East is -x so the map keeps its handedness when the car faces +z.
  return [-(lon - CENTER.lon) * METERS_PER_LON, (lat - CENTER.lat) * METERS_PER_LAT];
}

function roadWidth(tags) {
  const lanes = Number.parseFloat(tags.lanes);
  if (Number.isFinite(lanes) && lanes > 0) return Math.min(30, lanes * LANE_WIDTH);
  const base = tags.highway.replace("_link", "");
  return (tags.highway.endsWith("_link") ? 6 : DEFAULT_ROAD_WIDTH[base]) ?? 7;
}

function buildingHeight(tags) {
  const height = Number.parseFloat(tags.height);
  if (Number.isFinite(height) && height > 0) return Math.min(250, Math.max(3, height));
  const levels = Number.parseFloat(tags["building:levels"]);
  if (Number.isFinite(levels) && levels > 0) return Math.min(250, Math.max(3, levels * LEVEL_HEIGHT));
  return DEFAULT_BUILDING_HEIGHT;
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    sum += x1 * z2 - x2 * z1;
  }
  return Math.abs(sum) / 2;
}

function insidePolygon([x, z], points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i];
    const [xj, zj] = points[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

async function loadRaw() {
  const fromIndex = process.argv.indexOf("--from");
  if (fromIndex !== -1) return JSON.parse(await readFile(process.argv[fromIndex + 1], "utf8"));

  const dLat = HALF_SIZE / METERS_PER_LAT;
  const dLon = HALF_SIZE / METERS_PER_LON;
  const bbox = [CENTER.lat - dLat, CENTER.lon - dLon, CENTER.lat + dLat, CENTER.lon + dLon].join(",");
  const query = `[out:json][timeout:60];(way["highway"](${bbox});way["building"](${bbox});relation["building"](${bbox}););out geom tags;`;
  const response = await fetch(OVERPASS, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }),
  });
  if (!response.ok) throw new Error(`Overpass responded ${response.status}`);
  return response.json();
}

/** Straight runs of a road, as start points with a direction, sampled every 10 m. */
function* straightStarts(road) {
  const { points } = road;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[i + 1];
    const length = Math.hypot(x1 - x0, z1 - z0);
    if (length < START_CORRIDOR.ahead + START_CORRIDOR.behind) continue;
    const direction = [(x1 - x0) / length, (z1 - z0) / length];
    for (let s = START_CORRIDOR.behind; s <= length - START_CORRIDOR.ahead; s += 10) {
      yield { origin: [x0 + direction[0] * s, z0 + direction[1] * s], direction };
    }
  }
}

function corridorIsClear({ origin, direction }, buildings) {
  const side = [-direction[1], direction[0]];
  const toWorld = (along, across) => [
    origin[0] + direction[0] * along + side[0] * across,
    origin[1] + direction[1] * along + side[1] * across,
  ];
  const toLocal = ([x, z]) => {
    const dx = x - origin[0];
    const dz = z - origin[1];
    return [dx * direction[0] + dz * direction[1], dx * side[0] + dz * side[1]];
  };
  const { behind, ahead, halfWidth } = START_CORRIDOR;

  for (const building of buildings) {
    const near = building.points.some(([x, z]) => {
      const [along, across] = toLocal([x, z]);
      return along > -behind - 6 && along < ahead + 6 && Math.abs(across) < halfWidth + 6;
    });
    if (!near) continue;
    for (let along = -behind; along <= ahead; along += 2) {
      for (let across = -halfWidth; across <= halfWidth; across += 2) {
        if (insidePolygon(toWorld(along, across), building.points)) return false;
      }
    }
    const intrudes = building.points.some(([x, z]) => {
      const [along, across] = toLocal([x, z]);
      return along > -behind - 3 && along < ahead + 3 && Math.abs(across) < halfWidth + 3;
    });
    if (intrudes) return false;
  }
  return true;
}

function pickStart(roads, buildings) {
  let best;
  for (const road of roads) {
    if (road.width < START_MIN_ROAD_WIDTH) continue;
    for (const candidate of straightStarts(road)) {
      const distance = Math.hypot(...candidate.origin);
      if (best && distance >= best.distance) continue;
      if (corridorIsClear(candidate, buildings)) best = { ...candidate, distance, road };
    }
  }
  if (!best) throw new Error("No straight, building-free road found for the start");
  return best;
}

/** Drops the repeated closing point of a ring and rejects rings too small to matter. */
function toRing(geometry) {
  const points = geometry.map(project);
  const closed = points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1];
  const ring = closed ? points.slice(0, -1) : points;
  return ring.length >= 3 && polygonArea(ring) >= 10 ? ring : undefined;
}

const raw = await loadRaw();

const roads = [];
const buildings = [];
for (const element of raw.elements) {
  if (!element.tags) continue;
  if (element.type === "way" && element.geometry && DRIVABLE.has(element.tags.highway)) {
    roads.push({
      cls: element.tags.highway,
      width: roadWidth(element.tags),
      points: element.geometry.map(project),
      name: element.tags.name,
    });
  } else if (element.type === "way" && element.geometry && element.tags.building) {
    const ring = toRing(element.geometry);
    if (ring) buildings.push({ height: buildingHeight(element.tags), points: ring });
  } else if (element.type === "relation" && element.tags.building) {
    // A complex made of several outlines. Courtyard holes are ignored: only the outer rings count.
    for (const member of element.members ?? []) {
      if (member.role !== "outer" || !member.geometry) continue;
      const ring = toRing(member.geometry);
      if (ring) buildings.push({ height: buildingHeight(element.tags), points: ring });
    }
  }
}

const start = pickStart(roads, buildings);
const heading = Math.atan2(start.direction[0], start.direction[1]);

// Rotate so the start road runs along +z through the origin.
const transform = ([x, z]) => {
  const dx = x - start.origin[0];
  const dz = z - start.origin[1];
  return [
    round(dx * Math.cos(heading) - dz * Math.sin(heading)),
    round(dx * Math.sin(heading) + dz * Math.cos(heading)),
  ];
};
const withinMap = (points) =>
  points.some(([x, z]) => Math.abs(x) <= HALF_SIZE && Math.abs(z) <= HALF_SIZE);

const map = {
  meta: {
    source: "OpenStreetMap",
    attribution: "© OpenStreetMap contributors",
    license: "ODbL 1.0",
    centerLat: CENTER.lat,
    centerLon: CENTER.lon,
    halfSize: HALF_SIZE,
    startRoad: start.road.name ?? null,
    startHeadingFromNorthRad: round(heading * 1000) / 1000,
  },
  roads: roads
    .map((road) => ({ cls: road.cls, width: road.width, points: road.points.map(transform) }))
    .filter((road) => withinMap(road.points))
    .map((road) => ({ c: road.cls, w: road.width, p: road.points })),
  buildings: buildings
    .map((building) => ({ height: building.height, points: building.points.map(transform) }))
    .filter((building) => withinMap(building.points))
    .map((building) => ({ h: building.height, p: building.points })),
};

await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, JSON.stringify(map));
console.log(
  `start on ${start.road.name ?? start.road.cls} (${start.road.width} m wide), ` +
    `${map.roads.length} roads, ${map.buildings.length} buildings -> ${OUTPUT}`
);
