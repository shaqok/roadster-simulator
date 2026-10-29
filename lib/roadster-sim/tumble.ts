import { groundHeightAt, groundNormalAt } from "./map";
import {
  add,
  cross,
  dot,
  normalize,
  quatConjugate,
  quatFromRotationVector,
  quatMultiply,
  quatNormalize,
  rotate,
  scale,
  sub,
  vec,
  type Quat,
  type Vec3,
} from "./vec";
import type { SimState } from "./simulation";

/** Center of mass relative to the car's origin (the point between the wheels on the ground). */
export const CENTER_OF_MASS = vec(0, 0.55, 0);

const HALF_WIDTH = 0.95;
const HEIGHT = 1.1;
const HALF_LENGTH = 2.15;

const CORNERS: readonly Vec3[] = [0, HEIGHT].flatMap((y) =>
  [-HALF_WIDTH, HALF_WIDTH].flatMap((x) =>
    [-HALF_LENGTH, HALF_LENGTH].map((z) => vec(x, y, z))
  )
);

// Inverse principal moments of a uniform box of unit mass.
const INVERSE_INERTIA = vec(
  12 / (HEIGHT ** 2 + (2 * HALF_LENGTH) ** 2),
  12 / ((2 * HALF_WIDTH) ** 2 + (2 * HALF_LENGTH) ** 2),
  12 / ((2 * HALF_WIDTH) ** 2 + HEIGHT ** 2)
);

const GRAVITY = 9.81;
const RESTITUTION = 0.25;
const BOUNCE_THRESHOLD = 1.5;
const FRICTION = 0.6;
const ANGULAR_DAMPING = 0.15;
const SOLVER_ITERATIONS = 10;
const CONTACT_MARGIN = 0.02;
const PENETRATION_CORRECTION = 0.8;
const REST_SPEED = 0.4;
const REST_SPIN = 0.4;
const REST_TIME = 0.4;
const UPRIGHT_COS = Math.cos((35 * Math.PI) / 180);

function applyInverseInertia(orientation: Quat, v: Vec3): Vec3 {
  const local = rotate(quatConjugate(orientation), v);
  return rotate(
    orientation,
    vec(local.x * INVERSE_INERTIA.x, local.y * INVERSE_INERTIA.y, local.z * INVERSE_INERTIA.z)
  );
}

function worldCorner(position: Vec3, orientation: Quat, corner: Vec3): Vec3 {
  return add(position, rotate(orientation, corner));
}

/** Height of the lowest body corner above the ground beneath it; <= 0 means touching. */
export function lowestClearance(position: Vec3, orientation: Quat): number {
  let lowest = Infinity;
  for (const corner of CORNERS) {
    const p = worldCorner(position, orientation, corner);
    lowest = Math.min(lowest, p.y - groundHeightAt(p.x, p.z));
  }
  return lowest;
}

function impulseResponse(orientation: Quat, r: Vec3, direction: Vec3): number {
  const angular = cross(applyInverseInertia(orientation, cross(r, direction)), r);
  return 1 + dot(angular, direction);
}

/**
 * Advances a car that is bouncing and rolling after a rough landing. The body is a rigid box whose
 * corners collide with the ground; `angularVelocity` is in the world frame while tumbling.
 */
export function stepTumbling(state: SimState, dt: number): SimState {
  let { position, velocity, orientation, angularVelocity } = state;

  velocity = add(velocity, vec(0, -GRAVITY * dt, 0));
  angularVelocity = scale(angularVelocity, Math.exp(-ANGULAR_DAMPING * dt));

  const comBefore = add(position, rotate(orientation, CENTER_OF_MASS));
  const com = add(comBefore, scale(velocity, dt));
  orientation = quatNormalize(
    quatMultiply(quatFromRotationVector(scale(angularVelocity, dt)), orientation)
  );
  position = sub(com, rotate(orientation, CENTER_OF_MASS));

  // Collect every corner that is touching or sinking into the ground, then resolve them together
  // so a level landing stays level instead of tipping toward whichever corner is processed first.
  const touching: Array<{ corner: Vec3; normal: Vec3; penetration: number }> = [];
  let deepest = 0;
  for (const corner of CORNERS) {
    const p = worldCorner(position, orientation, corner);
    const penetration = groundHeightAt(p.x, p.z) - p.y;
    if (penetration < -CONTACT_MARGIN) continue;
    touching.push({ corner, normal: groundNormalAt(p.x, p.z), penetration });
    deepest = Math.max(deepest, penetration);
  }
  position = add(position, vec(0, deepest * PENETRATION_CORRECTION, 0));

  const center = add(position, rotate(orientation, CENTER_OF_MASS));
  const contacts = touching.map(({ corner, normal }) => {
    const r = sub(worldCorner(position, orientation, corner), center);
    const approach = dot(add(velocity, cross(angularVelocity, r)), normal);
    const bounce = approach < -BOUNCE_THRESHOLD ? -RESTITUTION * approach : 0;
    return { r, normal, bounce };
  });

  for (let iteration = 0; iteration < SOLVER_ITERATIONS && contacts.length > 0; iteration++) {
    let linear = vec(0, 0, 0);
    let angular = vec(0, 0, 0);
    for (const { r, normal, bounce } of contacts) {
      const pointVelocity = add(velocity, cross(angularVelocity, r));
      const approach = dot(pointVelocity, normal);
      if (approach >= bounce) continue;

      const normalImpulse = (bounce - approach) / impulseResponse(orientation, r, normal) / contacts.length;
      const impulse = scale(normal, normalImpulse);
      linear = add(linear, impulse);
      angular = add(angular, applyInverseInertia(orientation, cross(r, impulse)));

      const slide = sub(pointVelocity, scale(normal, approach));
      const slideSpeed = Math.hypot(slide.x, slide.y, slide.z);
      if (slideSpeed > 1e-4) {
        const tangent = scale(slide, 1 / slideSpeed);
        const frictionImpulse = Math.min(
          slideSpeed / impulseResponse(orientation, r, tangent) / contacts.length,
          FRICTION * normalImpulse
        );
        const friction = scale(tangent, -frictionImpulse);
        linear = add(linear, friction);
        angular = add(angular, applyInverseInertia(orientation, cross(r, friction)));
      }
    }
    velocity = add(velocity, linear);
    angularVelocity = add(angularVelocity, angular);
  }

  const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
  const spin = Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z);
  const resting = contacts.length > 0 && speed < REST_SPEED && spin < REST_SPIN;
  const restTime = resting ? state.restTime + dt : 0;

  const next: SimState = { ...state, position, velocity, orientation, angularVelocity, restTime };
  return restTime >= REST_TIME ? settle(next) : next;
}

function settle(state: SimState): SimState {
  const groundY = groundHeightAt(state.position.x, state.position.z);
  const normal = groundNormalAt(state.position.x, state.position.z);
  const up = rotate(state.orientation, vec(0, 1, 0));
  const still = { velocity: vec(0, 0, 0), angularVelocity: vec(0, 0, 0), restTime: 0 };

  if (dot(up, normal) < UPRIGHT_COS) {
    return { ...state, ...still, mode: "overturned" };
  }
  const forward = rotate(state.orientation, vec(0, 0, 1));
  const flat = normalize(vec(forward.x, 0, forward.z));
  const heading = Math.hypot(flat.x, flat.z) > 0.5 ? Math.atan2(flat.x, flat.z) : state.heading;
  return {
    ...state,
    ...still,
    mode: "driving",
    heading,
    position: vec(state.position.x, groundY, state.position.z),
  };
}
