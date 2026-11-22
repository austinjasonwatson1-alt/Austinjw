import { CONFIG } from '../config';

export interface Count {
  balls: number;
  strikes: number;
  fouls: number;
}

export type PitchEvent = 'ball' | 'calledStrike' | 'whiff' | 'foul' | 'fair';
export type AtBatResult = 'continue' | 'walk' | 'strikeout' | 'foulout' | 'inPlay';

export const freshCount = (): Count => ({ balls: 0, strikes: 0, fouls: 0 });

export function applyPitch(count: Count, event: PitchEvent): { count: Count; result: AtBatResult } {
  const c = { ...count };
  const R = CONFIG.rules;
  switch (event) {
    case 'ball':
      c.balls++;
      return { count: c, result: c.balls >= R.ballsForWalk ? 'walk' : 'continue' };
    case 'calledStrike':
    case 'whiff':
      c.strikes++;
      return { count: c, result: c.strikes >= R.strikesForOut ? 'strikeout' : 'continue' };
    case 'foul':
      c.fouls++;
      return { count: c, result: c.fouls >= R.foulsForOut ? 'foulout' : 'continue' };
    case 'fair':
      return { count: c, result: 'inPlay' };
  }
}
