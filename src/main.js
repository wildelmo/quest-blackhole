import * as THREE from 'three';
import { XRButton } from 'three/examples/jsm/webxr/XRButton.js';
import { TIERS, DEFAULT_TIER_XR, DEFAULT_TIER_DESKTOP, DEFAULTS, POSES, params, numParam } from './config.js';
import { LensingPass } from './lensing/pass.js';
import { loadStarmap, makeBlackbodyLUT, skyLodBase } from './sky/textures.js';
import { makeDust, makeBlink, makeSkyRotation } from './scene.js';
import { Controls } from './controls.js';
import { Hud } from './hud.js';

// ------------------------------------------------------------ diagnostics ----

window.__consoleErrors = [];
const origError = console.error.bind(console);
console.error = (...a) => { window.__consoleErrors.push(a.join(' ')); origError(...a); };
window.addEventListener('error', (e) => window.__consoleErrors.push(String(e.message)));

function warn(msg) {
  const el = document.getElementById('warn');
  el.style.display = 'block';
  el.textContent = msg;
}

// ------------------------------------------------------------------ setup ----

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = numParam('exposure', DEFAULTS.exposure);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setFramebufferScaleFactor(1.0); // eye pass is cheap — keep it sharp
document.body.appendChild(renderer.domElement);
if (renderer.xr.setFoveation) renderer.xr.setFoveation(0.5);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 900);
scene.add(camera);

const lensing = new LensingPass();
lensing.setBlackbody(makeBlackbodyLUT());
lensing.setSkyRotation(makeSkyRotation());
lensing.setLook({
  cinematic: THREE.MathUtils.clamp(numParam('cine', DEFAULTS.cinematic), 0, 1),
  diskGain: numParam('disk', DEFAULTS.diskGain),
});
scene.background = lensing.texture;

const dust = makeDust();
scene.add(dust.object);
const blink = makeBlink(camera);
const controls = new Controls(renderer, camera, renderer.domElement);
const hud = new Hud(camera);
controls.onToggleHud = () => hud.toggle();

// Screenshot/verification mode: fixed pose, frozen time, deterministic.
const poseIdx = numParam('pose', 0);
const shotMode = params.has('shot');
if (poseIdx >= 1 && poseIdx <= POSES.length) {
  controls.virtualPos.set(...POSES[poseIdx - 1].pos);
  controls.tourActive = false;
  controls.aimAtHole();
} else {
  controls.aimAtHole();
}
if (params.has('tour') && numParam('tour', 1) === 0) controls.tourActive = false;
if (params.has('clean')) document.getElementById('overlay').style.display = 'none';

// --------------------------------------------------------- quality tiers ----

let tier = THREE.MathUtils.clamp(
  numParam('tier', DEFAULT_TIER_DESKTOP), 0, TIERS.length - 1);
let autoTier = !params.has('tier');

function applyTier() {
  const t = TIERS[tier];
  lensing.setQuality({ faceSize: t.faceSize, steps: t.steps, maxWind: t.maxWind });
  const sky = lensing.material.uniforms.uSky.value;
  if (sky?.image?.width) {
    lensing.material.uniforms.uSkyLod.value = skyLodBase(sky.image.width, t.faceSize);
  }
}

const frameTimes = [];
let tierHoldoff = 0;

function updateQuality(dt) {
  if (!autoTier) return;
  frameTimes.push(dt);
  if (frameTimes.length > 90) frameTimes.shift();
  tierHoldoff = Math.max(0, tierHoldoff - dt);
  if (frameTimes.length < 60 || tierHoldoff > 0) return;

  const sorted = [...frameTimes].sort((a, b) => a - b);
  const p75 = sorted[(sorted.length * 3 / 4) | 0];
  const budget = renderer.xr.isPresenting ? 1 / 72 : 1 / 60;
  if (p75 > budget * 1.25 && tier > 0) {
    tier--; applyTier(); tierHoldoff = 2.5; frameTimes.length = 0;
  } else if (p75 < budget * 0.62 && tier < TIERS.length - 1 && !renderer.xr.isPresenting) {
    tier++; applyTier(); tierHoldoff = 4; frameTimes.length = 0;
  } else if (p75 < budget * 0.55 && tier < 3 && renderer.xr.isPresenting) {
    // In XR, cap auto-upscale at 'high' — headroom keeps reprojection smooth.
    tier++; applyTier(); tierHoldoff = 4; frameTimes.length = 0;
  }
}

// -------------------------------------------------------------- XR entry ----

if (navigator.xr) {
  document.body.appendChild(XRButton.createButton(renderer, {
    optionalFeatures: ['high-refresh-rate'],
  }));
  renderer.xr.addEventListener('sessionstart', () => {
    document.getElementById('overlay').classList.add('hidden');
    tier = Math.min(numParam('tier', DEFAULT_TIER_XR), TIERS.length - 1);
    applyTier();
    lensing.markDirty();
  });
  renderer.xr.addEventListener('sessionend', () => {
    document.getElementById('overlay').classList.remove('hidden');
    tier = numParam('tier', DEFAULT_TIER_DESKTOP);
    applyTier();
  });
} else {
  warn('WebXR not available in this browser — desktop preview mode. ' +
       'Open this page in the Quest Browser for VR.');
}

// ------------------------------------------------------------ render loop ----

const clock = new THREE.Clock();
let simTime = numParam('t0', 40); // pre-sheared disk: filaments already streaked
let framesRendered = 0;

async function start() {
  const { texture, width, source } = await loadStarmap(renderer);
  lensing.setSky(texture, skyLodBase(width, TIERS[tier].faceSize), source === 'procedural' ? 2.6 : 2.2);
  if (source === 'procedural') {
    console.info('[sky] procedural fallback star field (NASA map not fetched yet)');
  } else {
    console.info(`[sky] loaded ${source} (${width}px)`);
  }
  applyTier();

  renderer.setAnimationLoop(render);
}

function render() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!shotMode) simTime += dt * DEFAULTS.timeScale;

  controls.update(dt);
  updateQuality(dt);
  blink.set(controls.blinkAlpha);

  const t = TIERS[tier];
  // Fast translation makes stale faces visibly disagree at seams — refresh
  // the cube faster while moving quickly.
  const speedBoost = controls.velocity.length() > 1.2 ? 2 : 1;
  lensing.update(renderer, {
    camPos: controls.virtualPos,
    rigQuat: controls.rigQuat,
    simTime,
    count: Math.min(6, t.facesPerFrame * speedBoost),
    forceAll: framesRendered === 0 || controls.snapped || shotMode,
  });

  dust.update(dt, controls.velocity, camera.position);

  hud.update(dt, [
    `fps ${(1 / Math.max(dt, 1e-4)).toFixed(0)}  tier ${TIERS[tier].name}`,
    `face ${t.faceSize}px  steps ${t.steps}  ${t.facesPerFrame}f/frame`,
    `r ${controls.virtualPos.length().toFixed(1)} rs  v ${controls.velocity.length().toFixed(2)} rs/s`,
    `${renderer.xr.isPresenting ? 'XR' : 'desktop'}  tour ${controls.tourActive ? 'on' : 'off'}`,
  ]);

  renderer.render(scene, camera);
  framesRendered++;
  if (shotMode && framesRendered >= 3) window.__shotReady = true;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

start().catch((e) => {
  console.error(e);
  warn(`Failed to start: ${e.message}`);
});
