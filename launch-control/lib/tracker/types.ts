export type Tier = 1 | 2 | 3;

export type GateKey = 'prd' | 'eng' | 'qa' | 'flag' | 'sec' | 'docs' | 'enable' | 'support' | 'price' | 'comms';

export type Team = 'R&D' | 'QA' | 'Docs' | 'PMM' | 'Support' | 'Sales Eng' | 'Security' | 'PM';

export type IssueStatus = 'backlog' | 'in_progress' | 'in_review' | 'done' | 'blocked';

export type SourceKind = 'demo' | 'linear';

export interface Launch {
  id: string;
  name: string;
  /** "General availability", "Early access", "Minor release" */
  milestone: string;
  tier: Tier;
  /** ISO calendar date */
  launchDate: string;
  pm: string | null;
}

export interface Issue {
  id: string;
  launchId: string | null;
  gate: GateKey | null;
  title: string;
  team: Team | null;
  owner: string | null;
  status: IssueStatus;
  /** ISO calendar date, or null when no due date is set */
  due: string | null;
  /** ISO calendar date of the last update */
  updatedAt: string;
  url?: string;
}

/** Everything the UI and the agent need, as of one calendar date. */
export interface TrackerSnapshot {
  source: SourceKind;
  /** The "today" every score in this snapshot is computed against. */
  asOf: string;
  launches: Launch[];
  issues: Issue[];
  /** Team → lead who gets auto-assigned unowned tickets (null = no default owner). */
  teamLeads: Partial<Record<Team, string | null>>;
  /** Shown as a banner, e.g. when Linear failed and demo data was used instead. */
  notice?: string;
}

export interface TrackerSource {
  kind: SourceKind;
  load(asOf: string): Promise<TrackerSnapshot>;
}
