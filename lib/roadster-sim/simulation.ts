import { MAP_HALF_SIZE, groundHeightAt, groundNormalAt } from "./map";
import { CENTER_OF_MASS, hitsObstacleSide, lowestClearance, stepTumbling } from "./tumble";
import {
  IDENTITY,
  add,
  cross,
  dot,
  normalize,
  quatFromAxes,
  quatFromRotationVector,
  quatMultiply,
  quatNlerp,
  quatNormalize,
  rotate,
  scale,
  sub,
  vec,
  type Quat,
  type Vec3,
} from "./vec";

export type SimMode = "driving" | "airborne" | "tumbling" | "overturned" | "lost";

export type SimState = {
  mode: SimMode;
  position: Vec3;
  velocity: Vec3;
  orientation: Quat;
  /**
   * Rotation rate in rad/s. Airborne: about the car's own x (pitch), y and z (roll) axes.
   * Tumbling: about the world axes. Zero while driving.
   */
  angularVelocity: Vec3;
  /** How long a tumbling car has been nearly motionless, seconds. */
  restTime: number;
  /** Yaw of the car, radians. Forward is (sin h, 0, cos h). */
  heading: number;
  /** Remaining compressed air for the thrusters, 0 to 1. */
  thrustAir: number;
};

/**
 * throttle: +1 accelerates, -1 brakes then reverses. steer: +1 turns right. Both act on the ground only.
 * pitch: +1 raises the nose. roll: +1 rolls to the right. Both act in the air only.
 */
export type ControlInput = {
  throttle: number;
  steer: number;
  pitch: number;
  roll: number;
  thrust: boolean;
  reset: boolean;
};

export const IDLE_INPUT: ControlInput = {
  throttle: 0,
  steer: 0,
  pitch: 0,
  roll: 0,
  thrust: false,
  reset: false,
};

const WHEELBASE = 2.7;
const MAX_STEER = 0.5;
const MAX_SPEED = 70;
const MAX_REVERSE_SPEED = 12;
const ACCELERATION = 22;
const BRAKE_DECELERATION = 22;
const ROLLING_DRAG = 0.15;
const GRAVITY = 9.81;
const ORIENTATION_BLEND_RATE = 14;

const THRUST_ACCELERATION = 16;
const THRUST_AIR_BURN_PER_SECOND = 0.4;
const THRUST_AIR_REGEN_PER_SECOND = 0.2;
const AIR_CONTROL_AUTHORITY = 9;
const MAX_ANGULAR_SPEED = 4;
const ANGULAR_DAMPING = 0.6;
const AIR_DRAG = 0.02;
const LEVEL_LANDING_TILT_COS = Math.cos((25 * Math.PI) / 180);
const HARD_IMPACT_SPEED = 15;
const LIFT_OFF_TOLERANCE = 0.05;

export function createSimulation(): SimState {
  return {
    mode: "driving",
    position: vec(0, 0, 0),
    velocity: vec(0, 0, 0),
    orientation: IDENTITY,
    angularVelocity: vec(0, 0, 0),
    restTime: 0,
    heading: 0,
    thrustAir: 1,
  };
}

export function bodyAxes(state: SimState): { forward: Vec3; up: Vec3; right: Vec3 } {
  const forward = rotate(state.orientation, vec(0, 0, 1));
  const up = rotate(state.orientation, vec(0, 1, 0));
  return { forward, up, right: cross(forward, up) };
}

export function stepSimulation(state: SimState, input: ControlInput, dt: number): SimState {
  if (input.reset) return createSimulation();

  switch (state.mode) {
    case "overturned":
    case "lost":
      return state;
    case "tumbling":
      return stepTumbling(state, dt);
    case "airborne":
      return stepAirborne(state, input, dt);
    case "driving":
      return input.thrust && state.thrustAir > 0
        ? stepAirborne({ ...state, mode: "airborne" }, input, dt)
        : stepDriving(state, input, dt);
  }
}

function headingVector(heading: number): Vec3 {
  return vec(Math.sin(heading), 0, Math.cos(heading));
}

/** Unit tangent of the ground along the heading, following the slope under the car. */
function slopeTangent(heading: number, normal: Vec3): Vec3 {
  const h = headingVector(heading);
  return normalize(add(h, scale(normal, -dot(h, normal))));
}

function groundOrientation(heading: number, normal: Vec3): Quat {
  const forward = slopeTangent(heading, normal);
  const left = normalize(cross(normal, forward));
  return quatFromAxes(left, normal, forward);
}

function isOutOfBounds(position: Vec3) {
  return Math.abs(position.x) > MAP_HALF_SIZE || Math.abs(position.z) > MAP_HALF_SIZE;
}

function stepDriving(state: SimState, input: ControlInput, dt: number): SimState {
  const normal = groundNormalAt(state.position.x, state.position.z);
  const tangent = slopeTangent(state.heading, normal);
  let speed = dot(state.velocity, tangent);

  const accelerating = input.throttle > 0 && speed >= 0;
  const reversing = input.throttle < 0 && speed <= 0.5;
  if (accelerating) {
    speed += input.throttle * ACCELERATION * (1 - speed / MAX_SPEED) * dt;
  } else if (reversing) {
    speed += input.throttle * ACCELERATION * (1 + speed / MAX_REVERSE_SPEED) * 0.5 * dt;
    speed = Math.max(speed, -MAX_REVERSE_SPEED);
  } else if (input.throttle !== 0) {
    const braked = speed - Math.sign(speed) * BRAKE_DECELERATION * Math.abs(input.throttle) * dt;
    speed = Math.sign(braked) === Math.sign(speed) ? braked : 0;
  }
  speed -= ROLLING_DRAG * speed * dt;
  speed -= GRAVITY * tangent.y * dt;

  const steerAngle = (input.steer * MAX_STEER) / (1 + (speed / 25) ** 2);
  const heading = state.heading - (speed / WHEELBASE) * Math.tan(steerAngle) * dt;

  const velocity = scale(slopeTangent(heading, normal), speed);
  const moved = add(state.position, scale(velocity, dt));
  const groundY = groundHeightAt(moved.x, moved.z);
  const thrustAir = Math.min(1, state.thrustAir + THRUST_AIR_REGEN_PER_SECOND * dt);

  if (hitsObstacleSide(moved, state.orientation, velocity)) {
    return { ...state, mode: "tumbling", heading, thrustAir, velocity, restTime: 0 };
  }
  if (isOutOfBounds(moved)) {
    return { ...state, mode: "lost", heading, thrustAir, position: moved, velocity };
  }
  if (moved.y > groundY + LIFT_OFF_TOLERANCE) {
    return { ...state, mode: "airborne", heading, thrustAir, position: moved, velocity };
  }

  const position = vec(moved.x, groundY, moved.z);
  const target = groundOrientation(heading, groundNormalAt(position.x, position.z));
  const orientation = quatNlerp(
    state.orientation,
    target,
    1 - Math.exp(-ORIENTATION_BLEND_RATE * dt)
  );
  return { ...state, heading, thrustAir, position, velocity, orientation };
}

function clamp(value: number, limit: number) {
  return Math.max(-limit, Math.min(limit, value));
}

function stepAirborne(state: SimState, input: ControlInput, dt: number): SimState {
  const { up } = bodyAxes(state);
  let velocity = state.velocity;
  let thrustAir = state.thrustAir;

  if (input.thrust && thrustAir > 0) {
    const burn = Math.min(thrustAir, THRUST_AIR_BURN_PER_SECOND * dt);
    const fraction = burn / (THRUST_AIR_BURN_PER_SECOND * dt);
    velocity = add(velocity, scale(up, THRUST_ACCELERATION * fraction * dt));
    thrustAir -= burn;
  }
  velocity = add(velocity, vec(0, -GRAVITY * dt, 0));
  velocity = scale(velocity, Math.exp(-AIR_DRAG * dt));

  const damping = Math.exp(-ANGULAR_DAMPING * dt);
  const angularVelocity = vec(
    clamp((state.angularVelocity.x - input.pitch * AIR_CONTROL_AUTHORITY * dt) * damping, MAX_ANGULAR_SPEED),
    state.angularVelocity.y * damping,
    clamp((state.angularVelocity.z + input.roll * AIR_CONTROL_AUTHORITY * dt) * damping, MAX_ANGULAR_SPEED)
  );
  const orientation = quatNormalize(
    quatMultiply(state.orientation, quatFromRotationVector(scale(angularVelocity, dt)))
  );

  // The car turns about its center of mass, so its origin swings as the body rotates.
  const centerAfter = add(
    add(state.position, rotate(state.orientation, CENTER_OF_MASS)),
    scale(velocity, dt)
  );
  const moved = sub(centerAfter, rotate(orientation, CENTER_OF_MASS));
  const forward = rotate(orientation, vec(0, 0, 1));
  const heading =
    Math.hypot(forward.x, forward.z) > 0.3 ? Math.atan2(forward.x, forward.z) : state.heading;
  const next: SimState = {
    ...state,
    position: moved,
    velocity,
    orientation,
    angularVelocity,
    heading,
    thrustAir,
  };

  if (hitsObstacleSide(moved, orientation, velocity)) {
    return {
      ...next,
      mode: "tumbling",
      angularVelocity: rotate(orientation, angularVelocity),
      restTime: 0,
    };
  }
  if (isOutOfBounds(moved)) return { ...next, mode: "lost" };

  if (velocity.y <= 0 && lowestClearance(moved, orientation) <= 0) return touchDown(next);
  return next;
}

/** A level, gentle touchdown keeps driving; anything else becomes a bouncing, rolling impact. */
function touchDown(state: SimState): SimState {
  const normal = groundNormalAt(state.position.x, state.position.z);
  const { up } = bodyAxes(state);
  const impactSpeed = -state.velocity.y;

  if (dot(up, normal) >= LEVEL_LANDING_TILT_COS && impactSpeed < HARD_IMPACT_SPEED) {
    const groundY = groundHeightAt(state.position.x, state.position.z);
    return {
      ...state,
      mode: "driving",
      position: vec(state.position.x, groundY, state.position.z),
      velocity: add(state.velocity, scale(normal, -dot(state.velocity, normal))),
      angularVelocity: vec(0, 0, 0),
    };
  }
  return {
    ...state,
    mode: "tumbling",
    angularVelocity: rotate(state.orientation, state.angularVelocity),
    restTime: 0,
  };
}
