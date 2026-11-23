import type { LevelKey, Weather } from '../config';
import type { KickerRatings } from '../kick/physics';
import type { RecordBook } from './records';
import type { Standings } from './standings';

export type Stage = 'hs' | 'college' | 'draft' | 'nfl' | 'retired';
export type SkillKey = keyof KickerRatings;
export type Role = 'starter' | 'backup' | 'unsigned';

export interface Team {
  name: string;
  short: string;
  primary: string;
  secondary: string;
  strength: number; // 0..100 team quality this season
  tier?: 'major' | 'mid' | 'small';
  conference?: string;
}

export interface Rival {
  name: string;
  overall: number;
}

export interface KickLog {
  d: number; // distance, yards
  made: boolean;
  xp: boolean;
  pressure: number;
  gw: boolean; // a game-winning (or tying) attempt
  q: number;
  clock: string;
  by: 'me' | 'rival';
}

export interface GameResult {
  us: number;
  them: number;
  kicks: KickLog[]; // mine
  pointsEarned: number;
  trustBefore: number;
  trustAfter: number;
  notes: string[];
  ot: boolean;
}

export interface SchedGame {
  week: number;
  opp: Team;
  home: boolean;
  label?: string; // "State Quarterfinal", "Wild Card", "Bowl Game"…
  playoff: boolean;
  weather: Weather;
  windMph: number;
  windToDeg: number;
  tempF: number;
  result?: GameResult;
}

export interface SeasonLine {
  year: number;
  age: number;
  stage: 'hs' | 'college' | 'nfl';
  label: string; // Junior, Freshman, Rookie, Year 3…
  team: string;
  teamShort: string;
  role: Role;
  games: number;
  w: number;
  l: number;
  fgm: number;
  fga: number;
  xpm: number;
  xpa: number;
  long: number;
  points: number;
  honors: string[];
  postseason: string;
}

export interface Contract {
  years: number;
  salary: number; // $M per year
}

export interface Offer {
  id: string;
  kind: 'walkon' | 'scholarship' | 'starter' | 'drafted' | 'udfa' | 'freeAgent';
  team: Team;
  title: string;
  note: string;
  rivalOvr: number | null; // null = the job is yours
  contract?: Contract;
}

export type Pending =
  | { kind: 'camp'; title: string; rival: Rival; why: string }
  | { kind: 'showcase'; purpose: 'recruiting' | 'draft' }
  | { kind: 'offers'; title: string; offers: Offer[] }
  | { kind: 'declare'; forced: boolean }
  | { kind: 'draftResult'; text: string; drafted: boolean; offer: Offer | null }
  | { kind: 'tryout'; team: Team; contract: Contract }
  | { kind: 'review'; line: SeasonLine; notes: string[] }
  | { kind: 'offseason'; campDone: boolean }
  | { kind: 'retired' };

export interface KickerProfile {
  name: string;
  hometown: string;
  school: string;
  foot: 'R' | 'L';
  number: string;
}

export interface Career {
  v: 1;
  slot: number;
  createdAt: number;
  updatedAt: number;
  seed: number;
  kicker: KickerProfile;
  stage: Stage;
  level: LevelKey;
  year: number;
  age: number;
  seasonNo: number; // season number within the stage (1 = junior / freshman / rookie)
  skills: KickerRatings;
  points: number;
  trust: number;
  team: Team | null;
  role: Role;
  rival: Rival | null;
  rivalForm: boolean[]; // the starter's recent kicks, when I'm the backup
  schedule: SchedGame[];
  week: number; // index of the next game in schedule (or week counter while unsigned)
  inSeason: boolean;
  drillDone: boolean;
  drillBank?: number; // drill progress toward the next level
  stars: number | null;
  recruitScore: number | null;
  contract: Contract | null;
  pending: Pending | null;
  season: SeasonLine | null;
  history: SeasonLine[];
  log: { d: number; made: boolean; xp: boolean; stage: 'hs' | 'college' | 'nfl' }[];
  lastTen: boolean[]; // last NFL FG attempts, newest last
  honors: string[];
  titles: string[];
  news: string[];
  longest: number;
  unsignedWeeks: number;
  draftNote: string | null;
  settings: { autoXp: boolean };
  summary: CareerSummary | null;
  records?: RecordBook | null;
  recordsBroken?: string[];
  standings?: Standings | null;
}

export interface CareerSummary {
  points: number;
  fgm: number;
  fga: number;
  xpm: number;
  xpa: number;
  longest: number;
  nflPoints: number;
  nflSeasons: number;
  honors: string[];
  titles: string[];
  verdict: string;
  verdictNote: string;
}
