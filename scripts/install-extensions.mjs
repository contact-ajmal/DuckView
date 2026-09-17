#!/usr/bin/env node
/**
 * Pre-installs DuckDB extensions into a directory so containers never need network access at runtime.
 *   node scripts/install-extensions.mjs <extension_directory> [ext ...]
 * Defaults: httpfs azure arrow iceberg delta excel
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { DuckDBInstance } = require(path.resolve('packages/server/node_modules/@duckdb/node-api'));

const [dir = '/app/.duckdb/extensions', ...rest] = process.argv.slice(2);
const exts = rest.length ? rest : ['httpfs', 'azure', 'arrow', 'iceberg', 'delta', 'excel'];
fs.mkdirSync(dir, { recursive: true });
const inst = await DuckDBInstance.create(':memory:', { extension_directory: dir });
const c = await inst.connect();
let failed = 0;
for (const e of exts) {
  try {
    try {
      await c.run(`INSTALL ${e}`);
    } catch (coreErr) {
      // Not in the core repository for this build → try the community repository.
      await c.run(`INSTALL ${e} FROM community`).catch(() => {
        throw coreErr;
      });
    }
    await c.run(`LOAD ${e}`);
    console.log(`✓ ${e}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${e}: ${String(err.message).split('\n')[0]}`);
  }
}
const r = await c.runAndReadAll(`SELECT extension_name, extension_version FROM duckdb_extensions() WHERE installed ORDER BY 1`);
console.log('installed:', r.getRowObjectsJson().map((x) => `${x.extension_name}@${x.extension_version}`).join(' '));
c.closeSync();
inst.closeSync();
process.exit(failed && exts.length === failed ? 1 : 0);
