// Plays simulated careers and prints how they went. Run: npx vite-node scripts/careerprobe.ts
import { afterDraftResult, afterReview, applyOffseasonCamp, applyShowcase, chooseOffer, currentGame, declareForDraft, finishOffseason, gameSetup, newCareer, recordGame, resolveCamp, resolveTryout, rivalCampResults, simUnsignedWeek, spendPoint } from '../src/career/career';
import { GameSim } from '../src/career/gamesim';
import { overall } from '../src/career/progression';
const profile = { name: 'Austin Watson', hometown: 'Lakeview', school: 'Lakeview High', foot: 'R' as const, number: '3' };
for (let seed = 1; seed <= 8; seed++) {
  let c = newCareer(1, profile, seed * 97);
  let r = seed * 13;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const kicks = (n: number, p: number) => Array.from({ length: n }, () => rnd() < p);
  let guard = 0;
  while (c.stage !== 'retired' && guard++ < 5000) {
    const p = c.pending;
    if (p) {
      if (p.kind === 'camp') c = resolveCamp(c, kicks(5, 0.7), rivalCampResults(c, p.rival));
      else if (p.kind === 'showcase') c = applyShowcase(c, kicks(p.purpose === 'draft' ? 6 : 5, 0.7));
      else if (p.kind === 'offers') c = chooseOffer(c, p.offers[Math.min(1, p.offers.length - 1)]);
      else if (p.kind === 'declare') c = declareForDraft(c, p.forced);
      else if (p.kind === 'draftResult') c = afterDraftResult(c);
      else if (p.kind === 'tryout') c = resolveTryout(c, kicks(4, 0.75));
      else if (p.kind === "review") { (c as any)._ovr = [...((c as any)._ovr ?? []), `${c.age}:${overall(c.skills)}`]; c = afterReview(c); }
      else if (p.kind === 'offseason') {
        c = applyOffseasonCamp(c, kicks(5, 0.7));
        for (let i = 0; i < 300; i++) c = spendPoint(c, (['power', 'accuracy', 'composure', 'windControl', 'consistency'] as const)[i % 5]);
        c = finishOffseason(c);
      } else break;
      continue;
    }
    const g = currentGame(c);
    if (g) { const s = new GameSim(gameSetup(c, g)); s.simToEnd(); c = recordGame(c, s).career; }
    else c = simUnsignedWeek(c);
  }
  console.log(((c as any)._ovr ?? []).join(" ")); console.log(`#${seed} age ${c.age} ovr ${overall(c.skills)} stars ${c.stars} draft: ${c.draftNote} | ` + c.history.map(h => `${h.stage[0]}${h.role[0]}:${h.fgm}/${h.fga}`).join(' ') + ` | ${c.summary?.verdict} | honors ${c.honors.length} titles ${c.titles.length}`);
}
