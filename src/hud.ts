import * as THREE from "three";
import type { Heightfield, GridMeta } from "./terrain/heightfield";
import type { WorldData, Place } from "./terrain/data";
import { BOOST_MACH_LIMIT, FLY_LEVELS, SOUND_SPEED, soundSpeed, type Player } from "./player";
import type { Faora } from "./faora";
import { projectMarker } from "./markers";
import { renderControls } from "./controls";

// Fighter name tags: hidden within MARKER_HIDE metres, faint out to MARKER_FAINT.
const MARKER_HIDE = 40, MARKER_FAINT = 100;
// A place counts as "ahead" within ~20° of your horizontal flight path, once you're actually moving.
const FLY_TOWARD_COS = Math.cos(20 * Math.PI / 180);
const FLY_TOWARD_SPEED = 8;

interface Label {
  place: Place;
  el: HTMLDivElement;
  y: number;
  range: number;
  hidden: boolean;
  width: number;
}

interface LabelBounds { left: number; right: number; top: number; bottom: number }
const intersects = (a: LabelBounds, b: LabelBounds, gap = 0) =>
  a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap;

export interface InteractionPrompt {
  name: string;
  carrying: boolean;
  inPunchRange: boolean;
}

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  private guide = $("hud-guide");
  private labelsEl = $("labels");
  private boom = $("boom");
  private labels: Label[] = [];
  private wasSupersonic = false;
  private occlusionCursor = 0;
  private v = new THREE.Vector3();
  shake = 0;
  /** Whether auto-return covers this side (false = you and friends, true = foes). */
  persists: (enemy: boolean) => boolean = () => false;
  /** A short line about a fighter's technique state (Sukuna's Fuga count or domain), shown under their bar. */
  techniqueNote: (fighter: Faora) => string = () => "";
  onSonicBoom: () => void = () => {};
  private gauge = $("gauge");
  private gaugeTimer = 0;
  private speedSettingTimer = 0;
  private displayedFlyLevel = -1;
  private underwater = $("underwater");
  companion: Faora | null = null;
  opponent: Faora | null = null;
  beast: Faora | null = null;
  doomsday: Faora | null = null;
  sukuna: Faora | null = null;
  gojo: Faora | null = null;
  lockedTarget: Faora | null = null;
  private readonly markerPoint = new THREE.Vector3();
  private lastFlightMode: boolean | undefined;
  private text = new Map<HTMLElement | SVGElement, string>();

  constructor(world: WorldData, private hf: Heightfield, _meta: GridMeta, landmarks: Place[] = []) {
    $("ui-speed-levels").innerHTML = FLY_LEVELS.map(() => "<i></i>").join("");
    renderControls(this.guide.querySelector(".controls-grid")!, document.querySelector("#pause-controls .controls-grid")!);
    addEventListener("keydown", (e) => {
      if (!e.repeat && e.key === "?") this.guide.hidden = !this.guide.hidden;
    });

    const wantKinds = new Set(["town", "village", "castle", "landmark"]);
    for (const p of [...world.places, ...landmarks]) {
      if (!wantKinds.has(p.kind) || p.tier > 2) continue;
      const el = document.createElement("div");
      el.className = `label ${p.kind}`;
      el.textContent = p.name;
      this.labelsEl.appendChild(el);
      const y = Math.max(p.ele, hf.height(p.x, p.z, 10)) + (p.kind === "landmark" ? 3 : 60);
      const range = p.kind === "landmark" ? 1250 : p.kind === "castle" ? 6500 : 10000;
      this.labels.push({ place: p, el, y, range, hidden: false, width: 0 });
    }
  }

  /** Write text only when it changed; the HUD updates every frame. */
  private set(el: HTMLElement | SVGElement, value: string) {
    if (this.text.get(el) === value) return;
    this.text.set(el, value);
    el.textContent = value;
  }

  /** Flash a one-line message in the gauge slot. */
  toast(title: string, value: string) {
    this.gauge.innerHTML = `<div class="gauge-title">${title}</div><div class="gauge-value">${value}</div>`;
    this.gaugeTimer = 1.4;
  }

  /** Highlight the integrated speed selector when scroll or a preset changes it. */
  showLevel(_kind: "fly", _level: number, _count: number, _value: string) {
    this.speedSettingTimer = 1.5;
  }

  /** What the crosshair is on, or what you're holding; null hides the prompt. */
  updatePrompt(prompt: InteractionPrompt | null) {
    const interaction = $("ui-interaction");
    interaction.hidden = !prompt;
    if (prompt) {
      this.set($("ui-target"), prompt.name);
      this.set($("ui-actions"), prompt.carrying ? "F throw · X drop" : prompt.inPunchRange ? "Click punch · F grab" : "F grab");
    }
  }

  /** Track each active fighter even when they're outside the view or behind terrain. */
  updateFighterMarkers(camera: THREE.PerspectiveCamera, visible?: (fighter: Faora) => boolean) {
    camera.updateMatrixWorld();
    for (const [id, fighter] of [["marker-faora", this.companion], ["marker-anissa", this.opponent], ["marker-beast", this.beast],["marker-doomsday",this.doomsday], ["marker-sukuna", this.sukuna], ["marker-gojo", this.gojo]] as const) {
      const marker = $(id);
      marker.hidden = !fighter || (visible !== undefined && !visible(fighter));
      if (marker.hidden || !fighter) continue;
      this.set(marker.querySelector(".marker-text b")!, `${fighter.name.toUpperCase()}${this.persists(fighter.enemyMode) && fighter.vitals.defeated?" · RETURNING":fighter.vitals.downed?" · DOWN":fighter.vitals.eliminated?" · OUT":""}`);
      if (fighter.ragdoll.active) this.markerPoint.copy(fighter.ragdoll.joints[2]).y += .35;
      else this.markerPoint.copy(fighter.pos).y += 2.25 * fighter.bodyScale;
      const screen = projectMarker(camera, this.markerPoint, innerWidth, innerHeight);
      const metres = camera.position.distanceTo(this.markerPoint);
      // Close fighters need no tag: none inside 40 m, a faint one out to 100 m. Off-screen edge arrows always show.
      const near = !screen.offscreen && metres < MARKER_FAINT;
      marker.hidden = near && metres < MARKER_HIDE;
      if (marker.hidden) continue;
      marker.classList.toggle("faint", near);
      this.set(marker.querySelector(".marker-text small")!, metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`);
      marker.style.transform = `translate(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px) translate(-50%, -100%)`;
      marker.classList.toggle("offscreen", screen.offscreen);
      marker.classList.toggle("hostile", fighter.hostile);
      marker.classList.toggle("locked", fighter === this.lockedTarget);
      marker.classList.toggle("occluded", !fighter.visibleToPlayer);
      marker.classList.toggle("defeated", fighter.vitals.defeated);
      marker.classList.toggle("stasis", fighter.vitals.frozen);
      (marker.querySelector(".marker-arrow") as HTMLElement).style.transform = `rotate(${screen.angle.toFixed(1)}deg)`;
    }
  }

  /** Coarse ray-march against the heightfield. */
  private occluded(from: THREE.Vector3, x: number, y: number, z: number): boolean {
    const n = 28;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const px = from.x + (x - from.x) * t, py = from.y + (y - from.y) * t, pz = from.z + (z - from.z) * t;
      if (this.hf.height(px, pz, 20) > py + 8) return true;
    }
    return false;
  }

  /** Revive counts stay out of the way until they matter: down, out, last life or auto-return. */
  private reviveNote(vitals: Player["vitals"], automatic: boolean) {
    if (automatic) return vitals.defeated ? "RETURNING" : "";
    if (vitals.eliminated) return "OUT";
    if (vitals.downed) return `DOWN · ${vitals.revivesRemaining} LEFT`;
    return vitals.revivesRemaining ? "" : "LAST LIFE";
  }

  update(player: Player, camera: THREE.PerspectiveCamera, dt: number) {
    const spd = player.speed;
    const mach = spd / soundSpeed(player.pos.y);
    const formatHealth = ({ health, frozen }: Player["vitals"]) => `${frozen ? Number(health.toFixed(2)) : Math.ceil(health)}`;
    this.set($("ui-health"), formatHealth(player.vitals));
    $("ui-health-fill").style.transform = `scaleX(${player.vitals.healthFraction})`;
    this.set($("ui-revives"), this.reviveNote(player.vitals, this.persists(false)));
    for (const [id, fighter] of [["ui-foe-faora", this.companion], ["ui-foe-anissa", this.opponent], ["ui-foe-beast", this.beast],["ui-foe-doomsday",this.doomsday], ["ui-foe-sukuna", this.sukuna], ["ui-foe-gojo", this.gojo]] as const) {
      const bar = $(id), locked = !!fighter && fighter === this.lockedTarget;
      const friend = !!fighter && !fighter.enemyMode;
      bar.hidden = !fighter || (!friend && (fighter.vitals.eliminated || (!fighter.vitals.downed && !(fighter.hostile || locked))));
      if (bar.hidden || !fighter) continue;
      bar.classList.toggle("friend", friend);
      bar.classList.toggle("foe", !friend);
      this.set(bar.querySelector("span")!, fighter.name.toUpperCase());
      this.set(bar.querySelector(".unit-revives")!, this.reviveNote(fighter.vitals, this.persists(fighter.enemyMode)));
      bar.classList.toggle("downed",fighter.vitals.defeated && (fighter.vitals.downed || this.persists(fighter.enemyMode)));
      bar.classList.toggle("locked", locked);
      this.set(bar.querySelector("b")!, this.persists(fighter.enemyMode) && fighter.vitals.defeated?"DOWN":fighter.vitals.downed?"DOWN":fighter.vitals.eliminated?"OUT":formatHealth(fighter.vitals));
      bar.querySelector<HTMLElement>(".vital-track i")!.style.transform = `scaleX(${fighter.vitals.healthFraction})`;
      const note = bar.querySelector<HTMLElement>(".unit-technique");
      if (note) this.set(note, this.techniqueNote(fighter));
      const ceBar = bar.querySelector<HTMLElement>(".vital-ce");
      const energy = fighter.cursedEnergy;
      if (ceBar && energy) {
        const reserve = energy.reserveFraction;
        const value = String(Math.round(reserve * 100));
        const label = energy.burnedOut ? "CE ✕" : "CE";
        this.set(ceBar.querySelector("span")!, label);
        this.set(ceBar.querySelector("b")!, value);
        ceBar.classList.toggle("locked", energy.burnedOut);
        ceBar.querySelector<HTMLElement>("i")!.style.transform = `scaleX(${reserve})`;
        const valueText = energy.burnedOut ? `${value} of 100, unavailable` : `${value} of 100`;
        if (ceBar.getAttribute("aria-valuenow") !== value) ceBar.setAttribute("aria-valuenow", value);
        if (ceBar.getAttribute("aria-valuetext") !== valueText) ceBar.setAttribute("aria-valuetext", valueText);
      }
    }
    const orientation = player.vitals.orientation;
    const effect = $("orientation-effect");
    const disorientation = 1 - orientation / 100;
    effect.style.setProperty("--orientation-shift", `${(disorientation * 13).toFixed(1)}px`);
    effect.style.setProperty("--orientation-opacity", `${(disorientation * .65).toFixed(3)}`);
    effect.style.setProperty("--orientation-shade", `${(disorientation * .28).toFixed(3)}`);
    effect.classList.toggle("active", orientation < 99.5);
    effect.setAttribute("aria-label", orientation < 35 ? "Disoriented; flight unavailable" : orientation < 90 ? "Disoriented" : "Orientation stable");
    $("flight-lock-cue").classList.toggle("active", orientation < 35);
    $("flight-lock-cue").setAttribute("aria-hidden", `${orientation >= 35}`);
    const heading = ((-player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const cardinal = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(heading / 45) % 8];
    const fmt = (value: number) => Math.round(value).toLocaleString("en-US");
    this.set($("ui-heading"), `${cardinal} · ${String(Math.round(heading) % 360).padStart(3, "0")}°`);
    this.set($("ui-speed"), fmt(spd));
    this.set($("ui-limit"), fmt(player.flySpeed));
    this.set($("ui-mach"), mach.toFixed(2));
    if (this.displayedFlyLevel !== player.flyLevel) {
      this.displayedFlyLevel = player.flyLevel;
      Array.from($("ui-speed-levels").children).forEach((pip, i) => pip.classList.toggle("on", i <= player.flyLevel));
    }
    this.speedSettingTimer = Math.max(0, this.speedSettingTimer - dt);
    $("ui-speed-setting").classList.toggle("adjusting", this.speedSettingTimer > 0);
    const agl = Math.max(0, player.altitudeAGL);
    this.set($("ui-altitude"), fmt(agl));
    const falling = !player.flying && !player.onGround && !player.inWater && player.vel.y < -3;
    $("ui-falling").classList.toggle("active", falling);
    this.set($("ui-fall-speed"), fmt(Math.max(0, -player.vel.y)));
    this.set($("ui-fall-altitude"), fmt(agl));
    $("ui-boost").classList.toggle("recharging", player.boostReady < .99);
    const boostLocked = spd >= SOUND_SPEED * BOOST_MACH_LIMIT;
    $("ui-boost").classList.toggle("locked", boostLocked);
    this.set($("ui-boost-label"), boostLocked ? "BOOST LOCKED" : player.boostReady < .99 ? "BOOST" : "");
    $("ui-charge").classList.toggle("active", player.charging && !player.flying);
    this.set($("ui-charge-percent"), `${Math.round(player.jumpCharge * 100)}%`);
    this.set($("ui-jump-height"), player.chargedHeight < 10 ? player.chargedHeight.toFixed(1) : fmt(player.chargedHeight));
    $("ui-charge-fill").style.transform = `scaleX(${player.jumpCharge})`;
    if (this.lastFlightMode !== player.flying) {
      this.lastFlightMode = player.flying;
      document.body.dataset.hudMode = player.flying ? "fly" : "foot";
    }

    this.gaugeTimer -= dt;
    this.gauge.classList.toggle("show", this.gaugeTimer > 0);
    this.underwater.style.opacity = player.underwater ? "1" : "0";

    // speed effects
    const supersonic = !player.inWater && mach >= (this.wasSupersonic ? .95 : 1);
    if (supersonic && !this.wasSupersonic) {
      this.boom.classList.remove("go");
      void this.boom.offsetWidth;
      this.boom.classList.add("go");
      this.shake = 1;
      this.onSonicBoom();
    }
    this.wasSupersonic = supersonic;
    this.shake = Math.max(0, this.shake - dt * 1.6);

  }

  updateNavigation(player: Player, camera: THREE.PerspectiveCamera, playing: boolean) {
    if (!this.labels.length) return;
    // Place names only appear while flying, for the places you're heading toward.
    const heading = this.v.set(player.vel.x, 0, player.vel.z);
    const moving = heading.lengthSq() > FLY_TOWARD_SPEED ** 2;
    this.labelsEl.hidden = !playing || player.underwater || !player.flying || !moving;
    if (this.labelsEl.hidden) {
      for (const label of this.labels) label.el.classList.remove("visible");
      return;
    }
    heading.normalize();
    const hx = heading.x, hz = heading.z;
    const w = innerWidth, h = innerHeight;
    const candidates: { label: Label; x: number; y: number; score: number; opacity: number }[] = [];
    for (let i = 0; i < 12 && this.labels.length; i++) {
      const l = this.labels[this.occlusionCursor++ % this.labels.length];
      l.hidden = this.occluded(camera.position, l.place.x, l.y, l.place.z);
    }
    for (const label of this.labels) {
      const { place, y, hidden } = label;
      if (hidden) continue;
      const dx = place.x - player.pos.x, dz = place.z - player.pos.z;
      const flat = Math.hypot(dx, dz);
      if (flat < 30) continue;
      const toward = (dx * hx + dz * hz) / flat; // cosine between travel and the place
      if (toward < FLY_TOWARD_COS) continue;
      const point = this.v.set(place.x, y, place.z);
      const distance = point.distanceTo(camera.position);
      const range = label.range * (1 + THREE.MathUtils.clamp((camera.position.y - 1500) / 3500, 0, .75));
      if (distance > range) continue;
      point.project(camera);
      if (point.z < -1 || point.z > 1 || Math.abs(point.x) >= 1 || Math.abs(point.y) >= 1) continue;
      const x = (point.x + 1) * w * .5, screenY = (1 - point.y) * h * .5;
      const aim = THREE.MathUtils.smoothstep(toward, FLY_TOWARD_COS, 1);
      const opacity = THREE.MathUtils.smoothstep(1 - distance / range, 0, .4) * aim * .94;
      if (opacity < .08) continue;
      if (label.width === 0) label.width = label.el.offsetWidth;
      candidates.push({ label, x, y: screenY, score: aim - distance / range + (label.el.classList.contains("visible") ? .075 : 0), opacity });
    }

    const blocked: LabelBounds[] = [
      { left: w / 2 - 60, right: w / 2 + 60, top: h / 2 - 35, bottom: h / 2 + 42 },
    ];
    for (const selector of ["#ui-vitals", "#hit-feed", "#target-view", ".fighter-marker.locked", ".flight-heading", ".flight-speed", ".flight-altitude"]) {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      if (box?.width && box.height) blocked.push(box);
    }
    const shown = new Set<Label>();
    candidates.sort((a, b) => b.score - a.score);
    for (const { label, x, y, opacity } of candidates) {
      if (shown.size >= 3) continue;
      const bounds = { left: x - label.width / 2, right: x + label.width / 2, top: y - 17, bottom: y };
      if (bounds.left < 16 || bounds.right > w - 16 || bounds.top < 18 || bounds.bottom > h - 24
        || blocked.some(other => intersects(bounds, other, 10))) continue;
      shown.add(label);
      blocked.push(bounds);
      label.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      label.el.style.setProperty("--label-opacity", opacity.toFixed(2));
    }
    for (const label of this.labels) label.el.classList.toggle("visible", shown.has(label));
  }
}
