import * as THREE from 'three';

const PLAYER_SPEED = 12;
const BANK_ANGLE = 0.4;
const PLAYER_RADIUS = 1.0;
const PLAYER_Z = 0;
const CORRIDOR_HALF_WIDTH = 10;
const CORRIDOR_HALF_HEIGHT = 6;

const keys = new Set();

window.addEventListener('keydown', (e) => keys.add(e.key));
window.addEventListener('keyup', (e) => keys.delete(e.key));

/**
 * Creates the player ship mesh and handles its movement and collision logic.
 * @param {THREE.Scene} scene - The Three.js scene to add the player to.
 * @returns {Object} The Player object with update, getPosition, and getBoundingSphere methods.
 */
export function createPlayer(scene) {
  const geometry = new THREE.BoxGeometry(2, 1, 4);
  const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  const ship = new THREE.Mesh(geometry, material);
  ship.position.set(0, 0, PLAYER_Z);
  scene.add(ship);

  /**
   * Returns a fresh Vector3 containing the ship's world position.
   * @returns {THREE.Vector3}
   */
  const getPosition = () => {
    return new THREE.Vector3(ship.position.x, ship.position.y, PLAYER_Z);
  };

  /**
   * Returns the player's bounding sphere for collision detection.
   * @returns {{center: THREE.Vector3, radius: number}}
   */
  const getBoundingSphere = () => {
    return {
      center: getPosition(),
      radius: PLAYER_RADIUS
    };
  };

  /**
   * Updates the ship's position and rotation based on keyboard input.
   * @param {number} dt - Delta time in seconds.
   */
  const update = (dt) => {
    let vx = 0;
    let vy = 0;

    if (keys.has('ArrowLeft') || keys.has('a') || keys.has('A')) vx -= PLAYER_SPEED;
    if (keys.has('ArrowRight') || keys.has('d') || keys.has('D')) vx += PLAYER_SPEED;
    if (keys.has('ArrowUp') || keys.has('w') || keys.has('W')) vy += PLAYER_SPEED;
    if (keys.has('ArrowDown') || keys.has('s') || keys.has('S')) vy -= PLAYER_SPEED;

    ship.position.x += vx * dt;
    ship.position.y += vy * dt;

    // Clamp movement to corridor bounds
    ship.position.x = Math.max(-CORRIDOR_HALF_WIDTH, Math.min(CORRIDOR_HALF_WIDTH, ship.position.x));
    ship.position.y = Math.max(-CORRIDOR_HALF_HEIGHT, Math.min(CORRIDOR_HALF_HEIGHT, ship.position.y));

    // Apply banking tilt proportional to lateral velocity
    // If moving right (vx > 0), tilt right (negative rotation.z)
    // If moving left (vx < 0), tilt left (positive rotation.z)
    ship.rotation.z = -(vx / PLAYER_SPEED) * BANK_ANGLE;
  };

  return {
    update,
    getPosition,
    getBoundingSphere
  };
}
