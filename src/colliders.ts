// Analytic collision shapes: mannequin (lofted torso + capsules + spheres), rings, ground.
// All shapes push a point out to the surface + thickness and return the outward normal.

import type { Avatar, Ring } from './model';

export type V3 = [number, number, number];

export interface TorsoTable {
  y0: number; step: number; n: number;
  rx: Float32Array; rz: Float32Array; drx: Float32Array; drz: Float32Array;
}

export type Collider =
  | { kind: 'capsule'; a: V3; b: V3; r: number; bc: V3; br: number }
  | { kind: 'sphere'; c: V3; r: number; bc: V3; br: number }
  | { kind: 'torso'; t: TorsoTable; bc: V3; br: number }
  | { kind: 'ring'; c: V3; ax: V3; ay: V3; az: V3; R: number; tube: number; bc: V3; br: number };

// ---------- Mannequin definition ----------

interface Key { y: number; rx: number; rz: number }
const TORSO_KEYS: Key[] = [
  { y: 74.5, rx: 3, rz: 2.5 },
  { y: 76.5, rx: 10, rz: 7.5 },
  { y: 80, rx: 15, rz: 10.5 },
  { y: 88, rx: 17, rz: 12 },
  { y: 95, rx: 17.5, rz: 12 },
  { y: 105, rx: 14, rz: 10 },
  { y: 115, rx: 14.8, rz: 10.6 },
  { y: 122, rx: 15.8, rz: 11.6 },
  { y: 130, rx: 16.5, rz: 12 },
  { y: 138, rx: 17, rz: 10.6 },
  { y: 143, rx: 17.8, rz: 9.2 },
  { y: 146.5, rx: 16, rz: 8 },
  { y: 148.5, rx: 11.5, rz: 7 },
  { y: 150.3, rx: 6.5, rz: 5.8 },
  { y: 151.5, rx: 5.4, rz: 5 },
];

const gauss = (y: number, c: number, w: number) => Math.exp(-((y - c) * (y - c)) / (2 * w * w));

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function buildTorsoTable(av: Avatar): TorsoTable {
  const H = av.height;
  const keys = TORSO_KEYS.map(k => {
    const f = 1 + (av.hips - 1) * gauss(k.y, 91, 7) + (av.waist - 1) * gauss(k.y, 105, 5) + (av.chest - 1) * gauss(k.y, 128, 8);
    return { y: k.y * H, rx: k.rx * f, rz: k.rz * f };
  });
  const y0 = keys[0].y, y1 = keys[keys.length - 1].y;
  const step = 0.5;
  const n = Math.ceil((y1 - y0) / step) + 1;
  const rx = new Float32Array(n), rz = new Float32Array(n), drx = new Float32Array(n), drz = new Float32Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const y = Math.min(y0 + i * step, y1);
    while (seg < keys.length - 2 && y > keys[seg + 1].y) seg++;
    const k0 = keys[Math.max(0, seg - 1)], k1 = keys[seg], k2 = keys[seg + 1], k3 = keys[Math.min(keys.length - 1, seg + 2)];
    const t = (y - k1.y) / (k2.y - k1.y);
    rx[i] = Math.max(0.5, catmull(k0.rx, k1.rx, k2.rx, k3.rx, t));
    rz[i] = Math.max(0.5, catmull(k0.rz, k1.rz, k2.rz, k3.rz, t));
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dy = (b - a) * step || 1;
    drx[i] = (rx[b] - rx[a]) / dy;
    drz[i] = (rz[b] - rz[a]) / dy;
  }
  return { y0, step, n, rx, rz, drx, drz };
}

export interface MannequinParts {
  torso: TorsoTable;
  capsules: { a: V3; b: V3; r: number }[];
  spheres: { c: V3; r: number; sx?: number; sy?: number; sz?: number }[];
}

export function mannequinParts(av: Avatar): MannequinParts {
  const H = av.height;
  const torso = buildTorsoTable(av);
  const capsules: MannequinParts['capsules'] = [];
  const spheres: MannequinParts['spheres'] = [];
  const s = (x: number, y: number, z: number): V3 => [x, y * H, z];
  const armAngle = (42 * Math.PI) / 180;
  const shoulderW = 16 * (1 + (av.chest - 1) * 0.6);
  for (const side of [-1, 1]) {
    const sh = s(side * shoulderW, 140.5, 0);
    const dir: V3 = [side * Math.sin(armAngle), -Math.cos(armAngle), 0];
    const elbow: V3 = [sh[0] + dir[0] * 28 * H, sh[1] + dir[1] * 28 * H, 0];
    const dir2: V3 = [side * Math.sin(armAngle * 0.8), -Math.cos(armAngle * 0.8), 0.12];
    const wrist: V3 = [elbow[0] + dir2[0] * 25 * H, elbow[1] + dir2[1] * 25 * H, elbow[2] + dir2[2] * 25 * H];
    capsules.push({ a: sh, b: elbow, r: 4.6 });
    capsules.push({ a: elbow, b: wrist, r: 3.7 });
    spheres.push({ c: [wrist[0] + dir2[0] * 7, wrist[1] + dir2[1] * 7, wrist[2] + 0.5], r: 4.2, sx: 0.75, sy: 1.25, sz: 1 });
    spheres.push({ c: [sh[0] + side * 1, sh[1] + 1.5, 0], r: 5.4 }); // deltoid
    const hip = s(side * 9, 82, 0);
    const knee = s(side * 9.5, 46, 0.5);
    const ankle = s(side * 10, 8, 0);
    capsules.push({ a: hip, b: knee, r: 7.6 * (1 + (av.hips - 1) * 0.7) });
    capsules.push({ a: knee, b: ankle, r: 5.2 });
    capsules.push({ a: [ankle[0], 3.5, -3], b: [ankle[0], 3.5, 13], r: 3.5 }); // foot
  }
  capsules.push({ a: s(0, 146, 0), b: s(0, 158, 0.8), r: 5.4 }); // neck
  spheres.push({ c: s(0, 168, 1), r: 10, sx: 0.85, sy: 1.08, sz: 0.95 }); // head
  return { torso, capsules, spheres };
}

// ---------- Colliders ----------

function boundsOfCapsule(a: V3, b: V3, r: number): { bc: V3; br: number } {
  const bc: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const half = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 2;
  return { bc, br: half + r };
}

export function ringBasis(r: Ring): { ax: V3; ay: V3; az: V3 } {
  // Start with identity, tilt around X, then yaw around Y.
  const cy = Math.cos(r.yaw), sy = Math.sin(r.yaw), ct = Math.cos(r.tilt), st = Math.sin(r.tilt);
  const rot = (v: V3): V3 => {
    // rotX(tilt)
    const y1 = v[1] * ct - v[2] * st, z1 = v[1] * st + v[2] * ct;
    // rotY(yaw)
    return [v[0] * cy + z1 * sy, y1, -v[0] * sy + z1 * cy];
  };
  return { ax: rot([1, 0, 0]), ay: rot([0, 1, 0]), az: rot([0, 0, 1]) };
}

export function buildColliders(av: Avatar | null, rings: Ring[]): Collider[] {
  const out: Collider[] = [];
  if (av) {
    const m = mannequinParts(av);
    const t = m.torso;
    const yMid = t.y0 + ((t.n - 1) * t.step) / 2;
    out.push({ kind: 'torso', t, bc: [0, yMid, 0], br: ((t.n - 1) * t.step) / 2 + 25 });
    for (const c of m.capsules) out.push({ kind: 'capsule', a: c.a, b: c.b, r: c.r, ...boundsOfCapsule(c.a, c.b, c.r) });
    // Collide with the visual (ellipsoid) head/hands approximately as spheres of the mean radius
    for (const s of m.spheres) {
      const r = s.r * ((s.sx ?? 1) + (s.sy ?? 1) + (s.sz ?? 1)) / 3;
      out.push({ kind: 'sphere', c: s.c, r, bc: s.c, br: r });
    }
  }
  for (const r of rings) {
    const b = ringBasis(r);
    out.push({ kind: 'ring', c: [r.x, r.y, r.z], ...b, R: r.radius, tube: r.tube, bc: [r.x, r.y, r.z], br: r.radius + r.tube });
  }
  return out;
}

/**
 * Push point p (in-place, arrays at offset o) out of collider. thickness = cloth offset.
 * Writes outward normal into nOut and returns true if a correction happened.
 */
export function collide(c: Collider, p: Float32Array, o: number, thick: number, nOut: Float32Array, prev?: Float32Array): boolean {
  const x = p[o], y = p[o + 1], z = p[o + 2];
  const dxb = x - c.bc[0], dyb = y - c.bc[1], dzb = z - c.bc[2];
  const rb = c.br + thick;
  if (dxb * dxb + dyb * dyb + dzb * dzb > rb * rb) return false;

  switch (c.kind) {
    case 'sphere': {
      const dx = x - c.c[0], dy = y - c.c[1], dz = z - c.c[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const R = c.r + thick;
      if (d >= R) return false;
      const inv = d > 1e-6 ? 1 / d : 0;
      const nx = d > 1e-6 ? dx * inv : 0, ny = d > 1e-6 ? dy * inv : 1, nz = d > 1e-6 ? dz * inv : 0;
      p[o] = c.c[0] + nx * R; p[o + 1] = c.c[1] + ny * R; p[o + 2] = c.c[2] + nz * R;
      nOut[0] = nx; nOut[1] = ny; nOut[2] = nz;
      return true;
    }
    case 'capsule': {
      const abx = c.b[0] - c.a[0], aby = c.b[1] - c.a[1], abz = c.b[2] - c.a[2];
      const apx = x - c.a[0], apy = y - c.a[1], apz = z - c.a[2];
      let t = (apx * abx + apy * aby + apz * abz) / (abx * abx + aby * aby + abz * abz);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = c.a[0] + abx * t, qy = c.a[1] + aby * t, qz = c.a[2] + abz * t;
      const dx = x - qx, dy = y - qy, dz = z - qz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const R = c.r + thick;
      if (d >= R) return false;
      let nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : 1, nz = d > 1e-6 ? dz / d : 0;
      if (prev) {
        // Thin limbs: push out on the side the particle came from, so it can't tunnel through the core
        const ex = prev[o] - qx, ey = prev[o + 1] - qy, ez = prev[o + 2] - qz;
        const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (el > R * 0.8 && ex * nx + ey * ny + ez * nz < 0) { nx = ex / el; ny = ey / el; nz = ez / el; }
      }
      p[o] = qx + nx * R; p[o + 1] = qy + ny * R; p[o + 2] = qz + nz * R;
      nOut[0] = nx; nOut[1] = ny; nOut[2] = nz;
      return true;
    }
    case 'torso': {
      const t = c.t;
      let px = x, py = y, pz = z;
      let hit = false;
      let gx = 0, gy = 0, gz = 0;
      for (let it = 0; it < 2; it++) {
        const fi = (py - t.y0) / t.step;
        if (fi < 0 || fi > t.n - 1) break;
        const i0 = Math.floor(fi), i1 = Math.min(t.n - 1, i0 + 1), f = fi - i0;
        const rx = t.rx[i0] + (t.rx[i1] - t.rx[i0]) * f + thick;
        const rz = t.rz[i0] + (t.rz[i1] - t.rz[i0]) * f + thick;
        const drx = t.drx[i0] + (t.drx[i1] - t.drx[i0]) * f;
        const drz = t.drz[i0] + (t.drz[i1] - t.drz[i0]) * f;
        const ux = px / rx, uz = pz / rz;
        const r = Math.sqrt(ux * ux + uz * uz);
        if (r >= 1) break;
        if (r < 1e-5) { gx = 0; gy = 0; gz = 1; pz = rz; hit = true; break; }
        gx = px / (rx * rx * r);
        gz = pz / (rz * rz * r);
        gy = -((px * px * drx) / (rx * rx * rx) + (pz * pz * drz) / (rz * rz * rz)) / r;
        const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
        const d = (1 - r) / gl;
        gx /= gl; gy /= gl; gz /= gl;
        px += gx * d * 1.02; py += gy * d * 1.02; pz += gz * d * 1.02;
        hit = true;
      }
      if (!hit) return false;
      p[o] = px; p[o + 1] = py; p[o + 2] = pz;
      nOut[0] = gx; nOut[1] = gy; nOut[2] = gz;
      return true;
    }
    case 'ring': {
      const dx = x - c.c[0], dy = y - c.c[1], dz = z - c.c[2];
      const lx = dx * c.ax[0] + dy * c.ax[1] + dz * c.ax[2];
      const ly = dx * c.ay[0] + dy * c.ay[1] + dz * c.ay[2];
      const lz = dx * c.az[0] + dy * c.az[1] + dz * c.az[2];
      const rxy = Math.sqrt(lx * lx + ly * ly);
      const cx = rxy > 1e-6 ? (lx / rxy) * c.R : c.R, cy = rxy > 1e-6 ? (ly / rxy) * c.R : 0;
      const vx = lx - cx, vy = ly - cy, vz = lz;
      const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const R = c.tube + thick;
      if (d >= R) return false;
      let nx = d > 1e-6 ? vx / d : 0, ny = d > 1e-6 ? vy / d : 0, nz = d > 1e-6 ? vz / d : 1;
      if (prev) {
        // Same anti-tunnelling trick as capsules, done in ring space
        const qx0 = prev[o] - c.c[0], qy0 = prev[o + 1] - c.c[1], qz0 = prev[o + 2] - c.c[2];
        const px0 = qx0 * c.ax[0] + qy0 * c.ax[1] + qz0 * c.ax[2] - cx;
        const py0 = qx0 * c.ay[0] + qy0 * c.ay[1] + qz0 * c.ay[2] - cy;
        const pz0 = qx0 * c.az[0] + qy0 * c.az[1] + qz0 * c.az[2];
        const el = Math.sqrt(px0 * px0 + py0 * py0 + pz0 * pz0);
        if (el > R * 0.8 && px0 * nx + py0 * ny + pz0 * nz < 0) { nx = px0 / el; ny = py0 / el; nz = pz0 / el; }
      }
      const qx = cx + nx * R, qy = cy + ny * R, qz = nz * R;
      // back to world
      p[o] = c.c[0] + c.ax[0] * qx + c.ay[0] * qy + c.az[0] * qz;
      p[o + 1] = c.c[1] + c.ax[1] * qx + c.ay[1] * qy + c.az[1] * qz;
      p[o + 2] = c.c[2] + c.ax[2] * qx + c.ay[2] * qy + c.az[2] * qz;
      nOut[0] = c.ax[0] * nx + c.ay[0] * ny + c.az[0] * nz;
      nOut[1] = c.ax[1] * nx + c.ay[1] * ny + c.az[1] * nz;
      nOut[2] = c.ax[2] * nx + c.ay[2] * ny + c.az[2] * nz;
      return true;
    }
  }
}
