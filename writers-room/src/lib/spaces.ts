// The nine places a note can live. Fixed list: custom spaces are out of V1 scope.
export const SPACES = {
  inbox: { label: "Inbox", zone: "both" },
  brainstorm: { label: "Brainstorm", zone: "idea" },
  book_ideas: { label: "Book ideas", zone: "idea" },
  scenes: { label: "Scenes", zone: "book" },
  characters: { label: "Characters", zone: "book" },
  places: { label: "Places", zone: "book" },
  plot: { label: "Plot and timeline", zone: "book" },
  questions: { label: "Questions", zone: "both" },
} as const;

export type SpaceId = keyof typeof SPACES;

// What the author says out loud at the start of a note to name its space.
// Display text is what we show on the note ("Scene note").
export const SPOKEN_LABELS: Record<string, { space: SpaceId; display: string }> = {
  "book idea": { space: "book_ideas", display: "Book idea" },
  brainstorm: { space: "brainstorm", display: "Brainstorm" },
  scene: { space: "scenes", display: "Scene note" },
  character: { space: "characters", display: "Character note" },
  place: { space: "places", display: "Place note" },
  setting: { space: "places", display: "Place note" },
  plot: { space: "plot", display: "Plot note" },
  timeline: { space: "plot", display: "Plot note" },
  question: { space: "questions", display: "Question" },
};
