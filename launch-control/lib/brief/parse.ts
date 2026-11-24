/**
 * Parses a brief's restricted Markdown (## headings, - bullets, **bold**, paragraphs)
 * into plain data. The UI renders it as React text nodes, never as HTML, because
 * brief text can come from Claude or from tracker titles and is untrusted.
 */
export interface Span {
  text: string;
  bold: boolean;
}

export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: Span[][] }
  | { kind: 'para'; spans: Span[]; rec?: 'yes' | 'no' | 'cond' };

export function spans(line: string): Span[] {
  const out: Span[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), bold: false });
  return out;
}

export function parseBrief(text: string): Block[] {
  const blocks: Block[] = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const ln = raw.trim();
    if (!ln) continue;
    if (ln.startsWith('#')) {
      section = ln.replace(/^#+\s*/, '');
      blocks.push({ kind: 'heading', text: section });
      continue;
    }
    if (/^[-*]\s/.test(ln)) {
      const item = spans(ln.replace(/^[-*]\s+/, ''));
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === 'list') prev.items.push(item);
      else blocks.push({ kind: 'list', items: [item] });
      continue;
    }
    if (/^recommendation/i.test(section)) {
      const rec = /^\**\s*NO-GO/i.test(ln) ? 'no' : /^\**\s*GO\b(?!\s*WITH)/i.test(ln) ? 'yes' : 'cond';
      blocks.push({ kind: 'para', spans: spans(ln), rec });
    } else {
      blocks.push({ kind: 'para', spans: spans(ln) });
    }
  }
  return blocks;
}

/** The "Exec update" section as plain text, for the copy button. */
export function execUpdate(text: string): string {
  const after = text.split(/##\s*Exec update/i)[1];
  if (!after) return '';
  return after.split(/^#/m)[0].replace(/\*\*(.+?)\*\*/g, '$1').trim();
}
