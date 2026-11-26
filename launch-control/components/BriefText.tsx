'use client';

import { Fragment } from 'react';
import { parseBrief, type Span } from '@/lib/brief/parse';
import { cx } from './cx';

const ID = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;

/** Text with ticket ids shown as chips. Still plain text nodes: nothing here is rendered as HTML. */
function WithIds({ text }: { text: string }) {
  return (
    <>
      {text.split(ID).map((part, n) =>
        n % 2 ? (
          <code key={n} className={cx('idchip')}>
            {part}
          </code>
        ) : (
          <Fragment key={n}>{part}</Fragment>
        ),
      )}
    </>
  );
}

const Spans = ({ spans }: { spans: Span[] }) => (
  <>
    {spans.map((s, n) =>
      s.bold ? (
        <strong key={n}>
          <WithIds text={s.text} />
        </strong>
      ) : (
        <WithIds key={n} text={s.text} />
      ),
    )}
  </>
);

const plain = (spans: Span[]) => spans.map((s) => s.text).join('');

/** "NO-GO (as of today) — reason" → a verdict badge and the reason beside it. */
function Verdict({ spans, rec }: { spans: Span[]; rec: 'yes' | 'no' | 'cond' }) {
  const line = plain(spans);
  const m = /^\s*(NO-GO|GO WITH CONDITIONS|GO)\b\s*(\(as of today\))?\s*[—–:.,-]*\s*(.*)$/i.exec(line);
  if (!m) {
    return (
      <p className={cx('rec', rec === 'yes' && 'yes', rec === 'no' && 'no')}>
        <Spans spans={spans} />
      </p>
    );
  }
  const reason = m[3] ? m[3][0].toUpperCase() + m[3].slice(1) : '';
  return (
    <div className={cx('verdict')}>
      <span className={cx('vbadge', rec === 'yes' && 'vyes', rec === 'no' && 'vno', rec === 'cond' && 'vcond')}>
        {m[1].toUpperCase()}
        {m[2] && <small> as of today</small>}
      </span>
      {reason && (
        <p>
          <WithIds text={reason} />
        </p>
      )}
    </div>
  );
}

/** A risk bullet "Gate — LCH-1 — Owner — action": the gate name leads in bold. */
function RiskItem({ spans }: { spans: Span[] }) {
  const line = plain(spans);
  const cut = line.indexOf(' — ');
  if (cut < 3 || cut > 60) return <Spans spans={spans} />;
  return (
    <>
      <strong className={cx('rgate')}>{line.slice(0, cut)}</strong>
      <WithIds text={line.slice(cut)} />
    </>
  );
}

/** Renders brief Markdown as React text nodes. Never uses innerHTML: brief text is untrusted. */
export default function BriefText({ text }: { text: string }) {
  let section = '';
  return (
    <>
      {parseBrief(text).map((b, n) => {
        if (b.kind === 'heading') {
          section = b.text;
          return <h4 key={n}>{b.text}</h4>;
        }
        if (b.kind === 'list') {
          const risks = /^blocking risks/i.test(section);
          return (
            <ul key={n} className={risks ? cx('risklist') : undefined}>
              {b.items.map((it, k) => (
                <li key={k}>{risks ? <RiskItem spans={it} /> : <Spans spans={it} />}</li>
              ))}
            </ul>
          );
        }
        if (b.rec) return <Verdict key={n} spans={b.spans} rec={b.rec} />;
        return (
          <p key={n}>
            <Spans spans={b.spans} />
          </p>
        );
      })}
    </>
  );
}
