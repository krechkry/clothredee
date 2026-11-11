// Position-based cloth solver (XPBD-style, small substeps).
// Kept free of DOM/Three so it can move into a Web Worker later.
//
// Like Clo, a simulation starts in a "sewing phase": gravity is low until the seams have
// closed, so the garment gets stitched together before it starts to hang on the body.

import type { Collider } from '../colliders';
import { collide } from '../colliders';
import type { ClothData } from './build';
import type { Fabric } from '../model';

export interface SimOptions {
  substeps: number;
  stretchIters: number;
  thickness: number;     // body collision offset (cm)
  seamSpeed: number;     // cm/s each side of a seam moves while closing
  ground: boolean;
  selfCollision: boolean;
}

export class ClothSim {
  readonly n: number;
  x: Float32Array;
  private p: Float32Array;
  private v: Float32Array;
  private nTmp = new Float32Array(3);
  private partnerStart: Int32Array;
  private partnerList: Int32Array;
  private hashHead: Int32Array;
  private hashNext: Int32Array;
  private colMask: Uint32Array;
  private thinMask = 0; // bits of colliders that are thin enough for cloth to slip between particles
  private mid = new Float32Array(3);
  private midPrev = new Float32Array(3);
  private repelRadius: number;
  private alphaStretch = 0;
  private alphaBend = 0;
  private gravity = -981;
  private friction = 0.35;
  private longSlack = 1.02;
  gravityScale = 0.12;
  sewn = false;
  opts: SimOptions;
  time = 0;

  constructor(public data: ClothData, public colliders: Collider[], fabric: Fabric, spacing: number, opts?: Partial<SimOptions>) {
    this.n = data.n;
    this.x = new Float32Array(data.pos);
    this.p = new Float32Array(data.pos);
    this.v = new Float32Array(this.n * 3);
    this.opts = { substeps: 12, stretchIters: 2, thickness: 0.4, seamSpeed: 110, ground: true, selfCollision: true, ...opts };
    // Seam partners in CSR form (fast lookup during repulsion)
    const counts = new Int32Array(this.n + 1);
    const s = data.seams;
    for (let i = 0; i < s.length; i++) counts[s[i] + 1]++;
    for (let i = 0; i < this.n; i++) counts[i + 1] += counts[i];
    this.partnerStart = counts;
    this.partnerList = new Int32Array(s.length);
    const fill = new Int32Array(this.n);
    for (let i = 0; i < s.length; i += 2) {
      const a = s[i], b = s[i + 1];
      this.partnerList[counts[a] + fill[a]++] = b;
      this.partnerList[counts[b] + fill[b]++] = a;
    }
    const tableSize = Math.max(1024, this.n * 2);
    this.hashHead = new Int32Array(tableSize);
    this.hashNext = new Int32Array(this.n);
    this.colMask = new Uint32Array(this.n);
    this.repelRadius = spacing * 0.55;
    if (data.seams.length === 0) { this.sewn = true; this.gravityScale = 1; }
    this.setFabric(fabric);
  }

  setFabric(f: Fabric) {
    // Compliance already divided by h^2 ("alpha tilde"), mapped from the 0..1 sliders.
    this.alphaStretch = Math.pow(10, 1 - 4 * f.stretch);
    this.alphaBend = Math.pow(10, 2.5 - 3.5 * f.bend);
    this.gravity = -981 * f.weight;
    this.friction = f.friction;
    // Stretchy fabrics are allowed to grow more before the long-range limits kick in
    this.longSlack = 1 + (1 - f.stretch) * 0.15;
  }

  step(frameDt: number) {
    const dt = Math.min(frameDt, 1 / 30);
    // Sewing phase -> full gravity once seams are closed (or after a few seconds regardless)
    if (!this.sewn && (this.maxSeamGap() < 0.8 || this.time > 4)) this.sewn = true;
    const target = this.sewn ? 1 : 0.12;
    this.gravityScale += Math.sign(target - this.gravityScale) * Math.min(Math.abs(target - this.gravityScale), dt * 1.5);
    this.buildColliderMasks();
    const sub = this.opts.substeps;
    const h = dt / sub;
    for (let s = 0; s < sub; s++) this.substep(h, s);
    this.time += dt;
  }

  /** Once per frame: which colliders are near each particle (bounding sphere + margin). */
  private buildColliderMasks() {
    const cols = this.colliders, x = this.x, n = this.n, m = this.colMask;
    const margin = 6 + this.opts.thickness;
    const count = Math.min(32, cols.length);
    this.thinMask = 0;
    for (let c = 0; c < count; c++) if (cols[c].kind === 'ring') this.thinMask |= 1 << c;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let mask = 0;
      for (let c = 0; c < count; c++) {
        const C = cols[c];
        const dx = x[o] - C.bc[0], dy = x[o + 1] - C.bc[1], dz = x[o + 2] - C.bc[2];
        const r = C.br + margin;
        if (dx * dx + dy * dy + dz * dz < r * r) mask |= 1 << c;
      }
      m[i] = mask;
    }
  }

  private substep(h: number, s: number) {
    const { x, p, v, n } = this;
    const damp = Math.exp(-(this.sewn ? 1.2 : 4) * h);
    const vMax = 600;
    const g = this.gravity * this.gravityScale * h;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      v[o + 1] += g;
      let vx = v[o] * damp, vy = v[o + 1] * damp, vz = v[o + 2] * damp;
      const sp = vx * vx + vy * vy + vz * vz;
      if (sp > vMax * vMax) { const k = vMax / Math.sqrt(sp); vx *= k; vy *= k; vz *= k; }
      p[o] = x[o] + vx * h;
      p[o + 1] = x[o + 1] + vy * h;
      p[o + 2] = x[o + 2] + vz * h;
    }

    for (let it = 0; it < this.opts.stretchIters; it++) this.solveDistance(this.data.stretch, this.data.stretchRest, this.alphaStretch);
    this.solveMaxDistance(this.data.longRange, this.data.longRest, this.longSlack);
    this.solveDistance(this.data.bend, this.data.bendRest, this.alphaBend);
    this.solveSeams(h);
    if (this.opts.selfCollision && s % 3 === 0) this.solveRepulsion();
    this.solveCollisions();

    const inv = 1 / h;
    for (let i = 0; i < n * 3; i++) {
      v[i] = (p[i] - x[i]) * inv;
      x[i] = p[i];
    }
  }

  private solveDistance(pairs: Uint32Array, rest: Float32Array, alpha: number) {
    const p = this.p;
    const k0 = 1 / (2 + alpha);
    for (let c = 0, k = 0; k < pairs.length; c++, k += 2) {
      const a = pairs[k] * 3, b = pairs[k + 1] * 3;
      const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-7) continue;
      const corr = ((d - rest[c]) * k0) / d;
      p[a] += dx * corr; p[a + 1] += dy * corr; p[a + 2] += dz * corr;
      p[b] -= dx * corr; p[b + 1] -= dy * corr; p[b + 2] -= dz * corr;
    }
  }

  /** One-sided constraint: only pulls together when stretched past rest * slack. */
  private solveMaxDistance(pairs: Uint32Array, rest: Float32Array, slack: number) {
    const p = this.p;
    for (let c = 0, k = 0; k < pairs.length; c++, k += 2) {
      const a = pairs[k] * 3, b = pairs[k + 1] * 3;
      const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      const r = rest[c] * slack;
      if (d2 <= r * r) continue;
      const d = Math.sqrt(d2);
      const corr = ((d - r) * 0.5) / d;
      p[a] += dx * corr; p[a + 1] += dy * corr; p[a + 2] += dz * corr;
      p[b] -= dx * corr; p[b + 1] -= dy * corr; p[b + 2] -= dz * corr;
    }
  }

  private solveSeams(h: number) {
    const p = this.p, pairs = this.data.seams;
    const maxStep = this.opts.seamSpeed * h;
    for (let k = 0; k < pairs.length; k += 2) {
      const a = pairs[k] * 3, b = pairs[k + 1] * 3;
      const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-6) continue;
      // Far apart: pull at a capped speed. Close: snap shut like a stitch.
      let move = d * 0.5;
      if (!this.sewn && d > 0.6) move = Math.min(move, maxStep);
      const k2 = move / d;
      p[a] += dx * k2; p[a + 1] += dy * k2; p[a + 2] += dz * k2;
      p[b] -= dx * k2; p[b + 1] -= dy * k2; p[b + 2] -= dz * k2;
    }
  }

  private solveCollisions() {
    const p = this.p, x = this.x, nT = this.nTmp, mu = this.friction, th = this.opts.thickness;
    const cols = this.colliders, masks = this.colMask;
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      let mask = masks[i];
      while (mask) {
        const c = 31 - Math.clz32(mask);
        mask &= ~(1 << c);
        if (collide(cols[c], p, o, th, nT, x)) this.applyFriction(o, nT, mu);
      }
      if (this.opts.ground && p[o + 1] < th) {
        p[o + 1] = th;
        nT[0] = 0; nT[1] = 1; nT[2] = 0;
        this.applyFriction(o, nT, Math.min(1, mu + 0.3));
      }
    }
    if (this.thinMask) this.collideEdgeMidpoints();
  }

  /** Thin rings can slip between particles, so also collide the midpoint of every nearby edge. */
  private collideEdgeMidpoints() {
    const p = this.p, x = this.x, m = this.mid, mp = this.midPrev, nT = this.nTmp, th = this.opts.thickness;
    const e = this.data.stretch, cols = this.colliders, masks = this.colMask;
    for (let k = 0; k < e.length; k += 2) {
      const ia = e[k], ib = e[k + 1];
      let mask = (masks[ia] | masks[ib]) & this.thinMask;
      if (!mask) continue;
      const a = ia * 3, b = ib * 3;
      while (mask) {
        const c = 31 - Math.clz32(mask);
        mask &= ~(1 << c);
        m[0] = (p[a] + p[b]) * 0.5; m[1] = (p[a + 1] + p[b + 1]) * 0.5; m[2] = (p[a + 2] + p[b + 2]) * 0.5;
        mp[0] = (x[a] + x[b]) * 0.5; mp[1] = (x[a + 1] + x[b + 1]) * 0.5; mp[2] = (x[a + 2] + x[b + 2]) * 0.5;
        const ox = m[0], oy = m[1], oz = m[2];
        if (collide(cols[c], m, 0, th, nT, mp)) {
          const dx = m[0] - ox, dy = m[1] - oy, dz = m[2] - oz;
          p[a] += dx; p[a + 1] += dy; p[a + 2] += dz;
          p[b] += dx; p[b + 1] += dy; p[b + 2] += dz;
        }
      }
    }
  }

  private applyFriction(o: number, nrm: Float32Array, mu: number) {
    const p = this.p, x = this.x;
    const dx = p[o] - x[o], dy = p[o + 1] - x[o + 1], dz = p[o + 2] - x[o + 2];
    const dn = dx * nrm[0] + dy * nrm[1] + dz * nrm[2];
    const tx = dx - dn * nrm[0], ty = dy - dn * nrm[1], tz = dz - dn * nrm[2];
    p[o] -= tx * mu; p[o + 1] -= ty * mu; p[o + 2] -= tz * mu;
  }

  /** Keeps different pieces from passing through each other (particle repulsion on a hash grid). */
  private solveRepulsion() {
    if (this.data.pieces.length < 2) return;
    const p = this.p, n = this.n, r = this.repelRadius, r2 = r * r;
    const head = this.hashHead, next = this.hashNext, size = head.length;
    const pieceOf = this.data.pieceOf, ps = this.partnerStart, pl = this.partnerList;
    head.fill(-1);
    const inv = 1 / r;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const hh = ((Math.imul(Math.floor(p[o] * inv), 92837111) ^ Math.imul(Math.floor(p[o + 1] * inv), 689287499) ^ Math.imul(Math.floor(p[o + 2] * inv), 283923481)) >>> 0) % size;
      next[i] = head[hh];
      head[hh] = i;
    }
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const cx = Math.floor(p[o] * inv), cy = Math.floor(p[o + 1] * inv), cz = Math.floor(p[o + 2] * inv);
      const pi = pieceOf[i];
      const p0 = ps[i], p1 = ps[i + 1];
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        const hx = Math.imul(ix, 92837111);
        for (let iy = cy - 1; iy <= cy + 1; iy++) {
          const hy = hx ^ Math.imul(iy, 689287499);
          for (let iz = cz - 1; iz <= cz + 1; iz++) {
            let j = head[((hy ^ Math.imul(iz, 283923481)) >>> 0) % size];
            while (j !== -1) {
              if (j > i && pieceOf[j] !== pi) {
                const q = j * 3;
                const dx = p[q] - p[o], dy = p[q + 1] - p[o + 1], dz = p[q + 2] - p[o + 2];
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < r2 && d2 > 1e-10) {
                  let partner = false;
                  for (let k = p0; k < p1; k++) if (pl[k] === j) { partner = true; break; }
                  if (!partner) {
                    const d = Math.sqrt(d2);
                    const k = ((r - d) * 0.5) / d;
                    p[o] -= dx * k; p[o + 1] -= dy * k; p[o + 2] -= dz * k;
                    p[q] += dx * k; p[q + 1] += dy * k; p[q + 2] += dz * k;
                  }
                }
              }
              j = next[j];
            }
          }
        }
      }
    }
  }

  private maxSeamGap(): number {
    const pairs = this.data.seams, x = this.x;
    let m = 0;
    for (let k = 0; k < pairs.length; k += 2) {
      const a = pairs[k] * 3, b = pairs[k + 1] * 3;
      const d = Math.hypot(x[b] - x[a], x[b + 1] - x[a + 1], x[b + 2] - x[a + 2]);
      if (d > m) m = d;
    }
    return m;
  }

  /** Average distance still left on seams, for the "sewing" readout. */
  seamGap(): number {
    const pairs = this.data.seams, x = this.x;
    if (pairs.length === 0) return 0;
    let sum = 0;
    for (let k = 0; k < pairs.length; k += 2) {
      const a = pairs[k] * 3, b = pairs[k + 1] * 3;
      sum += Math.hypot(x[b] - x[a], x[b + 1] - x[a + 1], x[b + 2] - x[a + 2]);
    }
    return sum / (pairs.length / 2);
  }
}
