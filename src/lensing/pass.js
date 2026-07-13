import * as THREE from 'three';
import { PHYS } from '../config.js';
import fragSrc from './blackhole.frag.glsl?raw';
import vertSrc from './fullscreen.vert.glsl?raw';

// Renders the lensed universe into a cubemap centered on the viewer.
// The cube is sampled as the scene background by both eyes (content is at
// optical infinity → mono cube is stereo-correct), so head rotation costs
// nothing and the expensive shader is amortized round-robin over faces.
export class LensingPass {
  constructor() {
    this.faceSize = 768;
    this.rt = this._makeTarget(this.faceSize);

    const defines = [
      `#define B_CRIT ${PHYS.B_CRIT.toFixed(6)}`,
      `#define R_IN ${PHYS.R_ISCO.toFixed(2)}`,
      `#define R_OUT ${PHYS.R_DISK_OUT.toFixed(2)}`,
      `#define B_MARCH ${PHYS.B_MARCH.toFixed(2)}`,
    ].join('\n');

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vertSrc,
      fragmentShader: fragSrc.replace('//__DEFINES__', defines),
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCamPos: { value: new THREE.Vector3(30, 6, 0) },
        uBasis: { value: new THREE.Matrix3() },
        // CubeCamera face cameras use fov = -90 ("negative fov is not an
        // error"), which mirrors BOTH projection axes — replicate it here.
        uTanHalfFov: { value: new THREE.Vector2(-1, -1) },
        uTime: { value: 0 },
        uSteps: { value: 80 },
        uMaxWind: { value: 1.2 },
        uEscapeR: { value: PHYS.R_ESCAPE },
        uSky: { value: null },
        uSkyLod: { value: 0 },
        uSkyRot: { value: new THREE.Matrix3() },
        uSkyGain: { value: 2.2 },
        uBlackbody: { value: null },
        uCinematic: { value: 0.65 },
        uDiskGain: { value: 1.0 },
        uGlow: { value: 0.32 },
      },
    });

    // Fullscreen triangle.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(mesh);
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // A real CubeCamera is the source of truth for per-face orientation —
    // its child cameras carry whatever up/flip conventions the renderer needs.
    this.cubeCamera = new THREE.CubeCamera(0.1, 10, this.rt);
    this.faceBases = null; // THREE.Matrix3[6], lazily built once renderer is known

    // Universe yaw (snap turning rotates the universe around the viewer).
    this.rigQuat = new THREE.Quaternion();

    this.cursor = 0;          // next face to render
    this.cycleTime = 0;       // sim time latched at the start of a cube cycle
    this.cyclePos = new THREE.Vector3();
    this.cycleQuat = new THREE.Quaternion();
    this._latched = false;

    this._m4 = new THREE.Matrix4();
    this._m3 = new THREE.Matrix3();
    this._q = new THREE.Quaternion();
  }

  _makeTarget(size) {
    const rt = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    return rt;
  }

  get texture() { return this.rt.texture; }

  _buildFaceBases(renderer) {
    if (this.cubeCamera.coordinateSystem !== renderer.coordinateSystem &&
        typeof this.cubeCamera.updateCoordinateSystem === 'function') {
      this.cubeCamera.coordinateSystem = renderer.coordinateSystem;
      this.cubeCamera.updateCoordinateSystem();
    }
    this.cubeCamera.position.set(0, 0, 0);
    this.cubeCamera.updateMatrixWorld(true);
    this.faceBases = this.cubeCamera.children
      .filter((c) => c.isCamera)
      .slice(0, 6)
      .map((cam) => {
        cam.updateMatrixWorld(true);
        return new THREE.Matrix3().setFromMatrix4(cam.matrixWorld);
      });
    if (this.faceBases.length !== 6) {
      throw new Error('CubeCamera did not expose 6 face cameras');
    }
  }

  setSky(texture, lodBase, gain) {
    this.material.uniforms.uSky.value = texture;
    this.material.uniforms.uSkyLod.value = lodBase;
    if (gain !== undefined) this.material.uniforms.uSkyGain.value = gain;
    this.markDirty();
  }

  setBlackbody(lut) { this.material.uniforms.uBlackbody.value = lut; }

  setSkyRotation(matrix3) { this.material.uniforms.uSkyRot.value.copy(matrix3); }

  setQuality({ faceSize, steps, maxWind }) {
    if (faceSize && faceSize !== this.faceSize) {
      this.faceSize = faceSize;
      this.rt.setSize(faceSize, faceSize);
    }
    if (steps) this.material.uniforms.uSteps.value = steps;
    if (maxWind) this.material.uniforms.uMaxWind.value = maxWind;
    this.markDirty();
  }

  setLook({ cinematic, diskGain, glow }) {
    const u = this.material.uniforms;
    if (cinematic !== undefined) u.uCinematic.value = cinematic;
    if (diskGain !== undefined) u.uDiskGain.value = diskGain;
    if (glow !== undefined) u.uGlow.value = glow;
  }

  // Force the next update to restart the cycle at face 0 (fresh latch).
  markDirty() { this.cursor = 0; this._latched = false; }

  // Render `count` faces (or all 6 with forceAll). camPos in r_s units.
  update(renderer, { camPos, rigQuat, simTime, count = 2, forceAll = false }) {
    if (!this.faceBases) this._buildFaceBases(renderer);

    const u = this.material.uniforms;
    const n = forceAll ? 6 : Math.min(count, 6);

    const prevRT = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false; // offscreen pass must ignore the XR camera

    for (let j = 0; j < n; j++) {
      if (this.cursor === 0 || !this._latched) {
        // Latch state for the whole cube cycle so faces stay seam-consistent.
        this.cycleTime = simTime;
        this.cyclePos.copy(camPos);
        this.cycleQuat.copy(rigQuat ?? this.rigQuat);
        this._latched = true;
      }
      u.uTime.value = this.cycleTime;
      u.uCamPos.value.copy(this.cyclePos);

      this._m4.makeRotationFromQuaternion(this.cycleQuat);
      this._m3.setFromMatrix4(this._m4);
      // basis = rig * face  (columns transform local face rays into universe frame)
      u.uBasis.value.multiplyMatrices(this._m3, this.faceBases[this.cursor]);

      renderer.setRenderTarget(this.rt, this.cursor);
      renderer.render(this.fsScene, this.fsCam);

      this.cursor = (this.cursor + 1) % 6;
      if (this.cursor === 0) this._latched = false;
    }

    renderer.setRenderTarget(prevRT);
    renderer.xr.enabled = prevXr;
  }
}
