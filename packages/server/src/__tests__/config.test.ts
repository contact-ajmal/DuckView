import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, expandEnvPlaceholders } from '../config/index.js';

describe('expandEnvPlaceholders', () => {
  it('expands ${VAR} and ${VAR:-default}', () => {
    expect(expandEnvPlaceholders('a=${A} b=${B:-dflt} c=${C}', { A: '1' })).toBe('a=1 b=dflt c=');
  });
  it('expands nested defaults innermost-first', () => {
    expect(expandEnvPlaceholders('${X:-${Y:-z}}', {})).toBe('z');
    expect(expandEnvPlaceholders('${X:-${Y:-z}}', { Y: 'y' })).toBe('y');
    expect(expandEnvPlaceholders('${X:-${Y:-z}}', { X: 'x', Y: 'y' })).toBe('x');
    expect(expandEnvPlaceholders('${DATABASE_URL:-${METADATA_URL:-sqlite://duckview_meta.db}}', {})).toBe('sqlite://duckview_meta.db');
  });
});

describe('loadConfig', () => {
  it('applies defaults, YAML, and env overrides in order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-cfg-'));
    const file = path.join(dir, 'duckview.config.yaml');
    fs.writeFileSync(file, `server:\n  port: \${PORT:-4200}\nduckdb:\n  max_result_rows: 123\nsecurity:\n  data_jail_directory: ${dir}\n`);
    const cfg = loadConfig({ configPath: file, env: { PORT: '5001', DUCKVIEW__DUCKDB__QUERY_TIMEOUT_SECONDS: '7', DUCKVIEW_MAX_RESULT_ROWS: 'ignored' } });
    expect(cfg.server.port).toBe(5001);
    expect(cfg.duckdb.max_result_rows).toBe(123);
    expect(cfg.duckdb.query_timeout_seconds).toBe(7);
    expect(cfg.ephemeralSecrets).toBe(true);
    expect(cfg.security.jwt_secret.length).toBeGreaterThan(16);
    expect(cfg.security.data_jail_directory).toBe(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('treats empty placeholder expansions as unset', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-cfg-'));
    const file = path.join(dir, 'c.yaml');
    fs.writeFileSync(file, 'server:\n  public_url: "${NOPE:-}"\nauth:\n  oidc:\n    issuer_url: "${NOPE2}"\n');
    const cfg = loadConfig({ configPath: file, env: {} });
    expect(cfg.server.public_url).toBeUndefined();
    expect(cfg.auth.oidc.issuer_url).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('fails hard without secrets in production', () => {
    expect(() => loadConfig({ configPath: null, env: { NODE_ENV: 'production' } })).toThrow(/jwt_secret/);
  });
  it('validates encryption key format', () => {
    expect(() => loadConfig({ configPath: null, env: { ENCRYPTION_KEY: 'short' } })).toThrow(/encryption_key/);
  });
  it('requires oidc details when strategy=oidc', () => {
    expect(() => loadConfig({ configPath: null, env: { AUTH_STRATEGY: 'oidc' } })).toThrow(/oidc/);
  });
});
