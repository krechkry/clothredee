// 2D pattern window: draw pieces, edit points, sew edges.

import type { Store } from './store';
import type { EdgeRef, Piece, Vec2 } from './model';
import { addSeam, deletePiece, deletePoint, insertPoint, newPiece } from './ops';
import { distToSegment, pointInPolygon } from './cloth/build';

export type Tool = 'select' | 'rect' | 'poly' | 'point' | 'sew';

export const SEAM_COLORS = ['#ff9f43', '#54a0ff', '#ee5a6f', '#1dd1a1', '#c56cf0', '#feca57', '#48dbfb', '#ff6bcb'];

interface EdgeHit { piece: Piece; edge: number; t: number; pt: Vec2; d: number }

export class PatternEditor {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tool: Tool = 'select';
  scale = 4; ox = 0; oy = 0;
  private dpr = 1;
  private dirty = true;
  private hoverEdge: EdgeHit | null = null;
  private hoverVertex: number | null = null;
  private mouse: Vec2 = [0, 0]; // world
  private poly: Vec2[] = [];
  private rectStart: Vec2 | null = null;
  private drag: null | { kind: 'pan' | 'piece' | 'vertex'; sx: number; sy: number; ox: number; oy: number; start: Vec2; moved: boolean; orig?: Vec2 } = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; cx: number; cy: number; scale: number; ox: number; oy: number } | null = null;
  onToolChange: (t: Tool) => void = () => {};
  onStatus: (s: string) => void = () => {};

  constructor(private host: HTMLElement, private store: Store) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pattern-canvas';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.fit();
    this.bindEvents();
    store.on(kind => { if (kind === 'all') this.fit(); this.dirty = true; });
    const loop = () => { if (this.dirty) { this.dirty = false; this.draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  setTool(t: Tool) {
    this.tool = t;
    this.poly = [];
    this.rectStart = null;
    this.store.sewFirst = null;
    this.canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    this.onToolChange(t);
    this.dirty = true;
    const hints: Record<Tool, string> = {
      select: 'Click a piece to select. Drag points to reshape. Drag empty space to pan, wheel to zoom.',
      rect: 'Drag to draw a rectangle piece.',
      poly: 'Click to add points. Click the first point, double-click or press Enter to close. Esc cancels.',
      point: 'Click on an edge to add a point (splits the edge).',
      sew: 'Click an edge, then the edge it sews to. Arrows show which ends meet.',
    };
    this.onStatus(hints[t]);
  }

  redraw() { this.dirty = true; }

  // ---------- coordinates ----------
  toScreen(x: number, y: number): Vec2 { return [x * this.scale + this.ox, -y * this.scale + this.oy]; }
  toWorld(sx: number, sy: number): Vec2 { return [(sx - this.ox) / this.scale, -(sy - this.oy) / this.scale]; }
  private wp(p: Piece, i: number): Vec2 { const q = p.points[i]; return [q[0] + p.layout[0], q[1] + p.layout[1]]; }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * this.dpr);
    this.canvas.height = Math.max(1, r.height * this.dpr);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.dirty = true;
  }

  fit() {
    const r = this.host.getBoundingClientRect();
    const ps = this.store.project.pieces;
    if (!ps.length || r.width < 10) { this.scale = 4; this.ox = r.width / 2; this.oy = r.height / 2 + 100; this.dirty = true; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ps) for (let i = 0; i < p.points.length; i++) {
      const [x, y] = this.wp(p, i);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const pad = 40;
    this.scale = Math.min((r.width - pad * 2) / Math.max(10, maxX - minX), (r.height - pad * 2) / Math.max(10, maxY - minY), 20);
    this.ox = r.width / 2 - ((minX + maxX) / 2) * this.scale;
    this.oy = r.height / 2 + ((minY + maxY) / 2) * this.scale;
    this.dirty = true;
  }

  // ---------- hit testing ----------
  private edgeAt(sx: number, sy: number, tolPx = 9): EdgeHit | null {
    const [wx, wy] = this.toWorld(sx, sy);
    let best: EdgeHit | null = null;
    for (const p of this.store.project.pieces) {
      for (let e = 0; e < p.points.length; e++) {
        const a = this.wp(p, e), b = this.wp(p, (e + 1) % p.points.length);
        const { d, t } = distToSegment(wx, wy, a, b);
        const dpx = d * this.scale;
        if (dpx < tolPx && (!best || dpx < best.d)) {
          best = { piece: p, edge: e, t, pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d: dpx };
        }
      }
    }
    return best;
  }

  private vertexAt(sx: number, sy: number): number | null {
    const p = this.store.piece(this.store.sel.piece);
    if (!p) return null;
    for (let i = 0; i < p.points.length; i++) {
      const [x, y] = this.toScreen(...this.wp(p, i));
      if (Math.hypot(x - sx, y - sy) < 9) return i;
    }
    return null;
  }

  private pieceAt(sx: number, sy: number): Piece | null {
    const [wx, wy] = this.toWorld(sx, sy);
    const ps = this.store.project.pieces;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      if (pointInPolygon(wx - p.layout[0], wy - p.layout[1], p.points)) return p;
    }
    return null;
  }

  private seamOnEdge(r: EdgeRef) {
    return this.store.project.seams.find(s => (s.a.piece === r.piece && s.a.edge === r.edge) || (s.b.piece === r.piece && s.b.edge === r.edge)) ?? null;
  }

  // ---------- events ----------
  private bindEvents() {
    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => this.onDown(e));
    c.addEventListener('pointermove', e => this.onMove(e));
    c.addEventListener('pointerup', e => this.onUp(e));
    c.addEventListener('pointercancel', e => this.onUp(e));
    c.addEventListener('dblclick', () => { if (this.tool === 'poly') this.closePoly(); });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.zoomAt(sx, sy, k);
    }, { passive: false });
  }

  private zoomAt(sx: number, sy: number, k: number) {
    const ns = Math.min(60, Math.max(0.3, this.scale * k));
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = ns;
    this.ox = sx - wx * ns;
    this.oy = sy + wy * ns;
    this.dirty = true;
  }

  private local(e: PointerEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private snap(v: Vec2): Vec2 {
    const g = this.scale > 8 ? 0.5 : 1;
    return [Math.round(v[0] / g) * g, Math.round(v[1] / g) * g];
  }

  private onDown(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const r = this.canvas.getBoundingClientRect();
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top, scale: this.scale, ox: this.ox, oy: this.oy };
      this.drag = null;
      this.rectStart = null;
      return;
    }
    const [sx, sy] = this.local(e);
    const w = this.toWorld(sx, sy);
    const st = this.store;
    if (e.button === 1 || e.button === 2) { this.startPan(sx, sy); return; }

    switch (this.tool) {
      case 'select': {
        const v = this.vertexAt(sx, sy);
        const p = st.piece(st.sel.piece);
        if (v !== null && p) {
          st.select({ piece: p.id, vertex: v });
          this.drag = { kind: 'vertex', sx, sy, ox: 0, oy: 0, start: w, moved: false, orig: [...p.points[v]] as Vec2 };
          return;
        }
        const eh = this.edgeAt(sx, sy, 6);
        if (eh) {
          const seam = this.seamOnEdge({ piece: eh.piece.id, edge: eh.edge });
          if (seam) { st.select({ seam: seam.id, piece: eh.piece.id }); return; }
        }
        const hit = this.pieceAt(sx, sy);
        if (hit) {
          st.select({ piece: hit.id });
          this.drag = { kind: 'piece', sx, sy, ox: hit.layout[0], oy: hit.layout[1], start: w, moved: false };
          return;
        }
        st.select({});
        this.startPan(sx, sy);
        return;
      }
      case 'rect':
        this.rectStart = this.snap(w);
        this.mouse = this.snap(w);
        this.dirty = true;
        return;
      case 'poly': {
        const pt = this.snap(w);
        if (this.poly.length >= 3) {
          const [fx, fy] = this.toScreen(...this.poly[0]);
          if (Math.hypot(fx - sx, fy - sy) < 10) { this.closePoly(); return; }
        }
        this.poly.push(pt);
        this.dirty = true;
        return;
      }
      case 'point': {
        const eh = this.edgeAt(sx, sy);
        if (!eh) return;
        const local: Vec2 = [Math.round((eh.pt[0] - eh.piece.layout[0]) * 10) / 10, Math.round((eh.pt[1] - eh.piece.layout[1]) * 10) / 10];
        let removed = 0;
        st.commit('geometry', p => {
          const piece = p.pieces.find(x => x.id === eh.piece.id)!;
          removed = insertPoint(p, piece, eh.edge, local);
        });
        st.select({ piece: eh.piece.id, vertex: eh.edge + 1 });
        if (removed) this.onStatus('Point added. The seam on that edge was removed, sew the new edges again.');
        return;
      }
      case 'sew': {
        const eh = this.edgeAt(sx, sy);
        if (!eh) { st.sewFirst = null; this.dirty = true; return; }
        const ref = { piece: eh.piece.id, edge: eh.edge };
        if (!st.sewFirst) { st.sewFirst = ref; this.dirty = true; this.onStatus('Now click the edge to sew it to.'); return; }
        if (st.sewFirst.piece === ref.piece && st.sewFirst.edge === ref.edge) { st.sewFirst = null; this.dirty = true; return; }
        const first = st.sewFirst;
        st.sewFirst = null;
        let id = '';
        st.commit('geometry', p => { id = addSeam(p, first, ref).id; });
        st.select({ seam: id });
        this.onStatus('Sewn. If the 3D seam lines cross, use Flip on the seam.');
        return;
      }
    }
  }

  private startPan(sx: number, sy: number) {
    this.drag = { kind: 'pan', sx, sy, ox: this.ox, oy: this.oy, start: [0, 0], moved: false };
    this.canvas.style.cursor = 'grabbing';
  }

  private onMove(e: PointerEvent) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const r = this.canvas.getBoundingClientRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      const P = this.pinch;
      const ns = Math.min(60, Math.max(0.3, P.scale * (d / P.d)));
      const wx = (P.cx - P.ox) / P.scale, wy = -(P.cy - P.oy) / P.scale;
      this.scale = ns;
      this.ox = cx - wx * ns;
      this.oy = cy + wy * ns;
      this.dirty = true;
      return;
    }
    const [sx, sy] = this.local(e);
    const w = this.toWorld(sx, sy);
    this.mouse = this.tool === 'rect' || this.tool === 'poly' ? this.snap(w) : w;
    const st = this.store;
    const d = this.drag;
    if (d) {
      const dx = sx - d.sx, dy = sy - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      if (d.kind === 'pan') { this.ox = d.ox + dx; this.oy = d.oy + dy; this.dirty = true; return; }
      const p = st.piece(st.sel.piece);
      if (!p) return;
      if (!d.moved) st.snapshot();
      d.moved = true;
      if (d.kind === 'piece') {
        p.layout = [Math.round((d.ox + dx / this.scale) * 10) / 10, Math.round((d.oy - dy / this.scale) * 10) / 10];
        st.emit('meta');
      } else if (d.kind === 'vertex' && st.sel.vertex !== null && d.orig) {
        const nx = d.orig[0] + (w[0] - d.start[0]), ny = d.orig[1] + (w[1] - d.start[1]);
        const g = e.shiftKey ? 1 : 0.1;
        p.points[st.sel.vertex] = [Math.round(nx / g) * g, Math.round(ny / g) * g];
        st.emit('geometry');
        const n = p.points.length, v = st.sel.vertex;
        const a = p.points[(v - 1 + n) % n], b = p.points[v], c = p.points[(v + 1) % n];
        this.onStatus(`Point ${b[0].toFixed(1)}, ${b[1].toFixed(1)} cm  ·  edges ${Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(1)} / ${Math.hypot(c[0] - b[0], c[1] - b[1]).toFixed(1)} cm`);
      }
      return;
    }
    const prevE = this.hoverEdge, prevV = this.hoverVertex;
    this.hoverVertex = this.tool === 'select' ? this.vertexAt(sx, sy) : null;
    this.hoverEdge = this.hoverVertex === null ? this.edgeAt(sx, sy) : null;
    if (this.tool === 'select') this.canvas.style.cursor = this.hoverVertex !== null ? 'move' : this.pieceAt(sx, sy) ? 'grab' : 'default';
    if (this.hoverEdge !== prevE || this.hoverVertex !== prevV || this.tool !== 'select') this.dirty = true;
  }

  private onUp(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.tool === 'rect' && this.rectStart) {
      const a = this.rectStart, b = this.mouse;
      this.rectStart = null;
      if (Math.abs(b[0] - a[0]) >= 2 && Math.abs(b[1] - a[1]) >= 2) {
        let id = '';
        this.store.commit('geometry', p => {
          const n = p.pieces.length + 1;
          id = newPiece(p, [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]], `Piece ${n}`).id;
        });
        this.store.select({ piece: id });
        this.setTool('select');
      }
      this.dirty = true;
    }
    if (this.drag?.kind === 'pan') this.canvas.style.cursor = this.tool === 'select' ? 'default' : 'crosshair';
    this.drag = null;
  }

  closePoly() {
    if (this.poly.length < 3) return;
    const pts = this.poly;
    this.poly = [];
    let id = '';
    this.store.commit('geometry', p => { id = newPiece(p, pts, `Piece ${p.pieces.length + 1}`).id; });
    this.store.select({ piece: id });
    this.setTool('select');
  }

  cancel() {
    if (this.poly.length || this.rectStart || this.store.sewFirst) {
      this.poly = []; this.rectStart = null; this.store.sewFirst = null; this.dirty = true;
      return true;
    }
    return false;
  }

  deleteSelection() {
    const st = this.store, s = st.sel;
    if (s.seam) { st.commit('geometry', p => { p.seams = p.seams.filter(x => x.id !== s.seam); }); st.select({}); return; }
    const p = st.piece(s.piece);
    if (p && s.vertex !== null) {
      const v = s.vertex;
      st.commit('geometry', pr => { deletePoint(pr, pr.pieces.find(x => x.id === p.id)!, v); });
      st.select({ piece: p.id });
      return;
    }
    if (p) { st.commit('geometry', pr => deletePiece(pr, p.id)); st.select({}); return; }
    if (s.ring) { st.commit('scene', pr => { pr.rings = pr.rings.filter(r => r.id !== s.ring); }); st.select({}); }
  }

  // ---------- drawing ----------
  private draw() {
    const { ctx, dpr } = this;
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n: string) => css.getPropertyValue(n).trim();
    ctx.fillStyle = col('--pattern-bg');
    ctx.fillRect(0, 0, W, H);

    // Grid
    const step = this.scale < 1.5 ? 50 : this.scale < 6 ? 10 : 5;
    const [x0, y1] = this.toWorld(0, 0), [x1, y0] = this.toWorld(W, H);
    ctx.lineWidth = 1;
    for (let gx = Math.floor(x0 / step) * step; gx <= x1; gx += step) {
      const [sx] = this.toScreen(gx, 0);
      ctx.strokeStyle = gx % 50 === 0 ? col('--grid-strong') : col('--grid');
      ctx.beginPath(); ctx.moveTo(Math.round(sx) + 0.5, 0); ctx.lineTo(Math.round(sx) + 0.5, H); ctx.stroke();
    }
    for (let gy = Math.floor(y0 / step) * step; gy <= y1; gy += step) {
      const [, sy] = this.toScreen(0, gy);
      ctx.strokeStyle = gy % 50 === 0 ? col('--grid-strong') : col('--grid');
      ctx.beginPath(); ctx.moveTo(0, Math.round(sy) + 0.5); ctx.lineTo(W, Math.round(sy) + 0.5); ctx.stroke();
    }

    const st = this.store;
    const pr = st.project;
    const accent = col('--accent');

    // Pieces
    for (const p of pr.pieces) {
      ctx.beginPath();
      p.points.forEach((_, i) => { const [sx, sy] = this.toScreen(...this.wp(p, i)); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.closePath();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      const sel = st.sel.piece === p.id;
      ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeStyle = sel ? accent : col('--piece-line');
      ctx.stroke();
      // name
      const xs = p.points.map(q => q[0]), ys = p.points.map(q => q[1]);
      const [cx, cy] = this.toScreen(p.layout[0] + (Math.min(...xs) + Math.max(...xs)) / 2, p.layout[1] + (Math.min(...ys) + Math.max(...ys)) / 2);
      ctx.fillStyle = 'rgba(20,20,24,0.75)';
      ctx.font = '600 12px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.name, cx, cy);
    }

    // Seams
    pr.seams.forEach((s, k) => {
      const c = SEAM_COLORS[k % SEAM_COLORS.length];
      const sel = st.sel.seam === s.id;
      this.drawSeamEdge(s.a, c, false, sel, k + 1);
      this.drawSeamEdge(s.b, c, s.reversed, sel, k + 1);
    });

    // Sew first pick
    if (st.sewFirst) this.drawEdge(st.sewFirst, accent, 4, [6, 4]);
    // Hover edge
    if (this.hoverEdge && this.tool !== 'rect' && this.tool !== 'poly') {
      const h = this.hoverEdge;
      this.drawEdge({ piece: h.piece.id, edge: h.edge }, col('--hover'), 3);
      const n = h.piece.points.length;
      const a = h.piece.points[h.edge], b = h.piece.points[(h.edge + 1) % n];
      const [sx, sy] = this.toScreen(...h.pt);
      this.label(`${Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(1)} cm`, sx + 10, sy - 12);
      if (this.tool === 'point') {
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Vertices of selected piece
    const sp = st.piece(st.sel.piece);
    if (sp && this.tool === 'select') {
      sp.points.forEach((_, i) => {
        const [sx, sy] = this.toScreen(...this.wp(sp, i));
        const active = st.sel.vertex === i || this.hoverVertex === i;
        ctx.fillStyle = active ? accent : '#ffffff';
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 1;
        ctx.fillRect(sx - 4, sy - 4, 8, 8);
        ctx.strokeRect(sx - 4 + 0.5, sy - 4 + 0.5, 7, 7);
      });
    }

    // In-progress shapes
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    if (this.rectStart) {
      const [ax, ay] = this.toScreen(...this.rectStart), [bx, by] = this.toScreen(...this.mouse);
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
      this.label(`${Math.abs(this.mouse[0] - this.rectStart[0]).toFixed(1)} × ${Math.abs(this.mouse[1] - this.rectStart[1]).toFixed(1)} cm`, bx + 10, by + 14);
    }
    if (this.poly.length) {
      ctx.beginPath();
      this.poly.forEach((q, i) => { const [sx, sy] = this.toScreen(...q); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      const [mx, my] = this.toScreen(...this.mouse);
      ctx.lineTo(mx, my);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const q of this.poly) { const [sx, sy] = this.toScreen(...q); ctx.fillStyle = accent; ctx.fillRect(sx - 3, sy - 3, 6, 6); }
      const last = this.poly[this.poly.length - 1];
      this.label(`${Math.hypot(this.mouse[0] - last[0], this.mouse[1] - last[1]).toFixed(1)} cm`, mx + 10, my + 14);
    }
    ctx.setLineDash([]);

    if (!pr.pieces.length && !this.poly.length && !this.rectStart) {
      ctx.fillStyle = col('--muted');
      ctx.font = '13px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Draw a piece with Rectangle (R) or Polygon (P)', W / 2, H / 2);
    }
  }

  private edgeScreen(r: EdgeRef): [Vec2, Vec2] | null {
    const p = this.store.piece(r.piece);
    if (!p || r.edge >= p.points.length) return null;
    return [this.toScreen(...this.wp(p, r.edge)), this.toScreen(...this.wp(p, (r.edge + 1) % p.points.length))];
  }

  private drawEdge(r: EdgeRef, color: string, width: number, dash: number[] = []) {
    const e = this.edgeScreen(r);
    if (!e) return;
    const ctx = this.ctx;
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(...e[0]); ctx.lineTo(...e[1]); ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawSeamEdge(r: EdgeRef, color: string, reverse: boolean, selected: boolean, num: number) {
    const e = this.edgeScreen(r);
    if (!e) return;
    const ctx = this.ctx;
    this.drawEdge(r, color, selected ? 5 : 3);
    let [a, b] = e;
    if (reverse) [a, b] = [b, a];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const s = selected ? 9 : 7;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(mx + Math.cos(ang) * s, my + Math.sin(ang) * s);
    ctx.lineTo(mx + Math.cos(ang + 2.5) * s, my + Math.sin(ang + 2.5) * s);
    ctx.lineTo(mx + Math.cos(ang - 2.5) * s, my + Math.sin(ang - 2.5) * s);
    ctx.closePath();
    ctx.fill();
    // number on the outside of the edge
    const nx = -Math.sin(ang) * 12, ny = Math.cos(ang) * 12;
    ctx.font = '700 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), mx + (reverse ? -nx : nx), my + (reverse ? -ny : ny));
  }

  private label(text: string, x: number, y: number) {
    const ctx = this.ctx;
    ctx.font = '11px Inter, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(15,15,18,0.88)';
    ctx.fillRect(x, y - 9, w, 18);
    ctx.fillStyle = '#f2f2f2';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 5, y);
  }
}
