# Readiness agent eval

Run 2026-11-24 with `npm run eval -- --runs 3` · model `claude-sonnet-5-5` (effort medium) · demo data as of 2026-11-24 · same loop, tools and prompt as the app (`lib/agent/run.ts`).

**Scenarios.** *fresh*: the demo data as loaded (one launch at risk). *a week later*: five tickets change (L1's blocker clears; L2 gets a blocked ticket, L3 an overdue one, L4 a reopened overdue regression, L5 a ticket due after go/no-go), so four launches are at risk for different reasons.

**How it's scored.** Each brief is checked against the data the agent read (`lib/agent/verify.ts`, the same check the app shows under every AI brief):
- *Same call*: the brief's GO / GO WITH CONDITIONS / NO-GO matches the rules engine's call for the same data.
- *Invented ids*: issue ids the brief cites that don't exist in the tracker.
- *Recall*: of the tickets behind at-risk gates (blocked, overdue, due after go/no-go), how many the brief cites. Gates with no ticket have nothing to cite and aren't counted.
- *Format*: exactly the four headings, in order.

## Summary

| Metric | Result |
| --- | --- |
| Briefs completed | 30/30 |
| Briefs whose go/no-go call passed the readiness-rules check | 30/30 (100%) |
| Invented issue ids | 0 of 152 cited |
| At-risk tickets cited (recall) | 21/21 (100%) |
| Exact 4-section format | 30/30 |
| Latency p50 / p95 | 5.3 s / 6.4 s (target < 30 s) |
| Cost per brief (avg) | $0.013 (total $0.40) |

## Per brief

| Scenario | Launch | Run | Call (rules) | Ids cited / invented | At-risk tickets missed | Format | Time | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fresh | L1 Triage Agent | 1 | NO-GO (NO-GO) ✓ | 11 / 0 | none | ✓ | 5.7 s | $0.016 |
| fresh | L1 Triage Agent | 2 | NO-GO (NO-GO) ✓ | 11 / 0 | none | ✓ | 5.7 s | $0.016 |
| fresh | L1 Triage Agent | 3 | NO-GO (NO-GO) ✓ | 11 / 0 | none | ✓ | 5.6 s | $0.016 |
| fresh | Change Risk Insights | 1 | GO WITH CONDITIONS (GO WITH CONDITIONS) ✓ | 6 / 0 | none | ✓ | 5.7 s | $0.015 |
| fresh | Change Risk Insights | 2 | GO WITH CONDITIONS (GO WITH CONDITIONS) ✓ | 6 / 0 | none | ✓ | 5.9 s | $0.016 |
| fresh | Change Risk Insights | 3 | GO WITH CONDITIONS (GO WITH CONDITIONS) ✓ | 6 / 0 | none | ✓ | 6.5 s | $0.016 |
| fresh | Knowledge Graph API v2 | 1 | GO WITH CONDITIONS (GO WITH CONDITIONS) ✓ | 4 / 0 | none | ✓ | 5.1 s | $0.014 |
| fresh | Knowledge Graph API v2 | 2 | GO WITH CONDITIONS (GO WITH CONDITIONS) ✓ | 4 / 0 | none | ✓ | 5.9 s | $0.015 |
| fresh | Knowledge Graph API v2 | 3 | GO WITH CONDITIONS (GO WITH CONDITIONS) ✓ | 4 / 0 | none | ✓ | 4.9 s | $0.014 |
| fresh | ServiceNow connector 3.1 | 1 | GO (GO) ✓ | 3 / 0 | none | ✓ | 4.7 s | $0.009 |
| fresh | ServiceNow connector 3.1 | 2 | GO (GO) ✓ | 3 / 0 | none | ✓ | 3.8 s | $0.009 |
| fresh | ServiceNow connector 3.1 | 3 | GO (GO) ✓ | 3 / 0 | none | ✓ | 3.8 s | $0.009 |
| fresh | Incident timeline refresh | 1 | GO WITH CONDITIONS (GO WITH CONDITIONS) ✓ | 3 / 0 | none | ✓ | 4.8 s | $0.012 |
| fresh | Incident timeline refresh | 2 | GO WITH CONDITIONS (GO WITH CONDITIONS) ✓ | 3 / 0 | none | ✓ | 4.5 s | $0.011 |
| fresh | Incident timeline refresh | 3 | GO WITH CONDITIONS (GO WITH CONDITIONS) ✓ | 3 / 0 | none | ✓ | 4.2 s | $0.011 |
| a week later | L1 Triage Agent | 1 | NO-GO (NO-GO) ✓ | 11 / 0 | none | ✓ | 6.4 s | $0.017 |
| a week later | L1 Triage Agent | 2 | NO-GO (NO-GO) ✓ | 7 / 0 | none | ✓ | 5.0 s | $0.015 |
| a week later | L1 Triage Agent | 3 | NO-GO (NO-GO) ✓ | 11 / 0 | none | ✓ | 6.0 s | $0.016 |
| a week later | Change Risk Insights | 1 | NO-GO (NO-GO) ✓ | 6 / 0 | none | ✓ | 5.3 s | $0.015 |
| a week later | Change Risk Insights | 2 | NO-GO (NO-GO) ✓ | 6 / 0 | none | ✓ | 5.6 s | $0.015 |
| a week later | Change Risk Insights | 3 | NO-GO (NO-GO) ✓ | 6 / 0 | none | ✓ | 5.1 s | $0.015 |
| a week later | Knowledge Graph API v2 | 1 | NO-GO (NO-GO) ✓ | 4 / 0 | none | ✓ | 5.5 s | $0.014 |
| a week later | Knowledge Graph API v2 | 2 | NO-GO (NO-GO) ✓ | 4 / 0 | none | ✓ | 5.4 s | $0.014 |
| a week later | Knowledge Graph API v2 | 3 | NO-GO (NO-GO) ✓ | 4 / 0 | none | ✓ | 5.2 s | $0.014 |
| a week later | ServiceNow connector 3.1 | 1 | NO-GO (NO-GO) ✓ | 1 / 0 | none | ✓ | 5.7 s | $0.010 |
| a week later | ServiceNow connector 3.1 | 2 | NO-GO (NO-GO) ✓ | 1 / 0 | none | ✓ | 4.7 s | $0.010 |
| a week later | ServiceNow connector 3.1 | 3 | NO-GO (NO-GO) ✓ | 1 / 0 | none | ✓ | 5.3 s | $0.011 |
| a week later | Incident timeline refresh | 1 | NO-GO (NO-GO) ✓ | 3 / 0 | none | ✓ | 4.6 s | $0.012 |
| a week later | Incident timeline refresh | 2 | NO-GO (NO-GO) ✓ | 3 / 0 | none | ✓ | 4.3 s | $0.011 |
| a week later | Incident timeline refresh | 3 | NO-GO (NO-GO) ✓ | 3 / 0 | none | ✓ | 4.5 s | $0.012 |

Cost uses list prices ($2 / $10 per million input / output tokens). Latency is wall-clock from the first request to the final brief, run 3 at a time.
