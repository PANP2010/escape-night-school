# Lit landmark illumination integration

Scope: todo 481/572, the L1 "lit classroom" landmark at `(-60, 0, 70.4)`. The current campus layout puts it in the short hall before the southwest stairwell, room `A:1:sc0`, rather than a classroom. This change keeps that layout.

The old landmark meshes contain an emissive-looking tube, additive floor planes and a halo. They do not light a receiving wall. Interior materials also intentionally discard ordinary `PointLight` contributions so outdoor street lamps cannot light through walls.

`CampusScene.setLandmarks(landmarks)` places one persistent analytic tube in the room containing the current level's `lit` landmark. The existing interior Lambert lighting calculates its irradiance on receiving walls and floors. Bounds are derived from `storeyRooms` (or a stairwell clear rectangle), with a separate floor/ceiling span. The L1 rectangle is x `[-64.76, -53.95]`, z `[69, 72.06]`, y `[0, 3.4]`.

The lamp uses the existing fluorescent power value and `intLive` outage factor. `blackout` sets its strength to zero; restoring L2 power restores its light on the next update. The existing eye adaptation stays independent. This change adds zero THREE lights, materials, geometry, render targets or draw calls; that is an incremental budget claim, not a claim about the whole scene's existing light count. It shares the current interior lighting's limitation that furniture does not cast a new local shadow. The old tube, halo and additive floor meshes retain their existing self-lit appearance independently of the new receiving-surface illumination.

Integration hook: after `Game.loadLevel()` calls `buildBarriers()`, call `this.campus.setLandmarks(this.level.def.landmarks)`. Undefined or empty landmarks turn the lamp off. This call must stay after any level-specific campus state reset and before the next rendered frame.

The startup/render lane also owns a pending change to construct the campus across frames. When combining it with this scene file, retain all four shared uniforms (`intLandmark`, `intLandmarkRect`, `intLandmarkY`, `intLandmarkAxis`), `setLandmarks`, and the per-frame blackout strength update. Run the hook only after the final `world` and its interior uniforms exist. Preserve the existing `scene.onBeforeRender` visibility hook; the local illumination does not require an additional scene hook or a second world render.

Reproduction: x `-56.2`, z `70.5`, feet y `0`, yaw `π/2`, pitch `-0.15`, no flashlight, `?steady`. To compare the same frame, disable only this lamp with `g.campus.setLandmarks(undefined)` and restore with `g.campus.setLandmarks(g.level.def.landmarks)`.

Validation status: targeted checks ran through the required heavy gate. `eye_light`, `campus_visual` and `own_torch` passed (17 tests). The new landmark test first caught excessive light on the ceiling 0.45 m above the tube. The fixture now smoothly reduces upward direct light to 1% once the upward cosine reaches 0.3, while retaining wall/floor output; total surface illumination still includes the weak bounce term. Its unchanged assertions then passed on a gated rerun (1 test). The room bounds, opposite wall faces, next storey, blackout/restoration and stable scene/material/light counts are covered.

The unified gated typecheck completed with rc 0 in 2.85 s, and the unified gated build completed with rc 0 in 1.749 s. As of 2026-11-05 18:51 Asia/Shanghai, the browser gate was still queued: no new screenshots or FPS measurements were available. Visual acceptance remains pending. Deployment belongs to the integration lane and is not claimed as validated or completed by this change.
