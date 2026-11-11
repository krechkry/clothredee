// Save / load project files and export the draped garment.
// Works as a normal web page, and inside a claude.ai artifact (where files go through the
// viewer's "downloads" capability and only some extensions are allowed, so 3D files are zipped).

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import type { Project } from './model';

interface DownloadsApi { save(r: { filename: string; data: string | Blob | ArrayBuffer | ArrayBufferView }): Promise<unknown> }
type ClaudeWindow = Window & { claude?: { use(name: string): Promise<unknown> } };

let downloadsPromise: Promise<DownloadsApi | null> | null = null;
function getDownloads(): Promise<DownloadsApi | null> {
  if (!downloadsPromise) {
    const c = (window as ClaudeWindow).claude;
    downloadsPromise = c?.use
      ? Promise.race([c.use('downloads') as Promise<DownloadsApi | null>, new Promise<null>(r => setTimeout(() => r(null), 4000))]).catch(() => null)
      : Promise.resolve(null);
  }
  return downloadsPromise;
}
// Ask early so the first click isn't slowed down
setTimeout(() => { void getDownloads(); }, 0);

const SANDBOX_OK = ['json', 'zip', 'txt', 'png'];

/** Returns a short status for a toast. */
export async function download(name: string, data: Uint8Array | string): Promise<string> {
  const dl = await getDownloads();
  if (dl) {
    let filename = name, payload: Uint8Array | string = data;
    const ext = name.split('.').pop()!.toLowerCase();
    if (!SANDBOX_OK.includes(ext)) {
      payload = zipStore(name, typeof data === 'string' ? new TextEncoder().encode(data) : data);
      filename = name + '.zip';
    }
    try {
      await dl.save({ filename, data: payload });
      return `Saved ${filename}`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'declined') return 'Save cancelled';
      if (code === 'rate_limited') return 'A save is already waiting for you to confirm';
      return 'Saving is not available here';
    }
  }
  const blob = new Blob([data as BlobPart]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return `Downloaded ${name}`;
}

const safe = (s: string) => (s || 'garment').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'garment';

export function saveProject(p: Project) {
  return download(`${safe(p.name)}.clothredee.json`, JSON.stringify(p, null, 1));
}

export function openProjectFile(): Promise<Project> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return reject(new Error('No file'));
      try {
        const p = JSON.parse(await f.text()) as Project;
        if (p.version !== 1 || !Array.isArray(p.pieces) || !Array.isArray(p.seams)) throw new Error('not a Clothredee project file');
        p.rings ??= [];
        resolve(p);
      } catch (e) { reject(e); }
    };
    input.click();
  });
}

/** Clone the cloth meshes into a meter-scaled group for export. */
function exportGroup(cloth: THREE.Group): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Garment';
  for (const c of cloth.children) {
    const m = c as THREE.Mesh;
    const geo = m.geometry.clone();
    geo.scale(0.01, 0.01, 0.01);
    geo.computeVertexNormals();
    const src = m.material as THREE.MeshStandardMaterial;
    const mat = new THREE.MeshStandardMaterial({ color: src.color.clone(), roughness: 0.9, side: THREE.DoubleSide, name: m.name });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = m.name;
    g.add(mesh);
  }
  return g;
}

export function exportOBJ(cloth: THREE.Group, name: string) {
  return download(`${safe(name)}.obj`, new OBJExporter().parse(exportGroup(cloth)));
}

export async function exportGLB(cloth: THREE.Group, name: string) {
  const result = await new GLTFExporter().parseAsync(exportGroup(cloth), { binary: true });
  return download(`${safe(name)}.glb`, new Uint8Array(result as ArrayBuffer));
}

// ---------- minimal zip (store, no compression) ----------
let crcTable: Uint32Array | null = null;
function crc32(d: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = crcTable[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(filename: string, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(filename);
  const crc = crc32(data);
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
  lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
  lv.setUint16(26, name.length, true); local.set(name, 30);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
  cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
  cv.setUint16(28, name.length, true); central.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true); ev.setUint32(16, local.length + data.length, true);
  const out = new Uint8Array(local.length + data.length + central.length + end.length);
  out.set(local, 0); out.set(data, local.length); out.set(central, local.length + data.length); out.set(end, local.length + data.length + central.length);
  return out;
}
