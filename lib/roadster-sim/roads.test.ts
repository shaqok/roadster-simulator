import { describe, expect, it } from "vitest";

import { MAGOK_NETWORK } from "./magok";
import { buildRoadNetwork, laneLayout, laneMarkings, MIN_ROAD_WIDTH } from "./roads";

describe("차선 구성", () => {
  it("도로가 넓을수록 한 방향 차선이 많다", () => {
    expect(laneLayout(4.5).perDirection).toBe(1);
    expect(laneLayout(9).perDirection).toBe(1);
    expect(laneLayout(13.2).perDirection).toBe(2);
    expect(laneLayout(26.4).perDirection).toBe(4);
  });

  it("차선 폭은 도로 반쪽을 차선 수로 나눈 값이다", () => {
    const { perDirection, laneWidth } = laneLayout(26.4);
    expect(laneWidth * perDirection).toBeCloseTo(13.2);
  });
});

describe("도로망", () => {
  it("교차로에서 도로를 구간으로 나눈다", () => {
    const network = buildRoadNetwork([
      { c: "tertiary", w: 9, p: [[-100, 0], [0, 0], [100, 0]] },
      { c: "tertiary", w: 9, p: [[0, -100], [0, 0], [0, 100]] },
    ]);
    expect(network.edges).toHaveLength(4);
    expect(network.nodes.some((node) => node.ends.length === 4)).toBe(true);
  });

  it("폭이 좁은 도로와 버스 전용 도로는 제외한다", () => {
    const network = buildRoadNetwork([
      { c: "service", w: MIN_ROAD_WIDTH - 1, p: [[0, 0], [50, 0]] },
      { c: "busway", w: 7, p: [[0, 10], [50, 10]] },
      { c: "tertiary", w: 9, p: [[0, 20], [50, 20]] },
    ]);
    expect(network.edges).toHaveLength(1);
  });

  it("마곡 지도에서 교차로가 있는 연결된 도로망을 만든다", () => {
    expect(MAGOK_NETWORK.edges.length).toBeGreaterThan(100);
    expect(MAGOK_NETWORK.nodes.filter((node) => node.ends.length >= 3).length).toBeGreaterThan(20);
    expect(MAGOK_NETWORK.edges.every((edge) => edge.width >= MIN_ROAD_WIDTH)).toBe(true);
  });
});

describe("도로 차선 표시", () => {
  const straight = (width: number) =>
    buildRoadNetwork([{ c: "primary", w: width, p: [[0, -200], [0, 200]] }]);

  it("좁은 도로는 단일 노란 중앙선과 흰 가장자리선을 긋는다", () => {
    const lines = laneMarkings(straight(9));
    expect(lines.filter((line) => line.color === "yellow")).toHaveLength(1);
    expect(lines.filter((line) => line.color === "white")).toHaveLength(2);
  });

  it("넓은 도로는 이중 중앙선을 긋는다", () => {
    const yellow = laneMarkings(straight(26.4)).filter((line) => line.color === "yellow");
    expect(yellow).toHaveLength(2);
    expect(new Set(yellow.map((line) => line.x0)).size).toBe(2);
  });

  it("같은 방향 차선 사이에는 흰 점선을 긋고, 차선이 많을수록 점선 줄이 늘어난다", () => {
    const dividers = (width: number) =>
      new Set(
        laneMarkings(straight(width))
          .filter((line) => line.color === "white" && Math.abs(line.x0) < width / 2 - 1)
          .map((line) => line.x0.toFixed(2))
      ).size;
    expect(dividers(9)).toBe(0);
    expect(dividers(13.2)).toBe(2);
    expect(dividers(26.4)).toBe(6);
  });

  it("점선은 이어진 선이 아니라 끊어진 조각이다", () => {
    const dash = laneMarkings(straight(13.2)).filter(
      (line) => line.color === "white" && Math.abs(line.x0) < 5
    );
    expect(dash.length).toBeGreaterThan(10);
    expect(dash.every((line) => Math.abs(line.z1 - line.z0) <= 3.01)).toBe(true);
  });

  it("선은 도로 안쪽에만 그어진다", () => {
    for (const line of laneMarkings(straight(13.2))) {
      expect(Math.abs(line.x0)).toBeLessThanOrEqual(13.2 / 2);
    }
  });

  it("교차로 안에는 선을 긋지 않는다", () => {
    const cross = buildRoadNetwork([
      { c: "tertiary", w: 9, p: [[-200, 0], [0, 0], [200, 0]] },
      { c: "tertiary", w: 9, p: [[0, -200], [0, 0], [0, 200]] },
    ]);
    for (const line of laneMarkings(cross)) {
      for (const [x, z] of [
        [line.x0, line.z0],
        [line.x1, line.z1],
      ]) {
        expect(Math.hypot(x, z)).toBeGreaterThan(5);
      }
    }
  });

  it("마곡 도로 전체에 선이 그려진다", () => {
    const lines = laneMarkings(MAGOK_NETWORK);
    expect(lines.length).toBeGreaterThan(1000);
    expect(new Set(lines.map((line) => line.color))).toEqual(new Set(["white", "yellow"]));
  });
});
