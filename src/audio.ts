// Web Audio mixer for recorded fighter cues and procedural world sound.
import type { MaterialProps } from "./terrain/heightfield";
import type { Vector3 } from "three";
import { soundSpeed } from "./player";

type Timbre = MaterialProps["sound"];

export type Grunt = "effort" | "strain" | "stagger" | "pain" | "yell";
type CursedVoice = "gojo" | "sukuna";
type HurtGrunt = "stagger" | "pain" | "yell";
export type Voice = "player" | "faora" | "anissa" | "beast" | "doomsday" | CursedVoice;
type FighterVoice = Exclude<Voice, "player">;
type SukunaCue = "cut" | "cleave" | "world-charge" | "world-fire" | "fuga-charge" | "fuga-fire" | "fuga-blast"
  | "shrine-charge" | "shrine-open" | "shrine-pulse" | "rct" | "black-flash";
type EnergyCue = "beam-fire" | "beam-charge" | "nova-charge" | "nova-blast";
export type GojoCue = "blue-charge" | "red-charge" | "purple-charge" | "void-charge" | "blue-form"
  | "red-fire" | "purple-fire" | "blue-strike" | "red-burst" | "purple-burst" | "void-close" | "void-pulse"
  | "infinity" | "blink" | "rct" | "black-flash";

const PLAYER_VOICE = { pitch: 104, formant: 1, breath: .22 };
const FIGHTER_VOICES = {
  gojo: {
    range: 160, echo: .07,
    clips: { effort: "gojo-effort", strain: "gojo-effort", stagger: "gojo-stagger", pain: "gojo-pain", yell: "gojo-pain" },
  },
  sukuna: {
    range: 175, echo: .11,
    clips: { effort: "sukuna-effort", strain: "sukuna-effort", stagger: "sukuna-stagger", pain: "sukuna-pain", yell: "sukuna-pain" },
  },
  faora: {
    range: 150, echo: .08,
    clips: { effort: "faora-effort", strain: "faora-strain", stagger: "faora-stagger", pain: "faora-pain", yell: "faora-yell" },
  },
  anissa: {
    range: 175, echo: .1,
    clips: { effort: "anissa-effort", strain: "anissa-strain", stagger: "anissa-stagger", pain: "anissa-pain", yell: "anissa-yell" },
  },
  beast: {
    range: 230, echo: .17,
    clips: { effort: "beast-snarl", strain: "beast-growl", stagger: "beast-snarl", pain: "beast-growl", yell: "beast-roar" },
  },
  doomsday: {
    range: 320, echo: .27,
    clips: { effort: "doomsday-bark", strain: "doomsday-growl", stagger: "doomsday-bark", pain: "doomsday-growl", yell: "doomsday-roar" },
  },
} as const satisfies Record<FighterVoice, { range: number; echo: number; clips: Record<Grunt, string> }>;

const CURSED_LINES = {
  gojo: {
    blue: "gojo-blue", red: "gojo-red", purple: "gojo-purple", void: "gojo-void",
  },
  sukuna: {
    dismantle: "sukuna-dismantle", cleave: "sukuna-cleave", world: "sukuna-world",
    fuga: "sukuna-fuga", shrine: "sukuna-shrine", closer: "sukuna-closer", impress: "sukuna-impress",
  },
} as const;

const FIGHTER_CLIPS = new Set([
  ...Object.values(FIGHTER_VOICES).flatMap(({ clips }) => Object.values(clips)),
  ...Object.values(CURSED_LINES).flatMap(lines => Object.values(lines)),
  "beast-step", "doomsday-step", "ground-leap", "heat-charge", "heat-fire",
  "beam-charge", "beam-fire", "nova-charge", "nova-blast",
] as const);
type FighterClip = typeof FIGHTER_CLIPS extends Set<infer Clip> ? Clip : never;

// Vowel formants (Hz, adult male): "ah" for efforts and yells, "uh" for pain, a nasal hum for straining.
const VOWEL = { ah: [760, 1180, 2500], uh: [620, 1050, 2400], nn: [280, 1900, 2700] } as const;
const CURSED_HURT_VOICE = {
  gojo: { pitch: 122, formant: 1.07, breath: .27 },
  sukuna: { pitch: 86, formant: .92, breath: .19 },
};
const CURSED_HURT_SHAPES = {
  stagger: [
    { vowel: VOWEL.uh, duration: .13, from: 1.28, to: .88 },
    { vowel: VOWEL.nn, duration: .17, from: 1.06, to: .73 },
  ],
  pain: [
    { vowel: VOWEL.uh, duration: .26, from: 1.21, to: .65 },
    { vowel: VOWEL.ah, duration: .31, from: 1.08, to: .76 },
  ],
  yell: [
    { vowel: VOWEL.ah, duration: .44, from: 1.43, to: .68 },
    { vowel: VOWEL.uh, duration: .36, from: 1.32, to: .51 },
  ],
} as const;

export function distanceGain(distance: number, range: number): number {
  if (distance >= range) return 0;
  const edge = Math.max(0, 1 - (distance / range) ** 2);
  return edge * edge / (1 + (distance / (range * .12)) ** 2);
}

export class Sound {
  activeRoutedVoices = 0;
  private ctx: AudioContext | null = null;
  private samples = new Map<FighterClip, AudioBuffer>();
  private master!: GainNode;
  private output?: GainNode;
  private echo!: GainNode; // send into the valley reverb
  private noise!: AudioBuffer;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private rumbleGain!: GainNode;
  private boomDuckUntil = 0;
  private readonly curseVoiceUntil = { gojo: 0, sukuna: 0 };
  private readonly curseLineUntil = { gojo: 0, sukuna: 0 };
  private readonly hurtUntil = { gojo: 0, sukuna: 0 };
  private readonly hurtVariant = { gojo: -1, sukuna: -1 };
  private level = 0.8;
  private silent = false;

  get volume() { return this.level; }
  set volume(value: number) {
    if (!Number.isFinite(value)) return;
    this.level = Math.max(0, Math.min(1, value));
    this.applyVolume();
  }
  get muted() { return this.silent; }
  set muted(value: boolean) {
    this.silent = value;
    this.applyVolume();
  }

  private applyVolume() {
    if (!this.ctx || !this.output) return;
    this.output.gain.setTargetAtTime(this.silent ? 0 : this.level, this.ctx.currentTime, 0.015);
  }
  private listener = { x: 0, y: 0, z: 0, yaw: 0 };
  private spatial: { gain: number; pan: number; delay: number; cutoff: number; distance: number } | null = null;

  setListener(position: Vector3, yaw: number) { Object.assign(this.listener, { x: position.x, y: position.y + 1.6, z: position.z, yaw }); }

  private at(position: Vector3, range: number, play: () => void, propagationSpeed = 343) {
    const dx=position.x-this.listener.x, dy=position.y-this.listener.y, dz=position.z-this.listener.z;
    const distance=Math.hypot(dx,dy,dz), gain=distanceGain(distance,range);
    if (gain < .002) return;
    const previous=this.spatial;
    this.spatial={gain,pan:Math.max(-1,Math.min(1,(dx*Math.cos(this.listener.yaw)-dz*Math.sin(this.listener.yaw))/Math.max(1,distance))),delay:distance/propagationSpeed,cutoff:Math.max(450,16000/(1+distance/100)),distance};
    try { play(); } finally { this.spatial=previous; }
  }

  /** Both the dry voice and its reverb send inherit distance attenuation. */
  private routeVoice(gain: GainNode, echo: number): () => void {
    const ctx=this.ctx!, nodes: AudioNode[]=[];
    let output: AudioNode=gain;
    if(this.spatial){
      const filter=ctx.createBiquadFilter();filter.type="lowpass";filter.frequency.value=this.spatial.cutoff;
      const pan=ctx.createStereoPanner();pan.pan.value=this.spatial.pan;
      const level=ctx.createGain();level.gain.value=this.spatial.gain;
      output.connect(filter).connect(pan).connect(level);output=level;nodes.push(filter,pan,level);
    }
    output.connect(this.master);
    if(echo>0){const send=ctx.createGain();send.gain.value=echo;output.connect(send).connect(this.echo);nodes.push(send);}
    this.activeRoutedVoices++;
    return ()=>{
      this.activeRoutedVoices--;
      gain.disconnect();
      for(const node of nodes)node.disconnect();
    };
  }

  /** Browsers only allow audio after a user gesture: call from a click. */
  unlock() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    for (const clip of FIGHTER_CLIPS) void this.loadSample(ctx, clip);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 6;
    comp.attack.value = 0.002;
    comp.release.value = 0.25;
    this.output = ctx.createGain();
    this.output.gain.value = this.silent ? 0 : this.level;
    comp.connect(this.output).connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(comp);

    // 2 s of white noise, reused by every voice
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // mountain echo: long decaying noise impulse with a few discrete slap-backs off the valley walls
    const len = ctx.sampleRate * 4;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        ch[i] = (Math.random() * 2 - 1) * Math.exp(-t * 1.6) * 0.35;
      }
      for (const [t, a] of [[0.38, 0.5], [0.9, 0.35], [1.7, 0.22], [2.6, 0.12]]) {
        const i0 = Math.floor((t + c * 0.03) * ctx.sampleRate);
        for (let i = 0; i < 2000; i++) ch[i0 + i] += (Math.random() * 2 - 1) * a * Math.exp(-i / 400);
      }
    }
    const verb = ctx.createConvolver();
    verb.buffer = ir;
    const verbLp = ctx.createBiquadFilter();
    verbLp.type = "lowpass";
    verbLp.frequency.value = 1800;
    this.echo = ctx.createGain();
    this.echo.gain.value = 0.55;
    this.echo.connect(verb).connect(verbLp).connect(this.master);

    // wind: looping noise through a band-pass that opens with speed, plus a low rumble
    const wind = this.loopNoise();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    const rumble = this.loopNoise();
    const rlp = ctx.createBiquadFilter();
    rlp.type = "lowpass";
    rlp.frequency.value = 120;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rumble.connect(rlp).connect(this.rumbleGain).connect(this.master);

  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start();
    return src;
  }

  /** One-shot filtered noise burst. */
  private burst(type: BiquadFilterType, f0: number, f1: number, q: number, gain: number, attack: number, decay: number, delay = 0, echo = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay + (this.spatial?.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + attack + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g);
    const cleanup=this.routeVoice(g,echo);
    src.onended=()=>{src.disconnect();f.disconnect();cleanup();};
    src.start(t, Math.random() * 1.5);
    src.stop(t + attack + decay + 0.05);
  }

  /** Pitch-dropping sine: the chest-thump under every boom. */
  private thump(f0: number, f1: number, gain: number, decay: number, delay = 0, echo = 0,
    attack = .006, type: OscillatorType = "sine") {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay + (this.spatial?.delay ?? 0);
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g);
    const cleanup=this.routeVoice(g,echo);
    o.onended=()=>{o.disconnect();cleanup();};
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  private async loadSample(ctx: AudioContext, clip: FighterClip) {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}audio/fighters/${clip}.wav`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.samples.set(clip, await ctx.decodeAudioData(await response.arrayBuffer()));
    } catch (error) {
      console.warn(`Could not load fighter audio ${clip}`, error);
    }
  }

  private sample(clip: FighterClip, gain: number, echo: number, rate = 1) {
    const buffer = this.samples.get(clip);
    if (!this.ctx || !buffer) return;
    const source = this.ctx.createBufferSource(), level = this.ctx.createGain();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    level.gain.value = gain;
    source.connect(level);
    const cleanup = this.routeVoice(level, echo);
    source.onended = () => { source.disconnect(); cleanup(); };
    source.start(this.ctx.currentTime + (this.spatial?.delay ?? 0));
  }

  laser(firing: boolean, position: Vector3) {
    this.at(position, firing ? 620 : 420, () => this.sample(firing ? "heat-fire" : "heat-charge", firing ? .95 : .47, .14));
  }

  doomsdayEnergy(cue: EnergyCue, position: Vector3) {
    const blast = cue === "nova-blast";
    const gain = blast ? 1.1 : cue === "beam-fire" ? .85 : .58;
    this.at(position, blast ? 1500 : 460, () => this.sample(cue, gain, .28));
  }

  cursedLine<Speaker extends CursedVoice>(speaker: Speaker, line: keyof typeof CURSED_LINES[Speaker], position: Vector3, major = false) {
    const clips = CURSED_LINES[speaker];
    const clip = clips[line] as FighterClip;
    if (!this.ctx || (!major && this.ctx.currentTime < this.curseLineUntil[speaker])) return;
    this.at(position, major ? 265 : 175, () => {
      if (this.cursedVocal(speaker, clip, major ? 1.12 : .94, 1, .19)) {
        this.curseLineUntil[speaker] = this.curseVoiceUntil[speaker] + (major ? .7 : 2.7);
      }
    });
  }

  private cursedVocal(speaker: CursedVoice, clip: FighterClip, gain: number, rate: number, gap: number) {
    const buffer = this.samples.get(clip);
    if (!this.ctx || !buffer || this.silent || this.activeRoutedVoices >= 48 || this.ctx.currentTime < this.curseVoiceUntil[speaker]) return false;
    this.curseVoiceUntil[speaker] = this.ctx.currentTime + (this.spatial?.delay ?? 0) + buffer.duration / rate + gap;
    this.sample(clip, gain, FIGHTER_VOICES[speaker].echo, rate);
    return true;
  }

  private cursedEffect(speaker: CursedVoice, position: Vector3, range: number, play: () => void) {
    if (!this.ctx || this.silent || this.activeRoutedVoices >= 48) return;
    this.at(position, range, () => {
      if (this.spatial && this.ctx!.currentTime < this.curseVoiceUntil[speaker]) this.spatial.gain *= .68;
      play();
    });
  }

  sukuna(cue: SukunaCue, position: Vector3) {
    const heavy = cue === "shrine-open" || cue === "fuga-blast" || cue === "world-fire";
    this.cursedEffect("sukuna", position, heavy ? 950 : 340, () => {
      switch (cue) {
        case "cut":
          this.burst("bandpass", 6100, 2100, 2.1, .27, .002, .09, 0, .08);
          break;
        case "cleave":
          this.burst("bandpass", 3400, 740, 1.9, .30, .002, .13, 0, .10);
          this.thump(245, 104, .16, .12);
          break;
        case "world-charge":
          this.thump(144, 77, .21, 1.43, 0, .16, 1.1, "triangle");
          this.burst("bandpass", 570, 2580, 4.2, .22, 1.09, .23, .03, .18);
          break;
        case "world-fire":
          this.burst("highpass", 8500, 3150, .8, .47, .002, .30, 0, .26);
          this.thump(130, 32, .60, .69, .012, .38);
          this.burst("bandpass", 680, 150, 2.2, .37, .013, .60, .025, .35);
          break;
        case "fuga-charge":
          this.burst("bandpass", 470, 1770, 1.1, .46, .82, .21, 0, .17);
          this.thump(77, 123, .22, 1.02, 0, .22, .80, "triangle");
          break;
        case "fuga-fire":
          this.burst("bandpass", 440, 3700, 1.0, .62, .007, .32, 0, .21);
          this.thump(185, 59, .44, .39, 0, .20);
          break;
        case "fuga-blast":
          this.thump(121, 33, .80, .94, 0, .44);
          this.burst("lowpass", 3200, 200, 1.4, .66, .008, .85, 0, .30);
          this.burst("bandpass", 8100, 1140, .8, .41, .016, .62, .04, .28);
          break;
        case "shrine-charge":
          this.thump(84, 55, .29, 1.32, 0, .29, .93, "triangle");
          this.thump(176, 113, .13, 1.22, .06, .22, .79);
          break;
        case "shrine-open":
          this.thump(125, 36, .77, 1.21, 0, .48, .018);
          this.thump(83, 52, .32, .93, .09, .45, .026, "triangle");
          this.burst("bandpass", 3400, 380, 1.3, .52, .018, .78, .02, .41);
          break;
        case "shrine-pulse":
          this.burst("highpass", 6500, 1900, 1, .39, .005, .29, 0, .21);
          this.thump(150, 44, .29, .58, .02, .23);
          break;
        case "rct":
          this.thump(169, 244, .19, .74, .02, .14, .46, "triangle");
          this.burst("bandpass", 880, 2260, 2, .26, .40, .20, 0, .18);
          break;
        case "black-flash":
          this.burst("highpass", 8100, 2200, 1.1, .53, .002, .13, 0, .26);
          this.thump(162, 32, .52, .29, .009, .23);
          break;
      }
    });
  }

  gojo(cue: GojoCue, position: Vector3, size = 1) {
    const heavy = cue === "red-burst" || cue === "purple-burst" || cue === "purple-fire" || cue === "void-close";
    const gain = Math.min(1.3, Math.max(.36, size));
    this.cursedEffect("gojo", position, heavy ? 850 : 300, () => {
      switch (cue) {
        case "blue-charge":
          this.burst("bandpass", 2450, 520, 3.1, .22, .20, .23, 0, .10);
          this.thump(142, 390, .13, .44, 0, .14, .24, "triangle");
          break;
        case "red-charge":
          this.thump(67, 260, .19, .45, 0, .12, .26, "triangle");
          this.burst("bandpass", 480, 1950, 2.7, .24, .30, .13, 0, .15);
          break;
        case "purple-charge":
          this.thump(93, 185, .15, 1.37, 0, .24, .96, "triangle");
          this.thump(365, 276, .11, 1.39, .02, .19, 1.04, "triangle");
          this.burst("bandpass", 2900, 1140, 4.2, .21, 1.10, .22, .035, .12);
          break;
        case "void-charge":
          this.thump(262, 138, .20, .99, 0, .37, .73);
          this.thump(523, 277, .10, 1.00, 0, .33, .72);
          this.burst("bandpass", 760, 1920, 5, .16, .80, .16, 0, .18);
          break;
        case "blue-form":
          this.burst("bandpass", 1750, 230, 4, .34, .025, .37, 0, .14);
          this.thump(465, 195, .19, .34, 0, .20, .035);
          break;
        case "red-fire":
          this.burst("bandpass", 1250, 4700, .8, .32, .005, .15, 0, .14);
          this.thump(230, 72, .29, .27, 0, .20);
          break;
        case "purple-fire":
          this.thump(112, 42, .54, .7, 0, .41, .015);
          this.burst("bandpass", 4300, 290, 1.6, .41, .009, .55, 0, .33);
          this.thump(378, 131, .17, .61, .023, .15, .09, "triangle");
          break;
        case "blue-strike":
          this.thump(261, 93, .30, .16);
          this.burst("bandpass", 2900, 1320, 3.4, .34, .002, .10, 0, .10);
          break;
        case "red-burst":
        case "purple-burst": {
          const purple = cue === "purple-burst";
          this.thump(purple ? 108 : 170, 35, .68 * gain, purple ? .96 : .61, 0, .35);
          this.burst("lowpass", 3100, 300, 1.2, .49 * gain, .006, purple ? .86 : .53, 0, .31);
          this.burst("highpass", 4400, 1540, .8, .29 * gain, .002, .19, .016, .26);
          if (purple) this.thump(421, 83, .23 * gain, .67, .07, .32, .035, "triangle");
          break;
        }
        case "void-close":
          this.thump(70, 32, .47, .68, 0, .39, .018);
          this.burst("bandpass", 5400, 620, 3.2, .31, .012, .43, .015, .27);
          break;
        case "void-pulse":
          this.thump(138, 46, .30, .51, 0, .21, .024);
          this.thump(415, 308, .14, .58, .031, .36, .046);
          break;
        case "black-flash":
          this.burst("highpass", 7400, 2400, .85, .50, .002, .083, 0, .22);
          this.thump(178, 47, .45, .21, .009, .18);
          this.burst("bandpass", 2600, 750, 2.2, .24, .003, .15, .038, .22);
          break;
        case "infinity":
          this.burst("bandpass", 3450, 6800, 5.2, .40, .004, .15, 0, .09);
          this.thump(896, 978, .25, .21, 0, .21, .009);
          break;
        case "blink":
          this.burst("bandpass", 3900, 680, 2.5, .41, .003, .19, 0, .14);
          this.thump(812, 300, .21, .19, .006, .11, .011, "triangle");
          break;
        case "rct":
          this.thump(440, 550, .09, .52, 0, .28, .16);
          this.thump(659, 825, .085, .54, .047, .32, .18);
          this.burst("bandpass", 1200, 2600, 2, .13, .15, .30, 0, .20);
          break;
      }
    });
  }

  fighterLeap(doomsday: boolean, position: Vector3) {
    this.at(position, 250, () => this.sample("ground-leap", .55, .12, doomsday ? .72 : .94));
  }

  stomp(speed: number, doomsday: boolean, position: Vector3) {
    const gain = Math.min(.84, .31 + speed / 210);
    this.at(position, 270, () => this.sample(
      doomsday ? "doomsday-step" : "beast-step", gain, .14, .94 + Math.random() * .12,
    ));
  }

  /** Close, short body impact, separate from environmental destruction. */
  damage(strength: number, position?: Vector3) {
    if (position) { this.at(position, 180, () => this.damage(strength)); return; }
    if (!this.ctx) return;
    const intensity = Math.max(.15, Math.min(1, strength / 75));
    this.thump(125, 45, .18 + intensity * .32, .13 + intensity * .08);
    this.burst("bandpass", 1100, 360, .7, .12 + intensity * .22, .003, .09 + intensity * .06);
  }

  /** Hitting something. v is the impact speed in m/s. */
  impact(v: number, timbre: Timbre, position?: Vector3) {
    if (position) { this.at(position, Math.min(2200, 100 + v * 5), () => this.impact(v, timbre)); return; }
    if (!this.ctx) return;
    // 0 at a hop, 1 around 60 m/s, keeps growing (log) for real hits
    const e = Math.min(2.2, Math.log2(1 + v / 6) / 3.5);
    if (e < 0.08) return;
    if (timbre === "splash") {
      this.burst("bandpass", 1800, 500, 0.8, 0.25 + e * 0.5, 0.01, 0.35 + e * 0.6, 0, e * 0.4);
      this.thump(110, 40, e * 0.6, 0.4 + e * 0.3);
      if (e > 0.6) this.burst("lowpass", 900, 150, 0.5, e * 0.4, 0.05, 1.2 + e, 0.05, 0.5);
      return;
    }
    const big = e > 0.55;
    // body of the hit
    this.thump(big ? 85 : 140, 26, Math.min(1.2, 0.25 + e * 0.6), 0.25 + e * 0.9, 0, big ? 0.7 : 0.15);
    const bright = timbre === "hard" ? 3200 : timbre === "crunch" ? 2600 : 1100;
    this.burst("lowpass", bright, 90, 0.7, Math.min(1, 0.15 + e * 0.5), 0.004, 0.15 + e * 0.9, 0, big ? 0.8 : 0.2);
    if (timbre === "hard") this.burst("highpass", 2500, 4000, 0.6, 0.15 + e * 0.25, 0.002, 0.05 + e * 0.08);
    if (timbre === "crunch") for (let i = 0; i < 4; i++) this.burst("bandpass", 3500, 1500, 2, 0.1 + e * 0.1, 0.003, 0.05, i * 0.03);
    // debris raining down after the big ones
    if (big && (!this.spatial || this.spatial.distance < 45)) {
      for (let i = 0; i < 6 + e * 8; i++) {
        this.burst("bandpass", 600 + Math.random() * 2200, 300, 1.5, 0.03 + Math.random() * 0.05 * e, 0.003, 0.06 + Math.random() * 0.1, 0.15 + Math.random() * (0.6 + e * 0.6));
      }
    }
  }

  /** Crossing Mach 1: the classic double crack of an N-wave, then the valley throws it back. */
  sonicBoom(position?: Vector3, arrived = false) {
    if (position) { this.at(position, 9000, () => this.sonicBoom(), arrived ? Infinity : soundSpeed((position.y+this.listener.y)*.5)); return; }
    if (!this.ctx) return;
    if (!this.spatial) this.boomDuckUntil = this.ctx.currentTime + 0.45;
    for (const delay of [0, 0.11]) {
      this.burst("highpass", 2150, 850, .65, .5, .001, .065, delay, .2);
      this.burst("lowpass", 6000, 200, 0.5, 0.9, 0.001, 0.5, delay, 1);
      this.thump(70, 25, 1, 0.9, delay, 1);
    }
  }

  step(timbre: Timbre, speed: number, position?: Vector3) {
    if (position) { this.at(position, 45, () => this.step(timbre, speed)); return; }
    if (!this.ctx) return;
    const g = Math.min(0.35, 0.08 + speed * 0.025);
    switch (timbre) {
      case "soft":
        this.burst("lowpass", 700, 200, 0.7, g, 0.005, 0.09);
        this.thump(90, 50, g * 0.6, 0.08);
        break;
      case "hard":
        this.burst("bandpass", 2400, 1200, 1.4, g * 0.8, 0.002, 0.05);
        this.thump(160, 80, g * 0.5, 0.06);
        break;
      case "crunch":
        for (let i = 0; i < 3; i++) this.burst("bandpass", 3200 + Math.random() * 1500, 1800, 1.8, g * 0.6, 0.004, 0.05, i * 0.025);
        break;
      case "splash":
        this.burst("bandpass", 1400, 600, 0.9, g * 1.2, 0.01, 0.18);
        break;
    }
  }

  /** Charged punch (e 0..1): a deep blast, then a long rush of wind tearing down the punch line. */
  smash(e: number, position?: Vector3) {
    if (position) { this.at(position, 4000, () => this.smash(e)); return; }
    if (!this.ctx) return;
    this.thump(70, 22, Math.min(1.3, 0.5 + e * 0.8), 0.6 + e * 1.4, 0, 0.8);
    this.burst("lowpass", 4000, 120, 0.6, Math.min(1, 0.4 + e * 0.6), 0.003, 0.5 + e * 1.5, 0, 0.9);
    this.burst("bandpass", 250, 1800, 0.7, 0.25 + e * 0.5, 0.15 + e * 0.2, 1.2 + e * 2, 0.02, 0.6);
    this.burst("highpass", 1500, 600, 0.5, 0.1 + e * 0.25, 0.3, 1.5 + e * 1.5, 0.1, 0.5);
  }

  /**
   * A grunt or cry. intensity 0..1 makes it longer, louder and higher.
   * effort: a punch or jump ("hah!") · strain: a charge turning into a smash ("nngh") · stagger: a clipped "hk"
   * pain: a solid hit ("ugh") · yell: launched or defeated ("aagh")
   */
  grunt(kind: Grunt, voice: Voice, intensity = .5, position?: Vector3) {
    if (!this.ctx) return;
    const i = Math.max(0, Math.min(1, intensity));
    if (voice !== "player") {
      const { clips, echo, range } = FIGHTER_VOICES[voice];
      const cursed = voice === "gojo" || voice === "sukuna";
      const hurt = kind === "stagger" || kind === "pain" || kind === "yell";
      const play = () => {
        if (cursed && hurt) {
          this.cursedHurt(voice, kind, i);
          return;
        }
        const rate = .96 + Math.random() * .08;
        if (cursed) this.cursedVocal(voice, clips[kind], .45 + i * .38, rate, .09);
        else this.sample(clips[kind], .36 + i * .4, echo, rate);
      };
      if (position) this.at(position, cursed && hurt ? range * 1.2 : range, play);
      else play();
      return;
    }
    if (position) { this.at(position, 140, () => this.grunt(kind, voice, i)); return; }
    switch (kind) {
      case "effort":
        this.breathBurst(.1 + i * .1, .025);
        this.vocal(VOWEL.ah, .1 + i * .2, 1.1 + i * .2, .85, .32 + i * .3, .02);
        break;
      case "strain": this.vocal(VOWEL.nn, .32 + i * .2, .95, 1.12, .22 + i * .15); break;
      case "stagger": this.vocal(VOWEL.uh, .085, 1.12, .82, .55); break;
      case "pain":
        this.breathBurst(.12, .02);
        this.vocal(VOWEL.uh, .18 + i * .16, 1.2 + i * .15, .72, .38 + i * .25, .015);
        break;
      case "yell": this.vocal(VOWEL.ah, .45 + i * .35, 1.35 + i * .15, .62, .45 + i * .2); break;
    }
  }

  private cursedHurt(speaker: CursedVoice, kind: HurtGrunt, intensity: number) {
    const now = this.ctx!.currentTime;
    if (this.silent || this.activeRoutedVoices >= 48 || now < this.hurtUntil[speaker]) return;
    this.hurtUntil[speaker] = now + .2;
    if (now < this.curseVoiceUntil[speaker]) {
      // A short gasp can cut through a technique line without starting another voice over it.
      this.breathBurst(.12 + intensity * .1, .065 + intensity * .025);
      return;
    }

    const variant = (this.hurtVariant[speaker] + 1 + Number(Math.random() >= .5)) % 3;
    this.hurtVariant[speaker] = variant;
    if (variant === 0 && this.cursedVocal(speaker, FIGHTER_VOICES[speaker].clips[kind], .5 + intensity * .4, .89 + Math.random() * .2, .04)) return;
    const { vowel, duration, from, to } = CURSED_HURT_SHAPES[kind][variant === 2 ? 1 : 0];
    const length = duration * (.88 + intensity * .24);
    this.curseVoiceUntil[speaker] = now + (this.spatial?.delay ?? 0) + length + .04;
    this.breathBurst(.08 + intensity * .08, .035);
    this.vocal(vowel, length, from, to, .25 + intensity * .26, .015, CURSED_HURT_VOICE[speaker]);
  }

  /** A sawtooth "vocal folds" source with a little vibrato, through three formant filters, plus breath. */
  private vocal(vowel: readonly number[], duration: number, from: number, to: number, gain: number, delay = 0, voice = PLAYER_VOICE) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay + (this.spatial?.delay ?? 0), end = t + duration;
    const source = ctx.createOscillator();
    source.type = "sawtooth";
    const pitch = voice.pitch * (.96 + Math.random() * .08); // no two grunts quite alike
    source.frequency.setValueAtTime(pitch * from, t);
    source.frequency.exponentialRampToValueAtTime(pitch * to, end);
    const wobble = ctx.createOscillator(), depth = ctx.createGain();
    wobble.frequency.value = 6 + Math.random() * 5;
    depth.gain.value = pitch * .035;
    wobble.connect(depth).connect(source.frequency);
    const out = ctx.createGain();
    out.gain.setValueAtTime(.0001, t);
    out.gain.exponentialRampToValueAtTime(gain, t + .018);
    out.gain.setValueAtTime(gain, t + duration * .45);
    out.gain.exponentialRampToValueAtTime(.0001, end);
    const nodes: AudioNode[] = [wobble, depth];
    vowel.forEach((f, k) => {
      const band = ctx.createBiquadFilter(), level = ctx.createGain();
      band.type = "bandpass"; band.frequency.value = f * voice.formant; band.Q.value = 7 + k * 3;
      level.gain.value = [1, .55, .28][k] * 3;
      source.connect(band).connect(level).connect(out);
      nodes.push(band, level);
    });
    const breath = ctx.createBufferSource(), hiss = ctx.createBiquadFilter(), air = ctx.createGain();
    breath.buffer = this.noise; breath.loop = true;
    hiss.type = "bandpass"; hiss.frequency.value = 1600 * voice.formant; hiss.Q.value = .8;
    air.gain.value = voice.breath;
    breath.connect(hiss).connect(air).connect(out);
    nodes.push(breath, hiss, air);
    const cleanup = this.routeVoice(out, .15);
    source.onended = () => { source.disconnect(); for (const node of nodes) node.disconnect(); cleanup(); };
    for (const osc of [source, wobble, breath] as AudioScheduledSourceNode[]) { osc.start(t); osc.stop(end + .05); }
  }

  /** The "h" before a grunt: a short puff of breath. */
  private breathBurst(gain: number, duration: number) {
    this.burst("bandpass", 1400 * PLAYER_VOICE.formant, 1100 * PLAYER_VOICE.formant, .9, gain, .004, duration);
  }

  /** A punch cutting the air: brighter and longer the harder it's thrown. */
  swing(power: number) {
    if (!this.ctx) return;
    const e = Math.max(0, Math.min(1.4, power));
    this.burst("bandpass", 500, 2200 + e * 1500, 1.2, .3 + e * .35, .02, .09 + e * .12);
  }

  /** One of Sukuna's cuts: a thin steel hiss with a snap at the front. power 0..1.5 deepens and lengthens it. */
  slash(power: number, position?: Vector3) {
    if (position) { this.at(position, 320 + power * 500, () => this.slash(power)); return; }
    if (!this.ctx) return;
    const e = Math.max(0, Math.min(1.5, power));
    this.burst("highpass", 5200 - e * 1500, 2400 - e * 900, 1.1, .16 + e * .2, .002, .07 + e * .16);
    this.burst("bandpass", 3400, 900, 2.4, .1 + e * .22, .004, .1 + e * .3, .01, e * .35);
    if (e > .9) this.thump(120, 38, e * .5, .5, .02, .5);
  }

  /** A blow landing on a guard: a hard knock with a short metallic ring; a broken guard rings duller and lower. */
  block(fullyBlocked: boolean, position?: Vector3) {
    if (position) { this.at(position, 250, () => this.block(fullyBlocked)); return; }
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + (this.spatial?.delay ?? 0);
    this.thump(fullyBlocked ? 180 : 110, 60, .45, .12);
    this.burst("highpass", 2600, 3800, .7, fullyBlocked ? .22 : .12, .002, .05);
    for (const [f, g] of [[980, .12], [1470, .07], [2210, .05]] as const) {
      const o = ctx.createOscillator(), env = ctx.createGain();
      o.frequency.value = f * (fullyBlocked ? 1 : .7);
      env.gain.setValueAtTime(.0001, t);
      env.gain.exponentialRampToValueAtTime(g, t + .003);
      env.gain.exponentialRampToValueAtTime(.0001, t + (fullyBlocked ? .35 : .18));
      o.connect(env);
      const cleanup = this.routeVoice(env, .3);
      o.onended = () => { o.disconnect(); cleanup(); };
      o.start(t); o.stop(t + .4);
    }
  }

  /** Lift-off / launch whoosh. */
  launch(power: number) {
    if (!this.ctx) return;
    const e = Math.min(1.5, power);
    this.burst("bandpass", 300, 2500, 0.8, 0.2 + e * 0.4, 0.04, 0.5 + e * 0.4, 0, e * 0.3);
    if (e > 0.4) this.thump(60, 30, e * 0.9, 0.6, 0, 0.6);
  }

  /** Scroll detent: a short click whose pitch climbs with the level (t in 0..1). */
  tick(t: number) {
    if (!this.ctx) return;
    const ctx = this.ctx, at = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = 330 * Math.pow(2, t * 2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.12, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    o.connect(g).connect(this.master);
    o.start(at);
    o.stop(at + 0.1);
  }

  /** Continuous voices, called every frame. airSpeed in m/s relative to the air. */
  update(airSpeed: number, airDensity: number, underwater: boolean, nearApex = false, blastWind = 0, inVoid = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = underwater ? airSpeed * 0.2 : airSpeed;
    const density = Math.max(0.08, Math.min(1, airDensity));
    const duck = t < this.boomDuckUntil ? 0.3 : nearApex ? 0.55 : 1;
    const loud = Math.min(0.55, Math.pow(v / 110, 1.25) * 0.3) * Math.sqrt(density) * duck;
    const gust = Math.min(1, blastWind / 180) * (underwater ? .12 : 1);
    this.windGain.gain.setTargetAtTime(Math.min(.72, loud + .42 * gust) * (inVoid ? .11 : 1), t, 0.08);
    this.windFilter.frequency.setTargetAtTime(underwater ? 300 : 180 + Math.min(3000, Math.max(v, blastWind) * 6) * (0.5 + 0.5 * density), t, 0.15);
    this.rumbleGain.gain.setTargetAtTime((Math.min(0.45, v / 500) * density * duck + .2 * gust) * (inVoid ? .18 : 1), t, 0.15);
  }
}
