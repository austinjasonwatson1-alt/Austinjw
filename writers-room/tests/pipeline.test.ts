import { describe, expect, it } from "vitest";
import { checkCleanup } from "../src/lib/pipeline/guard";
import { basicCleanup } from "../src/lib/pipeline/basic-cleanup";
import { splitTranscript } from "../src/lib/pipeline/split";

describe("splitTranscript", () => {
  it("splits on 'new note' and reads spoken labels", () => {
    const segs = splitTranscript(
      "Um, scene note. She finds the, uh, the second phone in the glove box. New note. Character note: Detective Hale never sits down in an interview.",
    );
    expect(segs).toHaveLength(2);
    expect(segs[0].spokenSpace).toBe("scenes");
    expect(segs[0].content).toBe("She finds the, uh, the second phone in the glove box.");
    expect(segs[1].spokenSpace).toBe("characters");
    expect(segs[1].spokenLabel).toBe("Character note");
    expect(segs[1].content).toBe("Detective Hale never sits down in an interview.");
  });

  it("keeps notes with no label in the Inbox", () => {
    const [s] = splitTranscript("Hmm, something about a neighbor's security camera.");
    expect(s.spokenSpace).toBeNull();
    expect(s.content).toBe("Hmm, something about a neighbor's security camera.");
  });

  it("doesn't treat a sentence that starts with a space word as a command", () => {
    const [s] = splitTranscript("Scene for chapter 12 she finds the second phone.");
    expect(s.spokenSpace).toBeNull();
  });

  it("accepts 'new book idea'", () => {
    const [s] = splitTranscript("New book idea: a nanny cam catches the wrong crime.");
    expect(s.spokenSpace).toBe("book_ideas");
    expect(s.content).toBe("a nanny cam catches the wrong crime.");
  });

  it("drops empty segments and filler-only segments", () => {
    expect(splitTranscript("New note. Um. New note.")).toHaveLength(0);
  });
});

describe("checkCleanup", () => {
  const raw = "Um, she finds the, uh, the second phone in the glove box.";
  it("allows removing fillers and stutters, and changing punctuation", () => {
    const r = checkCleanup(raw, "She finds the second phone in the glove box.");
    expect(r.ok).toBe(true);
  });
  it("rejects added words", () => {
    expect(checkCleanup(raw, "She suddenly finds the second phone in the glove box.").ok).toBe(false);
  });
  it("rejects changed words", () => {
    expect(checkCleanup(raw, "She finds the second phone in the glovebox.").ok).toBe(false);
  });
  it("rejects reordered words", () => {
    expect(checkCleanup(raw, "In the glove box, she finds the second phone.").ok).toBe(false);
  });
  it("rejects dropping a real word", () => {
    expect(checkCleanup(raw, "She finds the phone in the glove box.").ok).toBe(false);
  });
  it("never lets 'had had' be collapsed", () => {
    expect(checkCleanup("She had had enough.", "She had enough.").ok).toBe(false);
  });
  it("never lets meaningful 'like' be removed", () => {
    expect(checkCleanup("I like him.", "I him.").ok).toBe(false);
  });
});

describe("basicCleanup", () => {
  const cases = [
    "Um, she finds the, uh, the second phone in the glove box.",
    "The lake house smells like wet cedar and gasoline, um.",
    "I I think the affair has to start before the fire, not after.",
    "She had had enough. Uh, Detective Hale never sits down.",
    "Hmm. What if the husband is the one being gaslit?",
  ];
  it.each(cases)("always passes the check: %s", (raw) => {
    expect(checkCleanup(raw, basicCleanup(raw)).ok).toBe(true);
  });
  it("tidies punctuation", () => {
    expect(basicCleanup(cases[0])).toBe("She finds the second phone in the glove box.");
    expect(basicCleanup(cases[1])).toBe("The lake house smells like wet cedar and gasoline.");
    expect(basicCleanup(cases[2])).toBe("I think the affair has to start before the fire, not after.");
    expect(basicCleanup(cases[4])).toBe("What if the husband is the one being gaslit?");
  });
});

describe("transcribe", () => {
  it("always opts out of Deepgram's model-improvement program", async () => {
    const { transcribe } = await import("../src/lib/transcribe");
    const calls: string[] = [];
    const orig = globalThis.fetch;
    process.env.DEEPGRAM_API_KEY = "test";
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "hi" }] }] } }));
    }) as typeof fetch;
    try {
      await transcribe(Buffer.from([1, 2, 3]), "audio/webm");
    } finally {
      globalThis.fetch = orig;
      delete process.env.DEEPGRAM_API_KEY;
    }
    expect(new URL(calls[0]).searchParams.get("mip_opt_out")).toBe("true");
  });
});
