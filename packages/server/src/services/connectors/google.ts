/**
 * Google Drive and Google Sheets through the person's Google account (OAuth) — or a service account key.
 * Drive: browse folders and files; a CSV / TSV / JSON / Excel file is downloaded and read by DuckDB, a Google
 * Sheet is exported as CSV. Sheets: pick a spreadsheet and a tab; rows come from the Sheets API with the first row
 * as the header.
 */
import { getJson, str, ConnectorError, type Connector, type Session } from './types.js';

const enc = (v: unknown) => encodeURIComponent(str(v));
const SHEET = 'application/vnd.google-apps.spreadsheet';
const FOLDER = 'application/vnd.google-apps.folder';
const DATA_MIME = new Set(['text/csv', 'text/tab-separated-values', 'application/json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/x-parquet', 'application/octet-stream', SHEET]);

async function listDrive(s: Session, q: string): Promise<{ id: string; name: string; mimeType: string; modifiedTime?: string; size?: string }[]> {
  const out: { id: string; name: string; mimeType: string; modifiedTime?: string; size?: string }[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('q', q);
    u.searchParams.set('fields', 'nextPageToken, files(id, name, mimeType, modifiedTime, size)');
    u.searchParams.set('pageSize', '200');
    u.searchParams.set('supportsAllDrives', 'true');
    u.searchParams.set('includeItemsFromAllDrives', 'true');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await getJson<{ files: typeof out; nextPageToken?: string }>(s, u.toString());
    out.push(...r.files);
    pageToken = r.nextPageToken;
  } while (pageToken && out.length < 2000);
  return out;
}

export const google_drive: Connector = {
  id: 'google_drive',
  label: 'Google Drive',
  remote_sql: false,
  auth: { kind: 'google', scopes: ['https://www.googleapis.com/auth/drive.readonly'], fields: [] },
  headers: (c) => ({ authorization: `Bearer ${c.access_token}` }),
  async test(s) {
    const r = await getJson<{ user?: { emailAddress?: string } }>(s, 'https://www.googleapis.com/drive/v3/about?fields=user');
    return { ok: true, message: `Connected · ${r.user?.emailAddress ?? 'Drive'}` };
  },
  /** Folders and data files; a folder's path is its id. */
  async browse(s, path) {
    const parent = path[0] ?? 'root';
    const files = await listDrive(s, `'${parent.replace(/'/g, "\\'")}' in parents and trashed = false`);
    return files
      .filter((f) => f.mimeType === FOLDER || DATA_MIME.has(f.mimeType) || /\.(csv|tsv|json|jsonl|ndjson|parquet|xlsx|xls)$/i.test(f.name))
      .sort((a, b) => Number(b.mimeType === FOLDER) - Number(a.mimeType === FOLDER) || a.name.localeCompare(b.name))
      .map((f) => (f.mimeType === FOLDER ? { name: f.name, type: 'folder', path: [f.id] } : { name: f.name, type: f.mimeType === SHEET ? 'sheet' : 'file', resource: { file_id: f.id, name: f.name, mime: f.mimeType }, hint: f.modifiedTime ? `modified ${f.modifiedTime.slice(0, 10)}` : undefined }));
  },
  async *read() {
    throw new ConnectorError('Drive files are downloaded and read by DuckDB (see driveDownload)', 400);
  },
  describeResource: (r) => str(r.name ?? r.file_id),
};

/** Downloads a Drive file (a Google Sheet as CSV) to a local path; returns the format DuckDB should read it as. */
export async function driveDownload(s: Session, resource: Record<string, unknown>, toFile: string): Promise<'csv' | 'json' | 'parquet' | 'excel'> {
  const id = enc(resource.file_id);
  const mime = str(resource.mime);
  const name = str(resource.name);
  const isSheet = mime === SHEET;
  const url = isSheet ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/csv` : `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
  const res = await s.fetch(url);
  if (!res.ok) throw new ConnectorError(`Drive download → ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
  const fs = await import('node:fs');
  fs.writeFileSync(toFile, Buffer.from(await res.arrayBuffer()));
  if (isSheet || /\.(csv|tsv)$/i.test(name) || mime === 'text/csv') return 'csv';
  if (/\.(json|jsonl|ndjson)$/i.test(name) || mime === 'application/json') return 'json';
  if (/\.parquet$/i.test(name) || mime === 'application/x-parquet') return 'parquet';
  if (/\.xlsx?$/i.test(name) || /spreadsheetml|ms-excel/.test(mime)) return 'excel';
  return 'csv';
}

export const google_sheets: Connector = {
  id: 'google_sheets',
  label: 'Google Sheets',
  remote_sql: false,
  auth: { kind: 'google', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'], fields: [] },
  headers: (c) => ({ authorization: `Bearer ${c.access_token}` }),
  async test(s) {
    const files = await listDrive(s, `mimeType = '${SHEET}' and trashed = false`);
    return { ok: true, message: `Connected · ${files.length} spreadsheet${files.length === 1 ? '' : 's'} visible` };
  },
  /** Spreadsheets → tabs. */
  async browse(s, path) {
    if (path.length === 0) {
      const files = await listDrive(s, `mimeType = '${SHEET}' and trashed = false`);
      return files.map((f) => ({ name: f.name, type: 'spreadsheet', path: [f.id], hint: f.modifiedTime ? `modified ${f.modifiedTime.slice(0, 10)}` : undefined }));
    }
    const r = await getJson<{ properties?: { title?: string }; sheets: { properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[] }>(s, `https://sheets.googleapis.com/v4/spreadsheets/${enc(path[0])}?fields=properties.title,sheets.properties`);
    return r.sheets.map((sh) => ({ name: sh.properties.title, type: 'tab', resource: { spreadsheet_id: path[0], sheet: sh.properties.title, spreadsheet: r.properties?.title }, hint: sh.properties.gridProperties?.rowCount ? `${sh.properties.gridProperties.rowCount} rows` : undefined }));
  },
  async *read(s, resource, opts) {
    const range = resource.range ? str(resource.range) : `'${str(resource.sheet).replace(/'/g, "''")}'`;
    const r = await getJson<{ values?: unknown[][] }>(s, `https://sheets.googleapis.com/v4/spreadsheets/${enc(resource.spreadsheet_id)}/values/${enc(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
    const values = r.values ?? [];
    if (!values.length) return;
    const header = (values[0] ?? []).map((h, i) => (str(h).trim() || `column_${i + 1}`));
    const rows = values
      .slice(1)
      .filter((row) => row.some((v) => v !== '' && v != null)) // Sheets pads the grid with empty rows
      .slice(0, opts.limit)
      .map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] === '' ? null : row[i] ?? null])));
    for (let i = 0; i < rows.length; i += 5000) yield rows.slice(i, i + 5000);
  },
  describeResource: (r) => `${str(r.spreadsheet ?? r.spreadsheet_id)} · ${str(r.sheet)}`,
};
