import { describe, expect, it } from 'vitest';
import { afterReview, canEnterPortal, choosePortal, currentGame, enterPortal, gameSetup, newCareer, recordGame, resolveCamp } from '../src/career/career';
import { COLLEGES } from '../src/career/data';
import { GameSim } from '../src/career/gamesim';
import { evenSkills } from '../src/career/progression';
import type { Career } from '../src/career/types';

const profile = { name: 'Austin Watson', hometown: 'Lakeview', school: 'Lakeview High', foot: 'R' as const, number: '3' };

/** A college freshman at a small school who just finished the season (in the offseason). */
function freshmanOffseason(ovr: number, seed = 4): Career {
  let c = newCareer(1, profile, seed);
  const small = COLLEGES.find((t) => t.tier === 'small')!;
  c = { ...c, stage: 'college', level: 'college', seasonNo: 1, team: { ...small, strength: 55 }, pending: { kind: 'camp', title: '', rival: { name: 'R', overall: 10 }, why: '' } };
  c = resolveCamp(c, [true, true, true, true, true], [false, false, false, false, false]);
  c.skills = evenSkills(ovr);
  while (c.inSeason) {
    const s = new GameSim(gameSetup(c, currentGame(c)!));
    s.simToEnd();
    c = recordGame(c, s).career;
  }
  return afterReview(c);
}

describe('transfer portal', () => {
  it('is open in a college offseason before the senior year', () => {
    const c = freshmanOffseason(60);
    expect(c.pending?.kind).toBe('offseason');
    expect(canEnterPortal(c)).toBe(true);
    expect(canEnterPortal({ ...c, seasonNo: 4 })).toBe(false);
    expect(canEnterPortal({ ...c, stage: 'nfl' })).toBe(false);
  });

  it('a strong kicker hears from bigger programs', () => {
    const withSeason = (c: Career, fgm: number, fga: number) => {
      c.history[c.history.length - 1] = { ...c.history[c.history.length - 1], fgm, fga, honors: [] };
      return c;
    };
    const strong = enterPortal(withSeason(freshmanOffseason(78, 5), 18, 20));
    const weak = enterPortal(withSeason(freshmanOffseason(48, 5), 9, 15));
    if (strong.pending?.kind !== 'portal' || weak.pending?.kind !== 'portal') throw new Error('not in portal');
    expect(strong.pending.offers.some((o) => o.team.tier === 'major')).toBe(true);
    expect(weak.pending.offers.every((o) => o.team.tier === 'small')).toBe(true);
    expect(strong.pending.offers.every((o) => o.team.name !== strong.team!.name)).toBe(true);
  });

  it('transferring moves you to the new team with its record book', () => {
    const c = enterPortal(freshmanOffseason(70));
    if (c.pending?.kind !== 'portal') throw new Error('not in portal');
    const offer = c.pending.offers[0];
    const t = choosePortal(c, offer);
    expect(t.team!.name).toBe(offer.team.name);
    expect(t.seasonNo).toBe(2);
    expect(t.year).toBe(c.year + 1);
    expect(t.transfers).toBe(1);
    expect(t.records!.title).toContain(offer.team.name);
    if (offer.rivalOvr === null) expect(t.inSeason).toBe(true);
    else expect(t.pending?.kind).toBe('camp');
  });

  it('withdrawing costs trust and brings a camp battle', () => {
    const c = enterPortal(freshmanOffseason(60));
    const w = choosePortal(c, null);
    expect(w.team!.name).toBe(c.team!.name);
    expect(w.trust).toBeLessThan(c.trust);
    expect(w.pending?.kind).toBe('camp');
    expect(w.role).toBe('backup');
  });
});
