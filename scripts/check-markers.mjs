import assert from "node:assert/strict";
import * as THREE from "three";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { projectMarker } = await server.ssrLoadModule("/src/markers.ts");
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, .1, 10000);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const center = projectMarker(camera, new THREE.Vector3(0, 0, -100), 1600, 900);
  assert.equal(center.offscreen, false); assert.equal(center.x, 800); assert.equal(center.y, 450);
  const right = projectMarker(camera, new THREE.Vector3(200, 0, -10), 1600, 900);
  assert.ok(right.offscreen && right.x > 800 && right.x <= 1515);
  const behind = projectMarker(camera, new THREE.Vector3(0, 0, 100), 1600, 900);
  assert.ok(behind.offscreen && behind.y > 450 && Number.isFinite(behind.angle));
  const narrow = projectMarker(camera, new THREE.Vector3(-100, 20, -5), 320, 500);
  assert.ok(narrow.offscreen && narrow.x >= 0 && narrow.x <= 320 && narrow.y >= 0 && narrow.y <= 500);
  console.log("Markers: on-screen, edge, behind-camera and narrow viewport projection passed.");
} finally { await server.close(); }
