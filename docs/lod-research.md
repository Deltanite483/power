# LOD rework — research and recommendation

Status: written 2026-10-25. Phase 2 (far terrain) has a first version: far tiles in `src/terrain/far.ts` morph CDLOD-style inside the existing quadtree, with voxels kept up to 4 m. Damage at distance comes from re-sampling edits per tile rather than a height-delta texture. Phase 4 (vegetation tiers) has a first version: clustered stands, instanced mid trees and baked impostors in `src/trees.ts`, inside the existing ±3 km planting region. The other phases are not started.

## Where we are

Today **everything** — ground, buildings, trees, roads, rivers — is one voxel field, meshed in a quadtree of 32×32-column chunks whose voxel size doubles per level (0.125 m → 64 m+). That single representation drives rendering, physics and destruction, which is elegant, but it is why distance looks wrong:

- Far away we draw 4–64 m blocks. They are a staircase that changes shape every time a chunk changes level, so no amount of fading hides that the mountain itself moves.
- Every future feature (tall buildings seen from 10 km, forests, night lights, cars, people) would have to be expressed as voxels and survive the same coarsening.
- Rivers are a 10 m raster mask painted as solid blue voxels whose surface follows the ground minus 1.5 m, so they terrace downhill, have staircase banks, are opaque, and disappear entirely above 64 m voxels.

Recent fixes (Oct 2026): hysteresis, a pixel-error split metric with a chunk budget, LOD-stable shade noise, a hole-free dithered crossfade (fading chunks use per-step materials — three.js does not re-upload a shared `MeshLambertMaterial`'s uniforms per object), and a NaN in the speed-blur pass. These make the current system stable, not good-looking at distance.

## What other games do

The consistent pattern in shipped open worlds: **the representation you simulate is not the representation you draw at distance.** Each category of thing gets its own purpose-built far representation and LOD scheme, and they are composited with a shared atmosphere that hides seams.

| Game / system | Near | Far | How transitions are hidden |
| --- | --- | --- | --- |
| **Minecraft + Distant Horizons** | Real voxel chunks | Separate, pre-generated simplified LOD data, rendered *behind* normal terrain | Depth compositing (LODs draw behind vanilla chunks), distance + height fog, fade/clip transitions ([VulkanMod DH extension notes](https://modrinth.com/project/ZCkzFkVk)) |
| **Aokana** (GPU voxel open-world research, 2025) | 256³ SVDAG chunks, ray-marched | Parent chunk = 8 children merged at same resolution, colour averaged | None — the paper explicitly does no blending; water/glass must be ordinary meshes; no runtime edits ([paper](https://arxiv.org/html/2505.02017v1)) |
| **Teardown** | Small destructible voxel scenes, ray-traced every pixel | Maps are deliberately small; no long-distance LOD to copy ([SE Daily interview](https://softwareengineeringdaily.com/2025/01/02/teardown-and-voxel-based-rendering-with-dennis-gustafsson/), [TechRadar](https://www.techradar.com/gaming/consoles-pc/ray-tracing-is-so-crucial-to-teardown-that-the-world-goes-black-if-you-turn-it-off)) | n/a |
| **CDLOD heightmap terrain** (Strugar; the basis of many engines' terrain) | Fine grid | Quadtree of regular grids, LOD by true 3-D distance | Per-vertex morphing toward the coarser grid in the vertex shader, so there is no pop and no stitching ([CDLOD repo + paper](https://github.com/fstrugar/CDLOD)); engines like O3DE blend between LODs with doubling blend distances ([O3DE terrain docs](https://docs.o3de.org/docs/user-guide/components/reference/terrain/world-renderer/)) |
| **Microsoft Flight Simulator** | Streamed terrain tiles, photogrammetry, AI-reconstructed buildings | Tiles requested recursively by estimated screen size; a tile uses its parent's data until its own arrives ([Asobo terrain talk](https://WWW.ASOBOSTUDIO.COM/files/inline-images/Designing_Terrain_System_Fuentes_Lionel.pdf)); buildings inferred from imagery/OSM ([TechCrunch](https://techcrunch.com/2020/08/17/meet-the-startup-that-helped-microsoft-build-the-world-of-flight-simulator)) | Screen-size LOD + streaming fallback to parent |
| **Unreal World Partition / Fortnite** | Individual actors | HLOD: clusters of actors baked into one proxy mesh + material per cell (merged, simplified, approximated or instanced) ([Epic docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine)); trees as octahedral impostors ([80.lv](https://80.lv/articles/impostor-baker-for-ue4/)) | Switch by load range / on-screen size |
| **GTA V** | Full city | Huge swathes in a single draw call; at night, distant lights are instanced 32×32 quads; distant cars are two headlight sprites until the model loads ([graphics study](https://adriancourreges.com/blog/2015/11/02/gta-v-graphics-study-part-2)) | Lights carry the night skyline |
| **Cities: Skylines II** (cautionary) | — | Shipped with characters lacking LODs and only frustum culling; the developer acknowledged the missing LODs ([TechRadar](https://www.techradar.com/gaming/pc-gaming/no-cities-skylines-2s-performance-issues-arent-because-of-the-citizens-teeth-developer-confirms)) | Lesson: every crowd/vehicle asset needs LODs from day one |

Nobody we found keeps a destructible voxel world as the *only* representation out to tens of kilometres with smooth transitions. Distant Horizons is the closest, and even it uses a separate LOD dataset drawn behind the real chunks.

## Recommendation: layered world, one shared LOD policy

Keep voxels where they matter (near the player: destruction, physics, punching through walls) and give every category a cheap far form generated **from the same source data**, so the two always agree.

### 1. Terrain

- **Near ring (roughly 0–1.5 km, tunable):** today's voxel quadtree, capped so the coarsest voxel chunk is ~2–4 m. This is where blockiness is the intended look and where edits happen.
- **Far field:** a CDLOD heightmap from the same 10 m DEM (and the outer grid), with vertex morphing, so mountains never pop. Colour and material come from the same `surfaceMaterial` / `surfaceColor` rules, baked into a texture per tile (or evaluated in the shader). Normals come from the DEM, which also gives correct sun lighting at any time of day.
- **Compositing:** far terrain is drawn behind the voxel ring (Distant Horizons-style), with an overlap band where the voxel ring dithers out using **per-instance or per-material fade, never a shared uniform**.
- **Damage at distance:** craters write into a low-res height-delta texture that the far terrain samples, so a crater stays visible from the air after its voxels leave the near ring.
- **Decision for you:** far terrain smooth (realistic) or quantised to look blocky. A 4 m voxel is sub-pixel past ~2 km anyway, so smooth is the usual choice; the shader can keep a faint voxel-grid shading so the style carries over.

### 2. Buildings (including future tall ones)

- **Near:** voxel buildings as now: hollow, destructible.
- **Mid/far:** a per-building mesh proxy built from the same OSM footprint and roof rules (extruded polygon, roof, window texture). The proxies are merged into one mesh per terrain tile, which is UE's HLOD idea, so a whole district is one draw call. Tall buildings then become cheap to show from 20 km.
- **Damage:** when a building is damaged, regenerate its proxy from the voxel mesher at a coarse voxel size. We already have that mesher, so destroyed skylines stay destroyed from far away.
- **Night:** emissive window texture on proxies plus GTA-style instanced light quads for streets and windows at distance.

### 3. Forests and trees

- **Near (≤ ~250 m):** voxel trees (punchable), placed in clustered stands (see forest notes in `voxel-scenery.md`).
- **Mid (≤ ~2 km):** low-poly instanced trees (`InstancedMesh`/`BatchedMesh` with per-instance culling and LOD; three.js has a `webgl_batch_lod_bvh` example at 500k instances: [example](https://threejs.org/examples/webgl_batch_lod_bvh.html), [@three.ez/batched-mesh-extensions](https://github.com/agargaro/batched-mesh-extensions/)).
- **Far (≤ ~6 km):** octahedral impostors with **separate unlit-diffuse and world-normal atlases**, so they relight correctly through day and night. A three.js open-world series bakes exactly this and targets a million trees with one instanced draw ([Cinevva, part 19](https://app.cinevva.com/blog/2026-05-04-open-world-browser-part-19-imposters)).
- **Beyond:** forest becomes a canopy colour and slight height on the far terrain itself.
- Fades use a per-instance attribute, which also avoids the uniform-upload trap we hit.

### 4. Cars and people

- Never voxels. Skinned meshes near (≤ ~150 m), instanced vertex-animation or palette-skinned instances mid ([GPU Gems 3, ch. 2](https://developer.nvidia.com/gpugems/GPUGems3/gpugems3_ch02.html)), impostor sprites or just lights far. At night a distant car is two headlight quads (GTA).
- Simulate far agents at lower rate on the road graph only.
- Every asset ships with LODs (the Cities: Skylines II lesson).

### 5. Atmosphere, day/night and shadows

- Replace `FogExp2` with Hillaire-style sky + aerial-perspective LUTs. They handle dynamic time of day cheaply, scale to low-end GPUs, and are what Unreal uses ([paper](https://diglib.eg.org/handle/10.1111/cgf14050), [slides](https://blog.selfshadow.com/publications/s2020-shading-course/hillaire/s2020_pbs_hillaire_slides.pdf)). The same haze applied to every layer is also the best seam-hider between near and far LODs.
- **No baked sun.** The mesher bakes depth darkening and face shading into vertex colours. That's fine as ambient occlusion, but sun direction must stay dynamic.
- **Shadows:** cascaded shadow maps for the near ring (standard for sun over large terrain: [NVIDIA](https://developer.download.nvidia.com/SDK/10/opengl/src/cascaded_shadow_maps/doc/cascaded_shadow_maps.pdf); terrain shadow cost tips: [GPUOpen](https://gpuopen.com/learn/optimizing-terrain-shadows/)). Precomputed horizon maps on the DEM handle long dawn and dusk mountain shadows on far terrain in one pass and suit LOD terrain ([Fourier horizon maps, HPG 2025](https://graphics.tu-bs.de/publications/fritsch2025fast)).

### 6. Rivers and water

The usual approach is a **separate water mesh**, not a voxel material:

- Build each river as a ribbon mesh along its OSM centreline, using real banks from OSM `waterway=riverbank`/`natural=water` polygons where available instead of a fixed 110 m.
- Make the water surface elevation **monotonic downstream**, smoothed along the spline, so it never terraces.
- Carve the terrain under the ribbon to water level minus depth inside `Heightfield.height`, so the voxel ring, physics and far terrain all agree. This "carve terrain from river geometry" step is standard ([Simon Schreibt's write-up](https://simonschreibt.de/?p=8231), [Shroud of the Avatar](https://shroudoftheavatar.com/?p=9441)).
- Shade with a flow map along the spline direction, depth-based colour and transparency using the scene depth we already have for clouds, and sky fresnel. Drawn as one transparent pass per tile, never per block, which is a known performance trap ([Godot forum](https://forum.godotengine.org/t/how-does-minecraft-render-water-is-it-possible-in-godot/76325)).
- The ribbon simplifies with distance, so the Rhine stays visible from altitude.
- Physics keeps a water volume (swim, splash) from the same spline.

### 7. Engine-level rules (apply to every layer)

- One LOD policy: screen-space error in pixels, hysteresis, a global budget, and a fade owned by the instance or material, never a shared uniform.
- Separate *simulation* range from *render* range per layer.
- WebGL2 is sufficient for all of the above. three.js's `WebGPURenderer` (we're on r185) would later allow GPU-driven culling and indirect draws, but nothing here depends on it.

## Suggested phases

1. **Rivers.** Self-contained, you asked for it, and it introduces the separate-mesh water layer the rest will reuse.
2. **Far terrain:** CDLOD + near voxel ring + height-delta damage texture. Biggest visual win; removes most popping.
3. **Atmosphere:** sky/aerial-perspective LUTs and a day/night clock (with dynamic lighting kept un-baked).
4. **Vegetation tiers:** clustered stands, instanced mid trees, impostors, canopy.
5. **Building proxies + HLOD tiles + night lights;** then tall buildings.
6. **Cars and people** with LOD + instancing from the start.

Each phase is shippable on its own, and each removes work from the voxel quadtree rather than adding to it.

## Open decisions

- Far terrain look: smooth vs quantised-blocky.
- Near voxel ring radius (cost vs how far destruction detail is visible).
- Whether destroyed things far away must update immediately (proxy regeneration cost) or can lag a second.

## Research gaps

- Distant Horizons' internal LOD data format: not documented publicly; only its compositing behaviour is confirmed.
- Teardown and Enshrouded: no public material on long-range LOD.
- MSFS tree and building LOD rules: only terrain tile streaming is documented.
