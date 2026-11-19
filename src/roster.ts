import type { Faora } from './faora';

const ROLES: Record<string, { role: string; key?: string; keyAction?: string }> = {
  'Satoru Gojo': { role: 'Boss', key: 'Y', keyAction: 'deploy' },
  'Sukuna': { role: 'Boss · Dismantle · Cleave · World Slash · Malevolent Shrine · Fuga', key: 'M', keyAction: 'deploy' },
  'Doomsday':{role:'Boss · energy beam · nuclear pulse · adapts after revival',key:'K',keyAction:'deploy'},
  'Faora-Ul': { role: 'Flyer · heat vision', key: 'B', keyAction: 'swap side' },
  'Anissa': { role: 'Flyer · fastest striker', key: 'N', keyAction: 'deploy' },
  'Battle Beast': { role: 'Ground · sprints · leaps · near-unbreakable', key: 'J', keyAction: 'deploy' },
};

/** Pause-menu Friend / Foe board. Drag a card across, or use its buttons. */
export function setupRoster(fighters: readonly Faora[], active: (fighter: Faora) => boolean,
  deploy: (fighter: Faora, enabled: boolean) => void, revive: (fighter: Faora) => void,
  changed: () => void,persistence:()=>boolean=()=>false) {
  const root = document.getElementById('fighter-roster')!;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') => {
    const node = document.createElement(tag); node.className = className; if (text) node.textContent = text; return node;
  };
  const render = () => {
    for (const column of root.querySelectorAll<HTMLElement>('[data-side]')) {
      const foe = column.dataset.side === 'foe';
      const list = column.querySelector('.roster-list')!;
      const members = fighters.filter(f => f.enemyMode === foe);
      column.querySelector('.roster-count')!.textContent = `${members.filter(active).length}/${members.length}`;
      list.replaceChildren();
      if (!members.length) list.append(el('p', 'roster-empty', 'Drop a fighter here'));
      for (const fighter of members) {
        const deployed = active(fighter), defeated = fighter.vitals.defeated, info = ROLES[fighter.name], automatic=!foe && persistence();
        const card = el('article', 'roster-card');
        card.classList.toggle('dismissed', !deployed);
        card.classList.toggle('defeated', defeated);
        card.draggable = true;
        card.dataset.fighter = fighter.name;
        const head = el('div', 'roster-head');
        head.append(el('strong', '', fighter.name.toUpperCase()));
        head.append(el('span', 'roster-state', automatic && defeated?'RETURNING':fighter.vitals.eliminated?'OUT':fighter.vitals.downed?`DOWN · ${fighter.vitals.revivesRemaining} LEFT`:deployed ? 'ACTIVE' : 'BENCHED'));
        card.append(head);
        if (info) card.append(el('span', 'roster-role', `${info.role} · ${automatic?`auto return at ${fighter.vitals.maxHealth * .75} HP`:fighter.vitals.revivesRemaining+" revives left"}`));
        const health = el('div', 'roster-health'), fill = el('i', '');
        fill.style.transform = `scaleX(${fighter.vitals.healthFraction})`;
        health.append(fill); card.append(health);
        const actions = el('div', 'roster-actions');
        const button = (label: string, kind: string, action: () => void) => {
          const b = el('button', kind, label); b.type = 'button';
          b.addEventListener('click', () => { action(); changed(); render(); }); actions.append(b); return b;
        };
        button(foe ? '← Friend' : 'Foe →', 'swap', () => setSide(fighter, !foe));
        const reviveButton=button(`Revive · ${fighter.vitals.maxHealth} HP`, 'revive', () => revive(fighter));
        reviveButton.disabled=!defeated;
        reviveButton.setAttribute('aria-label', `Revive ${fighter.name}`);
        reviveButton.title=`Revive at ${fighter.vitals.maxHealth} HP, including final defeats. Does not use a team revive.`;
        const deployButton=button(deployed ? 'Dismiss' : 'Deploy', deployed ? 'deploy on' : 'deploy', () => deploy(fighter, !deployed));
        deployButton.disabled=defeated;
        if (info?.key) {
          const hint = el('span', 'roster-key');
          hint.append(el('kbd', '', info.key), ` ${info.keyAction}`);
          actions.append(hint);
        }
        card.append(actions);
        card.addEventListener('dragstart', e => {
          e.dataTransfer?.setData('text/plain', fighter.name);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
        list.append(card);
      }
    }
  };
  const setSide = (fighter: Faora, foe: boolean) => {
    fighter.passive = !foe; fighter.setEnemyMode(foe);
    changed();
  };
  root.addEventListener('click', e => e.stopPropagation());
  root.addEventListener('mousedown', e => e.stopPropagation());
  for (const column of root.querySelectorAll<HTMLElement>('[data-side]')) {
    column.addEventListener('dragover', e => { e.preventDefault(); column.classList.add('drag-over'); });
    column.addEventListener('dragleave', e => { if (!column.contains(e.relatedTarget as Node)) column.classList.remove('drag-over'); });
    column.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation(); column.classList.remove('drag-over');
      const fighter = fighters.find(f => f.name === e.dataTransfer?.getData('text/plain'));
      if (fighter) { setSide(fighter, column.dataset.side === 'foe'); render(); }
    });
  }
  fighters.forEach(f => { f.passive = !f.enemyMode; f.setEnemyMode(f.enemyMode); });
  render();
  return render;
}
