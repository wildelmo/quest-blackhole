import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

// HDR present + bloom for the direct (non-XR) render path. The lensing shader
// and the dust layer render into `hdr` (linear, optionally supersampled); this
// module extracts bright regions, blurs them at two scales for a soft wide
// glow, then composites with exposure + ACES filmic tonemap to the screen.
// Bloom is what sells the Interstellar disk's molten look.

function hdrRT(w, h, depth = false) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace, depthBuffer: depth,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  return rt;
}

const THRESH_FRAG = /* glsl */`
  uniform sampler2D tDiffuse; uniform float uThreshold, uSoft;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float k = smoothstep(uThreshold, uThreshold + uSoft, l);
    gl_FragColor = vec4(c * k, 1.0);
  }`;

const BLUR_FRAG = /* glsl */`
  uniform sampler2D tDiffuse; uniform vec2 uDir; // texel-sized step * direction
  varying vec2 vUv;
  void main() {
    // 9-tap Gaussian.
    float w[5]; w[0]=0.227027; w[1]=0.194595; w[2]=0.121622; w[3]=0.054054; w[4]=0.016216;
    vec3 s = texture2D(tDiffuse, vUv).rgb * w[0];
    for (int i = 1; i < 5; i++) {
      vec2 o = uDir * float(i);
      s += texture2D(tDiffuse, vUv + o).rgb * w[i];
      s += texture2D(tDiffuse, vUv - o).rgb * w[i];
    }
    gl_FragColor = vec4(s, 1.0);
  }`;

const COMPOSITE_FRAG = /* glsl */`
  uniform sampler2D tScene, tBloom1, tBloom2;
  uniform float uExposure, uBloom;
  varying vec2 vUv;
  vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
  vec3 toSRGB(vec3 c){ return mix(1.055*pow(max(c,0.0),vec3(1.0/2.4))-0.055, c*12.92, vec3(lessThanEqual(c,vec3(0.0031308)))); }
  void main() {
    vec3 scene = texture2D(tScene, vUv).rgb;
    vec3 bloom = texture2D(tBloom1, vUv).rgb * 0.6 + texture2D(tBloom2, vUv).rgb * 0.9;
    vec3 c = scene + bloom * uBloom;
    c = aces(c * uExposure);
    gl_FragColor = vec4(toSRGB(c), 1.0);
  }`;

const VERT = /* glsl */`varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`;

export class Present {
  constructor() {
    this.hdr = hdrRT(2, 2, true);          // full-res scene (depth for dust)
    this.b1a = hdrRT(2, 2); this.b1b = hdrRT(2, 2); // half-res bloom
    this.b2a = hdrRT(2, 2); this.b2b = hdrRT(2, 2); // quarter-res bloom

    const mk = (frag, uniforms) => new FullScreenQuad(new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
    }));
    this.qThresh = mk(THRESH_FRAG, { tDiffuse: { value: null }, uThreshold: { value: 1.0 }, uSoft: { value: 0.6 } });
    this.qBlur = mk(BLUR_FRAG, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.qComp = mk(COMPOSITE_FRAG, {
      tScene: { value: null }, tBloom1: { value: null }, tBloom2: { value: null },
      uExposure: { value: 1.15 }, uBloom: { value: 0.85 },
    });
    this._w = 2; this._h = 2;
  }

  setSize(w, h) {
    w = Math.max(2, w | 0); h = Math.max(2, h | 0);
    if (w === this._w && h === this._h) return;
    this._w = w; this._h = h;
    this.hdr.setSize(w, h);
    this.b1a.setSize(w >> 1, h >> 1); this.b1b.setSize(w >> 1, h >> 1);
    this.b2a.setSize(w >> 2, h >> 2); this.b2b.setSize(w >> 2, h >> 2);
  }

  setLook({ exposure, bloom, threshold }) {
    if (exposure !== undefined) this.qComp.material.uniforms.uExposure.value = exposure;
    if (bloom !== undefined) this.qComp.material.uniforms.uBloom.value = bloom;
    if (threshold !== undefined) this.qThresh.material.uniforms.uThreshold.value = threshold;
  }

  // Separable Gaussian: src → (H) tmp → (V) dst. tmp and dst must share size;
  // reading a higher-res src into a smaller tmp downsamples on the way.
  _blur(renderer, src, tmp, dst) {
    const uni = this.qBlur.material.uniforms;
    uni.tDiffuse.value = src.texture;
    uni.uDir.value.set(1 / dst.width, 0);
    renderer.setRenderTarget(tmp); this.qBlur.render(renderer);
    uni.tDiffuse.value = tmp.texture;
    uni.uDir.value.set(0, 1 / dst.height);
    renderer.setRenderTarget(dst); this.qBlur.render(renderer);
  }

  // Composite this.hdr (already rendered into) to the screen with bloom.
  composite(renderer) {
    const prevXr = renderer.xr.enabled;
    const prevAutoClear = renderer.autoClear;
    renderer.xr.enabled = false;
    renderer.autoClear = true;

    this.qThresh.material.uniforms.tDiffuse.value = this.hdr.texture;
    renderer.setRenderTarget(this.b1a); this.qThresh.render(renderer); // bright (half)
    this._blur(renderer, this.b1a, this.b1b, this.b1a);                // half-res glow
    this._blur(renderer, this.b1a, this.b2b, this.b2a);               // quarter-res wide glow

    const c = this.qComp.material.uniforms;
    c.tScene.value = this.hdr.texture;
    c.tBloom1.value = this.b1a.texture;
    c.tBloom2.value = this.b2a.texture;
    renderer.setRenderTarget(null);
    this.qComp.render(renderer);

    renderer.autoClear = prevAutoClear;
    renderer.xr.enabled = prevXr;
  }
}
