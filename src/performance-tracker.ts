const HISTORY_SECONDS = 3600;
const PHASES = ["Player", "Prop physics", "Fighter setup", "Faora-Ul", "Anissa", "Battle Beast", "Doomsday", "Sukuna", "Satoru Gojo", "Fighter powers",
  "View and effects", "Destruction", "Atmosphere", "Terrain and trees", "HUD", "Main render", "Target view"] as const;
type Phase = typeof PHASES[number];
type Mode = "loading" | "playing" | "paused";

type Snapshot = Record<string, number | boolean | string | undefined>;
const round = (value: number) => Math.round(value * 100) / 100;

/** Per-second summaries keep long captures small and avoid allocating a record every frame. */
export class PerformanceTracker {
  private readonly started = performance.now();
  private readonly startedAt = new Date().toISOString();
  private readonly history: ReturnType<PerformanceTracker["summarize"]>[] = [];
  private readonly frameTimes: number[] = [];
  private readonly phaseTotal = new Float64Array(PHASES.length);
  private readonly phasePeak = new Float64Array(PHASES.length);
  private readonly phaseIndex = new Map<Phase, number>(PHASES.map((name, index) => [name, index]));
  private readonly panel = document.createElement("pre");
  private nextRow = 0;
  private bucketStart = 0;
  private frameStart = 0;
  private previousFrame = 0;
  private lastMark = 0;
  private cpuTotal = 0;
  private cpuPeak = 0;
  private slowFrames = 0;
  private slowedFrames = 0;
  private mode: Mode = "loading";
  private enabled = false;

  constructor(private readonly snapshot: () => Snapshot) {
    this.panel.id = "performance-tracker";
    this.panel.hidden = true;
    document.body.appendChild(this.panel);
    document.addEventListener("visibilitychange", () => {
      this.commit(performance.now());
      this.previousFrame = 0;
    });
    window.addEventListener("keydown", event => {
      if (event.code !== "KeyO" && event.code !== "KeyP") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      if (event.repeat) return;
      if (event.code === "KeyP") this.download();
      else {
        this.panel.hidden = !this.panel.hidden;
        if (!this.panel.hidden) this.show(this.latest());
      }
    });
  }

  begin(now: number, mode: Mode, scale: number) {
    this.enabled = !document.hidden;
    if (!this.enabled) return;
    if (mode !== this.mode) {
      this.commit(now);
      this.mode = mode;
      this.previousFrame = 0;
    } else if (now - this.bucketStart >= 1000) this.commit(now);
    if (!this.frameTimes.length) this.bucketStart = now;
    this.frameStart = this.lastMark = now;
    // The first frame after a mode or visibility change has no comparable frame interval.
    if (this.previousFrame) {
      const interval = now - this.previousFrame;
      this.frameTimes.push(interval);
      if (interval > 50) this.slowFrames++;
      if (scale < 1) this.slowedFrames++;
    }
    this.previousFrame = now;
  }

  mark(phase: Phase) {
    if (!this.enabled) return;
    const now = performance.now(), index = this.phaseIndex.get(phase)!;
    const duration = now - this.lastMark;
    this.lastMark = now;
    if (this.frameTimes.length === 0) return;
    this.phaseTotal[index] += duration;
    this.phasePeak[index] = Math.max(this.phasePeak[index], duration);
  }

  end() {
    if (!this.enabled || !this.frameTimes.length) return;
    const duration = performance.now() - this.frameStart;
    this.cpuTotal += duration;
    this.cpuPeak = Math.max(this.cpuPeak, duration);
  }

  private summarize(now: number) {
    const frames = this.frameTimes.length;
    const intervals = this.frameTimes.slice().sort((a, b) => a - b);
    const elapsed = intervals.reduce((total, ms) => total + ms, 0);
    return {
      sessionSeconds: round((now - this.started) / 1000),
      mode: this.mode,
      frames,
      fps: elapsed > 0 ? round(frames * 1000 / elapsed) : 0,
      p95FrameMs: round(intervals[Math.ceil(frames * .95) - 1]),
      worstFrameMs: round(intervals[frames - 1]),
      framesOver50Ms: this.slowFrames,
      intentionallySlowedFrames: this.slowedFrames,
      meanCpuMs: round(this.cpuTotal / frames),
      peakCpuMs: round(this.cpuPeak),
      phases: PHASES.map((name, i) => ({name, meanMs: round(this.phaseTotal[i] / frames), peakMs: round(this.phasePeak[i])})),
      counters: this.snapshot(),
    };
  }

  private commit(now: number) {
    if (!this.frameTimes.length) return;
    const row = this.summarize(now);
    this.history[this.nextRow] = row;
    this.nextRow = (this.nextRow + 1) % HISTORY_SECONDS;
    this.frameTimes.length = 0;
    this.phaseTotal.fill(0);
    this.phasePeak.fill(0);
    this.cpuTotal = this.cpuPeak = this.slowFrames = this.slowedFrames = 0;
    if (!this.panel.hidden) this.show(row);
  }

  private latest() {
    return this.history[(this.nextRow + HISTORY_SECONDS - 1) % HISTORY_SECONDS];
  }

  private show(row?: ReturnType<PerformanceTracker["summarize"]>) {
    if (!row) {
      this.panel.textContent = "Collecting frame data…  O hide · P export";
      return;
    }
    const busiest = row.phases.slice().sort((a, b) => b.meanMs - a.meanMs).slice(0, 3);
    const c = row.counters;
    this.panel.textContent = [
      `PERFORMANCE · ${row.mode}   O hide · P export`,
      `${row.fps} FPS   p95 ${row.p95FrameMs} ms   worst ${row.worstFrameMs} ms`,
      `CPU ${row.meanCpuMs} ms avg   ${busiest.map(phase => `${phase.name} ${phase.meanMs} ms`).join(" · ")}`,
      `${c.fighters} fighters   ${c.terrainEdits} terrain edits   ${c.pendingTerrainMeshes} mesh jobs   ${c.activeRubble} rubble`,
    ].join("\n");
  }

  private download() {
    const rows = this.history.slice(this.nextRow).concat(this.history.slice(0, this.nextRow));
    if (this.frameTimes.length) rows.push(this.summarize(performance.now()));
    const report = {
      version: 1,
      startedAt: this.startedAt,
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      note: "CPU timings include render submission and possible driver stalls. GPU execution is not measured. Counters are snapshots at the end of each interval.",
      rows,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report)], {type: "application/json"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = `power-performance-${report.exportedAt.replace(/[:.]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
