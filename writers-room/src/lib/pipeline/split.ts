import { SPOKEN_LABELS, type SpaceId } from "../spaces";

export type Segment = {
  /** The transcript words for this note, exactly as transcribed. */
  raw: string;
  /** The same words minus any spoken command ("scene note"), ready for cleanup. */
  content: string;
  /** Space the author named out loud, if any. */
  spokenSpace: SpaceId | null;
  spokenLabel: string | null;
};

// "new note" said anywhere splits the recording. Plain rule, no AI, so it's predictable.
const SPLIT = /\bnew\s+note\b[\s.,!?:;—–-]*/gi;

// Leading fillers/punctuation before a spoken command: "Um, scene note."
const LEAD = /^(?:(?:um+|uh+|uhm|er|erm|ah+|eh|hmm+|hm|mm+|okay|ok|so)\b[\s.,!?:;—–-]*)*/i;

// "<label> note" or "<label>:" at the start of a note. A bare "Scene for chapter 12"
// is not a command; the author has to say "scene note" or pause after the label.
const LABEL = new RegExp(
  "^(?:new\\s+)?(" +
    Object.keys(SPOKEN_LABELS).map((k) => k.replace(" ", "\\s+")).join("|") +
    ")(\\s+note)?\\b([\\s]*[.,:;!?\\u2014\\u2013-]+)?\\s*",
  "i",
);

export function splitTranscript(transcript: string): Segment[] {
  return transcript
    .split(SPLIT)
    .map((s) => s.trim())
    .filter((s) => /[a-z0-9]/i.test(s.replace(LEAD, "")))
    .map(detectLabel);
}

export function detectLabel(raw: string): Segment {
  const lead = raw.match(LEAD)?.[0] ?? "";
  const rest = raw.slice(lead.length);
  const m = rest.match(LABEL);
  if (m) {
    const key = m[1].toLowerCase().replace(/\s+/g, " ");
    const said = Boolean(m[2]) || Boolean(m[3]) || key === "book idea";
    const content = rest.slice(m[0].length).trim();
    if (said && content) {
      const { space, display } = SPOKEN_LABELS[key];
      return { raw, content, spokenSpace: space, spokenLabel: display };
    }
  }
  return { raw, content: raw, spokenSpace: null, spokenLabel: null };
}
