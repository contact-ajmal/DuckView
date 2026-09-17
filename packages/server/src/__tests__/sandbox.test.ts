import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataJail, SandboxViolation, looksLikePath, isRemoteUri } from '../engine/sandbox.js';

let root: string;
let outside: string;
let jail: DataJail;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-jail-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-outside-'));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'a.parquet'), '');
  fs.writeFileSync(path.join(root, 'sub', 'b.csv'), '');
  fs.writeFileSync(path.join(outside, 'secret.csv'), 'x');
  fs.symlinkSync(path.join(outside, 'secret.csv'), path.join(root, 'link.csv'));
  fs.mkdirSync(path.join(root, 'delta_tbl', '_delta_log'), { recursive: true });
  jail = new DataJail(root);
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('DataJail.resolve', () => {
  it('resolves relative paths inside the jail', () => {
    const r = jail.resolve('a.parquet');
    expect(r.absolute).toBe(path.join(jail.root, 'a.parquet'));
    expect(r.relative).toBe('a.parquet');
    expect(r.exists).toBe(true);
  });
  it('accepts absolute paths inside the jail', () => {
    expect(jail.resolve(path.join(jail.root, 'sub/b.csv')).relative).toBe('sub/b.csv');
  });
  it('rejects any .. segment even if it would normalise inside', () => {
    expect(() => jail.resolve('sub/../a.parquet')).toThrow(SandboxViolation);
    expect(() => jail.resolve('../../etc/passwd')).toThrow(SandboxViolation);
    expect(() => jail.resolve(`${jail.root}/../x`)).toThrow(SandboxViolation);
    expect(() => jail.resolve('sub\\..\\a.parquet')).toThrow(SandboxViolation);
  });
  it('rejects absolute paths outside the jail', () => {
    expect(() => jail.resolve('/etc/passwd')).toThrow(SandboxViolation);
    expect(() => jail.resolve(outside + '/secret.csv')).toThrow(SandboxViolation);
  });
  it('rejects a jail-prefix lookalike directory', () => {
    expect(() => jail.resolve(jail.root + '_evil/x.csv')).toThrow(SandboxViolation);
  });
  it('follows symlinks and rejects those escaping', () => {
    expect(() => jail.resolve('link.csv')).toThrow(SandboxViolation);
  });
  it('rejects null bytes, home paths, remote URIs, drive letters', () => {
    expect(() => jail.resolve('a\0.parquet')).toThrow(SandboxViolation);
    expect(() => jail.resolve('~/x.csv')).toThrow(SandboxViolation);
    expect(() => jail.resolve('s3://bucket/x.parquet')).toThrow(SandboxViolation);
    expect(() => jail.resolve('C:/Windows/x.csv')).toThrow(SandboxViolation);
  });
  it('handles globs when allowed and validates the static prefix', () => {
    expect(jail.resolve('sub/*.csv', { allowGlob: true }).absolute).toBe(path.join(jail.root, 'sub', '*.csv'));
    expect(jail.resolve('**/*.parquet', { allowGlob: true }).absolute).toBe(path.join(jail.root, '**/*.parquet'));
    expect(() => jail.resolve('sub/*.csv')).toThrow(SandboxViolation);
    expect(() => jail.resolve('/etc/*', { allowGlob: true })).toThrow(SandboxViolation);
  });
  it('resolves not-yet-existing files (for COPY TO)', () => {
    const r = jail.resolve('exports/new.parquet');
    expect(r.exists).toBe(false);
    expect(r.relative).toBe('exports/new.parquet');
  });
});

describe('DataJail.listFiles', () => {
  it('lists data files and detects delta directories', () => {
    const entries = jail.listFiles();
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('a.parquet');
    expect(paths).toContain('sub/b.csv');
    expect(entries.find((e) => e.path === 'delta_tbl')?.kind).toBe('delta');
  });
});

describe('looksLikePath / isRemoteUri', () => {
  it('detects paths', () => {
    expect(looksLikePath('sales.parquet')).toBe(true);
    expect(looksLikePath('data/*.csv')).toBe(true);
    expect(looksLikePath('/etc/passwd')).toBe(true);
    expect(looksLikePath('../x')).toBe(true);
    expect(looksLikePath('s3://b/k')).toBe(true);
    expect(looksLikePath('file.csv.gz')).toBe(true);
  });
  it('ignores ordinary string data', () => {
    expect(looksLikePath('north')).toBe(false);
    expect(looksLikePath('2024-01-01')).toBe(false);
    expect(looksLikePath('foo/bar')).toBe(false);
    expect(looksLikePath('')).toBe(false);
  });
  it('detects remote schemes', () => {
    expect(isRemoteUri('md:mydb')).toBe(true);
    expect(isRemoteUri('https://x/y.parquet')).toBe(true);
    expect(isRemoteUri('gcs://b/o')).toBe(true);
    expect(isRemoteUri('local.parquet')).toBe(false);
  });
});
