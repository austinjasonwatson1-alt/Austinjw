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

## 2026-11-22 — Tech stack: Next.js on Vercel, Postgres on Supabase
- **Decision:** One Next.js (React + TypeScript) project holds both the phone screens and the server code. It's hosted on Vercel and stores data in a Supabase Postgres database. On a laptop with no settings, it uses a built-in database saved in `.data/`, so `npm install` and `npm run dev` are all it takes.
- **Why:** One project and one deploy. API keys stay on the server. The phone needs a secure web address for the microphone, which Vercel provides. Both services are free at this size.
- **Alternatives considered:** A separate front end and back end (more moving parts); SQLite on a small rented server (more upkeep); a native app (out of V1 scope).

## 2026-11-22 — Private login is a single passphrase
- **Decision:** One passphrase, set as `APP_PASSPHRASE` in Vercel, signs the phone in for a year with a signed cookie. Without it the deployed app refuses to run.
- **Why:** Simplest private lock for one user: one setting and no email service. Changing the passphrase signs every device out. (This replaces the email login proposed in session 1, which needed an extra service.)
- **Alternatives considered:** Email magic links via Supabase Auth (another service and its email setup); no login (rejected: notes are private).

## 2026-11-22 — Recordings are stored temporarily in the database
- **Decision:** Audio is kept as 5-second pieces in a database table until its notes are reviewed, then deleted (unless "Keep the recording" is on).
- **Why:** No separate file-storage service. Recordings are short-lived and small (about 0.2 MB a minute).
- **Alternatives considered:** Supabase Storage or another file bucket (one more service and set of permissions for files that live a few days).

## 2026-11-22 — Recordings upload in pieces and wait on the phone until the server has them
- **Decision:** The phone writes each 5-second piece to its own storage, then uploads it, and deletes it from the phone only after the server confirms. Anything left over uploads the next time the app is open with a connection.
- **Why:** Drives have dead zones. A note said in a tunnel shouldn't disappear.
- **Alternatives considered:** Uploading the whole recording at the end (one dead zone loses everything); a background service worker (iPhone's support for this is unreliable; revisit if needed).

## 2026-11-22 — Deepgram (nova-3) for speech-to-text, opted out of training on every request
- **Decision:** Transcription uses Deepgram's pre-recorded API with `mip_opt_out=true` on every request, enforced by a unit test.
- **Why:** Deepgram enrolls requests in its Model Improvement Program and keeps the audio **by default**. The opt-out gives zero retention: nothing is stored after the transcript returns. Deepgram notes that opting out can affect pricing; at this volume the difference is pennies.
- **Alternatives considered:** OpenAI's transcription API (also no-training on API data; no strong reason to prefer it); browser dictation and self-hosted Whisper (see the speech-to-text entry above).

## 2026-11-22 — "Transcribe, don't ghostwrite" is enforced in code
- **Decision:** Saying "new note" splits notes and spoken labels ("scene note") are read by plain code rules, not AI. Claude (`claude-opus-5-5`, low effort) only removes hesitation sounds and stutters and fixes punctuation. Every AI result is then checked word for word against the transcript. Any added, changed, reordered or dropped word means the AI version is discarded and a code-only cleanup is used. Words like "like", "so" and "you know" are never removable, and neither is a correct double such as "had had". The exact transcript is stored with every note and shown under ⋯.
- **Why:** The copyright promise shouldn't depend on an AI following instructions. The check makes it impossible for AI-written words to reach a note, and the voice test reuses the same check, so results can be published.
- **Alternatives considered:** Trusting the prompt alone (not verifiable); no cleanup at all (notes full of "um"); letting the AI remove all filler-like words (risks changing meaning).

## 2026-11-22 — Milestone 1 scope details
- **Decision:** Spoken labels are shown on the note and stored as its suggested space, but every note stays in the Inbox until Milestone 2 adds spaces. Typed notes skip review and go straight to "In your Inbox". Deleting a note hides it, and the deletion is recorded in the authorship log.
- **Why:** This keeps Milestone 1 to capture, transcription and Inbox, as the spec orders. Typed words need no review. The authorship log must stay complete.
- **Alternatives considered:** Auto-filing labelled notes now (that's Milestone 2 work).

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
