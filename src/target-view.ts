import * as THREE from "three";
import type { Faora } from "./faora";
import { projectMarker } from "./markers";

const FRAMED = 2.4; // metres of the target kept in frame: a body fills most of the window at any range
const STANDOFF = 15; // the zoom camera sits at most this far from the target, on your side, to see past cover
const FAR = 60; // only targets locked from further than this get the zoom box
const SHOW_TIME = 2; // seconds the box stays up after locking on

/** A brief zoom box over a far target, right where they are on screen, drawn into #target-view after the main frame. */
export class TargetView {
  private shown: Faora | null = null;
  private timer = 0;
  private readonly camera = new THREE.PerspectiveCamera(10, 1.5, 0.5, 250000);
  private readonly point = new THREE.Vector3();
  private readonly toward = new THREE.Vector3();
  private readonly name: HTMLElement;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private fog: THREE.FogExp2, private frame: HTMLElement) {
    this.name = frame.querySelector("b")!;
  }

  /** hide: objects that belong to the main view only (the first-person fist). dt in real seconds. */
  render(main: THREE.PerspectiveCamera, target: Faora | null, hide: THREE.Object3D[], dt: number) {
    if (target && target.ragdoll.active) this.point.copy(target.ragdoll.joints[2]);
    else if (target) this.point.copy(target.pos).y += 1;
    // A new lock on a far target opens the box for SHOW_TIME; nearby locks never do.
    if (target !== this.shown) {
      this.shown = target;
      this.timer = target && main.position.distanceTo(this.point) > FAR ? SHOW_TIME : 0;
    }
    this.timer = Math.max(0, this.timer - dt);
    const screen = target && this.timer > 0 ? projectMarker(main, this.point, innerWidth, innerHeight) : null;
    this.frame.hidden = !target || !screen || screen.offscreen;
    if (!target || !screen || screen.offscreen) return;
    if (this.name.textContent !== target.name.toUpperCase()) this.name.textContent = target.name.toUpperCase();
    this.frame.style.transform = `translate(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px) translate(-50%, -50%)`;
    this.frame.style.opacity = `${Math.min(1, this.timer / 0.25, (SHOW_TIME - this.timer) / 0.12)}`;

    // Along your line of sight, but pulled in close: a building between you and her doesn't blank the window.
    const cam = this.camera;
    this.toward.subVectors(this.point, main.position);
    const distance = Math.min(STANDOFF, Math.max(1, this.toward.length()));
    cam.position.copy(this.point).addScaledVector(this.toward.normalize(), -distance);
    cam.lookAt(this.point);
    cam.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(FRAMED / distance)), 0.3, 40);
    const box = this.frame.getBoundingClientRect();
    cam.aspect = box.width / box.height;
    cam.updateProjectionMatrix();

    const r = this.renderer, autoClear = r.autoClear, density = this.fog.density;
    const visible = hide.map(o => o.visible);
    hide.forEach(o => o.visible = false);
    // Optics cut through some of the haze so a distant target stays readable.
    this.fog.density = density * 0.35;
    r.setRenderTarget(null);
    r.autoClear = false;
    const y = innerHeight - box.bottom;
    r.setScissorTest(true);
    r.setScissor(box.left, y, box.width, box.height);
    r.setViewport(box.left, y, box.width, box.height);
    r.clear(true, true, false);
    r.render(this.scene, cam);
    r.setScissorTest(false);
    r.setViewport(0, 0, innerWidth, innerHeight);
    r.autoClear = autoClear;
    this.fog.density = density;
    hide.forEach((o, i) => o.visible = visible[i]);
  }
}
