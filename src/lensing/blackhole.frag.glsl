// Gravitationally-lensed view of a Schwarzschild black hole with a thin
// relativistic accretion disk. All distances in Schwarzschild radii (r_s = 1),
// G = c = 1, black hole at the origin, disk in the x–z plane.
//
// Null geodesics use the 3D vector form (equivalent to the planar Binet
// equation u'' = -u + (3/2) u²):  a = -(3/2) h² x / r⁵,  h = |x × v| conserved.
// Far rays (impact parameter b > B_MARCH) take an analytic weak-field shortcut.
//
// Technique after oseiskar/black-hole (MIT) and ebruneton/black_hole_shader
// (BSD-3); physics per James, von Tunzelmann, Franklin & Thorne (2015).

precision highp float;
precision highp int;

#define PI 3.14159265358979
#define TWO_PI 6.28318530717959

// B_CRIT, R_IN, R_OUT, B_MARCH are injected at load from config.js:
//__DEFINES__

in vec2 vUv;
out vec4 outColor;

uniform vec3 uCamPos;       // camera position, r_s units
uniform mat3 uBasis;        // camera basis (columns: right, up, back) — looks down -Z
uniform vec2 uTanHalfFov;   // (1,1) for cube faces
uniform float uTime;        // sim time, frozen per cube refresh cycle
uniform int uSteps;
uniform float uMaxWind;     // winding budget in revolutions
uniform float uEscapeR;
uniform sampler2D uSky;     // equirect star map (linear after hardware sRGB decode)
uniform float uSkyLod;
uniform mat3 uSkyRot;
uniform float uSkyGain;
uniform sampler2D uBlackbody; // 256×1 LUT, 1000 K → 12000 K, linear RGB (peak-normalized)
uniform float uCinematic;   // 1 = movie look (shifts muted), 0 = full physics
uniform float uDiskGain;
uniform float uGlow;

// ---------------------------------------------------------------- noise ----

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + vec2(34.345));
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1, 0));
  float c = hash21(i + vec2(0, 1));
  float d = hash21(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0, amp = 0.55;
  for (int i = 0; i < 3; i++) {
    s += amp * vnoise(p);
    p = p * 2.13 + vec2(17.7);
    amp *= 0.5;
  }
  return s;
}

// ------------------------------------------------------------------ sky ----

vec3 skyColor(vec3 dir, float lodBias) {
  vec3 d = uSkyRot * dir;
  vec2 uv = vec2(atan(d.z, d.x) / TWO_PI + 0.5,
                 0.5 + asin(clamp(d.y, -1.0, 1.0)) / PI);
  vec3 c = textureLod(uSky, uv, uSkyLod + lodBias).rgb;
  // Superlinear lift so bright stars punch into HDR before tonemapping.
  return c * (uSkyGain + 2.0 * uSkyGain * c);
}

// ----------------------------------------------------------------- disk ----

// Emission + coverage of the thin disk at plane-crossing point p.
// marchDir = ray marching direction (unit, camera → scene) at the crossing.
vec4 diskSample(vec3 p, vec3 marchDir) {
  float r = length(p.xz);
  float win = smoothstep(R_IN, R_IN * 1.22, r) *
              (1.0 - smoothstep(R_OUT * 0.62, R_OUT, r));
  if (win <= 0.001) return vec4(0.0);

  // Differential rotation: rigid rotation per-radius → Keplerian shear, no φ seam.
  float om = 0.70710678 / (r * sqrt(r));   // Ω = 1/√(2 r³)
  float ang = om * uTime;
  float ca = cos(ang), sa = sin(ang);
  vec2 q = mat2(ca, -sa, sa, ca) * p.xz;

  // Streaky filaments: log-radial bands distorted by a swirled field.
  float lr = log(r);
  float distort = fbm(q * 0.55);
  float rings = fbm(vec2(lr * 9.0, distort * 3.1 + 2.0));
  float clumps = fbm(q * 1.15 + vec2(31.0));
  float density = (0.45 + 0.55 * rings) * (0.6 + 0.4 * clumps);
  density = pow(density, 1.35);

  // Temperature: hot white inner region → deep orange rim, dimmed at the
  // very inner edge (quasi Page–Thorne), modulated by the turbulence.
  float T = 6600.0 * pow(3.0 / r, 0.66)
          * (0.58 + 0.42 * smoothstep(2.9, 4.6, r))
          * (0.82 + 0.5 * rings);

  // Relativistic shifts. Photon propagation dir at emission = -marchDir
  // (we trace backwards from the camera).
  float v = clamp(1.0 / sqrt(max(2.0 * (r - 1.0), 0.4)), 0.0, 0.85); // local orbital speed
  float gamma = 1.0 / sqrt(1.0 - v * v);
  vec3 beta = v * vec3(p.z, 0.0, -p.x) / r;     // prograde (+Y angular momentum)
  float gDop = 1.0 / (gamma * (1.0 - dot(beta, -marchDir)));
  float gGrav = sqrt(max(1.0 - 1.0 / r, 0.02));
  float g = gDop * gGrav;                        // ν_obs / ν_em

  // Cinematic blend: the film shipped with these shifts switched off.
  float gCol = mix(g, 1.0, uCinematic);
  float beamExp = mix(3.0, 0.35, uCinematic);
  float beam = pow(clamp(g, 0.35, 2.8), beamExp);

  float Tobs = clamp(T * gCol, 1000.0, 12000.0);
  vec3 bb = texture(uBlackbody, vec2((Tobs - 1000.0) / 11000.0, 0.5)).rgb;

  // Grazing rays traverse more disk material.
  float grazing = clamp(0.14 / max(abs(marchDir.y), 0.05), 1.0, 3.2);

  float lum = pow(T / 6600.0, 4.0);              // Stefan–Boltzmann-ish falloff
  vec3 emission = bb * lum * density * beam * win * uDiskGain * 26.0;
  float alpha = clamp(win * (0.5 + 0.6 * density) * grazing * 0.75, 0.0, 0.92);
  return vec4(emission * grazing, alpha);
}

// Test the segment p0→p1 for an equatorial crossing; composite into col/trans.
void diskCrossing(vec3 p0, vec3 p1, vec3 dir, inout vec3 col, inout float trans) {
  if (p0.y * p1.y < 0.0) {
    float s = p0.y / (p0.y - p1.y);
    vec3 hit = mix(p0, p1, s);
    float r2 = dot(hit.xz, hit.xz);
    if (r2 > R_IN * R_IN * 0.8 && r2 < R_OUT * R_OUT * 1.1) {
      vec4 e = diskSample(hit, dir);
      col += trans * e.rgb;
      trans *= 1.0 - e.a;
    }
  }
}

// ----------------------------------------------------------------- main ----

void main() {
  vec3 rd = normalize(uBasis * vec3(vUv * uTanHalfFov, -1.0));
  vec3 ro = uCamPos;

  float tca = -dot(ro, rd);                  // ray param of closest approach
  vec3 pca = ro + rd * max(tca, 0.0);
  float b = length(pca);                     // impact parameter (b = |ro×rd| when tca>0)

  vec3 col = vec3(0.0);
  float trans = 1.0;
  bool captured = false;
  float bGlow = b;

  if (b > B_MARCH && length(ro) > B_MARCH * 1.15) {
    // ---- analytic far-field: weak-field impulse bend at closest approach ----
    float alpha = (tca > 0.0) ? (2.0 / b + 2.9452 / (b * b)) : 0.0;
    vec3 toBH = -pca / max(b, 1e-4);
    vec3 d2 = normalize(rd * cos(alpha) + toBH * sin(alpha));

    if (tca > 0.0) {
      diskCrossing(ro, pca, rd, col, trans);                    // pre-bend leg
      diskCrossing(pca, pca + d2 * (uEscapeR * 2.0), d2, col, trans); // post-bend leg
    } else {
      diskCrossing(ro, ro + rd * (uEscapeR * 2.0), rd, col, trans);
    }
    col += trans * skyColor(d2, 0.0);
  } else {
    // ---- geodesic march ----
    vec3 x = ro;
    vec3 v = rd;
    vec3 hv = cross(x, v);
    float h2 = dot(hv, hv);
    float dphi = uMaxWind * TWO_PI / float(uSteps);
    float esc2 = uEscapeR * uEscapeR;
    bool escaped = false;
    int crossings = 0;

    for (int i = 0; i < 512; i++) {
      if (i >= uSteps) break;
      float r2 = dot(x, x);
      if (r2 > esc2) { escaped = true; break; }
      float r = sqrt(r2);
      float dl = clamp(dphi * r, 0.008, 4.0);

      // kick–drift–kick leapfrog on a = -1.5 h² x / r⁵
      vec3 a = -1.5 * h2 * x / (r2 * r2 * r);
      vec3 vh = v + a * (0.5 * dl);
      vec3 xn = x + vh * dl;
      float rn2 = dot(xn, xn);
      float rn = sqrt(rn2);
      vec3 an = -1.5 * h2 * xn / (rn2 * rn2 * rn);
      v = vh + an * (0.5 * dl);

      if (crossings < 4 && trans > 0.02) {
        vec3 preX = x;
        x = xn;
        if (preX.y * xn.y < 0.0) {
          crossings++;
          diskCrossing(preX, xn, normalize(v), col, trans);
        }
      } else {
        x = xn;
      }

      if (rn2 < 1.0) { captured = true; break; }
    }

    if (escaped) {
      float ringBias = clamp(1.8 - 5.0 * abs(b - B_CRIT), 0.0, 1.8);
      col += trans * skyColor(normalize(v), ringBias);
    } else if (!captured && b > B_CRIT) {
      // Winding budget exhausted while grazing the photon sphere, but b > b_crit
      // means this ray must eventually escape (exact for Schwarzschild).
      // Sample along the wound-up direction, heavily blurred — the smeared,
      // multiply-imaged sky of the photon ring.
      col += trans * skyColor(normalize(v), 2.2) * 0.7;
    }
    // b ≤ b_crit without escape → genuinely captured (black shadow)
  }

  // Soft photon-ring halo — scattered light hugging the critical curve.
  float halo = exp(-abs(bGlow - B_CRIT) * 5.5);
  col += uGlow * halo * vec3(1.0, 0.78, 0.5) * uDiskGain * (captured ? 1.15 : 1.0);

  outColor = vec4(col, 1.0);
}
