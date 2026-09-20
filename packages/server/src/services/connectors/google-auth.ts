/**
 * Google authentication for connectors: a user's Google account (OAuth 2.0 authorization code, refresh tokens
 * kept encrypted) for Drive, Sheets, BigQuery and Analytics — or a service-account key (RS256 JWT bearer) for
 * server-to-server. Both end in a short-lived access token.
 */
import { createSign, randomBytes } from 'node:crypto';
import { ConnectorError } from './types.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Overridable for tests (a mock token endpoint). */
export const googleEndpoints = { auth: GOOGLE_AUTH_URL, token: GOOGLE_TOKEN_URL, userinfo: GOOGLE_USERINFO_URL };

export interface GoogleOAuthClient {
  client_id: string;
  client_secret: string;
}

export function authorizationUrl(client: GoogleOAuthClient, redirectUri: string, scopes: string[], state: string): string {
  const u = new URL(googleEndpoints.auth);
  u.searchParams.set('client_id', client.client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', ['openid', 'email', ...scopes].join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  return u.toString();
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  email?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string }> {
  const res = await fetch(googleEndpoints.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  const text = await res.text();
  if (!res.ok) throw new ConnectorError(`Google token endpoint → ${res.status}: ${text.slice(0, 300)}`, res.status === 400 || res.status === 401 ? 401 : 502);
  return JSON.parse(text);
}

export async function exchangeCode(client: GoogleOAuthClient, redirectUri: string, code: string): Promise<GoogleTokens> {
  const t = await tokenRequest({ code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  let email: string | undefined;
  try {
    const res = await fetch(googleEndpoints.userinfo, { headers: { authorization: `Bearer ${t.access_token}` } });
    if (res.ok) email = ((await res.json()) as { email?: string }).email;
  } catch {
    /* the account label is cosmetic */
  }
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000, scope: t.scope, email };
}

export async function refreshAccessToken(client: GoogleOAuthClient, refreshToken: string): Promise<{ access_token: string; expires_at: number }> {
  const t = await tokenRequest({ refresh_token: refreshToken, client_id: client.client_id, client_secret: client.client_secret, grant_type: 'refresh_token' });
  return { access_token: t.access_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000 };
}

/** Service account key JSON → access token (RS256 JWT bearer grant). */
export async function serviceAccountToken(keyJson: string, scopes: string[]): Promise<{ access_token: string; expires_at: number }> {
  let key: { client_email: string; private_key: string; token_uri?: string };
  try {
    key = JSON.parse(keyJson);
  } catch {
    throw new ConnectorError('The service account key must be the JSON file downloaded from Google Cloud', 400);
  }
  if (!key.client_email || !key.private_key) throw new ConnectorError('The service account key is missing client_email or private_key', 400);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: scopes.join(' '), aud: key.token_uri ?? googleEndpoints.token, iat: now, exp: now + 3600 })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(key.private_key).toString('base64url')}`;
  const res = await fetch(key.token_uri ?? googleEndpoints.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
  const text = await res.text();
  if (!res.ok) throw new ConnectorError(`Google service account token → ${res.status}: ${text.slice(0, 300)}`, 401);
  const t = JSON.parse(text) as { access_token: string; expires_in?: number };
  return { access_token: t.access_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000 };
}

export const randomState = () => randomBytes(16).toString('hex');
