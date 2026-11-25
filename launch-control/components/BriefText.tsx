'use client';

import { parseBrief, type Span } from '@/lib/brief/parse';
import { cx } from './cx';

const Spans = ({ spans }: { spans: Span[] }) => (
  <>{spans.map((s, n) => (s.bold ? <strong key={n}>{s.text}</strong> : <span key={n}>{s.text}</span>))}</>
);

/** Renders brief Markdown as React text nodes. Never uses innerHTML: brief text is untrusted. */
export default function BriefText({ text }: { text: string }) {
  return (
    <>
      {parseBrief(text).map((b, n) => {
        if (b.kind === 'heading') return <h4 key={n}>{b.text}</h4>;
        if (b.kind === 'list')
          return (
            <ul key={n}>
              {b.items.map((it, k) => (
                <li key={k}>
                  <Spans spans={it} />
                </li>
              ))}
            </ul>
          );
        return (
          <p key={n} className={b.rec ? cx('rec', b.rec === 'yes' && 'yes', b.rec === 'no' && 'no') : undefined}>
            <Spans spans={b.spans} />
          </p>
        );
      })}
    </>
  );
}
