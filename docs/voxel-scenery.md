# Voxel scenery and LOD

Buildings, plants and roads are sampled by the existing terrain engine. They do not create separate scenery meshes or colliders. `columnSpans` combines authored volumes with the ground before applying carve/fill edits. The same model definitions run on the main thread and in terrain mesh workers. Physics, destruction, debris and healing use the same voxel source and edits. Foliage is a soft, non-blocking visual material; the body collision sampler and Rapier mesh omit it, while punches can still remove it. Trunks remain solid.

## Buildings

OpenStreetMap polygons preserve diagonal facades, concave wings and courtyard notches rather than filling their axis-aligned bounding rectangles. Each building has a local frame aligned with its longest facade. Roof tags select gable, hip, shed or flat roofs; missing roof tags use deterministic procedural choices, with flat roofs favoured for large industrial buildings. Building height, levels and type inform proportions where available. Missing details are procedural, not surveyed architecture.

Nearby facades contain glass material voxels arranged into windows and timber doors; roof volumes use tile or slate materials. Chimneys are additional voxel volumes. Glass is rendered as an opaque blue window material in the shared terrain material. It breaks more easily than concrete. Buildings have hollow interiors at the near LOD: 0.5 m perimeter walls, floor slabs every 3.2 m, a thin roof shell, and a walkable opening in the first facade. Interior space is unfurnished. Medium and far LODs use closed exterior proxies; body collision always uses the fine hollow representation.

## Vegetation library

`src/vegetation.ts` defines **two reusable templates per species**, with three authored LOD representations each. Instances share the templates and vary yaw, size and form. Angled cylindrical trunks and branches intersect the same voxel columns as crowns. Crowns use ellipsoids and tapered shapes, avoiding axis-aligned cuboid trees. Shrubs have clustered crowns and several stems.

| Species | Scientific name | Silhouette |
| --- | --- | --- |
| Norway spruce | Picea abies | Narrow spire with tiered branches |
| Silver fir | Abies alba | Broader, flatter tiers |
| European beech | Fagus sylvatica | Wide, lobed crown |
| Sycamore maple | Acer pseudoplatanus | Rounded, asymmetric crown |
| European larch | Larix decidua | Open tapered crown |
| Scots pine | Pinus sylvestris | High, irregular crown |
| Common hazel | Corylus avellana | Broad, multi-stem shrub |
| Common dogwood | Cornus sanguinea | Low, clustered shrub |

Forest is planted as stands: an 8 m jittered grid over forest ground, thinned by stand-scale noise into closed stands, glades and shrubby edges. Each stand shares a species mix and age (smooth noise, with a fifth of each choice left to chance), so it reads as a patchwork from the air (~93,000 trees within ±3 km).

Trees are voxels only in chunks of ≤ 1 m voxels (`TREE_VOXEL_MAX`). Beyond that, `src/trees.ts` draws the same instances as low-poly instanced meshes (built from each model's medium LOD) and then as impostors baked at startup into albedo and normal atlases (8×8 hemi-octahedral views per model), lit per pixel by the scene lights. Mid and far tiers dither by distance with complementary screen-space noise. Trees whose trunk is carved away are hidden from both tiers.

Streets are planted on both sides at regular distances along mapped road segments, rather than at arbitrary OSM nodes. A second pass adds groups in open town green spaces. Spatial checks keep trunks out of roads, buildings and nearby plantings.

The historical [Liechtenstein forest inventory (1998)](https://www.llv.li/serviceportal2/amtsstellen/amt-fuer-umwelt/publikationen/wald-und-holz/liechtensteinisches-landeswaldinventar-1998.pdf) informs the selection of tree species and the distinction between lower and higher elevation forest. It is not treated as a current inventory. Spruce/fir/larch become more common uphill; broadleaf trees are concentrated lower down. Placement, frequencies, age/size ranges, canopy dimensions and model colours are procedural art choices. Individual trees and shrub locations are not surveyed.

Additional references used for forms and shrub scale:

- [Spruce — forest research portal Waldwissen](https://www.waldwissen.net/de/lebensraum-wald/baeume-und-waldpflanzen/nadelbaeume/die-fichte-picea-abies)
- [Sycamore maple — Bavarian State Research Center for Agriculture](https://www.lfl.bayern.de/iab/kulturlandschaft/179908/index.php)
- [Hazel — InfoFlora](https://www.infoflora.ch/en/flora/corylus-avellana.html)
- [Dogwood — InfoFlora](https://www.infoflora.ch/de/flora/1356-cornus-sanguinea.html)

No photographs or third-party tree assets were copied. The voxel models are generated locally from the reusable templates.

## LODs

LOD follows the terrain quadtree's voxel size rather than using a separate distance/collision system. Quadtree levels coarser than `TerrainLOD.voxelMaxSize` (4 m) are built as far tiles (`src/terrain/far.ts`): smooth ground sampled without vertical quantisation (destruction edits still applied), whose vertices also store their parent tile's height, normal and colour and morph toward them with distance (CDLOD), plus the voxel buildings (to 64 m voxels) and trees (to 16 m) standing on it. Collision always uses the voxel columns. The quadtree selects larger voxels as view distance increases; a chunk splits once its voxels would span more than `pixelError` screen pixels (eased upward when the drawn chunk count exceeds `chunkBudget`), and merges back only with some hysteresis. On a swap the new chunks dither in over `fadeTime` while the chunks they replace stay solid underneath (so rapid chained swaps can never open a hole), and voxel shade jitter uses a world grid sized to the pixel footprint, so it does not reshuffle when a chunk changes level.

| Representation | Voxel size | Buildings | Vegetation | Roads |
| --- | --- | --- | --- | --- |
| Near | 0.125–0.5 m | Full footprint, hollow rooms/floors, entrance, windows, chimney, shaped roof | Lobed/tiered crown, diagonal branches and trunk | Streets and footpaths |
| Medium | 1–2 m | Simplified footprint, roof silhouette, plain facade | Two crown masses and trunk | Streets; tiny paths omitted |
| Far | 4 m+ | Further simplified footprint and roof, plain facade | One crown mass and trunk | Wider roads retained, minor paths omitted |

Model templates have fewer primitives at each step. The worker mesher also coarsens geometry and greedily merges faces. Footprint simplification removes only small deviations; it does not substitute bounding boxes. Physics samples the finest model representation. Damage and healing are applied at each rendered LOD using the shared edit field.

## Materials and performance

Concrete has strength 0.35 (soil is 0.9), timber 0.3, and foliage 0.025. Concrete has zero restitution. Player flight, walking, head impacts, companion motion and debris respect the contacted material's restitution. Rapier terrain triangles are grouped so concrete uses zero restitution with the minimum combine rule; other terrain retains its previous restitution.

Interior floors and ceilings are greedily merged like roof surfaces. Source column intervals, material identities and instance IDs are cached with bounded memory (16,384 entries / 131,072 intervals), independently of changing destruction edits. Repeated material queries reuse the last sampled column, and primitive intersection reuses scratch storage. Vegetation placement uses spatial indexes instead of scanning every building at every candidate point.

A local synthetic room benchmark reduced geometry from 35,140 vertices to 2,820 (about 92%) after merging its interior slabs. The warm median build time in that run fell from 4.60 ms to 3.63 ms; timings depend on machine and workload. Run `node scripts/benchmark-scenery.mjs` for current results.

Checks: `node scripts/check-voxel-scenery.mjs`, `node scripts/check-authored-models.mjs`, `node scripts/check-city-physics.mjs`, and `npm run build`.
