/** One short controls reference, shown in the pause menu and on the in-game "?" card. */
const CONTROLS: [group: string, rows: [keys: string, action: string][]][] = [
  ["Move", [
    ["W A S D", "Move"],
    ["Space", "Hold to charge jump · rise in flight"],
    ["Shift", "Run · boost in flight"],
    ["C", "Crouch · ground pound · descend"],
    ["E", "Toggle flight"],
    ["Scroll / 1–6", "Flight speed"],
    ["Arrows", "Swerve and pitch in flight"],
  ]],
  ["Fight", [
    ["Left click", "Hold to charge punch"],
    ["Right click", "Hold to guard"],
    ["Q", "Brake + shockwave"],
    ["Q + click", "Kick · Q + guard: super block"],
    ["R", "Tap to lock on · hold to ram"],
    ["F / X", "Grab or throw / drop"],
    ["T", "Hold to revive a friend"],
  ]],
  ["Fighters", [
    ["G", "Call friends to you"],
    ["B", "Faora: switch side"],
    ["N · J · K", "Anissa · Battle Beast · Doomsday"],
    ["M · Y", "Sukuna · Gojo"],
  ]],
  ["World", [
    ["[ / ]", "Destruction power"],
    ["H", "Terrain healing"],
    ["− / + · V", "Volume · mute"],
    ["?", "Show this card"],
  ]],
];

export function renderControls(...targets: HTMLElement[]) {
  for (const target of targets) {
    target.replaceChildren(...CONTROLS.map(([group, rows]) => {
      const section = document.createElement("section");
      const heading = document.createElement("h3");
      heading.textContent = group;
      const list = document.createElement("dl");
      for (const [keys, action] of rows) {
        const dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = keys; dd.textContent = action;
        list.append(dt, dd);
      }
      section.append(heading, list);
      return section;
    }));
  }
}
