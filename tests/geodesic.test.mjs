// Physics self-tests for the Schwarzschild null-geodesic integrator.
// Mirrors src/lensing/blackhole.frag.glsl exactly (r_s = 1, a = -1.5 h² x/r⁵).
// Fails loudly if the ODE, the analytic weak-field branch, or the shader's
// step scheme drifts from ground truth:
//   1. weak-field deflection matches α(b) = 2/b + (15π/16)/b²
//   2. photon capture boundary sits at b_crit = (3√3)/2 ≈ 2.598
//   3. the shader's budgeted leapfrog agrees with a fine-step reference

const B_CRIT = (3 * Math.sqrt(3)) / 2;

const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b, s = 1) => v3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => { const l = len(a); return v3(a.x / l, a.y / l, a.z / l); };

const accel = (x, h2) => {
  const r2 = dot(x, x);
  const r5 = r2 * r2 * Math.sqrt(r2);
  const k = (-1.5 * h2) / r5;
  return v3(x.x * k, x.y * k, x.z * k);
};

// Fine-step RK4 — ground truth.
function traceReference(ro, rd, rEscape) {
  let x = { ...ro }, v = { ...rd };
  const h2 = dot(cross(ro, rd), cross(ro, rd));
  for (let i = 0; i < 4_000_000; i++) {
    const r = len(x);
    if (r < 1) return { captured: true };
    if (r > rEscape && dot(x, v) > 0) return { captured: false, dir: norm(v) };
    const dl = Math.min(0.002 * Math.max(r, 1), 5);
    const k1v = accel(x, h2), k1x = v;
    const k2v = accel(add(x, k1x, dl / 2), h2), k2x = add(v, k1v, dl / 2);
    const k3v = accel(add(x, k2x, dl / 2), h2), k3x = add(v, k2v, dl / 2);
    const k4v = accel(add(x, k3x, dl), h2), k4x = add(v, k3v, dl);
    x = add(x, v3(
      (k1x.x + 2 * k2x.x + 2 * k3x.x + k4x.x) / 6,
      (k1x.y + 2 * k2x.y + 2 * k3x.y + k4x.y) / 6,
      (k1x.z + 2 * k2x.z + 2 * k3x.z + k4x.z) / 6), dl);
    v = add(v, v3(
      (k1v.x + 2 * k2v.x + 2 * k3v.x + k4v.x) / 6,
      (k1v.y + 2 * k2v.y + 2 * k3v.y + k4v.y) / 6,
      (k1v.z + 2 * k2v.z + 2 * k3v.z + k4v.z) / 6), dl);
  }
  return { captured: true, timeout: true };
}

// The shader's integrator, verbatim: budgeted angular-stepped leapfrog.
// On budget exhaustion the shader classifies analytically by b vs b_crit
// (exact for Schwarzschild) — mirrored here.
function traceShaderStyle(ro, rd, { steps = 96, maxWind = 1.3, rEscape = 60 } = {}) {
  let x = { ...ro }, v = { ...rd };
  const hv = cross(ro, rd);
  const h2 = dot(hv, hv);
  const b = Math.sqrt(h2);
  const dphi = (maxWind * 2 * Math.PI) / steps;
  for (let i = 0; i < steps; i++) {
    const r2 = dot(x, x);
    if (r2 > rEscape * rEscape) return { captured: false, dir: norm(v) };
    const r = Math.sqrt(r2);
    const dl = Math.min(Math.max(dphi * r, 0.008), 4.0);
    const a = accel(x, h2);
    const vh = add(v, a, 0.5 * dl);
    const xn = add(x, vh, dl);
    const an = accel(xn, h2);
    v = add(vh, an, 0.5 * dl);
    x = xn;
    if (dot(x, x) < 1) return { captured: true };
  }
  return { captured: b <= B_CRIT, exhausted: true, dir: norm(v) };
}

function deflectionAngle(initialDir, finalDir) {
  return Math.acos(Math.min(1, Math.max(-1, dot(initialDir, finalDir))));
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- 1. weak-field deflection vs analytic series (validates shader's analytic branch)
console.log('\n[1] weak-field deflection from r0=5000 vs α(b) = 2/b + (15π/16)/b²');
for (const b of [12.5, 15, 20, 30, 50]) {
  const ro = v3(5000, b, 0);
  const rd = v3(-1, 0, 0);
  const res = traceReference(ro, rd, 6000);
  const alpha = deflectionAngle(rd, res.dir);
  const series = 2 / b + (15 * Math.PI / 16) / (b * b);
  const relErr = Math.abs(alpha - series) / series;
  check(`b=${b}`, relErr < 0.02,
    `integrated=${alpha.toFixed(5)} series=${series.toFixed(5)} relErr=${(relErr * 100).toFixed(2)}%`);
}

// ---- 2. capture boundary b_crit (bisection with the reference integrator)
console.log('\n[2] photon capture boundary vs b_crit = 2.59808');
{
  let lo = 2.0, hi = 3.2; // lo captured, hi escapes
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const res = traceReference(v3(5000, mid, 0), v3(-1, 0, 0), 6000);
    if (res.captured) lo = mid; else hi = mid;
  }
  const edge = (lo + hi) / 2;
  check('reference b_edge', Math.abs(edge - B_CRIT) < 0.01, `edge=${edge.toFixed(4)}`);

  // shader-style from a realistic camera distance
  let lo2 = 2.0, hi2 = 3.2;
  for (let i = 0; i < 30; i++) {
    const mid = (lo2 + hi2) / 2;
    const theta = Math.asin(mid / 30);
    const res = traceShaderStyle(v3(30, 0, 0),
      v3(-Math.cos(theta), Math.sin(theta), 0));
    if (res.captured) lo2 = mid; else hi2 = mid;
  }
  const edge2 = (lo2 + hi2) / 2;
  check('shader-style b_edge', Math.abs(edge2 - B_CRIT) < 0.02, `edge=${edge2.toFixed(4)}`);
}

// ---- 3. shader-budget integrator vs reference, camera at r0=30
console.log('\n[3] budgeted leapfrog (96 steps) vs fine RK4, escape direction error');
for (const b of [3.2, 4, 6, 9, 11]) {
  const theta = Math.asin(b / 30);
  const ro = v3(30, 0, 0);
  const rd = v3(-Math.cos(theta), Math.sin(theta), 0);
  const ref = traceReference(ro, rd, 60);
  const sh = traceShaderStyle(ro, rd);
  const bothEscape = !ref.captured && !sh.captured;
  const err = bothEscape ? deflectionAngle(ref.dir, sh.dir) : NaN;
  const tol = b < 3.5 ? 0.05 : 0.02;
  check(`b=${b}`, bothEscape && err < tol,
    bothEscape ? `dirErr=${(err * 1000).toFixed(2)} mrad` : `capture mismatch ref=${ref.captured} shader=${sh.captured}`);
}

// ---- 4. far rays are straight
console.log('\n[4] far rays pass essentially undeflected');
{
  const ro = v3(30, 0, 0);
  const rd = norm(v3(0.3, 1, 0.2)); // b ≈ 28, pointing well away
  const sh = traceShaderStyle(ro, rd);
  const bend = sh.captured ? NaN : deflectionAngle(rd, sh.dir);
  check('b≈28 outbound', !sh.captured && bend < 0.08, `bend=${(bend * 1000).toFixed(1)} mrad`);
}

console.log(failures === 0 ? '\nAll geodesic self-tests passed.' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
