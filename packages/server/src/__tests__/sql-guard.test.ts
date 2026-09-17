import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeSql, splitStatements, guardSql, extractPathLiterals, isWrappableSelect } from '../engine/sql-guard.js';
import { DataJail, SandboxViolation } from '../engine/sandbox.js';

let root: string;
let jail: DataJail;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-guard-'));
  jail = new DataJail(root);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const opts = () => ({ jail, allowRemote: false, allowedExtensions: ['parquet', 'json', 'httpfs'], blockedExtensions: ['shellfs'] });

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    expect(splitStatements(`SELECT ';' AS a; SELECT 2 -- ; comment\n; SELECT (SELECT 1; ) `).length).toBe(3);
  });
  it('ignores comments and dollar-quoted strings', () => {
    expect(splitStatements(`/* DROP TABLE x; */ SELECT $$a;b$$ AS s`).length).toBe(1);
  });
});

describe('analyzeSql classification', () => {
  it('classifies reads', () => {
    for (const s of ['SELECT 1', 'with x as (select 1) select * from x', "FROM 'a.parquet'", 'SUMMARIZE t', 'EXPLAIN SELECT 1', 'DESCRIBE t', 'SHOW TABLES', 'PIVOT t ON a USING sum(b)']) {
      expect(analyzeSql(s).overall, s).toBe('read');
    }
  });
  it('classifies destructive statements', () => {
    for (const s of ['DROP TABLE t', 'delete from t where 1=1', 'ALTER TABLE t ADD COLUMN x INT', 'UPDATE t SET a=1', 'TRUNCATE t', 'CREATE OR REPLACE TABLE t AS SELECT 1']) {
      const a = analyzeSql(s);
      expect(a.overall, s).toBe('destructive');
      expect(a.isMutating).toBe(true);
    }
  });
  it('classifies writes and admin', () => {
    expect(analyzeSql('INSERT INTO t VALUES (1)').overall).toBe('write');
    expect(analyzeSql('CREATE TABLE t (a INT)').overall).toBe('write');
    expect(analyzeSql("COPY t TO 'out.parquet'").overall).toBe('write');
    expect(analyzeSql('SET threads = 1').overall).toBe('admin');
    expect(analyzeSql('INSTALL httpfs').overall).toBe('admin');
    expect(analyzeSql("ATTACH 'x.duckdb' AS y").overall).toBe('admin');
  });
  it('sees through CTEs to the governing verb', () => {
    expect(analyzeSql('WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM x)').overall).toBe('destructive');
    expect(analyzeSql('WITH x AS (SELECT 1), y AS (SELECT 2) INSERT INTO t SELECT * FROM x').overall).toBe('write');
    expect(analyzeSql('WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<5) SELECT * FROM x').overall).toBe('read');
  });
  it('is not fooled by keywords inside strings/comments/subqueries', () => {
    expect(analyzeSql("SELECT 'DROP TABLE users' AS s").overall).toBe('read');
    expect(analyzeSql('SELECT 1 -- DROP TABLE x').overall).toBe('read');
    expect(analyzeSql('SELECT * FROM t WHERE "update" = 1').overall).toBe('read');
  });
  it('takes the highest risk across multiple statements', () => {
    const a = analyzeSql('SELECT 1; DROP TABLE t; SELECT 2');
    expect(a.overall).toBe('destructive');
    expect(a.mutatingVerbs).toEqual(['DROP']);
    expect(a.statements.length).toBe(3);
  });
});

describe('guardSql paths', () => {
  it('rewrites relative path literals to absolute jail paths', () => {
    const g = guardSql("SELECT * FROM 'sales.parquet' JOIN read_csv('sub/x.csv') USING (id)", opts());
    expect(g.sql).toContain(`'${path.join(jail.root, 'sales.parquet')}'`);
    expect(g.sql).toContain(`'${path.join(jail.root, 'sub/x.csv')}'`);
    expect(g.paths.length).toBe(2);
  });
  it('leaves non-path literals untouched', () => {
    const sql = "SELECT * FROM t WHERE region = 'north' AND d = '2024-01-01' AND s = 'a/b'";
    expect(guardSql(sql, opts()).sql).toBe(sql);
  });
  it('rejects traversal and absolute escapes', () => {
    expect(() => guardSql("SELECT * FROM read_csv('../../etc/passwd')", opts())).toThrow(SandboxViolation);
    expect(() => guardSql("SELECT * FROM '/etc/passwd'", opts())).toThrow(SandboxViolation);
    expect(() => guardSql(`COPY (SELECT 1) TO '${os.tmpdir()}/evil.csv'`, opts())).toThrow(SandboxViolation);
  });
  it('rejects remote URIs unless allowed', () => {
    expect(() => guardSql("SELECT * FROM 's3://bucket/x.parquet'", opts())).toThrow(SandboxViolation);
    expect(guardSql("SELECT * FROM 's3://bucket/x.parquet'", { ...opts(), allowRemote: true }).sql).toContain('s3://bucket/x.parquet');
  });
  it('handles escaped quotes in literals', () => {
    const g = guardSql("SELECT * FROM 'it''s.parquet'", opts());
    expect(g.sql).toContain(`it''s.parquet`);
  });
  it('preserves globs', () => {
    const g = guardSql("SELECT * FROM 'events/*.parquet'", opts());
    expect(g.sql).toContain(path.join(jail.root, 'events', '*.parquet'));
  });
});

describe('guardSql extensions & settings', () => {
  it('gates INSTALL/LOAD against allow/block lists', () => {
    expect(() => guardSql('INSTALL shellfs', opts())).toThrow(/blocked/);
    expect(() => guardSql('LOAD spatial', opts())).toThrow(/not in the allowed/);
    expect(() => guardSql('INSTALL httpfs', opts())).not.toThrow();
    expect(() => guardSql('LOAD parquet', { ...opts(), allowedExtensions: null })).not.toThrow();
  });
  it('blocks hardened settings', () => {
    expect(() => guardSql('SET enable_external_access = true', opts())).toThrow(SandboxViolation);
    expect(() => guardSql("SET allowed_directories = ['/']", opts())).toThrow(SandboxViolation);
    expect(() => guardSql('PRAGMA memory_limit = \'100GB\'', opts())).toThrow(SandboxViolation);
    expect(() => guardSql("SET TimeZone = 'UTC'", opts())).not.toThrow();
  });
});

describe('helpers', () => {
  it('extractPathLiterals finds only path-like literals', () => {
    const lits = extractPathLiterals("SELECT 'x' FROM 'a.parquet' WHERE b = 'north'");
    expect(lits.map((l) => l.value)).toEqual(['a.parquet']);
  });
  it('isWrappableSelect', () => {
    expect(isWrappableSelect('SELECT 1')).toBe(true);
    expect(isWrappableSelect("FROM 'x.parquet'")).toBe(true);
    expect(isWrappableSelect('DROP TABLE t')).toBe(false);
    expect(isWrappableSelect('SELECT 1; SELECT 2')).toBe(false);
  });
});
