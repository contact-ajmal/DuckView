/**
 * OpenAPI 3.0 document for the REST tool façade (/api/agent/v1/tools/<tool>), generated from the tool registry.
 * Consumed by Bedrock Agents action groups (OpenAPI schema + Lambda executor) and AgentCore Gateway OpenAPI targets.
 * Bedrock requires operationId, a description per operation and JSON request/response bodies — all present here.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDef } from './tools.js';

export function toolInputJsonSchema(tool: ToolDef): Record<string, unknown> {
  const schema = zodToJsonSchema(z.object(tool.inputSchema), { target: 'openApi3', $refStrategy: 'none' }) as Record<string, unknown>;
  delete schema.$schema;
  delete schema.additionalProperties;
  return schema;
}

export function buildOpenApi(tools: ToolDef[], opts: { serverUrl: string; version?: string }): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const t of tools) {
    paths[`/api/agent/v1/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.title,
        description: t.description,
        tags: ['tools'],
        'x-duckview-annotations': t.annotations,
        requestBody: { required: true, content: { 'application/json': { schema: toolInputJsonSchema(t) } } },
        responses: {
          '200': { description: 'Tool result', content: { 'application/json': { schema: { $ref: '#/components/schemas/ToolResult' } } } },
          '400': { description: 'Invalid arguments', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': { description: 'Missing or invalid bearer token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '403': { description: 'Scope or workspace not permitted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
        security: [{ bearerAuth: [] }],
      },
    };
  }
  paths['/api/agent/v1/tools'] = {
    get: {
      operationId: 'list_tools',
      summary: 'List tools',
      description: 'Names, descriptions and JSON-schema inputs of every tool this token may call.',
      tags: ['meta'],
      responses: { '200': { description: 'Tool catalogue', content: { 'application/json': { schema: { type: 'object', properties: { tools: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, input_schema: { type: 'object' } } } } } } } } } },
      security: [{ bearerAuth: [] }],
    },
  };
  return {
    openapi: '3.0.3',
    info: {
      title: 'DuckView agent tools',
      version: opts.version ?? '1.2.0',
      description:
        'HTTP façade over the DuckView MCP tools: run DuckDB SQL, profile datasets, browse files / cloud buckets / lakehouse catalogs, inspect schemas, run Databricks SQL and manage dashboards. ' +
        'Mutating statements are held for human approval (HITL) until re-issued with dry_run=false. Results are capped; prefer aggregations. ' +
        'Every operation returns text (Markdown) plus structured JSON.',
    },
    servers: [{ url: opts.serverUrl }],
    tags: [
      { name: 'tools', description: 'Data tools (same semantics as the MCP tools)' },
      { name: 'meta', description: 'Discovery' },
    ],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'DuckView API token (dv_…)' } },
      schemas: {
        ToolResult: {
          type: 'object',
          required: ['text', 'is_error'],
          properties: {
            text: { type: 'string', description: 'Human/LLM-readable Markdown rendering of the result' },
            is_error: { type: 'boolean' },
            structured: { type: 'object', additionalProperties: true, description: 'Typed JSON payload (status, columns, rows, …)' },
          },
        },
        Error: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' }, request_id: { type: 'string' } } },
      },
    },
  };
}
