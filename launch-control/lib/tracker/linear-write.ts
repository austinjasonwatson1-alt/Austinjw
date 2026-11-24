import { LinearClient } from '@linear/sdk';
import { fmtDate } from '../dates';
import type { FixWriter } from '../hygiene/apply';
import type { ProposedFix } from '../readiness/hygiene';
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
