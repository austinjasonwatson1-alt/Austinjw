// Shared word rules for splitting, basic cleanup and the cleanup check.
//
// The rule from CLAUDE.md: cleanup may remove filler words and add punctuation.
// It may never add, change or reorder a word. These helpers define, in code,
// exactly which words count as removable.

// Hesitation sounds. Deliberately narrow: words like "like", "so" or "you know"
// can carry meaning ("I like him"), so they are never removable.
export const FILLERS = new Set([
  "um", "umm", "ummm", "uh", "uhh", "uhm", "er", "erm", "ah", "ahh",
  "eh", "hmm", "hm", "hmmm", "mm", "mmm", "mhm",
]);

// Words that are often correctly doubled in English ("she had had enough",
// "I know that that's true"), so a repeat of these is never treated as a stutter.
const REPEAT_OK = new Set(["had", "that", "is", "do", "very", "really", "no", "yes", "so", "bye", "ha"]);

// Lowercase, straighten apostrophes, strip surrounding punctuation.
export function normalizeWord(token: string): string {
  return token
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "")
    .replace(/^'+|'+$/g, "");
}

// Split text into raw tokens (keeping their punctuation). Dashes and ellipses
// count as separators so "phone—she" is two words.
export function tokenize(text: string): string[] {
  return text
    .split(/[\s—–]+|\.{3}|…|(?<=\w)--(?=\w)/)
    .filter((t) => t.length > 0);
}

export function words(text: string): string[] {
  return tokenize(text).map(normalizeWord).filter((w) => w.length > 0);
}

export function isFiller(word: string): boolean {
  return FILLERS.has(word);
}

// True when the word at index i of a normalized word list is a removable stutter:
// the same word said twice in a row ("the the", "I I").
export function isStutter(list: string[], i: number): boolean {
  const w = list[i];
  if (REPEAT_OK.has(w)) return false;
  return list[i + 1] === w || list[i - 1] === w;
}
