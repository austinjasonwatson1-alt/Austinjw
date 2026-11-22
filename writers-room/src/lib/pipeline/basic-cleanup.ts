import { isFiller, isStutter, normalizeWord, tokenize } from "./words";

/**
 * Code-only cleanup: removes hesitation sounds and stutters, tidies the
 * punctuation around them, and does nothing else. Used when the AI cleanup is
 * unavailable or fails the check, so it must always pass `checkCleanup`.
 */
export function basicCleanup(raw: string): string {
  const tokens = tokenize(raw);
  const norm = tokens.map(normalizeWord);

  // Pass 1: drop fillers. If a dropped filler ended a sentence ("...glove box, um."),
  // move its end punctuation onto the previous kept word.
  let kept: { tok: string; w: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const w = norm[i];
    if (!w) {
      kept.push({ tok: tokens[i], w });
      continue;
    }
    if (isFiller(w)) {
      const end = tokens[i].match(/[.!?]+["')\]]*$/);
      const prev = kept[kept.length - 1];
      if (end && prev && !/[.!?]["')\]]*$/.test(prev.tok)) {
        prev.tok = prev.tok.replace(/[,;:]+$/, "") + end[0];
      }
      continue;
    }
    kept.push({ tok: tokens[i], w });
  }

  // Pass 2: drop stutters (keep the last copy, which usually carries the right punctuation).
  const ws = kept.map((k) => k.w);
  kept = kept.filter((k, i) => !(k.w && ws[i + 1] === k.w && isStutter(ws, i)));

  let text = kept.map((k) => k.tok).join(" ");
  text = text
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/^[\s,;:.]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Re-capitalize the start of each sentence if a leading filler was removed.
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
  return text;
}
