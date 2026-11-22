# Writer's Room: Baseline Spec

As of 2026-11-21 · Owner: Austin Watson

## Summary

Writer's Room is a voice-first notebook for a novelist: you talk out ideas anywhere, and it files them into the right space (brainstorm, book ideas, scenes, characters and more), then lets you interview your characters from what you've filed.

**The one rule that protects the books: the AI organizes, it never writes the book.** Every word that could end up in a manuscript is the author's, spoken or typed. The AI transcribes, sorts, tags, connects and asks questions. It does not compose prose.

Drive-time capture keeps the author's own spoken words, lightly cleaned up. It never rewrites them into polished prose.

## Protecting the work

Using AI to organize, transcribe and question ideas does not cost the author ownership of the book, as long as the words in the book are theirs. (Summary of current rules, not legal advice.)

| Rule | What it means for Writer's Room |
| --- | --- |
| US Copyright Office, AI report Part 2 (Jan 2025): AI-assisted creation does not bar copyright; purely AI-generated text is not protected | Dictated and typed words are protected. Text the AI writes on its own is not, so it never goes into the manuscript |
| Amazon KDP content guidelines: AI-generated text must be disclosed; AI-assisted content does not need to be | Organizing, brainstorming and transcribing count as AI-assisted |
| Anthropic Commercial Terms: API customers keep rights to inputs and own outputs; Anthropic may not train on them | Build on the Anthropic API, never a consumer chat app |

How the app enforces it:

- **Transcribe, don't ghostwrite.** Voice notes are cleaned up (filler words, punctuation) but stay the author's words. No added or rewritten sentences.
- **Provenance on everything.** Each note is labeled `spoken`, `typed`, or `ai_suggestion`. AI suggestions are visually distinct and cannot be copied into a scene card without being retyped.
- **Authorship log.** Exportable record of what the author created and when.
- **Canon in the author's own words.** When a character interview turns up something useful, the author writes the canon note; the AI's answer is kept as a linked reference only.
- **Data is portable.** Export everything as plain text or .docx at any time. The manuscript itself stays in the author's normal writing tool.
- **Private by default.** No sharing, no public pages. Demos use public-domain or made-up material only.

## Spaces

Everything lands in one Inbox first, then gets sorted. Two zones: an **idea zone** not tied to any book, and a **book zone** for each book being written.

| Space | Zone | What goes there | Example spoken input |
| --- | --- | --- | --- |
| Inbox | Both | Anything unsorted, or the AI isn't confident | "Hmm, something about a neighbor's security camera..." |
| Brainstorm | Idea | Loose sparks, what-ifs, images, overheard lines | "What if the husband is the one being gaslit?" |
| Book ideas | Idea | Premises for future books, one card per idea | "New book idea: a nanny cam catches the wrong crime" |
| Scenes | Book | Scene sketches and beats, attached to a book and chapter | "Scene for chapter 12: she finds the second phone" |
| Characters | Book | Who people are, motives, secrets, how they talk | "Detective Hale never sits down in an interview" |
| Places | Book | Settings, rooms, towns, sensory details | "The lake house smells like wet cedar and gasoline" |
| Plot and timeline | Book | What happens when, clues, twists, reveals | "The affair has to start before the fire, not after" |
| Questions | Both | Things to figure out or research | "Check how long phone records are kept" |

Cards can be promoted between spaces (Brainstorm → Book ideas, or a Book idea → a new book with its own spaces). The author can say the space out loud ("character note:") or let the app sort; low-confidence notes stay in the Inbox.

## How capture flows

1. Author talks or types.
2. Transcribe: author's words kept (light cleanup only).
3. Sort: confident → suggested space; not confident → Inbox, author files it.
4. Notes live in the idea zone or a book zone.
5. Character interviews read the book zone; discoveries become canon only when the author writes them.

## Drive-time capture

1. **Start:** one big button on the phone home screen, or a voice shortcut. No menus while driving.
2. **Talk freely:** saying "new note" splits the recording; saying a space name ("scene note", "book idea") files it directly.
3. **After parking:** the transcript is shown split into notes, each with a suggested space, book and chapter, plus extracted names, places and dates.
4. **Confirm in seconds:** swipe to accept, tap to move. Unsure notes wait in the Inbox.
5. **At the desk:** open a scene card and the author's own spoken words are there to start from.

Raw audio is kept until the transcript is confirmed, then deleted unless the author chooses to keep it.

## Character interviews

Interviews are a thinking tool: answers help the author discover things; the author decides what becomes true, in their own words.

- **Grounded in notes.** A character answers only from their Character card, the Places and Plot cards they appear in, and any scenes written. Uncovered topics: they say so, or give an answer marked as new.
- **New vs. canon always visible.** Answers matching notes are marked consistent; invented details are marked *new*; contradictions with canon are flagged.
- **Keeping a discovery.** "Add to canon" opens a blank note on the character card for the author to write the fact. The AI answer is linked as a reference only.
- **V1 modes:** straight interview, and a warm-up mode that asks the author five questions about a character before a writing session.
- **Not in V1:** multi-character conversations, detective-style interrogations.

## V1 scope

V1 is capture, sorting and one-on-one interviews for one writer, buildable in about three part-time weeks.

| In V1 | Cut for later |
| --- | --- |
| Phone web app with one-tap voice capture | Native iOS/Android app, CarPlay |
| Transcription with light cleanup, split into notes | AI-written prose of any kind |
| Inbox plus the eight spaces, with auto-sorting | Custom spaces |
| Multiple books, promoting ideas into a book | Sharing and co-writing |
| Provenance labels and the authorship log | Accounts for other writers |
| One-on-one interviews and warm-up mode | Multi-character scenes |
| Export to plain text and .docx | Syncing into Word or Google Docs |
| Search across all spaces | Analytics dashboards beyond the basics |

**Order of work:**
- Milestone 1: capture, transcription, Inbox
- Milestone 2: spaces, sorting, books, promotion
- Milestone 3: interviews, authorship log, export

## Success metrics and evaluation

North star: ideas captured per week that later get used in a scene.

| Metric | What it tells you | Starting target |
| --- | --- | --- |
| Notes captured per week | Is capture easy enough to be a habit? | 15+ |
| Auto-sort accuracy | Does the app file where the author would? | 85%+ accepted without moving |
| Ideas used | Do notes turn into scenes? | 20%+ of scene notes |
| Sessions started from a note | Does it beat the blank page? | Most sessions |
| Canon contradictions in interviews | Do characters stay true to notes? | Under 5% of answers |

Testing the AI:
1. **Sorting test:** 50 real voice notes filed by the author vs. the app's choices.
2. **Consistency test:** 30 tricky questions whose answers are in a character's card; count contradictions.
3. **Voice test:** cleaned transcripts keep the author's wording, with no added sentences.

## Open questions (answered 2026-11-22 — see DECISIONS.md)

- Just for the author at first, or open sign-up in V1?
- Where does data live: phone only, or a small cloud database that syncs to a laptop?
- Keep raw audio as a backup, or delete after transcription?
- Load *The Life I Deserve* and *Silence Speaks* as the first two books?
- May the AI read finished chapters to ground interviews, or notes only?
- Traditional publishing plans? (If so, ask an agent about publisher AI clauses.)
- Name: Writer's Room, or something else?
