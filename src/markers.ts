import * as THREE from "three";

export interface MarkerPosition { x: number; y: number; angle: number; offscreen: boolean; }

/** Project a world point onto the screen or a safe inset at its edge. */
export function projectMarker(camera: THREE.PerspectiveCamera, point: THREE.Vector3, width: number, height: number): MarkerPosition {
  const local = point.clone().applyMatrix4(camera.matrixWorldInverse);
  const depth = Math.max(.01, Math.abs(local.z));
  let dx = local.x / depth * camera.projectionMatrix.elements[0] * width / 2;
  let dy = -local.y / depth * camera.projectionMatrix.elements[5] * height / 2;
  const halfW = Math.max(1, width / 2 - Math.min(85, width * .2));
  const halfH = Math.max(1, height / 2 - Math.min(90, height * .2));
  const offscreen = local.z >= 0 || Math.abs(dx) > halfW || Math.abs(dy) > halfH;
  if (offscreen) {
    // A point exactly behind the camera has no projected direction; use the lower edge.
    if (Math.abs(dx) + Math.abs(dy) < .01) dy = 1;
    const scale = 1 / Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH);
    dx *= scale; dy *= scale;
  }
  return { x: width / 2 + dx, y: height / 2 + dy, angle: Math.atan2(dy, dx) * 180 / Math.PI + 90, offscreen };
}
