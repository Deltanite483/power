import type { Sound } from "./audio";

export function setupVolumeControls(sound: Sound) {
  const panel = document.getElementById("audio-controls")!;
  const slider = document.getElementById("master-volume") as HTMLInputElement;
  const value = document.getElementById("master-volume-value")!;
  const mute = document.getElementById("master-mute") as HTMLButtonElement;
  const storageKey = "power.audio";

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (saved && typeof saved.volume === "number") sound.volume = saved.volume;
    if (saved && typeof saved.muted === "boolean") sound.muted = saved.muted;
  } catch { /* Audio controls also work when storage is unavailable. */ }

  function render() {
    const percent = Math.round(sound.volume * 100);
    slider.value = String(percent);
    slider.setAttribute("aria-valuetext", `${percent}%${sound.muted ? ", muted" : ""}`);
    value.textContent = sound.muted ? "Muted" : `${percent}%`;
    mute.textContent = sound.muted ? "Unmute" : "Mute";
    mute.setAttribute("aria-pressed", String(sound.muted));
    try {
      localStorage.setItem(storageKey, JSON.stringify({ volume: sound.volume, muted: sound.muted }));
    } catch { /* Storage is optional. */ }
  }

  slider.addEventListener("input", () => {
    sound.volume = Number(slider.value) / 100;
    sound.muted = false;
    render();
  });
  mute.addEventListener("click", () => {
    sound.muted = !sound.muted;
    render();
  });
  // Focused controls keep their native keys without triggering game actions.
  panel.addEventListener("click", e => e.stopPropagation());
  panel.addEventListener("keydown", e => e.stopPropagation());
  panel.addEventListener("wheel", e => e.stopPropagation());
  addEventListener("keydown", e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
    if (e.code === "KeyV") {
      if (e.repeat) return;
      sound.muted = !sound.muted;
    } else if (e.code === "Minus" || e.code === "Equal") {
      sound.volume = Math.round((sound.volume + (e.code === "Equal" ? .05 : -.05)) * 100) / 100;
      sound.muted = false;
    } else return;
    e.preventDefault();
    render();
  });
  render();
}
