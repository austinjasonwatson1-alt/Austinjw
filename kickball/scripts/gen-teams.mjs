// Generates the 11 opponent rosters into src/data/teams.json, keeping your team as-is.
// Run once: node scripts/gen-teams.mjs  (re-running overwrites opponent edits)
import fs from 'node:fs';

const file = new URL('../src/data/teams.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const mine = data.teams.find((t) => t.isPlayer);

let seed = 20261122;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
const pick = (a) => a.splice(Math.floor(rnd() * a.length), 1)[0];

const guyNames = ['Marcus','Derek','Tyler','Jordan','Ben','Kyle','Nate','Sam','Luis','Andre','Matt','Ryan','Josh','Eli','Owen','Jake','Chris','Devin','Omar','Brett','Cody','Hank','Raj','Theo','Gabe','Pete','Wes','Drew','Leo','Max','Isaac','Zane','Colin','Dante','Grant','Felix','Jamal','Victor','Seth','Ian','Rory','Shane','Toby','Quinn','Mateo','Nico','Brady','Caleb','Damon','Evan','Frank','Garrett','Hugo','Jonah','Kurt','Lance','Miles','Noah','Oscar','Paul','Reed','Scott','Trent','Uri','Vince','Wyatt','Xavier','Yusuf','Zach R.','Aaron','Blake','Carl','Dev','Ethan','Finn','Gus','Hector','Jay','Kevin','Liam','Mason','Neil','Pablo','Russ','Sean','Tom','Ulysses','Walt','Bryce','Clay','Dean','Emmett','Fred','Glen','Hayden','Jared','Kai'];
const girlNames = ['Megan','Tara','Priya','Jess','Lauren','Nina','Sofia','Kate','Rachel','Amber','Brooke','Carmen','Dana','Erin','Fiona','Gina','Hannah','Iris','Jade','Kim','Lena','Maya','Nora','Olivia','Paige','Quinn S.','Rosa','Sara','Tess','Uma','Vera','Willa','Yara','Zoe','Ava','Bella','Cara','Daisy','Elle','Faith','Grace','Holly','Ivy','June','Kayla','Lucy','Mia','Nadia','Ruby','Stella'];

const tiers = [
  ['Ballbarians', 70], ['Roll Models', 70], ['Base Invaders', 70],
  ['Sole Survivors', 60], ['New Kicks on the Block', 58], ['Toe Jammers', 55], ['Grass Kickers', 53], ['Kicking and Screaming', 50],
  ['Balls on Parade', 40], ['The Bunt Cakes', 40], ['Recess Rejects', 40],
];
const positions = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RC', 'RF'];
const clamp = (v) => Math.max(10, Math.min(99, Math.round(v)));
const slug = (s) => s.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

const opponents = tiers.map(([name, avg]) => {
  const n = 10 + Math.floor(rnd() * 3); // 10 to 12 players
  const girls = Math.ceil(n / 3) + (rnd() < 0.4 ? 1 : 0);
  const star = Math.floor(rnd() * n);
  const players = [];
  for (let i = 0; i < n; i++) {
    const girl = i < girls;
    const base = avg + (i === star ? 18 : 0);
    const r = () => clamp(base + gauss() * 9);
    players.push({
      name: pick(girl ? girlNames : guyNames),
      kicksAs: girl ? 'girl' : 'guy',
      position: positions[i] ?? 'Bench',
      contact: r(), power: r() - (girl ? 6 : 0), speed: r(), arm: r(), glove: r(),
      ...(i === star ? { star: true } : {}),
    });
  }
  return { id: slug(name), name, tier: avg >= 70 ? 'contender' : avg >= 50 ? 'middle' : 'bottom', players };
});

mine.tier = 'player';
data.teams = [mine, ...opponents];
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
console.log('wrote', data.teams.length, 'teams');
