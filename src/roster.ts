import type { Faora } from './faora';

const KEYS: Record<string, string> = {
  'Satoru Gojo': 'Y', 'Sukuna': 'M', 'Doomsday': 'K', 'Faora-Ul': 'B', 'Anissa': 'N', 'Battle Beast': 'J',
};

/** Pause-menu Friend / Foe board. Drag a card across, or use its buttons. */
export function setupRoster(fighters: readonly Faora[], active: (fighter: Faora) => boolean,
  deploy: (fighter: Faora, enabled: boolean) => void, revive: (fighter: Faora) => void,
  changed: () => void,persistence:(foe:boolean)=>boolean=()=>false) {
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
      if (!members.length) list.append(el('p', 'roster-empty', 'Drag a fighter here'));
      for (const fighter of members) {
        const deployed = active(fighter), defeated = fighter.vitals.defeated, automatic = persistence(foe);
        const card = el('article', 'roster-card');
        card.classList.toggle('dismissed', !deployed);
        card.classList.toggle('defeated', defeated);
        card.draggable = true;
        card.dataset.fighter = fighter.name;
        const head = el('div', 'roster-head');
        const name = el('strong', '', fighter.name);
        const key = KEYS[fighter.name];
        if (key) { const k = el('kbd', '', key); k.title = `Press ${key} in game`; name.append(' ', k); }
        const state = automatic && defeated ? 'Returning' : fighter.vitals.eliminated ? 'Out' : fighter.vitals.downed ? 'Down' : deployed ? '' : 'Benched';
        head.append(name, el('span', 'roster-state', state));
        card.append(head);
        const health = el('div', 'roster-health'), fill = el('i', '');
        fill.style.transform = `scaleX(${deployed ? fighter.vitals.healthFraction : 0})`;
        health.append(fill); card.append(health);
        const actions = el('div', 'roster-actions');
        const button = (label: string, kind: string, action: () => void) => {
          const b = el('button', kind, label); b.type = 'button';
          b.addEventListener('click', () => { action(); changed(); render(); }); actions.append(b); return b;
        };
        if (defeated) button('Revive', 'revive', () => revive(fighter)).title = 'Revive at full health';
        else button(deployed ? 'Bench' : 'Deploy', deployed ? 'deploy on' : 'deploy', () => deploy(fighter, !deployed));
        const swap = button(foe ? '← Friend' : 'Foe →', 'swap', () => setSide(fighter, !foe));
        swap.setAttribute('aria-label', `Move ${fighter.name} to ${foe ? 'friends' : 'foes'}`);
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
