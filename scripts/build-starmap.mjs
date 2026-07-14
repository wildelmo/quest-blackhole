// Bake a photorealistic equirectangular star map from the HYG star catalog
// (real Hipparcos/Yale/Gliese stars: true positions, magnitudes, B-V colors).
// Renders point-spread stars (not hard dots), diffraction spikes on bright
// stars, and Milky Way nebulosity driven by the real galactic-plane star
// density. Output is a PNG committed to public/assets — the app never needs
// the catalog at runtime.
//
// Catalog: astronexus/HYG-Database (public domain).
// Usage: node scripts/build-starmap.mjs [--size 8192] [--out public/assets/starmap_hyg_8k.png]
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const W = parseInt(arg('size', '8192'), 10);
const H = W >> 1;
const OUT = arg('out', `public/assets/starmap_hyg_${W >= 8192 ? '8k' : W >= 4096 ? '4k' : W}.png`);
const CSV = arg('csv', 'hyg_v41.csv');
const CSV_URL = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv';

// ---------------------------------------------------------------- catalog ----

async function loadCatalog() {
  if (!existsSync(CSV)) {
    process.stderr.write(`Downloading HYG catalog → ${CSV}\n`);
    const res = await fetch(CSV_URL);
    if (!res.ok) throw new Error(`HYG download failed: ${res.status}`);
    writeFileSync(CSV, Buffer.from(await res.arrayBuffer()));
  }
  const text = readFileSync(CSV, 'utf8');
  const lines = text.split('\n');
  const head = lines[0].split(',').map((s) => s.replace(/"/g, ''));
  const ci = { ra: head.indexOf('ra'), dec: head.indexOf('dec'), mag: head.indexOf('mag'), bv: head.indexOf('ci') };
  const stars = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(',');
    const ra = +c[ci.ra], dec = +c[ci.dec], mag = +c[ci.mag];
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(mag)) continue;
    if (i === 1 && mag === 0) continue; // Sol (id 0) sits at the origin — skip
    const bv = Number.isFinite(+c[ci.bv]) ? +c[ci.bv] : 0.6;
    stars.push({ ra, dec, mag, bv });
  }
  return stars;
}

// ------------------------------------------------------------------ color ----

// B-V color index → temperature (Ballesteros 2012) → normalized linear RGB.
function bvToLinearRGB(bv) {
  bv = Math.max(-0.4, Math.min(2.0, bv));
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  return kelvinLinear(T);
}
function kelvinLinear(T) {
  // Blackbody chromaticity (Krystek approx) → linear RGB, normalized to max=1.
  const t = Math.max(1000, Math.min(40000, T)) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708 * Math.log(t) - 161.1196; }
  else { r = 329.6987 * Math.pow(t - 60, -0.1332); g = 288.1222 * Math.pow(t - 60, -0.0755); }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177 * Math.log(t - 10) - 305.0448;
  const srgb = [r, g, b].map((v) => Math.max(0, Math.min(255, v)) / 255);
  // sRGB → linear, then renormalize so hue is preserved but peak = 1
  const lin = srgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const m = Math.max(...lin, 1e-4);
  return lin.map((v) => v / m);
}

// ------------------------------------------------------------------ noise ----

function makeNoise(seed) {
  const p = new Uint8Array(512);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 256; i++) p[256 + i] = p[i];
  const grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
  return (x, y) => {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const aa = p[p[xi] + yi], ba = p[p[xi + 1] + yi], ab = p[p[xi] + yi + 1], bb = p[p[xi + 1] + yi + 1];
    const l = (a, b, t) => a + t * (b - a);
    return l(l(grad(aa, xf, yf), grad(ba, xf - 1, yf), u), l(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u), v) * 0.5 + 0.5;
  };
}

// --------------------------------------------------------------- rendering ----

// Equatorial (RA hours, Dec deg) → galactic (l, b) so the Milky Way — where
// the real stars concentrate — lands as a horizontal band on the equirect
// equator (the classic dramatic framing). J2000 constants.
const D2R = Math.PI / 180;
const A_NGP = 192.85948 * D2R, D_NGP = 27.12825 * D2R, L_NCP = 122.93192 * D2R;
function project(raHours, decDeg) {
  const a = raHours / 24 * 2 * Math.PI, d = decDeg * D2R;
  const sb = Math.sin(d) * Math.sin(D_NGP) + Math.cos(d) * Math.cos(D_NGP) * Math.cos(a - A_NGP);
  const b = Math.asin(Math.max(-1, Math.min(1, sb)));
  const l = L_NCP - Math.atan2(
    Math.cos(d) * Math.sin(a - A_NGP),
    Math.sin(d) * Math.cos(D_NGP) - Math.cos(d) * Math.sin(D_NGP) * Math.cos(a - A_NGP));
  const lon = ((l / (2 * Math.PI)) % 1 + 1) % 1;
  return [lon * W, (0.5 - b / Math.PI) * H];
}

function main(stars) {
  process.stderr.write(`Rendering ${stars.length} stars → ${W}×${H}\n`);
  const acc = new Float32Array(W * H * 3); // linear-light accumulation

  // ---- 1. nebulosity: coarse real star-density → blur → fractal modulation
  const DW = 1024, DH = 512;
  const dens = new Float32Array(DW * DH);
  for (const st of stars) {
    const [px, py] = project(st.ra, st.dec);
    const dx = Math.min(DW - 1, (px / W * DW) | 0);
    const dy = Math.min(DH - 1, (py / H * DH) | 0);
    dens[dy * DW + dx] += Math.pow(2.512, -st.mag * 0.35); // faint stars contribute glow
  }
  const blurred = boxBlurWrap(dens, DW, DH, 9, 3);
  let dmax = 0; for (const v of blurred) if (v > dmax) dmax = v;
  const n1 = makeNoise(11), n2 = makeNoise(29), n3 = makeNoise(53);
  const fbm = (x, y) => 0.55 * n1(x, y) + 0.28 * n2(x * 2.3, y * 2.3) + 0.17 * n3(x * 4.7, y * 4.7);
  for (let y = 0; y < H; y++) {
    const fy = y / H * DH;
    for (let x = 0; x < W; x++) {
      const band = bilinearWrap(blurred, DW, DH, x / W * DW, fy) / dmax;
      if (band < 0.004) continue;
      const u = x / W, v = y / H;
      const cloud = fbm(u * 6.0, v * 12.0);        // stretched along the band
      const fine = fbm(u * 18 + 7, v * 30 + 3);
      const lane = Math.pow(fbm(u * 16 + 40, v * 26 + 13), 2.2); // dark dust lanes
      let g = Math.pow(band, 1.25) * (0.30 + 0.9 * cloud + 0.25 * fine) * (1 - 0.78 * lane);
      g = Math.max(0, g) * 0.11;
      if (g < 1e-4) continue;
      const k = (y * W + x) * 3;
      // warm HII/star-cloud regions vs cool reflection nebulosity
      const warm = fbm(u * 4 + 20, v * 8 + 50);
      acc[k] += g * (0.92 + 0.42 * warm);
      acc[k + 1] += g * (0.90 + 0.06 * warm);
      acc[k + 2] += g * (0.98 + 0.30 * (1 - warm));
    }
  }

  // ---- 2. stars with Gaussian PSF + diffraction spikes on the brightest
  const splat = (cx, cy, r, g, b) => {
    const ix = Math.round(cx), iy = Math.round(cy);
    if (iy < 0 || iy >= H) return;
    const xx = ((ix % W) + W) % W;
    const k = (iy * W + xx) * 3;
    acc[k] += r; acc[k + 1] += g; acc[k + 2] += b;
  };
  for (const st of stars) {
    const [cx, cy] = project(st.ra, st.dec);
    if (cy < 0 || cy >= H) continue;
    // flux from apparent magnitude; compress the enormous dynamic range
    const flux = Math.pow(2.512, -(st.mag - 6.0));      // mag 6 ≈ unit
    const peak = Math.min(9.0, Math.pow(flux, 0.62)) * 0.9;
    if (peak < 0.02) { // sub-visible: single faint texel, keep the field dense
      const [r, g, b] = bvToLinearRGB(st.bv);
      splat(cx, cy, r * peak, g * peak, b * peak);
      continue;
    }
    const [cr, cg, cb] = bvToLinearRGB(st.bv);
    const sigma = 0.62 + 0.16 * Math.log2(1 + peak);     // core PSF radius
    const rad = Math.max(1, Math.ceil(sigma * 3));
    const fx = cx - Math.floor(cx), fy = cy - Math.floor(cy);
    const bx = Math.floor(cx), by = Math.floor(cy);
    for (let dy = -rad; dy <= rad; dy++) {
      const py = by + dy; if (py < 0 || py >= H) continue;
      for (let dx = -rad; dx <= rad; dx++) {
        const d2 = (dx - fx) ** 2 + (dy - fy) ** 2;
        const w = Math.exp(-d2 / (2 * sigma * sigma));
        if (w < 0.004) continue;
        const px = ((bx + dx) % W + W) % W;
        const k = (py * W + px) * 3;
        acc[k] += cr * peak * w; acc[k + 1] += cg * peak * w; acc[k + 2] += cb * peak * w;
      }
    }
    // bright stars: soft airy halo + 4-way diffraction spikes
    if (peak > 1.6) {
      const halo = peak * 0.05, hr = Math.ceil(sigma * 7);
      for (let dy = -hr; dy <= hr; dy++) {
        const py = by + dy; if (py < 0 || py >= H) continue;
        for (let dx = -hr; dx <= hr; dx++) {
          const dist = Math.hypot(dx - fx, dy - fy);
          const w = halo / (1 + dist * dist * 0.7);
          if (w < 0.003) continue;
          const px = ((bx + dx) % W + W) % W, k = (py * W + px) * 3;
          acc[k] += cr * w; acc[k + 1] += cg * w; acc[k + 2] += cb * w;
        }
      }
      const spikeLen = Math.min(48, Math.round(6 + peak * 3));
      for (let t = 1; t <= spikeLen; t++) {
        const w = peak * 0.05 * (1 - t / spikeLen) ** 2;
        for (const [ox, oy] of [[t, 0], [-t, 0], [0, t], [0, -t]]) {
          splat(cx + ox, cy + oy, cr * w, cg * w, cb * w);
        }
      }
    }
  }

  // ---- 3. display transform: exposure → filmic tone → sRGB → 8-bit
  const png = new PNG({ width: W, height: H });
  const EXP = 1.35;
  for (let i = 0; i < W * H; i++) {
    let r = acc[i * 3] * EXP, g = acc[i * 3 + 1] * EXP, b = acc[i * 3 + 2] * EXP;
    // Reinhard-ish shoulder keeps bright cores from clipping to flat white
    r = r / (1 + r * 0.55); g = g / (1 + g * 0.55); b = b / (1 + b * 0.55);
    const enc = (v) => { v = Math.max(0, Math.min(1, v)); return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255); };
    const o = i * 4;
    png.data[o] = enc(r); png.data[o + 1] = enc(g); png.data[o + 2] = enc(b); png.data[o + 3] = 255;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, PNG.sync.write(png, { deflateLevel: 9 }));
  process.stderr.write(`Wrote ${OUT}\n`);
}

function boxBlurWrap(src, w, h, radius, passes) {
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let d = -radius; d <= radius; d++) { s += a[y * w + ((x + d) % w + w) % w]; n++; }
      b[y * w + x] = s / n;
    }
    [a, b] = [b, a];
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      let s = 0, n = 0;
      for (let d = -radius; d <= radius; d++) { const yy = Math.max(0, Math.min(h - 1, y + d)); s += a[yy * w + x]; n++; }
      b[y * w + x] = s / n;
    }
    [a, b] = [b, a];
  }
  return a;
}
function bilinearWrap(src, w, h, fx, fy) {
  const x0 = Math.floor(fx), y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
  const x1 = (x0 + 1) % w, y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0, ty = fy - Math.floor(fy);
  const xx0 = (x0 % w + w) % w;
  const a = src[y0 * w + xx0], b = src[y0 * w + x1], c = src[y1 * w + xx0], d = src[y1 * w + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

loadCatalog().then(main).catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
