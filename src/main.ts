import { FUGA_SLASHES, SukunaPowers, fugaPower } from "./sukuna";
import { GOJO_HITS, GojoPowers } from "./gojo";
import { CLASH_BURNOUT_SCALE, CURSED_COST } from "./cursed-energy";
import { AnissaGrab } from "./anissa-grab";
import {KickView} from "./kick";
import { MomentumWaves, momentumContact } from "./momentum";
import { HitFeed } from "./hit-feed";
import { playerHit, type HitAction, type HitSource, type DamageHit, type HitTeam } from "./combat-events";
import * as THREE from "three";
import { loadWorld } from "./terrain/data";
import { Heightfield } from "./terrain/heightfield";
import { TerrainLOD } from "./terrain/lod";
import { TreeLayers } from "./trees";
import { Player } from "./player";
import { Atmosphere } from "./atmosphere";
import { Hud } from "./hud";
import { Sound, type Voice } from "./audio";
import { setupVolumeControls } from "./volume-controls";
import { SpeedEffects } from "./effects";
import { MachCollar, SonicFlyby } from "./air-pressure";
import { Destruction, smashCone } from "./destruction";
import { Faora, type CombatTarget } from "./faora";
import { Interactions } from "./interactions";
import { Scenery } from "./scenery";
import { ANISSA_RAM_DAMAGE_MULTIPLIER, Combat, MELEE_CHARGE_THRESHOLD, RAM_BLOCK_DAMAGE, RAM_TRANSFER, ramStrength } from "./combat";
import { FollowUp, nearestEnemy, pursuitBlockReason } from "./follow-up";
import { Pathfinder } from "./pathing";
import { DamageEffects } from "./damage-effects";
import { STAGGER_LIMIT, STAGGER_PUSH, launchSpeed } from "./vitality";
import { FistView } from "./fist";
import { createFighterEnvironment, setFighterEnvironment } from "./fighter-mesh";
import { TargetView } from "./target-view";
import { setupRoster } from "./roster";
import { LaserVision } from "./laser-vision";
import { RevivalSystem, SelfRevive, PersistenceMode, type RescueUnit } from "./revival";
import { friendOpponent,doomsdayAwareness } from "./targeting";
import {DoomsdayPowers} from "./doomsday";
import { PerformanceTracker } from "./performance-tracker";
import {DOOMSDAY_BEAM_DAMAGE_SCALE,DOOMSDAY_BEAM_IMPULSE,limitBeamPush} from "./beam-impact";
import "./style.css";

const HORIZON = new THREE.Color("#bcd4e8");

async function main() {
  const sound = new Sound();
  setupVolumeControls(sound);
  const status = document.getElementById("status")!;
  // Manhattan maps are parked for now; their loaders stay in place for later.
  const map = "vaduz" as "vaduz" | "manhattan" | "manhattan-island";
  status.textContent = "Loading terrain…";
  const world = await loadWorld(map);
  status.textContent = "Building the world…";
  const scenery = await Scenery.create(world.terrain, map);
  const hf = new Heightfield(world.terrain);

  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  setFighterEnvironment(createFighterEnvironment(renderer));
  const nativeRatio = Math.min(devicePixelRatio, 1.5);
  const renderScales = [1, 1, .86, .74, .65];
  let renderScaleIndex = 0;
  let resolutionTime = 0, resolutionFrames = 0, recoveryTime = 0;
  renderer.setPixelRatio(nativeRatio);
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const damageEffects = new DamageEffects(scene);
  scene.background = HORIZON;
  const fog = new THREE.FogExp2(HORIZON.getHex(), 3e-5);
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 250000);
  scene.add(camera); // so the first-person fist, a camera child, renders
  const fist = new FistView(camera);
  const leftFist = new FistView(camera,-1);
  const kickView=new KickView(camera);
  // Hitstop freezes the world for a beat on contact; the biggest hits follow it with a moment of slow motion.
  let hitstop = 0, slowmo = 0;
  const hitPause = (freeze: number, slow = 0) => {
    hitstop = Math.max(hitstop, freeze);
    slowmo = Math.max(slowmo, slow);
    if (freeze >= .10) fx.flashImpact(THREE.MathUtils.smoothstep(freeze, .085, .18));
  };

  const sun = new THREE.DirectionalLight(0xffe6c8, 2.75);
  const sunDirection = new THREE.Vector3(-0.55, 0.62, 0.55).normalize();
  sun.position.copy(sunDirection).multiplyScalar(115);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -56, right: 56, bottom: -56, top: 56, near: 1, far: 230 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.normalBias = .085;
  sun.shadow.bias = -.0003;
  sun.shadow.radius = 2.5;
  sun.shadow.intensity = 0;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xc6ddff, 0x6c6251, 1.26));
  const atmosphere = new Atmosphere(scene, sunDirection, (x, z) => hf.height(x, z, 80));

  const fx = new SpeedEffects(renderer, scene, camera, atmosphere);
  // underground your eyes adjust: a soft light around you, only when there's rock overhead
  const eyes = new THREE.PointLight(0xffe2c0, 0, 40, 1.2);
  scene.add(eyes);
  const terrain = new TerrainLOD(world.terrain, hf);
  scene.add(terrain.group);
  const trees = new TreeLayers(renderer, hf.authored.models, hf.authored.instances);
  scene.add(trees.group);

  const destruction = new Destruction(hf, terrain, scene);
  destruction.healing = false;
  atmosphere.terrain.setSampler((x, z) => destruction.spans(x, z).top);
  const player = new Player(hf, renderer.domElement);
  player.ground = destruction;
  player.spawn(0, 0, -Math.PI / 2);
  const hud = new Hud(world, hf, world.terrain.inner.meta, scenery.landmarks);
  const faora = new Faora(destruction, scene);
  faora.model.visible = faora.trails.mesh.visible = false;
  const anissa = new Faora(destruction, scene, "Anissa");
  anissa.model.visible = false;
  anissa.trails.mesh.visible = false;
  let faoraActive = false;
  let anissaActive = false;
  const beast = new Faora(destruction, scene, "Battle Beast");
  beast.model.visible = false; beast.trails.mesh.visible = false;
  let beastActive = false;
  const doomsday=new Faora(destruction,scene,"Doomsday");
  doomsday.model.visible=false;doomsday.trails.mesh.visible=false;doomsday.setEnemyMode(true);
  let doomsdayActive=false;
  const doomsdayPowers=new DoomsdayPowers(scene);
  const sukuna = new Faora(destruction, scene, "Sukuna");
  sukuna.model.visible = sukuna.trails.mesh.visible = false;
  sukuna.setEnemyMode(true);
  let sukunaActive = false;
  const sukunaPowers = new SukunaPowers(scene);
  const gojo = new Faora(destruction, scene, "Satoru Gojo");
  gojo.model.visible = gojo.trails.mesh.visible = false;
  let gojoActive = false;
  const gojoPowers = new GojoPowers(scene);
  const combatLight = new THREE.PointLight(0xffa769, 0, 0, 2);
  scene.add(combatLight);
  /** The outward blast wave of a Doomsday nova or a charged Fuga; owner is whoever set it off. */
  let novaWake: { origin: THREE.Vector3; radius: number; age: number; hostile: boolean; enemyTeam: boolean; cover: Map<object,number>; owner: Faora } | null = null;
  const activeFighters = () => roster.filter(isDeployed);
  const roster = [faora, anissa, beast, doomsday, sukuna, gojo];
  let observerMode = false;
  const playerCombatTarget = () => observerMode ? null : player;
  const combatTargetFor = (fighter: Faora) => fighter.opponent?.asTarget ?? playerCombatTarget();
  for (const fighter of roster) {
    fighter.canTargetPlayer = () => !observerMode;
    fighter.domainWall = (from, to) => gojoPowers.voidWall(from, to);
  }
  const shadowBody = (body: THREE.Object3D) => body.traverse(object => {
    if (object instanceof THREE.Mesh && [object.material].flat().every(material => !material.transparent && material.depthWrite)) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  for (const fighter of roster) shadowBody(fighter.model);
  const collars = roster.map(fighter => {
    const collar = new MachCollar();
    scene.add(collar.mesh);
    return { fighter, collar, flyby: new SonicFlyby() };
  });
  const cloudDensityAt = (point: THREE.Vector3) => atmosphere.densityAt(point);
  const hearFlyby = (origin: THREE.Vector3) => sound.sonicBoom(origin,true);
  const listenerEye = new THREE.Vector3();
  // Sides come from the roster: foes fight you and your friends, friends fight foes.
  // (A friend you provoke fights you instead, until she's even.)
  const enemies = (a: Faora, b: Faora) => a !== b && a.model.visible && b.model.visible && a.enemyMode !== b.enemyMode;
  const interactions = await Interactions.create(destruction, scene, faora);
  destruction.onTerrainChange = (x0, z0, x1, z1) => {
    atmosphere.terrain.invalidate(x0, z0, x1, z1);
    trees.fell(x0, z0, x1, z1, (x, y, z) => destruction.spans(x, z).solid(y));
  };
  faora.interactions = interactions;
  anissa.interactions = interactions;
  beast.interactions = interactions;
  doomsday.interactions=interactions;
  const spawn = scenery.findClearPoint(hf, 0, 0, 6);
  player.spawn(spawn.x, spawn.z, -Math.PI / 2);
  interactions.props.forEach((prop, i) => {
    shadowBody(prop.mesh);
    const p = scenery.findClearPoint(hf, spawn.x + 15 + i * 17, spawn.z + (i % 2 ? -14 : 12), prop.radius + 2);
    prop.body.setTranslation({ x: p.x, y: p.y + prop.size.y / 2 + 0.2, z: p.z }, true);
    prop.body.setLinvel({ x: 0, y: 0, z: 0 }, true); prop.sync();
  });
  player.carryingObject = () => interactions.carrying !== null;
  const cloudBodyCenter = new THREE.Vector3();
  atmosphere.bodySource = visit => {
    cloudBodyCenter.copy(player.pos).y += 0.9;
    visit(player, cloudBodyCenter, player.vel, 0.9);
    if (faoraActive) {
      cloudBodyCenter.copy(faora.pos).y += 0.95;
      visit(faora, cloudBodyCenter, faora.vel, 0.95);
      if (faora.ragdoll.active) {
        faora.ragdoll.joints.forEach((joint, i) => visit(joint, joint, faora.ragdoll.velocity[i], i < 3 ? 0.22 : 0.12));
      }
    }
    if (anissaActive) {
      cloudBodyCenter.copy(anissa.pos).y += .95;
      visit(anissa, cloudBodyCenter, anissa.vel, .95);
      if (anissa.ragdoll.active) anissa.ragdoll.joints.forEach((joint, i) => visit(joint, joint, anissa.ragdoll.velocity[i], i < 3 ? .22 : .12));
    }
    if (beastActive) {
      cloudBodyCenter.copy(beast.pos).y += 1.5;
      visit(beast, cloudBodyCenter, beast.vel, 1.5);
    }
    if (sukunaActive) { cloudBodyCenter.copy(sukuna.pos).y += .95; visit(sukuna, cloudBodyCenter, sukuna.vel, .95); }
    if (gojoActive) { cloudBodyCenter.copy(gojo.pos).y += .95; visit(gojo, cloudBodyCenter, gojo.vel, .95); }
    if(doomsdayActive){cloudBodyCenter.copy(doomsday.pos).y+=2;visit(doomsday,cloudBodyCenter,doomsday.vel,2);}
    for (const prop of interactions.props) visit(prop, prop.pos, prop.vel, prop.radius);
    destruction.debris.forEachCloudBody(visit);
  };
  let encounterStarted = false;
  const combat = new Combat();
  const revivals=new RevivalSystem(),selfRevive=new SelfRevive(),persistence=new PersistenceMode();
  try{
    persistence.setEnabled(localStorage.getItem("power.persistence")==="true");
    persistence.setFoes(localStorage.getItem("power.persistence.foes")==="true");
  }catch{}
  hud.persists=enemy=>persistence.covers(enemy);
  const hitFeed=new HitFeed(document.getElementById("hit-feed")!);
  const sourceFor=(fighter:Faora,action:HitAction):HitSource=>({name:fighter.name,team:fighter.enemyMode?"foe":"friend",action});
  const anissaGrab = new AnissaGrab(anissa,player,action=>sourceFor(anissa,action));
  const logHit=(hit:DamageHit,name:string,team:HitTeam)=>hitFeed.add({...hit,victim:{name,team},outcome:hit.outcome==="out" && persistence.covers(team==="foe")?"down":hit.outcome});
  let faoraInterrupter: Faora | Player | null = null;
  let faoraCounterTime = 0;
  const finishRescueCounter = (hit: DamageHit, victim: Faora | Player) => {
    if (faoraInterrupter === victim && hit.source.name === faora.name && hit.damage > 0
      && (hit.source.action === "smash" || hit.source.action === "uppercut" || hit.source.action === "slam")) {
      victim.vitals.orientation = Math.min(victim.vitals.orientation, 34);
      faoraInterrupter = null;
    }
  };
  player.onCombatHit = hit => {
    logHit(hit, "YOU", "player");
    finishRescueCounter(hit, player);
  };
  for (const fighter of roster) fighter.onCombatHit = hit => {
    logHit(hit, fighter.name, fighter.enemyMode ? "foe" : "friend");
    finishRescueCounter(hit, fighter);
    if (fighter !== faora || (!faora.rescueTarget && !faoraInterrupter) || hit.damage <= 0) return;
    const attacker = hit.source.team === "player"
      ? player
      : roster.find(other => other.name === hit.source.name && enemies(faora, other));
    if (!attacker || attacker.vitals.defeated || (observerMode && attacker === player)) return;
    faoraInterrupter = attacker;
    faoraCounterTime = 8;
  };

  let holdingAid=false;
  const pathfinder = new Pathfinder(destruction);
  const followUp = new FollowUp(pathfinder);
  const momentumWaves=new MomentumWaves(scene);
  momentumWaves.rings.onSweep=(origin,normal,previous,radius,strength)=>atmosphere.shockwave(origin,normal,previous,radius,strength);
  const haltMomentum=()=>{
    const velocity=player.cancelMomentum();
    if(!velocity)return false;
    const origin=player.pos.clone().add(new THREE.Vector3(0,1,0));
    const wave=momentumWaves.spawn(origin,velocity);
    if(wave){
      destruction.debris.gust(origin,wave.direction,{length:wave.power.range,r0:2,spread:(wave.power.radius-2)/wave.power.range},wave.power.impulse);
      sound.launch(.2+wave.power.energy*.8);
      if(velocity.length()>150)sound.sonicBoom(origin);
      hud.shake=Math.max(hud.shake,.08+wave.power.energy*.35);
    }
    return true;
  };
  const ramWave = (origin:THREE.Vector3, direction:THREE.Vector3, speed:number, source:HitSource, exempt:readonly object[]) => {
    damageEffects.fx.ram(origin,direction,speed);
    const wave=momentumWaves.spawn(origin,direction.clone().multiplyScalar(speed),source,exempt);
    if(wave){
      destruction.debris.gust(origin,direction,{length:wave.power.range,r0:2,spread:(wave.power.radius-2)/wave.power.range},wave.power.impulse);
      sound.impact(speed,"hard",origin);
    }
  };
  momentumWaves.onSweep=(wave,previous,next)=>{
    const contact=(position:THREE.Vector3,size:number)=>{
      const force=momentumContact(wave,position,size,previous,next);
      return force*(force>0 && !faora.lineClear(wave.origin,position) ? .15 : 1);
    };
    const source=wave.source ?? playerHit("shockwave");
    for(const fighter of activeFighters()){
      if(wave.hit.has(fighter) || fighter.vitals.defeated || fighter.vitals.frozen || fighter.held)continue;
      const center=fighter.pos.clone().add(new THREE.Vector3(0,fighter.bodyScale,0));
      const force=contact(center,fighter.bodyScale);if(force<=0)continue;
      wave.hit.add(fighter);
      fighter.strike(wave.direction,zero,wave.power.impulse*force,source.team==="player",wave.power.strength*force,1,source);
    }
    for(const prop of interactions.props){
      if(wave.hit.has(prop) || prop.held)continue;
      const force=contact(prop.pos,prop.radius);if(force<=0)continue;
      wave.hit.add(prop);prop.playerAttackTime=8;prop.attackSource=source;
      prop.body.applyImpulse(wave.direction.clone().multiplyScalar(prop.mass*wave.power.impulse*force),true);
    }
  };

  let lockedTarget: Faora | null = null;
  let pursuitHeld = false, pursuitHeldTime = 0, pursuitSuppressed = false;
  const checkRam = (from: THREE.Vector3) => followUp.sweep(player,from);
  followUp.onRam = (target,direction,speed) => {
    pursuitSuppressed = pursuitHeld;
    const power=Math.min(1.4,.35+speed/220);
    fist.strike(power);
    leftFist.strike(power);
    const impact=player.pos.clone().add(new THREE.Vector3(0,.9,0));
    ramWave(impact,direction,speed,playerHit("shockwave"),[target]);
    target.strike(direction,zero,speed,true,ramStrength(speed),1,playerHit("ram"));
    hud.shake=Math.max(hud.shake,Math.min(1,speed/150));
    if(speed>=40)hitPause(Math.min(.1,speed/1600));
  };
  let pursuitNotice="";
  let pursuitPressedAt = 0, pursuitStartedLocked: Faora | null = null;
  const overlay = document.getElementById("overlay")!;
  const pauseActions = document.getElementById("pause-actions")!;
  const menuRevivePlayer = document.getElementById("revive-player") as HTMLButtonElement;
  const retryPlayer = document.getElementById("retry-player") as HTMLButtonElement;
  let refreshRoster = () => {};
  const refreshRecovery = () => {
    refreshRoster();
    retryPlayer.hidden = !player.vitals.eliminated || persistence.enabled;
    menuRevivePlayer.disabled = player.vitals.health >= player.vitals.maxHealth;
    menuRevivePlayer.textContent = player.vitals.defeated ? "Revive" : "Heal to full";
    pauseActions.hidden = false;
  };
  let guardFeedback = 0;
  const guardResult = document.getElementById("ui-guard-result")!;
  const defend = (strength: number, fighterAttack = true) => {
    if((observerMode && fighterAttack) || player.superBlock.active || player.vitals.inReviveGrace)return 0;
    const guarding = combat.mode === "guard";
    const remaining = combat.defend(strength);
    if (guarding) {
      guardResult.textContent = remaining === 0 ? "BLOCKED" : "GUARD BROKEN";
      guardFeedback = .8;
      sound.block(remaining === 0);
    }
    return remaining;
  };

  interactions.onImpact = (speed, point) => { sound.impact(speed, "hard", point); };
  interactions.onIncomingAttack = (strength, source) => {
    const remaining = defend(strength, source.team === "foe" || source.team === "friend");
    if (remaining > 0) player.receiveHit(strength * remaining,1,source);
    return remaining;
  };
  interactions.onPlayerCollision = speed => player.receiveHit(speed * .35);
  const waveOffset = new THREE.Vector3(), waveDirection = new THREE.Vector3();
  destruction.onShockwave = (origin, normal, previous, radius, strength, hit) => {
    atmosphere.shockwave(origin, normal, previous, radius, strength);
    const impulseAt = (position: THREE.Vector3, size: number): number => {
      waveOffset.subVectors(position, origin);
      const axial = waveOffset.dot(normal);
      if (Math.abs(axial) > Math.max(3, strength * .7) + size) return 0;
      waveDirection.copy(waveOffset).addScaledVector(normal, -axial);
      const distance = waveDirection.length();
      if (distance < .01 || distance - size > radius || (previous > 0 && distance + size < previous)) return 0;
      waveDirection.multiplyScalar(1 / distance);
      return Math.min(14, 3 + strength * .4) / (1 + distance / Math.max(5, strength * 1.2)) ** 2;
    };
    for (const prop of interactions.props) {
      if (hit.has(prop) || prop.held) continue;
      const speed = impulseAt(prop.pos, prop.radius);
      if (!speed) continue;
      hit.add(prop);
      prop.body.applyImpulse({ x: waveDirection.x * prop.mass * speed, y: (waveDirection.y + .2) * prop.mass * speed, z: waveDirection.z * prop.mass * speed }, true);
    }
    for (const fighter of activeFighters()) {
      if (hit.has(fighter) || fighter.vitals.defeated || fighter.vitals.frozen || fighter.vitals.inReviveGrace || interactions.carrying === fighter) continue;
      const speed = impulseAt(fighter.pos, 1);
      if (speed) {
        hit.add(fighter);
        if (speed >= 8) fighter.strike(waveDirection, fighter.vel.clone(), speed, false, speed * .25,1,{name:"Shockwave",team:"world",action:"shockwave"});
        else if (!fighter.superBlocking && !fighter.infinityProtects && !fighter.dodgeIncoming(waveDirection)) fighter.vel.addScaledVector(waveDirection, speed * .35);
      }
    }
  };
  let impactPitch = 0, impactRoll = 0, launchKick = 0;
  // Same rule as the fighters: below the stagger limit you keep your feet (a shove, a flinch, a broken wind-up).
  const knockPlayer = (direction: THREE.Vector3, impulse: number, through: number) => {
    if(player.superBlock.active || player.vitals.inReviveGrace || player.vitals.frozen)return;
    const launch = launchSpeed(impulse, through);
    if (launch > 0) { player.vel.addScaledVector(direction, launch); return; }
    player.vel.addScaledVector(direction, Math.min(impulse, STAGGER_PUSH));
    if (through < 1) return;
    impactPitch = Math.max(impactPitch, .05);
    hud.shake = Math.max(hud.shake, .35);
    if (combat.mode === "attack") { combat.cancel(); player.combatCharging = false; player.combatAttacking = false; player.combatAttackCharge = 0; }
  };
  const cursedContactPoint = new THREE.Vector3();
  const resolveCursedMelee = (fighter: Faora, target: CombatTarget, direction: THREE.Vector3, action: HitAction,
    strength: number, multiplier: number, impulse: number, empowered: boolean) => {
    if (target.vitals.defeated || target.vitals.frozen || target.vitals.inReviveGrace) return false;
    const energy = fighter.cursedEnergy!;
    const flash = empowered && energy.rollsBlackFlash();
    const source = sourceFor(fighter, flash ? "black-flash" : action);
    const damage = multiplier * (flash ? 2.5 : 1);
    const force = action === "blue-melee" ? 0 : flash ? Math.max(195, impulse * 1.3) : impulse;
    const revision = target.vitals.damageRevision;
    if (target === player) {
      if (!fighter.hostile) return false;
      const remaining = defend(strength);
      if (remaining <= 0) return false;
      player.receiveHit(strength * remaining, damage, source);
      if (force && revision !== target.vitals.damageRevision) knockPlayer(direction, force * remaining, strength * remaining);
    } else {
      const victim = roster.find(other => other.asTarget === target);
      if (!victim || !enemies(fighter, victim)) return false;
      victim.strike(direction, zero, force, false, strength, damage, source);
    }
    if (revision === target.vitals.damageRevision) return false;
    if (flash) {
      energy.landedBlackFlash();
      cursedContactPoint.copy(target.pos).y += 1;
      if (fighter === gojo) gojoPowers.showBlackFlash(cursedContactPoint);
      else sukunaPowers.showBlackFlash(cursedContactPoint);
      if (fighter === gojo) sound.gojo("black-flash", cursedContactPoint);
      else sound.sukuna("black-flash", cursedContactPoint);
      if (cursedContactPoint.distanceToSquared(player.pos) < 45 ** 2) {
        fx.flashImpact(.7);
        hud.shake = Math.max(hud.shake, .55);
      }
    }
    return true;
  };
  anissa.onGrab = target => {
    const captive = target === player ? (anissa.hostile ? playerCombatTarget() : null)
      : roster.find(fighter=>fighter.asTarget===target && enemies(anissa,fighter));
    if (!captive || (captive === player && combat.mode === "guard") || !anissaGrab.start(captive)) return false;
    if (captive === player) {
      interactions.drop();
      combat.cancel();player.combatCharging=player.combatAttacking=false;
      lockedTarget = null;
      followUp.cancel();pursuitSuppressed=pursuitHeld;
      holdingAid=false;
    }
    return true;
  };
  anissa.onRam=(target,direction,speed)=>{
    const victim=roster.find(other=>other.asTarget===target);
    const excluded=roster.filter(other=>other===victim || !enemies(anissa,other));
    const impact=anissa.pos.clone().add(new THREE.Vector3(0,.9,0));
    ramWave(impact,direction,speed,sourceFor(anissa,"shockwave"),excluded);
    if(victim && enemies(anissa,victim)){
      victim.strike(direction,zero,speed,false,ramStrength(speed),ANISSA_RAM_DAMAGE_MULTIPLIER,sourceFor(anissa,"ram"));
    }else if(target===player && anissa.hostile && !player.vitals.defeated){
      const strength=ramStrength(speed),guardScale=combat.mode==="guard" ? RAM_BLOCK_DAMAGE : 1;
      const remaining=defend(strength);
      if(remaining>0){
        player.receiveHit(strength*remaining*guardScale,guardScale*ANISSA_RAM_DAMAGE_MULTIPLIER,sourceFor(anissa,"ram"));
        player.vel.addScaledVector(direction,speed*RAM_TRANSFER*remaining*guardScale);
        hud.shake=Math.max(hud.shake,.65*remaining*guardScale);
        hitPause(Math.min(.1,speed/1600)*guardScale);
      }
    }
  };
  const escapeIcon = document.getElementById("grab-escape")!;
  const superBlockPanel=document.getElementById("super-block-status")!;
  const activateSuperBlock=()=>{
    if(!player.superBlock.activate(combat.mode==="guard",!player.vitals.defeated))return false;
    sound.block(true);
    return true;
  };
  let impactDamageCooldown = 0;
  player.onImpact = (i) => {
    // landings get a hitstop beat (not flight, which grinds through terrain every frame); a ground pound never hurts you
    if (i.speed > 40 && !i.flying && impactDamageCooldown <= 0) hitPause(Math.min(0.12, i.speed / 1200), player.pounding && i.speed > 150 ? 0.4 : 0);
    if (i.speed >= 12 && impactDamageCooldown <= 0 && !player.pounding) {
      player.receiveHit(i.speed * .35);
      impactDamageCooldown = .5;
    }
    if (i.speed < 12 || i.material.sound === "splash") sound.impact(i.speed, i.material.sound, i.point);
    hud.shake = Math.max(hud.shake, Math.min(1.4, Math.log2(1 + i.speed / 10) / 3));
    const force = Math.min(1, Math.max(0, (i.speed - 5) / 90));
    impactPitch = Math.max(impactPitch, force * .045 * Math.max(.25, Math.abs(i.normal.y)));
    impactRoll = THREE.MathUtils.clamp(impactRoll + force * .035 * (i.normal.x * Math.cos(player.yaw) - i.normal.z * Math.sin(player.yaw)), -.06, .06);
    destruction.onImpact(i);
  };
  let lastBreakSound = 0;
  destruction.onBreak = (energy, m, kind, position) => {
    const distance = position.distanceTo(player.pos);
    const shakeScale = 1 / (1 + (distance / 70) ** 2);
    const now = performance.now();
    if (kind === "bore" || kind === "tear") {
      // continuous grinding while you plough through rock: throttled crunches
      if (now - lastBreakSound < 70) return;
      sound.impact(15 + energy * 60, m.sound, position);
      hud.shake = Math.max(hud.shake, (0.35 + energy * 0.3) * shakeScale);
    } else if (kind === "punch") {
      sound.impact(30 + energy * 90, m.sound, position);
      hud.shake = Math.max(hud.shake, (0.25 + energy * 0.4) * shakeScale);
    } else {
      sound.impact(50 + energy * 120, m.sound, position);
      hud.shake = Math.max(hud.shake, Math.min(1.5, 0.3 + energy * 0.5) * shakeScale);
    }
    lastBreakSound = now;
  };

  // Attack and guard are mutually exclusive; Shift accelerates either charge.
  const SMASH_FROM = MELEE_CHARGE_THRESHOLD; // charge above which a punch becomes a smash down the view
  let punchKick = 0, punchLunge = 0, punchRoll = 0;
  const look = new THREE.Vector3(), zero = new THREE.Vector3(), rel = new THREE.Vector3();
  const chargeRing = document.getElementById("punch-charge")!;
  const boomRing = document.getElementById("boom")!;
  const captured = () => document.pointerLockElement === renderer.domElement && ready;
  const locked = () => captured() && !player.vitals.defeated && !player.vitals.frozen;
  renderer.domElement.addEventListener("mousedown", (e) => {
    if (e.button === 2 && locked()) {
      e.preventDefault();
      if (!combat.begin("guard")) return;
      if (anissaGrab.holdingPlayer) anissaGrab.end();
      holdingAid = false;
      interactions.drop();
      followUp.cancel();
      pursuitHeldTime = 0;
      pursuitSuppressed = pursuitHeld;
      player.cancelForBlock();
      player.combatCharging = true;
      player.combatAttacking = false;
      player.combatAttackCharge = 0;
      fist.cancelStrike();
      leftFist.cancelStrike();
      kickView.cancelStrike();
      punchKick = punchLunge = punchRoll = 0;
      guardResult.textContent = "";
      guardFeedback = 0;
      if (player.momentumKeyHeld) activateSuperBlock();
      return;
    }
    if (captured() && player.held) {
      e.preventDefault();
      if (e.button === 0) {
        fist.strike(.25);
        anissaGrab.punchToEscape();
      }
      return;
    }
    if(e.button===0 && captured() && player.vitals.downed && !persistence.enabled){
      e.preventDefault();
      if(selfRevive.tap(performance.now()/1000))revivePlayer();
      return;
    }
    if (!locked() || holdingAid || e.button !== 0) return;
    if (combat.begin("attack", player.momentumKeyHeld)) {
      followUp.cancel();
      pursuitHeldTime=0;
      player.combatCharging = true;
      player.combatAttacking = true;
      player.combatWhiff = 0;
      guardResult.textContent = "";
      guardFeedback = 0;
    }
  });
  addEventListener("mouseup", (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    const mode = e.button === 0 ? "attack" : "guard";
    const kick=combat.kick;
    const charge = combat.end(mode);
    if (charge === null) return;
    player.combatCharging = false;
    if (mode === "attack" && locked()) throwPunch(charge,kick);
    player.combatAttacking = false;
    player.combatAttackCharge = 0;
  });
  const throwPunch = (held: number,kick=false) => {
    camera.getWorldDirection(look);
    const eye = camera.position;
    // Momentum along the punch adds power: a fast fly-by tap lands like a charged smash.
    const charge = Math.min(1.4, held + Math.max(0, player.vel.dot(look)) / 400);
    if(kick)kickView.strike(charge);else fist.strike(charge);
    sound.swing(charge);
    sound.grunt("effort", "player", Math.min(1, charge));
    punchLunge = 0.2 + charge * 0.3;
    punchRoll = 0.02 + charge * 0.03;
    const hitItem = interactions.punch(eye, look, player, 1 + charge * 3,kick,held);
    const struck = interactions.lastPunchHitFighter;
    const armoredTap = struck?.isDoomsday && held < SMASH_FROM;
    const breaksPoise = !struck || 20 + charge * 80 >= struck.poiseThreshold;
    if (hitItem) {
      // Fighters already play a body-impact sound from onInjured; avoid stacking
      // an unrelated full-volume terrain impact over it.
      if (!interactions.lastPunchHitFighter) sound.impact(240, "hard");
      hud.shake = Math.max(hud.shake, .65);
      // Armor also prevents repeated tap hitstop from freezing the boss's attack clock.
      if(!armoredTap && breaksPoise)hitPause(0.06 + Math.min(1, charge) * 0.08);
      if (charge < SMASH_FROM) return;
    } else if (charge < SMASH_FROM) {
      if (destruction.punch(eye, look, true)) hitPause(0.05);
      else {
        const cloudHit = atmosphere.punch(eye, look, destruction.power);
        if (!cloudHit) player.combatWhiff = 1.1;
        if (cloudHit) sound.launch(.45); // a miss gets only the swing whoosh
        if (cloudHit) hud.shake = Math.max(hud.shake, .25);
      }
      return;
    }
    // One For All: the smash levels a cone down the view and its wind throws everything inside it
    const smash = (charge - SMASH_FROM) / (1 - SMASH_FROM);
    const cone = smashCone(smash, destruction.power), reach = cone.length * 1.3;
    const windAt = (p: THREE.Vector3) => {
      rel.subVectors(p, eye);
      const t = rel.dot(look);
      if (t < 0 || t > reach) return 0;
      const r = cone.r0 + t * cone.spread * 1.5, perp = Math.sqrt(Math.max(0, rel.lengthSq() - t * t));
      return perp > r ? 0 : (1 - t / reach) * (1 - 0.5 * perp / r);
    };
    const fighters = activeFighters();
    const affected = fighters.filter(fighter => windAt(fighter.pos) > .02 || fighter === struck);
    const hitTerrain = destruction.smash(eye, look, smash, affected);
    let hitProp = false;
    for (const prop of interactions.props) {
      const f = windAt(prop.pos);
      if (f > 0.02 && interactions.carrying !== prop) { hitProp = true; prop.playerAttackTime = 8; prop.attackSource=playerHit("throw"); prop.strike(look, zero, prop.pos.clone(), f * f * (.1 + smash * .35)); }
    }
    if (!hitItem && !hitTerrain && !hitProp && affected.length === 0) player.combatWhiff = 1.1;
    else if (!armoredTap && (!struck?.isSukuna || breaksPoise || hitTerrain || hitProp || affected.length > 1)) {
      hitPause(0.08 + Math.min(1, smash) * 0.1, smash > 0.85 ? 0.7 : 0);
    }
    for (const fighter of fighters) {
      const f = windAt(fighter.pos);
      // same falloff as an enemy smash on you: 15% of the strength, scaled by the wind's force
      if (f > 0.02 && struck !== fighter && interactions.carrying !== fighter) fighter.strike(look, zero, 20 * f * f, true, (20 + charge * 80) * f * .15,kick?2:1,playerHit(kick?"kick":"smash"),held);
    }
    sound.smash(smash);
    if (smash > 0.7) sound.sonicBoom();
    hud.shake = Math.max(hud.shake, 0.4 + smash * 1.1);
    punchKick = 6 + smash * 16;
    if (smash > 0.4) { boomRing.classList.remove("go"); void boomRing.offsetWidth; boomRing.classList.add("go"); }
  };
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement !== renderer.domElement) { combat.cancel(); followUp.cancel(); pursuitHeld = false; pursuitSuppressed = false; player.combatCharging = false; player.combatAttacking = false; }
  });
  addEventListener("blur", () => { combat.cancel(); followUp.cancel(); pursuitHeld = false; pursuitSuppressed = false; player.combatCharging = false; player.combatAttacking = false; });
  addEventListener("keyup", e => {
    if(e.code==="KeyT")holdingAid=false;
    if (e.code !== "KeyR") return;
    if (pursuitHeld && pursuitStartedLocked && lockedTarget === pursuitStartedLocked && performance.now() - pursuitPressedAt < 180) {
      lockedTarget = null;
      hud.toast("TARGET", "Unlocked");
    }
    pursuitHeld = false; pursuitHeldTime = 0; pursuitSuppressed = false; pursuitStartedLocked = null; followUp.cancel();
  });
  addEventListener("wheel", e => { if (interactions.carrying) { e.preventDefault(); interactions.adjustDistance(e.deltaMode === 1 ? e.deltaY*33 : e.deltaMode === 2 ? e.deltaY*400 : e.deltaY); } }, { passive: false });
  addEventListener("contextmenu", (e) => e.preventDefault());
  addEventListener("keydown", (e) => {
    if (e.repeat || !locked() || player.held) return;
    if(e.code==="KeyT" && !persistence.enabled && combat.mode !== "guard"){holdingAid=true;combat.cancel();player.combatCharging=false;player.combatAttacking=false;}
    if (e.code === "Tab" && locked()) {
      e.preventDefault();
      lockedTarget = null; followUp.cancel(); pursuitSuppressed = pursuitHeld;
      hud.toast("TARGET", "Unlocked");
    }
    if (e.code === "KeyR" && locked()) {
      pursuitStartedLocked = lockedTarget;
      if (!lockedTarget) lockedTarget = nearestEnemy(activeFighters(), player.pos);
      pursuitPressedAt = performance.now();
      followUp.cancel(); pursuitHeld = true; pursuitHeldTime = 0; pursuitSuppressed = false;pursuitNotice="";
      if (!pursuitStartedLocked && !lockedTarget) hud.toast("TARGET", "No enemy nearby");
    }
    if (e.code === "KeyQ") {
      combat.armKick();
      if(combat.mode==="guard")activateSuperBlock();
      followUp.cancel();pursuitSuppressed=pursuitHeld;
      haltMomentum();
    }
    if (e.code === "KeyX") interactions.drop();
    if (e.code === "KeyF" && combat.mode === "idle") {
      camera.getWorldDirection(look);
      const wasHoldingFighter = interactions.carrying instanceof Faora;
      const message = interactions.grabOrThrow(camera.position, look, player);
      if (message) {
        if (!wasHoldingFighter && !(interactions.carrying instanceof Faora)) hud.toast("GRAB", message);
        sound.launch(.35);
      }
    }
    if (e.code === "KeyG") {
      const friends = activeFighters().filter(fighter => !fighter.enemyMode && !fighter.vitals.defeated && !fighter.held);
      for (const friend of friends) friend.recall(player);
      hud.toast("FRIENDS", friends.length ? "On our way" : "No friends available");
    }
    if (e.code === "KeyB" && locked()) {
      faora.passive = faora.enemyMode; faora.setEnemyMode(!faora.enemyMode);
      refreshRoster();
    }
    if (e.code === "KeyM") { deployFighter(sukuna, !sukunaActive); refreshRoster(); }
    if (e.code === "KeyY") { deployFighter(gojo, !gojoActive); refreshRoster(); }
    if(e.code==="KeyK" && locked()){deployFighter(doomsday,!doomsdayActive);refreshRoster();}
    if (e.code === "KeyJ" && locked()) { deployFighter(beast, !beastActive); refreshRoster(); }
    if (e.code === "KeyN" && locked()) { deployFighter(anissa, !anissaActive); refreshRoster(); }
    if (e.code === "BracketRight" || e.code === "BracketLeft") {
      destruction.power = Math.max(0.25, Math.min(64, destruction.power * (e.code === "BracketRight" ? 2 : 0.5)));
      hud.toast("POWER", `×${destruction.power}`);
    }
    if (e.code === "KeyH") {
      destruction.healing = !destruction.healing;
      hud.toast("TERRAIN HEALING", destruction.healing ? "ON" : "OFF");
    }
  });
  // Who cries out, and how: a clipped "hk" on a stagger, a pain grunt on a solid hit, a yell when launched.
  const voiceOf = (fighter: Faora): Voice => fighter === doomsday ? "doomsday"
    : fighter === beast ? "beast" : fighter === anissa ? "anissa"
    : fighter === gojo ? "gojo" : fighter === sukuna ? "sukuna" : "faora";
  const lastCry = new Map<Voice, number>();
  const hurtGrunt = (voice: Voice, strength: number, position?: THREE.Vector3) => {
    if (strength < 8) return; // light bumps and soft landings stay quiet
    // one cry per speaker at a time: a launch and the crash right after it don't stack two yells
    const now = performance.now();
    const gap = voice === "gojo" || voice === "sukuna" ? 250 : 450;
    if (now - (lastCry.get(voice) ?? -1e9) < gap) return;
    lastCry.set(voice, now);
    sound.grunt(strength >= STAGGER_LIMIT ? "yell" : strength >= 25 ? "pain" : "stagger", voice, Math.min(1, strength / 100), position);
  };
  player.onPound = () => sound.grunt("effort", "player", .85);
  player.onDefeated = () => {
    if(anissaGrab.holdingPlayer)anissaGrab.end();
    sound.grunt("yell", "player", 1);
    combat.cancel(); player.combatCharging = false; player.combatAttacking = false;
    followUp.cancel(); pursuitHeld = false; pursuitSuppressed = false; lockedTarget = null;
    holdingAid=false;selfRevive.reset();
    status.textContent = persistence.enabled?"Down · back in 25 s":player.vitals.downed?"Down · mash click to get up":"Defeated";
    refreshRecovery();
    if(player.vitals.eliminated && !persistence.enabled){
      overlay.classList.remove("hidden");
      if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
    }
  };
  player.onInjured = strength => {
    hurtGrunt("player", strength);
    followUp.cancel(); pursuitHeldTime=0;
    damageEffects.hit(player.pos, strength, undefined, true);
    sound.damage(strength);
  };
  player.onStep = (m, speed) => sound.step(m.sound, speed);
  player.onCharge = (charge) => sound.tick(charge);
  player.onJump = (speed, charge, point, material) => {
    if (charge > .4) sound.grunt("effort", "player", charge);
    destruction.launch(point, speed, charge, material);
    if (faoraActive) faora.jumpWith(player, charge);
    hud.shake = Math.max(hud.shake, Math.min(1.5, 0.15 + charge * 0.4 + speed / 200));
    launchKick = Math.min(.035, charge * .035);
    if (speed > 150) sound.sonicBoom();
  };
  player.onLaunch = (power) => {
    sound.launch(power);
    hud.shake = Math.max(hud.shake, power * 0.5);
  };
  hud.onSonicBoom = () => sound.sonicBoom();
  for (const fighter of roster) {
  fighter.onInjured = (strength, direction) => {
    if(fighter===doomsday)doomsdayPowers.absorb(strength);
    hurtGrunt(voiceOf(fighter), strength, fighter.pos);
    damageEffects.hit(fighter.pos, strength, direction, false, fighter.bodyScale);
    sound.damage(strength, fighter.pos);
  };
  fighter.onDefeated = () => {
    if (fighter === gojo) gojoPowers.reset(gojo);
    sound.grunt("yell", voiceOf(fighter), 1, fighter.pos);
    if (interactions.carrying === fighter) interactions.drop();
    fighter.trails.emit(fighter.pos, 0, 0);
    refreshRecovery();
    hud.toast(fighter.name.toUpperCase(), persistence.covers(fighter.enemyMode)?"Back in 25 s":fighter.vitals.downed?"Down":"Defeated");
  };
  fighter.onLeap = () => {
    if(fighter.isDoomsday) {
      const origin=fighter.pos.clone();origin.y+=.6;
      destruction.doomsdayImpact(origin,new THREE.Vector3(0,1,0),24,roster);
    }
    sound.grunt(fighter.isSukuna ? "effort" : "yell", voiceOf(fighter), fighter.isSukuna ? .5 : .8, fighter.pos);
    sound.fighterLeap(fighter.isDoomsday, fighter.pos);
  };
  fighter.onLand = speed => {
    if(fighter.isDoomsday) {
      const origin=fighter.pos.clone().add(new THREE.Vector3(0,.6,0));
      destruction.doomsdayImpact(origin,new THREE.Vector3(0,1,0),Math.min(65,24+speed*.3),roster);
    }
    sound.stomp(speed * (fighter.isSukuna ? 1 : 2), fighter.isDoomsday, fighter.pos);
    hud.shake = Math.max(hud.shake, (fighter.isSukuna ? .18 : .65) / (1 + player.pos.distanceToSquared(fighter.pos) / 900));
  };
  fighter.onPounceAttack = target => {
    // A physical contact snatch, not a ranged pull: the AI has already checked reach and line of sight.
    const strength=100, down=new THREE.Vector3(0,-1,0);
    if(fighter.isDoomsday)
      destruction.doomsdayImpact(target.pos.clone().add(new THREE.Vector3(0,1,0)),down,25,roster);
    let landed=false;
    if(target===player && fighter.hostile && !player.vitals.defeated){
      const remaining=defend(strength);
      if(remaining>0){
        player.receiveHit(strength*remaining,1,sourceFor(fighter,"snatch"));
        knockPlayer(down,850*remaining,strength*remaining);
        if(strength*remaining>STAGGER_LIMIT)player.vel.y=Math.min(player.vel.y,-28*remaining);
        landed=true;
      }
    }else{
      const victim=roster.find(other=>other.asTarget===target);
      if(victim && enemies(fighter,victim) && !victim.vitals.defeated && !victim.held)
        landed=victim.strike(down,zero,850,false,strength,1,sourceFor(fighter,"snatch"));
    }
    sound.grunt("effort",voiceOf(fighter),1,fighter.pos);
    if(landed && player.pos.distanceToSquared(fighter.pos)<1600){
      hitPause(.1);
      hud.shake=Math.max(hud.shake,.65);
    }
    return landed;
  };
  fighter.onGuard = fullyBlocked => sound.block(fullyBlocked, fighter.pos);
  fighter.onObstacleSmash = direction => {
    const broke=destruction.breach(fighter.pos,direction,fighter.bodyScale);
    sound.grunt("effort",voiceOf(fighter),.9,fighter.pos);
    if(broke && fighter.isDoomsday) {
      const origin=fighter.pos.clone().addScaledVector(direction,2);origin.y+=2;
      destruction.doomsdayImpact(origin,direction,22,roster);
    }
    if(broke)hud.shake=Math.max(hud.shake,.3/(1+player.pos.distanceToSquared(fighter.pos)/400));
    return broke;
  };
  fighter.onStomp = speed => {
    destruction.stomp(fighter.pos, fighter.vel);
    sound.stomp(speed, fighter.isDoomsday, fighter.pos);
    hud.shake = Math.max(hud.shake, .3 / (1 + player.pos.distanceToSquared(fighter.pos) / 400));
  };
  fighter.onSmash = (origin, direction, charge, knockback = direction) => {
    // Every fighter is exempt from the terrain blast: the cone below decides who it actually hits.
    destruction.smash(origin, direction, charge, roster);
    const cone = smashCone(charge, destruction.power), reach = cone.length * 1.3;
    const attackCharge = .3 + charge * .7;
    const relative = new THREE.Vector3();
    /** Force at a point in the smash cone (0 outside it), and whether it's close enough for the fist itself. */
    const coneAt = (position: THREE.Vector3, lift: number) => {
      relative.copy(position).sub(origin); relative.y += lift;
      const along = relative.dot(direction);
      if (along < 0 || along > reach) return { force: 0, direct: false };
      const width = cone.r0 + along * cone.spread * 1.5;
      const offset = Math.sqrt(Math.max(0, relative.lengthSq() - along * along));
      return offset > width ? { force: 0, direct: false } : { force: (1 - along / reach) * (1 - .5 * offset / width), direct: along <= 6 };
    };
    let landed = false;
    if (fighter.hostile) {
      const { force, direct } = coneAt(player.pos, .9);
      if (force > 0) {
        const strength = (20 + attackCharge * 80) * force * (direct ? 1 : .15);
        const remaining = defend(strength);
        if (remaining > 0) {
          player.receiveHit(strength * remaining,1,sourceFor(fighter,knockback.y>.6?"uppercut":knockback.y<-.6?"slam":"smash"));
          hitPause(0.05 + 0.07 * force * remaining);
          const impulse = direct ? 260 * (1 + attackCharge * 3) * force : 20 * force * force;
          knockPlayer(knockback, impulse * remaining, strength * remaining);
          hud.shake = Math.max(hud.shake, .7 * force * remaining);
          landed = true;
        }
      }
    }
    for (const other of roster) {
      if (!enemies(fighter, other) || other.vitals.defeated || interactions.carrying === other) continue;
      const { force, direct } = coneAt(other.pos, .9 * other.bodyScale);
      if (force <= 0) continue;
      const strength = (20 + attackCharge * 80) * force * (direct ? 1 : .15);
      const impulse = direct ? 260 * (1 + attackCharge * 3) * force : 20 * force * force;
      if (other.strike(knockback, fighter.vel, impulse, false, strength,1,sourceFor(fighter,knockback.y>.6?"uppercut":knockback.y<-.6?"slam":"smash"))) landed = true;
    }
    for (const prop of interactions.props) {
      if (prop.held) continue;
      const { force } = coneAt(prop.pos, 0);
      if (force > .02) { prop.playerAttackTime=8; prop.attackSource=sourceFor(fighter,"throw"); prop.strike(direction, fighter.vel, prop.pos.clone(), force * force * (.1 + charge * .35)); }
    }
    sound.smash(charge, origin);
    sound.grunt("effort", voiceOf(fighter), 1, origin);
    return landed;
  };
  fighter.onCounterAttack = (direction, charge, style) => {
    const knockback = direction.clone();
    if (style === "uppercut") knockback.y = Math.max(.8, knockback.y + .8);
    else if (style === "down") knockback.y = Math.min(-.8, knockback.y - .8);
    else knockback.y = 0;
    if (knockback.lengthSq() < .001) knockback.copy(direction);
    knockback.normalize();
    if (fighter.cursedEnergy) {
      const empowered = fighter === gojo ? gojoPowers.spendOnMelee(gojo) : fighter.cursedEnergy.spend(CURSED_COST.melee);
      sound.grunt("effort", voiceOf(fighter), charge, fighter.pos);
      const target = fighter.opponent?.asTarget ?? player;
      const intoRed = fighter === gojo && gojoPowers.alignMelee(fighter, target, knockback);
      const kick = fighter === gojo && (intoRed || style === "down" || fighter.pos.distanceToSquared(target.pos) > 3.6 ** 2);
      if (kick) fighter.poseCursedStrike(true);
      const action = kick ? "kick" : style === "down" ? "slam" : style === "uppercut" ? "uppercut" : "punch";
      const strength = (20 + charge * 80) * (empowered ? fighter.meleeStrengthMultiplier : .73);
      return resolveCursedMelee(fighter, target, knockback, action, strength, 1, intoRed ? 370 : 170 * charge, empowered);
    }
    if (!fighter.groundOnly && charge >= .3) return fighter.onSmash(fighter.pos.clone().add(new THREE.Vector3(0, 1.3, 0)), direction, (charge - .3) / .7, knockback);
    if(fighter.isDoomsday) {
      const origin=fighter.pos.clone().addScaledVector(direction,2);origin.y+=2.2;
      destruction.doomsdayImpact(origin,knockback,18+charge*16,roster);
      sound.smash(charge,origin);
    }
    sound.grunt("effort", voiceOf(fighter), charge, fighter.pos);
    const strength = (20 + charge * 80) * fighter.meleeStrengthMultiplier;
    const victim = fighter.opponent;
    if (victim) {
      // Fighter on fighter: their own guard and resistance decide what lands. A beat of hitstop when it's near you.
      const landed = victim.strike(knockback, fighter.vel, 260 * (1 + charge * 3), false, strength,fighter.isDoomsday?1.4:1,sourceFor(fighter,style==="down"?"slam":style==="uppercut"?"uppercut":"punch"));
      if (landed && player.pos.distanceToSquared(fighter.pos) < 1600) hitPause(0.03 + charge * 0.04);
      return landed;
    }
    const remaining = defend(strength);
    if (remaining <= 0) return false;
    player.receiveHit(strength * remaining,fighter.isDoomsday?1.4:1,sourceFor(fighter,style==="down"?"slam":style==="uppercut"?"uppercut":"punch"));
    hitPause(0.06 + charge * 0.06);
    knockPlayer(knockback, 260 * (1 + charge * 3) * remaining, strength * remaining);
    hud.shake = Math.max(hud.shake, .55 * remaining);
    return true;
  };
  }
  player.onLevel = (kind, level, count) => {
    sound.tick(level / (count - 1));
    hud.showLevel(kind, level, count, `${player.flySpeed} m/s`);
  };

  const play = () => {
    if (player.vitals.eliminated && !persistence.enabled) return;
    if (ready) { encounterStarted = true; overlay.classList.add("hidden"); }
    sound.unlock();
    // embedded previews can refuse pointer lock; that's not worth an uncaught rejection
    Promise.resolve(renderer.domElement.requestPointerLock() as unknown).catch(() => {});
  };
  renderer.domElement.addEventListener("click", play);
  document.getElementById("resume-game")!.addEventListener("click", play);
  document.addEventListener("pointerlockchange", () => {
    if(!captured())holdingAid=false;
    overlay.classList.toggle("hidden", document.pointerLockElement === renderer.domElement);
    refreshRecovery();
    document.getElementById("resume-game")!.textContent = encounterStarted ? "Resume" : "Play";
    if (document.pointerLockElement !== renderer.domElement && encounterStarted) status.textContent = player.vitals.defeated && persistence.enabled?"Down · back soon":player.vitals.eliminated ? "Defeated" : player.vitals.downed?"Down":"Paused";
  });
  addEventListener("blur",()=>{holdingAid=false;});
  const revivePlayer=(automatic=false)=>{
    if(!player.revive(automatic))return false;
    selfRevive.reset();damageEffects.resetScreen();refreshRecovery();
    hud.toast("REVIVED",`${Math.round(player.vitals.health)} HP`);
    return true;
  };
  menuRevivePlayer.addEventListener("click", e => {
    e.stopPropagation();
    if (!player.vitals.defeated) {
      player.vitals.health = player.vitals.maxHealth;
      damageEffects.resetScreen();
      refreshRecovery();
      status.textContent = "Healed";
      return;
    }
    if(!player.revive(false,true))return;
    selfRevive.reset();holdingAid=false;damageEffects.resetScreen();
    persistence.forget("YOU");
    refreshRecovery();status.textContent="Revived";
  });
  retryPlayer.addEventListener("click", e => {
    e.stopPropagation();
    player.vitals.reset(); player.setFlying(false); player.spawn(spawn.x, spawn.z, -Math.PI / 2);
    selfRevive.reset();revivals.clear();persistence.clear();hitFeed.clear();
    faoraInterrupter = null;
    damageEffects.resetScreen();
    refreshRecovery(); status.textContent = ""; play();
  });
  const persistenceInput=document.getElementById("persist-friends") as HTMLInputElement;
  const foePersistenceInput=document.getElementById("persist-foes") as HTMLInputElement;
  persistenceInput.checked=persistence.enabled;
  foePersistenceInput.checked=persistence.foes;
  document.getElementById("game-modes")!.addEventListener("click",e=>e.stopPropagation());
  foePersistenceInput.addEventListener("change",()=>{
    persistence.setFoes(foePersistenceInput.checked);
    for(const fighter of roster)if(fighter.enemyMode)fighter.rescueTarget=null;
    try{localStorage.setItem("power.persistence.foes",String(persistence.foes));}catch{}
    refreshRecovery();
  });
  persistenceInput.addEventListener("change",()=>{
    persistence.setEnabled(persistenceInput.checked);
    selfRevive.reset();holdingAid=false;
    for(const fighter of roster)if(!fighter.enemyMode)fighter.rescueTarget=null;
    try{localStorage.setItem("power.persistence",String(persistence.enabled));}catch{}
    refreshRecovery();
    if(player.vitals.defeated)status.textContent=persistence.enabled?"Down · back soon":player.vitals.downed?"Down":"Defeated";
  });
  const revive = (fighter: Faora, offset = { x: 15, z: 10 }) => {
    const hostile = fighter.enemyMode;
    if(fighter===doomsday)doomsdayPowers.reset();
    if (fighter === sukuna) sukunaPowers.reset(sukuna);
    if (fighter === gojo) gojoPowers.reset(gojo);
    const spot = scenery.findClearPoint(hf, player.pos.x + offset.x, player.pos.z + offset.z, 3);
    fighter.spawn(spot.x, spot.z);
    if (!fighter.groundOnly && !player.onGround) { fighter.pos.y = Math.max(fighter.pos.y, player.pos.y + 5); fighter.model.position.copy(fighter.pos); }
    fighter.setEnemyMode(hostile);
    refreshRecovery();
  };
  const isDeployed = (fighter: Faora) => fighter === faora ? faoraActive : fighter === anissa ? anissaActive
    : fighter === beast ? beastActive : fighter === doomsday ? doomsdayActive : fighter === sukuna ? sukunaActive : gojoActive;
  const deployedOnce = new Set<Faora>();
  const deployFighter = (fighter: Faora, enabled: boolean, offset?: { x: number; z: number }) => {
    const wasActive = isDeployed(fighter);
    if (enabled && !wasActive && !deployedOnce.has(fighter)) {
      revive(fighter, offset);
      deployedOnce.add(fighter);
    }
    if (fighter === faora) faoraActive = enabled;
    else if (fighter === anissa) anissaActive = enabled;
    else if(fighter===beast)beastActive=enabled;
    else if (fighter === doomsday) doomsdayActive=enabled;
    else if (fighter === sukuna) sukunaActive = enabled;
    else if (fighter === gojo) gojoActive = enabled;
    if (fighter === sukuna && !enabled) sukunaPowers.reset(sukuna);
    if (fighter === gojo && !enabled) gojoPowers.reset(gojo);
    fighter.model.visible = enabled; fighter.trails.mesh.visible = enabled && !fighter.groundOnly;
    if (fighter !== faora) {
      const index = interactions.opponents.indexOf(fighter);
      if (enabled && index < 0) interactions.opponents.push(fighter);
      if (!enabled && index >= 0) interactions.opponents.splice(index, 1);
    }
    if (!enabled && interactions.carrying === fighter) interactions.drop();
    if (!enabled && lockedTarget === fighter) { lockedTarget = null; followUp.cancel(); }
    hud.companion = faoraActive ? faora : null;
    hud.opponent = anissaActive ? anissa : null;
    hud.beast = beastActive ? beast : null;
    hud.doomsday=doomsdayActive?doomsday:null;
    hud.sukuna = sukunaActive ? sukuna : null;
    hud.gojo = gojoActive ? gojo : null;
  };
  const menuReviveFighter=(fighter:Faora)=>{
    if(!fighter.vitals.defeated)return;
    if(interactions.carrying===fighter)interactions.drop();
    if(!fighter.revive(false,true))return;
    if(fighter===doomsday)doomsdayPowers.reset();
    if (fighter === sukuna) sukunaPowers.reset(sukuna);
    if (fighter === gojo) gojoPowers.reset(gojo);
    persistence.forget(fighter.name);
    refreshRecovery();
    status.textContent=`${fighter.name} revived`;
  };
  deployFighter(sukuna, true, { x: 24, z: 10 });
  deployFighter(gojo, true, { x: 10, z: -5 });
  refreshRoster =setupRoster(roster, isDeployed, deployFighter, menuReviveFighter, () => {
    if (lockedTarget && !lockedTarget.hostile) { lockedTarget = null; followUp.cancel(); }
  },enemy=>persistence.covers(enemy));
  refreshRecovery();
  sukuna.onBlink = (from, to) => {
    atmosphere.shockwave(from, new THREE.Vector3(0, 1, 0), 0, 3, 1);
    atmosphere.shockwave(to, new THREE.Vector3(0, 1, 0), 0, 3, 1);
    sound.swing(.45);
  };
  let nextSukunaTaunt = false;
  sukuna.onTaunt = () => {
    sound.cursedLine("sukuna", nextSukunaTaunt ? "impress" : "closer", sukuna.pos);
    nextSukunaTaunt = !nextSukunaTaunt;
  };
  sukunaPowers.onCast = (technique, origin) => {
    switch (technique) {
      case "cleave":
      case "dismantle":
        sound.cursedLine("sukuna", technique, origin);
        break;
      case "world-slash":
        sound.cursedLine("sukuna", "world", origin, true);
        sound.sukuna("world-charge", origin);
        break;
      case "fuga":
        sound.cursedLine("sukuna", "fuga", origin, true);
        sound.sukuna("fuga-charge", origin);
        break;
      case "shrine":
        sound.cursedLine("sukuna", "shrine", origin, true);
        sound.sukuna("shrine-charge", origin);
        break;
      case "rct":
        sound.sukuna("rct", origin);
        break;
      default:
        sound.grunt("effort", "sukuna", .72, origin);
    }
  };
  /** Everyone inside Sukuna's closed barrier when it formed stays inside until it falls. */
  const barrierTrapped = new Set<typeof player | Faora>();
  const barrierUnconstrained = new THREE.Vector3(), barrierCorrection = new THREE.Vector3();
  sukunaPowers.onRelease = (kind, origin) => {
    sound.sukuna(kind === "shrine" ? "shrine-open" : kind === "fuga" ? "fuga-fire" : "world-fire", origin);
    const domain = sukunaPowers.domain;
    if (kind === "shrine" && domain?.form === "barrier") {
      barrierTrapped.clear();
      for (const body of [player, ...activeFighters()])
        if (body !== sukuna && body.pos.distanceToSquared(domain.center) < domain.radius ** 2) barrierTrapped.add(body);
    }
  };
  hud.techniqueNote = fighter => {
    if (fighter !== sukuna) return "";
    const domain = sukunaPowers.domain;
    if (domain) return `${domain.form === "barrier" ? "BARRIER" : "OPEN"} SHRINE · ${Math.ceil(sukunaPowers.domainTimeLeft)}s`;
    const slashes = sukunaPowers.slashCount;
    return slashes >= FUGA_SLASHES ? `FUGA READY · ${Math.round(fugaPower(slashes) * 100)}%` : `FUGA ${slashes}/${FUGA_SLASHES}`;
  };
  sukunaPowers.groundAt = (x, y, z) => {
    const ground = destruction.spans(x, z).floor(y);
    return Number.isFinite(ground) ? ground : y;
  };
  let slashSound = 0, blockedCuts = 0;
  sukunaPowers.onWorldCut = (point, direction) => {
    destruction.slashCut(point, direction, 8.5, .7,
      { streaming: true, scatter: point.distanceToSquared(player.pos) < 45 ** 2 });
  };
  sukunaPowers.onCutBlocked = (point, direction) => {
    // Cover holds, but every few cuts leave a notch in it.
    if (blockedCuts++ % 5 === 0) destruction.slashCut(point, direction, 2.2, .35);
  };
  sukunaPowers.onShrinePulse = (origin, radius, pulse) => {
    // Widen the terrain cut in five passes, then keep shredding props that enter.
    if (pulse <= 20 && pulse % 5 === 0) {
      destruction.shrineCut(origin, radius * (.36 + pulse * .032));
    }
    sound.sukuna("shrine-pulse", player.pos.distanceToSquared(origin) < radius ** 2 ? player.pos : origin);
    interactions.destroyPropsWithin(origin, radius, 13);
    if (player.pos.distanceToSquared(origin) < (radius * 1.5) ** 2) {
      hud.shake = Math.max(hud.shake, .45);
    }
  };
  sukunaPowers.onFuga = (point, radius, power) => {
    damageEffects.fx.nova(point, radius);
    // A minimum Fuga scorches what it lands on; a charged one levels everything in reach, air burst or not.
    const ground = destruction.spans(point.x, point.z).floor(point.y + 1);
    if (power > .25 || (Number.isFinite(ground) && Math.abs(ground - point.y) < 5)) {
      destruction.energyBlast(point, Math.max(18, radius), roster);
    }
    sound.sukuna("fuga-blast", point);
    if (power > .25) {
      // At strength it is a spectacle on the scale of Doomsday's nova: light, a rolling blast wave and a beat of stillness.
      sound.doomsdayEnergy("nova-blast", point);
      combatLight.position.copy(point).y += 10;
      combatLight.color.setHex(0xff6a2a);
      combatLight.distance = radius * 1.4;
      combatLight.intensity = radius * radius * 4;
      novaWake = { origin: point.clone(), radius, age: 0, hostile: sukuna.hostile, enemyTeam: sukuna.enemyMode, cover: new Map(), owner: sukuna };
      hitPause(.04 + .08 * power);
    }
    hud.shake = Math.max(hud.shake, (.35 + power) * 1.2 / (1 + player.pos.distanceToSquared(point) / Math.max(4000, radius * radius)));
  };
  sukunaPowers.onHit = (technique, target, direction, scale = 1) => {
    if (technique === "punch" || technique === "kick") {
      resolveCursedMelee(sukuna, target, direction, technique, technique === "punch" ? 37 : 55, 1, 0, true);
      return;
    }
    const boost = technique === "fuga" ? scale : technique === "shrine" ? sukunaPowers.sureHitScale : 1;
    const strength = { cleave: 95, dismantle: 72, fuga: 135, shrine: 45, "world-slash": 150 }[technique] * boost;
    const impulse = technique === "fuga" ? 300 * scale : technique === "world-slash" ? 240 : 0;
    // Malevolent Shrine's slashes deal two thirds of their former damage; stagger and knockback are unchanged.
    const damageMultiplier = technique === "cleave" ? .055 : technique === "dismantle" ? .16 : technique === "fuga" ? 1.4 : technique === "shrine" ? 2 / 3 : 1;
    if ((technique === "dismantle" || technique === "cleave") && slashSound++ % 5 === 0) {
      sound.sukuna(technique === "cleave" ? "cleave" : "cut", target.pos);
    }
    const source = sourceFor(sukuna, technique);
    if (target === player) {
      const remaining = defend(strength);
      if (remaining <= 0) return;
      player.receiveHit(strength * remaining, damageMultiplier, source);
      if (impulse) knockPlayer(direction, impulse * remaining, strength * remaining);
      hud.shake = Math.max(hud.shake, .4 * remaining);
    } else {
      const victim = roster.find(other => other.asTarget === target);
      if (!victim || (technique !== "shrine" && !enemies(sukuna, victim))) return;
      const ward = victim === gojo && technique === "shrine" ? gojoPowers.defendDomain(gojo) : 1;
      if (ward <= 0 || !victim.strike(direction, zero, impulse, false, strength * ward, damageMultiplier, source)) return;
    }
  };
  const gojoFlash = (point: THREE.Vector3, color: number, radius: number) => {
    if (novaWake || point.distanceToSquared(player.pos) > (radius * 5) ** 2) return;
    combatLight.position.copy(point);
    combatLight.color.setHex(color);
    combatLight.distance = radius * 1.6;
    combatLight.intensity = radius * radius * .74;
  };
  gojo.onInfinityBlock = () => {
    if (gojoPowers.block(gojo.pos)) sound.gojo("infinity", gojo.pos);
  };
  gojo.onBlink = (from, to) => {
    gojoPowers.block(from);
    sound.gojo("blink", to);
    damageEffects.fx.beamImpact(to, new THREE.Vector3(0, 1, 0), 1 / 60, .7, false);
  };
  gojoPowers.onDomainDefense = (_kind, origin) => sound.gojo("infinity", origin);
  sukunaPowers.insideHostileDomain = point => gojoActive && enemies(gojo, sukuna) && gojoPowers.insideVoid(point);
  // Sukuna answers the Void's sure-hit the same way: Simple Domain, then Falling Blossom.
  gojoPowers.sureHitWard = (target, spend) => {
    if (target !== sukuna.asTarget) return 1;
    if (!spend) return sukunaPowers.defense.cover;
    const able = !sukuna.vitals.frozen && !sukuna.vitals.defeated && !sukuna.held && !sukuna.ragdoll.active;
    return sukunaPowers.defense.defend(sukuna.cursedEnergy, able, kind => gojoPowers.showDefense(kind, sukuna.pos));
  };
  gojoPowers.blockedAt = point => destruction.spans(point.x, point.z).solid(point.y);
  const gojoWindup = {
    blue: "blue-charge", "maximum-blue": "blue-charge", "blue-melee": "blue-charge",
    red: "red-charge", "red-melee": "red-charge", purple: "purple-charge", "amplified-purple": "purple-charge",
    void: "void-charge",
  } as const;
  gojoPowers.onCast = (kind, origin) => {
    if (kind === "blue" || kind === "maximum-blue") sound.cursedLine("gojo", "blue", origin);
    else if (kind === "red") sound.cursedLine("gojo", "red", origin);
    else if (kind === "void") sound.cursedLine("gojo", "void", origin, true);
    else if (kind === "purple" || kind === "amplified-purple") sound.cursedLine("gojo", "purple", origin, true);
    else if (kind !== "rct") sound.grunt("effort", "gojo", .78, origin);
    if (kind !== "rct") sound.gojo(gojoWindup[kind], origin);
  };
  gojoPowers.onRelease = (kind, origin) => {
    if (kind === "blue" || kind === "maximum-blue") sound.gojo("blue-form", origin);
    else if (kind === "red") sound.gojo("red-fire", origin);
    else if (kind === "rct") sound.gojo("rct", origin);
    else if (kind === "purple" || kind === "amplified-purple") {
      sound.gojo("purple-fire", origin);
      gojoFlash(origin, 0x964aff, 10);
    }
  };
  gojoPowers.onVoidPulse = point => sound.gojo("void-pulse", point);
  let lastPurpleDebris = -Infinity;
  gojoPowers.onPurplePath = (point, direction) => {
    const now = performance.now();
    const scatter = now - lastPurpleDebris >= 125 && point.distanceToSquared(player.pos) < 100 ** 2;
    if (destruction.slashCut(point, direction, 5.8, 3.8, { streaming: true, scatter }) && scatter) lastPurpleDebris = now;
  };
  gojoPowers.onImpact = (kind, point) => {
    const purple = kind === "purple" || kind === "amplified-purple";
    if (purple) {
      destruction.slashCut(point, new THREE.Vector3(0, 1, 0), 8, 6);
      sound.gojo("purple-burst", point, .8);
    } else {
      sound.gojo(kind === "void" ? "void-close" : "blue-strike", point);
      if (kind === "blue-melee") gojoFlash(point, 0x55aaff, 4);
    }
    if (point.distanceToSquared(player.pos) < 55 ** 2 && purple) {
      fx.flashImpact(.32);
      hud.shake = Math.max(hud.shake, .32);
    }
  };
  const blastUp = new THREE.Vector3(0, 1, 0);
  gojoPowers.onExplosion = (kind, point, radius) => {
    const purple = kind === "remote-purple";
    const floor = destruction.spans(point.x, point.z).floor(point.y + .3);
    if (point.y - floor < 3 && kind !== "red") {
      destruction.slashCut(point, blastUp, radius * .48, purple ? 5 : 2.9,
        { streaming: true, scatter: point.distanceToSquared(player.pos) < 65 ** 2 });
    }
    sound.gojo(purple ? "purple-burst" : "red-burst", point, radius / 13);
    gojoFlash(point, purple ? 0xa43bff : 0xff194c, radius);
    const proximity = Math.max(0, 1 - point.distanceTo(player.pos) / (radius * 4));
    if (proximity > 0) {
      fx.flashImpact(proximity * (purple ? .65 : .44));
      hud.shake = Math.max(hud.shake, proximity * (purple ? .7 : .5));
    }
  };
  gojoPowers.onDomainCapture = target => {
    if (target === player) {
      if (anissaGrab.holdingPlayer) anissaGrab.end();
      interactions.drop();
      combat.cancel();
      followUp.cancel();
      pursuitHeld = holdingAid = false;
      pursuitHeldTime = 0;
      player.stopForStasis();
      return;
    }
    const fighter = roster.find(other => other.asTarget === target);
    if (fighter && (fighter === anissa || anissaGrab.holds(fighter))) anissaGrab.end();
    if (interactions.carrying === fighter) interactions.drop();
    if (fighter?.ragdoll.active) for (const velocity of fighter.ragdoll.velocity) velocity.set(0, 0, 0);
  };
  gojoPowers.onDomainDrain = (target, damage) => {
    const fighter = roster.find(other => other.asTarget === target);
    const source = sourceFor(gojo, "void");
    if (target === player) {
      logHit({ source, damage, outcome: "hit" }, "YOU", "player");
      hud.shake = Math.max(hud.shake, .23);
    } else if (fighter) logHit({ source, damage, outcome: "hit" }, fighter.name, fighter.enemyMode ? "foe" : "friend");
  };
  gojoPowers.onHit = (kind, target, direction, blastScale) => {
    if (target.vitals.defeated || target.vitals.frozen || target.vitals.inReviveGrace) return false;
    const { strength, multiplier, impulse, splashMultiplier } = GOJO_HITS[kind];
    if (blastScale === undefined && (kind === "blue-melee" || kind === "red-melee")) {
      return resolveCursedMelee(gojo, target, direction, kind, strength, multiplier, impulse, true);
    }
    const scale = blastScale ?? 1;
    const damageMultiplier = (splashMultiplier ?? multiplier) * scale;
    const source = sourceFor(gojo, kind);
    const revision = target.vitals.damageRevision;
    if (target === player) {
      if (!gojo.hostile) return false;
      const remaining = defend(strength);
      if (remaining <= 0) return false;
      player.receiveHit(strength * remaining, damageMultiplier, source);
      if (revision === target.vitals.damageRevision) return false;
      if (impulse) knockPlayer(direction, impulse * scale * remaining, strength * remaining);
      hud.shake = Math.max(hud.shake, .42 * remaining);
    } else {
      const victim = roster.find(other => other.asTarget === target);
      if (!victim || !enemies(gojo, victim)) return false;
      victim.strike(direction, zero, impulse * scale, false, strength, damageMultiplier, source);
    }
    return revision !== target.vitals.damageRevision;
  };
  gojoPowers.onPull = (target, direction, impulse) => {
    if (target === player) {
      if (!observerMode && gojo.hostile && !player.superBlock.active && !player.vitals.inReviveGrace) player.vel.addScaledVector(direction, impulse);
      return;
    }
    const victim = roster.find(fighter => fighter.asTarget === target);
    victim?.applyOrbImpulse(direction, impulse);
  };
  const laserVision = new LaserVision(scene);
  doomsdayPowers.onCharge=kind=>{
    sound.grunt(kind==="nova"?"yell":"strain",voiceOf(doomsday),1,doomsday.pos);
    sound.doomsdayEnergy(kind==="nova"?"nova-charge":"beam-charge",doomsday.pos);
  };
  doomsdayPowers.onBurn=(point,group)=>destruction.burn(point,1.8,group);
  doomsdayPowers.onBeamFire=()=>{sound.doomsdayEnergy("beam-fire",doomsday.pos);sound.grunt("effort",voiceOf(doomsday),1,doomsday.pos);};
  doomsdayPowers.onBeamHit=(target,strength,direction)=>{
    if(target===player && doomsday.hostile && !player.vitals.defeated){
      const remaining=defend(strength);
      if(remaining>0){
        const previousAlong=player.vel.dot(direction);
        player.receiveHit(strength*remaining,DOOMSDAY_BEAM_DAMAGE_SCALE,sourceFor(doomsday,"beam"));
        knockPlayer(direction,DOOMSDAY_BEAM_IMPULSE*remaining,strength*remaining);
        limitBeamPush(player.vel,direction,previousAlong);
        hud.shake=Math.max(hud.shake,.35);
      }
    }else{
      const victim=roster.find(other=>other.asTarget===target);
      if(victim && enemies(doomsday,victim) && !victim.held)
        victim.strike(direction,zero,DOOMSDAY_BEAM_IMPULSE,false,strength,DOOMSDAY_BEAM_DAMAGE_SCALE,sourceFor(doomsday,"beam"));
    }
  };
  doomsdayPowers.onNova=(origin,radius)=>{
    damageEffects.fx.nova(origin,radius);
    novaWake={origin:origin.clone(),radius,age:0,hostile:doomsday.hostile,enemyTeam:doomsday.enemyMode,cover:new Map(),owner:doomsday};
    combatLight.position.copy(origin).y+=10;
    combatLight.color.setHex(0xffa769);
    combatLight.distance=radius*1.4;
    combatLight.intensity=radius*radius*4;
    destruction.energyBlast(origin,radius,roster);
    const hit=(position:THREE.Vector3)=>{
      const distance=position.distanceTo(origin);
      if(distance>=radius)return 0;
      const point=position.clone();point.y+=1;
      return Math.pow(1-distance/radius,1.2)*(doomsday.lineClear(origin,point)?1:.15);
    };
    if(doomsday.hostile && !player.vitals.defeated){
      const force=hit(player.pos),strength=200*force,remaining=defend(strength);
      if(force>0 && remaining>0){
        player.receiveHit(strength*remaining,2,sourceFor(doomsday,"nova"));
        const direction=player.pos.clone().sub(origin).setY(Math.max(1,player.pos.y-origin.y+8)).normalize();
        knockPlayer(direction,520*force*remaining,strength*remaining);
      }
    }
    for(const victim of roster){
      if(!enemies(doomsday,victim) || victim.vitals.defeated || victim.held)continue;
      const force=hit(victim.pos);if(force<=0)continue;
      const direction=victim.pos.clone().sub(origin);direction.y=Math.max(8,direction.y);direction.normalize();
      victim.strike(direction,zero,520*force,false,200*force,2,sourceFor(doomsday,"nova"));
    }
    sound.doomsdayEnergy("nova-blast",origin);
    hud.shake=Math.max(hud.shake,1.2/(1+player.pos.distanceToSquared(origin)/4000));
    hitPause(.12);
  };
  const novaDirection=new THREE.Vector3();
  const blastWind=new THREE.Vector3();
  const updateNovaWake=(dt:number)=>{
    const wake=novaWake;
    if (dt <= 0) return;
    if (!wake) {
      if (combatLight.intensity > 0) {
        combatLight.intensity *= Math.exp(-dt * 15);
        if (combatLight.intensity < .25) combatLight.intensity = 0;
      }
      return;
    }
    wake.age+=dt;
    combatLight.intensity=wake.radius*wake.radius*4*Math.exp(-wake.age*10);
    const duration=3.5;
    if(wake.age>=duration){novaWake=null;combatLight.intensity=0;return;}
    // Follow the leading ring, then keep applying outward pressure in its wake.
    const front=wake.radius*(.6+5*THREE.MathUtils.smoothstep(wake.age,0,1.05))/5.6;
    const push=(body:typeof player | Faora)=>{
      if(body.vitals.frozen || body instanceof Faora && (body.vitals.defeated || body.vitals.inReviveGrace || body.held || body.superBlocking || body.infinityProtects))return;
      novaDirection.subVectors(body.pos,wake.origin);novaDirection.y+=1;
      const distance=novaDirection.length();
      if(distance>front)return;
      let cover=wake.cover.get(body);
      if(cover===undefined){
        cover=wake.owner.lineClear(wake.origin,wake.origin.clone().add(novaDirection))?1:.15;
        wake.cover.set(body,cover);
      }
      novaDirection.y=Math.max(3,novaDirection.y+distance*.12);
      novaDirection.normalize();
      const falloff=(1-.65*distance/wake.radius)*cover;
      const fade=1-THREE.MathUtils.smoothstep(wake.age,1.05,duration);
      if(body===player){
        // The gust reaches the camera even when allies or Super Block keep you safe.
        blastWind.copy(novaDirection).multiplyScalar(240*falloff*fade);
        if(observerMode || !wake.hostile || player.vitals.defeated || player.superBlock.active || player.vitals.inReviveGrace)return;
      }
      const outward=body.vel.dot(novaDirection);
      const impulse=Math.min(280*falloff*fade*dt,Math.max(0,95*falloff-outward));
      if (body === sukuna) {
        if (!sukuna.ragdoll.active && !sukuna.hasSukunaChargeArmor) sukuna.applyDoomsdayShove(novaDirection, impulse);
        return;
      }
      if(body instanceof Faora && body.ragdoll.active){
        for(const velocity of body.ragdoll.velocity)velocity.addScaledVector(novaDirection,impulse);
      }
      body.vel.addScaledVector(novaDirection,impulse);
      if(body===player)hud.shake=Math.max(hud.shake,.55*falloff*fade);
    };
    push(player);
    for(const fighter of activeFighters())if(fighter!==wake.owner && fighter.enemyMode!==wake.enemyTeam)push(fighter);
  };
  laserVision.onCharge = () => sound.laser(false, faora.pos);
  laserVision.onFire = () => sound.laser(true, faora.pos);
  laserVision.onBurn = (point, group) => destruction.burn(point, .6, group);
  laserVision.onHit = (strength, target) => {
    if (target !== player) {
      const victim = faora.opponent;
      if (victim?.asTarget === target) victim.strike(look.subVectors(victim.pos, faora.pos).normalize(), zero, 0, false, strength,1,sourceFor(faora,"beam"));
      return;
    }
    const remaining = defend(strength);
    if (remaining > 0) { player.receiveHit(strength * remaining,1,sourceFor(faora,"beam")); hud.shake = Math.max(hud.shake, .18); }
  };
  // Compile hidden fighters' and the laser's shaders now, not as a hitch the first time they appear.
  const hidden = roster.filter(fighter => !fighter.model.visible);
  hidden.forEach(fighter => fighter.model.visible = true); laserVision.warm = true;doomsdayPowers.warm=true;damageEffects.fx.warm=true;
  gojoPowers.warmEffects(renderer, true);
  renderer.compile(scene, camera);
  fx.render(0, false, true);
  gojoPowers.warmEffects(renderer, false);
  hidden.forEach(fighter => fighter.model.visible = false); laserVision.warm = false;doomsdayPowers.warm=false;damageEffects.fx.warm=false;
  Object.assign(window, { laserVision });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    fx.setSize(innerWidth, innerHeight);
  });

  // expose for debugging in devtools
  Object.assign(window, { player, terrain, trees, hf, camera, sound, fx, destruction, faora, anissa, beast, doomsday,doomsdayPowers,sukuna,sukunaPowers,gojo,gojoPowers,interactions, atmosphere, scenery });

  // Who each fighter goes after, rechecked twice a second with a bias toward keeping the current target.
  const retarget = new Map<Faora, number>();
  const observerInput = document.getElementById("observer-mode") as HTMLInputElement;
  const observerStatus = document.getElementById("ui-observer")!;
  const updateObserverMode = () => {
    observerMode = observerInput.checked;
    observerStatus.hidden = !observerMode;
    retarget.clear();
    if (!observerMode) return;
    if (faoraInterrupter === player) {
      faoraInterrupter = null;
      faora.rescueCountering = false;
    }
    if (anissaGrab.holdingPlayer) anissaGrab.end();
    gojoPowers.releaseDomainTarget(player);
    sukunaPowers.releaseTarget(sukuna, player);
  };
  observerInput.addEventListener("change", updateObserverMode);
  updateObserverMode();
  const valid = (fighter: Faora, other: Faora) => enemies(fighter, other) && !other.vitals.defeated && !other.held;
  const pickOpponent = (fighter: Faora): Faora | null => {
    const current = fighter.opponent;
    if (!fighter.enemyMode) {
      return friendOpponent(fighter,roster,player.pos);
    }
    // A foe: you, or whichever friend is closest. You're the favourite target, and switching takes a clear reason.
    let best: Faora | null = null;
    let bestScore = observerMode || player.vitals.defeated ? Infinity : fighter.pos.distanceTo(player.pos) * .8 * (current === null ? .8 : 1);
    for (const other of roster) {
      if (!valid(fighter, other)) continue;
      const score = other.pos.distanceTo(fighter.pos) * (other === current ? .8 : 1);
      if (score < bestScore) { bestScore = score; best = other; }
    }
    return best;
  };
  const chooseOpponents = (dt: number) => {
    if(doomsdayActive)doomsday.trackedTargets=doomsdayAwareness(doomsday,activeFighters(),playerCombatTarget()).known;
    for (const fighter of roster) {
      if (!isDeployed(fighter) || fighter.vitals.defeated || fighter.rescueTarget) { fighter.opponent = null; continue; }
      if (fighter === faora && faoraInterrupter) {
        fighter.opponent = faoraInterrupter instanceof Faora ? faoraInterrupter : null;
        continue;
      }
      if ((fighter === sukuna || fighter === gojo) && fighter.specialChanneling) continue;
      if (fighter === anissa && (anissaGrab.active || fighter.attackCommitted
        && (fighter.opponent ? valid(fighter,fighter.opponent) : fighter.hostile && !observerMode && !player.vitals.defeated))) continue;
      if(fighter.isDoomsday){
        const currentValid=fighter.opponent?valid(fighter,fighter.opponent):!observerMode && !player.vitals.defeated && (fighter.enemyMode || fighter.hostile);
        if(fighter.attackCommitted && currentValid)continue;
        fighter.opponent=doomsdayAwareness(fighter,activeFighters(),playerCombatTarget()).opponent;
        continue;
      }
      const left = (retarget.get(fighter) ?? 0) - dt;
      const stale = fighter.opponent !== null && !valid(fighter, fighter.opponent);
      if (left > 0 && !stale && !(fighter.recallTime > 0 && fighter.opponent)) { retarget.set(fighter, left); continue; }
      retarget.set(fighter, .5);
      fighter.opponent = pickOpponent(fighter);
    }
  };

  const updateRescuePriorities = (dt: number) => {
    const hasCasualty = (fighter: Faora) =>
      activeFighters().some(other => other !== fighter && other.enemyMode === fighter.enemyMode && other.vitals.downed)
      || (!fighter.enemyMode && player.vitals.downed);
    const faoraNeedsRescue = hasCasualty(faora) && !persistence.covers(faora.enemyMode);
    faoraCounterTime = Math.max(0, faoraCounterTime - dt);
    if (!faoraNeedsRescue || !faoraActive || faora.vitals.defeated || faoraCounterTime === 0
      || faoraInterrupter?.vitals.defeated
      || (faoraInterrupter instanceof Faora && !valid(faora, faoraInterrupter))
      || (faoraInterrupter === player && (player.held || !faora.hostile))) faoraInterrupter = null;
    faora.rescueCountering = faoraInterrupter !== null;

    const anissaHasCasualty = hasCasualty(anissa);
    const opponent = anissa.opponent && valid(anissa, anissa.opponent)
      ? anissa.opponent : pickOpponent(anissa) ?? (anissa.hostile ? playerCombatTarget() : null);
    const healthyOpponent = opponent && !opponent.vitals.defeated
      && opponent.vitals.healthFraction > .6 && anissa.pos.distanceToSquared(opponent.pos) <= 120 ** 2;
    anissa.rescuePressure = anissaHasCasualty && !!healthyOpponent;
    anissa.rescueRecovery = anissaHasCasualty && anissa.vitals.healthFraction < .55;
  };

  const rescueUnits=():RescueUnit[]=>{
    const deployed=activeFighters();
    const targets = new Map<string, CombatTarget>([["YOU", player], ...deployed.map(fighter => [fighter.name, fighter.asTarget] as const)]);
    const sight=(from:THREE.Vector3,to:THREE.Vector3)=>{
      const a=from.clone();a.y+=1;
      const b=to.clone();b.y=Math.max(b.y+.9,destruction.spans(b.x,b.z).floor(b.y+2)+.2);
      return faora.lineClear(a,b);
    };
    const units:RescueUnit[]=[{
      id:"YOU",enemy:false,pos:player.pos,vitals:player.vitals,canHelp:holdingAid && locked(),maxDistance:3.5,manual:true,
      canReach:other=>sight(player.pos,other.pos),setGoal:()=>{},revive:()=>revivePlayer(),persistentRevive:()=>revivePlayer(true),
    }];
    for(const fighter of deployed)units.push({
      id:fighter.name,enemy:fighter.enemyMode,pos:fighter.pos,vitals:fighter.vitals,
      canBeHelped:!fighter.held,canHelp:(!fighter.retreating || fighter === beast) && !fighter.held && !fighter.vitals.defeated && !fighter.ragdoll.active && (!fighter.hostile || fighter.enemyMode)
        && (!fighter.isDoomsday || !doomsdayAwareness(fighter,activeFighters(),playerCombatTarget()).hasTarget)
        && (fighter !== beast || fighter.vitals.healthFraction <= .15 || fighter.rescueTarget !== null)
        && (fighter !== anissa || (!fighter.rescueRecovery && !fighter.rescuePressure && !fighter.attackCommitted))
        && (fighter !== faora || !fighter.rescueCountering),
      rescuePriority: fighter === faora ? 1 : fighter === beast ? -1 : 0,
      maxDistance:Infinity,groundOnly:fighter.groundOnly && fighter !== beast,
      canReach:other=>sight(fighter.pos,other.pos),
      setGoal:other=>{fighter.rescueTarget=other?targets.get(other.id)??null:null;},
      persistentRevive:()=>{
        if(interactions.carrying===fighter)interactions.drop();
        if(!fighter.revive(true))return false;
        refreshRecovery();hud.toast(fighter.name.toUpperCase(),"Back");return true;
      },
      revive:()=>{
        if(!fighter.revive())return false;
        refreshRecovery();hud.toast(fighter.name.toUpperCase(),"Revived");
        return true;
      },
    });
    return units;
  };
  const revivePanel=document.getElementById("revive-status")!;
  const reviveLabel=document.getElementById("revive-label")!;
  const reviveDetail=document.getElementById("revive-detail")!;
  const reviveFill=document.getElementById("revive-fill")!;
  const updateReviveHud=()=>{
    const nearby=activeFighters().filter(fighter=>!fighter.enemyMode && fighter.vitals.defeated && (persistence.enabled || fighter.vitals.downed) && !fighter.held && fighter.pos.distanceTo(player.pos)<4.5)
      .sort((a,b)=>a.pos.distanceToSquared(player.pos)-b.pos.distanceToSquared(player.pos))[0];
    const downed=player.vitals.downed || (player.vitals.defeated && persistence.enabled);
    revivePanel.hidden=!overlay.classList.contains("hidden") || (!downed && (!nearby || player.vitals.defeated));
    if(revivePanel.hidden)return;
    if(persistence.enabled){
      const id=downed?"YOU":nearby.name;
      reviveLabel.textContent=`${downed?"RETURNING":nearby.name.toUpperCase()+" RETURNS"} IN ${Math.ceil(persistence.remainingFor(id))}s`;
      reviveDetail.textContent="";
      const progress=persistence.progressFor(id);reviveFill.style.transform=`scaleX(${progress})`;
      revivePanel.setAttribute("aria-valuenow",`${Math.round(progress*100)}`);return;
    }
    const helper=revivals.helperFor(downed?"YOU":nearby.name);
    reviveLabel.textContent=downed?(helper?`${helper.toUpperCase()} IS REVIVING YOU`:"MASH CLICK TO GET UP"):`HOLD T · REVIVE ${nearby.name.toUpperCase()}`;
    reviveDetail.textContent=downed?`${player.vitals.revivesRemaining} revives left`:"";
    const progress=downed?Math.max(selfRevive.progress,revivals.progressFor("YOU")):revivals.progressFor(nearby.name);
    reviveFill.style.transform=`scaleX(${progress})`;
    revivePanel.setAttribute("aria-valuenow",`${Math.round(progress*100)}`);
  };

  const targetView = new TargetView(renderer, scene, fog, document.getElementById("target-view")!);
  renderer.info.autoReset = false;
  const tracker = new PerformanceTracker(() => ({
    fighters: activeFighters().length,
    deployedFighters: activeFighters().map(fighter => fighter.name).join(", "),
    ...terrain.performanceStats,
    ...destruction.performanceStats,
    terrainColliderTiles: interactions.terrainColliderTileCount,
    atmosphereTrackedBodies: atmosphere.trackedBodyCount,
    routedAudioVoices: sound.activeRoutedVoices,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    gpuGeometries: renderer.info.memory.geometries,
    gpuTextures: renderer.info.memory.textures,
    pixelRatio: renderer.getPixelRatio(),
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    jsHeapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize,
  }));
  let ready = false;
  let last = performance.now();
  const voidPlayerOrigin = new THREE.Vector3();
  const voidFighterOrigins = roster.map(() => new THREE.Vector3());
  const sealPlayer = (from: THREE.Vector3) => {
    if (!observerMode && gojoPowers.sealEntry(from, player.pos, player.vel) && player.held) anissaGrab.end();
  };
  const sealProp = (before: THREE.Vector3, after: THREE.Vector3, velocity: THREE.Vector3, radius: number) =>
    gojoPowers.sealEntry(before, after, velocity, 0, radius);
  const voidCorrection = new THREE.Vector3();
  const voidUnconstrained = new THREE.Vector3();
  const inVoidMarker = (fighter: Faora) => fighter.vitals.frozen || gojoPowers.insideVoid(fighter.pos);
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const elapsed=Math.max(0,(now-last)/1000);
    const real = Math.min(0.05, elapsed);
    hitFeed.update(overlay.classList.contains("hidden")?elapsed:0,overlay.classList.contains("hidden"));
    last = now;
    // the world runs on scaled time; camera easing and UI below keep real time
    let scale = 1;
    if (hitstop > 0) { hitstop -= real; scale = 0.03; }
    else if (slowmo > 0) { slowmo -= real; scale = 0.25 + 0.75 * Math.max(0, 1 - slowmo / 0.35); }
    const dt = real * scale;
    impactDamageCooldown = Math.max(0, impactDamageCooldown - dt);
    blastWind.set(0,0,0);
    const playing=ready && encounterStarted && overlay.classList.contains("hidden");
    tracker.begin(now, playing ? "playing" : ready ? "paused" : "loading", scale);
    if(playing){
      player.superBlock.update(elapsed);
      player.vitals.advanceReviveGrace(elapsed);
      for(const fighter of activeFighters())fighter.vitals.advanceReviveGrace(elapsed);
    }
    const shield=player.superBlock;
    superBlockPanel.hidden=!playing || player.vitals.defeated || (!shield.active && shield.cooldown===0 && combat.mode!=="guard");
    superBlockPanel.classList.toggle("shield-active",shield.active);
    superBlockPanel.classList.toggle("shield-cooldown",shield.cooldown>0);
    superBlockPanel.style.setProperty("--shield-progress",String(shield.active?shield.remaining/3:1-shield.cooldown/2));
    superBlockPanel.setAttribute("aria-label",shield.active?"Super Block active":shield.cooldown>0?"Super Block recharging":"Super Block ready");
    document.body.classList.toggle("super-block-active",playing && shield.active);

    sound.setListener(player.pos, player.yaw);
    if (playing && !player.vitals.frozen) {
      if (lockedTarget && (lockedTarget.vitals.defeated || lockedTarget.held || !lockedTarget.hostile)) {
        lockedTarget = null; followUp.cancel(); pursuitSuppressed = pursuitHeld;
      }
      if (followUp.active) {
        followUp.update(dt, player);
        if (!followUp.active && pursuitHeld) pursuitHeldTime=0;
        if(followUp.waitingForRoute && pursuitNotice!=="Finding a clear route"){
          pursuitNotice="Finding a clear route";hud.toast("PURSUIT",pursuitNotice);
        }else if(!followUp.waitingForRoute)pursuitNotice="";
      } else if (pursuitHeld && !pursuitSuppressed && lockedTarget && combat.mode !== "guard") {
        pursuitHeldTime += dt;
        if (pursuitHeldTime >= .18) {
          const reason=pursuitBlockReason(player,lockedTarget,combat.mode==="idle");
          if(reason){
            if(pursuitNotice!==reason){pursuitNotice=reason;hud.toast("PURSUIT",reason);}
          }else if(followUp.start(player,lockedTarget)){
            pursuitNotice="";sound.launch(.3);
          }
          // Temporary blockers never latch off the rest of this R hold.
        }
      }
    }
    const voidWasActive = gojoPowers.domainActive;
    if (ready && (overlay.classList.contains("hidden") || player.vitals.defeated)) {
      if (gojoPowers.domainActive) voidPlayerOrigin.copy(player.pos);
      player.update(dt, followUp.active ? checkRam : undefined, gojoPowers.domainActive ? sealPlayer : undefined);
    }
    if (playing) {
      if (lockedTarget && !player.vitals.defeated && !player.vitals.frozen) {
        const aim = lockedTarget.pos.clone().add(new THREE.Vector3(0, 1, 0)).sub(player.pos.clone().add(new THREE.Vector3(0, 1.5, 0)));
        const yaw = Math.atan2(-aim.x, -aim.z);
        const pitch = Math.atan2(aim.y, Math.hypot(aim.x, aim.z));
        const blend = 1 - Math.exp(-dt * 2.5);
        player.yaw += Math.atan2(Math.sin(yaw - player.yaw), Math.cos(yaw - player.yaw)) * blend;
        player.pitch += (THREE.MathUtils.clamp(pitch, -1.55, 1.55) - player.pitch) * blend;
      }
    }
    player.applyCamera(camera);
    tracker.mark("Player");
    if (playing) {
      momentumWaves.update(dt);
      interactions.update(dt, camera, player, gojoPowers.domainActive ? sealProp : undefined);
    }
    tracker.mark("Prop physics");
    if (playing) {
      if (gojoPowers.domainActive) for (const [i, fighter] of roster.entries()) voidFighterOrigins[i].copy(fighter.pos);
      selfRevive.update(real,now/1000);
      updateRescuePriorities(dt);
      const units=rescueUnits();
      persistence.update(elapsed,units);
      revivals.update(dt,units.filter(unit=>!persistence.covers(unit.enemy) || !unit.vitals.defeated));
      chooseOpponents(dt);
      const enemyFighters=activeFighters().filter(fighter=>fighter.enemyMode && !fighter.vitals.defeated);
      const targetDistance = (fighter: Faora) => {
        const target = combatTargetFor(fighter);
        return target ? fighter.pos.distanceTo(target.pos) : Infinity;
      };
      const leader=enemyFighters.find(fighter=>fighter.rescueTarget) ?? enemyFighters.sort((a,b)=>targetDistance(a)-targetDistance(b))[0];
      for(const fighter of activeFighters())fighter.supportAnchor=fighter.enemyMode && !fighter.rescueCountering && !fighter.rescuePressure && leader && fighter!==leader?leader.asTarget:null;
      updateNovaWake(dt);
      if (!doomsday.vitals.frozen) doomsdayPowers.update(dt,doomsday,combatTargetFor(doomsday),doomsdayActive);
      // His anti-domain timers keep running even while the Void holds him frozen.
      if (sukunaActive) sukunaPowers.defense.update(dt);
      if (sukunaActive && !sukuna.vitals.frozen) {
        const targets = activeFighters().filter(fighter => enemies(sukuna, fighter) && !fighter.held).map(fighter => fighter.asTarget);
        if (!observerMode && sukuna.hostile && !player.held) targets.push(player);
        const domainTargets = activeFighters().filter(fighter => fighter !== sukuna).map(fighter => fighter.asTarget);
        if (!observerMode) domainTargets.unshift(player);
        sukunaPowers.update(dt, sukuna, combatTargetFor(sukuna), targets, true, domainTargets, elapsed);
      }
      if (gojoActive) {
        const targets = activeFighters().filter(fighter => enemies(gojo, fighter) && !fighter.held).map(fighter => fighter.asTarget);
        if (!observerMode && gojo.hostile && !player.held) targets.push(player);
        const domainTargets = activeFighters().filter(fighter => fighter !== gojo).map(fighter => fighter.asTarget);
        if (!observerMode) domainTargets.unshift(player);
        // Only an enemy's Shrine is a threat to answer; an ally's is left alone.
        const rival = sukunaActive && enemies(gojo, sukuna);
        gojoPowers.hostileDomain = rival ? sukunaPowers.domain : null;
        gojoPowers.hostileCaster = rival ? sukuna.asTarget : null;
        gojoPowers.update(dt, gojo,combatTargetFor(gojo), targets, domainTargets, elapsed);
      }
      // Domain clash: when Unlimited Void and Malevolent Shrine overlap, both cancel out and both casters burn out three times as long.
      const shrineDomain = sukunaPowers.domain, voidDomain = gojoPowers.voidDomain;
      if (shrineDomain && voidDomain && enemies(gojo, sukuna)
        && shrineDomain.center.distanceTo(voidDomain.center) < shrineDomain.radius + voidDomain.radius) {
        sukunaPowers.shatterDomain(sukuna, CLASH_BURNOUT_SCALE);
        gojoPowers.shatterDomain(gojo, CLASH_BURNOUT_SCALE);
        const middle = shrineDomain.center.clone().lerp(voidDomain.center, .5);
        damageEffects.fx.nova(middle, Math.min(60, Math.max(shrineDomain.radius, voidDomain.radius)));
        sound.gojo("void-pulse", middle);
        sound.sukuna("shrine-pulse", middle);
        hud.toast("DOMAIN CLASH", "Both domains shattered");
        hud.shake = Math.max(hud.shake, 1 / (1 + player.pos.distanceToSquared(middle) / 4000));
        hitPause(.1);
      }
      tracker.mark("Fighter setup");
      if (gojoPowers.domainActive && !voidWasActive) {
        for (const [i, fighter] of roster.entries()) voidFighterOrigins[i].copy(fighter.pos);
      }
      // Each fighter pursues and attacks independently.
      if (faoraActive) { faora.update(dt, player, fog, elapsed); tracker.mark("Faora-Ul"); }
      if (anissaActive) { anissa.update(dt, player, fog, elapsed); tracker.mark("Anissa"); }
      if (beastActive) { beast.update(dt, player, fog, elapsed); tracker.mark("Battle Beast"); }
      if (doomsdayActive) { doomsday.update(dt, player, fog, elapsed); tracker.mark("Doomsday"); }
      if (sukunaActive) { sukuna.update(dt, player, fog, elapsed); tracker.mark("Sukuna"); }
      if (gojoActive) {
        gojo.update(dt, player, fog, elapsed);
        gojoPowers.syncShield(gojo);
        tracker.mark("Satoru Gojo");
      }
      anissaGrab.update(dt,captive=>isDeployed(anissa) && (captive === player
        ? anissa.hostile && !observerMode : captive instanceof Faora && isDeployed(captive) && enemies(anissa,captive)));
      const wasHeld = player.held;
      if (gojoPowers.domainActive) {
        if (wasHeld && voidWasActive) sealPlayer(voidPlayerOrigin);
        for (const [i, fighter] of roster.entries()) {
          if (fighter === gojo || !isDeployed(fighter) || fighter.vitals.frozen) continue;
          voidUnconstrained.copy(fighter.pos);
          if (!gojoPowers.sealEntry(voidFighterOrigins[i], fighter.pos, fighter.vel, fighter.bodyScale, .55 * fighter.bodyScale)) continue;
          if (anissaGrab.holds(fighter)) anissaGrab.end();
          if (interactions.carrying === fighter) interactions.drop();
          if (fighter.ragdoll.active) {
            voidCorrection.subVectors(fighter.pos, voidUnconstrained);
            fighter.ragdoll.translate(voidCorrection, fighter.vel);
          } else fighter.model.position.copy(fighter.pos);
        }
      }
      // Nobody walks out of the closed Malevolent Shrine.
      if (sukunaPowers.domain?.form === "barrier") {
        if (!observerMode && barrierTrapped.has(player)) sukunaPowers.confine(player.pos, player.vel);
        for (const fighter of activeFighters()) {
          if (fighter === sukuna || !barrierTrapped.has(fighter) || fighter.vitals.frozen) continue;
          barrierUnconstrained.copy(fighter.pos);
          if (!sukunaPowers.confine(fighter.pos, fighter.vel)) continue;
          if (fighter.ragdoll.active) {
            barrierCorrection.subVectors(fighter.pos, barrierUnconstrained);
            fighter.ragdoll.translate(barrierCorrection, fighter.vel);
          } else fighter.model.position.copy(fighter.pos);
        }
      } else barrierTrapped.clear();
      if (wasHeld) player.applyCamera(camera);
      if (!doomsday.vitals.frozen) doomsdayPowers.syncPose(doomsday);
      if(!doomsday.vitals.frozen && doomsdayPowers.beamImpact)damageEffects.fx.beamImpact(doomsdayPowers.beamImpact,doomsdayPowers.beamDirection,dt,2.4,true);
      const counterGrab = !observerMode && interactions.carrying === faora && faora.hostile;
      if (!faora.vitals.frozen) laserVision.update(dt, faora, counterGrab ? player : combatTargetFor(faora), faoraActive, counterGrab);
      if(!faora.vitals.frozen && laserVision.impacting)damageEffects.fx.beamImpact(laserVision.impactPoint,laserVision.beamDirection,dt,.7,false);
    }
    tracker.mark("Fighter powers");

    // speed sells the flight: widen FOV, shake past Mach 1
    const nearApex = !player.flying && !player.onGround && !player.inWater && player.altitudeAGL > 30 && Math.abs(player.vel.y) < 12;
    damageEffects.update(dt, player.vitals.health, real);
    sound.update(player.speed, player.airDensity, player.underwater, nearApex, blastWind.length(), gojoPowers.insideVoid(camera.position));
    // charging a punch narrows the view; throwing it kicks the view wide
    const tenth = Math.floor(combat.attack * 10), wasSmash = combat.attack >= SMASH_FROM;
    combat.update(dt * player.vitals.control, player.shiftHeld);
    player.combatAttacking = followUp.active || combat.mode === "attack";
    player.combatAttackCharge = followUp.active ? .85 : combat.mode === "attack" ? combat.attack : 0;
    player.combatGuard = combat.mode === "guard" ? combat.guard : 0;
    if (combat.mode === "attack" && Math.floor(combat.attack * 10) > tenth) sound.tick(combat.attack);
    if (combat.mode === "attack" && !wasSmash && combat.attack >= SMASH_FROM) sound.grunt("strain", "player", combat.attack);
    chargeRing.classList.toggle("on", combat.mode === "attack");
    chargeRing.style.setProperty("--c", `${combat.attack}`);
    chargeRing.classList.toggle("smash", combat.attack >= SMASH_FROM);
    document.getElementById("ui-guard")!.classList.toggle("active", combat.mode === "guard");
    document.getElementById("ui-guard-value")!.textContent = `${Math.floor(combat.guard)}`;
    document.getElementById("ui-guard-fill")!.style.transform = `scaleX(${combat.guard / 100})`;
    guardFeedback -= dt;
    if (guardFeedback <= 0) guardResult.textContent = "";
    punchKick *= Math.exp(-dt * 3);
    const targetFov = 68 + Math.min(26, Math.log2(1 + player.speed / 30) * 5.5) - combat.attack * 8 + punchKick;
    camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-4 * real));
    camera.updateProjectionMatrix();
    fx.update(dt, player, fog, blastWind);
    camera.rotation.x -= impactPitch + launchKick;
    camera.rotation.z += impactRoll + punchRoll;
    // the punch lunges the view along the strike, then settles back
    camera.position.addScaledVector(camera.getWorldDirection(look), punchLunge);
    punchLunge *= Math.exp(-real * 10);
    punchRoll *= Math.exp(-real * 8);
    fist.update(dt, followUp.active ? .7 : combat.mode === "attack" && !combat.kick ? combat.attack : -1);
    leftFist.update(dt, followUp.active ? .7 : -1);
    kickView.update(dt,combat.mode==="attack" && combat.kick?combat.attack:-1);
    impactPitch *= Math.exp(-dt * 7);
    impactRoll *= Math.exp(-dt * 7);
    launchKick *= Math.exp(-dt * 9);
    const a = hud.shake * hud.shake * 0.02 + fx.buffet;
    if (a > 0) {
      camera.rotation.x += (Math.random() - 0.5) * a;
      camera.rotation.y += (Math.random() - 0.5) * a;
      camera.rotation.z += (Math.random() - 0.5) * a * 0.5;
    }

    // haze thins out as you climb
    const agl = Math.max(0, player.altitudeAGL);
    const targetHaze = 6.0e-5 / (1 + agl / 2200 + Math.max(0, player.pos.y - 2000) / 3500);
    fog.density += (targetHaze - fog.density) * (1 - Math.exp(-dt * 1.5));

    tracker.mark("View and effects");
    destruction.update(dt, camera, real);
    tracker.mark("Destruction");
    atmosphere.update(dt, camera, fog, player.vel);
    listenerEye.copy(player.pos).y += 1.6;
    for (const {fighter,collar,flyby} of collars) {
      const airborne = fighter.model.visible && !fighter.held && !fighter.asTarget.onGround;
      collar.update(fighter.pos,fighter.vel,fighter.bodyScale,airborne,now/1000,cloudDensityAt);
      if(playing)flyby.update(real,fighter.pos,fighter.vel,airborne,listenerEye,hearFlyby);
    }
    tracker.mark("Atmosphere");
    const overhead = destruction.spans(camera.position.x, camera.position.z).ceil(camera.position.y) < camera.position.y + 60;
    eyes.intensity += ((overhead ? 12 : 0) - eyes.intensity) * Math.min(1, dt * 3);
    terrain.underground = overhead;
    eyes.position.copy(camera.position);
    const landing = destruction.debris.nearbyLanding(camera.position, 45);
    if (landing && performance.now() - lastBreakSound > 90) {
      sound.step("hard", Math.min(6, landing.count), landing.point);
      lastBreakSound = performance.now();
    }
    terrain.update(camera, real);
    trees.update(camera.position, terrain.treeVoxelRange);
    const groundY = hf.height(camera.position.x, camera.position.z, 4);
    const insideVoid = gojoPowers.insideVoid(camera.position);
    sun.shadow.intensity = (insideVoid ? 0 : .61) * (1 - THREE.MathUtils.smoothstep(camera.position.y - groundY, 32, 82));
    if (sun.shadow.intensity > 0) {
      const snap = 112 / sun.shadow.mapSize.x;
      const x = Math.round(camera.position.x / snap) * snap, z = Math.round(camera.position.z / snap) * snap;
      sun.target.position.set(x, Math.round(groundY / 4) * 4, z);
      sun.position.copy(sun.target.position).addScaledVector(sunDirection, 115);
      renderer.shadowMap.needsUpdate = true;
    }
    tracker.mark("Terrain and trees");
    if (!ready && terrain.pendingCount === 0 && terrain.chunkCount > 0) {
      ready = true;
      Object.assign(window, { gameReady: true });
      status.textContent = "";
      (document.getElementById("resume-game") as HTMLButtonElement).disabled = false;
      overlay.classList.add("ready");
    }
    hud.update(player, camera, dt);
    updateReviveHud();
    const captive = interactions.carrying;
    const holdingFighter = captive instanceof Faora;
    const escaping = anissaGrab.holdingPlayer;
    escapeIcon.hidden = !playing || (!holdingFighter && !escaping) || player.vitals.defeated;
    escapeIcon.classList.toggle("player-escape",escaping);
    if (!escapeIcon.hidden) {
      escapeIcon.style.setProperty("--escape-progress",String(escaping ? anissaGrab.progress : captive instanceof Faora ? captive.escapeProgress : 0));
    }
    hud.updatePrompt(encounterStarted && !holdingFighter && !escaping ? interactions.prompt : null);
    hud.lockedTarget = lockedTarget;
    document.getElementById("followup-cue")!.classList.toggle("active", !!lockedTarget && !pursuitHeld && !escaping && combat.mode === "idle" && player.vitals.orientation >= 35 && !player.vitals.defeated);
    hud.updateFighterMarkers(camera, insideVoid ? inVoidMarker : undefined);
    tracker.mark("HUD");
    if (playing && !document.hidden && elapsed > 0 && elapsed < .25) {
      resolutionTime += elapsed;
      resolutionFrames++;
      if (resolutionTime >= 1) {
        const frameTime = resolutionTime / resolutionFrames;
        const previous = renderScaleIndex;
        if (frameTime > .0185) {
          if (renderScaleIndex === 0 || frameTime > .0235) {
            renderScaleIndex = Math.min(renderScales.length - 1, renderScaleIndex + 1);
          }
          recoveryTime = 0;
        } else {
          recoveryTime = frameTime < .0174 ? recoveryTime + resolutionTime : 0;
          if (recoveryTime >= 5 && renderScaleIndex > 0) { renderScaleIndex--; recoveryTime = 0; }
        }
        resolutionTime = resolutionFrames = 0;
        if (renderScaleIndex !== previous) {
          // Relax distant geometry first. Resizing the framebuffers is reserved for sustained load.
          terrain.pixelError = 5 + .7 * renderScaleIndex;
          const ratio = Math.max(Math.min(.65, nativeRatio), nativeRatio * renderScales[renderScaleIndex]);
          if (ratio !== renderer.getPixelRatio()) {
            renderer.setPixelRatio(ratio);
            fx.setSize(innerWidth, innerHeight);
          }
        }
      }
    } else resolutionTime = resolutionFrames = recoveryTime = 0;
    renderer.info.reset();
    fx.render(real, laserVision.impacting || Boolean(doomsdayPowers.beamImpact), insideVoid, gojoPowers.voidPulse);
    tracker.mark("Main render");
    targetView.render(camera, lockedTarget, [fist.group,kickView.group], real);
    tracker.mark("Target view");
    hud.updateNavigation(player, camera, !insideVoid && overlay.classList.contains("hidden"));
    tracker.end();
  });
}

main().catch((e) => {
  document.getElementById("status")!.textContent = `Failed to start: ${e.message}`;
  console.error(e);
});
