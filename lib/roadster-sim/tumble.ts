import {
  OBSTACLE_REACH,
  groundHeightAt,
  groundNormalAt,
  obstacleLocal,
  rampHeightAt,
  type ObstacleState,
  type Solids,
} from "./map";
import { buildingContact } from "./world";
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
// A parked car is a little heavier than the roadster, whose mass is 1 in the solver.
const OBSTACLE_INVERSE_MASS = 0.9;
const RESUME_JOLT_RATE = -1.2;
const RESTITUTION = 0.25;
const BODY_RESTITUTION = 0.15;
const BOUNCE_THRESHOLD = 1.5;
const MAX_ENTRY_DEPTH = 0.8;
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
export function lowestClearance(
  position: Vec3,
  orientation: Quat,
  solids: Solids
): number {
  let lowest = Infinity;
  for (const corner of CORNERS) {
    const p = worldCorner(position, orientation, corner);
    lowest = Math.min(lowest, p.y - groundHeightAt(p.x, p.z, solids));
  }
  return lowest;
}

function impulseResponse(orientation: Quat, r: Vec3, direction: Vec3): number {
  const angular = cross(applyInverseInertia(orientation, cross(r, direction)), r);
  return 1 + dot(angular, direction);
}

type Contact = { normal: Vec3; penetration: number; restitution: number; obstacle?: number };

const UPRIGHT_HANDOFF_COS = Math.cos((20 * Math.PI) / 180);
const WHEELS_DOWN_CONTACTS = 3;

/**
 * A body corner that is inside a parked or traffic car, with the face it should be pushed out
 * through. Only faces the corner is moving into are candidates, because the shallowest face is often
 * the wrong one: the roadster is almost as wide as a car, so a head-on hit is barely inside its
 * sides. Traffic cars come after the parked ones in the contact index, and their motion counts.
 */
function obstacleContact(p: Vec3, velocity: Vec3, solids: Solids): Contact | undefined {
  const parked = solids.obstacles.length;
  const traffic = solids.traffic ?? [];
  for (let index = 0; index < parked + traffic.length; index++) {
    const moving = index >= parked;
    const o = moving ? traffic[index - parked] : solids.obstacles[index];
    if (Math.abs(p.x - o.x) > OBSTACLE_REACH || Math.abs(p.z - o.z) > OBSTACLE_REACH) continue;
    const { across, along } = obstacleLocal(o, p.x, p.z);
    const dAcross = o.sizeX / 2 - Math.abs(across);
    const dAlong = o.sizeZ / 2 - Math.abs(along);
    const dy = o.height - p.y;
    if (dAcross <= 0 || dAlong <= 0 || dy <= 0) continue;

    const heading = o.heading ?? 0;
    const sideSign = Math.sign(across) || 1;
    const endSign = Math.sign(along) || 1;
    const faces: Contact[] = [
      { normal: vec(0, 1, 0), penetration: dy, restitution: RESTITUTION },
      {
        normal: vec(Math.cos(heading) * sideSign, 0, -Math.sin(heading) * sideSign),
        penetration: dAcross,
        restitution: BODY_RESTITUTION,
      },
      {
        normal: vec(Math.sin(heading) * endSign, 0, Math.cos(heading) * endSign),
        penetration: dAlong,
        restitution: BODY_RESTITUTION,
      },
    ];
    const approach = moving
      ? vec(velocity.x - (o as ObstacleState).vx, velocity.y, velocity.z - (o as ObstacleState).vz)
      : velocity;
    // A corner cannot have gone deeper than a step of travel, so a far face it is moving "into"
    // (the back of the car after a bounce) is not the one it crossed.
    const entered = faces.filter(
      (face) => dot(face.normal, approach) < 0 && face.penetration <= MAX_ENTRY_DEPTH
    );
    const candidates = entered.length > 0 ? entered : faces;
    const best = candidates.reduce((a, face) => (face.penetration < a.penetration ? face : a));
    return { ...best, obstacle: index };
  }

  // Buildings never move, so they carry no obstacle index and take the whole impact.
  const building = buildingContact(solids.buildings, p);
  if (building) {
    return {
      ...building,
      restitution: building.normal.y > 0 ? RESTITUTION : BODY_RESTITUTION,
    };
  }
  return undefined;
}

/** True when a body corner has run into the side of a parked car rather than landing on top of it. */
export function hitsObstacleSide(
  position: Vec3,
  orientation: Quat,
  velocity: Vec3,
  solids: Solids
): boolean {
  return CORNERS.some((corner) => {
    const contact = obstacleContact(worldCorner(position, orientation, corner), velocity, solids);
    return contact !== undefined && contact.normal.y === 0;
  });
}

/**
 * Advances a car that is bouncing and rolling after a rough landing. The body is a rigid box whose
 * corners collide with the ground; `angularVelocity` is in the world frame while tumbling.
 */
export function stepTumbling(state: SimState, dt: number): SimState {
  let { position, velocity, orientation, angularVelocity } = state;
  const obstacles: ObstacleState[] = state.obstacles.map((o) => ({ ...o }));
  const traffic = state.traffic;
  const solids: Solids = { obstacles, traffic, buildings: state.buildings };

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
        normal: groundNormalAt(p.x, p.z, solids),
        penetration: groundPenetration,
        restitution: RESTITUTION,
      });
    }
    const body = obstacleContact(p, velocity, solids);
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
  const obstacleVelocity = (index?: number): Vec3 => {
    if (index === undefined) return vec(0, 0, 0);
    const body = index < obstacles.length ? obstacles[index] : traffic[index - obstacles.length];
    return vec(body.vx, 0, body.vz);
  };

  const contacts = touching.map(({ corner, normal, restitution, obstacle }) => {
    const r = sub(worldCorner(position, orientation, corner), center);
    const relative = sub(add(velocity, cross(angularVelocity, r)), obstacleVelocity(obstacle));
    const approach = dot(relative, normal);
    const bounce = approach < -BOUNCE_THRESHOLD ? -restitution * approach : 0;
    return { r, normal, bounce, obstacle };
  });

  for (let iteration = 0; iteration < SOLVER_ITERATIONS && contacts.length > 0; iteration++) {
    let linear = vec(0, 0, 0);
    let angular = vec(0, 0, 0);
    const shoved = obstacles.map(() => ({ x: 0, z: 0 }));
    for (const { r, normal, bounce, obstacle } of contacts) {
      const pointVelocity = sub(
        add(velocity, cross(angularVelocity, r)),
        obstacleVelocity(obstacle)
      );
      const approach = dot(pointVelocity, normal);
      if (approach >= bounce) continue;

      // A shoved parked car shares the impact, so it soaks up part of it instead of the roadster.
      // Traffic cars keep their course, so the roadster takes the whole impact.
      const shovable = obstacle !== undefined && obstacle < obstacles.length;
      const otherInverseMass = shovable ? OBSTACLE_INVERSE_MASS : 0;
      const normalImpulse =
        (bounce - approach) /
        (impulseResponse(orientation, r, normal) + otherInverseMass) /
        contacts.length;
      let reaction = scale(normal, normalImpulse);
      linear = add(linear, reaction);
      angular = add(angular, applyInverseInertia(orientation, cross(r, reaction)));

      const slide = sub(pointVelocity, scale(normal, approach));
      const slideSpeed = Math.hypot(slide.x, slide.y, slide.z);
      if (slideSpeed > 1e-4) {
        const tangent = scale(slide, 1 / slideSpeed);
        const frictionImpulse = Math.min(
          slideSpeed /
            (impulseResponse(orientation, r, tangent) + otherInverseMass) /
            contacts.length,
          FRICTION * normalImpulse
        );
        const friction = scale(tangent, -frictionImpulse);
        linear = add(linear, friction);
        angular = add(angular, applyInverseInertia(orientation, cross(r, friction)));
        reaction = add(reaction, friction);
      }
      if (shovable) {
        shoved[obstacle].x -= reaction.x * OBSTACLE_INVERSE_MASS;
        shoved[obstacle].z -= reaction.z * OBSTACLE_INVERSE_MASS;
      }
    }
    velocity = add(velocity, linear);
    angularVelocity = add(angularVelocity, angular);
    shoved.forEach((delta, index) => {
      obstacles[index].vx += delta.x;
      obstacles[index].vz += delta.z;
    });
  }

  const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
  const spin = Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z);
  const resting = contacts.length > 0 && speed < REST_SPEED && spin < REST_SPIN;
  const restTime = resting ? state.restTime + dt : 0;

  const next: SimState = {
    ...state,
    position,
    velocity,
    orientation,
    angularVelocity,
    restTime,
    obstacles,
    suspension: 0,
    suspensionRate: 0,
  };

  // Give control back as soon as the car is sitting level on its wheels, even if it is still moving.
  const wheelsOnSurface = touching.filter(
    (contact) => contact.corner.y === 0 && contact.normal.y > 0.9
  ).length;
  const hitSomethingSideways = touching.some((contact) => contact.normal.y < 0.5);
  const up = rotate(orientation, vec(0, 1, 0));
  const surface = groundNormalAt(position.x, position.z, solids);
  if (
    wheelsOnSurface >= WHEELS_DOWN_CONTACTS &&
    !hitSomethingSideways &&
    dot(up, surface) >= UPRIGHT_HANDOFF_COS
  ) {
    return resumeDriving(next);
  }
  return restTime >= REST_TIME ? settle(next) : next;
}

function solidsOf(state: SimState): Solids {
  return { obstacles: state.obstacles, traffic: state.traffic, buildings: state.buildings };
}

function resumeDriving(state: SimState): SimState {
  const normal = groundNormalAt(state.position.x, state.position.z, solidsOf(state));
  const forward = rotate(state.orientation, vec(0, 0, 1));
  const heading = Math.hypot(forward.x, forward.z) > 0.5 ? Math.atan2(forward.x, forward.z) : state.heading;
  return {
    ...state,
    mode: "driving",
    heading,
    position: vec(
      state.position.x,
      groundHeightAt(state.position.x, state.position.z, solidsOf(state)),
      state.position.z
    ),
    velocity: sub(state.velocity, scale(normal, dot(state.velocity, normal))),
    angularVelocity: vec(0, 0, 0),
    restTime: 0,
    suspensionRate: RESUME_JOLT_RATE,
  };
}

function settle(state: SimState): SimState {
  const groundY = groundHeightAt(state.position.x, state.position.z, solidsOf(state));
  const normal = groundNormalAt(state.position.x, state.position.z, solidsOf(state));
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
