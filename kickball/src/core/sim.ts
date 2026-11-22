import { CONFIG } from '../config';
import { aiKick, aiPitchChoice, pitchScatter } from './ai';
import { applyPitch, freshCount } from './count';
import { simulateFlight } from './flight';
import type { GameState } from './game';
import { resolveKick } from './kick';
import { generatePitch } from './pitch';
import { LivePlay } from './play';
import type { Rng } from './rng';

/** Plays one plate appearance with computers on both sides. */
export function simulatePlateAppearance(game: GameState, rng: Rng): void {
  let count = freshCount();
  const def = game.defense();
  const pitcher = def.P;
  const kicker = game.kickerUp;
  for (let guard = 0; guard < 60; guard++) {
    const choice = aiPitchChoice(rng);
    const pitch = generatePitch(rng, undefined, { ...choice, scatter: pitchScatter(pitcher.arm) });
    const k = aiKick(pitch, kicker, rng);
    if (!k.swing) {
      const r = applyPitch(count, pitch.isStrike ? 'calledStrike' : 'ball');
      count = r.count;
      if (r.result === 'walk') return game.walk();
      if (r.result === 'strikeout') return game.out();
      continue;
    }
    const out = resolveKick({ pitch, kicker, ...k }, rng);
    if (out.kind === 'whiff') {
      const r = applyPitch(count, 'whiff');
      count = r.count;
      if (r.result === 'strikeout') return game.out();
      continue;
    }
    const flight = simulateFlight(out.sprayDeg, out.launchDeg, out.exitSpeed);
    const play = new LivePlay({
      flight,
      batter: kicker,
      bases: game.half.bases,
      outs: game.half.outs,
      defense: def,
      rng,
      autoRun: true,
    });
    while (!play.over) play.step(1 / 60);
    if (play.endReason === 'foul' && !play.caughtFly) {
      const r = applyPitch(count, 'foul');
      count = r.count;
      if (r.result === 'foulout') return game.out();
      continue;
    }
    return game.applyPlay(play);
  }
  game.out();
}

/** Plays the current half-inning to three outs (or a walk-off). Returns true if the game ended. */
export function simulateHalf(game: GameState, rng: Rng): boolean {
  while (!game.half.over && !game.over) simulatePlateAppearance(game, rng);
  if (game.over) return true;
  return game.endHalf();
}

export function simulateGame(game: GameState, rng: Rng): GameState {
  for (let guard = 0; guard < 60 && !game.over; guard++) simulateHalf(game, rng);
  return game;
}

export const SIM_RULES = CONFIG.rules;
