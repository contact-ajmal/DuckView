/**
 * Finds personal data in a workspace's tables: columns whose names say so (email, phone, date of birth…) and
 * columns whose values look like it (email addresses, phone numbers, card numbers passing the Luhn check, IBANs
 * passing mod-97, IP addresses, US social security and UK national insurance numbers). Findings can be tagged in
 * the catalog (pii, pii:<kind>) and protected with an access policy that masks them for everyone but the owners.
 *
 * Only a sample of each table is read (the first rows of each column); nothing leaves the server, and the examples
 * returned are masked.
 */
import type { AppContext } from '../context.js';
import type { Principal } from './principal.js';
import type { ColumnMask, MaskKind } from '../db/schema/sqlite.js';
import { badRequest } from './errors.js';

export type PiiKind = 'email' | 'phone' | 'card' | 'iban' | 'national_id' | 'ip' | 'birth_date' | 'address' | 'person_name';
export interface PiiFinding {
  object: string;
  column: string;
  type: string;
  kind: PiiKind;
  /** high: the name and the values agree, or the values alone are unmistakable; medium: one signal. */
  confidence: 'high' | 'medium';
  evidence: 'name' | 'values' | 'both';
  /** Share of sampled, non-empty values that match. */
  match_rate: number | null;
  examples: string[];
  suggested_mask: Exclude<MaskKind, 'expression'>;
  tagged: boolean;
}

export const PII_LABEL: Record<PiiKind, string> = { email: 'email address', phone: 'phone number', card: 'payment card number', iban: 'bank account (IBAN)', national_id: 'national ID', ip: 'IP address', birth_date: 'date of birth', address: 'postal address', person_name: "person's name" };
const MASK_FOR: Record<PiiKind, Exclude<MaskKind, 'expression'>> = { email: 'partial', phone: 'partial', card: 'partial', iban: 'partial', national_id: 'redact', ip: 'hash', birth_date: 'null', address: 'redact', person_name: 'hash' };

const NAME_HINTS: [PiiKind, RegExp][] = [
  ['email', /(^|_)(e_?mail|mail)(_|$)|email/i],
  ['phone', /(^|_)(phone|mobile|tel|telephone|cell|msisdn)(_|$)/i],
  ['card', /(^|_)(card_?(number|no|num)?|cc_?(num|number)|pan)(_|$)/i],
  ['iban', /(^|_)(iban|account_?number|bank_?account)(_|$)/i],
  ['national_id', /(^|_)(ssn|social_?security|national_?id|nino|ni_?number|passport(_?(no|number))?|tax_?id|tin)(_|$)/i],
  ['ip', /(^|_)(ip|ip_?address|ipv4|ipv6|client_?ip|remote_?addr)(_|$)/i],
  ['birth_date', /(^|_)(dob|date_?of_?birth|birth_?(date|day)|birthday)(_|$)/i],
  ['address', /(^|_)(address|street|addr(ess)?_?line\d?|post_?code|postal_?code|zip(_?code)?)(_|$)/i],
  ['person_name', /(^|_)(first_?name|last_?name|full_?name|surname|forename|given_?name|family_?name|customer_?name|contact_?name)(_|$)/i],
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
function ibanOk(v: string): boolean {
  const s = v.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}
const VALUE_TESTS: [PiiKind, (v: string) => boolean][] = [
  ['email', (v) => /^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,24}$/i.test(v)],
  ['card', (v) => { const d = v.replace(/[\s-]/g, ''); return /^\d{13,19}$/.test(d) && /^[\d\s-]+$/.test(v) && luhn(d); }],
  ['iban', ibanOk],
  ['national_id', (v) => /^\d{3}-\d{2}-\d{4}$/.test(v) || /^[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]$/i.test(v)],
  ['ip', (v) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v) || (/^[0-9a-f:]+$/i.test(v) && v.includes('::') && v.length >= 6)],
  ['phone', (v) => /^(\+|00)\d[\d\s().-]{6,18}\d$/.test(v) || /^\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}$/.test(v) || /^0\d{2,4}[\s-]\d{3,4}[\s-]?\d{3,4}$/.test(v)],
];

/** a•••••z@e•••e.com, +44 •••• ••12: enough to recognise the shape, not the value. */
export function maskExample(v: string): string {
  const s = v.trim();
  if (s.includes('@')) {
    const [u, d] = s.split('@') as [string, string];
    const [host, ...rest] = d.split('.');
    return `${u[0] ?? ''}${'•'.repeat(Math.max(1, u.length - 1))}@${host?.[0] ?? ''}${'•'.repeat(Math.max(1, (host ?? '').length - 1))}.${rest.join('.')}`;
  }
  if (s.length <= 4) return '•'.repeat(s.length);
  return `${s.slice(0, 2)}${s.slice(2, -2).replace(/[^\s.-]/g, '•')}${s.slice(-2)}`;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

export class PiiService {
  private ctx!: AppContext;
  bind(ctx: AppContext) {
    this.ctx = ctx;
  }

  async scan(p: Principal, workspaceId: string, opts: { tables?: string[]; sample?: number } = {}): Promise<PiiFinding[]> {
    const c = this.ctx;
    const catalog = (await c.lineage.catalog(p, workspaceId)).filter((o) => o.schema !== 'information_schema' && o.schema !== 'pg_catalog');
    const wanted = opts.tables?.length ? new Set(opts.tables.map((t) => t.toLowerCase().replace(/^main\./, ''))) : null;
    const sample = Math.min(Math.max(opts.sample ?? 300, 20), 5000);
    const findings: PiiFinding[] = [];
    for (const o of catalog) {
      const full = o.schema === 'main' ? o.name : `${o.schema}.${o.name}`;
      if (wanted && !wanted.has(full.toLowerCase()) && !wanted.has(o.name.toLowerCase())) continue;
      const hinted = new Map<string, PiiKind>();
      for (const col of o.columns) {
        const hit = NAME_HINTS.find(([, re]) => re.test(col.name));
        if (hit) hinted.set(col.name, hit[0]);
      }
      const textCols = o.columns.filter((col) => /CHAR|TEXT|STRING|VARCHAR/i.test(col.type));
      let values = new Map<string, string[]>();
      if (textCols.length) {
        const sel = textCols.map((col) => `CAST(${q(col.name)} AS VARCHAR) AS ${q(col.name)}`).join(', ');
        const rel = o.schema === 'main' ? q(o.name) : `${q(o.schema)}.${q(o.name)}`;
        try {
          const r = await c.queries.run(p, workspaceId, `SELECT ${sel} FROM ${rel} LIMIT ${sample}`, { maxRows: sample });
          values = new Map(r.columns.map((col, i) => [col.name, r.rows.map((row) => row[i]).filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())]));
        } catch {
          /* unreadable (a view over a missing file…): names only */
        }
      }
      for (const col of o.columns) {
        const vals = values.get(col.name) ?? [];
        let valueKind: PiiKind | null = null;
        let rate: number | null = null;
        if (vals.length >= 5) {
          let best: [PiiKind, number] | null = null;
          for (const [kind, test] of VALUE_TESTS) {
            const hits = vals.filter(test).length / vals.length;
            if (hits >= 0.6 && (!best || hits > best[1])) best = [kind, hits];
          }
          if (best) [valueKind, rate] = best;
        }
        const nameKind = hinted.get(col.name) ?? null;
        if (!valueKind && !nameKind) continue;
        const kind = valueKind ?? nameKind!;
        const evidence: PiiFinding['evidence'] = valueKind && nameKind === valueKind ? 'both' : valueKind ? 'values' : 'name';
        const confidence: PiiFinding['confidence'] = evidence === 'both' || (evidence === 'values' && (rate ?? 0) >= 0.9 && kind !== 'phone') ? 'high' : 'medium';
        const test = VALUE_TESTS.find(([k]) => k === kind)?.[1];
        const examples = (test ? vals.filter(test) : vals).slice(0, 3).map(maskExample);
        findings.push({ object: full, column: col.name, type: col.type, kind, confidence, evidence, match_rate: rate != null ? Math.round(rate * 100) / 100 : null, examples, suggested_mask: MASK_FOR[kind], tagged: col.tags.includes('pii') });
      }
    }
    return findings.sort((a, b) => (a.confidence === b.confidence ? a.object.localeCompare(b.object) || a.column.localeCompare(b.column) : a.confidence === 'high' ? -1 : 1));
  }

  /** Adds pii and pii:<kind> to the columns' catalog tags. */
  async tag(p: Principal, workspaceId: string, items: { object: string; column: string; kind: PiiKind }[]): Promise<number> {
    const c = this.ctx;
    const current = await c.lineage.annotations(p, workspaceId);
    for (const it of items) {
      const existing = current.find((a) => a.object_name === it.object && a.column_name === it.column);
      const tags = [...new Set([...(existing?.tags ?? []), 'pii', `pii:${it.kind}`])];
      await c.lineage.annotate(p, workspaceId, { object_name: it.object, column_name: it.column, tags, description: existing?.description ?? undefined });
    }
    return items.length;
  }

  /**
   * An access policy on one table that masks the given columns for everyone except the workspace's owners. An
   * existing "Personal data in <table>" policy is updated rather than duplicated.
   */
  async protect(p: Principal, workspaceId: string, table: string, columns: Record<string, Exclude<MaskKind, 'expression'>>) {
    const c = this.ctx;
    if (!Object.keys(columns).length) throw badRequest('Choose at least one column to mask');
    const name = `Personal data in ${table}`;
    const masks: Record<string, ColumnMask> = Object.fromEntries(Object.entries(columns).map(([col, kind]) => [col, { kind }]));
    const existing = (await c.policies.list(p, workspaceId)).find((x) => x.name === name);
    if (existing) return c.policies.update(p, existing.id, { column_masks: { ...(existing.column_masks as Record<string, ColumnMask>), ...masks }, enabled: true });
    return c.policies.create(p, workspaceId, { name, description: 'Masks personal data for everyone but the workspace owners (found by the PII scan).', table_name: table, column_masks: masks, applies_to: { all: true }, enabled: true });
  }
}
