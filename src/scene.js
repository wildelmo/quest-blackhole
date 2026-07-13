import * as THREE from 'three';

// Near-field dust motes: the only true-3D (stereo) content — sells scale and
// motion while the lensed universe sits at optical infinity.
function makeDustSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeDust() {
  const COUNT = 900;
  const RANGE = 40;    // metres
  const MIN_DIST = 2.5; // keep motes out of the viewer's face
  const pos = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT * 3; i++) pos[i] = (Math.random() * 2 - 1) * RANGE;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x8fa3c8, size: 0.05, sizeAttenuation: true,
    map: makeDustSprite(), transparent: true, opacity: 0.3,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;

  const METERS_PER_RS = 11; // dust drift per unit of virtual motion

  return {
    object: points,
    update(dt, velocityRs, camPos) {
      if (dt <= 0) return;
      const arr = geo.attributes.position.array;
      const vx = -velocityRs.x * METERS_PER_RS * dt;
      const vy = -velocityRs.y * METERS_PER_RS * dt;
      const vz = -velocityRs.z * METERS_PER_RS * dt;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] += vx; arr[i + 1] += vy; arr[i + 2] += vz;
        let d2 = 0;
        for (let a = 0; a < 3; a++) {
          const c = camPos.getComponent(a);
          // wrap into a moving box centered on the viewer
          if (arr[i + a] - c > RANGE) arr[i + a] -= RANGE * 2;
          else if (arr[i + a] - c < -RANGE) arr[i + a] += RANGE * 2;
          d2 += (arr[i + a] - c) ** 2;
        }
        if (d2 < MIN_DIST * MIN_DIST) {
          // too close — push along the drift direction to the far side
          arr[i] += Math.sign(vx || 1) * MIN_DIST * 2;
          arr[i + 1] += MIN_DIST;
        }
      }
      geo.attributes.position.needsUpdate = true;
      const speed = velocityRs.length();
      mat.opacity = THREE.MathUtils.clamp(0.1 + speed * 0.3, 0.1, 0.34);
    },
  };
}

// Camera-locked black quad for snap-turn comfort blinks.
export function makeBlink(camera) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), mat);
  mesh.position.set(0, 0, -0.5);
  mesh.renderOrder = 100;
  mesh.visible = false;
  camera.add(mesh);
  return {
    set(alpha) {
      mat.opacity = alpha;
      mesh.visible = alpha > 0.01;
    },
  };
}

// Tilt of the galaxy band relative to the accretion-disk plane.
export function makeSkyRotation() {
  const m4 = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(THREE.MathUtils.degToRad(62), THREE.MathUtils.degToRad(23), 0));
  return new THREE.Matrix3().setFromMatrix4(m4);
}
