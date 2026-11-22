# Writer's Room — project rules for Claude Code

Read SPEC.md and DECISIONS.md at the start of every session.

## Non-negotiable rules (these protect the author's copyright)

- The AI never writes manuscript prose. It transcribes, sorts, tags, connects and asks questions only.
- Transcription cleanup may remove filler words and add punctuation. It must never add, rewrite or reorder sentences.
- Every note stores its source: `spoken`, `typed`, or `ai_suggestion`.
- AI suggestions are visually distinct and cannot be copied or dragged into a Scene card; the author must retype.
- "Add to canon" opens a blank note for the author to write. Never pre-fill it with AI text.
- All AI calls go through the Anthropic API (commercial terms, no training on inputs). Never route content through a consumer chat product.
- One exception, for audio only: speech-to-text goes to a single named transcription provider whose business terms forbid training on customer data, because the Anthropic API doesn't accept audio. All cleanup, splitting, sorting and interviews still go through the Anthropic API. (See DECISIONS.md, 2026-11-22.)
- The API key lives server-side or in an environment variable, never in client code or the repo.
- Export to plain text and .docx must always work, and the authorship log must be exportable.
- No public sharing, no analytics that send note content to third parties.

## How to work with me (Austin)

- I'm a product manager, not a full-time engineer. Explain decisions in plain language.
- Build one milestone at a time (see SPEC.md "Order of work"). Stop at the end of each milestone, show me how to run it, and wait for my go-ahead.
- Before adding anything not in SPEC.md, ask me.
- Log every meaningful product or technical decision in DECISIONS.md: date, decision, why, alternatives considered.
- I care a lot about visual design. The app should look polished and intentional on a phone, not like a default template.
- Keep setup simple: I should be able to run it with one or two commands.

## Testing

- Keep the evaluation tests from SPEC.md (sorting, consistency, voice) runnable as scripts, so results can be published.
