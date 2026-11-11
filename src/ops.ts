// Pattern editing operations that keep seams consistent.

import type { EdgeRef, Piece, Project, Vec2 } from './model';
import { ensureCCW, PIECE_COLORS, uid } from './model';

const sameEdge = (a: EdgeRef, b: EdgeRef) => a.piece === b.piece && a.edge === b.edge;

/** Insert a vertex on edge e at point pt. Seams on that edge are removed; later edges shift. Returns removed seam count. */
export function insertPoint(p: Project, piece: Piece, e: number, pt: Vec2): number {
  piece.points.splice(e + 1, 0, pt);
  const before = p.seams.length;
  p.seams = p.seams.filter(s => !((s.a.piece === piece.id && s.a.edge === e) || (s.b.piece === piece.id && s.b.edge === e)));
  for (const s of p.seams) for (const r of [s.a, s.b]) if (r.piece === piece.id && r.edge > e) r.edge++;
  return before - p.seams.length;
}

/** Remove vertex v (merging edges v-1 and v). Seams on both edges are removed. */
export function deletePoint(p: Project, piece: Piece, v: number): boolean {
  const n = piece.points.length;
  if (n <= 3) return false;
  const ePrev = (v - 1 + n) % n;
  p.seams = p.seams.filter(s => ![s.a, s.b].some(r => r.piece === piece.id && (r.edge === v || r.edge === ePrev)));
  piece.points.splice(v, 1);
  for (const s of p.seams) for (const r of [s.a, s.b]) {
    if (r.piece !== piece.id) continue;
    if (r.edge > v) r.edge--;
    else if (v === 0 && r.edge === n - 1) r.edge = n - 2; // wrap case (unreachable since removed, kept for safety)
  }
  return true;
}

export function addSeam(p: Project, a: EdgeRef, b: EdgeRef) {
  p.seams = p.seams.filter(s => !(sameEdge(s.a, a) || sameEdge(s.b, a) || sameEdge(s.a, b) || sameEdge(s.b, b)));
  const s = { id: uid('s'), a: { ...a }, b: { ...b }, reversed: true };
  p.seams.push(s);
  return s;
}

export function deletePiece(p: Project, id: string) {
  p.pieces = p.pieces.filter(x => x.id !== id);
  p.seams = p.seams.filter(s => s.a.piece !== id && s.b.piece !== id);
}

export function nextColor(p: Project) {
  return PIECE_COLORS[p.pieces.length % PIECE_COLORS.length];
}

export function duplicatePiece(p: Project, src: Piece, mirror: boolean): Piece {
  let pts: Vec2[] = src.points.map(([x, y]) => [mirror ? -x : x, y] as Vec2);
  if (mirror) ensureCCW(pts);
  const xs = src.points.map(q => q[0]);
  const w = Math.max(...xs) - Math.min(...xs);
  const piece: Piece = {
    id: uid(),
    name: src.name + (mirror ? ' (mirror)' : ' copy'),
    color: nextColor(p),
    points: pts,
    layout: [src.layout[0] + w + 8, src.layout[1]],
    placement: {
      ...src.placement,
      x: mirror ? -src.placement.x : src.placement.x + 5,
      yaw: mirror ? -src.placement.yaw : src.placement.yaw,
    },
  };
  p.pieces.push(piece);
  return piece;
}

/** New piece from a polygon given in pattern-window coordinates. */
export function newPiece(p: Project, worldPts: Vec2[], name: string): Piece {
  const xs = worldPts.map(q => q[0]), ys = worldPts.map(q => q[1]);
  const ox = Math.min(...xs), oy = Math.min(...ys);
  const pts: Vec2[] = worldPts.map(([x, y]) => [round(x - ox), round(y - oy)]);
  ensureCCW(pts);
  const h = Math.max(...ys) - oy;
  const avatar = p.scene === 'avatar';
  const piece: Piece = {
    id: uid(), name, color: nextColor(p), points: pts, layout: [round(ox), round(oy)],
    placement: avatar
      ? { x: 0, y: Math.max(h / 2 + 5, 148 - h / 2), z: 0, yaw: p.pieces.length % 2 ? Math.PI : 0, pitch: 0, wrap: 'vertical', radius: 26 }
      : { x: 0, y: 60 + h / 2, z: 15 + p.pieces.length * 4, yaw: 0, pitch: 0, wrap: 'flat', radius: 20 },
  };
  p.pieces.push(piece);
  return piece;
}

const round = (v: number) => Math.round(v * 10) / 10;
