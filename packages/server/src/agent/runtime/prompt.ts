/**
 * The agent's system prompt: who it works for, the rules it works under, its plan, the context the Context Engine
 * selected, the tools the Decision Engine selected, and the tool protocol. Small by construction — nothing here
 * lists the whole catalog or every tool.
 */
import type { AgentPlanStep } from '../../db/schema/sqlite.js';
import type { ContextPack } from '../context/types.js';
import { renderPack } from '../context/engine.js';
import type { Intent } from '../decision/types.js';
import type { ToolDescriptor } from '../registry.js';
import { PROTOCOL_GUIDE, describeForPrompt } from '../reasoning/protocol.js';

/** A first plan for each kind of request; the model may replace it with a ```plan block. */
export function initialPlan(intent: Intent): AgentPlanStep[] {
  const steps: Record<Intent, string[]> = {
    ask: ['Find the data that answers it', 'Get the numbers', 'Answer'],
    analyse: ['Find the relevant data and metrics', 'Query it', 'Summarise the findings'],
    investigate: ['Find the canonical metric and its data', 'Compare the periods', 'Break the change down by segment', 'Summarise the drivers'],
    explain: ['Look at what is being asked about', 'Explain it'],
    create: ['Find what it builds on', 'Create it', 'Confirm what was made'],
    build: ['Find the data', 'Check the queries', 'Build it', 'Summarise what was built'],
    modify: ['Find what to change', 'Make the change', 'Confirm'],
    navigate: ['Open it'],
    quality: ['Inspect the table', 'Work out the checks', 'Create the checks', 'Summarise'],
    transform: ['Inspect the source', 'Write the SQL', 'Create the model', 'Summarise'],
    discover: ['Search the catalog', 'Look at the candidates', 'Answer'],
  };
  return steps[intent].map((text, i) => ({ text, status: i === 0 ? 'active' : 'pending' }));
}

export interface PromptInput {
  workspace: string;
  user: string;
  pack: ContextPack;
  tools: ToolDescriptor[];
  plan: AgentPlanStep[];
  maxRows: number;
  canWrite: boolean;
  stepsLeft: number;
}

export function systemPrompt(i: PromptInput): string {
  const plan = i.plan.map((s, n) => `${n + 1}. [${s.status}] ${s.text}`).join('\n');
  return `You are the DuckView agent. You work inside the DuckView workspace "${i.workspace}" for ${i.user}: you operate the workspace through tools, then answer. Today is ${new Date().toISOString().slice(0, 10)}.

## Rules
- Use only the tools listed below, one at a time. The workspace is chosen for you: leave workspace_id out.
- When a metric of the semantic layer answers the question, query it with query_metrics. Never re-derive a defined metric with your own SQL.
- Look before you write: inspect schemas and check a query before building a dashboard, checks or a model on it.
- SQL is DuckDB. Aggregate rather than list rows; results are capped at ${i.maxRows} rows.
- ${i.canWrite ? 'Some changes need the person\'s approval: the task pauses until they decide. Never try to work around a refusal.' : 'This person can read but not change the workspace: do not try to create or change anything.'}
- Every number in your answer must come from a tool result. Say which metric, table or SQL it came from.
- If a tool fails, read the error, fix the call (inspect_schema helps) and try again, or take another way.
- To show the person something in their workspace (a dashboard, a table, a SQL tab), use open_in_workspace.
- You have ${i.stepsLeft} tool calls left.

## Plan
${plan}

${renderPack(i.pack)}

## Tools
${i.tools.map(describeForPrompt).join('\n')}

${PROTOCOL_GUIDE}

Answer in short markdown: lead with the answer, then the findings as bullets, then the metric, table or SQL used.`;
}
