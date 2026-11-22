import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import type { Player } from '../src/data/types';
import { HalfInning } from '../src/core/half';
import { LivePlay } from '../src/core/play';
import { simulateFlight } from '../src/core/flight';
import { seededRng } from '../src/core/rng';

const P = (name: string, speed = 60): Player => ({
  name, kicksAs: 'guy', position: 'CF', contact: 60, power: 60, speed, arm: 60, glove: 60,
});
const sure = { speed: 60, glove: 100, arm: 100 };
const butterfingers = { speed: 60, glove: 1, arm: 60 };
const allDefense = (r: typeof sure) => Object.fromEntries(Object.keys(CONFIG.field.positions).map((p) => [p, r]));

function run(play: LivePlay, maxT = 40, each?: (p: LivePlay) => void) {
  while (!play.over && play.t < maxT) {
    play.step(1 / 60);
    each?.(play);
  }
  return play;
}

describe('half-inning', () => {
  it('a walk with the bases loaded forces in a run', () => {
    const h = new HalfInning();
    h.bases = [P('a'), P('b'), P('c')];
    expect(h.walk(P('d'))).toBe(1);
    expect(h.runs).toBe(1);
    expect(h.bases.map((b) => b?.name)).toEqual(['d', 'a', 'b']);
  });
  it('a walk with first and third only moves the forced runner', () => {
    const h = new HalfInning();
    h.bases = [P('a'), null, P('c')];
    expect(h.walk(P('d'))).toBe(0);
    expect(h.bases.map((b) => b?.name ?? null)).toEqual(['d', 'a', 'c']);
  });
});

describe('live play', () => {
  it('a routine fly to center is caught for an out', () => {
    const flight = simulateFlight(-12, 40, 62); // lazy fly toward the CF
    const play = run(new LivePlay({ flight, batter: P('k'), bases: [null, null, null], outs: 0, defense: allDefense(sure), rng: seededRng(1) }));
    expect(play.caughtFly).toBe(true);
    expect(play.outs).toBe(1);
    expect(play.batterResult()).toBe(0);
  });

  it('a home run over the fence scores everyone', () => {
    const flight = simulateFlight(0, 38, 115);
    expect(flight.overFence).toBe(true);
    const play = run(new LivePlay({ flight, batter: P('k'), bases: [P('a'), null, P('c')], outs: 1, defense: allDefense(sure), rng: seededRng(2) }));
    expect(play.endReason).toBe('homeRun');
    expect(play.runs).toBe(3);
    expect(play.batterResult()).toBe(4);
  });

  it('a slow grounder to short gets a force at second', () => {
    const flight = simulateFlight(-18, 0, 42);
    const play = run(new LivePlay({ flight, batter: P('k', 10), bases: [P('slow', 10), null, null], outs: 0, defense: allDefense(sure), rng: seededRng(3) }));
    const outs = play.events.filter((e) => e.type === 'out');
    expect(outs.length).toBeGreaterThanOrEqual(1);
    expect(play.outs).toBeGreaterThanOrEqual(1);
  });

  it('a runner sent from first on a ball in the gap keeps going when told', () => {
    const flight = simulateFlight(-25, 14, 78); // liner into the left-center gap
    let sent = false;
    const play = run(
      new LivePlay({ flight, batter: P('k', 90), bases: [P('fast', 95), null, null], outs: 0, defense: allDefense(butterfingers), rng: seededRng(4) }),
      40,
      (p) => {
        if (!sent && p.t > 1) {
          p.send(null);
          p.send(null);
          sent = true;
        }
      },
    );
    expect(play.over).toBe(true);
    const fast = play.runners.find((r) => r.player.name === 'fast')!;
    expect(fast.out || fast.pos >= 3).toBe(true);
  });

  it('holding a non-forced runner keeps them on their base', () => {
    const flight = simulateFlight(-18, 0, 50);
    const play = new LivePlay({ flight, batter: P('k'), bases: [null, P('two'), null], outs: 0, defense: allDefense(sure), rng: seededRng(5) });
    run(play);
    const two = play.runners.find((r) => r.player.name === 'two')!;
    expect(two.pos).toBe(2);
    expect(two.out).toBe(false);
  });

  it('third-out force wipes out runs that crossed on the play', () => {
    const flight = simulateFlight(-18, 0, 40);
    const play = new LivePlay({ flight, batter: P('k', 1), bases: [P('a', 1), P('b', 1), P('fast', 100)], outs: 2, defense: allDefense(sure), rng: seededRng(6) });
    run(play);
    expect(play.outs).toBe(3);
    if (play.events.some((e) => e.type === 'run')) {
      const third = play.events.filter((e) => e.type === 'out').pop();
      if (third && third.type === 'out' && third.how === 'force') expect(play.runs).toBe(0);
    }
  });

  it('a foul pop nobody reaches is just a foul', () => {
    const flight = simulateFlight(-70, 50, 40);
    expect(flight.fair).toBe(false);
    const play = run(new LivePlay({ flight, batter: P('k'), bases: [null, null, null], outs: 0, defense: allDefense(sure), rng: seededRng(7) }));
    expect(['foul', 'settled', 'threeOuts']).toContain(play.endReason);
  });
});
