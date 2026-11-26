# Hard questions, with honest answers

Short answers to say out loud, about 20 seconds each. The self-critical ones matter most: answer them plainly.

## About the product

**1. Why wouldn't a team just use Linear's (or Jira's) own dashboards?**
Dashboards show the tickets that exist. The riskiest gap is the ticket nobody filed, and a dashboard can't show that. Launch Control starts from the gates a launch of that tier *should* have, so a missing ticket shows up as a red gate. It also answers the question in a sentence instead of leaving someone to read a board.

**2. What's weak about it today?**
Three things. The gate definitions are mine, not validated with real R&D, QA and PMM leads. There's no history, so it can't say whether a launch is getting better or worse week over week. And "minutes saved" is an estimate, not a measurement. I'd fix those in that order.

**3. What would you cut?**
The "manual work removed" counter. It's the least defensible number on the page. I'd replace it with something measured, like hours between "brief requested" and "decision posted".

**4. What did you get wrong along the way?**
The first agent runs added an extra section and once said "go with conditions" while two gates were at risk. Both showed up because I tested instead of assuming. I tightened the prompt, added a check under every brief, and built an eval so I'd know if it regressed.

**5. How do you know the AI is right?**
Every brief is checked against the data it read: each issue ID must exist, and its call must match the rules engine. Across 30 runs on two scenarios: 30 of 30 matching calls, 0 invented IDs out of 157, and every at-risk ticket cited. If a check fails, the screen says so in pink.

**6. If the rules engine already makes the call, why use AI at all?**
The rules decide go or no-go; they can't write. The agent turns ticket data into a brief a VP can read in ten seconds, names what each owner has to do by when, and notices things the rules don't score, like an unassigned ticket inside a healthy gate. The rules are the floor and the benchmark; the AI is the communication layer.

**7. Why can't the agent act on its own?**
Trust. A wrong automated message to an exec, or a wrong reassignment, costs more than the minute it saves. So the agent is read-only, and every write (fixes, alerts, the decision) is previewed and confirmed by a person. The server also recomputes what's valid before writing, so a stale screen can't write stale changes.

**8. A person can override the rules and record "Go". Isn't that a hole?**
It's deliberate. The tool informs the decision; a person owns it. But the override is on the record: the posted update includes the readiness numbers and says the rules disagreed.

## About scale and the real world

**9. How would this work with our tracker instead of Linear?**
The tracker sits behind one interface with two adapters today (demo and Linear). Jira or another tracker is one more adapter plus a mapping file: what's a launch, what's a gate, what counts as blocked. The rules, the agent and the UI don't change. The hard part isn't the code; it's agreeing the mapping with the teams.

**10. Our gates aren't your ten gates. Then what?**
Good, they shouldn't be. Gates per tier are data, not code. The first 30 days are sitting with each function to agree what "ready" means for them and who owns each gate.

**11. What breaks at 50 launches and 5,000 tickets?**
Loading everything on each page view, and an in-memory rate limit. I'd add incremental sync, a small database for history and decisions, and a shared rate-limit store. I kept v1 without a database on purpose so it could ship in a week.

**12. What about security and data?**
Keys stay on the server. AI output and tracker text are treated as untrusted and rendered as text. The public demo has a passcode, a rate limit and a spend cap. For real use I'd add sign-in, per-team permissions and an audit log of every write.

**13. What does it cost to run?**
About a cent per brief with the current model. At five launches reviewed weekly that's well under a dollar a month in AI cost.

## About this role (from the posting)

**18. The posting says the process is new and much of it is yours to design. Where would you start?**
By watching one real launch go through today's process before changing anything. Then agree with each function what "ready" means for their gate and who owns it. I'd design it with the teams, not for them, and automate the step that's repeated most first.

**19. Where should humans stay in the loop in an agentic delivery process?**
Wherever a mistake is expensive or hard to undo: the go/no-go call, anything customer-facing, anything that reassigns people's work, and any message to leadership. Agents read, score, draft and propose. In Launch Control the agent has no write access at all; every write is previewed and confirmed.

**20. We use Linear and DevRev. What's your DevRev experience?**
[Answer honestly with your own experience.] The architecture point: the tracker sits behind one interface. Linear is one adapter; DevRev is another adapter plus a mapping of what counts as a launch, a gate and a blocker. The first thing I'd want to understand is which system owns which record, and where the handoff between them drops things.

**21. Which product delivery KPIs would you define?**
The demo shows four as a starting point (section 4): gates with an owner and a date, launches on track, gates ready a week before go/no-go, and tracker data quality. Beyond those:
Launch date predictability (days slipped against the committed date). Share of gates ready a week before go/no-go. Risks found before the review versus in it. Share of releases that followed the process. Tracker hygiene. Manual hours removed. I'd start with two, baseline them, and add more only when someone acts on the first two.

**22. A KPI slips. What do you do?**
Find out whether it's the measure or the process: is the data right, and is it one launch or a pattern? Then take it to the owner of that step with the evidence and one proposed change, and re-measure. [Add your own example.]

**23. This is launches. What about SKO or a Customer Advisory Board?**
Same shape, different gates. An SKO has a date, owners across functions, and things that must be true before it: content, enablement, logistics, exec prep. I'd run it as a program with gates and a go/no-go. [Add your own example of a large program.]

**24. How do you hold senior stakeholders to an agenda and a date?**
Send the brief before the meeting so the meeting is for decisions, not status. Open with the call the data suggests. Record the decision and owners before people leave, and publish it. [Add your own example.]

**25. How do you measure the manual work an automation removes?**
Time the manual version first, even roughly, with the person who does it. Count how often it happens. After the automation, count runs and spot-check the time. In the demo the minutes are estimates and labelled that way; in the role I'd baseline before building.

## About you and the role

**14. How would you roll this out without annoying people?**
Run it alongside the current process on two launches first. Don't change anyone's workflow; read what they already keep in the tracker. Show each team their own gates and let them correct the definitions. Only make it the default once the numbers show it catches risks earlier.

**15. How would you measure success?**
Prep hours per go/no-go; the share of gates with an owner and a date a week before go/no-go; risks found before the meeting rather than in it; and whether leadership stops asking for a separate status deck.

**16. Why did you build this instead of writing a proposal?**
Because a working tool forces the real questions: what counts as blocked, who owns a gate with no ticket, what an exec actually reads. I ran the build like a launch, with a PRD, milestones, gates in Linear and a decisions log, so the process is as inspectable as the product.

**17. What would you do in the first week if hired?**
Sit in on a real launch review, map how status moves today, and find the one report someone assembles by hand every week. Start there.
