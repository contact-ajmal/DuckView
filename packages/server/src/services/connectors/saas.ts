/**
 * SaaS connectors: each walks the application's objects and pulls records page by page as JSON rows.
 *   - Salesforce : connected app, OAuth 2.0 client-credentials flow; SOQL over the REST API with nextRecordsUrl.
 *   - HubSpot    : private-app token; CRM objects (standard + custom schemas) with `after` paging.
 *   - Stripe     : secret key; list endpoints with starting_after paging.
 *   - GA4        : Google account or service account; Data API runReport (dimensions × metrics × date range).
 *   - Airtable   : personal access token; bases → tables → records with offset paging.
 *   - Notion     : internal integration token; databases via search, rows via query with start_cursor, flattened.
 */
import { getJson, flatten, str, ConnectorError, type Connector, type Session, type BrowseEntry } from './types.js';

const enc = (v: unknown) => encodeURIComponent(str(v));

// --------------------------------------------------------------------------------------------- Salesforce
export const salesforce: Connector = {
  id: 'salesforce',
  label: 'Salesforce',
  remote_sql: false,
  auth: {
    kind: 'fields',
    fields: [
      { key: 'instance_url', label: 'Instance URL', kind: 'url', required: true, placeholder: 'https://myorg.my.salesforce.com', hint: 'Your My Domain URL' },
      { key: 'client_id', label: 'Connected app consumer key', kind: 'text', required: true, hint: 'Setup → App Manager → your connected app → OAuth settings, with the client-credentials flow enabled and a run-as user' },
      { key: 'client_secret', label: 'Consumer secret', kind: 'secret', required: true },
      { key: 'api_version', label: 'API version', kind: 'text', placeholder: 'v60.0' },
    ],
  },
  headers: (c) => ({ authorization: `Bearer ${c.access_token}` }),
  async test(s) {
    const r = await getJson<{ identity?: string }>(s, `${base(s)}/services/data/${ver(s)}/`);
    void r;
    const lim = await getJson<Record<string, { Max: number; Remaining: number }>>(s, `${base(s)}/services/data/${ver(s)}/limits`);
    return { ok: true, message: `Connected · API requests remaining today: ${lim.DailyApiRequests?.Remaining ?? '?'} / ${lim.DailyApiRequests?.Max ?? '?'}` };
  },
  async browse(s) {
    const r = await getJson<{ sobjects: { name: string; label: string; queryable: boolean; custom: boolean }[] }>(s, `${base(s)}/services/data/${ver(s)}/sobjects`);
    return r.sobjects.filter((o) => o.queryable).map((o) => ({ name: o.name, type: o.custom ? 'custom object' : 'object', resource: { object: o.name }, hint: o.label }));
  },
  async *read(s, resource, opts) {
    let soql = str(resource.soql);
    if (!soql) {
      // All queryable fields of the object (compound/address fields skipped — they are not SOQL-selectable as one).
      const d = await getJson<{ fields: { name: string; type: string; compoundFieldName?: string | null }[] }>(s, `${base(s)}/services/data/${ver(s)}/sobjects/${enc(resource.object)}/describe`);
      const fields = d.fields.filter((f) => f.type !== 'address' && f.type !== 'location' && f.type !== 'base64').map((f) => f.name);
      soql = `SELECT ${fields.join(', ')} FROM ${str(resource.object)}${resource.where ? ` WHERE ${str(resource.where)}` : ''}`;
    }
    let url: string | null = `${base(s)}/services/data/${ver(s)}/query?q=${encodeURIComponent(soql)}`;
    let emitted = 0;
    while (url) {
      const r: { records: Record<string, unknown>[]; done: boolean; nextRecordsUrl?: string } = await getJson(s, url);
      const rows = r.records.map((rec) => { const { attributes: _a, ...rest } = rec; return flatten(rest); });
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      if (opts.limit && emitted >= opts.limit) return;
      url = r.done || !r.nextRecordsUrl ? null : `${base(s)}${r.nextRecordsUrl}`;
    }
  },
  describeResource: (r) => (r.soql ? `SOQL: ${str(r.soql).slice(0, 80)}` : `${str(r.object)}${r.where ? ` WHERE ${str(r.where)}` : ''}`),
};
const base = (s: Session) => str(s.config.instance_url).replace(/\/+$/, '');
const ver = (s: Session) => str(s.config.api_version, 'v60.0');
/** Client-credentials token for a connected app (run-as user configured on the app). */
export async function salesforceToken(config: Record<string, unknown>, creds: Record<string, string>): Promise<{ access_token: string; expires_at: number }> {
  const res = await fetch(`${str(config.instance_url).replace(/\/+$/, '')}/services/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: str(config.client_id), client_secret: creds.client_secret ?? '' }).toString() });
  const text = await res.text();
  if (!res.ok) throw new ConnectorError(`Salesforce token → ${res.status}: ${text.slice(0, 300)}`, 401);
  const t = JSON.parse(text) as { access_token: string };
  return { access_token: t.access_token, expires_at: Date.now() + 90 * 60_000 };
}

// --------------------------------------------------------------------------------------------- HubSpot
const HUBSPOT_STANDARD = ['contacts', 'companies', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'calls', 'emails', 'meetings', 'notes', 'tasks'];
export const hubspot: Connector = {
  id: 'hubspot',
  label: 'HubSpot',
  remote_sql: false,
  auth: { kind: 'fields', fields: [{ key: 'token', label: 'Private app access token', kind: 'secret', required: true, hint: 'Settings → Integrations → Private apps; scopes crm.objects.*.read' }] },
  headers: (c) => ({ authorization: `Bearer ${c.token}` }),
  async test(s) {
    const r = await getJson<{ total?: number }>(s, 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1');
    return { ok: true, message: `Connected · contacts reachable${r.total != null ? ` (${r.total})` : ''}` };
  },
  async browse(s) {
    const out: BrowseEntry[] = HUBSPOT_STANDARD.map((o) => ({ name: o, type: 'object', resource: { object: o } }));
    try {
      const r = await getJson<{ results: { name: string; objectTypeId: string; labels?: { plural?: string } }[] }>(s, 'https://api.hubapi.com/crm/v3/schemas');
      for (const c of r.results ?? []) out.push({ name: c.labels?.plural ?? c.name, type: 'custom object', resource: { object: c.objectTypeId }, hint: c.name });
    } catch {
      /* no custom-object scope */
    }
    return out;
  },
  async *read(s, resource, opts) {
    const object = str(resource.object);
    let properties = Array.isArray(resource.properties) ? (resource.properties as string[]) : [];
    if (!properties.length) {
      const p = await getJson<{ results: { name: string }[] }>(s, `https://api.hubapi.com/crm/v3/properties/${enc(object)}`);
      properties = p.results.map((x) => x.name).slice(0, 200);
    }
    let after: string | undefined;
    let emitted = 0;
    do {
      const u = new URL(`https://api.hubapi.com/crm/v3/objects/${enc(object)}`);
      u.searchParams.set('limit', '100');
      u.searchParams.set('properties', properties.join(','));
      if (after) u.searchParams.set('after', after);
      const r = await getJson<{ results: { id: string; properties: Record<string, unknown>; createdAt?: string; updatedAt?: string; archived?: boolean }[]; paging?: { next?: { after: string } } }>(s, u.toString());
      const rows = r.results.map((x) => ({ id: x.id, ...x.properties, createdAt: x.createdAt, updatedAt: x.updatedAt, archived: x.archived }));
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      after = r.paging?.next?.after;
    } while (after && !(opts.limit && emitted >= opts.limit));
  },
  describeResource: (r) => `${str(r.object)}${Array.isArray(r.properties) && r.properties.length ? ` (${(r.properties as string[]).length} properties)` : ''}`,
};

// --------------------------------------------------------------------------------------------- Stripe
const STRIPE_RESOURCES = ['charges', 'customers', 'invoices', 'subscriptions', 'payment_intents', 'balance_transactions', 'refunds', 'payouts', 'products', 'prices', 'disputes', 'checkout/sessions'];
export const stripe: Connector = {
  id: 'stripe',
  label: 'Stripe',
  remote_sql: false,
  auth: { kind: 'fields', fields: [{ key: 'api_key', label: 'Secret key (restricted, read-only recommended)', kind: 'secret', required: true, placeholder: 'rk_live_… or sk_live_…', hint: 'Developers → API keys' }] },
  headers: (c) => ({ authorization: `Bearer ${c.api_key}`, 'stripe-version': '2024-06-20' }),
  async test(s) {
    const r = await getJson<{ settings?: { dashboard?: { display_name?: string } }; id?: string }>(s, 'https://api.stripe.com/v1/account');
    return { ok: true, message: `Connected · ${r.settings?.dashboard?.display_name ?? r.id ?? 'account'}` };
  },
  async browse() {
    return STRIPE_RESOURCES.map((r) => ({ name: r, type: 'resource', resource: { resource: r } }));
  },
  async *read(s, resource, opts) {
    const path = str(resource.resource);
    if (!STRIPE_RESOURCES.includes(path)) throw new ConnectorError(`Unknown Stripe resource "${path}"`, 400);
    let after: string | undefined;
    let emitted = 0;
    do {
      const u = new URL(`https://api.stripe.com/v1/${path}`);
      u.searchParams.set('limit', '100');
      if (after) u.searchParams.set('starting_after', after);
      if (resource.created_gte) u.searchParams.set('created[gte]', str(resource.created_gte));
      const r = await getJson<{ data: Record<string, unknown>[]; has_more: boolean }>(s, u.toString());
      const rows = r.data.map((x) => flatten(x));
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      after = r.has_more && r.data.length ? str(r.data[r.data.length - 1]!.id) : undefined;
    } while (after && !(opts.limit && emitted >= opts.limit));
  },
  describeResource: (r) => `${str(r.resource)}${r.created_gte ? ` since ${str(r.created_gte)}` : ''}`,
};

// --------------------------------------------------------------------------------------------- Google Analytics 4
export const ga4: Connector = {
  id: 'ga4',
  label: 'Google Analytics 4',
  remote_sql: false,
  auth: {
    kind: 'google',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    fields: [
      { key: 'property_id', label: 'Property id', kind: 'text', required: true, placeholder: '123456789', hint: 'Admin → Property settings' },
      { key: 'service_account_key', label: 'Service account key (JSON) — instead of a Google account', kind: 'secret', hint: 'Add the service account as a viewer of the property' },
    ],
  },
  headers: (c) => ({ authorization: `Bearer ${c.access_token}`, 'content-type': 'application/json' }),
  async test(s) {
    const r = await getJson<{ dimensions?: unknown[]; metrics?: unknown[] }>(s, `https://analyticsdata.googleapis.com/v1beta/properties/${enc(s.config.property_id)}/metadata`);
    return { ok: true, message: `Connected · ${r.dimensions?.length ?? 0} dimensions, ${r.metrics?.length ?? 0} metrics available` };
  },
  /** Ready-made reports; any dimensions × metrics combination can be typed into the resource by hand. */
  async browse() {
    const reports: { name: string; dimensions: string[]; metrics: string[] }[] = [
      { name: 'Sessions by day', dimensions: ['date'], metrics: ['sessions', 'activeUsers', 'newUsers', 'screenPageViews'] },
      { name: 'Traffic by source / medium', dimensions: ['date', 'sessionSource', 'sessionMedium'], metrics: ['sessions', 'activeUsers', 'conversions'] },
      { name: 'Pages', dimensions: ['date', 'pagePath'], metrics: ['screenPageViews', 'activeUsers', 'averageSessionDuration'] },
      { name: 'Countries & devices', dimensions: ['date', 'country', 'deviceCategory'], metrics: ['sessions', 'activeUsers'] },
      { name: 'Events', dimensions: ['date', 'eventName'], metrics: ['eventCount', 'activeUsers'] },
    ];
    return reports.map((r) => ({ name: r.name, type: 'report', resource: { dimensions: r.dimensions, metrics: r.metrics, start_date: '30daysAgo', end_date: 'today' }, hint: `${r.dimensions.join(', ')} × ${r.metrics.join(', ')}` }));
  },
  async *read(s, resource, opts) {
    const dimensions = (resource.dimensions as string[] | undefined) ?? ['date'];
    const metrics = (resource.metrics as string[] | undefined) ?? ['sessions'];
    let offset = 0;
    let emitted = 0;
    for (;;) {
      const r = await getJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[]; rowCount?: number }>(s, `https://analyticsdata.googleapis.com/v1beta/properties/${enc(s.config.property_id)}:runReport`, { method: 'POST', body: JSON.stringify({ dateRanges: [{ startDate: str(resource.start_date, '30daysAgo'), endDate: str(resource.end_date, 'today') }], dimensions: dimensions.map((name) => ({ name })), metrics: metrics.map((name) => ({ name })), limit: 10_000, offset }) });
      const rows = (r.rows ?? []).map((row) => ({ ...Object.fromEntries(dimensions.map((d, i) => [d, row.dimensionValues[i]?.value])), ...Object.fromEntries(metrics.map((m, i) => [m, Number(row.metricValues[i]?.value)])) }));
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      offset += rows.length;
      if (!rows.length || rows.length < 10_000 || (r.rowCount != null && offset >= r.rowCount) || (opts.limit && emitted >= opts.limit)) return;
    }
  },
  describeResource: (r) => `${((r.dimensions as string[]) ?? []).join(', ')} × ${((r.metrics as string[]) ?? []).join(', ')} · ${str(r.start_date, '30daysAgo')} → ${str(r.end_date, 'today')}`,
};

// --------------------------------------------------------------------------------------------- Airtable
export const airtable: Connector = {
  id: 'airtable',
  label: 'Airtable',
  remote_sql: false,
  auth: { kind: 'fields', fields: [{ key: 'token', label: 'Personal access token', kind: 'secret', required: true, hint: 'airtable.com/create/tokens with scopes data.records:read and schema.bases:read' }] },
  headers: (c) => ({ authorization: `Bearer ${c.token}` }),
  async test(s) {
    const r = await getJson<{ bases: unknown[] }>(s, 'https://api.airtable.com/v0/meta/bases');
    return { ok: true, message: `Connected · ${r.bases.length} base${r.bases.length === 1 ? '' : 's'}` };
  },
  async browse(s, path) {
    if (path.length === 0) {
      const r = await getJson<{ bases: { id: string; name: string }[] }>(s, 'https://api.airtable.com/v0/meta/bases');
      return r.bases.map((b) => ({ name: b.name, type: 'base', path: [b.id], hint: b.id }));
    }
    const r = await getJson<{ tables: { id: string; name: string; fields: unknown[] }[] }>(s, `https://api.airtable.com/v0/meta/bases/${enc(path[0])}/tables`);
    return r.tables.map((t) => ({ name: t.name, type: 'table', resource: { base: path[0], table: t.id, table_name: t.name }, hint: `${t.fields.length} fields` }));
  },
  async *read(s, resource, opts) {
    let offset: string | undefined;
    let emitted = 0;
    do {
      const u = new URL(`https://api.airtable.com/v0/${enc(resource.base)}/${enc(resource.table)}`);
      u.searchParams.set('pageSize', '100');
      if (offset) u.searchParams.set('offset', offset);
      if (resource.view) u.searchParams.set('view', str(resource.view));
      const r = await getJson<{ records: { id: string; createdTime: string; fields: Record<string, unknown> }[]; offset?: string }>(s, u.toString());
      const rows = r.records.map((x) => ({ id: x.id, createdTime: x.createdTime, ...x.fields }));
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      offset = r.offset;
    } while (offset && !(opts.limit && emitted >= opts.limit));
  },
  describeResource: (r) => `${str(r.table_name ?? r.table)}${r.view ? ` (view ${str(r.view)})` : ''}`,
};

// --------------------------------------------------------------------------------------------- Notion
export const notion: Connector = {
  id: 'notion',
  label: 'Notion',
  remote_sql: false,
  auth: { kind: 'fields', fields: [{ key: 'token', label: 'Internal integration secret', kind: 'secret', required: true, placeholder: 'ntn_… / secret_…', hint: 'notion.so/my-integrations; share each database with the integration' }] },
  headers: (c) => ({ authorization: `Bearer ${c.token}`, 'notion-version': '2022-06-28', 'content-type': 'application/json' }),
  async test(s) {
    const r = await getJson<{ name?: string; bot?: { owner?: { type?: string } } }>(s, 'https://api.notion.com/v1/users/me');
    return { ok: true, message: `Connected · integration ${r.name ?? ''}` };
  },
  async browse(s) {
    const r = await getJson<{ results: { id: string; title?: { plain_text: string }[] }[] }>(s, 'https://api.notion.com/v1/search', { method: 'POST', body: JSON.stringify({ filter: { property: 'object', value: 'database' }, page_size: 100 }) });
    return r.results.map((d) => ({ name: d.title?.map((t) => t.plain_text).join('') || d.id, type: 'database', resource: { database_id: d.id, name: d.title?.map((t) => t.plain_text).join('') }, hint: d.id }));
  },
  async *read(s, resource, opts) {
    let cursor: string | undefined;
    let emitted = 0;
    do {
      const r = await getJson<{ results: { id: string; created_time: string; last_edited_time: string; url: string; properties: Record<string, NotionProp> }[]; next_cursor?: string | null; has_more: boolean }>(s, `https://api.notion.com/v1/databases/${enc(resource.database_id)}/query`, { method: 'POST', body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }) });
      const rows = r.results.map((p) => ({ id: p.id, created_time: p.created_time, last_edited_time: p.last_edited_time, url: p.url, ...Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, notionValue(v)])) }));
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      cursor = r.has_more ? r.next_cursor ?? undefined : undefined;
    } while (cursor && !(opts.limit && emitted >= opts.limit));
  },
  describeResource: (r) => str(r.name ?? r.database_id),
};
type NotionProp = { type: string } & Record<string, unknown>;
/** Notion property → plain value. */
export function notionValue(p: NotionProp): unknown {
  const v = p[p.type];
  switch (p.type) {
    case 'title': case 'rich_text': return Array.isArray(v) ? (v as { plain_text: string }[]).map((t) => t.plain_text).join('') : null;
    case 'number': case 'checkbox': case 'url': case 'email': case 'phone_number': case 'created_time': case 'last_edited_time': return v ?? null;
    case 'select': case 'status': return (v as { name?: string } | null)?.name ?? null;
    case 'multi_select': return Array.isArray(v) ? (v as { name: string }[]).map((x) => x.name) : null;
    case 'date': return (v as { start?: string } | null)?.start ?? null;
    case 'people': return Array.isArray(v) ? (v as { name?: string; id: string }[]).map((x) => x.name ?? x.id) : null;
    case 'relation': return Array.isArray(v) ? (v as { id: string }[]).map((x) => x.id) : null;
    case 'formula': case 'rollup': { const inner = v as { type: string } & Record<string, unknown>; return inner && typeof inner === 'object' ? (inner[inner.type] as unknown) ?? null : null; }
    default: return v == null ? null : typeof v === 'object' ? JSON.stringify(v) : v;
  }
}
