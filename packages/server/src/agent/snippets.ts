/**
 * Copy-paste integration snippets for agent frameworks. Placeholders: <TOKEN>, <MCP_URL>, <BASE_URL>, <WORKSPACE_ID>,
 * <REGION>, <GATEWAY_ID> — the UI substitutes the agent's token and workspace.
 */
import type { AgentFramework } from '../db/schema/sqlite.js';

export interface Snippet {
  id: string;
  label: string;
  file: string;
  language: 'python' | 'bash' | 'json';
  code: string;
  notes?: string;
}

export const FRAMEWORK_META: Record<AgentFramework, { title: string; blurb: string; transport: 'mcp' | 'rest' | 'both'; docs: string }> = {
  strands: { title: 'Strands Agents', blurb: 'AWS Strands Agents SDK — connects to DuckView over MCP (streamable HTTP).', transport: 'mcp', docs: 'https://strandsagents.com/latest/user-guide/concepts/tools/mcp-tools/' },
  langgraph: { title: 'LangGraph', blurb: 'LangGraph ReAct agent with langchain-mcp-adapters.', transport: 'mcp', docs: 'https://github.com/langchain-ai/langchain-mcp-adapters' },
  langchain: { title: 'LangChain', blurb: 'LangChain 1.x create_agent with MCP tools.', transport: 'mcp', docs: 'https://docs.langchain.com/oss/python/langchain/mcp' },
  crewai: { title: 'CrewAI', blurb: 'CrewAI crew whose agents use DuckView tools through MCPServerAdapter.', transport: 'mcp', docs: 'https://docs.crewai.com/en/mcp/overview' },
  agentcore_runtime: { title: 'AgentCore Runtime', blurb: 'Your own agent (Strands / LangGraph / CrewAI …) deployed on Amazon Bedrock AgentCore Runtime; DuckView can invoke it back (InvokeAgentRuntime).', transport: 'mcp', docs: 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime.html' },
  agentcore_gateway: { title: 'AgentCore Gateway', blurb: 'Expose DuckView as a Gateway target (MCP server or OpenAPI) so every agent behind the gateway gets the tools.', transport: 'both', docs: 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html' },
  bedrock_agent: { title: 'Bedrock Agents (Classic)', blurb: 'Action group backed by the generated OpenAPI schema + a Lambda forwarder. Bedrock Agents Classic is closed to new customers — prefer AgentCore for new builds.', transport: 'rest', docs: 'https://docs.aws.amazon.com/bedrock/latest/userguide/agents-action-create.html' },
  custom: { title: 'Custom / HTTP', blurb: 'Any agent or script: plain HTTPS calls to the REST tool façade, or MCP.', transport: 'both', docs: '' },
};

const SYSTEM_PROMPT = 'You are a data analyst working in DuckView. Call list_accessible_data first, prefer aggregations, and never run mutating SQL without human approval (dry_run=false).';

export function snippetsFor(framework: AgentFramework): Snippet[] {
  switch (framework) {
    case 'strands':
      return [
        {
          id: 'strands',
          label: 'Strands agent',
          file: 'agent.py',
          language: 'python',
          code: `# pip install strands-agents mcp
from mcp.client.streamable_http import streamablehttp_client
from strands import Agent
from strands.tools.mcp import MCPClient

duckview = MCPClient(lambda: streamablehttp_client(
    "<MCP_URL>",
    headers={"Authorization": "Bearer <TOKEN>"},
))

with duckview:
    agent = Agent(
        system_prompt="${SYSTEM_PROMPT}",
        tools=duckview.list_tools_sync(),
    )
    agent("Which region had the highest revenue last month? Workspace <WORKSPACE_ID>.")
`,
        },
      ];
    case 'langgraph':
      return [
        {
          id: 'langgraph',
          label: 'LangGraph ReAct agent',
          file: 'agent.py',
          language: 'python',
          code: `# pip install langchain-mcp-adapters langgraph langchain-anthropic
import asyncio
from langchain_anthropic import ChatAnthropic
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent

async def main():
    client = MultiServerMCPClient({
        "duckview": {
            "transport": "streamable_http",
            "url": "<MCP_URL>",
            "headers": {"Authorization": "Bearer <TOKEN>"},
        }
    })
    tools = await client.get_tools()
    agent = create_react_agent(ChatAnthropic(model="claude-opus-5"), tools, prompt="${SYSTEM_PROMPT}")
    result = await agent.ainvoke({"messages": [("user", "Profile sales.parquet in workspace <WORKSPACE_ID> and summarise anomalies.")]})
    print(result["messages"][-1].content)

asyncio.run(main())
`,
        },
      ];
    case 'langchain':
      return [
        {
          id: 'langchain',
          label: 'LangChain agent',
          file: 'agent.py',
          language: 'python',
          code: `# pip install langchain langchain-mcp-adapters langchain-anthropic
import asyncio
from langchain.agents import create_agent
from langchain_mcp_adapters.client import MultiServerMCPClient

async def main():
    client = MultiServerMCPClient({
        "duckview": {
            "transport": "streamable_http",
            "url": "<MCP_URL>",
            "headers": {"Authorization": "Bearer <TOKEN>"},
        }
    })
    tools = await client.get_tools()
    agent = create_agent("anthropic:claude-opus-5", tools=tools, system_prompt="${SYSTEM_PROMPT}")
    result = await agent.ainvoke({"messages": [{"role": "user", "content": "Top 5 products by revenue in workspace <WORKSPACE_ID>?"}]})
    print(result["messages"][-1].content)

asyncio.run(main())
`,
        },
      ];
    case 'crewai':
      return [
        {
          id: 'crewai',
          label: 'CrewAI crew',
          file: 'crew.py',
          language: 'python',
          code: `# pip install crewai "crewai-tools[mcp]"
from crewai import Agent, Crew, Task
from crewai_tools import MCPServerAdapter

server_params = {
    "url": "<MCP_URL>",
    "transport": "streamable-http",
    "headers": {"Authorization": "Bearer <TOKEN>"},
}

with MCPServerAdapter(server_params) as tools:
    analyst = Agent(
        role="Data analyst",
        goal="Answer business questions with DuckDB SQL over the DuckView workspace",
        backstory="${SYSTEM_PROMPT}",
        tools=tools,
        verbose=True,
    )
    task = Task(
        description="Find the top 5 products by revenue in workspace <WORKSPACE_ID>.",
        expected_output="A ranked list with revenue figures and the SQL used.",
        agent=analyst,
    )
    Crew(agents=[analyst], tasks=[task]).kickoff()
`,
        },
      ];
    case 'agentcore_runtime':
      return [
        {
          id: 'agentcore_runtime',
          label: 'AgentCore Runtime entrypoint (Strands)',
          file: 'agent.py',
          language: 'python',
          notes: 'Deploy with the AgentCore starter toolkit: agentcore configure -e agent.py && agentcore launch --env DUCKVIEW_TOKEN=<TOKEN>. DuckView invokes it with payload {"prompt": "...", "context": "..."}.',
          code: `# pip install bedrock-agentcore strands-agents mcp
import os
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from mcp.client.streamable_http import streamablehttp_client
from strands import Agent
from strands.tools.mcp import MCPClient

app = BedrockAgentCoreApp()
duckview = MCPClient(lambda: streamablehttp_client(
    os.environ.get("DUCKVIEW_MCP_URL", "<MCP_URL>"),
    headers={"Authorization": f"Bearer {os.environ['DUCKVIEW_TOKEN']}"},
))

@app.entrypoint
async def invoke(payload, context):
    prompt = payload.get("prompt", "")
    extra = payload.get("context")  # workspace schema/context DuckView sends along
    with duckview:
        agent = Agent(
            system_prompt="${SYSTEM_PROMPT}" + (f"\\n\\n{extra}" if extra else ""),
            tools=duckview.list_tools_sync(),
        )
        async for event in agent.stream_async(prompt):
            if "data" in event:
                yield event["data"]

if __name__ == "__main__":
    app.run()
`,
        },
        {
          id: 'agentcore_invoke',
          label: 'Invoke from your code (boto3)',
          file: 'invoke.py',
          language: 'python',
          code: `import json, uuid, boto3

client = boto3.client("bedrock-agentcore", region_name="<REGION>")
resp = client.invoke_agent_runtime(
    agentRuntimeArn="<RUNTIME_ARN>",
    runtimeSessionId=str(uuid.uuid4()) + "-duckview",  # 33+ chars
    payload=json.dumps({"prompt": "Summarise last month's revenue by region"}).encode(),
)
for line in resp["response"].iter_lines():
    if line.startswith(b"data:"):
        print(json.loads(line[5:]), end="")
`,
        },
      ];
    case 'agentcore_gateway':
      return [
        {
          id: 'gateway_mcp_target',
          label: 'Gateway target → DuckView MCP',
          file: 'gateway.py',
          language: 'python',
          notes: 'Registers DuckView\'s MCP endpoint as a Gateway target authenticated with an API-key credential provider that holds the DuckView token.',
          code: `# pip install boto3
import boto3

ctl = boto3.client("bedrock-agentcore-control", region_name="<REGION>")

# 1) store the DuckView token once as an API-key credential provider
cred = ctl.create_api_key_credential_provider(name="duckview-token", apiKey="<TOKEN>")

# 2) add DuckView as an MCP-server target of your gateway
ctl.create_gateway_target(
    gatewayIdentifier="<GATEWAY_ID>",
    name="duckview",
    description="DuckView DuckDB workspaces, lakehouse catalogs and dashboards",
    targetConfiguration={"mcp": {"mcpServer": {"endpoint": "<MCP_URL>"}}},
    credentialProviderConfigurations=[{
        "credentialProviderType": "API_KEY",
        "credentialProvider": {"apiKeyCredentialProvider": {
            "providerArn": cred["credentialProviderArn"],
            "credentialLocation": "HEADER",
            "credentialParameterName": "Authorization",
            "credentialPrefix": "Bearer ",
        }},
    }],
)
`,
        },
        {
          id: 'gateway_openapi_target',
          label: 'Gateway target → OpenAPI (REST façade)',
          file: 'gateway_openapi.py',
          language: 'python',
          notes: 'Alternative: an OpenAPI target built from the generated schema (download it from this page).',
          code: `import boto3, json

ctl = boto3.client("bedrock-agentcore-control", region_name="<REGION>")
schema = open("duckview-openapi.json").read()  # from <BASE_URL>/api/agent/openapi.json
cred = ctl.create_api_key_credential_provider(name="duckview-token", apiKey="<TOKEN>")
ctl.create_gateway_target(
    gatewayIdentifier="<GATEWAY_ID>",
    name="duckview-rest",
    targetConfiguration={"mcp": {"openApiSchema": {"inlinePayload": schema}}},
    credentialProviderConfigurations=[{
        "credentialProviderType": "API_KEY",
        "credentialProvider": {"apiKeyCredentialProvider": {
            "providerArn": cred["credentialProviderArn"],
            "credentialLocation": "HEADER",
            "credentialParameterName": "Authorization",
            "credentialPrefix": "Bearer ",
        }},
    }],
)
`,
        },
      ];
    case 'bedrock_agent':
      return [
        {
          id: 'bedrock_lambda',
          label: 'Action group Lambda forwarder',
          file: 'lambda_function.py',
          language: 'python',
          notes: 'Create an action group with the OpenAPI schema from this page and this Lambda as executor. Set DUCKVIEW_URL and DUCKVIEW_TOKEN as Lambda environment variables (use Secrets Manager for the token in production).',
          code: `import json, os, urllib.request, urllib.error

DUCKVIEW = os.environ.get("DUCKVIEW_URL", "<BASE_URL>")
TOKEN = os.environ["DUCKVIEW_TOKEN"]

def lambda_handler(event, context):
    tool = event["apiPath"].rsplit("/", 1)[-1]
    body = {}
    content = event.get("requestBody", {}).get("content", {}).get("application/json", {})
    for p in content.get("properties", []):
        body[p["name"]] = _coerce(p.get("value"), p.get("type"))
    for p in event.get("parameters", []):
        body[p["name"]] = _coerce(p.get("value"), p.get("type"))
    req = urllib.request.Request(
        f"{DUCKVIEW}/api/agent/v1/tools/{tool}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status, payload = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        status, payload = e.code, e.read().decode()
    return {
        "messageVersion": "1.0",
        "response": {
            "actionGroup": event["actionGroup"],
            "apiPath": event["apiPath"],
            "httpMethod": event["httpMethod"],
            "httpStatusCode": status,
            "responseBody": {"application/json": {"body": payload}},
        },
    }

def _coerce(v, t):
    if v is None or t is None:
        return v
    if t in ("integer", "number"):
        try:
            return int(v) if t == "integer" else float(v)
        except ValueError:
            return v
    if t == "boolean":
        return str(v).lower() == "true"
    if t in ("object", "array") and isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v
`,
        },
        {
          id: 'bedrock_invoke',
          label: 'Invoke the agent (boto3)',
          file: 'invoke.py',
          language: 'python',
          code: `import boto3, uuid

rt = boto3.client("bedrock-agent-runtime", region_name="<REGION>")
resp = rt.invoke_agent(agentId="<AGENT_ID>", agentAliasId="<AGENT_ALIAS_ID>", sessionId=str(uuid.uuid4()),
                       inputText="How many orders did we ship last week?")
for event in resp["completion"]:
    if "chunk" in event:
        print(event["chunk"]["bytes"].decode(), end="")
`,
        },
      ];
    case 'custom':
      return [
        {
          id: 'curl',
          label: 'REST façade (curl)',
          file: 'terminal',
          language: 'bash',
          code: `# list tools
curl -s <BASE_URL>/api/agent/v1/tools -H "Authorization: Bearer <TOKEN>"

# run a query
curl -s -X POST <BASE_URL>/api/agent/v1/tools/execute_query \\
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \\
  -d '{"sql": "SELECT count(*) AS n FROM '"'"'sales.parquet'"'"'", "workspace_id": "<WORKSPACE_ID>"}'
`,
        },
        {
          id: 'python_requests',
          label: 'Python (requests)',
          file: 'client.py',
          language: 'python',
          code: `import requests

BASE, TOKEN = "<BASE_URL>", "<TOKEN>"
H = {"Authorization": f"Bearer {TOKEN}"}

def tool(name, **args):
    r = requests.post(f"{BASE}/api/agent/v1/tools/{name}", json=args, headers=H, timeout=120)
    r.raise_for_status()
    return r.json()          # {"text": markdown, "structured": {...}, "is_error": bool}

print(tool("list_accessible_data", workspace_id="<WORKSPACE_ID>")["text"])
print(tool("execute_query", sql="SELECT 42 AS answer", workspace_id="<WORKSPACE_ID>")["structured"]["rows"])
`,
        },
        {
          id: 'mcp_json',
          label: 'MCP client config',
          file: 'mcp.json',
          language: 'json',
          code: JSON.stringify({ mcpServers: { duckview: { url: '<MCP_URL>', headers: { Authorization: 'Bearer <TOKEN>' } } } }, null, 2),
        },
      ];
  }
}

export function renderSnippet(code: string, vars: Record<string, string | null | undefined>): string {
  let out = code;
  for (const [k, v] of Object.entries(vars)) if (v) out = out.split(`<${k}>`).join(v);
  return out;
}
