import { describe, expect, it } from 'vitest';
import { execUpdate, parseBrief, spans } from './parse';

describe('brief parser', () => {
  it('splits headings, bullets and paragraphs and tags the recommendation', () => {
    const b = parseBrief('## Recommendation\n**NO-GO** — reasons\n## Blocking risks\n- a\n- **b** c\n## Exec update\nPlain.');
    expect(b).toEqual([
      { kind: 'heading', text: 'Recommendation' },
      { kind: 'para', spans: [{ text: 'NO-GO', bold: true }, { text: ' — reasons', bold: false }], rec: 'no' },
      { kind: 'heading', text: 'Blocking risks' },
      { kind: 'list', items: [[{ text: 'a', bold: false }], [{ text: 'b', bold: true }, { text: ' c', bold: false }]] },
      { kind: 'heading', text: 'Exec update' },
      { kind: 'para', spans: [{ text: 'Plain.', bold: false }] },
    ]);
  });

  it('classifies GO, GO WITH CONDITIONS and NO-GO', () => {
    const rec = (l: string) => (parseBrief(`## Recommendation\n${l}`)[1] as { rec?: string }).rec;
    expect(rec('GO — fine')).toBe('yes');
    expect(rec('GO WITH CONDITIONS — x')).toBe('cond');
    expect(rec('NO-GO (as of today) — x')).toBe('no');
  });

  it('keeps HTML as literal text', () => {
    expect(spans('<img src=x onerror=alert(1)>')).toEqual([{ text: '<img src=x onerror=alert(1)>', bold: false }]);
  });

  it('extracts the exec update for copying', () => {
    expect(execUpdate('## Recommendation\nGO\n## Exec update\nLine **one**.\nLine two.')).toBe('Line one.\nLine two.');
    expect(execUpdate('no section')).toBe('');
  });
});
