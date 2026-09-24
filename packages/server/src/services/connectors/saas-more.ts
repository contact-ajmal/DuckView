/**
 * More SaaS connectors, each pulling records page by page as JSON rows:
 *   - GitHub    : personal access token (GitHub Enterprise too); repositories → issues, pull requests, commits,
 *                 releases, workflow runs, contributors; Link-header paging.
 *   - Jira      : Atlassian account email + API token; projects → issues through JQL (enhanced search, token paging),
 *                 fields named as in Jira (custom fields included), people/options flattened to their names.
 *   - Zendesk   : agent email + API token; tickets, users, organizations, groups, satisfaction ratings; cursor paging.
 *   - Shopify   : Admin API access token; orders, customers, products, draft orders, collections, locations;
 *                 Link-header page_info paging.
 *   - Intercom  : access token (US, EU or AU workspace); contacts, conversations, companies, admins, tags, teams.
 *   - Linear    : personal API key; issues, projects, cycles, teams, users over GraphQL with cursors.
 *   - Pipedrive : API token; deals, persons, organizations, activities, leads, products, pipelines, stages, users,
 *                 custom fields renamed from their hash keys to their names.
 *   - Mailchimp : API key (its data-center suffix picks the host); audiences → members, campaigns, reports.
 */
import { getJson, flatten, str, ConnectorError, type Connector, type Session, type BrowseEntry, type ReadOptions } from './types.js';

const enc = (v: unknown) => encodeURIComponent(str(v));
const trim = (u: string) => u.replace(/\/+$/, '');
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** The rel="next" URL of an RFC 8288 Link header. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

/** Follows Link-header pages, yielding the rows `pick` finds in each body. */
async function* linkPages(s: Session, first: string, pick: (body: unknown) => Record<string, unknown>[], opts: ReadOptions): AsyncIterable<Record<string, unknown>[]> {
  let url: string | null = first;
  let emitted = 0;
  while (url) {
    const res = await s.fetch(url);
    const text = await res.text();
    if (!res.ok) throw new ConnectorError(`GET ${new URL(url).pathname} → ${res.status}: ${text.slice(0, 300) || res.statusText}`, res.status);
    const rows = pick(text ? JSON.parse(text) : []);
    yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
    emitted += rows.length;
    if (opts.limit && emitted >= opts.limit) return;
    url = nextLink(res.headers.get('link'));
  }
}

/** A person, option or other small object as the value a column should hold. */
function nameOf(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(nameOf);
  const o = v as Record<string, unknown>;
  return o.displayName ?? o.name ?? o.value ?? o.key ?? o.login ?? o.emailAddress ?? (o.id !== undefined && Object.keys(o).length <= 3 ? o.id : JSON.stringify(o));
}

/** Plain text of an Atlassian Document Format value. */
export function adfText(v: unknown): string {
  if (!v || typeof v !== 'object') return typeof v === 'string' ? v : '';
  const n = v as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  // Blocks (paragraphs, headings, list items) go on their own lines; inline content runs together.
  return (n.content ?? []).map(adfText).join(n.type === 'doc' || n.type === 'bulletList' || n.type === 'orderedList' ? '\n' : '');
}

// --------------------------------------------------------------------------------------------- GitHub
const GITHUB_RESOURCES = ['issues', 'pulls', 'commits', 'releases', 'workflow_runs', 'contributors'] as const;
const gh = (s: Session) => trim(str(s.config.api_url) || 'https://api.github.com');
export const github: Connector = {
  id: 'github',
  label: 'GitHub',
  remote_sql: false,
  auth: {
    kind: 'fields',
    fields: [
      { key: 'token', label: 'Personal access token', kind: 'secret', required: true, placeholder: 'github_pat_…', hint: 'Settings → Developer settings → Fine-grained tokens, read-only access to the repositories' },
      { key: 'api_url', label: 'API URL (GitHub Enterprise)', kind: 'url', placeholder: 'https://api.github.com' },
    ],
  },
  headers: (c) => ({ authorization: `Bearer ${c.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }),
  async test(s) {
    const me = await getJson<{ login: string }>(s, `${gh(s)}/user`);
    return { ok: true, message: `Connected as ${me.login}` };
  },
  async browse(s, path) {
    if (!path.length) {
      const repos = await getJson<{ full_name: string; private: boolean; description: string | null }[]>(s, `${gh(s)}/user/repos?per_page=100&sort=updated`);
      return repos.map((r) => ({ name: r.full_name, type: r.private ? 'private repository' : 'repository', path: [r.full_name], hint: r.description ?? undefined }));
    }
    return GITHUB_RESOURCES.map((r) => ({ name: r.replace('_', ' '), type: 'resource', resource: { repo: path[0], resource: r } }));
  },
  read(s, resource, opts) {
    const repo = str(resource.repo);
    const what = str(resource.resource) as (typeof GITHUB_RESOURCES)[number];
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ConnectorError('repo must be owner/name', 400);
    if (!GITHUB_RESOURCES.includes(what)) throw new ConnectorError(`Unknown GitHub resource "${what}"`, 400);
    const u = new URL(`${gh(s)}/repos/${repo}/${what === 'workflow_runs' ? 'actions/runs' : what}`);
    u.searchParams.set('per_page', '100');
    if (what === 'issues' || what === 'pulls') u.searchParams.set('state', 'all');
    if (resource.since && (what === 'issues' || what === 'commits')) u.searchParams.set('since', str(resource.since));
    return linkPages(s, u.toString(), (body) => {
      let rows = (what === 'workflow_runs' ? (body as { workflow_runs: Record<string, unknown>[] }).workflow_runs : (body as Record<string, unknown>[])) ?? [];
      // The issues endpoint also lists pull requests; they have their own resource.
      if (what === 'issues') rows = rows.filter((r) => !r.pull_request);
      return rows.map((r) => {
        const row = flatten(r, what === 'commits' ? 2 : 1);
        for (const k of Object.keys(row)) if (/_url$|^url$|\.url$|_urls?\./.test(k) && k !== 'html_url') delete row[k];
        if (Array.isArray(r.labels)) row.labels = (r.labels as { name: string }[]).map((l) => l.name);
        if (Array.isArray(r.assignees)) row.assignees = (r.assignees as { login: string }[]).map((a) => a.login);
        return row;
      });
    }, opts);
  },
  describeResource: (r) => `${str(r.repo)} · ${str(r.resource).replace('_', ' ')}`,
};

// --------------------------------------------------------------------------------------------- Jira
const jira = (s: Session) => trim(str(s.config.site_url));
export const jiraCloud: Connector = {
  id: 'jira',
  label: 'Jira',
  remote_sql: false,
  auth: {
    kind: 'fields',
    fields: [
      { key: 'site_url', label: 'Site URL', kind: 'url', required: true, placeholder: 'https://acme.atlassian.net' },
      { key: 'email', label: 'Atlassian account email', kind: 'text', required: true },
      { key: 'api_token', label: 'API token', kind: 'secret', required: true, hint: 'id.atlassian.com → Security → API tokens' },
    ],
  },
  headers: (c, cfg) => ({ authorization: basic(str(cfg.email), c.api_token ?? ''), accept: 'application/json' }),
  async test(s) {
    const me = await getJson<{ displayName: string }>(s, `${jira(s)}/rest/api/3/myself`);
    return { ok: true, message: `Connected as ${me.displayName}` };
  },
  async browse(s) {
    const out: BrowseEntry[] = [];
    let startAt = 0;
    for (let i = 0; i < 20; i++) {
      const r = await getJson<{ values: { key: string; name: string }[]; isLast: boolean }>(s, `${jira(s)}/rest/api/3/project/search?maxResults=100&startAt=${startAt}`);
      out.push(...r.values.map((p) => ({ name: `${p.key} · ${p.name}`, type: 'project', resource: { project: p.key } })));
      if (r.isLast || !r.values.length) break;
      startAt += r.values.length;
    }
    return out;
  },
  async *read(s, resource, opts) {
    const jql = str(resource.jql) || `project = "${str(resource.project).replace(/"/g, '')}" ORDER BY created ASC`;
    // Column names from Jira's own field names (custom fields too), where they are unique.
    const fields = await getJson<{ id: string; name: string }[]>(s, `${jira(s)}/rest/api/3/field`);
    const counts = new Map<string, number>();
    for (const f of fields) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
    const label = new Map(fields.map((f) => [f.id, counts.get(f.name) === 1 && !['id', 'key'].includes(f.name.toLowerCase()) ? f.name : f.id]));
    let token: string | undefined;
    let emitted = 0;
    do {
      const r = await getJson<{ issues: { id: string; key: string; fields: Record<string, unknown> }[]; nextPageToken?: string; isLast?: boolean }>(s, `${jira(s)}/rest/api/3/search/jql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jql, fields: ['*navigable'], maxResults: 100, ...(token ? { nextPageToken: token } : {}) }) });
      const rows = r.issues.map((i) => {
        const row: Record<string, unknown> = { id: i.id, key: i.key };
        for (const [k, v] of Object.entries(i.fields)) {
          if (v === null || v === undefined) continue;
          row[label.get(k) ?? k] = k === 'description' || (typeof v === 'object' && (v as { type?: string }).type === 'doc') ? adfText(v) : nameOf(v);
        }
        return row;
      });
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      token = r.isLast ? undefined : r.nextPageToken;
    } while (token && !(opts.limit && emitted >= opts.limit));
  },
  describeResource: (r) => (r.jql ? `JQL: ${str(r.jql).slice(0, 80)}` : `issues of ${str(r.project)}`),
};

// --------------------------------------------------------------------------------------------- Zendesk
const ZENDESK_RESOURCES = ['tickets', 'users', 'organizations', 'groups', 'satisfaction_ratings', 'ticket_fields'];
const zd = (s: Session) => `https://${str(s.config.subdomain).replace(/\.zendesk\.com.*$/, '')}.zendesk.com`;
export const zendesk: Connector = {
  id: 'zendesk',
  label: 'Zendesk',
  remote_sql: false,
  auth: {
    kind: 'fields',
    fields: [
      { key: 'subdomain', label: 'Subdomain', kind: 'text', required: true, placeholder: 'acme', hint: 'acme for acme.zendesk.com' },
      { key: 'email', label: 'Agent email', kind: 'text', required: true },
      { key: 'api_token', label: 'API token', kind: 'secret', required: true, hint: 'Admin Center → Apps and integrations → Zendesk API' },
    ],
  },
  headers: (c, cfg) => ({ authorization: basic(`${str(cfg.email)}/token`, c.api_token ?? ''), accept: 'application/json' }),
  async test(s) {
    const me = await getJson<{ user: { name: string; role: string } }>(s, `${zd(s)}/api/v2/users/me.json`);
    if (me.user.role === 'end-user') throw new ConnectorError('Those credentials belong to an end user; use an agent or admin', 401);
    return { ok: true, message: `Connected as ${me.user.name} (${me.user.role})` };
  },
  async browse() {
    return ZENDESK_RESOURCES.map((r) => ({ name: r.replace('_', ' '), type: 'resource', resource: { resource: r } }));
  },
  async *read(s, resource, opts) {
    const what = str(resource.resource);
    if (!ZENDESK_RESOURCES.includes(what)) throw new ConnectorError(`Unknown Zendesk resource "${what}"`, 400);
    let url: string | null = `${zd(s)}/api/v2/${what}.json?page[size]=100`;
    let emitted = 0;
    while (url) {
      const r: Record<string, unknown> & { meta?: { has_more?: boolean }; links?: { next?: string | null } } = await getJson(s, url);
      const rows = ((r[what] as Record<string, unknown>[]) ?? []).map((x) => flatten(x));
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      if (opts.limit && emitted >= opts.limit) return;
      url = r.meta?.has_more && r.links?.next ? r.links.next : null;
    }
  },
  describeResource: (r) => str(r.resource).replace('_', ' '),
};

// --------------------------------------------------------------------------------------------- Shopify
const SHOPIFY_RESOURCES = ['orders', 'customers', 'products', 'draft_orders', 'custom_collections', 'smart_collections', 'locations'];
const SHOPIFY_VERSION = '2025-01';
const shop = (s: Session) => `https://${str(s.config.shop).replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/admin/api/${SHOPIFY_VERSION}`;
export const shopify: Connector = {
  id: 'shopify',
  label: 'Shopify',
  remote_sql: false,
  auth: {
    kind: 'fields',
    fields: [
      { key: 'shop', label: 'Shop domain', kind: 'text', required: true, placeholder: 'acme.myshopify.com' },
      { key: 'access_token', label: 'Admin API access token', kind: 'secret', required: true, placeholder: 'shpat_…', hint: 'Settings → Apps → Develop apps → your app, with read_orders, read_customers and read_products' },
    ],
  },
  headers: (c) => ({ 'x-shopify-access-token': c.access_token ?? '', accept: 'application/json' }),
  async test(s) {
    const r = await getJson<{ shop: { name: string; currency: string } }>(s, `${shop(s)}/shop.json`);
    return { ok: true, message: `Connected · ${r.shop.name} (${r.shop.currency})` };
  },
  async browse() {
    return SHOPIFY_RESOURCES.map((r) => ({ name: r.replace('_', ' '), type: 'resource', resource: { resource: r } }));
  },
  read(s, resource, opts) {
    const what = str(resource.resource);
    if (!SHOPIFY_RESOURCES.includes(what)) throw new ConnectorError(`Unknown Shopify resource "${what}"`, 400);
    const u = new URL(`${shop(s)}/${what}.json`);
    u.searchParams.set('limit', '250');
    if (what === 'orders' || what === 'draft_orders') u.searchParams.set('status', 'any');
    if (resource.updated_at_min) u.searchParams.set('updated_at_min', str(resource.updated_at_min));
    return linkPages(s, u.toString(), (body) => ((body as Record<string, Record<string, unknown>[]>)[what] ?? []).map((x) => flatten(x)), opts);
  },
  describeResource: (r) => `${str(r.resource).replace('_', ' ')}${r.updated_at_min ? ` updated since ${str(r.updated_at_min)}` : ''}`,
};

// --------------------------------------------------------------------------------------------- Intercom
const INTERCOM_RESOURCES = ['contacts', 'conversations', 'companies', 'admins', 'tags', 'teams'];
const ic = (s: Session) => ({ eu: 'https://api.eu.intercom.io', au: 'https://api.au.intercom.io' })[str(s.config.region) as 'eu' | 'au'] ?? 'https://api.intercom.io';
export const intercom: Connector = {
  id: 'intercom',
  label: 'Intercom',
  remote_sql: false,
  auth: {
    kind: 'fields',
    fields: [
      { key: 'access_token', label: 'Access token', kind: 'secret', required: true, hint: 'Developer Hub → your app → Authentication' },
      { key: 'region', label: 'Region (us, eu or au)', kind: 'text', placeholder: 'us' },
    ],
  },
  headers: (c) => ({ authorization: `Bearer ${c.access_token}`, accept: 'application/json', 'intercom-version': '2.11' }),
  async test(s) {
    const me = await getJson<{ name?: string; app?: { name?: string } }>(s, `${ic(s)}/me`);
    return { ok: true, message: `Connected · ${me.app?.name ?? me.name ?? 'workspace'}` };
  },
  async browse() {
    return INTERCOM_RESOURCES.map((r) => ({ name: r, type: 'resource', resource: { resource: r } }));
  },
  async *read(s, resource, opts) {
    const what = str(resource.resource);
    if (!INTERCOM_RESOURCES.includes(what)) throw new ConnectorError(`Unknown Intercom resource "${what}"`, 400);
    let emitted = 0;
    const emit = (rows: Record<string, unknown>[]) => {
      const out = opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      return out;
    };
    const tidy = (x: Record<string, unknown>) => {
      const row = flatten(x);
      for (const k of Object.keys(row)) if (/\.(url|type)$/.test(k)) delete row[k];
      return row;
    };
    if (what === 'admins' || what === 'tags' || what === 'teams') {
      const r = await getJson<Record<string, Record<string, unknown>[]>>(s, `${ic(s)}/${what}`);
      yield emit((r[what] ?? r.data ?? []).map(tidy));
      return;
    }
    if (what === 'companies') {
      for (let page = 1; ; page++) {
        const r = await getJson<{ data: Record<string, unknown>[]; pages?: { total_pages?: number } }>(s, `${ic(s)}/companies?per_page=60&page=${page}`);
        yield emit(r.data.map(tidy));
        if (page >= (r.pages?.total_pages ?? 1) || (opts.limit && emitted >= opts.limit)) return;
      }
    }
    let after: string | undefined;
    do {
      const u = new URL(`${ic(s)}/${what}`);
      u.searchParams.set('per_page', '150');
      if (after) u.searchParams.set('starting_after', after);
      const r = await getJson<{ data?: Record<string, unknown>[]; conversations?: Record<string, unknown>[]; pages?: { next?: { starting_after?: string } } }>(s, u.toString());
      yield emit((r.data ?? r.conversations ?? []).map(tidy));
      after = r.pages?.next?.starting_after;
    } while (after && !(opts.limit && emitted >= opts.limit));
  },
  describeResource: (r) => str(r.resource),
};

// --------------------------------------------------------------------------------------------- Linear
const LINEAR_QUERIES: Record<string, string> = {
  issues: 'identifier title description priority priorityLabel estimate createdAt updatedAt completedAt canceledAt dueDate url state { name type } assignee { name } creator { name } team { key } project { name } cycle { number } labels { nodes { name } }',
  projects: 'name description state progress startDate targetDate createdAt updatedAt completedAt lead { name } teams { nodes { key } }',
  cycles: 'number name startsAt endsAt completedAt progress team { key }',
  teams: 'key name description createdAt',
  users: 'name displayName email active admin createdAt',
};
export const linear: Connector = {
  id: 'linear',
  label: 'Linear',
  remote_sql: false,
  auth: { kind: 'fields', fields: [{ key: 'api_key', label: 'Personal API key', kind: 'secret', required: true, placeholder: 'lin_api_…', hint: 'Settings → Security & access → Personal API keys' }] },
  headers: (c) => ({ authorization: c.api_key ?? '', 'content-type': 'application/json' }),
  async test(s) {
    const r = await linearQuery<{ viewer: { name: string }; organization: { name: string } }>(s, '{ viewer { name } organization { name } }');
    return { ok: true, message: `Connected as ${r.viewer.name} · ${r.organization.name}` };
  },
  async browse() {
    return Object.keys(LINEAR_QUERIES).map((r) => ({ name: r, type: 'resource', resource: { resource: r } }));
  },
  async *read(s, resource, opts) {
    const what = str(resource.resource);
    const fields = LINEAR_QUERIES[what];
    if (!fields) throw new ConnectorError(`Unknown Linear resource "${what}"`, 400);
    let after: string | null = null;
    let emitted = 0;
    do {
      const r: Record<string, { nodes: Record<string, unknown>[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }> = await linearQuery(s, `query($after: String) { ${what}(first: 100, after: $after) { nodes { id ${fields} } pageInfo { hasNextPage endCursor } } }`, { after });
      const page = r[what]!;
      const rows = page.nodes.map((n) => {
        const row: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(n)) {
          if (v && typeof v === 'object' && Array.isArray((v as { nodes?: unknown[] }).nodes)) row[k] = ((v as { nodes: Record<string, unknown>[] }).nodes).map((x) => x.name ?? x.key);
          else if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) row[`${k}.${k2}`] = v2;
          else row[k] = v;
        }
        return row;
      });
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after && !(opts.limit && emitted >= opts.limit));
  },
  describeResource: (r) => str(r.resource),
};
async function linearQuery<T>(s: Session, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await getJson<{ data?: T; errors?: { message: string }[] }>(s, 'https://api.linear.app/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (r.errors?.length) throw new ConnectorError(`Linear: ${r.errors.map((e) => e.message).join('; ')}`, 400);
  return r.data as T;
}

// --------------------------------------------------------------------------------------------- Pipedrive
const PIPEDRIVE_RESOURCES = ['deals', 'persons', 'organizations', 'activities', 'leads', 'products', 'pipelines', 'stages', 'users'];
const PIPEDRIVE_FIELDS: Record<string, string> = { deals: 'dealFields', persons: 'personFields', organizations: 'organizationFields', activities: 'activityFields', products: 'productFields' };
const pd = (s: Session) => `https://${str(s.config.company_domain).replace(/\.pipedrive\.com.*$/, '').replace(/^https?:\/\//, '')}.pipedrive.com/api/v1`;
export const pipedrive: Connector = {
  id: 'pipedrive',
  label: 'Pipedrive',
  remote_sql: false,
  auth: {
    kind: 'fields',
    fields: [
      { key: 'company_domain', label: 'Company domain', kind: 'text', required: true, placeholder: 'acme', hint: 'acme for acme.pipedrive.com' },
      { key: 'api_token', label: 'API token', kind: 'secret', required: true, hint: 'Personal preferences → API' },
    ],
  },
  headers: (c) => ({ 'x-api-token': c.api_token ?? '', accept: 'application/json' }),
  async test(s) {
    const me = await getJson<{ data: { name: string; company_name?: string } }>(s, `${pd(s)}/users/me`);
    return { ok: true, message: `Connected as ${me.data.name}${me.data.company_name ? ` · ${me.data.company_name}` : ''}` };
  },
  async browse() {
    return PIPEDRIVE_RESOURCES.map((r) => ({ name: r, type: 'resource', resource: { resource: r } }));
  },
  async *read(s, resource, opts) {
    const what = str(resource.resource);
    if (!PIPEDRIVE_RESOURCES.includes(what)) throw new ConnectorError(`Unknown Pipedrive resource "${what}"`, 400);
    // Custom fields come back under 40-character hash keys; give them their names.
    const names = new Map<string, string>();
    if (PIPEDRIVE_FIELDS[what]) {
      const f = await getJson<{ data: { key: string; name: string }[] | null }>(s, `${pd(s)}/${PIPEDRIVE_FIELDS[what]}?limit=500`);
      for (const x of f.data ?? []) if (/^[0-9a-f]{40}$/.test(x.key)) names.set(x.key, x.name);
    }
    let start = 0;
    let emitted = 0;
    for (;;) {
      const r = await getJson<{ data: Record<string, unknown>[] | null; additional_data?: { pagination?: { more_items_in_collection?: boolean; next_start?: number } } }>(s, `${pd(s)}/${what}?start=${start}&limit=500`);
      const rows = (r.data ?? []).map((x) => {
        const row: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(x)) row[names.get(k) ?? k] = v && typeof v === 'object' && !Array.isArray(v) ? nameOf(v) : v;
        return row;
      });
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      const p = r.additional_data?.pagination;
      if (!p?.more_items_in_collection || (opts.limit && emitted >= opts.limit)) return;
      start = p.next_start ?? start + rows.length;
    }
  },
  describeResource: (r) => str(r.resource),
};

// --------------------------------------------------------------------------------------------- Mailchimp
const mc = (s: Session) => {
  const dc = /-(\w+)$/.exec(s.credentials.api_key ?? '')?.[1];
  if (!dc) throw new ConnectorError('A Mailchimp API key ends with its data center, like …-us21', 400);
  return `https://${dc}.api.mailchimp.com/3.0`;
};
export const mailchimp: Connector = {
  id: 'mailchimp',
  label: 'Mailchimp',
  remote_sql: false,
  auth: { kind: 'fields', fields: [{ key: 'api_key', label: 'API key', kind: 'secret', required: true, placeholder: '…-us21', hint: 'Profile → Extras → API keys' }] },
  headers: (c) => ({ authorization: basic('duckview', c.api_key ?? ''), accept: 'application/json' }),
  async test(s) {
    const r = await getJson<{ account_name: string }>(s, `${mc(s)}/`);
    return { ok: true, message: `Connected · ${r.account_name}` };
  },
  async browse(s) {
    const lists = await getJson<{ lists: { id: string; name: string; stats?: { member_count?: number } }[] }>(s, `${mc(s)}/lists?count=1000&fields=lists.id,lists.name,lists.stats.member_count`);
    return [
      ...lists.lists.map((l) => ({ name: `${l.name} · members`, type: 'audience', resource: { resource: 'members', list_id: l.id, name: l.name }, hint: l.stats?.member_count != null ? `${l.stats.member_count} members` : undefined })),
      { name: 'campaigns', type: 'resource', resource: { resource: 'campaigns' } },
      { name: 'campaign reports', type: 'resource', resource: { resource: 'reports' } },
      { name: 'audiences', type: 'resource', resource: { resource: 'lists' } },
    ];
  },
  async *read(s, resource, opts) {
    const what = str(resource.resource);
    const path = what === 'members' ? `lists/${enc(resource.list_id)}/members` : ['campaigns', 'reports', 'lists'].includes(what) ? what : null;
    if (!path) throw new ConnectorError(`Unknown Mailchimp resource "${what}"`, 400);
    let offset = 0;
    let emitted = 0;
    for (;;) {
      const r = await getJson<Record<string, unknown> & { total_items?: number }>(s, `${mc(s)}/${path}?count=1000&offset=${offset}`);
      const items = (r[what] as Record<string, unknown>[]) ?? [];
      const rows = items.map((x) => {
        const { _links: _l, ...rest } = x;
        return flatten(rest);
      });
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      offset += items.length;
      if (!items.length || offset >= (r.total_items ?? 0) || (opts.limit && emitted >= opts.limit)) return;
    }
  },
  describeResource: (r) => (str(r.resource) === 'members' ? `members of ${str(r.name) || str(r.list_id)}` : str(r.resource)),
};
