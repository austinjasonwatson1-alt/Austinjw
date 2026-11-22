import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import {
  afterDraftResult,
  afterReview,
  applyOffseasonCamp,
  applyShowcase,
  chooseOffer,
  currentGame,
  declareForDraft,
  finishOffseason,
  gameSetup,
  newCareer,
  recordGame,
  resolveCamp,
  resolveTryout,
  rivalCampResults,
  simUnsignedWeek,
  spendPoint,
} from '../src/career/career';
import { GameSim } from '../src/career/gamesim';
import { autoMakeProb, coachRangeYd, costToRaise, evenSkills, levelCost, overall } from '../src/career/progression';
import type { Career, Team } from '../src/career/types';

const profile = { name: 'Austin Watson', hometown: 'Lakeview', school: 'Lakeview High', foot: 'R' as const, number: '3' };
const team = (strength: number): Team => ({ name: 'Test', short: 'TST', primary: '#123456', secondary: '#ffffff', strength });

describe('skill costs', () => {
  it('follow the tiers in the brief', () => {
    expect(levelCost(45)).toBe(1);
    expect(levelCost(59)).toBe(1);
    expect(levelCost(60)).toBe(2);
    expect(levelCost(79)).toBe(2);
    expect(levelCost(80)).toBe(3);
    expect(levelCost(90)).toBe(5);
  });
  it('add up across tiers', () => {
    expect(costToRaise(58, 62)).toBe(1 + 1 + 2 + 2);
    expect(costToRaise(40, 99)).toBe(20 * 1 + 20 * 2 + 10 * 3 + 9 * 5);
  });
  it('spending is refused without enough points', () => {
    const c = { ...newCareer(1, profile, 1), points: 0 };
    expect(spendPoint(c, 'power').skills.power).toBe(c.skills.power);
    const rich = { ...c, points: 5 };
    const after = spendPoint(rich, 'power');
    expect(after.skills.power).toBe(c.skills.power + 1);
    expect(after.points).toBe(4);
  });
});

describe('game sim', () => {
  for (const [level, lo, hi] of [['hs', 17, 30], ['college', 22, 34], ['nfl', 18, 28]] as const) {
    it(`scores look like ${level} football`, () => {
      let pts = 0;
      let kicks = 0;
      const N = 400;
      for (let i = 0; i < N; i++) {
        const g = new GameSim({ level, us: team(50), them: team(50), home: true, playoff: false, weather: 'clear', windMph: 5, windToDeg: 90, kicker: evenSkills(70), kickerName: 'Me', trust: 55, role: 'starter', rival: null, autoXp: false, seed: i + 7 });
        g.simToEnd();
        pts += g.us + g.them;
        kicks += g.myKicks.length;
      }
      const ppg = pts / N / 2;
      expect(ppg).toBeGreaterThan(lo);
      expect(ppg).toBeLessThan(hi);
      expect(kicks / N).toBeGreaterThan(2.5);
      expect(kicks / N).toBeLessThan(6.5);
    });
  }

  it('is deterministic for a seed', () => {
    const setup = { level: 'nfl' as const, us: team(55), them: team(48), home: true, playoff: false, weather: 'rain' as const, windMph: 12, windToDeg: 180, kicker: evenSkills(75), kickerName: 'Me', trust: 60, role: 'starter' as const, rival: null, autoXp: true, seed: 99 };
    const a = new GameSim(setup);
    const b = new GameSim(setup);
    a.simToEnd();
    b.simToEnd();
    expect(a.lines.map((l) => l.text)).toEqual(b.lines.map((l) => l.text));
  });

  it('a backup never kicks', () => {
    const g = new GameSim({ level: 'college', us: team(60), them: team(40), home: true, playoff: false, weather: 'clear', windMph: 0, windToDeg: 0, kicker: evenSkills(60), kickerName: 'Me', trust: 50, role: 'backup', rival: { name: 'Rival', overall: 70 }, autoXp: false, seed: 3 });
    g.simToEnd();
    expect(g.myKicks.length).toBe(0);
    expect(g.rivalKicks.length).toBeGreaterThan(0);
  });
});

describe('coach decisions', () => {
  it('follow trust and range', () => {
    const s = evenSkills(70);
    const low = coachRangeYd(s, 'clear', 0, 0);
    const high = coachRangeYd(s, 'clear', 0, 100);
    expect(high).toBeGreaterThan(low + 8);
    expect(coachRangeYd(evenSkills(90), 'clear', 0, 50)).toBeGreaterThan(coachRangeYd(evenSkills(50), 'clear', 0, 50));
    expect(coachRangeYd(s, 'snow', 0, 50)).toBeLessThan(coachRangeYd(s, 'clear', 0, 50));
  });

  it('low trust sends the kicker out less often from distance', () => {
    const count = (trust: number) => {
      let long = 0;
      for (let i = 0; i < 300; i++) {
        const g = new GameSim({ level: 'nfl', us: team(50), them: team(50), home: true, playoff: false, weather: 'clear', windMph: 0, windToDeg: 0, kicker: evenSkills(75), kickerName: 'Me', trust, role: 'starter', rival: null, autoXp: true, seed: i + 1 });
        g.simToEnd();
        long += g.myKicks.filter((k) => !k.xp && k.d >= 45).length;
      }
      return long;
    };
    expect(count(95)).toBeGreaterThan(count(5) * 1.3);
  });

  it('better kickers make more kicks', () => {
    expect(autoMakeProb(evenSkills(85), 50, 'clear', 0, 0)).toBeGreaterThan(autoMakeProb(evenSkills(50), 50, 'clear', 0, 0));
  });
});

/** Plays a whole career with simulated kicks. */
function autoCareer(seed: number, skillBoost = 0): { c: Career; stagesSeen: Set<string>; steps: number } {
  let c = newCareer(1, profile, seed);
  c.skills = evenSkills(44 + skillBoost);
  const stagesSeen = new Set<string>([c.stage]);
  let steps = 0;
  const rng = (() => {
    let s = seed;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  })();
  const kicks = (n: number, p: number) => Array.from({ length: n }, () => rng() < p);
  while (c.stage !== 'retired' && steps < 4000) {
    steps++;
    stagesSeen.add(c.stage);
    const p = c.pending;
    if (p) {
      switch (p.kind) {
        case 'camp':
          c = resolveCamp(c, kicks(5, 0.75), rivalCampResults(c, p.rival));
          break;
        case 'showcase':
          c = applyShowcase(c, kicks(p.purpose === 'draft' ? 6 : 5, 0.75));
          break;
        case 'offers':
          c = chooseOffer(c, p.offers[p.offers.length - 1]);
          break;
        case 'declare':
          c = declareForDraft(c, true);
          break;
        case 'draftResult':
          c = afterDraftResult(c);
          break;
        case 'tryout':
          c = resolveTryout(c, kicks(4, 0.8));
          break;
        case 'review':
          c = afterReview(c);
          break;
        case 'offseason':
          c = applyOffseasonCamp(c, kicks(5, 0.7));
          // Spend everything round-robin, like a player would.
          for (let i = 0; i < 200; i++) {
            const k = (['power', 'accuracy', 'composure', 'windControl', 'consistency'] as const)[i % 5];
            const before = c.points;
            c = spendPoint(c, k);
            if (c.points === before && i > 10) break;
          }
          c = finishOffseason(c);
          break;
        case 'retired':
          return { c, stagesSeen, steps };
      }
      continue;
    }
    const g = currentGame(c);
    if (g) {
      const sim = new GameSim(gameSetup(c, g));
      sim.simToEnd();
      c = recordGame(c, sim).career;
    } else if (c.role === 'unsigned' && c.inSeason) {
      c = simUnsignedWeek(c);
    } else {
      throw new Error(`stuck: ${c.stage} ${c.role} inSeason=${c.inSeason}`);
    }
  }
  return { c, stagesSeen, steps };
}

describe('career transitions', () => {
  it('a career runs from high school to retirement', () => {
    const { c, stagesSeen } = autoCareer(11, 10);
    expect(stagesSeen.has('hs')).toBe(true);
    expect(stagesSeen.has('college')).toBe(true);
    expect(c.stage).toBe('retired');
    expect(c.summary?.verdict).toBeTruthy();
    expect(c.history.length).toBeGreaterThanOrEqual(5);
    expect(c.history[0].stage).toBe('hs');
  });

  it('many careers never get stuck', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { c } = autoCareer(seed * 31, seed % 3 === 0 ? 0 : 12);
      expect(c.stage).toBe('retired');
    }
  });

  it('high school lasts two seasons, then recruiting gives stars and offers', () => {
    let c = newCareer(1, profile, 5);
    expect(c.pending?.kind).toBe('camp');
    c = resolveCamp(c, [true, true, true, true, true], [false, false, false, false, false]);
    expect(c.role).toBe('starter');
    expect(c.schedule.length).toBe(CONFIG.career.seasons.hs.games);
    while (c.inSeason) {
      const sim = new GameSim(gameSetup(c, currentGame(c)!));
      sim.simToEnd();
      c = recordGame(c, sim).career;
    }
    expect(c.pending?.kind).toBe('review');
    c = finishOffseason(afterReview(c));
    expect(c.pending?.kind).toBe('showcase');
    c = applyShowcase(c, [true, true, true, false, false]);
    expect(c.stars).toBeGreaterThanOrEqual(2);
    expect(c.seasonNo).toBe(2);
    while (c.inSeason) {
      const sim = new GameSim(gameSetup(c, currentGame(c)!));
      sim.simToEnd();
      c = recordGame(c, sim).career;
    }
    c = finishOffseason(afterReview(c));
    expect(c.pending?.kind).toBe('offers');
    if (c.pending?.kind === 'offers') {
      expect(c.pending.offers.some((o) => o.rivalOvr === null)).toBe(true);
      c = chooseOffer(c, c.pending.offers[0]);
    }
    expect(c.stage).toBe('college');
    expect(c.level).toBe('college');
  });

  it('losing an NFL camp battle gets you cut', () => {
    let c = newCareer(1, profile, 8);
    c.stage = 'nfl';
    c.team = team(50);
    c.rival = { name: 'Vet', overall: 85 };
    c.pending = { kind: 'camp', title: 'camp', rival: c.rival, why: '' };
    c = resolveCamp(c, [false, false, false, false, false], [true, true, true, true, true]);
    expect(c.role).toBe('unsigned');
    expect(c.team).toBeNull();
  });

  it('overall averages the five skills', () => {
    expect(overall({ power: 50, accuracy: 60, composure: 70, windControl: 80, consistency: 90 })).toBe(70);
  });
});
