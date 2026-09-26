# Agent UI principles

How the DuckView agent looks and behaves in the Console and the Analyst WebUI. It is one agent in two surfaces, with
the same components.

## 1. The prompt is the centre

The Agent Home is a prompt, not a page of options. It has:

- no headline paragraph;
- one field;
- a compact context line under it (workspace · datasets · + Context);
- five quiet intents.

Everything else sits below the fold of attention.

## 2. Context is explicit and small

- The workspace and the chosen datasets are always visible, as a single line.
- With no dataset chosen, the line invites one with "Choose data (optional)" rather than stating "Any data".
- An object carried from the screen (⌘I) appears as a removable chip.
- The agent's own discoveries are shown apart from what the person chose, under "The agent found".

## 3. One continuous flow

**ready → working → mission → workspace.** Submitting doesn't feel like navigating:

- The request the person typed becomes the heading of the mission, at the same reading width.
- The plan appears under it (`dv-rise`, 320 ms, off with reduced motion).
- As results arrive, the page widens into the workspace. The request stays as the title, and progress stays in the
  header.

## 4. Show decisions, not thinking

- Shown:
  - the plan;
  - steps as sentences ("Ran a query on `orders` · 1.2 s · 240 rows");
  - approvals;
  - datasets discovered;
  - results.
- Never shown: the model's reasoning or chain of thought.
- Activity is collapsed behind "Show the work (n steps)". It opens automatically only on a failure or an approval.

## 5. Results are native objects

- A result is the dashboards' own chart, with a Chart, Table and SQL switch.
- A made object (dashboard, notebook, model, checks) is a single row with "Open in Console". The action is disabled,
  with the server's reason, when access doesn't allow it.
- Nothing lives only in the conversation.

## 6. Fewer frames

- Findings are a list on the canvas, not a card.
- Results sit in a frame (they need one, as a chart does).
- Made objects are rows under a hairline.
- The side panel holds Progress, Context and Requests as plain sections.

## 7. One primary action per screen

| Screen | Primary action |
|---|---|
| Home | Start |
| Working | None (Stop is secondary) |
| Waiting for approval | Approve |
| Workspace | Continue the mission (the composer) |

Everything else is a ghost button or an icon button.

## 8. Missions have weight when they are alive

- Active missions sit above Recent, each with a progress bar, its current activity and its status word.
- Recent missions are compact rows (title, what they made, when). Hover or focus reveals Duplicate and Open.

## 9. Permissions are visible, not surprising

- A viewer never sees an action they can never take.
- An action they can't take *here* is disabled with a reason.
- A shared mission, seen under a restricted access policy, hides values and offers "Run as me".

## 10. States

| State | Word | Tone |
|---|---|---|
| Planning | Planning | busy |
| Running | Working | busy |
| Waiting for approval | Needs approval | warn |
| Done | Done | ok |
| Failed | Failed | error |
| Cancelled | Cancelled | idle |

Always show the word with the dot.
