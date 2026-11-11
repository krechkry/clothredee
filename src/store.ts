// App state: the project, selection, undo/redo and autosave.

import type { EdgeRef, Project } from './model';
import { tankTopTemplate } from './model';

export interface Selection {
  piece: string | null;
  vertex: number | null;   // vertex index within selected piece
  seam: string | null;
  ring: string | null;
}

type Listener = (kind: ChangeKind) => void;
/** geometry: pieces/seams/placement/particle distance changed -> cloth must be rebuilt
 *  scene: avatar/rings changed -> colliders rebuilt
 *  fabric: material params only
 *  meta: names/colors/layout/selection, no sim impact */
export type ChangeKind = 'geometry' | 'scene' | 'fabric' | 'meta' | 'select' | 'all';

const STORAGE_KEY = 'clothredee-project-v1';

export class Store {
  project: Project;
  sel: Selection = { piece: null, vertex: null, seam: null, ring: null };
  sewFirst: EdgeRef | null = null;
  private listeners: Listener[] = [];
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastKey = '';
  private lastTime = 0;
  private saveTimer = 0;

  constructor() {
    this.project = this.loadAutosave() ?? tankTopTemplate();
  }

  on(fn: Listener) { this.listeners.push(fn); }

  emit(kind: ChangeKind) {
    for (const l of this.listeners) l(kind);
    if (kind !== 'select') this.scheduleSave();
  }

  /** Snapshot for undo, then mutate. Consecutive edits with the same key within 1s merge into one undo step. */
  commit(kind: ChangeKind, mutate: (p: Project) => void, key = '') {
    const now = performance.now();
    if (!(key && key === this.lastKey && now - this.lastTime < 1000)) {
      this.undoStack.push(JSON.stringify(this.project));
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this.lastKey = key;
    this.lastTime = now;
    mutate(this.project);
    this.emit(kind);
  }

  /** Take an undo snapshot without changing anything (start of a drag). */
  snapshot() {
    this.undoStack.push(JSON.stringify(this.project));
    this.redoStack = [];
    this.lastKey = '';
  }

  replace(p: Project, clearHistory = false) {
    if (clearHistory) { this.undoStack = []; this.redoStack = []; }
    else this.undoStack.push(JSON.stringify(this.project));
    this.project = p;
    this.sel = { piece: null, vertex: null, seam: null, ring: null };
    this.sewFirst = null;
    this.emit('all');
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(s);
    this.fixSelection();
    this.lastKey = '';
    this.emit('all');
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(s);
    this.fixSelection();
    this.lastKey = '';
    this.emit('all');
  }

  select(s: Partial<Selection>) {
    this.sel = { piece: null, vertex: null, seam: null, ring: null, ...s };
    this.emit('select');
  }

  private fixSelection() {
    const p = this.project;
    if (this.sel.piece && !p.pieces.some(x => x.id === this.sel.piece)) this.sel.piece = null;
    if (this.sel.seam && !p.seams.some(x => x.id === this.sel.seam)) this.sel.seam = null;
    if (this.sel.ring && !p.rings.some(x => x.id === this.sel.ring)) this.sel.ring = null;
    this.sel.vertex = null;
  }

  piece(id: string | null) { return id ? this.project.pieces.find(p => p.id === id) ?? null : null; }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.project)); } catch { /* storage unavailable */ }
    }, 400);
  }

  private loadAutosave(): Project | null {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (!s) return null;
      const p = JSON.parse(s) as Project;
      return p && p.version === 1 && Array.isArray(p.pieces) ? p : null;
    } catch { return null; }
  }
}
