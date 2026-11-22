import css from './screens.css?inline';
import { CONFIG } from '../config';
import type { Player, Team } from '../data/types';
import type { GameState, Side } from '../core/game';
import { autoLineup, FIELD_POSITIONS, lineupProblems, type FieldPos, type Lineup } from '../core/lineup';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Styles are injected from the script so the web page needs no separate stylesheet file.
function ensureStyles(): void {
  if (document.getElementById('ks-styles')) return;
  const style = document.createElement('style');
  style.id = 'ks-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function mount(html: string): HTMLDivElement {
  ensureStyles();
  document.querySelector('.ks-screen')?.remove();
  const el = document.createElement('div');
  el.className = 'ks-screen';
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

export function closeScreens(): void {
  document.querySelector('.ks-screen')?.remove();
}

export interface LineupChoice {
  lineup: Lineup;
  opponent: Team;
  innings: number;
}

/**
 * The lineup card: kicking order (drag to reorder), field positions, who sits,
 * Auto Lineup, and the opponent and game length. Blocks illegal lineups.
 */
export function showLineupCard(
  mine: Team,
  start: Lineup,
  opponents: Team[],
  initial: { opponent: Team; innings: number },
  onPlay: (c: LineupChoice) => void,
): void {
  // Working state: every player in kicking order; sitting ones are skipped.
  let rows: Player[] = [...start.order, ...mine.players.filter((p) => !start.order.includes(p))];
  const sitting = new Set<Player>(mine.players.filter((p) => !start.order.includes(p)));
  const posOf = new Map<Player, FieldPos | 'Bench'>();
  for (const p of rows) posOf.set(p, 'Bench');
  for (const pos of FIELD_POSITIONS) if (start.field[pos]) posOf.set(start.field[pos], pos);
  let opponent = initial.opponent;
  let innings = initial.innings;

  const el = mount(`
    <div class="ks-card">
      <div class="ks-band">Lineup card</div>
      <div class="ks-body">
        <h1 class="ks-title">${esc(mine.name)} <span class="vs">vs</span> <span id="ks-opp-name"></span></h1>
        <div class="ks-row">
          <label>Opponent <select id="ks-opp">${opponents
            .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}${t.tier ? ` (${t.tier})` : ''}</option>`)
            .join('')}</select></label>
          <label>Innings <select id="ks-inn">${CONFIG.rules.inningChoices
            .map((n) => `<option value="${n}">${n}</option>`)
            .join('')}</select></label>
          <span style="flex:1"></span>
          <button id="ks-auto" type="button">Auto Lineup</button>
        </div>
        <div class="ks-table-wrap">
          <table class="ks-table ks-lineup">
            <thead><tr>
              <th>#</th><th></th><th>Player</th><th>Kicks as</th><th>Position</th><th>Kicks</th>
              <th class="num">CON</th><th class="num">POW</th><th class="num">SPD</th><th class="num">ARM</th><th class="num">GLV</th><th></th>
            </tr></thead>
            <tbody id="ks-rows"></tbody>
          </table>
        </div>
        <div id="ks-check"></div>
        <div class="ks-row"><span style="flex:1;color:var(--muted)">Drag rows to change the kicking order. Bench players swap into the field every other inning.</span>
          <button id="ks-play" class="ks-primary" type="button">Play ball</button></div>
      </div>
    </div>`);

  const tbody = el.querySelector<HTMLTableSectionElement>('#ks-rows')!;
  const oppSel = el.querySelector<HTMLSelectElement>('#ks-opp')!;
  const innSel = el.querySelector<HTMLSelectElement>('#ks-inn')!;
  const playBtn = el.querySelector<HTMLButtonElement>('#ks-play')!;
  oppSel.value = opponent.id;
  innSel.value = String(innings);

  const current = (): { order: Player[]; field: Partial<Record<FieldPos, Player>> } => {
    const order = rows.filter((p) => !sitting.has(p));
    const field: Partial<Record<FieldPos, Player>> = {};
    for (const p of order) {
      const pos = posOf.get(p);
      if (pos && pos !== 'Bench' && !field[pos]) field[pos] = p;
      else if (pos && pos !== 'Bench' && field[pos]) field[pos] = field[pos]; // duplicate shows as a problem below
    }
    return { order, field };
  };

  const dupes = (): string[] => {
    const seen = new Map<string, Player>();
    const out: string[] = [];
    for (const p of rows) {
      if (sitting.has(p)) continue;
      const pos = posOf.get(p)!;
      if (pos === 'Bench') continue;
      if (seen.has(pos)) out.push(`${seen.get(pos)!.name} and ${p.name} are both at ${pos}.`);
      else seen.set(pos, p);
    }
    return out;
  };

  const render = () => {
    el.querySelector('#ks-opp-name')!.textContent = opponent.name;
    const { order } = current();
    let n = 0;
    tbody.innerHTML = rows
      .map((p, i) => {
        const sits = sitting.has(p);
        const num = sits ? '–' : String(++n);
        const opts = ['Bench', ...FIELD_POSITIONS]
          .map((pos) => `<option ${posOf.get(p) === pos ? 'selected' : ''}>${pos}</option>`)
          .join('');
        return `<tr draggable="true" data-i="${i}" class="${sits ? 'sitting' : ''}">
          <td class="num">${num}</td><td class="ks-grip" aria-hidden="true">⋮⋮</td>
          <td>${esc(p.name)}${p.star ? ' <span class="ks-star" title="Star player">★</span>' : ''}</td>
          <td><span class="ks-pill ${p.kicksAs}">${p.kicksAs === 'girl' ? 'Girl' : 'Guy'}</span></td>
          <td><select data-pos="${i}" aria-label="Position for ${esc(p.name)}">${opts}</select></td>
          <td><input type="checkbox" data-kick="${i}" ${sits ? '' : 'checked'} aria-label="${esc(p.name)} kicks"></td>
          <td class="num">${p.contact}</td><td class="num">${p.power}</td><td class="num">${p.speed}</td><td class="num">${p.arm}</td><td class="num">${p.glove}</td>
          <td><button class="ks-move" data-up="${i}" type="button" aria-label="Move ${esc(p.name)} up">▲</button>
              <button class="ks-move" data-down="${i}" type="button" aria-label="Move ${esc(p.name)} down">▼</button></td>
        </tr>`;
      })
      .join('');
    const { field } = current();
    const problems = [...lineupProblems(order, field), ...dupes()];
    const check = el.querySelector('#ks-check')!;
    check.innerHTML = problems.length
      ? `<ul class="ks-problems">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
      : `<p class="ks-ok">Lineup is legal: ${order.length} kickers, a girl after every 2 guys, all 10 spots filled.</p>`;
    playBtn.disabled = problems.length > 0;
  };

  // Drag and drop to reorder
  let dragFrom = -1;
  tbody.addEventListener('dragstart', (e) => {
    const tr = (e.target as HTMLElement).closest('tr');
    if (!tr) return;
    dragFrom = Number(tr.dataset.i);
    tr.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', String(dragFrom));
  });
  tbody.addEventListener('dragover', (e) => {
    e.preventDefault();
    tbody.querySelectorAll('tr.over').forEach((t) => t.classList.remove('over'));
    (e.target as HTMLElement).closest('tr')?.classList.add('over');
  });
  tbody.addEventListener('drop', (e) => {
    e.preventDefault();
    const tr = (e.target as HTMLElement).closest('tr');
    if (!tr || dragFrom < 0) return;
    const to = Number(tr.dataset.i);
    const [p] = rows.splice(dragFrom, 1);
    rows.splice(to, 0, p);
    dragFrom = -1;
    render();
  });
  tbody.addEventListener('dragend', () => render());
  tbody.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.dataset.pos) posOf.set(rows[Number(t.dataset.pos)], t.value as FieldPos | 'Bench');
    if (t.dataset.kick) {
      const p = rows[Number(t.dataset.kick)];
      if ((t as HTMLInputElement).checked) sitting.delete(p);
      else sitting.add(p);
    }
    render();
  });
  tbody.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const i = Number(b.dataset.up ?? b.dataset.down);
    const j = b.dataset.up !== undefined ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    render();
  });
  el.querySelector('#ks-auto')!.addEventListener('click', () => {
    const l = autoLineup({ ...mine, players: mine.players.filter((p) => !sitting.has(p)) });
    rows = [...l.order, ...mine.players.filter((p) => !l.order.includes(p))];
    for (const p of rows) posOf.set(p, 'Bench');
    for (const pos of FIELD_POSITIONS) posOf.set(l.field[pos], pos);
    render();
  });
  oppSel.addEventListener('change', () => {
    opponent = opponents.find((t) => t.id === oppSel.value)!;
    render();
  });
  innSel.addEventListener('change', () => (innings = Number(innSel.value)));
  playBtn.addEventListener('click', () => {
    const { order, field } = current();
    if (lineupProblems(order, field).length || dupes().length) return;
    closeScreens();
    onPlay({ lineup: { order, field: field as Record<FieldPos, Player> }, opponent, innings });
  });
  render();
}

/** Box score: line score by inning, each player's line, player of the game. */
export function showBoxScore(game: GameState, onDone: () => void): void {
  const [a, h] = game.score;
  const sides: Side[] = [game.away, game.home];
  const mine = sides.find((s) => s.isPlayer);
  const mineRuns = mine === game.away ? a : h;
  const theirRuns = mine === game.away ? h : a;
  const result = mineRuns > theirRuns ? 'win' : mineRuns < theirRuns ? 'loss' : 'tie';
  const headline = { win: `${mine?.team.name} win ${mineRuns}–${theirRuns}!`, loss: `${mine?.team.name} lose ${mineRuns}–${theirRuns}.`, tie: `Tie game, ${mineRuns}–${theirRuns}.` }[result];
  const innings = Math.max(game.line[0].length, game.line[1].length);
  const cols = Array.from({ length: innings }, (_, i) => i + 1);
  const lineRow = (s: Side, i: 0 | 1) =>
    `<tr><td>${esc(s.team.name)}</td>${cols.map((c) => `<td>${game.line[i][c - 1] ?? 'X'}</td>`).join('')}
      <td class="tot">${game.score[i]}</td><td>${game.hits[i]}</td><td>${game.errors[i]}</td></tr>`;
  const potg = game.playerOfTheGame();
  const pl = game.box.get(potg)!;
  const potgTeam = sides.find((s) => s.lineup.order.includes(potg))!;
  const statLine = (l: typeof pl) =>
    [l.h ? `${l.h}-for-${l.ab}` : `0-for-${l.ab}`, l.hr ? `${l.hr} HR` : '', l.rbi ? `${l.rbi} RBI` : '', l.r ? `${l.r} R` : '', l.bb ? `${l.bb} BB` : '', l.outsMade ? `${l.outsMade} out${l.outsMade === 1 ? "" : "s"} on defense` : '']
      .filter(Boolean)
      .join(', ');
  const playerTable = (s: Side) => `
    <div><h3 class="ks-h">${esc(s.team.name)}</h3><div class="ks-table-wrap"><table class="ks-table">
      <thead><tr><th>Player</th><th class="num">AB</th><th class="num">R</th><th class="num">H</th><th class="num">RBI</th><th class="num">HR</th><th class="num">BB</th><th class="num">E</th></tr></thead>
      <tbody>${s.lineup.order
        .map((p) => {
          const l = game.box.get(p)!;
          return `<tr><td>${esc(p.name)}</td><td class="num">${l.ab}</td><td class="num">${l.r}</td><td class="num">${l.h}</td><td class="num">${l.rbi}</td><td class="num">${l.hr}</td><td class="num">${l.bb}</td><td class="num">${l.e}</td></tr>`;
        })
        .join('')}</tbody></table></div></div>`;

  const el = mount(`
    <div class="ks-card">
      <div class="ks-band">Box score · Final${innings > game.lastInning ? ` (${innings} innings)` : ''}</div>
      <div class="ks-body">
        <p class="ks-result ${result}">${esc(headline)}</p>
        <div class="ks-table-wrap"><table class="ks-table ks-linescore">
          <thead><tr><th>Team</th>${cols.map((c) => `<th>${c}</th>`).join('')}<th>R</th><th>H</th><th>E</th></tr></thead>
          <tbody>${lineRow(game.away, 0)}${lineRow(game.home, 1)}</tbody>
        </table></div>
        <div class="ks-potg"><span>🏅</span><span><b>Player of the game:</b> ${esc(potg.name)} (${esc(potgTeam.team.name)}), ${esc(statLine(pl))}</span></div>
        <div class="ks-two">${playerTable(game.away)}${playerTable(game.home)}</div>
        <div class="ks-row"><span style="flex:1"></span><button id="ks-again" class="ks-primary" type="button">Back to the lineup card</button></div>
      </div>
    </div>`);
  el.querySelector('#ks-again')!.addEventListener('click', () => {
    closeScreens();
    onDone();
  });
}
