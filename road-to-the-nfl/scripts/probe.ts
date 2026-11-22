// Tuning probe: prints how wind, power and strike affect kicks. Run: npx vite-node scripts/probe.ts
import { CONFIG } from '../src/config';
import { resolveKick, launchSpeedForRange, maxRangeYd } from '../src/kick/physics';
import { Rng } from '../src/sim/rng';

const k = CONFIG.practice.kicker;
console.log('range', maxRangeYd(k).toFixed(1), 'v0', launchSpeedForRange(maxRangeYd(k)).toFixed(1), 'ft/s');
const noJitter = () => { const r = new Rng(1); r.normal = () => 0; r.next = () => 0.5; return r; };
for (const [label, mph, dir] of [['calm',0,0],['15 head',15,180],['15 tail',15,0],['15 cross L→R',15,90],['25 cross',25,90]] as const) {
  for (const d of [30, 45, 52]) {
    const r = resolveKick({ level: 'nfl', distanceYd: d, hash: 'M', windMph: mph, windToDeg: dir }, { aimXFt: 0, power: 1, accuracy: 0 }, k, noJitter());
    console.log(label.padEnd(14), d, r.outcome.padEnd(12), 'carry', r.carryYd.toFixed(1), 'crossX', r.crossXFt?.toFixed(1), 'crossZ', r.crossZFt?.toFixed(1), 'flight', (r.decideIndex/60).toFixed(2)+'s');
  }
}
for (const acc of [0, 0.1, 0.15, 0.2, 0.3, 0.5]) for (const d of [25, 40, 50]) {
  const r = resolveKick({ level: 'nfl', distanceYd: d, hash: 'M', windMph: 0, windToDeg: 0 }, { aimXFt: 0, power: 1, accuracy: acc }, k, noJitter());
  console.log('acc', acc, d, r.outcome, 'crossX', r.crossXFt?.toFixed(1));
}
for (const p of [0.6, 0.8, 0.9, 1.0, 1.15]) {
  const r = resolveKick({ level: 'nfl', distanceYd: 30, hash: 'M', windMph: 0, windToDeg: 0 }, { aimXFt: 0, power: p, accuracy: 0 }, k, noJitter());
  console.log('power', p, 'carry', r.carryYd.toFixed(1));
}
