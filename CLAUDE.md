# Clothredee: handoff notes

A personal, browser-based Clo3D-style tool: draw 2D pattern pieces, sew edges, arrange them around a body or rings, simulate the drape, export. Started by Krystof (repo owner) on 2026-11-11 as a "simple first version". Read this before changing anything, then `README.md` for the user-facing feature list.

## Scope decisions so far

These came from the owner. Keep them unless the owner says otherwise.

- Core loop is **draw → sew → drape**, like Clo, not preset garments only.
- Two scenes: a **built-in mannequin** with size sliders, and an **empty scene with rings** for designing bags and hardware.
- Must have: **save/load project** and **OBJ/GLB export** (the owner is a 3D generalist and takes results into Blender).
- Format: a real repo project (Vite + TypeScript + Three.js), with a one-file preview build that can be published as a claude.ai artifact.
- Not in v1 yet: fabric textures/prints, avatar import, self-collision within a piece, partial-edge seams, pins/tack points, a Web Worker solver.

## Commands

```bash
npm install
npm run dev             # dev server
npm run build           # tsc --noEmit + vite build -> dist/
npm run check:sim       # headless regression: every template x every fabric must sew shut and stay on
npm run build:artifact  # dist-single/clothredee.html, a body-only page for a claude.ai artifact
```

CI (`.github/workflows/deploy.yml`) runs build + check:sim on every push and PR, and deploys `dist/` to GitHub Pages from `main`. Pages must be set to **Source: GitHub Actions** in repo settings or the deploy job fails with a 404.

**Always run `npm run check:sim` after touching `src/cloth/`, `src/colliders.ts` or the templates.** Most bugs so far showed up as "garment quietly slides to the floor", which looks fine in a screenshot of the first frame.

## Architecture

| File | Role |
| --- | --- |
| `src/model.ts` | Plain-JSON project model (`Project`, `Piece`, `Seam`, `Ring`), fabric presets, templates |
| `src/store.ts` | State, selection, undo/redo (JSON snapshots), localStorage autosave. Change kinds: `geometry` rebuilds cloth, `scene` rebuilds colliders, `fabric` updates solver params, `meta` is visual only |
| `src/ops.ts` | Pattern edits that keep seam edge indices valid (insert/delete point, add seam, duplicate/mirror) |
| `src/cloth/build.ts` | Pattern → particles: edge sampling (sewn edges share a segment count), triangular lattice + Delaunator, stretch/bend/long-range constraints, seam particle pairs, 3D placement |
| `src/cloth/solver.ts` | Cloth solver. No DOM or Three imports, so it can move into a Worker |
| `src/colliders.ts` | Analytic colliders: lofted torso (elliptical cross-section table with gradients), capsules, spheres, torus rings, ground |
| `src/pattern2d.ts` | Canvas 2D pattern editor and tools |
| `src/view3d.ts` | Three.js viewport, mannequin mesh (built from the same data as its collider), cloth meshes, seam lines, move gizmo |
| `src/main.ts` | App wiring, sim loop, properties panel (vanilla DOM, re-rendered on change) |
| `src/io.ts` | Save/open JSON, OBJ/GLB export (meters), artifact `downloads` capability fallback with a tiny zip writer |

## Conventions that bit us

- **Units are cm** everywhere in the app. Exports scale to meters. UVs are pattern cm / 100 (1 UV unit = 1 m of fabric).
- Pattern polygons are stored **counter-clockwise, y up**. `ensureCCW` on creation. Edge `i` runs from point `i` to `i+1`.
- **Placement position is the piece's bbox center** (flat), or the **wrap cylinder axis at the piece's mid height** (wrapped). It is *not* the hem. Templates were once placed as if it were the hem and every garment started 30 cm too low.
- Wrap mapping: vertical wrap bends piece-x around the Y axis; horizontal wrap bends piece-y around the local X axis. Then pitch (local X), then yaw (world Y). See `placePoint`.
- Seams default to `reversed: true` (a.start meets b.end), which is right for two CCW pieces facing each other. The 2D arrows show which ends meet; the 3D seam lines cross like an X when it's wrong.
- Inserting/deleting a point drops seams on the affected edge(s) and shifts later edge indices (`ops.ts`). Keep that invariant if you add new edit ops.

## Solver notes (tuned values, change carefully)

- XPBD-style: 12 substeps per frame, 2 stretch iterations, 1 bend iteration. Compliance comes from the 0..1 fabric sliders as `10^(1 - 4*stretch)` and `10^(2.5 - 3.5*bend)`.
- **Fixed 1/60 s per frame.** Real-time dt made slow machines (and headless tests) produce softer cloth and different results. Slow devices now play in slow motion instead.
- **Sewing phase:** gravity is 12% until the largest seam gap is under 0.8 cm (or 4 s pass), then ramps to full. Seams close at a capped 110 cm/s while sewing, and act as stiff zero-length constraints after. Without this, garments slid off before the shoulders were stitched.
- **Long-range max-distance constraints** (2 random partners per particle, 3 to 14 spacings away, same piece, line inside the polygon). One-sided: they only pull when 3D distance exceeds the flat 2D distance × slack. This stopped hanging cloth from creeping/stretching 15%+ over a few seconds. Slack grows for stretchy fabrics.
- **Thin colliders:** capsule and ring pushes use the side the particle came from, so fast particles can't tunnel through the core. Rings also collide stretch-edge midpoints, since lattice rows can be ~3.5 cm apart and a 2.6 cm ring tube slipped between them.
- Collider candidates are found once per frame per particle (bitmask, max 32 colliders). Layer repulsion between different pieces runs every 3rd substep on a hash grid; seam partners are excluded.
- Rough cost in Node: tank top (~1.8k particles) ~11 ms/frame. Repulsion is the most expensive part.

## Artifact preview

`npm run build:artifact` strips `<!doctype>/<html>/<head>/<body>` because the claude.ai artifact host adds its own skeleton. The page declares the `downloads` capability; there, only some extensions are allowed (json, zip, ...), so OBJ/GLB are wrapped in a store-only zip. Outside an artifact, `io.ts` falls back to normal `<a download>`.

## Ideas for next steps

Roughly in the order they'd add the most:

1. Self-collision within a piece (folds, sleeves, gathered fabric).
2. Pin/tack points (fix particles in space or to a ring/body) and partial-edge seams.
3. Sleeve and trousers templates; sleeves need the armhole arrangement to wrap around the arm capsules.
4. Fabric color/texture on pieces (image upload, UV already set up in export).
5. Avatar import (OBJ/GLB) with a mesh SDF or BVH collider.
6. Move the solver into a Web Worker; consider WASM later.
7. Bag hardware beyond rings: D-rings, frames, handles as rigid capsules.

