import * as THREE from 'three';

const POOL_SIZE = 50;
const ASTEROID_RADIUS = 1.5;
const BASE_ASTEROID_SPEED = 30;
const SPEED_PER_SECOND = 0.5;
const CAMERA_Z = 10;
const SPAWN_Z = -200;
const CORRIDOR_HALF_WIDTH = 10;
const CORRIDOR_HALF_HEIGHT = 6;

export function createAsteroidManager(scene, player) {
  const geometry = new THREE.SphereGeometry(ASTEROID_RADIUS, 8, 8);
  const material = new THREE.MeshStandardMaterial({ color: 0x888888 });

  const asteroids = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    asteroids.push(mesh);
  }

  let spawnTimer = 0;
  let spawnInterval = 0.5;

  function randomPosition() {
    const x = (Math.random() * 2 - 1) * CORRIDOR_HALF_WIDTH;
    const y = (Math.random() * 2 - 1) * CORRIDOR_HALF_HEIGHT;
    return { x, y };
  }

  function resetInternal() {
    for (const asteroid of asteroids) {
      const pos = randomPosition();
      // Stagger depth so the pool does not arrive as a single wall
      asteroid.position.set(pos.x, pos.y, SPAWN_Z + Math.random() * 180);
      asteroid.visible = true;
    }
    spawnTimer = 0;
  }

  resetInternal();

  return {
    update(dt, elapsed) {
      const currentSpeed = BASE_ASTEROID_SPEED + SPEED_PER_SECOND * elapsed;

      for (const asteroid of asteroids) {
        asteroid.position.z += currentSpeed * dt;

        if (asteroid.position.z > CAMERA_Z) {
          const pos = randomPosition();
          asteroid.position.set(pos.x, pos.y, SPAWN_Z - Math.random() * 60);
        }
      }
    },

    checkCollision() {
      const playerSphere = player.getBoundingSphere();
      const playerCenter = playerSphere.center;
      const sumRadii = playerSphere.radius + ASTEROID_RADIUS;

      for (const asteroid of asteroids) {
        const dx = asteroid.position.x - playerCenter.x;
        const dy = asteroid.position.y - playerCenter.y;
        const dz = asteroid.position.z - playerCenter.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (distance < sumRadii) {
          return true;
        }
      }

      return false;
    },

    reset() {
      resetInternal();
    }
  };
}
