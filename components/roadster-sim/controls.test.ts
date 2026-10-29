import { describe, expect, it } from "vitest";

import { attitudeJets, toControlInput } from "./controls";

const keys = (...codes: string[]) => new Set(codes);

describe("키보드 입력 변환", () => {
  it("아무 키도 누르지 않으면 모든 입력이 비어 있다", () => {
    expect(toControlInput(keys())).toEqual({
      throttle: 0,
      steer: 0,
      pitch: 0,
      roll: 0,
      thrust: false,
      reset: false,
    });
  });

  it("W와 위쪽 화살표는 가속, S와 아래쪽 화살표는 제동이다", () => {
    expect(toControlInput(keys("KeyW")).throttle).toBe(1);
    expect(toControlInput(keys("ArrowUp")).throttle).toBe(1);
    expect(toControlInput(keys("KeyS")).throttle).toBe(-1);
    expect(toControlInput(keys("ArrowDown")).throttle).toBe(-1);
    expect(toControlInput(keys("KeyW", "KeyS")).throttle).toBe(0);
  });

  it("D와 오른쪽 화살표는 오른쪽 조향, A와 왼쪽 화살표는 왼쪽 조향이다", () => {
    expect(toControlInput(keys("KeyD")).steer).toBe(1);
    expect(toControlInput(keys("ArrowRight")).steer).toBe(1);
    expect(toControlInput(keys("KeyA")).steer).toBe(-1);
    expect(toControlInput(keys("ArrowLeft")).steer).toBe(-1);
  });

  it("공중 자세 조절은 화살표 키만 쓰고 WASD는 쓰지 않는다", () => {
    expect(toControlInput(keys("ArrowDown")).pitch).toBe(1);
    expect(toControlInput(keys("ArrowUp")).pitch).toBe(-1);
    expect(toControlInput(keys("ArrowRight")).roll).toBe(1);
    expect(toControlInput(keys("ArrowLeft")).roll).toBe(-1);

    const wasd = toControlInput(keys("KeyW", "KeyA", "KeyS", "KeyD"));
    expect(wasd.pitch).toBe(0);
    expect(wasd.roll).toBe(0);
  });

  it("스페이스는 추진, R은 재시작이다", () => {
    expect(toControlInput(keys("Space")).thrust).toBe(true);
    expect(toControlInput(keys("KeyR")).reset).toBe(true);
  });
});

describe("자세 제어 분사", () => {
  it("공중에서 오른쪽 롤은 왼쪽 옆면 분사, 왼쪽 롤은 오른쪽 옆면 분사다", () => {
    expect(attitudeJets({ pitch: 0, roll: 1 }, true)).toMatchObject({ leftFlankDown: true, rightFlankDown: false });
    expect(attitudeJets({ pitch: 0, roll: -1 }, true)).toMatchObject({ leftFlankDown: false, rightFlankDown: true });
  });

  it("공중에서 기수 올림은 앞쪽 아래 분사, 기수 내림은 앞쪽 위 분사다", () => {
    expect(attitudeJets({ pitch: 1, roll: 0 }, true)).toMatchObject({ noseDown: true, noseUp: false });
    expect(attitudeJets({ pitch: -1, roll: 0 }, true)).toMatchObject({ noseDown: false, noseUp: true });
  });

  it("키를 떼거나 공중이 아니면 분사하지 않는다", () => {
    const none = { leftFlankDown: false, rightFlankDown: false, noseDown: false, noseUp: false };
    expect(attitudeJets({ pitch: 0, roll: 0 }, true)).toEqual(none);
    expect(attitudeJets({ pitch: 1, roll: 1 }, false)).toEqual(none);
  });
});
