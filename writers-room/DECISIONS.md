# Decisions log

One entry per meaningful decision. This becomes the backbone of the portfolio case study.

Format:

## YYYY-MM-DD — Decision title
- **Decision:**
- **Why:**
- **Alternatives considered:**

---

## 2026-11-21 — The AI organizes, it never writes the book
- **Decision:** No AI-generated prose anywhere a manuscript could use it. Transcripts keep the author's words; canon notes are written by the author.
- **Why:** Keeps the books fully copyrightable and avoids KDP AI-generated disclosure. Also the core product promise to writers.
- **Alternatives considered:** AI turning spoken rambling into polished prose (rejected: authorship and disclosure risk).

## 2026-11-21 — Build on the Anthropic API
- **Decision:** All AI calls go through the Anthropic API under commercial terms.
- **Why:** Inputs aren't used for training, and the customer keeps rights to inputs and outputs.
- **Alternatives considered:** Consumer chat apps (rejected: different data terms).

---

## 2026-11-22 — V1 is for Austin only
- **Decision:** One user, behind a private login. No sign-up.
- **Why:** The V1 spec is for one writer and already cuts accounts for other writers. Leaving out sign-up skips about a week of login, password reset and data-separation work.
- **Alternatives considered:** Open sign-up in V1 (rejected: more work, plus privacy and support obligations, before the core loop is proven).

## 2026-11-22 — Data lives in a small cloud database
- **Decision:** One private hosted database that the phone and laptop both use.
- **Why:** Capture happens on the phone in the car and work happens at the desk. Phone-only storage can't reach the laptop, and it risks data loss: a lost phone, or Safari clearing storage for web apps that go unused.
- **Alternatives considered:** Phone only (rejected: no desk access, loss risk).

## 2026-11-22 — Raw audio is deleted when the note is confirmed
- **Decision:** Keep audio until the author confirms the transcript, then delete it, unless the author turns on "keep audio" for that note.
- **Why:** It's a safety net against bad transcripts without piling up storage and sensitive recordings. This matches the spec.
- **Alternatives considered:** Always keep (more storage and more sensitive data held); delete right after transcription (no way to recheck a garbled note).

## 2026-11-22 — Start with no books loaded
- **Decision:** The app starts with no books. Austin adds books himself when ready (*The Life I Deserve* and *Silence Speaks* are not pre-loaded).
- **Why:** Austin's call. Books only matter from Milestone 2, and nothing from the real manuscripts goes in up front.
- **Alternatives considered:** Pre-create both as empty books; pre-create and import existing notes.

## 2026-11-22 — Interviews read notes only, not finished chapters (V1)
- **Decision:** Character interviews read only Character, Places, Plot and Scene cards. Manuscript chapters are never sent to the AI in V1. Revisit at Milestone 3.
- **Why:** Less manuscript text goes to an outside service, the "answers from your notes" consistency test stays clean, and the manuscript stays in the author's writing tool, as the spec says.
- **Alternatives considered:** Notes plus finished chapters (richer answers, but manuscript text goes to the API and needs an import step).

## 2026-11-22 — Speech-to-text: a paid transcription API with no-training terms
- **Decision:** The phone records audio. The server sends it to one paid transcription provider whose business terms forbid training on customer data (to be picked at build time, for example Deepgram or OpenAI's transcription API). Claude then does the light cleanup and splitting. CLAUDE.md now allows this one exception.
- **Why:** The Anthropic API doesn't accept audio, so something else has to turn speech into text. Browser dictation on iPhone cuts off at pauses and when the screen locks, and it sends audio to Apple or Google under consumer terms anyway. A paid API is reliable for long drives and costs well under $1 a month at this volume.
- **Alternatives considered:** Browser built-in (free, but flaky for long dictation and consumer data terms); self-hosted Whisper (no third party, but slower, more setup and higher hosting cost).

## 2026-11-22 — Working name: Writer's Room
- **Decision:** Keep "Writer's Room" as the working name. Revisit before the portfolio case study.
- **Why:** It says what the app is, and renaming later is cheap.
- **Alternatives considered:** Drive Notes, Canon. Note: "writers' room" is a common phrase that other products already use, so it's weak if the app ever ships publicly.

## 2026-11-22 — Traditional publishing is possible
- **Decision:** Plan for a possible traditional deal. Ask an agent about publisher AI clauses before signing anything, and keep the authorship log export clean and complete enough to hand to a publisher.
- **Why:** Publisher contracts increasingly include AI clauses, and the authorship log is the evidence that would answer them. This doesn't change the V1 build.
- **Alternatives considered:** Self-publish only (KDP rules already covered in SPEC.md); undecided.

---

## Open questions settled in session 1 (2026-11-22)

- [x] Just for me at first, or open sign-up in V1? → Just me
- [x] Data storage: phone only, or small cloud database that syncs to my laptop? → Small cloud database
- [x] Keep raw audio, or delete after transcription? → Delete on confirm, with a per-note "keep audio" switch
- [x] Load *The Life I Deserve* and *Silence Speaks* as the first two books? → No, start with none
- [x] Can the AI read finished chapters for interviews, or notes only? → Notes only (V1)
- [x] Speech-to-text: browser built-in (free) or a paid service? → Paid API with no-training terms
- [x] App name → Writer's Room (working name)
- [x] Traditional publishing plans? (from SPEC.md) → Possible; ask an agent about AI clauses
