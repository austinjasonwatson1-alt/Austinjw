// The broadcast booth: a play-by-play voice and an analyst, written from the situation.

import type { Weather } from '../config';
import type { KickResult, Trajectory } from './physics';

export interface BoothContext {
  kickerName: string;
  distance: number;
  xp: boolean;
  windMph: number;
  windWords: string; // "In your face, left to right"
  weather: Weather;
  pressure: number; // raw 0..1
  tag: string | null; // GAME-WINNER, TO TIE…
  iced: boolean;
  vouched: boolean;
  hurry: boolean;
  swirl: boolean;
  home: boolean;
  seasonLine: string | null; // "12 of 14 this season"
  longest: number | null; // season or career long
  practice: boolean;
}

export interface Caption {
  who: 'Play-by-play' | 'Analyst';
  text: string;
}

function pick<T>(seed: number, items: T[]): T {
  return items[Math.abs(Math.floor(seed)) % items.length];
}

export function preKick(c: BoothContext, seed: number): Caption {
  const last = c.kickerName.split(' ').slice(-1)[0];
  if (c.practice) return { who: 'Analyst', text: pick(seed, [`Just ${last} and the posts. Find a rhythm.`, `Practice reps. Same routine every time.`, `Watch the flags before you aim.`]) };
  if (c.hurry) return { who: 'Play-by-play', text: `No timeouts! ${last} has to line it up on the run!` };
  if (c.iced) return { who: 'Analyst', text: `They called timeout to make him think about it. Classic icing.` };
  if (c.tag === 'GAME-WINNER') return { who: 'Play-by-play', text: `${c.distance} yards for the win. Everything comes down to this.` };
  if (c.tag === 'TO TIE') return { who: 'Play-by-play', text: `${last} lines up from ${c.distance} to tie it.` };
  if (c.tag === 'GO-AHEAD') return { who: 'Play-by-play', text: `${c.distance} yards to take the lead late.` };
  if (c.vouched) return { who: 'Analyst', text: `He told his coach he could make it from ${c.distance}. Now he has to back it up.` };
  if (c.xp) return { who: 'Play-by-play', text: pick(seed, [`${last} on for the extra point.`, `Extra point try, ${last} to kick.`]) };
  if (c.swirl && c.windMph >= 8) return { who: 'Analyst', text: `This place swirls. Those flags can lie to you.` };
  if (c.windMph >= 14) return { who: 'Analyst', text: `${c.windMph} mile-an-hour wind, ${c.windWords.toLowerCase()}. He has to play that.` };
  if (c.weather === 'snow') return { who: 'Analyst', text: `Snow on the field. Footing and a heavy ball cost you distance.` };
  if (c.weather === 'rain') return { who: 'Analyst', text: `Wet ball, wet hold. Ugly conditions for a kicker.` };
  if (c.distance >= 52) return { who: 'Play-by-play', text: `${c.distance} yards. That's a big ask.` };
  if (c.seasonLine && seed % 2 === 0) return { who: 'Analyst', text: `${last} is ${c.seasonLine}.` };
  if (!c.home && c.pressure >= 0.4) return { who: 'Play-by-play', text: `The crowd's trying to get in his head here.` };
  return { who: 'Play-by-play', text: pick(seed, [`${last} sets up from ${c.distance}.`, `${c.distance}-yard try for ${last}.`, `Here's ${last} from ${c.distance} out.`]) };
}

export function inFlight(c: BoothContext, seed: number, trajectory: Trajectory): Caption {
  if (trajectory === 'low') return { who: 'Play-by-play', text: 'Low line drive...' };
  if (trajectory === 'high') return { who: 'Play-by-play', text: 'High and lofty...' };
  if (c.distance >= 50) return { who: 'Play-by-play', text: pick(seed, ['Does he have the leg...', 'It is a long way...', "It's on line... is it long enough..."]) };
  return { who: 'Play-by-play', text: pick(seed, ['The kick is up...', "It's away...", 'Kick is on the way...']) };
}

export function afterKick(c: BoothContext, r: KickResult, seed: number): Caption {
  const last = c.kickerName.split(' ').slice(-1)[0];
  const big = !!c.tag;
  switch (r.outcome) {
    case 'GOOD':
      if (big) return { who: 'Analyst', text: `Ice water. ${last} didn't flinch.` };
      if (c.distance >= 52) return { who: 'Analyst', text: `That's a big-time leg. It would've been good from ${Math.round(r.carryYd)}.` };
      if (c.vouched) return { who: 'Analyst', text: `Told the coach he had it, and he had it.` };
      return { who: 'Analyst', text: pick(seed, ['Right down the middle.', 'Never in doubt.', 'Smooth swing, pure contact.', 'Automatic.']) };
    case 'GOOD_UPRIGHT':
    case 'GOOD_CROSSBAR':
      return { who: 'Analyst', text: `Ugly, but they all count the same.` };
    case 'UPRIGHT_NO':
    case 'CROSSBAR_NO':
      return { who: 'Analyst', text: `Inches. That one will keep him up tonight.` };
    case 'SHORT':
      return { who: 'Analyst', text: c.windWords.startsWith('In') ? `The wind knocked that down.` : `Just didn't have the leg from there.` };
    case 'BLOCKED':
      return { who: 'Play-by-play', text: `BLOCKED! They got a hand on it!` };
    default:
      if (!r.inSweetSpot) return { who: 'Analyst', text: r.strikeMiss < 0 ? `He pulled it. Hooked it left from the start.` : `Pushed it right. Never had a chance.` };
      return { who: 'Analyst', text: c.windMph >= 10 ? `Good swing, but the wind took it.` : `He's going to want that one back.` };
  }
}
