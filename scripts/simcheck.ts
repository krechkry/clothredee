// Headless regression check: every template must sew shut and hang where it should
// with every fabric preset. Run: npm run check:sim
import { TEMPLATES, FABRICS } from '../src/model';
import { buildCloth } from '../src/cloth/build';
import { ClothSim } from '../src/cloth/solver';
import { buildColliders } from '../src/colliders';

// Lowest point the top of each garment may sag to after 7 s (cm). Below = it slipped off.
const MIN_TOP: Record<string, number> = { 'Tank top': 145, 'Skirt': 98, 'Hanging bag': 110 };

let failed = 0;
for (const [name, minTop] of Object.entries(MIN_TOP)) {
  for (const [fabric, f] of Object.entries(FABRICS)) {
    const p = TEMPLATES[name]();
    p.fabric = { preset: fabric, ...f };
    const d = buildCloth(p);
    const sim = new ClothSim(d, buildColliders(p.scene === 'avatar' ? p.avatar : null, p.rings), p.fabric, p.particleDistance);
    const t0 = performance.now();
    for (let i = 0; i < 420; i++) sim.step(1 / 60);
    const ms = (performance.now() - t0) / 420;
    let maxY = -Infinity, nan = 0;
    for (let i = 0; i < d.n; i++) { const y = sim.x[i * 3 + 1]; if (!Number.isFinite(y)) nan++; else maxY = Math.max(maxY, y); }
    const gap = sim.seamGap();
    const ok = nan === 0 && gap < 0.5 && maxY >= minTop;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(12)} ${fabric.padEnd(8)} top=${maxY.toFixed(1)} (min ${minTop}) gap=${gap.toFixed(2)} nan=${nan} ${ms.toFixed(1)}ms/frame`);
  }
}
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
