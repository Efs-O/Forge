import { createPlayer } from './player.js';
import { createAsteroidManager } from './asteroids.js';
import { initUI, updateHUD, showGameOver, hideOverlay } from './ui.js';
import * as THREE from 'three';

// Global state
let running = false;
let gameOver = false;
let elapsed = 0;

// Constants
const CAMERA_Z = 10;

// Main objects
let scene, camera, renderer;
let player, asteroidManager;
let lastTime = 0;

function init() {
  // Create scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000022);

  // Create camera
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 0, CAMERA_Z);
  camera.lookAt(0, 0, 0);

  // Create renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setAnimationLoop(animate);
  document.body.appendChild(renderer.domElement);

  // Add lights
  const ambientLight = new THREE.AmbientLight(0x404040);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(0, 10, 10);
  scene.add(directionalLight);

  // Create player and asteroid manager
  player = createPlayer(scene);
  asteroidManager = createAsteroidManager(scene, player);

  // Event listeners
  window.addEventListener('resize', onWindowResize);
  document.getElementById('overlay').addEventListener('click', resetGame);

  // Start game
  running = true;
  gameOver = false;
  elapsed = 0;
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate(time) {
  const dt = (time - lastTime) / 1000; // Convert to seconds
  lastTime = time;

  if (running && !gameOver) {
    elapsed += dt;

    // Update game objects
    player.update(dt);
    asteroidManager.update(dt, elapsed);

    // Check collisions
    if (asteroidManager.checkCollision()) {
      gameOver = true;
      running = false;
      const finalScore = Math.floor(elapsed);
      showGameOver(finalScore);
    }

    // Update HUD
    const currentSpeed = 30 + 0.5 * elapsed;
    updateHUD(Math.floor(elapsed), currentSpeed);
  }

  renderer.render(scene, camera);
}

function resetGame() {
  if (!gameOver) return;

  // Tear down old renderer/listeners so init() does not stack canvases
  renderer.setAnimationLoop(null);
  renderer.domElement.remove();
  window.removeEventListener('resize', onWindowResize);
  document.getElementById('overlay').removeEventListener('click', resetGame);
  while(scene.children.length > 0){
    scene.remove(scene.children[0]);
  }

  // Reset global state
  running = true;
  gameOver = false;
  elapsed = 0;
  lastTime = 0;

  // Reinitialize game
  init();

  // Hide overlay
  hideOverlay();
}

// Initialize UI and start game when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initUI();
  init();
});