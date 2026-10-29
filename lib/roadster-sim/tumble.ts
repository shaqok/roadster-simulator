import { OBSTACLES, groundHeightAt, groundNormalAt, rampHeightAt } from "./map";
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
const HOOD_HEIGHT = 0.65;

// Low nose and tail with a cabin set back from both ends, so a head-on hit lands below the car's
// center of mass and pitches the tail up instead of stopping it flat.
const CORNERS: readonly Vec3[] = [
  ...[0, HOOD_HEIGHT].flatMap((y) =>
    [-HALF_WIDTH, HALF_WIDTH].flatMap((x) => [-HALF_LENGTH, HALF_LENGTH].map((z) => vec(x, y, z)))
  ),
  ...[-1.1, 0.8].flatMap((z) => [-0.8, 0.8].map((x) => vec(x, HEIGHT, z))),
];

// Inverse principal moments of a uniform box of unit mass.
const INVERSE_INERTIA = vec(
  12 / (HEIGHT ** 2 + (2 * HALF_LENGTH) ** 2),
  12 / ((2 * HALF_WIDTH) ** 2 + (2 * HALF_LENGTH) ** 2),
  12 / ((2 * HALF_WIDTH) ** 2 + HEIGHT ** 2)
);

const GRAVITY = 9.81;
const RESTITUTION = 0.25;
const BODY_RESTITUTION = 0.15;
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

type Contact = { normal: Vec3; penetration: number; restitution: number };

const UPRIGHT_HANDOFF_COS = Math.cos((20 * Math.PI) / 180);
const WHEELS_DOWN_CONTACTS = 3;

/**
 * A body corner that is inside a parked car, with the face it should be pushed out through. Only
 * faces the corner is moving into are candidates, because the shallowest face is often the wrong
 * one: the roadster is almost as wide as a parked car, so a head-on hit is barely inside its sides.
 */
function obstacleContact(p: Vec3, velocity: Vec3): Contact | undefined {
  for (const o of OBSTACLES) {
    const dx = o.sizeX / 2 - Math.abs(p.x - o.x);
    const dz = o.sizeZ / 2 - Math.abs(p.z - o.z);
    const dy = o.height - p.y;
    if (dx <= 0 || dz <= 0 || dy <= 0) continue;

    const faces: Contact[] = [
      { normal: vec(0, 1, 0), penetration: dy, restitution: RESTITUTION },
      { normal: vec(Math.sign(p.x - o.x), 0, 0), penetration: dx, restitution: BODY_RESTITUTION },
      { normal: vec(0, 0, Math.sign(p.z - o.z)), penetration: dz, restitution: BODY_RESTITUTION },
    ];
    const entered = faces.filter((face) => dot(face.normal, velocity) < 0);
    const candidates = entered.length > 0 ? entered : faces;
    return candidates.reduce((best, face) => (face.penetration < best.penetration ? face : best));
  }
  return undefined;
}

/** True when a body corner has run into the side of a parked car rather than landing on top of it. */
export function hitsObstacleSide(position: Vec3, orientation: Quat, velocity: Vec3): boolean {
  return CORNERS.some((corner) => {
    const contact = obstacleContact(worldCorner(position, orientation, corner), velocity);
    return contact !== undefined && contact.normal.y === 0;
  });
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

  // Collect every corner that is touching or sinking into the ground or a parked car, then resolve
  // them together so a level landing stays level instead of tipping toward whichever is first.
  const touching: Array<Contact & { corner: Vec3 }> = [];
  for (const corner of CORNERS) {
    const p = worldCorner(position, orientation, corner);
    const groundPenetration = rampHeightAt(p.x, p.z) - p.y;
    if (groundPenetration >= -CONTACT_MARGIN) {
      touching.push({
        corner,
        normal: groundNormalAt(p.x, p.z),
        penetration: groundPenetration,
        restitution: RESTITUTION,
      });
    }
    const body = obstacleContact(p, velocity);
    if (body) touching.push({ corner, ...body });
  }
  const pushedOut = touching.filter((contact) => contact.penetration > 0);
  if (pushedOut.length > 0) {
    const total = pushedOut.reduce(
      (sum, contact) => add(sum, scale(contact.normal, contact.penetration)),
      vec(0, 0, 0)
    );
    position = add(position, scale(total, PENETRATION_CORRECTION / pushedOut.length));
  }

  const center = add(position, rotate(orientation, CENTER_OF_MASS));
  const contacts = touching.map(({ corner, normal, restitution }) => {
    const r = sub(worldCorner(position, orientation, corner), center);
    const approach = dot(add(velocity, cross(angularVelocity, r)), normal);
    const bounce = approach < -BOUNCE_THRESHOLD ? -restitution * approach : 0;
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

  // Give control back as soon as the car is sitting level on its wheels, even if it is still moving.
  const wheelsOnSurface = touching.filter(
    (contact) => contact.corner.y === 0 && contact.normal.y > 0.9
  ).length;
  const hitSomethingSideways = touching.some((contact) => contact.normal.y < 0.5);
  const up = rotate(orientation, vec(0, 1, 0));
  const surface = groundNormalAt(position.x, position.z);
  if (
    wheelsOnSurface >= WHEELS_DOWN_CONTACTS &&
    !hitSomethingSideways &&
    dot(up, surface) >= UPRIGHT_HANDOFF_COS
  ) {
    return resumeDriving(next);
  }
  return restTime >= REST_TIME ? settle(next) : next;
}

function resumeDriving(state: SimState): SimState {
  const normal = groundNormalAt(state.position.x, state.position.z);
  const forward = rotate(state.orientation, vec(0, 0, 1));
  const heading = Math.hypot(forward.x, forward.z) > 0.5 ? Math.atan2(forward.x, forward.z) : state.heading;
  return {
    ...state,
    mode: "driving",
    heading,
    position: vec(state.position.x, groundHeightAt(state.position.x, state.position.z), state.position.z),
    velocity: sub(state.velocity, scale(normal, dot(state.velocity, normal))),
    angularVelocity: vec(0, 0, 0),
    restTime: 0,
  };
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
