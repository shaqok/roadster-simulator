import type { ControlInput } from "@/lib/roadster-sim";

/** Keys the simulator reacts to; the browser's default action is suppressed for these. */
export const HANDLED_KEYS: ReadonlySet<string> = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "KeyR",
]);

const axis = (keys: ReadonlySet<string>, positive: string[], negative: string[]) =>
  (positive.some((k) => keys.has(k)) ? 1 : 0) - (negative.some((k) => keys.has(k)) ? 1 : 0);

export function toControlInput(keys: ReadonlySet<string>): ControlInput {
  return {
    throttle: axis(keys, ["KeyW", "ArrowUp"], ["KeyS", "ArrowDown"]),
    steer: axis(keys, ["KeyD", "ArrowRight"], ["KeyA", "ArrowLeft"]),
    pitch: axis(keys, ["ArrowDown"], ["ArrowUp"]),
    roll: axis(keys, ["ArrowRight"], ["ArrowLeft"]),
    thrust: keys.has("Space"),
    reset: keys.has("KeyR"),
  };
}

/**
 * Which attitude jets fire. Each pushes the part of the car it sits on away from the direction it
 * points: a jet on the left flank firing down lifts the left side, which rolls the car to the right.
 */
export type AttitudeJets = {
  leftFlankDown: boolean;
  rightFlankDown: boolean;
  noseDown: boolean;
  noseUp: boolean;
};

export function attitudeJets(
  input: Pick<ControlInput, "pitch" | "roll">,
  airborne: boolean
): AttitudeJets {
  return {
    leftFlankDown: airborne && input.roll > 0,
    rightFlankDown: airborne && input.roll < 0,
    noseDown: airborne && input.pitch > 0,
    noseUp: airborne && input.pitch < 0,
  };
}
