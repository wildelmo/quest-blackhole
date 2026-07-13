import * as THREE from 'three';
import { TOUR, PHYS } from './config.js';

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _q = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// Owns the virtual camera position (r_s units, universe frame), the rig yaw
// (snap turning rotates the universe), the cinematic tour, and all input.
export class Controls {
  constructor(renderer, camera, dom) {
    this.renderer = renderer;
    this.camera = camera;

    this.virtualPos = new THREE.Vector3(...TOUR.points[0]);
    this.rigQuat = new THREE.Quaternion();
    this.velocity = new THREE.Vector3(); // r_s per second, universe frame

    this.tourActive = true;
    this.tourT = 0;
    this.curve = new THREE.CatmullRomCurve3(
      TOUR.points.map((p) => new THREE.Vector3(...p)), true, 'centripetal');

    this.blinkAlpha = 0;      // snap-turn comfort blink, consumed by main.js
    this.snapped = false;     // true on the frame a snap turn happened
    this.speedScale = 1;

    this._keys = new Set();
    this._snapCooldown = 0;
    this._btnPrev = { A: false, B: false };
    this.onToggleHud = null;

    this._prevPos = this.virtualPos.clone();

    // --- desktop input ---
    this._yaw = 0; this._pitch = 0;
    this._dragging = false;
    dom.addEventListener('pointerdown', (e) => {
      this._dragging = true;
      this._px = e.clientX; this._py = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      this._yaw -= (e.clientX - this._px) * 0.0032;
      this._pitch -= (e.clientY - this._py) * 0.0032;
      this._pitch = Math.max(-1.5, Math.min(1.5, this._pitch));
      this._px = e.clientX; this._py = e.clientY;
    });
    dom.addEventListener('pointerup', () => { this._dragging = false; });
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this._keys.add(k);
      if (k === 't') this.tourActive = !this.tourActive;
      if (k === 'h' && this.onToggleHud) this.onToggleHud();
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.key.toLowerCase()));
    window.addEventListener('wheel', (e) => {
      this.speedScale = Math.max(0.2, Math.min(6, this.speedScale * (e.deltaY < 0 ? 1.15 : 0.87)));
    }, { passive: true });
  }

  // Point the desktop camera at the black hole (universe origin).
  aimAtHole() {
    const dirLocal = _v.copy(this.virtualPos).negate().normalize()
      .applyQuaternion(_q.copy(this.rigQuat).invert());
    this._yaw = Math.atan2(-dirLocal.x, -dirLocal.z);
    this._pitch = Math.asin(THREE.MathUtils.clamp(dirLocal.y, -1, 1));
  }

  _freeFlySpeed() {
    const r = this.virtualPos.length();
    return THREE.MathUtils.clamp((r - 2) * 0.14, 0.05, 4) * this.speedScale;
  }

  _applyMove(dirLocal, amount, dt) {
    // local direction → universe frame via rig yaw
    _v.copy(dirLocal).applyQuaternion(this.rigQuat);
    this.virtualPos.addScaledVector(_v, amount * dt);
    // never enter the horizon neighbourhood
    const r = this.virtualPos.length();
    const rMin = PHYS.B_CRIT * 1.35;
    if (r < rMin) this.virtualPos.multiplyScalar(rMin / r);
  }

  update(dt, xrFrame) {
    this.snapped = false;
    this._snapCooldown = Math.max(0, this._snapCooldown - dt);
    this.blinkAlpha = Math.max(0, this.blinkAlpha - dt * 5);

    const session = this.renderer.xr.getSession?.();
    let manualInput = false;

    if (session) {
      // ---------------- XR: thumbsticks ----------------
      for (const src of session.inputSources) {
        const axes = src.gamepad?.axes;
        if (!axes || axes.length < 4) continue;
        const sx = axes[2], sy = axes[3];
        const head = this.renderer.xr.getCamera();

        if (src.handedness === 'left') {
          if (Math.abs(sx) > 0.15 || Math.abs(sy) > 0.15) {
            manualInput = true;
            head.getWorldDirection(_fwd);            // local/display frame
            _right.crossVectors(_fwd, Y_AXIS).normalize();
            const speed = this._freeFlySpeed();
            this._applyMove(_fwd, -sy * speed, dt);  // stick fwd = fly fwd
            this._applyMove(_right, sx * speed, dt);
          }
        } else if (src.handedness === 'right') {
          if (Math.abs(sy) > 0.2) {
            manualInput = true;
            this._applyMove(Y_AXIS, -sy * this._freeFlySpeed() * 0.7, dt);
          }
          if (Math.abs(sx) > 0.65 && this._snapCooldown === 0) {
            const angle = (sx > 0 ? -1 : 1) * Math.PI / 6; // 30° snap
            this.rigQuat.premultiply(_q.setFromAxisAngle(Y_AXIS, angle));
            this._snapCooldown = 0.35;
            this.blinkAlpha = 1;
            this.snapped = true;
          }
          const btns = src.gamepad.buttons;
          const a = !!btns[4]?.pressed, b = !!btns[5]?.pressed;
          if (a && !this._btnPrev.A) this.tourActive = !this.tourActive;
          if (b && !this._btnPrev.B && this.onToggleHud) this.onToggleHud();
          this._btnPrev.A = a; this._btnPrev.B = b;
        }
      }
    } else {
      // ---------------- desktop: mouse look + WASDQE ----------------
      this.camera.rotation.set(this._pitch, this._yaw, 0, 'YXZ');
      const boost = this._keys.has('shift') ? 3 : 1;
      const speed = this._freeFlySpeed() * boost;
      this.camera.getWorldDirection(_fwd);
      _right.crossVectors(_fwd, Y_AXIS).normalize();
      let moved = false;
      if (this._keys.has('w')) { this._applyMove(_fwd, speed, dt); moved = true; }
      if (this._keys.has('s')) { this._applyMove(_fwd, -speed, dt); moved = true; }
      if (this._keys.has('a')) { this._applyMove(_right, -speed, dt); moved = true; }
      if (this._keys.has('d')) { this._applyMove(_right, speed, dt); moved = true; }
      if (this._keys.has('q')) { this._applyMove(Y_AXIS, -speed, dt); moved = true; }
      if (this._keys.has('e')) { this._applyMove(Y_AXIS, speed, dt); moved = true; }
      manualInput = moved;
    }

    if (manualInput) this.tourActive = false;

    if (this.tourActive) {
      this.tourT = (this.tourT + dt / TOUR.duration) % 1;
      const target = this.curve.getPointAt(this.tourT);
      // exponential glide → smooth join when the tour (re)engages
      this.virtualPos.lerp(target, 1 - Math.exp(-dt * 1.8));
    }

    if (dt > 0) {
      this.velocity.copy(this.virtualPos).sub(this._prevPos).divideScalar(dt);
      this._prevPos.copy(this.virtualPos);
    }
  }
}
