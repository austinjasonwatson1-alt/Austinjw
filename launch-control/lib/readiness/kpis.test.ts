import { describe, expect, it } from 'vitest';
import { demoSnapshot } from '../tracker/demo';
import { autofix } from './hygiene';
import { deliveryKpis } from './kpis';

const snap = demoSnapshot('2026-11-24');
const values = (s: typeof snap) => Object.fromEntries(deliveryKpis(s).map((k) => [k.key, [k.value, k.tone]]));

describe('deliveryKpis', () => {
  it('computes the four KPIs for the fresh sample data', () => {
    expect(values(snap)).toEqual({
      // 33 gates: 1 has no ticket (L1 support) and 3 have an unowned or undated open ticket (L1 eng, L1 docs, L5 docs)
      owned: ['88%', 'hot'],
      onTrack: ['4/5', 'hot'],
      // L4 (go/no-go in 2 days) 3/3 ready and L3 (go/no-go in 7 days) 3/7 ready
      readyNearGoNoGo: ['60%', 'hot'],
      quality: ['85%', 'hot'],
    });
  });

  it('improves when hygiene fixes are applied', () => {
    const fixed = { ...snap, issues: autofix(snap).issues };
    expect(values(fixed).owned).toEqual(['97%', 'ok']); // only the gate with no ticket is left
    expect(values(fixed).quality).toEqual(['95%', 'ok']);
  });

  it('says n/a when no launch is near go/no-go, and handles an empty tracker', () => {
    const far = { ...snap, launches: snap.launches.filter((l) => l.id === 'L5') };
    expect(values(far).readyNearGoNoGo).toEqual(['n/a', '']);
    expect(deliveryKpis({ launches: [], issues: [], asOf: '2026-11-24' }).map((k) => k.value)).toEqual(['100%', '0/0', 'n/a', '100%']);
  });
});
