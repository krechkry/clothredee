import './style.css';
import { Store } from './store';
import type { ChangeKind } from './store';
import { PatternEditor } from './pattern2d';
import type { Tool } from './pattern2d';
import { SEAM_COLORS } from './pattern2d';
import { View3D } from './view3d';
import { buildCloth } from './cloth/build';
import type { ClothData } from './cloth/build';
import { ClothSim } from './cloth/solver';
import { buildColliders } from './colliders';
import type { Collider } from './colliders';
import { FABRICS, TEMPLATES, uid } from './model';
import type { Piece, Placement, Ring } from './model';
import { deletePiece, duplicatePiece } from './ops';
import { exportGLB, exportOBJ, openProjectFile, saveProject } from './io';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DEG = 180 / Math.PI;

class App {
  store = new Store();
  editor: PatternEditor;
  view: View3D;
  data!: ClothData;
  sim!: ClothSim;
  colliders: Collider[] = [];
  running = false;
  private geoDirty = false;
  private sceneDirty = false;
  private lastStats = 0;
  private frames = 0;
  private fps = 0;
  private toastTimer = 0;

  constructor() {
    this.editor = new PatternEditor($('view2d'), this.store);
    this.view = new View3D($('view3d'), this.store);
    this.editor.onToolChange = t => this.syncTools(t);
    this.editor.onStatus = s => { $('hint').textContent = s; };
    this.editor.setTool('select');

    this.rebuildScene();
    this.rebuildCloth();
    this.view.frameAll();

    this.store.on(k => this.onChange(k));
    this.bindHeader();
    this.bindKeys();
    this.bindGizmo();
    this.renderPanel();
    this.syncHeader();
    requestAnimationFrame(t => this.loop(t));
  }

  // ---------- state changes ----------
  private onChange(kind: ChangeKind) {
    if (kind === 'geometry' || kind === 'all') this.geoDirty = true;
    if (kind === 'scene' || kind === 'all') this.sceneDirty = true;
    if (kind === 'fabric') this.sim.setFabric(this.store.project.fabric);
    if (kind === 'meta') { this.view.setCloth(this.data); this.view.updateCloth(this.sim.x); }
    if (kind === 'select' || kind === 'scene') { this.view.highlight(); this.updateGizmo(); }
    if (kind === 'scene' && this.store.sel.ring) this.sceneDirty = true;
    if (kind === 'select') this.view.rebuildScene();
    // Avoid rebuilding the panel while someone is typing or dragging a slider in it
    const active = document.activeElement;
    const editingPanel = active && $('panel').contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT');
    if (!editingPanel || kind === 'select' || kind === 'all') this.renderPanel();
    if (kind === 'all') { this.syncHeader(); requestAnimationFrame(() => this.view.frameAll()); }
  }

  rebuildCloth() {
    const p = this.store.project;
    this.data = buildCloth(p);
    this.sim = new ClothSim(this.data, this.colliders, p.fabric, p.particleDistance);
    this.view.setCloth(this.data);
    this.updateGizmo();
  }

  rebuildScene() {
    const p = this.store.project;
    this.colliders = buildColliders(p.scene === 'avatar' ? p.avatar : null, p.rings);
    if (this.sim) this.sim.colliders = this.colliders;
    this.view.rebuildScene();
  }

  setRunning(on: boolean) {
    this.running = on && this.data.n > 0;
    const b = $('btn-sim');
    b.textContent = this.running ? 'Pause' : 'Simulate';
    b.classList.toggle('running', this.running);
    this.updateGizmo();
  }

  reset() {
    this.rebuildCloth();
    this.setRunning(false);
  }

  private loop(t: number) {
    if (this.sceneDirty) { this.sceneDirty = false; this.rebuildScene(); }
    if (this.geoDirty) { this.geoDirty = false; this.rebuildCloth(); }
    if (this.running) {
      // Fixed step: the same drape on every machine (slow devices just play it in slow motion)
      this.sim.step(1 / 60);
      this.view.updateCloth(this.sim.x);
    }
    this.view.render();
    this.frames++;
    if (t - this.lastStats > 500) {
      this.fps = (this.frames * 1000) / (t - this.lastStats);
      this.frames = 0;
      this.lastStats = t;
      const gap = this.sim.seamGap();
      $('stats').textContent = `${this.data.n} particles · seam gap ${gap.toFixed(1)} cm · ${this.fps.toFixed(0)} fps`;
    }
    requestAnimationFrame(n => this.loop(n));
  }

  toast(msg: string) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { el.hidden = true; }, 2600);
  }

  // ---------- gizmo (move selected piece or ring in 3D) ----------
  private updateGizmo() {
    const st = this.store;
    if (this.running) { this.view.setGizmo(null); return; }
    const p = st.piece(st.sel.piece);
    if (p) { this.view.setGizmo([p.placement.x, p.placement.y, p.placement.z]); return; }
    const r = st.project.rings.find(x => x.id === st.sel.ring);
    if (r) { this.view.setGizmo([r.x, r.y, r.z]); return; }
    this.view.setGizmo(null);
  }

  private bindGizmo() {
    this.view.onGizmoStart = () => this.store.snapshot();
    this.view.onGizmoMove = (pos, dragging) => {
      const st = this.store;
      const round = (v: number) => Math.round(v * 10) / 10;
      const p = st.piece(st.sel.piece);
      if (p) {
        p.placement.x = round(pos.x); p.placement.y = round(pos.y); p.placement.z = round(pos.z);
        st.emit('geometry');
      } else {
        const r = st.project.rings.find(x => x.id === st.sel.ring);
        if (!r) return;
        r.x = round(pos.x); r.y = round(pos.y); r.z = round(pos.z);
        st.emit('scene');
      }
      if (!dragging) this.renderPanel();
    };
  }

  // ---------- header ----------
  private bindHeader() {
    const st = this.store;
    const nameInput = $<HTMLInputElement>('project-name');
    nameInput.addEventListener('input', () => st.commit('meta', p => { p.name = nameInput.value; }, 'name'));

    const sel = $<HTMLSelectElement>('template-select');
    sel.innerHTML = `<option value="">New…</option>` + Object.keys(TEMPLATES).map(k => `<option value="${k}">${k}</option>`).join('');
    sel.addEventListener('change', () => {
      const k = sel.value;
      sel.value = '';
      if (!k) return;
      this.setRunning(false);
      st.replace(TEMPLATES[k]());
      this.toast(`Started "${k}". Press Simulate to sew and drape.`);
    });

    $('btn-open').onclick = async () => {
      try {
        const p = await openProjectFile();
        this.setRunning(false);
        st.replace(p);
        this.toast(`Opened ${p.name}`);
      } catch (e) { if ((e as Error).message !== 'No file') this.toast(`Could not open: ${(e as Error).message}`); }
    };
    $('btn-save').onclick = async () => this.toast(await saveProject(st.project));
    $('btn-obj').onclick = async () => this.toast(await exportOBJ(this.view.clothGroup, st.project.name));
    $('btn-glb').onclick = async () => this.toast(await exportGLB(this.view.clothGroup, st.project.name));
    $('btn-undo').onclick = () => st.undo();
    $('btn-redo').onclick = () => st.redo();
    $('btn-sim').onclick = () => this.setRunning(!this.running);
    $('btn-reset').onclick = () => this.reset();
    $('btn-fit2d').onclick = () => this.editor.fit();
    $('btn-frame3d').onclick = () => this.view.frameAll();
    $<HTMLInputElement>('show-seams').onchange = e => { this.view.showSeams = (e.target as HTMLInputElement).checked; this.view.updateCloth(this.running ? this.sim.x : this.data.pos); };
    for (const b of document.querySelectorAll<HTMLButtonElement>('#tools button')) b.onclick = () => this.editor.setTool(b.dataset.tool as Tool);
  }

  private syncHeader() { $<HTMLInputElement>('project-name').value = this.store.project.name; }

  private syncTools(t: Tool) {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#tools button')) b.classList.toggle('active', b.dataset.tool === t);
  }

  private bindKeys() {
    window.addEventListener('keydown', e => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.store.redo() : this.store.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); this.store.redo(); return; }
      if (mod && k === 's') { e.preventDefault(); void saveProject(this.store.project).then(m => this.toast(m)); return; }
      if (mod) return;
      if (k === ' ') { e.preventDefault(); this.setRunning(!this.running); return; }
      if (k === 'escape') { if (!this.editor.cancel()) this.store.select({}); return; }
      if (k === 'enter') { this.editor.closePoly(); return; }
      if (k === 'delete' || k === 'backspace') { e.preventDefault(); this.editor.deleteSelection(); return; }
      const tools: Record<string, Tool> = { v: 'select', r: 'rect', p: 'poly', a: 'point', s: 'sew' };
      if (tools[k]) { this.editor.setTool(tools[k]); return; }
      if (k === 'f') { this.editor.fit(); this.view.frameAll(); return; }
      if (k === 'w') { this.view.gizmo.setMode('translate'); return; }
    });
  }

  // ---------- properties panel ----------
  renderPanel() {
    const panel = $('panel');
    const scroll = panel.scrollTop;
    panel.innerHTML = '';
    const st = this.store, p = st.project;

    // Selection first, it's what you're working on
    const piece = st.piece(st.sel.piece);
    const seam = p.seams.find(s => s.id === st.sel.seam);
    const ring = p.rings.find(r => r.id === st.sel.ring);
    if (seam) panel.append(this.seamSection(seam.id));
    if (piece) panel.append(this.pieceSection(piece));
    if (ring) panel.append(this.ringSection(ring));

    panel.append(this.fabricSection(), this.sceneSection(), this.piecesSection(), this.seamsSection(), this.helpSection());
    panel.scrollTop = scroll;
  }

  private sec(title: string, extra?: HTMLElement) {
    const s = document.createElement('section');
    s.className = 'sec';
    const h = document.createElement('h3');
    h.textContent = title;
    if (extra) h.append(extra);
    s.append(h);
    return s;
  }

  private row(label: string, ...els: HTMLElement[]) {
    const r = document.createElement('div');
    r.className = 'row';
    const l = document.createElement('label');
    l.textContent = label;
    if (els[0]?.id) l.htmlFor = els[0].id;
    r.append(l, ...els);
    return r;
  }

  private input(id: string, type: string, value: string | number, onInput: (v: string) => void, attrs: Record<string, string> = {}) {
    const i = document.createElement('input');
    i.id = id; i.type = type; i.value = String(value);
    for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }

  private slider(id: string, label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, onInput: (v: number) => void) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const l = document.createElement('label');
    l.textContent = label; l.htmlFor = id;
    const i = document.createElement('input');
    i.type = 'range'; i.id = id; i.min = String(min); i.max = String(max); i.step = String(step); i.value = String(value);
    const o = document.createElement('output');
    o.textContent = fmt(value);
    i.addEventListener('input', () => { const v = parseFloat(i.value); o.textContent = fmt(v); onInput(v); });
    wrap.append(l, i, o);
    return wrap;
  }

  private button(label: string, onClick: () => void, cls = '') {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; if (cls) b.className = cls;
    b.onclick = onClick;
    return b;
  }

  private btns(...b: HTMLElement[]) { const d = document.createElement('div'); d.className = 'btns'; d.append(...b); return d; }

  private pieceSection(piece: Piece) {
    const st = this.store;
    const s = this.sec('Piece');
    const id = piece.id;
    const edit = (kind: ChangeKind, f: (pc: Piece) => void, key: string) => st.commit(kind, p => { const pc = p.pieces.find(x => x.id === id); if (pc) f(pc); }, key + id);
    s.append(this.row('Name', this.input('pc-name', 'text', piece.name, v => edit('meta', pc => { pc.name = v; }, 'name'))));
    s.append(this.row('Color', this.input('pc-color', 'color', piece.color, v => edit('meta', pc => { pc.color = v; }, 'color'))));

    const pl = piece.placement;
    const num = (key: keyof Placement, v: number, step = 1) => {
      const i = this.input(`pl-${key}`, 'number', Math.round(v * 10) / 10, val => {
        const n = parseFloat(val);
        if (Number.isFinite(n)) edit('geometry', pc => { (pc.placement[key] as number) = key === 'yaw' || key === 'pitch' ? n / DEG : n; }, 'pl' + key);
      }, { step: String(step) });
      i.setAttribute('aria-label', key);
      return i;
    };
    const trio = document.createElement('div');
    trio.className = 'trio';
    trio.append(num('x', pl.x), num('y', pl.y), num('z', pl.z));
    s.append(this.row('Position', trio));
    const rot = document.createElement('div');
    rot.className = 'trio';
    rot.append(num('yaw', pl.yaw * DEG, 15), num('pitch', pl.pitch * DEG, 15));
    s.append(this.row('Yaw / pitch', rot));

    const seg = document.createElement('div');
    seg.className = 'seg';
    for (const [m, label] of [['flat', 'Flat'], ['vertical', 'Wrap ↔'], ['horizontal', 'Wrap ↕']] as const) {
      const b = this.button(label, () => edit('geometry', pc => { pc.placement.wrap = m; }, 'wrap'));
      if (pl.wrap === m) b.classList.add('on');
      seg.append(b);
    }
    s.append(this.row('Shape', seg));
    if (pl.wrap !== 'flat') s.append(this.slider('pl-radius', 'Wrap radius', pl.radius, 3, 80, 0.5, v => `${v.toFixed(1)}`, v => edit('geometry', pc => { pc.placement.radius = v; }, 'radius')));

    if (st.project.scene === 'avatar') {
      const arrange = (yaw: number) => () => edit('geometry', pc => {
        pc.placement = { ...pc.placement, x: 0, z: 0, yaw, pitch: 0, wrap: 'vertical', radius: Math.max(pc.placement.radius, 22) };
      }, 'arr');
      s.append(this.row('Arrange', this.btns(
        this.button('Front', arrange(0)), this.button('Back', arrange(Math.PI)),
        this.button('Left', arrange(Math.PI / 2)), this.button('Right', arrange(-Math.PI / 2)),
      )));
    }
    s.append(this.btns(
      this.button('Duplicate', () => { let nid = ''; st.commit('geometry', p => { nid = duplicatePiece(p, p.pieces.find(x => x.id === id)!, false).id; }); st.select({ piece: nid }); }),
      this.button('Mirror copy', () => { let nid = ''; st.commit('geometry', p => { nid = duplicatePiece(p, p.pieces.find(x => x.id === id)!, true).id; }); st.select({ piece: nid }); }),
      this.button('Delete', () => { st.commit('geometry', p => deletePiece(p, id)); st.select({}); }, 'danger'),
    ));
    const pts = piece.points;
    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
    const info = document.createElement('div');
    info.className = 'muted';
    info.textContent = `${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} × ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)} cm · ${pts.length} points`;
    s.append(info);
    return s;
  }

  private seamSection(seamId: string) {
    const st = this.store;
    const s = this.sec('Seam');
    const seam = st.project.seams.find(x => x.id === seamId)!;
    const name = (r: { piece: string; edge: number }) => `${st.piece(r.piece)?.name ?? '?'} edge ${r.edge + 1}`;
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = `${name(seam.a)} ↔ ${name(seam.b)}`;
    s.append(d);
    s.append(this.btns(
      this.button('Flip direction', () => st.commit('geometry', p => { const x = p.seams.find(q => q.id === seamId); if (x) x.reversed = !x.reversed; })),
      this.button('Delete', () => { st.commit('geometry', p => { p.seams = p.seams.filter(q => q.id !== seamId); }); st.select({}); }, 'danger'),
    ));
    const tip = document.createElement('div');
    tip.className = 'muted';
    tip.textContent = 'If the colored lines in 3D cross each other like an X, flip it.';
    s.append(tip);
    return s;
  }

  private ringSection(ring: Ring) {
    const st = this.store;
    const s = this.sec('Ring');
    const id = ring.id;
    const edit = (f: (r: Ring) => void, key: string) => st.commit('scene', p => { const r = p.rings.find(x => x.id === id); if (r) f(r); }, key + id);
    const num = (key: 'x' | 'y' | 'z', v: number) => {
      const i = this.input(`rg-${key}`, 'number', v, val => { const n = parseFloat(val); if (Number.isFinite(n)) edit(r => { r[key] = n; }, key); });
      i.setAttribute('aria-label', key);
      return i;
    };
    const trio = document.createElement('div');
    trio.className = 'trio';
    trio.append(num('x', ring.x), num('y', ring.y), num('z', ring.z));
    s.append(this.row('Position', trio));
    s.append(this.slider('rg-yaw', 'Turn', ring.yaw * DEG, -180, 180, 5, v => `${v.toFixed(0)}°`, v => edit(r => { r.yaw = v / DEG; }, 'yaw')));
    s.append(this.slider('rg-tilt', 'Tilt', ring.tilt * DEG, -90, 90, 5, v => `${v.toFixed(0)}°`, v => edit(r => { r.tilt = v / DEG; }, 'tilt')));
    s.append(this.slider('rg-rad', 'Radius', ring.radius, 2, 30, 0.5, v => `${v.toFixed(1)}`, v => edit(r => { r.radius = v; }, 'rad')));
    s.append(this.slider('rg-tube', 'Thickness', ring.tube, 0.3, 4, 0.1, v => `${v.toFixed(1)}`, v => edit(r => { r.tube = v; }, 'tube')));
    s.append(this.btns(this.button('Delete ring', () => { st.commit('scene', p => { p.rings = p.rings.filter(r => r.id !== id); }); st.select({}); }, 'danger')));
    return s;
  }

  private fabricSection() {
    const st = this.store, f = st.project.fabric;
    const s = this.sec('Fabric');
    const sel = document.createElement('select');
    sel.id = 'fab-preset';
    sel.innerHTML = Object.keys(FABRICS).map(k => `<option${k === f.preset ? ' selected' : ''}>${k}</option>`).join('') + (FABRICS[f.preset] ? '' : `<option selected>Custom</option>`);
    sel.onchange = () => { st.commit('fabric', p => { p.fabric = { preset: sel.value, ...FABRICS[sel.value] }; }); this.renderPanel(); };
    s.append(this.row('Preset', sel));
    const pct = (v: number) => `${Math.round(v * 100)}`;
    const set = (k: 'stretch' | 'bend' | 'weight' | 'friction') => (v: number) => st.commit('fabric', p => { p.fabric[k] = v; p.fabric.preset = 'Custom'; }, 'fab' + k);
    s.append(this.slider('fab-stretch', 'Stiffness', f.stretch, 0, 1, 0.01, pct, set('stretch')));
    s.append(this.slider('fab-bend', 'Bending', f.bend, 0, 1, 0.01, pct, set('bend')));
    s.append(this.slider('fab-weight', 'Weight', f.weight, 0.2, 3, 0.05, v => v.toFixed(2), set('weight')));
    s.append(this.slider('fab-friction', 'Friction', f.friction, 0, 1, 0.01, pct, set('friction')));
    s.append(this.slider('particle-dist', 'Particle dist.', st.project.particleDistance, 1, 5, 0.25, v => v.toFixed(2),
      v => st.commit('geometry', p => { p.particleDistance = v; }, 'pd')));
    return s;
  }

  private sceneSection() {
    const st = this.store, p = st.project;
    const s = this.sec('Scene');
    const seg = document.createElement('div');
    seg.className = 'seg';
    for (const [m, label] of [['avatar', 'Mannequin'], ['empty', 'Empty (bags)']] as const) {
      const b = this.button(label, () => st.commit('scene', pr => { pr.scene = m; }));
      if (p.scene === m) b.classList.add('on');
      seg.append(b);
    }
    s.append(seg);
    if (p.scene === 'avatar') {
      const set = (k: 'height' | 'chest' | 'waist' | 'hips') => (v: number) => st.commit('scene', pr => { pr.avatar[k] = v; }, 'av' + k);
      s.append(this.slider('av-height', 'Height', p.avatar.height, 0.8, 1.15, 0.01, v => `${Math.round(175 * v)}`, set('height')));
      s.append(this.slider('av-chest', 'Chest', p.avatar.chest, 0.8, 1.3, 0.01, v => `${Math.round(v * 100)}%`, set('chest')));
      s.append(this.slider('av-waist', 'Waist', p.avatar.waist, 0.8, 1.4, 0.01, v => `${Math.round(v * 100)}%`, set('waist')));
      s.append(this.slider('av-hips', 'Hips', p.avatar.hips, 0.8, 1.3, 0.01, v => `${Math.round(v * 100)}%`, set('hips')));
    }
    const list = document.createElement('div');
    list.className = 'list';
    p.rings.forEach((r, i) => {
      const it = document.createElement('div');
      it.className = 'item' + (st.sel.ring === r.id ? ' sel' : '');
      it.innerHTML = `<span class="dot" style="background:#c9ccd4"></span><span class="grow">Ring ${i + 1}</span><span class="num">⌀${(r.radius * 2).toFixed(0)} cm</span>`;
      it.onclick = () => st.select({ ring: r.id });
      list.append(it);
    });
    s.append(list);
    s.append(this.btns(this.button('Add ring', () => {
      const id = uid('r');
      st.commit('scene', pr => { pr.rings.push({ id, x: 0, y: pr.scene === 'avatar' ? 150 : 110, z: pr.scene === 'avatar' ? 30 : 0, yaw: 0, tilt: 0, radius: 6, tube: 0.8 }); });
      st.select({ ring: id });
    })));
    return s;
  }

  private piecesSection() {
    const st = this.store;
    const s = this.sec('Pieces');
    const list = document.createElement('div');
    list.className = 'list';
    for (const pc of st.project.pieces) {
      const it = document.createElement('div');
      it.className = 'item' + (st.sel.piece === pc.id ? ' sel' : '');
      it.innerHTML = `<span class="dot"></span><span class="grow"></span><span class="num">${pc.points.length} pts</span>`;
      (it.querySelector('.dot') as HTMLElement).style.background = pc.color;
      (it.querySelector('.grow') as HTMLElement).textContent = pc.name;
      it.onclick = () => st.select({ piece: pc.id });
      list.append(it);
    }
    if (!st.project.pieces.length) list.innerHTML = `<div class="muted">No pieces yet. Draw one in the 2D window.</div>`;
    s.append(list);
    return s;
  }

  private seamsSection() {
    const st = this.store;
    const s = this.sec('Seams');
    const list = document.createElement('div');
    list.className = 'list';
    st.project.seams.forEach((sm, i) => {
      const it = document.createElement('div');
      it.className = 'item' + (st.sel.seam === sm.id ? ' sel' : '');
      const a = st.piece(sm.a.piece)?.name ?? '?', b = st.piece(sm.b.piece)?.name ?? '?';
      it.innerHTML = `<span class="dot"></span><span class="grow"></span><span class="num">${sm.reversed ? '⇄' : '⇉'}</span>`;
      (it.querySelector('.dot') as HTMLElement).style.background = SEAM_COLORS[i % SEAM_COLORS.length];
      (it.querySelector('.grow') as HTMLElement).textContent = `${i + 1}. ${a} ↔ ${b}`;
      it.onclick = () => st.select({ seam: sm.id });
      list.append(it);
    });
    if (!st.project.seams.length) list.innerHTML = `<div class="muted">No seams. Use Sew (S) and click two edges.</div>`;
    s.append(list);
    return s;
  }

  private helpSection() {
    const s = this.sec('Keys');
    const d = document.createElement('div');
    d.className = 'kbd';
    d.innerHTML = 'V select · R rect · P polygon · A add point · S sew<br>Space simulate · Del delete · F fit · Ctrl+Z undo<br>Shift while dragging a point snaps to 1 cm';
    s.append(d);
    return s;
  }
}

new App();
