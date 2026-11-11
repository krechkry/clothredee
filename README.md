# Clothredee

A small Clo3D-style garment tool that runs in the browser. Draw 2D pattern pieces, sew their edges together, place them around a mannequin (or rings in an empty scene) and let the cloth simulation sew and drape them.

## What it does (v0.1)

- **2D pattern window**: rectangle and polygon tools, drag points to reshape, add or delete points, edge lengths in cm, pan/zoom (mouse, trackpad, touch pinch).
- **Sewing**: pick two edges. Colored arrows show which ends meet; flip a seam if it comes out twisted.
- **Arrangement**: each piece is placed in 3D flat, or wrapped around a vertical or horizontal cylinder (like Clo's arrangement points). Quick Front / Back / Left / Right buttons, a move gizmo in 3D.
- **Simulation**: position-based cloth solver with a Clo-like sewing phase (low gravity until seams close), body collisions, friction, and layer separation between pieces.
- **Scenes**: built-in mannequin with height / chest / waist / hips sliders, or an empty scene with rings (for bags, straps and hardware).
- **Fabric**: Cotton, Denim, Silk, Jersey, Leather presets plus stiffness, bending, weight and friction sliders.
- **Files**: autosave in the browser, Save/Open project JSON, export the current drape as OBJ or GLB (meters, with pattern UVs where 1 UV unit = 1 m of fabric).
- **Templates**: Tank top, Skirt, Hanging bag, blank mannequin, blank scene.

## Keys

| Key | Action |
| --- | --- |
| V / R / P / A / S | Select, Rectangle, Polygon, Add point, Sew |
| Space | Simulate / pause |
| Delete | Delete selected point, piece, seam or ring |
| Enter / Esc | Close polygon / cancel |
| F | Fit both views |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo |
| Ctrl+S | Save project file |
| Shift while dragging a point | Snap to 1 cm |

## Develop

```bash
npm install
npm run dev           # local dev server
npm run build         # production build in dist/
npm run build:artifact  # one-file build for a claude.ai preview page
```

Pushing to `main` builds the site with GitHub Actions and deploys it to GitHub Pages. Turn that on once in **Settings → Pages → Source: GitHub Actions**.

## Code map

- `src/model.ts` project data, fabric presets, templates
- `src/cloth/build.ts` pattern pieces to particles: edge sampling, triangulation, seam pairs, 3D arrangement
- `src/cloth/solver.ts` the cloth solver (no DOM, ready to move into a Web Worker)
- `src/colliders.ts` mannequin, ring and ground collision shapes
- `src/pattern2d.ts` 2D pattern editor
- `src/view3d.ts` Three.js viewport
- `src/main.ts` app wiring and properties panel
- `src/io.ts` save, open, OBJ/GLB export

## Known limits

- No self-collision inside a single piece yet (folds of one piece can pass through each other).
- Seams join whole edges; split an edge with Add point to sew part of it.
- The mannequin is a stylized collision body, not a scanned avatar. No avatar import yet.
- One simulation step per frame at a fixed 1/60 s, so slow devices play the drape in slow motion.
