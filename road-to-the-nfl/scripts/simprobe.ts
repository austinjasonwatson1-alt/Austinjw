// Prints average scores and kick counts per level. Run: npx vite-node scripts/simprobe.ts
import { GameSim } from '../src/career/gamesim';
import { evenSkills } from '../src/career/progression';
const team = (name: string, strength: number) => ({ name, short: name.slice(0, 3).toUpperCase(), primary: '#123456', secondary: '#ffffff', strength });
for (const level of ['hs', 'college', 'nfl'] as const) {
  let pts = 0, kicks = 0, fga = 0, gw = 0, ot = 0, close = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const g = new GameSim({ level, us: team('Us', 50), them: team('Them', 50), home: i % 2 === 0, playoff: false, weather: 'clear', windMph: 6, windToDeg: 90, kicker: evenSkills(level === 'hs' ? 45 : level === 'college' ? 62 : 78), kickerName: 'Me', trust: 55, role: 'starter', rival: null, autoXp: false, seed: i + 1 });
    g.simToEnd();
    pts += g.us + g.them; kicks += g.myKicks.length; fga += g.myKicks.filter(k => !k.xp).length; gw += g.myKicks.some(k => k.gw) ? 1 : 0; ot += g.ot ? 1 : 0; close += Math.abs(g.us - g.them) <= 3 ? 1 : 0;
  }
  console.log(level, 'pts/team', (pts / N / 2).toFixed(1), 'my kicks', (kicks / N).toFixed(2), 'FGA', (fga / N).toFixed(2), 'gw games %', (gw / N * 100).toFixed(1), 'OT %', (ot / N * 100).toFixed(1), 'within 3 %', (close / N * 100).toFixed(1));
}
