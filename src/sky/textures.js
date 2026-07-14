import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

// ------------------------------------------------------------- blackbody ----

// Kelvin → sRGB, classic Tanner Helland fit (fine for a display-referred ramp).
function kelvinToSrgb(kelvin) {
  const t = kelvin / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = Math.max(0, Math.min(255, 99.4708 * Math.log(t) - 161.1196));
    b = t <= 19 ? 0 : Math.max(0, Math.min(255, 138.5177 * Math.log(t - 10) - 305.0448));
  } else {
    r = Math.max(0, Math.min(255, 329.6987 * Math.pow(t - 60, -0.1332047)));
    g = Math.max(0, Math.min(255, 288.1222 * Math.pow(t - 60, -0.0755148)));
    b = 255;
  }
  return [r, g, b];
}

// 256×1 sRGB LUT covering 1000 K → 12000 K; hardware decodes to linear on sample.
export function makeBlackbodyLUT() {
  const N = 256;
  const data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const T = 1000 + (11000 * i) / (N - 1);
    const [r, g, b] = kelvinToSrgb(T);
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------- procedural star field ----

// Tiny value-noise for the Milky Way band.
function makeNoise(seed) {
  const perm = new Uint8Array(512);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 256; i++) perm[256 + i] = perm[i];
  const grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
  return (x, y) => {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const aa = perm[perm[xi] + yi], ab = perm[perm[xi] + yi + 1];
    const ba = perm[perm[xi + 1] + yi], bb = perm[perm[xi + 1] + yi + 1];
    const l = (a, b, t) => a + t * (b - a);
    return l(
      l(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
      l(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u), v) * 0.7 + 0.5;
  };
}

// Fallback sky: statistically plausible star field + Milky Way band,
// used until the NASA Deep Star Map asset has been fetched by CI.
export function makeProceduralStarmap({ width = 2048, seed = 7 } = {}) {
  const W = width, H = width >> 1;
  const data = new Uint8Array(W * H * 4);
  const noise = makeNoise(seed);
  const fbm = (x, y) => 0.6 * noise(x, y) + 0.28 * noise(x * 2.7 + 11, y * 2.7 + 5) +
                        0.14 * noise(x * 6.1 + 23, y * 6.1 + 42);

  // Milky Way band along the equator (galactic-style orientation).
  // Noise is sampled on a circle in the domain so it tiles across the
  // longitude wrap, and the latitude profile runs to zero smoothly (no
  // hard cutoff rows).
  for (let j = 0; j < H; j++) {
    const lat = ((j + 0.5) / H - 0.5) * Math.PI;
    const bandProfile = Math.exp(-Math.pow(lat / 0.24, 2));
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W) * 2 * Math.PI;
      const cx = Math.cos(lon) * 2.2, cy = Math.sin(lon) * 2.2;
      const wob = fbm(cx + 40, cy + lat * 4 + 7.3);
      const lane = Math.pow(fbm(cx * 2.1 + 80, cy * 2.1 + lat * 9 + 13), 2.2); // dust lanes
      let g = bandProfile * (0.35 + 0.85 * wob) * (1.0 - 0.75 * lane);
      g = Math.max(0, g) * 62;
      if (g < 0.5) continue;
      const k = (j * W + i) * 4;
      data[k] = Math.min(255, data[k] + g * 1.02);
      data[k + 1] = Math.min(255, data[k + 1] + g * 0.94);
      data[k + 2] = Math.min(255, data[k + 2] + g * 0.86);
    }
  }

  // Stars: uniform on the sphere, power-law brightness, blackbody tints.
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const count = Math.floor(W * H * 0.009);
  for (let n = 0; n < count; n++) {
    const z = rnd() * 2 - 1;                       // sin(lat), uniform on sphere
    const lon = rnd() * 2 * Math.PI;
    const j = Math.min(H - 1, Math.floor((Math.asin(z) / Math.PI + 0.5) * H));
    const i = Math.min(W - 1, Math.floor((lon / (2 * Math.PI)) * W));
    let lum = Math.pow(rnd(), 9) * 3.2 + Math.pow(rnd(), 2.2) * 0.12;
    // extra density inside the band
    if (Math.abs(z) < 0.25 && rnd() < 0.5) lum *= 1.6;
    const T = 2600 + Math.pow(rnd(), 1.6) * 9000;
    const [cr, cg, cb] = kelvinToSrgb(T);
    const splat = (px, py, w) => {
      if (py < 0 || py >= H) return;
      px = ((px % W) + W) % W; // wrap across the longitude seam
      const k = (py * W + px) * 4;
      data[k] = Math.min(255, data[k] + cr * lum * w);
      data[k + 1] = Math.min(255, data[k + 1] + cg * lum * w);
      data[k + 2] = Math.min(255, data[k + 2] + cb * lum * w);
    };
    splat(i, j, 1.0);
    if (lum > 0.55) { // small gaussian halo for the bright few
      splat(i + 1, j, 0.35); splat(i - 1, j, 0.35);
      splat(i, j + 1, 0.35); splat(i, j - 1, 0.35);
      splat(i + 1, j + 1, 0.16); splat(i - 1, j - 1, 0.16);
      splat(i + 1, j - 1, 0.16); splat(i - 1, j + 1, 0.16);
    }
  }
  for (let k = 3; k < data.length; k += 4) data[k] = 255;

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------ asset chain ----

function configureEquirect(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// Resolution → base LOD so one cube-face pixel starts near 1:1 with sky texels.
export function skyLodBase(skyWidth, faceSize) {
  return Math.max(0, Math.log2(skyWidth / (faceSize * 4)));
}

async function loadPNG(url) {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  configureEquirect(tex);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  if (tex.anisotropy !== undefined) tex.anisotropy = 8;
  return tex;
}

// Resolution order: optional NASA KTX2 (if the fetch workflow was run) →
// baked real HYG star catalog (ships in-repo) → procedural fallback.
// preferHiRes picks the 8k HYG map (desktop); XR defaults to the 4k for
// GPU-memory headroom. A `?sky=` param can force a specific source.
export async function loadStarmap(renderer, { preferHiRes = true, force } = {}) {
  const base = import.meta.env.BASE_URL;

  if (force !== 'hyg' && force !== 'procedural') {
    try {
      const loader = new KTX2Loader().setTranscoderPath(`${base}basis/`).detectSupport(renderer);
      const tex = await loader.loadAsync(`${base}assets/starmap_8k.ktx2`);
      loader.dispose();
      configureEquirect(tex);
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      return { texture: tex, width: tex.image.width, source: 'nasa-ktx2' };
    } catch { /* not fetched */ }
  }

  if (force !== 'procedural') {
    const order = preferHiRes
      ? ['starmap_hyg_8k.png', 'starmap_hyg_4k.png']
      : ['starmap_hyg_4k.png', 'starmap_hyg_8k.png'];
    for (const file of order) {
      try {
        const tex = await loadPNG(`${base}assets/${file}`);
        return { texture: tex, width: tex.image.width, source: `hyg-${file.includes('8k') ? '8k' : '4k'}` };
      } catch { /* try next */ }
    }
  }

  const tex = makeProceduralStarmap({ width: 4096 });
  return { texture: tex, width: tex.image.width, source: 'procedural' };
}
