import * as THREE from "three";
import { surfaceColor, type Heightfield, type GridMeta } from "./terrain/heightfield";
import type { WorldData, Place } from "./terrain/data";
import { BOOST_MACH_LIMIT, FLY_LEVELS, JUMP_MIN, JUMP_MAX, SOUND_SPEED, soundSpeed, type Player } from "./player";
import type { Faora } from "./faora";
import { projectMarker } from "./markers";

const MAP_RES = 40; // metres per minimap pixel
const ARC = 340 * Math.PI / 3; // length of the 60° speed / jump arcs, in HUD units
const FOOT_SPEED_SCALE = 30 / 3.6; // the on-foot speed arc is full at 30 km/h
const GROUND_WARN = 150; // metres above ground at which the flight HUD shows the warning
// Circular minimap: metres from centre to rim, from standing still to top flight speed.
const MINIMAP_NEAR = 1500, MINIMAP_FAR = 12000, MINIMAP_SPEED = 400;

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
  private mapWrap = $("map");
  private mapBase: HTMLCanvasElement;
  private mapCanvas = $("map-canvas") as HTMLCanvasElement;
  private minimap = $("minimap-canvas") as HTMLCanvasElement;
  private minimapNorth = $("minimap-north");
  private minimapRange = MINIMAP_NEAR;
  private labels: Label[] = [];
  private wasSupersonic = false;
  private occlusionCursor = 0;
  private bigMap = false;
  private v = new THREE.Vector3();
  private mapX0: number;
  private mapZ0: number;
  shake = 0;
  persistenceMode=false;
  /** The legacy helmet HUD and minimap are not rendered. */
  hidden = true;
  onSonicBoom: () => void = () => {};
  private gauge = $("gauge");
  private gaugeTimer = 0;
  private speedSettingTimer = 0;
  private displayedFlyLevel = -1;
  private underwater = $("underwater");
  companion: Faora | null = null;
  opponent: Faora | null = null;
  beast: Faora | null = null;
  doomsday: Faora|null=null;
  sukuna: Faora | null = null;
  gojo: Faora | null = null;
  lockedTarget: Faora | null = null;
  private readonly markerPoint = new THREE.Vector3();
  private lastFlightMode: boolean | undefined;
  private text = new Map<HTMLElement | SVGElement, string>();
  private el = {
    heading: $("hud-heading"),
    speed: $("hud-speed"),
    mach: $("hud-mach"),
    cap: $("hud-cap"),
    speedFill: $("hud-speed-fill"),
    jump: $("hud-jump"),
    jumpFill: $("hud-jump-fill"),
    altCaret: $("hud-alt-caret"),
    groundWarn: $("hud-ground-warn"),
    aglWarn: $("hud-agl-warn"),
    rightLine: $("hud-right-line"),
    rightTicks: $("hud-right-ticks"),
    boost: $("hud-boost"),
    agl: $("hud-agl"),
    msl: $("hud-msl"),
    surface: $("hud-surface"),
    prompt: $("hud-prompt"),
    promptName: $("hud-prompt-name"),
    promptAim: $("hud-prompt-aim"),
    promptHold: $("hud-prompt-hold"),
    moveGuide: $("hud-move-guide"),
  };
  private cardinals = (["N", "E", "S", "W"] as const).map((c, i) => ({ el: $(`hud-card-${c}`), deg: i * 90 }));

  constructor(private world: WorldData, private hf: Heightfield, private meta: GridMeta, landmarks: Place[] = []) {
    $("ui-speed-levels").innerHTML = FLY_LEVELS.map(() => "<i></i>").join("");
    this.mapX0 = meta.origin_x;
    this.mapZ0 = meta.origin_z;
    this.mapBase = this.renderMap();
    this.mapCanvas.width = this.mapBase.width;
    this.mapCanvas.height = this.mapBase.height;
    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (e.key === "?") this.guide.hidden = !this.guide.hidden;
      if (e.code === "KeyM") {
        this.bigMap = !this.bigMap;
        this.mapWrap.classList.toggle("big", this.bigMap);
      }
    });

    const wantKinds = new Set(["town", "village", "peak", "castle", "landmark"]);
    for (const p of [...world.places, ...landmarks]) {
      if (!wantKinds.has(p.kind) || p.tier > 2) continue;
      const el = document.createElement("div");
      el.className = `label ${p.kind}`;
      el.textContent = p.kind === "peak" ? `▲ ${p.name} ${Math.round(p.ele)} m` : p.name;
      this.labelsEl.appendChild(el);
      const y = Math.max(p.ele, hf.height(p.x, p.z, 10)) + (p.kind === "landmark" ? 3 : p.kind === "peak" ? 25 : 60);
      const range = p.kind === "landmark" ? 1250 : p.kind === "peak" ? 12000 : p.kind === "castle" ? 6500 : 10000;
      this.labels.push({ place: p, el, y, range, hidden: false, width: 0 });
    }
  }

  /** Write text only when it changed; the HUD updates every frame. */
  private set(el: HTMLElement | SVGElement, value: string) {
    if (this.text.get(el) === value) return;
    this.text.set(el, value);
    el.textContent = value;
  }

  private renderMap(): HTMLCanvasElement {
    const w = Math.floor((this.meta.width * this.meta.cell_m) / MAP_RES);
    const h = Math.floor((this.meta.height * this.meta.cell_m) / MAP_RES);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    const hs = new Float32Array((w + 1) * (h + 1));
    for (let j = 0; j <= h; j++) {
      for (let i = 0; i <= w; i++) hs[j * (w + 1) + i] = this.hf.height(this.mapX0 + i * MAP_RES, this.mapZ0 + j * MAP_RES, MAP_RES);
    }
    const rgb = [0, 0, 0];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * (w + 1) + i;
        const e = hs[k];
        const dx = hs[k + 1] - e, dz = hs[k + w + 1] - e;
        const slope = Math.hypot(dx, dz) / MAP_RES;
        const x = this.mapX0 + i * MAP_RES, z = this.mapZ0 + j * MAP_RES;
        surfaceColor(e, slope, this.hf.waterAt(x, z) > 0.5, x, z, MAP_RES, rgb, 0);
        // light from the north-west
        const shade = Math.max(0.45, Math.min(1.35, 1 + (-dx - dz) / MAP_RES * 1.6));
        const o = (j * w + i) * 4;
        img.data[o] = rgb[0] * shade;
        img.data[o + 1] = rgb[1] * shade;
        img.data[o + 2] = rgb[2] * shade;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = "rgba(255,80,80,0.9)";
    ctx.lineWidth = 2;
    for (const line of this.world.border) {
      ctx.beginPath();
      line.forEach(([x, z], i) => {
        const px = (x - this.mapX0) / MAP_RES, pz = (z - this.mapZ0) / MAP_RES;
        if (i) ctx.lineTo(px, pz);
        else ctx.moveTo(px, pz);
      });
      ctx.stroke();
    }
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const p of this.world.places) {
      if (!(p.municipality || p.kind === "town")) continue;
      const px = (p.x - this.mapX0) / MAP_RES, pz = (p.z - this.mapZ0) / MAP_RES;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillText(p.name, px + 1, pz + 1);
      ctx.fillStyle = "#fff";
      ctx.fillText(p.name, px, pz);
    }
    return c;
  }

  /** The expanded (M) map: whole country, north up, with Faora's marker. */
  private drawMap(player: Player) {
    const ctx = this.mapCanvas.getContext("2d")!;
    ctx.drawImage(this.mapBase, 0, 0);
    const px = (player.pos.x - this.mapX0) / MAP_RES, pz = (player.pos.z - this.mapZ0) / MAP_RES;
    const cx = Math.max(6, Math.min(this.mapCanvas.width - 6, px)), cz = Math.max(6, Math.min(this.mapCanvas.height - 6, pz));
    ctx.save();
    ctx.translate(cx, cz);
    ctx.rotate(-player.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fillStyle = "#ffb547";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (this.companion) {
      const scale = this.mapCanvas.height / Math.max(1, this.mapCanvas.getBoundingClientRect().height);
      const edge = 8 * scale;
      const fx = THREE.MathUtils.clamp((this.companion.pos.x - this.mapX0) / MAP_RES, edge, this.mapCanvas.width - edge);
      const fz = THREE.MathUtils.clamp((this.companion.pos.z - this.mapZ0) / MAP_RES, edge, this.mapCanvas.height - edge);
      ctx.save();
      ctx.strokeStyle = "#09252c"; ctx.lineWidth = 2 * scale;
      ctx.fillStyle = "#76f4eb";
      const alongside = Math.hypot(fx-cx, fz-cz) < 9*scale;
      ctx.beginPath(); ctx.arc(fx, fz, (alongside ? 7 : 4) * scale, 0, Math.PI * 2);
      if (alongside) ctx.strokeStyle = "#76f4eb"; else ctx.fill();
      ctx.stroke();
      // A leader label keeps her readable even when flying right beside the player.
      const labelX = THREE.MathUtils.clamp(fx + 18 * scale, 38 * scale, this.mapCanvas.width - 38 * scale);
      const labelZ = THREE.MathUtils.clamp(fz - 16 * scale, 14 * scale, this.mapCanvas.height - 14 * scale);
      ctx.strokeStyle = "#76f4eb"; ctx.lineWidth = scale;
      ctx.beginPath(); ctx.moveTo(fx, fz); ctx.lineTo(labelX, labelZ + 3 * scale); ctx.stroke();
      ctx.font = `600 ${11 * scale}px system-ui`; ctx.textAlign = "center";
      ctx.lineWidth = 3 * scale; ctx.strokeStyle = "#09252c";
      ctx.strokeText("Faora", labelX, labelZ); ctx.fillText("Faora", labelX, labelZ);
      ctx.restore();
    }
  }

  /** Circular, heading-up minimap whose range widens with speed. */
  private drawMinimap(player: Player, dt: number) {
    const c = this.minimap;
    const size = c.clientWidth;
    if (!size) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const px = Math.round(size * dpr);
    if (c.width !== px) { c.width = px; c.height = px; }

    const t = Math.min(1, player.speed / MINIMAP_SPEED);
    const target = MINIMAP_NEAR + (MINIMAP_FAR - MINIMAP_NEAR) * Math.sqrt(t);
    // Ease the zoom so speed spikes (boosts, impacts) don't make it pump.
    this.minimapRange += (target - this.minimapRange) * (1 - Math.exp(-dt * 2.5));

    const r = px / 2;
    const scale = r / (this.minimapRange / MAP_RES);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#06121c";
    ctx.fillRect(0, 0, px, px);
    ctx.save();
    ctx.beginPath(); ctx.arc(r, r, r, 0, Math.PI * 2); ctx.clip();
    ctx.translate(r, r);
    ctx.rotate(player.yaw);
    ctx.scale(scale, scale);
    ctx.translate(-(player.pos.x - this.mapX0) / MAP_RES, -(player.pos.z - this.mapZ0) / MAP_RES);
    ctx.drawImage(this.mapBase, 0, 0);
    ctx.restore();

    // North sits on the bezel, turning with the map.
    const a = player.yaw - Math.PI / 2;
    const ring = 118 / 240;
    this.minimapNorth.style.transform =
      `translate(${(0.5 + Math.cos(a) * ring) * 100}%, ${(0.5 + Math.sin(a) * ring) * 100}%) translate(-50%, -50%)`;
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
      this.set($("ui-actions"), prompt.carrying ? "F  Throw  ·  X  Drop" : prompt.inPunchRange ? "LEFT CLICK  Punch  ·  F  Grab" : "F  Grab");
    }
    this.el.prompt.setAttribute("display", prompt ? "inline" : "none");
    if (!prompt) return;
    this.set(this.el.promptName, prompt.name);
    this.el.promptAim.setAttribute("display", prompt.carrying ? "none" : "inline");
    $("hud-prompt-punch").setAttribute("display", prompt.inPunchRange ? "inline" : "none");
    this.el.promptHold.setAttribute("display", prompt.carrying ? "inline" : "none");
  }

  /** Track each active fighter even when they're outside the view or behind terrain. */
  updateFighterMarkers(camera: THREE.PerspectiveCamera, visible?: (fighter: Faora) => boolean) {
    camera.updateMatrixWorld();
    for (const [id, fighter] of [["marker-faora", this.companion], ["marker-anissa", this.opponent], ["marker-beast", this.beast],["marker-doomsday",this.doomsday], ["marker-sukuna", this.sukuna], ["marker-gojo", this.gojo]] as const) {
      const marker = $(id);
      marker.hidden = !fighter || (visible !== undefined && !visible(fighter));
      if (marker.hidden || !fighter) continue;
      this.set(marker.querySelector(".marker-text b")!, `${fighter.name.toUpperCase()}${this.persistenceMode && !fighter.enemyMode && fighter.vitals.defeated?" · RETURNING":fighter.vitals.downed?` · DOWN · ${fighter.vitals.revivesRemaining} LEFT`:fighter.vitals.eliminated?" · OUT":fighter.rescueTarget?" · REVIVING":""}`);
      if (fighter.ragdoll.active) this.markerPoint.copy(fighter.ragdoll.joints[2]).y += .35;
      else this.markerPoint.copy(fighter.pos).y += 2.25 * fighter.bodyScale;
      const screen = projectMarker(camera, this.markerPoint, innerWidth, innerHeight);
      marker.style.transform = `translate(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px) translate(-50%, -50%)`;
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

  private updateCore(player: Player) {
    const spd = player.speed;
    const flying = player.flying;
    const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

    // Heading: forward is (-sin yaw, -cos yaw), with -z as north.
    const heading = ((-player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    this.set(this.el.heading, `${String(Math.round(heading) % 360).padStart(3, "0")}°`);
    // The tape shows ±60° of heading across ±20° of arc.
    for (const c of this.cardinals) {
      const diff = ((c.deg - heading + 540) % 360) - 180;
      if (Math.abs(diff) > 60) { c.el.setAttribute("display", "none"); continue; }
      const a = (-90 + diff / 3) * Math.PI / 180;
      c.el.setAttribute("display", "inline");
      c.el.setAttribute("x", (Math.cos(a) * 306).toFixed(1));
      c.el.setAttribute("y", (Math.sin(a) * 306 + 5).toFixed(1));
    }

    const mach = spd / soundSpeed(player.pos.y);
    this.set(this.el.speed, fmt(spd * 3.6));
    this.set(this.el.mach, mach >= 0.3 ? `M${mach.toFixed(2)}` : "");
    this.el.mach.classList.toggle("hud-amber", mach >= 1);
    this.el.speedFill.classList.toggle("hud-amber", mach >= 1);
    const speedFrac = Math.min(1, spd / (flying ? player.flySpeed : FOOT_SPEED_SCALE));
    this.el.speedFill.setAttribute("stroke-dasharray", `${(speedFrac * ARC).toFixed(1)} 400`);

    const agl = Math.max(0, player.altitudeAGL);
    this.set(this.el.agl, fmt(agl));
    this.set(this.el.msl, fmt(player.pos.y));

    if (flying) {
      this.set(this.el.cap, fmt(player.flySpeed * 3.6));
      this.el.boost.setAttribute("stroke-dasharray", `${(Math.max(0, Math.min(1, player.boostReady)) * 251).toFixed(1)} 251`);
      const warn = agl < GROUND_WARN;
      this.el.groundWarn.setAttribute("display", warn ? "inline" : "none");
      if (warn) this.set(this.el.aglWarn, fmt(agl));
      // The caret rides the right arc on a log scale: 0 m at the bottom, 5 km at the top.
      const frac = Math.min(1, Math.log10(1 + agl) / Math.log10(5001));
      this.el.altCaret.setAttribute("transform", `rotate(${(30 - frac * 60).toFixed(1)})`);
      this.el.rightLine.classList.toggle("hud-amber", warn);
      this.el.rightTicks.classList.toggle("hud-amber", warn);
    } else {
      // The readout climbs with the Space charge toward the height a release would reach.
      const jump = player.chargedHeight;
      this.set(this.el.jump, `${jump < 10 ? jump.toFixed(1) : Math.round(jump)}`);
      const jumpFrac = Math.log(jump / JUMP_MIN) / Math.log(JUMP_MAX / JUMP_MIN);
      this.el.jumpFill.setAttribute("stroke-dasharray", `${(Math.max(0, Math.min(1, jumpFrac)) * ARC).toFixed(1)} 400`);
      this.set(this.el.surface, player.material.name.charAt(0).toUpperCase() + player.material.name.slice(1));
      this.el.rightLine.classList.remove("hud-amber");
      this.el.rightTicks.classList.remove("hud-amber");
    }
  }

  update(player: Player, camera: THREE.PerspectiveCamera, dt: number) {
    const spd = player.speed;
    const mach = spd / soundSpeed(player.pos.y);
    const formatHealth = ({ health, frozen }: Player["vitals"]) => `${frozen ? Number(health.toFixed(2)) : Math.ceil(health)}`;
    this.set($("ui-health"), formatHealth(player.vitals));
    $("ui-health-fill").style.transform = `scaleX(${player.vitals.healthFraction})`;
    this.set($("ui-revives"),this.persistenceMode?(player.vitals.defeated?"RETURNING · 75 HP":"PERSISTENCE MODE"):player.vitals.eliminated?"DEFEATED":player.vitals.downed?`DOWN · ${player.vitals.revivesRemaining} REVIVES LEFT`:player.vitals.revivesRemaining?`${player.vitals.revivesRemaining} REVIVES LEFT`:"FINAL LIFE");
    for (const [id, fighter] of [["ui-foe-faora", this.companion], ["ui-foe-anissa", this.opponent], ["ui-foe-beast", this.beast],["ui-foe-doomsday",this.doomsday], ["ui-foe-sukuna", this.sukuna], ["ui-foe-gojo", this.gojo]] as const) {
      const bar = $(id), locked = !!fighter && fighter === this.lockedTarget;
      const friend = !!fighter && !fighter.enemyMode;
      bar.hidden = !fighter || (!friend && (fighter.vitals.eliminated || (!fighter.vitals.downed && !(fighter.hostile || locked))));
      if (bar.hidden || !fighter) continue;
      bar.classList.toggle("friend", friend);
      bar.classList.toggle("foe", !friend);
      this.set(bar.querySelector("span")!, fighter.name.toUpperCase());
      this.set(bar.querySelector("small")!,this.persistenceMode && !fighter.enemyMode?`AUTO RETURN · ${fighter.vitals.maxHealth * .75} HP`:fighter.vitals.eliminated?"DEFEATED":fighter.vitals.revivesRemaining?`${fighter.vitals.revivesRemaining} REVIVES LEFT`:"FINAL LIFE");
      bar.classList.toggle("downed",fighter.vitals.defeated && (fighter.vitals.downed || this.persistenceMode && !fighter.enemyMode));
      bar.classList.toggle("locked", locked);
      this.set(bar.querySelector("b")!, this.persistenceMode && !fighter.enemyMode && fighter.vitals.defeated?"DOWN":fighter.vitals.downed?"DOWN":fighter.vitals.eliminated?"OUT":formatHealth(fighter.vitals));
      bar.querySelector<HTMLElement>(".vital-track i")!.style.transform = `scaleX(${fighter.vitals.healthFraction})`;
      const ceBar = bar.querySelector<HTMLElement>(".vital-ce");
      const energy = fighter.cursedEnergy;
      if (ceBar && energy) {
        const reserve = energy.reserveFraction;
        const value = String(Math.round(reserve * 100));
        const label = energy.burnedOut ? "CE LOCKED" : "CE";
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
      this.el.moveGuide.innerHTML = player.flying
        ? '<kbd>Space</kbd> Rise <span>·</span> <kbd>C</kbd> Descend<br><kbd>Shift</kbd> Boost (unavailable at Mach 2.5 or above) <span>·</span> <kbd>1–6</kbd> Speed presets<br><kbd>W + A / D</kbd> Turn <span>·</span> <kbd>A / D</kbd> Strafe without W<br><kbd>W / S</kbd> Thrust<br><kbd>Arrow keys</kbd> Turn &amp; pitch<br>Speed builds gradually. Fast turns are wider.<br><kbd>E</kbd> Stop flying; momentum carries you onward.'
        : '<kbd>Space</kbd> Hold to charge (up to 1800 m), release to jump <span>·</span> <kbd>Shift</kbd> Run<br><kbd>Shift</kbd> taps while charging: charge faster<br><kbd>Left click</kbd> Charge punch <span>·</span> <kbd>Right click</kbd> Charge guard <span>·</span> <kbd>Shift</kbd> Charge faster<br><kbd>C</kbd> Toggle crouch <span>·</span> in the air: ground pound<br>Punch while moving fast for extra power<br><kbd>E</kbd> Take flight and explore from above.';
    }
    if (!this.hidden) this.updateCore(player);

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

    if (!this.hidden) this.drawMinimap(player, dt);
    if (this.bigMap) this.drawMap(player);
  }

  updateNavigation(player: Player, camera: THREE.PerspectiveCamera, playing: boolean) {
    if (!this.labels.length) return;
    this.labelsEl.hidden = !playing || this.bigMap || player.underwater;
    if (this.labelsEl.hidden) return;
    const w = innerWidth, h = innerHeight;
    const airborne = player.flying || player.altitudeAGL > 60;
    const candidates: { label: Label; x: number; y: number; score: number; opacity: number }[] = [];
    for (let i = 0; i < 12 && this.labels.length; i++) {
      const l = this.labels[this.occlusionCursor++ % this.labels.length];
      l.hidden = this.occluded(camera.position, l.place.x, l.y, l.place.z);
    }
    for (const label of this.labels) {
      const { place, y, hidden } = label;
      const landmark = place.kind === "landmark", peak = place.kind === "peak";
      if (hidden || (!airborne && !landmark)) continue;
      const point = this.v.set(place.x, y, place.z);
      const distance = point.distanceTo(camera.position);
      const range = label.range * (airborne ? 1 + THREE.MathUtils.clamp((camera.position.y - 1500) / 3500, 0, .75) : .22);
      if (distance > range || distance < 6) continue;
      point.project(camera);
      if (point.z < -1 || point.z > 1 || Math.abs(point.x) >= 1 || Math.abs(point.y) >= 1) continue;
      const x = (point.x + 1) * w * .5, screenY = (1 - point.y) * h * .5;
      const priority = landmark || place.kind === "castle" ? 3 : peak ? 0 : 1.5;
      const opacity = THREE.MathUtils.smoothstep(1 - distance / range, 0, .4) * (peak ? .73 : .94);
      if (opacity < .08) continue;
      if (label.width === 0) label.width = label.el.offsetWidth;
      candidates.push({ label, x, y: screenY, score: priority - distance / range + (label.el.classList.contains("visible") ? .075 : 0), opacity });
    }

    const blocked: LabelBounds[] = [
      { left: w / 2 - 60, right: w / 2 + 60, top: h / 2 - 35, bottom: h / 2 + 42 },
    ];
    for (const selector of ["#ui-vitals", "#hit-feed", "#target-view", ".fighter-marker.locked", ".flight-heading", ".flight-speed", ".flight-altitude"]) {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      if (box?.width && box.height) blocked.push(box);
    }
    const shown = new Set<Label>();
    let peaks = 0;
    candidates.sort((a, b) => b.score - a.score);
    for (const { label, x, y, opacity } of candidates) {
      const peak = label.place.kind === "peak";
      if (shown.size >= (w < 740 ? 5 : 8) || (peak && peaks >= (w < 740 ? 2 : 4))) continue;
      const bounds = { left: x - label.width / 2, right: x + label.width / 2, top: y - 17, bottom: y };
      if (bounds.left < 16 || bounds.right > w - 16 || bounds.top < 18 || bounds.bottom > h - 24
        || blocked.some(other => intersects(bounds, other, 10))) continue;
      shown.add(label);
      blocked.push(bounds);
      if (peak) peaks++;
      label.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      label.el.style.setProperty("--label-opacity", opacity.toFixed(2));
    }
    for (const label of this.labels) label.el.classList.toggle("visible", shown.has(label));
  }
}
