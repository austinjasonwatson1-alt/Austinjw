// Story systems: traits you unlock, slumps that stick, press conferences, the rival who follows
// your career, the legacy wall and the difficulty setting. No UI code.

import { CONFIG, type Weather } from '../config';
import type { KickerRatings } from '../kick/physics';
import { COLLEGES, NFL_TEAMS } from './data';
import { clampSkill } from './progression';
import type { Career, KickLog } from './types';
import type { Rng } from '../sim/rng';

// ---------------------------------------------------------------------------
// Traits

export interface Counters {
  fgMade: number;
  clutchMade: number; // game-winning / tying / go-ahead makes
  windMade: number; // made FGs in 12+ mph wind
  badWeatherMade: number; // made FGs in rain, snow or cold
  pressureMade: number; // made FGs with pressure >= 0.6
  streak: number;
  bestStreak: number;
  long: number;
}

export const blankCounters = (): Counters => ({ fgMade: 0, clutchMade: 0, windMade: 0, badWeatherMade: 0, pressureMade: 0, streak: 0, bestStreak: 0, long: 0 });

export type TraitId = 'bigLeg' | 'iceWater' | 'windWhisperer' | 'coldBlooded' | 'metronome' | 'closer' | 'automatic';

export interface TraitDef {
  id: TraitId;
  name: string;
  effect: string;
  goal: string;
  progress: (k: Counters) => [number, number];
}

export const TRAITS: TraitDef[] = [
  { id: 'bigLeg', name: 'Big Leg', effect: '+3 Power', goal: 'Make a 55-yard field goal', progress: (k) => [Math.min(k.long, 55), 55] },
  { id: 'iceWater', name: 'Ice Water', effect: 'Icing no longer speeds up your meters', goal: 'Make 3 game-winning or tying kicks', progress: (k) => [k.clutchMade, 3] },
  { id: 'windWhisperer', name: 'Wind Whisperer', effect: '+8 Wind control', goal: 'Make 20 field goals in 12+ mph wind', progress: (k) => [k.windMade, 20] },
  { id: 'coldBlooded', name: 'Cold Blooded', effect: '+6 Power in rain, snow and cold', goal: 'Make 12 field goals in bad weather', progress: (k) => [k.badWeatherMade, 12] },
  { id: 'metronome', name: 'Metronome', effect: '+8 Consistency', goal: 'Make 15 field goals in a row', progress: (k) => [k.bestStreak, 15] },
  { id: 'closer', name: 'The Closer', effect: '+8 Composure', goal: 'Make 12 high-pressure field goals', progress: (k) => [k.pressureMade, 12] },
  { id: 'automatic', name: 'Automatic', effect: '+5 Accuracy', goal: 'Make 100 career field goals', progress: (k) => [k.fgMade, 100] },
];

export function hasTrait(c: Career, id: TraitId): boolean {
  return (c.traits ?? []).includes(id);
}

/** Update counters from a game's kicks and return any newly unlocked traits. */
export function trackKicks(c: Career, kicks: KickLog[], windMph: number, weather: Weather): TraitDef[] {
  const k = (c.counters ??= blankCounters());
  for (const kick of kicks) {
    if (kick.xp) continue;
    if (!kick.made) {
      k.streak = 0;
      continue;
    }
    k.fgMade++;
    k.streak++;
    k.bestStreak = Math.max(k.bestStreak, k.streak);
    k.long = Math.max(k.long, kick.d);
    if (kick.gw) k.clutchMade++;
    if (windMph >= 12) k.windMade++;
    if (weather !== 'clear') k.badWeatherMade++;
    if (kick.pressure >= 0.6) k.pressureMade++;
  }
  const have = new Set(c.traits ?? []);
  const fresh = TRAITS.filter((t) => !have.has(t.id) && t.progress(k)[0] >= t.progress(k)[1]);
  c.traits = [...have, ...fresh.map((t) => t.id)];
  return fresh;
}

// ---------------------------------------------------------------------------
// Slumps

export interface Slump {
  level: number; // 0..1
  reason: string;
}

export function startSlump(c: Career, reason: string) {
  const level = Math.min(1, (c.slump?.level ?? 0) + CONFIG.story.slump.start);
  c.slump = { level, reason };
}

/** After each game: slumps fade; a clutch make ends one outright. */
export function easeSlump(c: Career, clutchMade: boolean): 'ended' | 'eased' | null {
  if (!c.slump) return null;
  if (clutchMade) {
    c.slump = null;
    return 'ended';
  }
  const level = c.slump.level - CONFIG.story.slump.decayPerGame;
  c.slump = level <= 0.05 ? null : { ...c.slump, level };
  return c.slump ? 'eased' : 'ended';
}

// ---------------------------------------------------------------------------
// Effective ratings: skills + traits - slump (+ difficulty, applied in the kick scene)

export function effectiveSkills(c: Career, weather: Weather = 'clear'): KickerRatings {
  const s = { ...c.skills };
  if (hasTrait(c, 'bigLeg')) s.power += 3;
  if (hasTrait(c, 'windWhisperer')) s.windControl += 8;
  if (hasTrait(c, 'coldBlooded') && weather !== 'clear') s.power += 6;
  if (hasTrait(c, 'metronome')) s.consistency += 8;
  if (hasTrait(c, 'closer')) s.composure += 8;
  if (hasTrait(c, 'automatic')) s.accuracy += 5;
  if (c.slump) {
    s.composure -= CONFIG.story.slump.composureHit * c.slump.level;
    s.accuracy -= CONFIG.story.slump.accuracyHit * c.slump.level;
  }
  return {
    power: clampSkill(s.power),
    accuracy: clampSkill(s.accuracy),
    composure: clampSkill(s.composure),
    windControl: clampSkill(s.windControl),
    consistency: clampSkill(s.consistency),
  };
}

// ---------------------------------------------------------------------------
// Press conferences

export interface PressChoice {
  label: string;
  quote: string;
  trust: number;
  slump: number; // added to slump level (negative helps)
}

export interface PressConf {
  id: string;
  headline: string;
  question: string;
  choices: PressChoice[];
}

export function pressFor(kind: 'gwMade' | 'gwMissed' | 'record' | 'rough', name: string, detail: string): PressConf {
  const first = name.split(' ')[0];
  switch (kind) {
    case 'gwMade':
      return {
        id: kind,
        headline: `${name} wins it`,
        question: `${first}, walk us through that last kick. What was going through your head?`,
        choices: [
          { label: 'Credit the unit', quote: 'Great snap, perfect hold. I just had to swing.', trust: 3, slump: -0.3 },
          { label: 'Ice in the veins', quote: "I want that kick every time. Put the game on my foot.", trust: 5, slump: -0.2 },
          { label: 'Stay humble', quote: "Just happy to help us win. Next week's a new week.", trust: 2, slump: -0.4 },
        ],
      };
    case 'gwMissed':
      return {
        id: kind,
        headline: `Miss costs the game`,
        question: `${first}, the game was on your foot ${detail}. What happened?`,
        choices: [
          { label: 'Own it', quote: "That's on me. I'll be better. Nobody's harder on me than me.", trust: 2, slump: -0.3 },
          { label: 'Blame the conditions', quote: 'The wind did something weird out there.', trust: -4, slump: 0.15 },
          { label: 'Short memory', quote: "Kickers miss. I'll make the next one.", trust: 0, slump: -0.15 },
        ],
      };
    case 'record':
      return {
        id: kind,
        headline: `${name} sets a record`,
        question: `${first}, ${detail}. Did you know you were chasing it?`,
        choices: [
          { label: 'Thank the team', quote: "Doesn't happen without the ten guys in front of me.", trust: 3, slump: -0.2 },
          { label: 'Aim higher', quote: "Nice moment. I'm not done.", trust: 2, slump: -0.2 },
          { label: 'Shrug it off', quote: 'Records are for after the career. We play next week.', trust: 1, slump: -0.1 },
        ],
      };
    case 'rough':
      return {
        id: kind,
        headline: 'A rough day for the kicker',
        question: `${first}, ${detail} today. Is something off?`,
        choices: [
          { label: 'Fix it in practice', quote: "I'll be out there early all week. I'll fix it.", trust: 2, slump: -0.2 },
          { label: 'Nothing to see', quote: "I feel great. It's football.", trust: -1, slump: 0 },
          { label: 'Snap at the reporter', quote: "Next question.", trust: -4, slump: 0.2 },
        ],
      };
  }
}

export function applyPress(c: Career, pc: PressConf, i: number): Career {
  const ch = pc.choices[i];
  const n: Career = { ...c, trust: Math.max(0, Math.min(100, c.trust + ch.trust)) };
  if (n.slump || ch.slump > 0) {
    const level = Math.max(0, Math.min(1, (n.slump?.level ?? 0) + ch.slump));
    n.slump = level <= 0.05 ? null : { level, reason: n.slump?.reason ?? 'A tough week in the press' };
  }
  n.news = [`${n.year} · "${ch.quote}" ${n.kicker.name.split(' ')[0]} told reporters.`, ...n.news].slice(0, 40);
  return n;
}

// ---------------------------------------------------------------------------
// The rival who follows you

export interface Nemesis {
  name: string;
  overall: number;
  team: string | null; // where he kicks now
  teamShort: string | null;
  note: string;
}

/** Move the rival along with the career: college when you go to college, maybe the NFL when you get there. */
export function advanceNemesis(c: Career, rng: Rng): string | null {
  const n = c.nemesis;
  if (!n) return null;
  if (c.stage === 'college' && !n.team) {
    const tier = n.overall >= 52 ? 'mid' : 'small';
    const t = rng.pick(COLLEGES.filter((x) => x.tier === tier));
    c.nemesis = { ...n, team: t.name, teamShort: t.short, overall: n.overall + 6, note: `kicks for ${t.name}` };
    return `Your old rival ${n.name} is kicking at ${t.name}.`;
  }
  if (c.stage === 'nfl' && n.team && !NFL_TEAMS.some((t) => t.name === n.team) && n.note !== 'out of football') {
    if (rng.next() < 0.6) {
      const t = rng.pick(NFL_TEAMS.filter((x) => x.name !== c.team?.name));
      c.nemesis = { ...n, team: t.name, teamShort: t.short, overall: Math.max(n.overall, 74), note: `kicks for the ${t.name}` };
      return `${n.name} made it too. He's the kicker for the ${t.name}.`;
    }
    c.nemesis = { ...n, team: null, teamShort: null, note: 'out of football' };
    return `${n.name} didn't catch on in the NFL. He's out of football.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Legacy wall and global settings (browser storage, always guarded)

export interface LegacyEntry {
  name: string;
  years: string;
  verdict: string;
  points: number;
  nflPoints: number;
  longest: number;
  titles: number;
  honors: number;
}

const LEGACY = 'rtn.legacy';
const SETTINGS = 'rtn.settings';

export function readLegacy(): LegacyEntry[] {
  try {
    return JSON.parse(localStorage.getItem(LEGACY) ?? '[]') as LegacyEntry[];
  } catch {
    return [];
  }
}

export function addLegacy(e: LegacyEntry) {
  try {
    const rest = readLegacy().filter((x) => !(x.name === e.name && x.years === e.years));
    localStorage.setItem(LEGACY, JSON.stringify([e, ...rest].slice(0, 30)));
  } catch {
    /* storage blocked */
  }
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface Settings {
  difficulty: Difficulty;
  tutorialDone: boolean;
}

export function readSettings(): Settings {
  try {
    return { difficulty: 'normal', tutorialDone: false, ...(JSON.parse(localStorage.getItem(SETTINGS) ?? '{}') as Partial<Settings>) };
  } catch {
    return { difficulty: 'normal', tutorialDone: false };
  }
}

export function writeSettings(s: Partial<Settings>) {
  try {
    localStorage.setItem(SETTINGS, JSON.stringify({ ...readSettings(), ...s }));
  } catch {
    /* storage blocked */
  }
}

/** Difficulty shifts the ratings the kick uses and the meter speed. */
export function applyDifficulty(k: KickerRatings, d: Difficulty): KickerRatings {
  const D = CONFIG.difficulty[d];
  return {
    power: k.power,
    accuracy: clampSkill(k.accuracy + D.accuracy),
    composure: clampSkill(k.composure + D.composure),
    windControl: clampSkill(k.windControl + D.windControl),
    consistency: clampSkill(k.consistency + D.consistency),
  };
}
