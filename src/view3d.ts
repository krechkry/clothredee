// 3D viewport: mannequin, rings, cloth meshes, seam preview, transform gizmo.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Store } from './store';
import type { ClothData } from './cloth/build';
import { mannequinParts } from './colliders';
import type { V3 } from './colliders';
import { SEAM_COLORS } from './pattern2d';

export class View3D {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  gizmo: TransformControls;
  private gizmoTarget = new THREE.Object3D();
  private avatarGroup = new THREE.Group();
  private ringGroup = new THREE.Group();
  clothGroup = new THREE.Group();
  private seamLines: THREE.LineSegments | null = null;
  private clothMeshes: THREE.Mesh[] = [];
  private data: ClothData | null = null;
  private raycaster = new THREE.Raycaster();
  showSeams = true;
  onGizmoMove: (pos: THREE.Vector3, dragging: boolean) => void = () => {};
  onGizmoStart: () => void = () => {};

  constructor(private host: HTMLElement, private store: Store) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.camera.position.set(140, 150, 320);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 105, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.update();

    this.scene.background = new THREE.Color(0x26272b);
    this.scene.fog = new THREE.Fog(0x26272b, 600, 1400);
    const hemi = new THREE.HemisphereLight(0xf4f1ea, 0x3a3a40, 1.4);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(120, 260, 180);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -120; sc.right = 120; sc.top = 220; sc.bottom = -40; sc.near = 50; sc.far = 600;
    key.shadow.bias = -0.002;
    key.shadow.normalBias = 1.2;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb7ff, 0.8);
    rim.position.set(-200, 120, -200);
    this.scene.add(rim);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(400, 64), new THREE.MeshStandardMaterial({ color: 0x2f3035, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(400, 40, 0x46474e, 0x38393f);
    grid.position.y = 0.05;
    this.scene.add(grid);

    this.scene.add(this.avatarGroup, this.ringGroup, this.clothGroup);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.scene.add(this.gizmoTarget);
    this.gizmo.attach(this.gizmoTarget);
    this.gizmo.enabled = false;
    const helper = this.gizmo.getHelper();
    helper.visible = false;
    this.scene.add(helper);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const d = (e as unknown as { value: boolean }).value;
      this.controls.enabled = !d;
      if (d) this.onGizmoStart();
      else this.onGizmoMove(this.gizmoTarget.position, false);
    });
    this.gizmo.addEventListener('objectChange', () => this.onGizmoMove(this.gizmoTarget.position, true));

    this.bindPicking();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.renderer.setSize(r.width, r.height);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  /** Position the move gizmo, or hide it. */
  setGizmo(pos: V3 | null) {
    const helper = this.gizmo.getHelper();
    if (!pos) { this.gizmo.enabled = false; helper.visible = false; return; }
    if (this.gizmo.dragging) return;
    this.gizmoTarget.position.set(pos[0], pos[1], pos[2]);
    this.gizmo.enabled = true;
    helper.visible = true;
  }

  // ---------- avatar & rings ----------
  rebuildScene() {
    const p = this.store.project;
    this.disposeGroup(this.avatarGroup);
    if (p.scene === 'avatar') this.buildMannequin();
    this.disposeGroup(this.ringGroup);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd4, metalness: 0.9, roughness: 0.28 });
    for (const r of p.rings) {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r.radius, r.tube, 20, 72), ringMat);
      m.position.set(r.x, r.y, r.z);
      m.rotation.order = 'YXZ';
      m.rotation.set(r.tilt, r.yaw, 0);
      m.castShadow = true;
      m.userData.ringId = r.id;
      if (this.store.sel.ring === r.id) {
        (m.material as THREE.MeshStandardMaterial) = ringMat.clone();
        (m.material as THREE.MeshStandardMaterial).emissive.set(0x6a4a10);
      }
      this.ringGroup.add(m);
    }
  }

  private buildMannequin() {
    const av = this.store.project.avatar;
    const parts = mannequinParts(av);
    const mat = new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.75, metalness: 0 });
    // Torso: loft ellipses from the same table the collider uses
    const t = parts.torso;
    const seg = 40;
    const rows: number[] = [];
    for (let i = 0; i < t.n; i += 2) rows.push(i);
    if (rows[rows.length - 1] !== t.n - 1) rows.push(t.n - 1);
    const pos: number[] = [], idx: number[] = [];
    rows.forEach((i) => {
      const y = t.y0 + i * t.step;
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        pos.push(Math.sin(a) * t.rx[i], y, Math.cos(a) * t.rz[i]);
      }
    });
    for (let r = 0; r < rows.length - 1; r++) for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s, b = a + seg + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.addPart(new THREE.Mesh(g, mat));
    // bottom cap
    const capBottom = new THREE.Mesh(new THREE.CircleGeometry(1, seg), mat);
    capBottom.scale.set(t.rx[0], t.rz[0], 1);
    capBottom.rotation.x = Math.PI / 2;
    capBottom.position.y = t.y0;
    this.addPart(capBottom);

    for (const c of parts.capsules) {
      const a = new THREE.Vector3(...c.a), b = new THREE.Vector3(...c.b);
      const len = a.distanceTo(b);
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(c.r, len, 8, 24), mat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      this.addPart(m);
    }
    for (const s of parts.spheres) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(s.r, 32, 24), mat);
      m.position.set(...s.c);
      m.scale.set(s.sx ?? 1, s.sy ?? 1, s.sz ?? 1);
      this.addPart(m);
    }
  }

  private addPart(m: THREE.Mesh) {
    m.castShadow = true;
    m.receiveShadow = true;
    this.avatarGroup.add(m);
  }

  private disposeGroup(g: THREE.Group) {
    for (const c of [...g.children]) {
      g.remove(c);
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
    }
  }

  // ---------- cloth ----------
  setCloth(data: ClothData) {
    this.data = data;
    this.disposeGroup(this.clothGroup);
    this.clothMeshes = [];
    const p = this.store.project;
    data.pieces.forEach((pm, i) => {
      const piece = p.pieces[i];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pm.count * 3), 3));
      const uv = new Float32Array(pm.uv.length);
      for (let k = 0; k < uv.length; k++) uv[k] = pm.uv[k] / 100; // 1 UV unit = 1 m of fabric
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      const local = new Uint32Array(pm.tris.length);
      for (let k = 0; k < local.length; k++) local[k] = pm.tris[k] - pm.start;
      g.setIndex(new THREE.BufferAttribute(local, 1));
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(piece.color), roughness: 0.9, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = piece.name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.pieceId = piece.id;
      this.clothMeshes.push(mesh);
      this.clothGroup.add(mesh);
    });
    // Seam preview lines
    if (this.seamLines) { this.scene.remove(this.seamLines); this.seamLines.geometry.dispose(); }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.seams.length * 3), 3));
    const colors = new Float32Array(data.seams.length * 3);
    // color each pair by which seam it belongs to
    const seamOf = this.seamIndexPerPair(data);
    for (let k = 0; k < data.seams.length; k++) {
      const c = new THREE.Color(SEAM_COLORS[seamOf[k >> 1] % SEAM_COLORS.length]);
      colors[k * 3] = c.r; colors[k * 3 + 1] = c.g; colors[k * 3 + 2] = c.b;
    }
    sg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.seamLines = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }));
    this.seamLines.renderOrder = 10;
    this.scene.add(this.seamLines);
    this.updateCloth(data.pos);
    this.highlight();
  }

  private seamIndexPerPair(data: ClothData): number[] {
    // Rebuild pairing the same way build.ts does to label lines by seam
    const out: number[] = [];
    const p = this.store.project;
    const pieceIdx = new Map(p.pieces.map((x, i) => [x.id, i]));
    const pairSeam = new Map<string, number>();
    p.seams.forEach((s, si) => {
      const ia = pieceIdx.get(s.a.piece), ib = pieceIdx.get(s.b.piece);
      if (ia === undefined || ib === undefined) return;
      const A = data.pieces[ia]?.edgeParticles[s.a.edge], B = data.pieces[ib]?.edgeParticles[s.b.edge];
      if (!A || !B || A.length !== B.length) return;
      const n1 = A.length - 1;
      for (let k = 0; k <= n1; k++) {
        const a = A[k], b = B[s.reversed ? n1 - k : k];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (!pairSeam.has(key)) pairSeam.set(key, si);
      }
    });
    for (let k = 0; k < data.seams.length; k += 2) {
      const a = data.seams[k], b = data.seams[k + 1];
      out.push(pairSeam.get(a < b ? `${a}_${b}` : `${b}_${a}`) ?? 0);
    }
    return out;
  }

  updateCloth(x: Float32Array) {
    if (!this.data) return;
    this.data.pieces.forEach((pm, i) => {
      const mesh = this.clothMeshes[i];
      if (!mesh) return;
      const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      (attr.array as Float32Array).set(x.subarray(pm.start * 3, (pm.start + pm.count) * 3));
      attr.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    });
    if (this.seamLines) {
      const s = this.data.seams;
      const attr = this.seamLines.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let k = 0; k < s.length; k++) {
        const o = s[k] * 3;
        arr[k * 3] = x[o]; arr[k * 3 + 1] = x[o + 1]; arr[k * 3 + 2] = x[o + 2];
      }
      attr.needsUpdate = true;
      this.seamLines.geometry.computeBoundingSphere();
      this.seamLines.visible = this.showSeams;
    }
  }

  highlight() {
    const sel = this.store.sel.piece;
    for (const m of this.clothMeshes) {
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.emissive.set(m.userData.pieceId === sel ? 0x3a2a08 : 0x000000);
    }
  }

  // ---------- picking ----------
  private bindPicking() {
    let down: { x: number; y: number } | null = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || this.gizmo.dragging) { down = null; return; }
      down = null;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const hits = this.raycaster.intersectObjects([...this.clothMeshes, ...this.ringGroup.children], false);
      if (!hits.length) { if (!(this.gizmo.getHelper().visible && this.gizmo.axis)) this.store.select({}); return; }
      const o = hits[0].object;
      if (o.userData.pieceId) this.store.select({ piece: o.userData.pieceId });
      else if (o.userData.ringId) this.store.select({ ring: o.userData.ringId });
    });
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  frameAll() {
    const box = new THREE.Box3();
    box.expandByObject(this.clothGroup);
    if (this.store.project.scene === 'avatar') box.expandByObject(this.avatarGroup);
    box.expandByObject(this.ringGroup);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(dir.multiplyScalar(size * 1.5 + 40));
  }
}
