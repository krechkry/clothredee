// Project data model. Everything here is plain JSON so it can be saved, loaded and undone.
// Units: centimeters, radians.

export type Vec2 = [number, number];

export type WrapMode = 'flat' | 'vertical' | 'horizontal';

export interface Placement {
  // Flat: where the piece's center goes. Wrapped: the axis of the wrap cylinder (at the piece's mid height).
  x: number; y: number; z: number;
  yaw: number;   // rotation around world Y
  pitch: number; // rotation around local X
  wrap: WrapMode;
  radius: number; // wrap cylinder radius (cm), used when wrap != flat
}

export interface Piece {
  id: string;
  name: string;
  color: string;
  points: Vec2[];      // polygon in piece-local cm, counter-clockwise
  layout: Vec2;        // where the piece sits in the 2D pattern window
  placement: Placement;
}

export interface EdgeRef { piece: string; edge: number }

export interface Seam {
  id: string;
  a: EdgeRef;
  b: EdgeRef;
  reversed: boolean; // true: a.start meets b.end (the usual case for two CCW pieces)
}

export interface Ring {
  id: string;
  x: number; y: number; z: number;
  yaw: number;   // ring faces +Z at yaw 0 (hole axis = Z)
  tilt: number;  // rotation around local X
  radius: number; // major radius
  tube: number;   // tube radius
}

export interface Avatar {
  height: number; // multiplier, 1 = 175 cm
  chest: number;
  waist: number;
  hips: number;
}

export interface Fabric {
  preset: string;
  stretch: number;  // 0..1 (1 = very stiff)
  bend: number;     // 0..1
  weight: number;   // gravity multiplier
  friction: number; // 0..1
}

export interface Project {
  version: 1;
  name: string;
  scene: 'avatar' | 'empty';
  pieces: Piece[];
  seams: Seam[];
  rings: Ring[];
  avatar: Avatar;
  fabric: Fabric;
  particleDistance: number; // cm
}

let idCounter = 0;
export function uid(prefix = 'p'): string {
  idCounter++;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Make polygon counter-clockwise (y up). Returns true if it was flipped. */
export function ensureCCW(pts: Vec2[]): boolean {
  if (signedArea(pts) < 0) { pts.reverse(); return true; }
  return false;
}

export function edgeLength(p: Piece, e: number): number {
  const a = p.points[e];
  const b = p.points[(e + 1) % p.points.length];
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export const FABRICS: Record<string, Omit<Fabric, 'preset'>> = {
  Cotton: { stretch: 0.85, bend: 0.25, weight: 1.0, friction: 0.5 },
  Denim: { stretch: 0.97, bend: 0.6, weight: 1.6, friction: 0.45 },
  Silk: { stretch: 0.75, bend: 0.05, weight: 0.6, friction: 0.15 },
  Jersey: { stretch: 0.45, bend: 0.12, weight: 0.9, friction: 0.5 },
  Leather: { stretch: 0.99, bend: 0.85, weight: 2.0, friction: 0.5 },
};

export const PIECE_COLORS = ['#e8d6b8', '#b8cfe8', '#e8b8c4', '#c4e8b8', '#d8b8e8', '#e8deb8', '#b8e8e0', '#f0c49a'];

export function defaultPlacement(): Placement {
  return { x: 0, y: 110, z: 25, yaw: 0, pitch: 0, wrap: 'flat', radius: 24 };
}

export function emptyProject(scene: Project['scene'] = 'avatar'): Project {
  return {
    version: 1,
    name: 'Untitled',
    scene,
    pieces: [],
    seams: [],
    rings: [],
    avatar: { height: 1, chest: 1, waist: 1, hips: 1 },
    fabric: { preset: 'Cotton', ...FABRICS.Cotton },
    particleDistance: 2,
  };
}

// ---------- Templates ----------

function tankFront(neckDepth: number): Vec2[] {
  // Origin at hem center, y up. Counter-clockwise.
  return [
    [-25, 0], [25, 0], [25, 45],
    [21, 48.5], [18, 53], [16.5, 58], [16, 64],   // right armhole
    [7.5, 66.5],                                 // right shoulder
    [5.5, 66.5 - neckDepth * 0.55], [3, 66.5 - neckDepth * 0.9], [0, 66.5 - neckDepth],
    [-3, 66.5 - neckDepth * 0.9], [-5.5, 66.5 - neckDepth * 0.55],
    [-7.5, 66.5],                                // left shoulder start
    [-16, 64], [-16.5, 58], [-18, 53], [-21, 48.5], [-25, 45],
  ];
}

export function tankTopTemplate(): Project {
  const p = emptyProject('avatar');
  p.name = 'Tank top';
  const front: Piece = {
    id: uid(), name: 'Front', color: PIECE_COLORS[0], points: tankFront(9), layout: [-30, 0],
    placement: { x: 0, y: 115, z: 0, yaw: 0, pitch: 0, wrap: 'vertical', radius: 23 },
  };
  const back: Piece = {
    id: uid(), name: 'Back', color: PIECE_COLORS[1], points: tankFront(3), layout: [30, 0],
    placement: { x: 0, y: 115, z: 0, yaw: Math.PI, pitch: 0, wrap: 'vertical', radius: 23 },
  };
  p.pieces.push(front, back);
  // Edge indices (CCW): 1 = right side (x=+25), 18 = left side (x=-25),
  // 6 = right shoulder (16,64)->(7.5,66.5), 13 = left shoulder (-7.5,66.5)->(-16,64)
  // Front's +x lands on the wearer's left (world +x); back's +x lands on world -x.
  const S = (a: Piece, ea: number, b: Piece, eb: number): Seam => ({ id: uid('s'), a: { piece: a.id, edge: ea }, b: { piece: b.id, edge: eb }, reversed: true });
  p.seams.push(S(front, 1, back, 18), S(front, 18, back, 1), S(front, 6, back, 13), S(front, 13, back, 6));
  return p;
}

export function skirtTemplate(): Project {
  const p = emptyProject('avatar');
  p.name = 'Skirt';
  // Simple A-line panel: waist 40 wide, hem 64 wide, 50 long
  const panel = (): Vec2[] => [[-32, 0], [32, 0], [20, 50], [0, 51], [-20, 50]];
  const front: Piece = { id: uid(), name: 'Front', color: PIECE_COLORS[2], points: panel(), layout: [-36, 0],
    placement: { x: 0, y: 79, z: 0, yaw: 0, pitch: 0, wrap: 'vertical', radius: 23 } };
  const back: Piece = { id: uid(), name: 'Back', color: PIECE_COLORS[3], points: panel(), layout: [36, 0],
    placement: { x: 0, y: 79, z: 0, yaw: Math.PI, pitch: 0, wrap: 'vertical', radius: 23 } };
  p.pieces.push(front, back);
  const S = (a: Piece, ea: number, b: Piece, eb: number): Seam => ({ id: uid('s'), a: { piece: a.id, edge: ea }, b: { piece: b.id, edge: eb }, reversed: true });
  // edges: 0 hem, 1 right side, 2,3 waist, 4 left side
  p.seams.push(S(front, 1, back, 4), S(front, 4, back, 1));
  return p;
}

export function hangingBagTemplate(): Project {
  const p = emptyProject('empty');
  p.name = 'Hanging bag';
  p.fabric = { preset: 'Denim', ...FABRICS.Denim };
  p.rings.push({ id: uid('r'), x: 0, y: 120, z: 0, yaw: 0, tilt: 0, radius: 7, tube: 0.9 });
  const panel = (): Vec2[] => [[-15, 0], [15, 0], [15, 30], [2, 30], [-2, 30], [-15, 30]];
  // edges: 0 bottom, 1 right side, 2 top right, 3 strap slot, 4 top left, 5 left side
  const front: Piece = { id: uid(), name: 'Front', color: PIECE_COLORS[0], points: panel(), layout: [-22, 0],
    placement: { x: 0, y: 84, z: 9, yaw: 0, pitch: 0, wrap: 'flat', radius: 20 } };
  const back: Piece = { id: uid(), name: 'Back', color: PIECE_COLORS[5], points: panel(), layout: [22, 0],
    placement: { x: 0, y: 84, z: -9, yaw: Math.PI, pitch: 0, wrap: 'flat', radius: 20 } };
  const strapLen = 56;
  const r = strapLen / Math.PI;
  const strap: Piece = { id: uid(), name: 'Strap', color: PIECE_COLORS[7], points: [[-2, 0], [2, 0], [2, strapLen], [-2, strapLen]], layout: [0, 40],
    // Bent into an arch through the ring: top of the arch sits at the ring center
    placement: { x: 0, y: 120 - r + 1, z: 0, yaw: 0, pitch: -Math.PI / 2, wrap: 'horizontal', radius: r } };
  p.pieces.push(front, back, strap);
  const S = (a: Piece, ea: number, b: Piece, eb: number): Seam => ({ id: uid('s'), a: { piece: a.id, edge: ea }, b: { piece: b.id, edge: eb }, reversed: true });
  p.seams.push(
    S(front, 0, back, 0),
    S(front, 1, back, 5),
    S(front, 5, back, 1),
    S(front, 3, strap, 0),
    S(back, 3, strap, 2),
  );
  return p;
}

export const TEMPLATES: Record<string, () => Project> = {
  'Tank top': tankTopTemplate,
  'Skirt': skirtTemplate,
  'Hanging bag': hangingBagTemplate,
  'Blank on mannequin': () => emptyProject('avatar'),
  'Blank empty scene': () => emptyProject('empty'),
};
