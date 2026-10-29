import { describe, expect, it } from "vitest";

import { MAGOK_NETWORK, createMagokBuildings } from "./magok";
import { RAMPS, rampHeightAt } from "./map";
import { RAMP_LENGTH, RAMP_WIDTH, rampLocal } from "./ramps";
import { nearestOnNetwork, sampleEdge } from "./roads";
import { buildingHeightAt } from "./world";

const [START_RAMP, ...JUMP_RAMPS] = RAMPS;

function pointOn(ramp: (typeof RAMPS)[number], along: number, across = 0) {
  const heading = ramp.heading ?? 0;
  return {
    x: ramp.x + Math.sin(heading) * along + Math.cos(heading) * across,
    z: ramp.z0 + Math.cos(heading) * along - Math.sin(heading) * across,
  };
}

describe("점프대 배치", () => {
  it("출발 지점 점프대 외에 열 개 안팎의 점프대가 더 있다", () => {
    expect(START_RAMP).toMatchObject({ x: 0, z0: 40 });
    expect(JUMP_RAMPS.length).toBeGreaterThanOrEqual(8);
    expect(JUMP_RAMPS.length).toBeLessThanOrEqual(12);
  });

  it("점프대끼리는 서로 150m 이상 떨어져 있다", () => {
    for (let i = 0; i < RAMPS.length; i++) {
      for (let j = i + 1; j < RAMPS.length; j++) {
        expect(Math.hypot(RAMPS[i].x - RAMPS[j].x, RAMPS[i].z0 - RAMPS[j].z0)).toBeGreaterThanOrEqual(150);
      }
    }
  });

  it("점프대는 도로 한가운데에서 도로 방향을 향한다", () => {
    for (const ramp of JUMP_RAMPS) {
      const road = nearestOnNetwork(MAGOK_NETWORK, ramp.x, ramp.z0)!;
      expect(road.distance).toBeLessThan(0.5);
      expect(road.edge.width).toBeGreaterThanOrEqual(RAMP_WIDTH);
      const tangent = sampleEdge(road.edge, road.s).heading;
      const difference = Math.atan2(
        Math.sin((ramp.heading ?? 0) - tangent),
        Math.cos((ramp.heading ?? 0) - tangent)
      );
      expect(Math.min(Math.abs(difference), Math.PI - Math.abs(difference))).toBeLessThan(0.1);
    }
  });

  it("점프대 앞 도로는 곧고 건물이 없어 도약 후 도로에 착지할 수 있다", () => {
    const buildings = createMagokBuildings();
    for (const ramp of JUMP_RAMPS) {
      for (let along = 0; along <= RAMP_LENGTH + 45; along += 5) {
        const center = pointOn(ramp, along);
        expect(buildingHeightAt(buildings, center.x, center.z)).toBe(0);
        expect(nearestOnNetwork(MAGOK_NETWORK, center.x, center.z)!.distance).toBeLessThan(2);
      }
    }
  });

  it("점프대는 맵 안쪽에 놓인다", () => {
    for (const ramp of JUMP_RAMPS) {
      const end = pointOn(ramp, RAMP_LENGTH + 45);
      expect(Math.max(Math.abs(ramp.x), Math.abs(ramp.z0), Math.abs(end.x), Math.abs(end.z))).toBeLessThan(700);
    }
  });
});

describe("방향이 있는 점프대", () => {
  const ramp = JUMP_RAMPS[0];

  it("출발 쪽에서는 지면과 같고 끝으로 갈수록 높아진다", () => {
    const start = pointOn(ramp, 0.01);
    const middle = pointOn(ramp, RAMP_LENGTH / 2);
    const end = pointOn(ramp, RAMP_LENGTH - 0.01);
    expect(rampHeightAt(start.x, start.z)).toBeCloseTo(0, 1);
    expect(rampHeightAt(middle.x, middle.z)).toBeCloseTo(ramp.height / 2, 1);
    expect(rampHeightAt(end.x, end.z)).toBeCloseTo(ramp.height, 1);
  });

  it("끝을 넘으면 급하게 떨어지고, 옆으로 벗어나면 점프대가 아니다", () => {
    const past = pointOn(ramp, RAMP_LENGTH + 1);
    const beside = pointOn(ramp, RAMP_LENGTH / 2, RAMP_WIDTH / 2 + 1);
    expect(rampHeightAt(past.x, past.z)).toBe(0);
    expect(rampHeightAt(beside.x, beside.z)).toBe(0);
  });

  it("점프대 좌표계에서 점의 위치를 구한다", () => {
    const point = pointOn(ramp, 7, 2);
    const local = rampLocal(ramp, point.x, point.z)!;
    expect(local.along).toBeCloseTo(7);
    expect(local.across).toBeCloseTo(2);
  });
});
