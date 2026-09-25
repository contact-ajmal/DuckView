/**
 * The tool-calling protocol DuckView speaks with every model, whatever the provider: the model asks for one tool at
 * a time with a fenced ```tool block ({"name", "arguments"}) and may state or revise its plan with a ```plan block
 * (one step a line). Plain text with neither block is the answer. It works with every provider DuckView supports —
 * chat-completion vendors, Anthropic, Bedrock, local models — because it needs nothing but text.
 */
import type { ToolDescriptor } from '../registry.js';

const TOOL_BLOCK = /```tool[ \t]*\n([\s\S]*?)```/;
const PLAN_BLOCK = /```plan[ \t]*\n([\s\S]*?)```/;
/** Where a protocol block starts (or may be starting, at the end of a stream). */
const BLOCK_START = /```(tool|plan)\b/;

/** The first ```tool block of a reply: {name, arguments}, or an error to send back to the model. */
export function parseToolCall(text: string): { name: string; arguments: Record<string, unknown> } | { error: string } | null {
  const m = TOOL_BLOCK.exec(text);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]!.trim()) as { name?: unknown; tool?: unknown; arguments?: unknown; args?: unknown };
    const name = String(raw.name ?? raw.tool ?? '');
    if (!name) return { error: 'The tool block needs "name".' };
    const args = (raw.arguments ?? raw.args ?? {}) as Record<string, unknown>;
    return { name, arguments: typeof args === 'object' && args && !Array.isArray(args) ? args : {} };
  } catch (err) {
    return { error: `The tool block is not valid JSON (${(err as Error).message}). Send {"name": "...", "arguments": {...}}.` };
  }
}

/** The steps of a ```plan block ("1. …", "- …" or plain lines), or null. */
export function parsePlan(text: string): string[] | null {
  const m = PLAN_BLOCK.exec(text);
  if (!m) return null;
  const steps = m[1]!.split('\n').map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean);
  return steps.length ? steps.slice(0, 20) : null;
}

/** The answer text of a reply: everything outside protocol blocks. */
export function visibleText(text: string): string {
  return stripBlocks(text).trim();
}

/** The text with protocol blocks removed, whitespace kept. */
export function stripBlocks(text: string): string {
  return text.replace(/```(tool|plan)[ \t]*\n[\s\S]*?(```|$)/g, '');
}

/** How much of a streaming reply is safe to show: up to the start of a protocol block, holding back a partial fence. */
export function safePrefixLength(text: string): number {
  const m = BLOCK_START.exec(text);
  if (m) return m.index;
  // Trailing backticks (and a few letters) could still become a block: hold them back until more text arrives.
  const tail = /`{1,3}[a-z]{0,4}$/.exec(text);
  return tail ? tail.index : text.length;
}

/** "name(a: string, b?: number) — summary", for the prompt. */
export function describeForPrompt(d: Pick<ToolDescriptor, 'name' | 'summary' | 'description' | 'inputSchema'>): string {
  const schema = d.inputSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] };
  const args = Object.entries(schema.properties ?? {}).map(([k, v]) => `${k}${schema.required?.includes(k) ? '' : '?'}: ${v.enum ? v.enum.map((x) => JSON.stringify(x)).join('|') : v.type ?? 'any'}`);
  return `- ${d.name}(${args.join(', ')}) — ${(d.description.split('\n')[0] ?? d.summary).slice(0, 400)}`;
}

export const PROTOCOL_GUIDE = `To use a tool, reply with ONLY one fenced block and nothing after it:
\`\`\`tool
{"name": "<tool>", "arguments": { ... }}
\`\`\`
The result comes back in the next message. One tool at a time.
To state or change your plan, you may put a \`\`\`plan block (one short step a line) before the tool block.
When you have what you need, reply with the final answer in markdown and no tool block.`;
