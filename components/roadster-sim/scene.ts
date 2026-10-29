import * as THREE from "three";

import type { AttitudeJets } from "./controls";
import {
  MAP_HALF_SIZE,
  OBSTACLES,
  RAMPS,
  type Ramp,
  type SimState,
} from "@/lib/roadster-sim";

export type SceneEffects = { mainThrust: boolean; jets: AttitudeJets };

export type RoadsterScene = {
  update: (state: SimState, effects: SceneEffects, dt: number) => void;
  resize: () => void;
  dispose: () => void;
};

const BODY_RED = 0xc8102e;
const PARKED_COLORS = [0xe8e8ec, 0x1c1f26, 0x5c6bc0, 0xc9c9cf, 0x2f6f8f];

function box(w: number, h: number, d: number, color: number, y: number, z = 0) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2 })
  );
  mesh.position.set(0, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildRoadster(): THREE.Group {
  const group = new THREE.Group();
  group.add(box(1.9, 0.45, 4.3, BODY_RED, 0.58));
  group.add(box(1.7, 0.3, 1.8, BODY_RED, 0.95, -0.2));
  group.add(box(1.5, 0.28, 1.1, 0x10151c, 1.05, 0.1));

  const wheelGeometry = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 20);
  wheelGeometry.rotateZ(Math.PI / 2);
  const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.8 });
  for (const [x, z] of [
    [0.95, 1.35],
    [-0.95, 1.35],
    [0.95, -1.35],
    [-0.95, -1.35],
  ]) {
    const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
    wheel.position.set(x, 0.34, z);
    wheel.castShadow = true;
    group.add(wheel);
  }

  return group;
}

function buildRamp(ramp: Ramp) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(ramp.length, 0);
  shape.lineTo(ramp.length, ramp.height);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: ramp.width, bevelEnabled: false });
  geometry.translate(0, 0, -ramp.width / 2);
  geometry.rotateY(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x4a4d57, roughness: 0.7 })
  );
  mesh.position.set(ramp.x, 0, ramp.z0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Sun position relative to the car; the shadow camera follows the car so shadows stay sharp. */
const SUN_OFFSET = new THREE.Vector3(18, 120, -10);

function buildWorld(scene: THREE.Scene) {
  scene.background = new THREE.Color(0xa9c8e8);
  scene.fog = new THREE.Fog(0xa9c8e8, 80, 420);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7a5c, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.set(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -45;
  sun.shadow.camera.right = 45;
  sun.shadow.camera.top = 45;
  sun.shadow.camera.bottom = -45;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  const size = MAP_HALF_SIZE * 2;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(size * 3, size * 3),
    new THREE.MeshStandardMaterial({ color: 0x5f7a52, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(14, size),
    new THREE.MeshStandardMaterial({ color: 0x2e3036, roughness: 0.9 })
  );
  road.rotation.x = -Math.PI / 2;
  road.position.y = 0;
  road.receiveShadow = true;
  scene.add(road);

  const dashCount = Math.floor(size / 8);
  const dashes = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.3, 0.02, 3.5),
    new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }),
    dashCount
  );
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < dashCount; i++) {
    matrix.setPosition(0, 0.02, -MAP_HALF_SIZE + 4 + i * 8);
    dashes.setMatrixAt(i, matrix);
  }
  scene.add(dashes);

  const postsPerSide = 21;
  const posts = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.3, 0.3, 3, 8),
    new THREE.MeshBasicMaterial({ color: 0xff7a1a }),
    postsPerSide * 4
  );
  let index = 0;
  for (let i = 0; i < postsPerSide; i++) {
    const t = -MAP_HALF_SIZE + (i * size) / (postsPerSide - 1);
    for (const [x, z] of [
      [t, -MAP_HALF_SIZE],
      [t, MAP_HALF_SIZE],
      [-MAP_HALF_SIZE, t],
      [MAP_HALF_SIZE, t],
    ]) {
      matrix.setPosition(x, 1.5, z);
      posts.setMatrixAt(index++, matrix);
    }
  }
  scene.add(posts);

  for (const ramp of RAMPS) scene.add(buildRamp(ramp));

  OBSTACLES.forEach((obstacle, i) => {
    const color = PARKED_COLORS[i % PARKED_COLORS.length];
    const car = new THREE.Group();
    car.add(box(obstacle.sizeX, 0.9, obstacle.sizeZ, color, 0.65));
    car.add(box(obstacle.sizeX * 0.85, 0.5, obstacle.sizeZ * 0.5, 0x10151c, obstacle.height - 0.25));
    car.position.set(obstacle.x, 0, obstacle.z);
    scene.add(car);
  });

  return { sun };
}

type Nozzle = { at: [number, number, number]; aim: [number, number, number] };
type Jet = { nozzles: Nozzle[]; speed: number; life: number; size: number; perSecond: number };

// Thin white condensation trails from compressed air, like the demo footage: fast, narrow, quickly
// spreading and fading, rather than a solid flame.
const MAIN_JETS: Jet[] = [
  {
    // Four nozzles in the belly fire straight down, as in the footage: fat columns of vapor that
    // spread into a cloud when they reach the ground.
    nozzles: [
      [-0.6, 1.0],
      [0.6, 1.0],
      [-0.6, -1.0],
      [0.6, -1.0],
    ].map(([x, z]) => ({ at: [x, 0.1, z], aim: [0, -1, 0] })),
    speed: 13,
    life: 1.5,
    size: 0.5,
    perSecond: 45,
  },
];

const ATTITUDE_NOZZLES: Record<keyof AttitudeJets, Nozzle> = {
  leftFlankDown: { at: [1.0, 0.5, 0.2], aim: [0.45, -1, 0] },
  rightFlankDown: { at: [-1.0, 0.5, 0.2], aim: [-0.45, -1, 0] },
  noseDown: { at: [0, 0.35, 2.15], aim: [0, -1, 0.35] },
  noseUp: { at: [0, 0.9, 1.9], aim: [0, 1, 0.35] },
};

const MAX_VAPOR = 520;
const GROUND_CLOUD_HEIGHT = 0.3;
const GROUND_CLOUD_REACH = 7;

function createVaporTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.5, "rgba(255,255,255,0.45)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}

type Puff = { sprite: THREE.Sprite; velocity: THREE.Vector3; age: number; life: number; size: number };

function createVapor(scene: THREE.Scene) {
  const texture = createVaporTexture();
  const puffs: Puff[] = Array.from({ length: MAX_VAPOR }, () => {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0, depthWrite: false })
    );
    sprite.visible = false;
    scene.add(sprite);
    return { sprite, velocity: new THREE.Vector3(), age: 0, life: 0, size: 0 };
  });
  let cursor = 0;

  const emit = (origin: THREE.Vector3, direction: THREE.Vector3, carVelocity: THREE.Vector3, jet: Pick<Jet, "speed" | "life" | "size">) => {
    const puff = puffs[cursor];
    cursor = (cursor + 1) % puffs.length;
    puff.age = 0;
    puff.life = jet.life * (0.7 + Math.random() * 0.6);
    puff.size = jet.size;
    puff.velocity
      .copy(direction)
      .multiplyScalar(jet.speed * (0.8 + Math.random() * 0.4))
      .addScaledVector(carVelocity, 0.1)
      .add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.6));
    puff.sprite.position.copy(origin);
    puff.sprite.visible = true;
  };

  const advance = (dt: number) => {
    const drag = Math.exp(-1.6 * dt);
    for (const puff of puffs) {
      if (!puff.sprite.visible) continue;
      puff.age += dt;
      if (puff.age >= puff.life) {
        puff.sprite.visible = false;
        continue;
      }
      const t = puff.age / puff.life;
      puff.velocity.multiplyScalar(drag);
      puff.sprite.position.addScaledVector(puff.velocity, dt);
      if (puff.sprite.position.y < GROUND_CLOUD_HEIGHT) {
        puff.sprite.position.y = GROUND_CLOUD_HEIGHT;
        puff.velocity.y = 0;
        puff.velocity.x *= 1 + 0.6 * dt;
        puff.velocity.z *= 1 + 0.6 * dt;
      }
      puff.sprite.scale.setScalar(puff.size * (1 + 4 * t));
      (puff.sprite.material as THREE.SpriteMaterial).opacity = 0.7 * (1 - t) ** 1.5;
    }
  };

  const dispose = () => {
    puffs.forEach((puff) => puff.sprite.material.dispose());
    texture.dispose();
  };

  return { emit, advance, dispose };
}

export function createRoadsterScene(canvas: HTMLCanvasElement): RoadsterScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const { sun } = buildWorld(scene);
  const roadster = buildRoadster();
  scene.add(roadster);
  const vapor = createVapor(scene);
  let emitDebt = 0;

  const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 900);
  const lookTarget = new THREE.Vector3();
  let cameraReady = false;
  let cameraHeading = 0;
  let airBlend = 0;

  const resize = () => {
    const { clientWidth, clientHeight } = canvas.parentElement ?? canvas;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / Math.max(1, clientHeight);
    camera.updateProjectionMatrix();
  };
  resize();

  const emitVapor = (effects: SceneEffects, state: SimState, dt: number) => {
    const carVelocity = new THREE.Vector3(state.velocity.x, state.velocity.y, state.velocity.z);
    emitDebt += dt;
    const spawn = (nozzle: Nozzle, jet: Pick<Jet, "speed" | "life" | "size">, count: number) => {
      for (let i = 0; i < count; i++) {
        const origin = roadster.localToWorld(new THREE.Vector3(...nozzle.at));
        const direction = new THREE.Vector3(...nozzle.aim).normalize().applyQuaternion(roadster.quaternion);
        emit(origin, direction, carVelocity, jet);
      }
    };
    const emit = vapor.emit;
    if (effects.mainThrust) {
      for (const jet of MAIN_JETS) {
        const count = Math.round(jet.perSecond * emitDebt);
        for (const nozzle of jet.nozzles) spawn(nozzle, jet, count);
      }
    }
    if (effects.mainThrust && state.position.y < GROUND_CLOUD_REACH) {
      const still = new THREE.Vector3();
      const cloud = { speed: 4.5, life: 1.8, size: 1.1 };
      const puffs = Math.round(28 * emitDebt);
      for (let i = 0; i < puffs; i++) {
        const angle = Math.random() * Math.PI * 2;
        const origin = new THREE.Vector3(
          state.position.x + (Math.random() - 0.5) * 2,
          GROUND_CLOUD_HEIGHT,
          state.position.z + (Math.random() - 0.5) * 3
        );
        emit(origin, new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)), still, cloud);
      }
    }
    const small = { speed: 9, life: 0.55, size: 0.2 };
    const count = Math.round(55 * emitDebt);
    (Object.keys(ATTITUDE_NOZZLES) as Array<keyof AttitudeJets>).forEach((name) => {
      if (effects.jets[name]) spawn(ATTITUDE_NOZZLES[name], small, count);
    });
    if (emitDebt > 0.02) emitDebt = 0;
  };

  const update = (state: SimState, effects: SceneEffects, dt: number) => {
    const { position, orientation, heading } = state;
    roadster.position.set(position.x, position.y, position.z);
    roadster.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
    roadster.updateMatrixWorld();
    sun.target.position.set(position.x, 0, position.z);
    sun.position.set(position.x + SUN_OFFSET.x, SUN_OFFSET.y, position.z + SUN_OFFSET.z);
    emitVapor(effects, state, dt);
    vapor.advance(dt);

    // On the ground the camera follows the car's heading. In the air the body can pitch through
    // vertical, which flips its heading, so follow the direction of travel and keep the car in view.
    const inAir = state.mode !== "driving";
    const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    const targetHeading = !inAir
      ? heading
      : horizontalSpeed > 3
        ? Math.atan2(state.velocity.x, state.velocity.z)
        : cameraHeading;
    const turn = Math.atan2(Math.sin(targetHeading - cameraHeading), Math.cos(targetHeading - cameraHeading));
    cameraHeading += turn * (1 - Math.exp(-4 * dt));
    airBlend += ((inAir ? 1 : 0) - airBlend) * (1 - Math.exp(-3 * dt));

    const ahead = new THREE.Vector3(Math.sin(cameraHeading), 0, Math.cos(cameraHeading));
    const distance = 9.5 + 5 * airBlend;
    const height = 3.6 + 2.4 * airBlend;
    const center = new THREE.Vector3(position.x, position.y + 0.6, position.z);
    const desired = center.clone().addScaledVector(ahead, -distance);
    desired.y = Math.max(center.y + height, 1.2);
    const look = center.clone().addScaledVector(ahead, 6 * (1 - airBlend) + 1 * airBlend);
    if (!cameraReady) {
      camera.position.copy(desired);
      lookTarget.copy(look);
      cameraHeading = heading;
      cameraReady = true;
    } else {
      const k = 1 - Math.exp(-6 * dt);
      camera.position.lerp(desired, k);
      lookTarget.lerp(look, k);
    }
    camera.lookAt(lookTarget);
    renderer.render(scene, camera);
  };

  const dispose = () => {
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((m) => m.dispose());
      }
    });
    vapor.dispose();
    renderer.dispose();
  };

  return { update, resize, dispose };
}
