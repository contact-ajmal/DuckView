import type { Connector } from './types.js';
import { snowflake, bigquery, redshift, clickhouse, fabric } from './warehouses.js';
import { salesforce, hubspot, stripe, ga4, airtable, notion } from './saas.js';
import { google_drive, google_sheets } from './google.js';

export const CONNECTORS: Connector[] = [snowflake, bigquery, redshift, clickhouse, fabric, salesforce, hubspot, stripe, ga4, airtable, notion, google_drive, google_sheets];
export const connectorById = (id: string): Connector | null => CONNECTORS.find((c) => c.id === id) ?? null;
export * from './types.js';
