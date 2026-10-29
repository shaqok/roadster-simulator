import data from "./data/magok-map.json";
import { buildRoadNetwork } from "./roads";
import { createBuildingIndex, type BuildingIndex } from "./world";

export type MapRoad = { c: string; w: number; p: Array<[number, number]> };
export type MapBuilding = { h: number; p: Array<[number, number]> };

type MagokMap = {
  meta: { attribution: string; startRoad: string | null };
  roads: MapRoad[];
  buildings: MapBuilding[];
};

/** Roads and buildings around Magok, Seoul, rotated so the start road runs along +z. */
export const MAGOK_MAP = data as unknown as MagokMap;

export const MAP_ATTRIBUTION = MAGOK_MAP.meta.attribution;

/** The roads cars can drive on, split into stretches between junctions. */
export const MAGOK_NETWORK = buildRoadNetwork(MAGOK_MAP.roads);

export function createMagokBuildings(): BuildingIndex {
  return createBuildingIndex(
    MAGOK_MAP.buildings.map((building) => ({ height: building.h, points: building.p }))
  );
}
