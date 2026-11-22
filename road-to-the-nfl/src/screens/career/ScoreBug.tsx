import type { Team } from '../../career/types';

const Q = ['', '1ST', '2ND', '3RD', '4TH', 'OT'];

export function ScoreBug({ us, them, usScore, themScore, q, clock, home }: { us: Team; them: Team; usScore: number; themScore: number; q: number; clock: string; home: boolean }) {
  const away = home ? { t: them, s: themScore } : { t: us, s: usScore };
  const hm = home ? { t: us, s: usScore } : { t: them, s: themScore };
  return (
    <div className="bug game-bug">
      {[away, hm].map(({ t, s }) => (
        <div key={t.short + t.name} className="gb-team" style={{ background: t.primary }}>
          <span className="gb-name" style={{ color: '#fff' }}>
            {t.short}
          </span>
          <span className="gb-score">{s}</span>
        </div>
      ))}
      <div className="bug-cell gb-clock">
        <span className="bug-k">{Q[Math.min(5, q)] ?? ''}</span>
        <span className="bug-v">{q >= 5 ? '' : clock}</span>
      </div>
    </div>
  );
}
