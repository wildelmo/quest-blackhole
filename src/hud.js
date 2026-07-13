import * as THREE from 'three';

// Lightweight stats: a DOM box on desktop plus a small camera-locked canvas
// sprite in VR. Toggled with H (desktop) / B button (controller).
export class Hud {
  constructor(camera) {
    this.dom = document.getElementById('hud');
    this.visible = false;

    this.canvas = document.createElement('canvas');
    this.canvas.width = 512; this.canvas.height = 160;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, depthTest: false, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.094), mat);
    this.mesh.position.set(0, -0.18, -0.62);
    this.mesh.renderOrder = 90;
    this.mesh.visible = false;
    camera.add(this.mesh);

    this._acc = 0;
  }

  toggle() {
    this.visible = !this.visible;
    this.dom.style.display = this.visible ? 'block' : 'none';
    this.mesh.visible = this.visible;
  }

  update(dt, lines) {
    if (!this.visible) return;
    this._acc += dt;
    if (this._acc < 0.5) return;
    this._acc = 0;

    const text = lines.join('\n');
    this.dom.textContent = text;

    const c = this.ctx;
    c.clearRect(0, 0, 512, 160);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(0, 0, 512, 160);
    c.fillStyle = '#9fe8a8';
    c.font = '26px monospace';
    lines.forEach((l, i) => c.fillText(l, 12, 34 + i * 30));
    this.texture.needsUpdate = true;
  }
}
