import { describe, expect, it } from "vitest";

import { IDLE_INPUT, createSimulation, stepSimulation, type SimState } from "./simulation";
import { MAGOK_NETWORK, createMagokBuildings } from "./magok";
import { CLOSED_ZONES, MAP_HALF_SIZE, rampHeightAt } from "./map";
import {
  buildRoadNetwork,
  inZone,
  nearestOnNetwork,
  rightOf,
  sampleEdge,
  type ClosedZone,
  type RoadNetwork,
} from "./roads";
import { advanceTraffic, spawnTraffic, type TrafficCar } from "./traffic";

const DT = 1 / 60;

function drive(cars: TrafficCar[], network: RoadNetwork, zones: readonly ClosedZone[], seconds: number, each?: (cars: TrafficCar[], t: number) => void) {
  let current = cars;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    current = advanceTraffic(current, network, zones, DT);
    each?.(current, i * DT);
  }
  return current;
}

/** One straight two-way road along z, 600 m long and well inside the map. */
const STRAIGHT = buildRoadNetwork([{ c: "tertiary", w: 9, p: [[0, -300], [0, 300]] }]);
const lanePin = (z: number, heading = 0, lane = 0) => ({ x: 0, z, heading, lane });

describe("교통 차량 배치", () => {
  const start = createSimulation({ roads: MAGOK_NETWORK, buildings: createMagokBuildings() });

  it("도로망이 있으면 교통 차량 약 40대가 나타난다", () => {
    expect(start.traffic.length).toBeGreaterThanOrEqual(40);
    expect(start.traffic.length).toBeLessThanOrEqual(48);
  });

  it("도로망이 없으면 교통 차량도 없다", () => {
    expect(createSimulation().traffic).toHaveLength(0);
  });

  it("같은 시드면 같은 배치가 나온다", () => {
    const a = spawnTraffic(MAGOK_NETWORK, CLOSED_ZONES, { seed: 7 });
    const b = spawnTraffic(MAGOK_NETWORK, CLOSED_ZONES, { seed: 7 });
    expect(a).toEqual(b);
  });

  it("차는 맵 안, 닫힌 구간 밖, 건물 밖에 놓이고 서로 겹치지 않는다", () => {
    const buildings = createMagokBuildings();
    const cars = spawnTraffic(MAGOK_NETWORK, CLOSED_ZONES, { buildings });
    for (const car of cars) {
      expect(Math.abs(car.x)).toBeLessThan(MAP_HALF_SIZE);
      expect(Math.abs(car.z)).toBeLessThan(MAP_HALF_SIZE);
      expect(CLOSED_ZONES.some((zone) => inZone(zone, car.x, car.z))).toBe(false);
    }
    for (let a = 0; a < cars.length; a++) {
      for (let b = a + 1; b < cars.length; b++) {
        expect(Math.hypot(cars[a].x - cars[b].x, cars[a].z - cars[b].z)).toBeGreaterThan(5);
      }
    }
  });

  it("모든 차는 자기 진행 방향의 오른쪽 차선에 있다", () => {
    for (const car of start.traffic) {
      const edge = MAGOK_NETWORK.edges[car.edge];
      const center = sampleEdge(edge, car.s);
      const right = rightOf(car.heading);
      const side = (car.x - center.x) * right.x + (car.z - center.z) * right.z;
      expect(side).toBeGreaterThan(0);
      expect(side).toBeLessThan(edge.width / 2);
    }
  });

  it("처음부터 출발 지점 근처 도로에 움직이는 차가 보인다", () => {
    const nearby = start.traffic.filter((car) => Math.abs(car.x) < 10 && car.z > 100 && car.z < 300);
    expect(nearby.length).toBeGreaterThanOrEqual(2);
    expect(nearby.every((car) => car.speed > 5)).toBe(true);
  });
});

describe("교통 차량 주행", () => {
  it("도로 등급에 맞는 속도로 달린다", () => {
    const primary = buildRoadNetwork([{ c: "primary", w: 13.2, p: [[0, -300], [0, 300]] }]);
    const fast = drive(spawnTraffic(primary, [], { count: 0, pins: [lanePin(-250)] }), primary, [], 12)[0];
    const slow = drive(spawnTraffic(STRAIGHT, [], { count: 0, pins: [lanePin(-250)] }), STRAIGHT, [], 12)[0];
    expect(fast.speed * 3.6).toBeGreaterThan(40);
    expect(fast.speed * 3.6).toBeLessThan(56);
    expect(slow.speed * 3.6).toBeGreaterThan(22);
    expect(slow.speed * 3.6).toBeLessThan(34);
  });

  it("같은 차선의 느린 앞차를 만나면 부딪히지 않고 간격을 두고 따라간다", () => {
    const cars = spawnTraffic(STRAIGHT, [], { count: 0, pins: [lanePin(-250), lanePin(-215)] });
    cars[1] = { ...cars[1], pace: 0.4 };
    let closest = Infinity;
    const end = drive(cars, STRAIGHT, [], 40, (now) => {
      closest = Math.min(closest, now[1].z - now[0].z);
    });
    expect(closest).toBeGreaterThan(4.5);
    expect(end[0].speed).toBeLessThan(5);
  });

  it("교차로에서 이어지는 도로로 계속 달리고 도로를 벗어나지 않는다", () => {
    const cross = buildRoadNetwork([
      { c: "tertiary", w: 9, p: [[-300, 0], [0, 0], [300, 0]] },
      { c: "tertiary", w: 9, p: [[0, -300], [0, 0], [0, 300]] },
    ]);
    const cars = spawnTraffic(cross, [], { count: 0, pins: [{ x: -250, z: 0, heading: Math.PI / 2, lane: 0 }] });
    const edges = new Set<number>();
    let worst = 0;
    drive(cars, cross, [], 90, (now) => {
      edges.add(now[0].edge);
      const nearest = nearestOnNetwork(cross, now[0].x, now[0].z)!;
      worst = Math.max(worst, nearest.distance - nearest.edge.width / 2);
    });
    expect(edges.size).toBeGreaterThan(1);
    expect(worst).toBeLessThan(2);
  });

  it("막다른 길 끝에서 되돌아 반대편 차선으로 나온다", () => {
    const dead = buildRoadNetwork([{ c: "tertiary", w: 9, p: [[0, -100], [0, 100]] }]);
    const cars = spawnTraffic(dead, [], { count: 0, pins: [lanePin(0)] });
    let farthest = 0;
    let worst = 0;
    const end = drive(cars, dead, [], 60, (now) => {
      farthest = Math.max(farthest, Math.abs(now[0].z));
      const nearest = nearestOnNetwork(dead, now[0].x, now[0].z)!;
      worst = Math.max(worst, nearest.distance - nearest.edge.width / 2);
    });
    expect(farthest).toBeLessThan(108);
    expect(farthest).toBeGreaterThan(60);
    expect(worst).toBeLessThan(1);
    expect(end[0].speed).toBeGreaterThan(1);
  });

  it("맵 가장자리에 닿으면 돌아서 맵 밖으로 나가지 않는다", () => {
    const edgeRoad = buildRoadNetwork([{ c: "tertiary", w: 9, p: [[0, 300], [0, 1000]] }]);
    const cars = spawnTraffic(edgeRoad, [], { count: 0, pins: [lanePin(600)] });
    let farthest = 0;
    const end = drive(cars, edgeRoad, [], 40, (now) => {
      farthest = Math.max(farthest, now[0].z);
    });
    expect(farthest).toBeLessThan(MAP_HALF_SIZE);
    expect(Math.cos(end[0].heading)).toBeLessThan(0);
  });

  it("닫힌 구간 앞에서 돌아서고 그 안으로 들어가지 않는다", () => {
    const zone: ClosedZone = { x: 0, z: 0, heading: 0, from: 100, to: 160, halfWidth: 7 };
    const cars = spawnTraffic(STRAIGHT, [zone], { count: 0, pins: [lanePin(0)] });
    let entered = false;
    const end = drive(cars, STRAIGHT, [zone], 40, (now) => {
      entered ||= inZone(zone, now[0].x, now[0].z);
    });
    expect(entered).toBe(false);
    expect(Math.cos(end[0].heading)).toBeLessThan(0);
  });

  it("마곡 전체에서 오래 달려도 맵과 도로 안에 머물고 점프대와 닫힌 구간에 들어가지 않는다", () => {
    const start = createSimulation({ roads: MAGOK_NETWORK, buildings: createMagokBuildings() });
    let samples = 0;
    let offRoad = 0;
    let outside = 0;
    let closed = 0;
    let climbed = 0;
    const end = drive(start.traffic, MAGOK_NETWORK, CLOSED_ZONES, 150, (now, t) => {
      if (Math.round(t / DT) % 30 !== 0) return;
      for (const car of now) {
        samples++;
        const nearest = nearestOnNetwork(MAGOK_NETWORK, car.x, car.z)!;
        if (nearest.distance - nearest.edge.width / 2 > 1.5) offRoad++;
        if (Math.abs(car.x) > MAP_HALF_SIZE || Math.abs(car.z) > MAP_HALF_SIZE) outside++;
        if (CLOSED_ZONES.some((zone) => inZone(zone, car.x, car.z))) closed++;
        if (rampHeightAt(car.x, car.z) > 0) climbed++;
      }
    });
    expect(outside).toBe(0);
    expect(closed).toBe(0);
    expect(climbed).toBe(0);
    expect(offRoad / samples).toBeLessThan(0.01);
    expect(end.filter((car) => car.speed > 1).length / end.length).toBeGreaterThan(0.9);
  });
});

/** A traffic car standing still, for collision checks. With no roads the traffic step leaves it alone. */
function parkedTraffic(x: number, z: number): TrafficCar {
  return {
    sizeX: 2,
    sizeZ: 4.5,
    height: 1.5,
    x,
    z,
    heading: 0,
    vx: 0,
    vz: 0,
    speed: 0,
    edge: 0,
    dir: 1,
    s: 0,
    lane: 0,
    pace: 1,
    seed: 1,
    turnCooldown: 0,
    waiting: 0,
    next: null,
  };
}

function step(state: SimState, seconds: number, each?: (state: SimState) => void) {
  let current = state;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    current = stepSimulation(current, IDLE_INPUT, DT);
    each?.(current);
  }
  return current;
}

describe("로드스터와 교통 차량의 충돌", () => {
  const traffic = spawnTraffic(STRAIGHT, [], { count: 0, pins: [lanePin(-200)] });
  const standing = (x: number): SimState => ({
    ...createSimulation({ roads: STRAIGHT, traffic }),
    position: { x, y: 0, z: -150 },
  });

  it("다가오는 교통 차량에 부딪히면 로드스터는 튕기며 속도를 잃고 덜컹인다", () => {
    let hit = false;
    let pushed = 0;
    step(standing(-2.25), 14, (state) => {
      hit ||= state.mode === "tumbling";
      pushed = Math.max(pushed, state.velocity.z);
    });
    expect(hit).toBe(true);
    expect(pushed).toBeGreaterThan(2);
  });

  it("부딪혀도 교통 차량은 밀리거나 방향이 바뀌지 않고 제 길을 간다", () => {
    const crashed = step(standing(-2.25), 14);
    const clear = step(standing(40), 14);
    expect(crashed.mode).not.toBe("lost");
    expect(crashed.traffic).toEqual(clear.traffic);
  });

  it("교통 차량의 옆면에 달려들면 통과하지 않고 튕겨 나온다", () => {
    const sideOn: SimState = {
      ...createSimulation({ traffic: [parkedTraffic(0, 0)] }),
      position: { x: -8, y: 0, z: 0 },
      heading: Math.PI / 2,
      velocity: { x: 12, y: 0, z: 0 },
      orientation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
    };
    let deepest = -Infinity;
    const end = step(sideOn, 4, (state) => {
      deepest = Math.max(deepest, state.position.x);
    });
    expect(deepest).toBeLessThan(0);
    expect(end.position.x).toBeLessThan(-1);
  });

  it("교통 차량 지붕에 반듯하게 내려앉을 수 있고 차 안으로 파묻히지 않는다", () => {
    const above: SimState = {
      ...createSimulation({ traffic: [parkedTraffic(50, 0)] }),
      mode: "airborne",
      position: { x: 50, y: 4, z: 0 },
    };
    const landed = step(above, 3);
    expect(landed.mode).toBe("driving");
    expect(landed.position.y).toBeCloseTo(1.5, 1);
  });

  it("R 키로 처음 위치로 돌아가도 교통 차량은 계속 달린다", () => {
    const start = createSimulation({ roads: MAGOK_NETWORK, buildings: createMagokBuildings() });
    const later = step(start, 5);
    const reset = stepSimulation(later, { ...IDLE_INPUT, reset: true }, DT);
    expect(reset.position).toEqual(start.position);
    expect(reset.traffic).toEqual(later.traffic);
    expect(reset.traffic).not.toEqual(start.traffic);
  });
});
