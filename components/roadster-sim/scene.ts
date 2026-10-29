import * as THREE from "three";

import {
  MAP_HALF_SIZE,
  OBSTACLES,
  RAMPS,
  type Ramp,
  type SimState,
} from "@/lib/roadster-sim";

export type RoadsterScene = {
  update: (state: SimState, thrusting: boolean, dt: number) => void;
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
  return mesh;
}

function buildRoadster() {
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
    group.add(wheel);
  }

  const plumeGeometry = new THREE.ConeGeometry(0.2, 2.2, 12);
  const plumeMaterial = new THREE.MeshBasicMaterial({
    color: 0xe8f4ff,
    transparent: true,
    opacity: 0.75,
  });
  const plumes = new THREE.Group();
  for (const x of [-0.7, -0.25, 0.25, 0.7]) {
    const plume = new THREE.Mesh(plumeGeometry, plumeMaterial);
    plume.rotation.x = -Math.PI / 2;
    plume.position.set(x, 0.65, -3.3);
    plumes.add(plume);
  }
  for (const z of [-0.8, 0.8]) {
    const plume = new THREE.Mesh(plumeGeometry, plumeMaterial);
    plume.position.set(0, -0.5, z);
    plume.scale.set(1.3, 0.8, 1.3);
    plume.rotation.x = Math.PI;
    plume.position.y = 0.15;
    plumes.add(plume);
  }
  plumes.visible = false;
  group.add(plumes);
  return { group, plumes };
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
  return mesh;
}

function buildWorld(scene: THREE.Scene) {
  scene.background = new THREE.Color(0xa9c8e8);
  scene.fog = new THREE.Fog(0xa9c8e8, 80, 420);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7a5c, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(60, 120, -40);
  scene.add(sun);

  const size = MAP_HALF_SIZE * 2;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(size * 3, size * 3),
    new THREE.MeshStandardMaterial({ color: 0x5f7a52, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);

  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(14, size),
    new THREE.MeshStandardMaterial({ color: 0x2e3036, roughness: 0.9 })
  );
  road.rotation.x = -Math.PI / 2;
  road.position.y = 0;
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
}

export function createRoadsterScene(canvas: HTMLCanvasElement): RoadsterScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  buildWorld(scene);
  const roadster = buildRoadster();
  scene.add(roadster.group);

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

  const update = (state: SimState, thrusting: boolean, dt: number) => {
    const { position, orientation, heading } = state;
    roadster.group.position.set(position.x, position.y, position.z);
    roadster.group.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
    roadster.plumes.visible = thrusting;
    if (thrusting) roadster.plumes.scale.setScalar(0.8 + Math.random() * 0.4);

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
    renderer.dispose();
  };

  return { update, resize, dispose };
}
