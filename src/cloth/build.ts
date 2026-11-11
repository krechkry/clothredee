// Turns 2D pattern pieces + seams into a particle cloth ready to simulate.

import Delaunator from 'delaunator';
import type { Piece, Placement, Project, Vec2 } from '../model';

export interface PieceMesh {
  pieceId: string;
  start: number;          // first particle index
  count: number;
  tris: Uint32Array;      // global particle indices
  uv: Float32Array;       // 2 per particle (piece-local cm)
  edgeParticles: number[][]; // per polygon edge: particle indices from start corner to end corner (inclusive)
}

export interface ClothData {
  n: number;
  pos: Float32Array;      // arranged 3D positions (cm)
  stretch: Uint32Array;   // pairs
  stretchRest: Float32Array;
  bend: Uint32Array;
  bendRest: Float32Array;
  seams: Uint32Array;     // pairs to be pulled together
  longRange: Uint32Array; // pairs that may never be further apart than their flat 2D distance
  longRest: Float32Array;
  pieceOf: Uint16Array;   // piece index per particle
  pieces: PieceMesh[];
}

// ---------- geometry helpers ----------

export function pointInPolygon(x: number, y: number, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(px: number, py: number, a: Vec2, b: Vec2): { d: number; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = a[0] + dx * t, qy = a[1] + dy * t;
  return { d: Math.hypot(px - qx, py - qy), t };
}

export function bbox(pts: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** Map a piece-local 2D point into the 3D arrangement. */
export function placePoint(pl: Placement, cx: number, cy: number, u: number, v: number, out: number[] | Float32Array, o = 0) {
  let X: number, Y: number, Z: number;
  const du = u - cx, dv = v - cy;
  const r = Math.max(1, pl.radius);
  if (pl.wrap === 'vertical') {
    const a = du / r;
    X = r * Math.sin(a); Y = dv; Z = r * Math.cos(a);
  } else if (pl.wrap === 'horizontal') {
    const a = dv / r;
    X = du; Y = r * Math.sin(a); Z = r * Math.cos(a);
  } else {
    X = du; Y = dv; Z = 0;
  }
  // rotX(pitch)
  const cp = Math.cos(pl.pitch), sp = Math.sin(pl.pitch);
  const Y1 = Y * cp - Z * sp, Z1 = Y * sp + Z * cp;
  // rotY(yaw)
  const cyw = Math.cos(pl.yaw), syw = Math.sin(pl.yaw);
  const X2 = X * cyw + Z1 * syw, Z2 = -X * syw + Z1 * cyw;
  out[o] = pl.x + X2; out[o + 1] = pl.y + Y1; out[o + 2] = pl.z + Z2;
}

/** Number of segments each edge is split into. Sewn edges share the larger count. */
export function edgeSegmentCounts(project: Project, spacing: number): Map<string, number> {
  const counts = new Map<string, number>();
  const byId = new Map(project.pieces.map(p => [p.id, p]));
  const len = (pid: string, e: number) => {
    const p = byId.get(pid)!;
    const a = p.points[e], b = p.points[(e + 1) % p.points.length];
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  };
  for (const p of project.pieces) {
    for (let e = 0; e < p.points.length; e++) {
      counts.set(`${p.id}:${e}`, Math.max(1, Math.ceil(len(p.id, e) / spacing - 0.15)));
    }
  }
  // Seams force equal counts. Iterate in case an edge chain links several seams.
  for (let iter = 0; iter < 3; iter++) {
    for (const s of project.seams) {
      const ka = `${s.a.piece}:${s.a.edge}`, kb = `${s.b.piece}:${s.b.edge}`;
      if (!counts.has(ka) || !counts.has(kb)) continue;
      const m = Math.max(counts.get(ka)!, counts.get(kb)!);
      counts.set(ka, m); counts.set(kb, m);
    }
  }
  return counts;
}

interface LocalMesh {
  pts: Vec2[];
  tris: number[];
  edgeParticles: number[][];
}

export function meshPiece(piece: Piece, spacing: number, counts: Map<string, number>): LocalMesh {
  const poly = piece.points;
  const pts: Vec2[] = [];
  const edgeParticles: number[][] = [];
  const nE = poly.length;
  // Boundary samples
  const cornerIdx: number[] = [];
  for (let e = 0; e < nE; e++) {
    const a = poly[e], b = poly[(e + 1) % nE];
    const n = counts.get(`${piece.id}:${e}`) ?? 1;
    cornerIdx.push(pts.length);
    const list: number[] = [];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      list.push(pts.length);
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    edgeParticles.push(list);
  }
  // Close each edge list with the next corner
  for (let e = 0; e < nE; e++) edgeParticles[e].push(cornerIdx[(e + 1) % nE]);
  const nBoundary = pts.length;

  // Interior: triangular lattice
  const bb = bbox(poly);
  const h = spacing * Math.sqrt(3) / 2;
  const minClear = spacing * 0.55;
  for (let j = 0, y = bb.minY + h * 0.5; y < bb.maxY; j++, y += h) {
    const off = j % 2 ? spacing / 2 : 0;
    for (let x = bb.minX + off + spacing * 0.25; x < bb.maxX; x += spacing) {
      if (!pointInPolygon(x, y, poly)) continue;
      let ok = true;
      for (let e = 0; e < nE && ok; e++) if (distToSegment(x, y, poly[e], poly[(e + 1) % nE]).d < minClear) ok = false;
      if (ok) pts.push([x, y]);
    }
  }

  const tris: number[] = [];
  if (pts.length >= 3) {
    const del = Delaunator.from(pts);
    const t = del.triangles;
    const maxLen = spacing * 2.3;
    for (let i = 0; i < t.length; i += 3) {
      const a = pts[t[i]], b = pts[t[i + 1]], c = pts[t[i + 2]];
      const gx = (a[0] + b[0] + c[0]) / 3, gy = (a[1] + b[1] + c[1]) / 3;
      if (!pointInPolygon(gx, gy, poly)) continue;
      const l1 = Math.hypot(a[0] - b[0], a[1] - b[1]), l2 = Math.hypot(b[0] - c[0], b[1] - c[1]), l3 = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (Math.max(l1, l2, l3) > maxLen) continue;
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      if (area < spacing * spacing * 0.02) continue;
      // Reject triangles made only of boundary points that hug a concave corner from outside
      if (t[i] < nBoundary && t[i + 1] < nBoundary && t[i + 2] < nBoundary) {
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const nx = (b[0] + c[0]) / 2, ny = (b[1] + c[1]) / 2;
        const ox = (c[0] + a[0]) / 2, oy = (c[1] + a[1]) / 2;
        const inside = (x: number, y: number) => pointInPolygon(x, y, poly) || onBoundary(x, y, poly);
        if (!inside(mx, my) || !inside(nx, ny) || !inside(ox, oy)) continue;
      }
      // CCW in 2D -> consistent outward-facing normals after placement
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (cross > 0) tris.push(t[i], t[i + 1], t[i + 2]);
      else tris.push(t[i], t[i + 2], t[i + 1]);
    }
  }
  return { pts, tris, edgeParticles };
}

function onBoundary(x: number, y: number, poly: Vec2[]): boolean {
  for (let e = 0; e < poly.length; e++) if (distToSegment(x, y, poly[e], poly[(e + 1) % poly.length]).d < 1e-3) return true;
  return false;
}

export function buildCloth(project: Project): ClothData {
  const spacing = Math.max(0.5, project.particleDistance);
  const counts = edgeSegmentCounts(project, spacing);
  const meshes = project.pieces.map(p => meshPiece(p, spacing, counts));
  const n = meshes.reduce((s, m) => s + m.pts.length, 0);
  const pos = new Float32Array(n * 3);
  const pieceOf = new Uint16Array(n);
  const stretch: number[] = [], stretchRest: number[] = [];
  const bend: number[] = [], bendRest: number[] = [];
  const pieces: PieceMesh[] = [];
  const longRange: number[] = [], longRest: number[] = [];
  let seed = 1234567;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

  let start = 0;
  meshes.forEach((m, pi) => {
    const piece = project.pieces[pi];
    const bb = bbox(piece.points);
    const uv = new Float32Array(m.pts.length * 2);
    m.pts.forEach(([u, v], i) => {
      placePoint(piece.placement, bb.cx, bb.cy, u, v, pos, (start + i) * 3);
      pieceOf[start + i] = pi;
      uv[i * 2] = u; uv[i * 2 + 1] = v;
    });
    // Edges & bending from triangle adjacency
    const edgeMap = new Map<number, number>(); // key -> opposite vertex of first triangle
    const key = (a: number, b: number) => (a < b ? a * 1e6 + b : b * 1e6 + a);
    const dist2D = (a: number, b: number) => Math.hypot(m.pts[a][0] - m.pts[b][0], m.pts[a][1] - m.pts[b][1]);
    for (let t = 0; t < m.tris.length; t += 3) {
      const tri = [m.tris[t], m.tris[t + 1], m.tris[t + 2]];
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3], opp = tri[(k + 2) % 3];
        const kk = key(a, b);
        if (!edgeMap.has(kk)) {
          edgeMap.set(kk, opp);
          stretch.push(start + a, start + b);
          stretchRest.push(dist2D(a, b));
        } else {
          const o2 = edgeMap.get(kk)!;
          if (o2 >= 0) {
            bend.push(start + o2, start + opp);
            bendRest.push(dist2D(o2, opp));
            edgeMap.set(kk, -1);
          }
        }
      }
    }
    // Long-range limits: a few far-away partners per particle (stops the slow "creep" of hanging cloth)
    const np = m.pts.length;
    for (let i = 0; i < np; i++) {
      let added = 0;
      for (let tries = 0; tries < 14 && added < 2; tries++) {
        const j = Math.floor(rand() * np);
        if (j <= i) continue;
        const d = dist2D(i, j);
        if (d < spacing * 3 || d > spacing * 14) continue;
        // only valid if the straight 2D line stays inside the piece (concave pieces)
        const mx = (m.pts[i][0] + m.pts[j][0]) / 2, my = (m.pts[i][1] + m.pts[j][1]) / 2;
        if (!pointInPolygon(mx, my, piece.points)) continue;
        longRange.push(start + i, start + j);
        longRest.push(d);
        added++;
      }
    }
    const trisG = new Uint32Array(m.tris.length);
    for (let i = 0; i < m.tris.length; i++) trisG[i] = m.tris[i] + start;
    pieces.push({
      pieceId: piece.id,
      start,
      count: m.pts.length,
      tris: trisG,
      uv,
      edgeParticles: m.edgeParticles.map(l => l.map(i => i + start)),
    });
    start += m.pts.length;
  });

  // Seams
  const seamPairs: number[] = [];
  const seen = new Set<string>();
  const pieceIdx = new Map(project.pieces.map((p, i) => [p.id, i]));
  for (const s of project.seams) {
    const ia = pieceIdx.get(s.a.piece), ib = pieceIdx.get(s.b.piece);
    if (ia === undefined || ib === undefined) continue;
    const A = pieces[ia].edgeParticles[s.a.edge], B = pieces[ib].edgeParticles[s.b.edge];
    if (!A || !B || A.length !== B.length) continue;
    const n1 = A.length - 1;
    for (let k = 0; k <= n1; k++) {
      const a = A[k], b = B[s.reversed ? n1 - k : k];
      if (a === b) continue;
      const kk = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(kk)) continue;
      seen.add(kk);
      seamPairs.push(a, b);
    }
  }

  return {
    n, pos, pieceOf, pieces,
    stretch: new Uint32Array(stretch), stretchRest: new Float32Array(stretchRest),
    bend: new Uint32Array(bend), bendRest: new Float32Array(bendRest),
    seams: new Uint32Array(seamPairs),
    longRange: new Uint32Array(longRange), longRest: new Float32Array(longRest),
  };
}
