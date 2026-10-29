"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  MAGOK_NETWORK,
  MAP_ATTRIBUTION,
  createMagokBuildings,
  createSimulation,
  stepSimulation,
  type SimMode,
  type SimState,
} from "@/lib/roadster-sim";

import { HANDLED_KEYS, attitudeJets, toControlInput } from "./controls";
import { createRoadsterScene } from "./scene";

const STEP = 1 / 120;
const MAX_FRAME = 0.1;
const HUD_INTERVAL_MS = 80;

type Hud = { mode: SimMode; speedKmh: number; thrustAir: number };

const INITIAL_HUD: Hud = { mode: "driving", speedKmh: 0, thrustAir: 1 };

const MODE_LABEL: Record<SimMode, string> = {
  driving: "주행",
  airborne: "비행",
  tumbling: "충돌",
  overturned: "전복",
  lost: "맵 밖",
};

const KEY_GUIDE: ReadonlyArray<readonly [string, string]> = [
  ["W / S", "가속 / 제동"],
  ["A / D", "조향"],
  ["Space", "추진기 분사"],
  ["↑ ↓", "공중에서 기수 내림 / 올림"],
  ["← →", "공중에서 좌 / 우 롤"],
  ["R", "언제든 처음 위치에서 재시작"],
];

export function RoadsterSimulator() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resetRequested = useRef(false);
  const [hud, setHud] = useState<Hud>(INITIAL_HUD);
  const [webglFailed, setWebglFailed] = useState(false);

  const requestReset = useCallback(() => {
    resetRequested.current = true;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let scene;
    try {
      scene = createRoadsterScene(canvas);
    } catch {
      queueMicrotask(() => setWebglFailed(true));
      return;
    }

    const pressed = new Set<string>();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!HANDLED_KEYS.has(event.code)) return;
      event.preventDefault();
      if (event.code === "KeyR") resetRequested.current = true;
      pressed.add(event.code);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      pressed.delete(event.code);
    };
    const onBlur = () => pressed.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(canvas.parentElement ?? canvas);

    let state: SimState = createSimulation({ buildings: createMagokBuildings(), roads: MAGOK_NETWORK });
    let accumulator = 0;
    let lastTime = performance.now();
    let lastHudTime = 0;
    let thrusting = false;
    let frame = 0;

    const tick = (now: number) => {
      const elapsed = Math.min((now - lastTime) / 1000, MAX_FRAME);
      lastTime = now;
      accumulator += elapsed;

      const input = { ...toControlInput(pressed), reset: false };
      while (accumulator >= STEP) {
        const stepInput = { ...input, reset: resetRequested.current };
        resetRequested.current = false;
        const next = stepSimulation(state, stepInput, STEP);
        thrusting = input.thrust && next.mode === "airborne" && next.thrustAir < state.thrustAir;
        state = next;
        accumulator -= STEP;
      }

      scene.update(
        state,
        { mainThrust: thrusting, jets: attitudeJets(input, state.mode === "airborne") },
        elapsed
      );

      if (now - lastHudTime >= HUD_INTERVAL_MS) {
        lastHudTime = now;
        setHud({
          mode: state.mode,
          speedKmh: Math.round(Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z) * 3.6),
          thrustAir: state.thrustAir,
        });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      observer.disconnect();
      scene.dispose();
    };
  }, []);

  const airPercent = Math.round(hud.thrustAir * 100);
  const needsReset = hud.mode === "overturned" || hud.mode === "lost";

  return (
    <div
      className="relative flex-1 overflow-hidden bg-background"
      data-testid="simulator"
      data-mode={hud.mode}
      data-speed-kmh={hud.speedKmh}
      data-thrust-air={airPercent}
    >
      <div className="absolute inset-0">
        <canvas ref={canvasRef} className="block size-full" aria-label="로드스터 주행 화면" />
      </div>

      {webglFailed ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <p className="max-w-sm text-center text-muted-foreground" role="alert">
            이 브라우저에서는 3D 화면을 열 수 없습니다. WebGL을 지원하는 PC 브라우저에서 다시 열어 주세요.
          </p>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="flex min-w-56 flex-col gap-3 rounded-lg border bg-background/80 p-4 backdrop-blur">
          <div className="flex items-baseline justify-between gap-6">
            <span className="text-sm text-muted-foreground">속도</span>
            <span className="font-mono text-3xl font-semibold tabular-nums" data-testid="speed">
              {hud.speedKmh}
              <span className="ml-1 text-sm font-normal text-muted-foreground">km/h</span>
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">추진 공기</span>
              <span className="font-mono tabular-nums" data-testid="thrust-air">
                {airPercent}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-label="추진 공기"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={airPercent}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full bg-primary" style={{ width: `${airPercent}%` }} />
            </div>
          </div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">상태</span>
            <span className="font-medium" data-testid="mode">
              {MODE_LABEL[hud.mode]}
            </span>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="pointer-events-auto bg-background/80 backdrop-blur"
          onClick={requestReset}
        >
          <RotateCcwIcon data-icon="inline-start" />
          재시작
        </Button>
      </div>

      {needsReset ? (
        <div className="pointer-events-none absolute inset-x-0 top-1/3 flex justify-center px-4">
          <p
            className="rounded-lg border bg-background/90 px-5 py-3 text-center font-medium backdrop-blur"
            role="status"
          >
            {hud.mode === "overturned" ? "차가 뒤집힌 채 멈췄습니다." : "맵 밖으로 나갔습니다."} R 키를
            누르면 처음 위치에서 다시 시작합니다.
          </p>
        </div>
      ) : null}

      <dl className="pointer-events-none absolute bottom-4 left-4 hidden gap-x-4 gap-y-1 rounded-lg border bg-background/80 p-3 text-sm backdrop-blur sm:grid sm:grid-cols-[auto_1fr]">
        {KEY_GUIDE.map(([key, description]) => (
          <div key={key} className="contents">
            <dt className="font-mono text-foreground">{key}</dt>
            <dd className="text-muted-foreground">{description}</dd>
          </div>
        ))}
      </dl>

      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noopener noreferrer"
        className="absolute right-3 bottom-2 rounded bg-background/80 px-2 py-1 text-xs text-muted-foreground backdrop-blur hover:text-foreground"
      >
        {MAP_ATTRIBUTION}
      </a>
    </div>
  );
}
