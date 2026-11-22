# Writer's Room

A voice-first notebook for a novelist. Talk out ideas anywhere; your own words land in an Inbox, ready to file.
**The AI organizes. It never writes the book.** See [SPEC.md](SPEC.md), [CLAUDE.md](CLAUDE.md) and [DECISIONS.md](DECISIONS.md).

Status: **Milestone 1** (capture, transcription, Inbox).

## Run it on your laptop

```bash
npm install
npm run dev
```

Open http://localhost:3000. With no settings at all, it runs with a built-in database (saved in `.data/`) and no login.
To hear real transcription locally, copy `.env.example` to `.env.local` and add the two API keys.

## Put it on your phone

See [SETUP.md](SETUP.md): about 15 minutes, once.

## Tests

```bash
npm test               # unit tests: note splitting, labels, the "no ghostwriting" word check
npm run eval:voice     # voice test from SPEC.md; writes a report to evals/results/
```

## How a voice note becomes a note

1. **Record.** The phone saves a piece of audio every 5 seconds to its own storage, then uploads it. Pieces leave the phone only once the server has them, so dead zones don't lose anything.
2. **Transcribe.** The server sends the audio to Deepgram (speech-to-text only) and stores the transcript word for word.
3. **Split.** Saying "new note" splits the recording. A note that starts with "scene note", "character note", "book idea", etc. gets that label. This is plain code, not AI.
4. **Tidy.** Claude removes hesitation sounds (um, uh…) and stutters and fixes punctuation. Then code checks the result word for word against the transcript: if any word was added, changed, reordered or dropped, the AI version is thrown away and a code-only cleanup (which can only remove fillers) is used instead.
5. **Review.** Notes wait in the Inbox under "To review". Keep (or swipe right), edit or delete. Once every note from a recording is reviewed, the audio is deleted, unless you switched on "Keep the recording" for one of them.

Every step is written to an append-only authorship log (who did what, when: you, the AI, or the system).

## Where things live

| Path | What |
| --- | --- |
| `src/components/Recorder.tsx` | The record screen |
| `src/components/Inbox.tsx` | The Inbox and note cards |
| `src/client/queue.ts` | Offline-safe upload queue on the phone |
| `src/lib/pipeline/` | Splitting, cleanup and the word-for-word check |
| `src/lib/store.ts` | Notes, recordings and the authorship log |
| `src/lib/db.ts` | Database tables |
| `evals/` | Evaluation fixtures (made-up material only) and published results |
