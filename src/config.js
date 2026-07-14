// Central knobs. Distances are in Schwarzschild radii (r_s = 1), G = c = 1.

export const PHYS = {
  RS: 1.0,                 // Schwarzschild radius (unit of the simulation)
  R_ISCO: 3.0,             // innermost stable circular orbit = 3 r_s
  R_DISK_OUT: 14.0,        // outer edge of the accretion disk
  R_ESCAPE: 60.0,          // ray considered escaped beyond this radius
  B_CRIT: 2.598076,        // photon capture impact parameter (3√3/2 r_s)
  // March every ray whose impact parameter is below this. Kept above
  // R_DISK_OUT so a ray that can touch the disk (crossing radius ≥ b for
  // near-straight rays) is always integrated, never approximated — the
  // analytic/march handoff then lives entirely in empty sky.
  B_MARCH: 15.0,
};

// Quality tiers. facesPerFrame is how many cube faces re-render each frame
// (6 faces total → refresh rate = displayHz * facesPerFrame / 6).
export const TIERS = [
  { name: 'potato',  faceSize: 512,  steps: 48,  maxWind: 1.0, facesPerFrame: 1 },
  { name: 'low',     faceSize: 640,  steps: 64,  maxWind: 1.1, facesPerFrame: 2 },
  { name: 'medium',  faceSize: 768,  steps: 80,  maxWind: 1.2, facesPerFrame: 2 },
  { name: 'high',    faceSize: 896,  steps: 96,  maxWind: 1.3, facesPerFrame: 3 },
  { name: 'ultra',   faceSize: 1024, steps: 128, maxWind: 1.5, facesPerFrame: 6 },
];
export const DEFAULT_TIER_XR = 2;      // Quest 3 starting point; quality manager adjusts
export const DEFAULT_TIER_DESKTOP = 4;

// Cinematic slider: 1 = the film's look (Doppler beaming & shifts muted),
// 0 = full physics. DNGR paper documents the movie shipped with beaming off.
export const DEFAULTS = {
  cinematic: 0.65,
  exposure: 1.0,
  diskGain: 1.0,
  bloom: 0.5,
  bloomThreshold: 1.25,
  timeScale: 1.15,        // sim-time units per second (inner disk lap ≈ 40 s)
};

// Camera poses (r_s units) used by ?pose=N and screenshot verification.
export const POSES = [
  { pos: [26, 2.5, 0],  name: 'classic edge-on' },
  { pos: [18, 6, -6],   name: 'elevated three-quarter' },
  { pos: [45, 10, 0],   name: 'far approach' },
  { pos: [12, 2, -8],   name: 'close drama' },
];

// Cinematic cruise loop (closed Catmull-Rom, r_s units). Closest approach ~17 r_s.
export const TOUR = {
  points: [
    [30, 6.5, 0], [20, 4, -14], [2, 3, -17], [-16, 3.5, -12],
    [-26, 6, 0], [-18, 7.5, 10], [0, 8.5, 16], [18, 5.5, 13],
  ],
  duration: 110, // seconds per lap
};

export const params = new URLSearchParams(location.search);

export function numParam(name, fallback) {
  const v = params.get(name);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
