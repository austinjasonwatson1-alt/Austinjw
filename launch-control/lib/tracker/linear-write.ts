import { LinearClient } from '@linear/sdk';
import { fmtDate } from '../dates';
import type { FixWriter } from '../hygiene/apply';
import type { ProposedFix } from '../readiness/hygiene';
import { ALERT_MARKER, type RiskAlert } from '../readiness/alerts';
import { withTimeout } from './linear';
import { nudgeComment, setOwnerLine } from './linear-schema';

const WRITE_TIMEOUT_MS = 5_000;

/** Writes confirmed hygiene fixes to Linear. Only these three mutations exist; nothing else is written. */
export function linearFixWriter(apiKey: string): FixWriter {
  const client = new LinearClient({ apiKey });
  const gql = async <T>(query: string, vars: Record<string, unknown>): Promise<T> => {
    const res: { data?: T } = await withTimeout(client.client.rawRequest<T, Record<string, unknown>>(query, vars), WRITE_TIMEOUT_MS);
    if (!res.data) throw new Error('linear_empty_response');
    return res.data;
  };
  const ok = (r: { success: boolean }) => {
    if (!r.success) throw new Error('linear_rejected');
  };

  return {
    async apply(fix: ProposedFix) {
      // issue(id:) accepts the identifier (LCH-16) and returns the uuid + current description.
      const { issue } = await gql<{ issue: { id: string; description: string | null } }>(
        `query($id: String!) { issue(id: $id) { id description } }`,
        { id: fix.issueId },
      );
      if (fix.kind === 'owner') {
        // Assign a real workspace member if the lead is one; otherwise record the owner as text (PRD §5 mapping note).
        const { users } = await gql<{ users: { nodes: { id: string }[] } }>(
          `query($n: String!) { users(first: 2, filter: { name: { eqIgnoreCase: $n } }) { nodes { id } } }`,
          { n: fix.owner },
        );
        const input = users.nodes.length === 1 ? { assigneeId: users.nodes[0].id } : { description: setOwnerLine(issue.description, fix.owner!) };
        const r = await gql<{ issueUpdate: { success: boolean } }>(
          `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
          { id: issue.id, input },
        );
        ok(r.issueUpdate);
      } else if (fix.kind === 'due') {
        const r = await gql<{ issueUpdate: { success: boolean } }>(
          `mutation($id: String!, $due: TimelessDate!) { issueUpdate(id: $id, input: { dueDate: $due }) { success } }`,
          { id: issue.id, due: fix.due },
        );
        ok(r.issueUpdate);
      } else {
        const body = nudgeComment(fix.owner!, fix.staleDays ?? 14, fix.goNoGo ? fmtDate(fix.goNoGo) : undefined);
        const r = await gql<{ commentCreate: { success: boolean } }>(
          `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
          { issueId: issue.id, body },
        );
        ok(r.commentCreate);
      }
    },
  };
}

const DAY_MS = 86_400_000;

/**
 * Posts a confirmed risk alert as a comment on the ticket (Linear notifies its assignee and
 * subscribers). Skips a ticket that already got a Launch Control alert in the last 24 hours.
 */
export function linearAlertWriter(apiKey: string): { apply(a: RiskAlert): Promise<void> } {
  const client = new LinearClient({ apiKey });
  const gql = async <T>(query: string, vars: Record<string, unknown>): Promise<T> => {
    const res: { data?: T } = await withTimeout(client.client.rawRequest<T, Record<string, unknown>>(query, vars), WRITE_TIMEOUT_MS);
    if (!res.data) throw new Error('linear_empty_response');
    return res.data;
  };
  return {
    async apply(a: RiskAlert) {
      const { issue } = await gql<{ issue: { id: string; comments: { nodes: { body: string; createdAt: string }[] } } }>(
        `query($id: String!) { issue(id: $id) { id comments(first: 25) { nodes { body createdAt } } } }`,
        { id: a.issueId },
      );
      const recent = issue.comments.nodes.some(
        (c) => c.body.startsWith(ALERT_MARKER) && Date.now() - new Date(c.createdAt).getTime() < DAY_MS,
      );
      if (recent) throw new Error('already alerted in the last 24 h');
      const r = await gql<{ commentCreate: { success: boolean } }>(
        `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
        { issueId: issue.id, body: a.message },
      );
      if (!r.commentCreate.success) throw new Error('linear_rejected');
    },
  };
}

/** Posts a recorded go/no-go decision as a project update (with health) on the launch's Linear project. */
export async function postDecisionToLinear(
  apiKey: string,
  projectSlug: string,
  update: { body: string; health: 'onTrack' | 'atRisk' | 'offTrack' },
): Promise<{ url?: string }> {
  const client = new LinearClient({ apiKey });
  const gql = async <T>(query: string, vars: Record<string, unknown>): Promise<T> => {
    const res: { data?: T } = await withTimeout(client.client.rawRequest<T, Record<string, unknown>>(query, vars), WRITE_TIMEOUT_MS);
    if (!res.data) throw new Error('linear_empty_response');
    return res.data;
  };
  const { project } = await gql<{ project: { id: string } | null }>(`query($id: String!) { project(id: $id) { id } }`, { id: projectSlug });
  if (!project) throw new Error('linear_project_not_found');
  const r = await gql<{ projectUpdateCreate: { success: boolean; projectUpdate: { url: string } | null } }>(
    `mutation($input: ProjectUpdateCreateInput!) { projectUpdateCreate(input: $input) { success projectUpdate { url } } }`,
    { input: { projectId: project.id, body: update.body, health: update.health } },
  );
  if (!r.projectUpdateCreate.success) throw new Error('linear_rejected');
  const url = r.projectUpdateCreate.projectUpdate?.url;
  return { url: url && /^https:\/\/linear\.app\//.test(url) ? url : undefined };
}
