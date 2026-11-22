import { isFiller, isStutter, words } from "./words";

export type GuardResult =
  | { ok: true; removed: string[] }
  | { ok: false; reason: string };

/**
 * The "transcribe, don't ghostwrite" check.
 *
 * Passes only if `cleaned` is the `raw` transcript with some filler words or
 * stutters removed. Capitalization and punctuation may differ. Any added,
 * changed or reordered word fails. This runs on every AI cleanup, and the voice
 * evaluation uses it too.
 */
export function checkCleanup(raw: string, cleaned: string): GuardResult {
  const r = words(raw);
  // Filler and stutter words are judged against the raw word list, but a stutter
  // can also be the word left over after a filler between the two copies
  // ("the, uh, the" -> "the the"), so judge stutters on the filler-free list too.
  const rNoFill = r.filter((w) => !isFiller(w));
  const noFillIndex: number[] = [];
  {
    let k = 0;
    for (let i = 0; i < r.length; i++) noFillIndex.push(isFiller(r[i]) ? -1 : k++);
  }
  const deletable = (i: number) =>
    isFiller(r[i]) || isStutter(r, i) || (noFillIndex[i] >= 0 && isStutter(rNoFill, noFillIndex[i]));

  const c = words(cleaned);
  const removed: string[] = [];
  let i = 0;
  for (const word of c) {
    while (i < r.length && r[i] !== word) {
      if (!deletable(i)) {
        return {
          ok: false,
          reason: `"${word}" doesn't match the next spoken word "${r[i]}"`,
        };
      }
      removed.push(r[i]);
      i++;
    }
    if (i >= r.length) {
      return { ok: false, reason: `"${word}" was added: it isn't in the transcript` };
    }
    i++;
  }
  for (; i < r.length; i++) {
    if (!deletable(i)) return { ok: false, reason: `"${r[i]}" was dropped` };
    removed.push(r[i]);
  }
  return { ok: true, removed };
}
