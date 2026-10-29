import { describe, expect, it } from "vitest";

import {
  MAP_HALF_SIZE,
  bodyAxes,
  createSimulation,
  IDLE_INPUT,
  stepSimulation,
  type ControlInput,
  type SimState,
} from "@/lib/roadster-sim";

const DT = 1 / 60;

function run(
  state: SimState,
  seconds: number,
  input: Partial<ControlInput> | ((state: SimState, t: number) => Partial<ControlInput>)
): SimState {
  let current = state;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const partial = typeof input === "function" ? input(current, i * DT) : input;
    current = stepSimulation(current, { ...IDLE_INPUT, ...partial }, DT);
  }
  return current;
}

/** Start on open ground, clear of the ramp and the parked cars. */
function openField(): SimState {
  return { ...createSimulation(), position: { x: 60, y: 0, z: -100 } };
}

function speedOf(state: SimState) {
  return Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
}

describe("지면 주행", () => {
  it("시작하면 정지한 채 지면에 서 있고 추진 공기가 가득 차 있다", () => {
    const state = createSimulation();

    expect(state.mode).toBe("driving");
    expect(speedOf(state)).toBe(0);
    expect(state.position.y).toBe(0);
    expect(state.thrustAir).toBe(1);
  });

  it("가속 키를 누르면 앞으로 속도를 올려 이동한다", () => {
    const start = createSimulation();
    const state = run(start, 2, { throttle: 1 });

    expect(speedOf(state)).toBeGreaterThan(15);
    expect(state.position.z).toBeGreaterThan(start.position.z + 15);
  });

  it("가속 키를 떼도 관성으로 계속 움직이다가 서서히 느려진다", () => {
    const moving = run(openField(), 2, { throttle: 1 });
    const justAfter = run(moving, 0.2, {});
    const later = run(moving, 4, {});

    expect(speedOf(justAfter)).toBeGreaterThan(speedOf(moving) * 0.8);
    expect(speedOf(later)).toBeLessThan(speedOf(moving));
    expect(speedOf(later)).toBeGreaterThan(0);
  });

  it("제동하면 속도가 줄어 멈춘다", () => {
    const moving = run(openField(), 2, { throttle: 1 });
    const stopped = run(moving, 3, (s) => ({ throttle: speedOf(s) > 0.5 ? -1 : 0 }));

    expect(speedOf(stopped)).toBeLessThan(1);
  });

  it("달리는 중 오른쪽으로 조향하면 진행 방향이 오른쪽으로 꺾인다", () => {
    const start = createSimulation();
    const rightBefore = bodyAxes(start).right;
    const moving = run(start, 1.5, { throttle: 1 });
    const turned = run(moving, 1, { throttle: 1, steer: 1 });

    const sideways =
      (turned.position.x - moving.position.x) * rightBefore.x +
      (turned.position.z - moving.position.z) * rightBefore.z;
    expect(sideways).toBeGreaterThan(1);
  });

  it("멈춰 있을 때는 조향해도 방향이 바뀌지 않는다", () => {
    const start = createSimulation();
    const state = run(start, 1, { steer: 1 });

    expect(state.heading).toBeCloseTo(start.heading, 5);
  });
});

describe("추진 도약", () => {
  it("달리는 중 추진 키를 누르면 차체가 지면에서 떠올라 비행 상태가 된다", () => {
    const moving = run(openField(), 2, { throttle: 1 });
    const lifted = run(moving, 0.8, { throttle: 1, thrust: true });

    expect(lifted.mode).toBe("airborne");
    expect(lifted.position.y).toBeGreaterThan(1.5);
  });

  it("추진기를 쓰는 동안 추진 공기가 줄어든다", () => {
    const moving = run(openField(), 1, { throttle: 1 });
    const thrusting = run(moving, 0.5, { thrust: true });

    expect(thrusting.thrustAir).toBeLessThan(moving.thrustAir);
  });

  it("추진 공기가 바닥나면 추진 키를 눌러도 더 오르지 않고 내려온다", () => {
    const burnedOut = run(openField(), 6, { thrust: true });
    expect(burnedOut.thrustAir).toBe(0);

    const hovering: SimState = {
      ...burnedOut,
      mode: "airborne",
      position: { x: 60, y: 5, z: -100 },
      velocity: { x: 0, y: 0, z: 10 },
    };
    let peak = 0;
    run(hovering, 0.5, (s) => {
      peak = Math.max(peak, s.position.y);
      return { thrust: true };
    });

    expect(peak).toBeLessThanOrEqual(5);
  });

  it("추진 없이 공중에 뜬 차는 중력으로 내려와 바퀴로 착지하고 다시 주행 입력에 반응한다", () => {
    const moving = run(openField(), 2, { throttle: 1 });
    const lifted = run(moving, 0.6, { thrust: true });
    expect(lifted.mode).toBe("airborne");

    const landed = run(lifted, 6, {});
    expect(landed.mode).toBe("driving");
    expect(landed.position.y).toBe(0);

    const accelerated = run(landed, 1, { throttle: 1 });
    expect(speedOf(accelerated)).toBeGreaterThan(speedOf(landed));
  });

  it("지면에서 추진 공기가 5초 안에 가득 찰 만큼 빠르게 회복된다", () => {
    const spent = { ...createSimulation(), thrustAir: 0.2 };
    const recovered = run(spent, 2, {});

    expect(recovered.thrustAir).toBeGreaterThan(0.5);
    expect(recovered.thrustAir).toBeLessThanOrEqual(1);
  });
});

describe("공중 기동", () => {
  const highAirborne = () => {
    const moving = run(openField(), 2, { throttle: 1 });
    return run(moving, 2, { thrust: true });
  };

  it("공중에서 기수 올림 키를 누르면 기수가 들린다", () => {
    const before = highAirborne();
    const after = run(before, 0.4, { pitch: 1 });

    expect(bodyAxes(after).forward.y).toBeGreaterThan(bodyAxes(before).forward.y + 0.2);
  });

  it("공중에서 롤 키를 누르면 차체가 옆으로 굴러 뒤집힌다", () => {
    let lowestUp = 1;
    run(highAirborne(), 2, (s) => {
      lowestUp = Math.min(lowestUp, bodyAxes(s).up.y);
      return { roll: 1 };
    });

    expect(lowestUp).toBeLessThan(-0.9);
  });

  it("한 바퀴 돌고 바퀴로 돌아와 착지하면 주행을 이어 간다", () => {
    let phase: "rolling" | "upside-down" | "recovered" = "rolling";
    const flipped = run(highAirborne(), 12, (s) => {
      const axes = bodyAxes(s);
      if (phase === "rolling" && axes.up.y < -0.5) phase = "upside-down";
      if (phase === "upside-down" && axes.up.y > 0.8) phase = "recovered";
      if (phase !== "recovered") return { roll: 1 };
      // level the car out: push back against the remaining tilt and spin
      return { roll: Math.max(-1, Math.min(1, axes.right.y * 3 - s.angularVelocity.z * 0.5)) };
    });

    expect(phase).toBe("recovered");
    expect(flipped.mode).toBe("driving");
  });
});

describe("램프와 주차 차량", () => {
  it("램프에서 속도를 내 달려 오르면 추진 없이도 공중으로 도약한다", () => {
    let peak = 0;
    run(createSimulation(), 5, (s) => {
      peak = Math.max(peak, s.position.y);
      return { throttle: 1 };
    });

    expect(peak).toBeGreaterThan(4.5);
  });

  it("램프를 타고 도약하면 일렬로 세운 주차 차량 구간을 넘어 착지한다", () => {
    let firstLandingZ: number | undefined;
    let wasAirborne = false;
    run(createSimulation(), 8, (s) => {
      if (s.mode === "airborne") wasAirborne = true;
      if (wasAirborne && s.mode === "driving" && firstLandingZ === undefined) {
        firstLandingZ = s.position.z;
      }
      return { throttle: 1 };
    });

    expect(firstLandingZ).toBeGreaterThan(105);
  });

});

describe("주차 차량 충돌", () => {
  const nearCars = (z: number, speed: number): SimState => ({
    ...createSimulation(),
    position: { x: 0, y: 0, z },
    velocity: { x: 0, y: 0, z: speed },
  });

  const observe = (start: SimState, seconds: number) => {
    const modes = new Set<string>();
    let passedThrough = false;
    const end = run(start, seconds, (s) => {
      modes.add(s.mode);
      if (s.position.z >= s.obstacles[0].z) passedThrough = true;
      return {};
    });
    return { end, modes, passedThrough };
  };

  const startZ = createSimulation().obstacles.map((o) => o.z);

  it("빠르게 달려 부딪히면 차는 통과하지 못하고 주차 차량을 앞으로 밀어낸다", () => {
    const { end, modes, passedThrough } = observe(nearCars(62, 25), 6);

    expect(modes.has("tumbling")).toBe(true);
    expect(passedThrough).toBe(false);
    expect(end.obstacles[0].z).toBeGreaterThan(startZ[0] + 1.5);
  });

  it("맨 앞 차가 밀리면 뒤에 세워 둔 차들도 함께 밀려난다", () => {
    const { end } = observe(nearCars(62, 25), 8);

    expect(end.obstacles[4].z).toBeGreaterThan(startZ[4] + 0.5);
  });

  it("밀려난 차량은 마찰로 서서히 멈추고 서로 겹치지 않는다", () => {
    const { end } = observe(nearCars(62, 25), 20);

    for (const o of end.obstacles) expect(Math.hypot(o.vx, o.vz)).toBeLessThan(0.1);
    for (let i = 1; i < end.obstacles.length; i++) {
      expect(end.obstacles[i].z - end.obstacles[i - 1].z).toBeGreaterThan(4.4);
    }
  });

  it("약하게 닿으면 거의 밀리지 않고 차는 다시 주행 입력에 반응한다", () => {
    const { end } = observe(nearCars(70, 3), 6);
    expect(end.obstacles[0].z - startZ[0]).toBeLessThan(0.6);
    expect(end.mode).toBe("driving");

    const driven = run(end, 1, { throttle: -1 });
    expect(speedOf(driven)).toBeGreaterThan(1);
  });

  it("공중에서 옆면에 부딪혀도 통과하지 않는다", () => {
    const flying: SimState = {
      ...nearCars(68, 20),
      mode: "airborne",
      position: { x: 0, y: 0.9, z: 68 },
    };
    const { modes, passedThrough } = observe(flying, 8);

    expect(modes.has("tumbling")).toBe(true);
    expect(passedThrough).toBe(false);
  });

  it("차 지붕 위에는 반듯하게 내려앉아 계속 달릴 수 있다", () => {
    const above: SimState = {
      ...createSimulation(),
      mode: "airborne",
      position: { x: 0, y: 3.5, z: 90 },
    };
    const landed = run(above, 2, {});

    expect(landed.mode).toBe("driving");
    expect(landed.position.y).toBeCloseTo(1.5, 1);
  });
});

describe("착지 덜컹임", () => {
  const dropFrom = (height: number) => {
    const fall: SimState = {
      ...openField(),
      mode: "airborne",
      position: { x: 60, y: height, z: -100 },
      velocity: { x: 0, y: 0, z: 10 },
    };
    let lowest = 0;
    let highest = 0;
    const end = run(fall, 5, (s) => {
      lowest = Math.min(lowest, s.suspension);
      highest = Math.max(highest, s.suspension);
      return {};
    });
    return { end, lowest, highest };
  };

  it("반듯하게 떨어지면 차체가 눌렸다가 되돌아오며 덜컹이고 곧 가라앉는다", () => {
    const { end, lowest, highest } = dropFrom(10);

    expect(lowest).toBeLessThan(-0.05);
    expect(highest).toBeGreaterThan(0.005);
    expect(Math.abs(end.suspension)).toBeLessThan(0.01);
  });

  it("높은 곳에서 떨어질수록 더 많이 눌린다", () => {
    expect(dropFrom(25).lowest).toBeLessThan(dropFrom(3).lowest);
  });

  it("덜컹이는 중에도 가속 입력에 바로 반응하고, 평소 주행에서는 덜컹이지 않는다", () => {
    const fall: SimState = {
      ...openField(),
      mode: "airborne",
      position: { x: 60, y: 10, z: -100 },
      velocity: { x: 0, y: 0, z: 10 },
    };
    const landed = run(fall, 1.6, {});
    expect(landed.mode).toBe("driving");
    expect(speedOf(run(landed, 0.5, { throttle: 1 }))).toBeGreaterThan(speedOf(landed));

    expect(run(openField(), 3, { throttle: 1 }).suspension).toBe(0);
  });
});

describe("거친 착지", () => {
  const upsideDownAt = (y: number): SimState => ({
    ...openField(),
    mode: "airborne",
    position: { x: 60, y, z: -100 },
    orientation: { x: 0, y: 0, z: 1, w: 0 },
  });

  const record = (start: SimState, seconds: number) => {
    const modes = new Set<string>();
    let bounced = false;
    let touched = false;
    let lowest = Infinity;
    const end = run(start, seconds, (s) => {
      modes.add(s.mode);
      lowest = Math.min(lowest, s.position.y);
      if (s.mode === "tumbling") {
        if (touched && s.velocity.y > 0.3) bounced = true;
        touched = true;
      }
      return {};
    });
    return { end, modes, bounced, lowest };
  };

  it("뒤집힌 채 떨어지면 바로 멈추지 않고 튕기며 구른 뒤 지붕으로 멈춘다", () => {
    const { end, modes, bounced } = record(upsideDownAt(4), 10);

    expect(modes.has("tumbling")).toBe(true);
    expect(bounced).toBe(true);
    expect(end.mode).toBe("overturned");
    expect(speedOf(end)).toBeLessThan(0.5);
  });

  it("아주 높은 곳에서 반듯하게 떨어져도 착지 직후 멈추지 않고 바로 가속할 수 있다", () => {
    const fall: SimState = {
      ...openField(),
      mode: "airborne",
      position: { x: 60, y: 40, z: -100 },
      velocity: { x: 0, y: 0, z: 20 },
    };
    const landed = run(fall, 4, {});
    expect(landed.mode).toBe("driving");
    expect(speedOf(landed)).toBeGreaterThan(10);

    const accelerated = run(landed, 1, { throttle: 1 });
    expect(speedOf(accelerated)).toBeGreaterThan(speedOf(landed));
  });

  it("기울어 착지해 구르다가 바퀴로 서면, 멈추기를 기다리지 않고 속도가 남은 채 주행을 이어 간다", () => {
    const half = 0.52 / 2;
    const tilted: SimState = {
      ...openField(),
      mode: "airborne",
      position: { x: 60, y: 3, z: -100 },
      velocity: { x: 0, y: 0, z: 20 },
      orientation: { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) },
    };
    let tumbled = false;
    let resumedSpeed: number | undefined;
    run(tilted, 6, (s) => {
      if (s.mode === "tumbling") tumbled = true;
      if (tumbled && s.mode === "driving" && resumedSpeed === undefined) resumedSpeed = speedOf(s);
      return {};
    });

    expect(tumbled).toBe(true);
    expect(resumedSpeed).toBeGreaterThan(5);
  });

  it("어떤 각도로 비스듬히 달려와 떨어져도 지면을 뚫지 않고 안정적으로 멈춘다", () => {
    for (const roll of [0.8, 1.6, 2.4, 3.1]) {
      const half = roll / 2;
      const start: SimState = {
        ...openField(),
        mode: "airborne",
        position: { x: 60, y: 3, z: -100 },
        velocity: { x: 0, y: 0, z: 15 },
        orientation: { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) },
      };
      const { end, lowest } = record(start, 12);

      expect(["driving", "overturned"]).toContain(end.mode);
      expect(lowest).toBeGreaterThan(-0.2);
      expect(Number.isFinite(end.position.x + end.position.y + end.position.z)).toBe(true);
    }
  });

  it("공중에서 앞으로 돌아 곤두박질치듯 떨어져도 지면을 뚫지 않는다", () => {
    const half = 1.2 / 2;
    const start: SimState = {
      ...openField(),
      mode: "airborne",
      position: { x: 60, y: 4, z: -100 },
      velocity: { x: 0, y: 0, z: 20 },
      orientation: { x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) },
    };
    const { end, lowest } = record(start, 12);

    expect(["driving", "overturned"]).toContain(end.mode);
    expect(lowest).toBeGreaterThan(-0.2);
  });
});

describe("재시작", () => {
  const states: Array<[string, () => SimState]> = [
    ["주행 중", () => run(openField(), 1, { throttle: 1 })],
    ["비행 중", () => run(run(openField(), 1, { throttle: 1 }), 0.6, { thrust: true })],
    [
      "구르는 중",
      () => run({ ...openField(), mode: "airborne", position: { x: 60, y: 4, z: -100 }, orientation: { x: 0, y: 0, z: 1, w: 0 } }, 0.8, {}),
    ],
    [
      "멈춰 선 뒤",
      () => run({ ...openField(), mode: "airborne", position: { x: 60, y: 4, z: -100 }, orientation: { x: 0, y: 0, z: 1, w: 0 } }, 10, {}),
    ],
    ["맵 밖", () => run({ ...createSimulation(), position: { x: 0, y: 0, z: MAP_HALF_SIZE - 1 } }, 2, { throttle: 1 })],
  ];

  it.each(states)("%s에도 R 한 번으로 처음 위치에서 다시 시작한다", (_label, make) => {
    const before = make();
    const after = stepSimulation(before, { ...IDLE_INPUT, reset: true }, DT);

    expect(after.mode).toBe("driving");
    expect(after.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(after.thrustAir).toBe(1);
    expect(speedOf(after)).toBe(0);
  });

  it("맵 밖으로 나가면 길을 잃은 상태가 된다", () => {
    const edge: SimState = { ...createSimulation(), position: { x: 0, y: 0, z: MAP_HALF_SIZE - 1 } };

    expect(run(edge, 2, { throttle: 1 }).mode).toBe("lost");
  });
});
