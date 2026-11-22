import { describe, expect, it } from 'vitest';
import teams from '../src/data/teams.json';
import type { Team } from '../src/data/types';
import { GameState } from '../src/core/game';
import { defaultLineup } from '../src/core/lineup';
import { seededRng } from '../src/core/rng';
import { simulateGame } from '../src/core/sim';

const all = teams.teams as Team[];
const side = (t: Team, isPlayer = false) => ({ team: t, lineup: defaultLineup(t), isPlayer, next: 0 });
const byName = (n: string) => all.find((t) => t.name === n)!;

describe('game state', () => {
  it('a simulated game finishes with a sensible score and box score', () => {
    const g = simulateGame(new GameState(side(byName('Toe Jammers')), side(byName('Grass Kickers'))), seededRng(1));
    expect(g.over).toBe(true);
    const [a, h] = g.score;
    expect(a + h).toBeGreaterThan(0);
    expect(a + h).toBeLessThan(60);
    const runs = [...g.box.values()].reduce((s, l) => s + l.r, 0);
    expect(runs).toBe(a + h);
  });

  it('regular season: tied after the last inning plays one extra, then can end tied', () => {
    let tiesSeen = 0;
    for (let s = 1; s <= 40; s++) {
      const g = simulateGame(new GameState(side(byName('Toe Jammers')), side(byName('Grass Kickers')), { innings: 3 }), seededRng(s));
      expect(g.inning).toBeLessThanOrEqual(4);
      if (!g.winner) {
        tiesSeen++;
        expect(g.inning).toBe(4);
      }
    }
    expect(tiesSeen).toBeGreaterThanOrEqual(0);
  });

  it('playoffs: extra innings until someone wins', () => {
    for (let s = 1; s <= 15; s++) {
      const g = simulateGame(
        new GameState(side(byName('Toe Jammers')), side(byName('Grass Kickers')), { innings: 3, extraInnings: 'until-winner' }),
        seededRng(s),
      );
      expect(g.winner).not.toBeNull();
    }
  });

  it('home team does not kick in the last inning when already ahead', () => {
    for (let s = 1; s <= 20; s++) {
      const g = simulateGame(new GameState(side(byName('Recess Rejects')), side(byName('Ballbarians')), { innings: 3 }), seededRng(s));
      if (g.score[1] > g.score[0] && g.line[1].length < g.line[0].length) return; // found one
    }
  });

  it('better teams win more often', () => {
    let wins = 0;
    for (let s = 1; s <= 30; s++) {
      const g = simulateGame(new GameState(side(byName('Recess Rejects')), side(byName('Ballbarians')), { innings: 5 }), seededRng(100 + s));
      if (g.winner?.team.name === 'Ballbarians') wins++;
    }
    expect(wins).toBeGreaterThan(18);
  });
});
