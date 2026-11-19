# Three.js atmosphere and clouds

`src/atmosphere.ts` uses Three.js's `Sky` and `ImprovedNoise` addons and adapts the ray/box intersection and density-texture raymarching approach from:
https://github.com/mrdoob/three.js/blob/r185/examples/webgl_volume_cloud.html

The world-space placement, light sampling, atmosphere integration and steering are specific to Power.

Three.js is distributed under the MIT license. Its copyright and full license are preserved in `public/THREE-LICENSE.txt`, which is also included in the production output.

Other candidates researched:
- https://github.com/takram-design-engineering/three-geospatial — fuller geospatial atmosphere/cloud pipeline; more integration work than this renderer needs.
- https://github.com/xiaxiangfeng/sky-cloud-3d — ready-made sky/cloud dome; non-commercial-only license, so not used.

# Street and building data

`public/data/manhattan-island.json` and the matching terrain grid use OpenStreetMap roads, building footprints, and the coastline from the [BBBike New York extract](https://download.bbbike.org/osm/bbbike/NewYork/), downloaded on 2026-11-04 and processed with `scripts/import-manhattan.py`. © OpenStreetMap contributors, licensed under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

`public/data/manhattan.json` contains Midtown Manhattan road centerlines and building footprints from the [OpenStreetMap map API](https://api.openstreetmap.org/api/0.6/map?bbox=-73.98655,40.74755,-73.98285,40.7507), extracted on 2026-11-04 and projected into local game coordinates. © OpenStreetMap contributors, licensed under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

`public/data/scenery.json` contains OpenStreetMap road and building data, extracted from the Geofabrik Liechtenstein download on 2026-10-21 with `scripts/import-scenery.py`. © OpenStreetMap contributors, licensed under the Open Database License (ODbL) 1.0: https://www.openstreetmap.org/copyright and https://opendatacommons.org/licenses/odbl/1-0/. In-game attribution links to OpenStreetMap.

# Fighter audio

The clips below are edited mono excerpts of Freesound recordings and sound designs. Each source is licensed under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

| Game cues | Source |
| --- | --- |
| Faora vocals | [rpg - tough girl battle sounds.wav](https://freesound.org/s/347342/) by mvVoiceActing |
| Anissa vocals | [Female Battle Cries v1 mp3.mp3](https://freesound.org/s/439516/) by Volonda |
| Battle Beast vocals | [elaine-growl.wav](https://freesound.org/s/63668/) by Miselaineous |
| Doomsday vocals | [Monster roar](https://freesound.org/s/537883/) by colorsCrimsonTears |
| Battle Beast footfall | [Metal Boom](https://freesound.org/s/209772/) by Johnnyfarmer |
| Doomsday footfall | [HeavyWobblyImpactHit_15](https://freesound.org/s/718004/) by Johnny25225 |
| Ground fighter leap | [Swing Woosh](https://freesound.org/s/389590/) by Jofae |
| Faora heat-vision buildup | [Sci-Fi Weapon Charging 02.wav](https://freesound.org/s/514081/) by Tim_Verberne |
| Faora heat-vision blast | [Weapon SciFi Blast Big Sequence](https://freesound.org/s/673794/) by Nox_Sound, layered with [Electric zap.wav](https://freesound.org/s/512471/) by michael_grinnell |
| Doomsday nova buildup | [Power Charge](https://freesound.org/s/407052/) by Sojan |
| Doomsday beam buildup | [SciFi Gun - Mega Charge Cannon](https://freesound.org/s/440147/) by dpren |
| Doomsday beam release | [Heavy beam weapon, de-clicked](https://freesound.org/s/245883/) by Sarithule, based on [heavy beam weapon](https://freesound.org/s/152322/) by roper1911 |
| Doomsday nova blast | [S28-35 Atomic bomb explosion. then rumble.wav](https://freesound.org/s/674884/) by craigsmith |
