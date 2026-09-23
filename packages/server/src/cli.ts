#!/usr/bin/env node
/**
 * duckview CLI
 *   duckview serve                      — HTTP/WS/MCP server + web UI
 *   duckview mcp [--token|--user] [--workspace]  — MCP over stdio
 *   duckview migrate                    — run metadata migrations and exit
 *   duckview create-user --email --password [--role]
 *   duckview create-token --email --name [--scopes read,write,mcp] [--workspace] [--days]
 *   duckview config                     — print the effective (redacted) configuration
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig, setConfig, redactConfig } from './config/index.js';
import { initLogger, logger } from './observability/logger.js';
import { initTracing, shutdownTracing } from './observability/tracing.js';
import { createContext } from './context.js';

const program = new Command();
program.name('duckview').description('DuckView Enterprise — hardened DuckDB platform with an MCP server').version('1.2.0');
program.option('-c, --config <path>', 'path to duckview.config.yaml');

/**
 * Reads `.env` from the working directory (or DUCKVIEW_ENV_FILE) into process.env — never overriding variables that
 * are already set — so `pnpm start` outside Docker gets the same JWT_SECRET / ENCRYPTION_KEY / provider settings
 * that docker compose reads from the same file. Plain KEY=VALUE lines, `#` comments, optional quotes.
 */
export function loadDotEnv(file = process.env.DUCKVIEW_ENV_FILE ?? path.resolve(process.cwd(), '.env')): string[] {
  if (!fs.existsSync(file)) return [];
  const loaded: string[] = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (process.env[m[1]!] === undefined) {
      process.env[m[1]!] = value;
      loaded.push(m[1]!);
    }
  }
  return loaded;
}

function boot(opts: { stderr?: boolean } = {}) {
  const globalOpts = program.opts<{ config?: string }>();
  if (globalOpts.config) process.env.DUCKVIEW_CONFIG = globalOpts.config;
  const fromEnvFile = loadDotEnv();
  const cfg = loadConfig();
  setConfig(cfg);
  initLogger({ level: cfg.server.log_level, stderr: opts.stderr });
  if (fromEnvFile.length) logger().info({ variables: fromEnvFile }, 'Loaded .env');
  return cfg;
}

program
  .command('serve')
  .description('start the DuckView server')
  .option('-p, --port <port>', 'override server.port')
  .option('-H, --host <host>', 'override server.host')
  .action(async (opts: { port?: string; host?: string }) => {
    const cfg = boot();
    if (opts.port) cfg.server.port = Number(opts.port);
    if (opts.host) cfg.server.host = opts.host;
    await initTracing(cfg);
    const ctx = await createContext(cfg);
    const { buildApp } = await import('./app.js');
    const { app, appsServer } = await buildApp(ctx);
    const shutdown = async (signal: string) => {
      logger().info({ signal }, 'Shutting down');
      // Whatever is still open after 15 s (a client holding a socket), the process goes.
      setTimeout(() => process.exit(0), 15_000).unref();
      try {
        await app.close();
        await appsServer?.close();
        await ctx.shutdown();
        await shutdownTracing();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    await app.listen({ port: cfg.server.port, host: cfg.server.host });
    if (appsServer) {
      await appsServer.listen({ port: cfg.apps.port!, host: cfg.server.host });
      logger().info({ port: cfg.apps.port, public_url: cfg.apps.public_url ?? null }, 'Data apps listening on their own origin');
    }
    logger().info({ port: cfg.server.port, host: cfg.server.host, dataDir: cfg.security.data_jail_directory, metadata: ctx.store.dialect, auth: cfg.auth.strategy, filesystemMode: cfg.security.filesystem_mode, externalAccess: cfg.security.enable_external_access || cfg.security.filesystem_mode === 'full', config: cfg.configPath }, 'DuckView Enterprise listening');
  });

program
  .command('mcp')
  .description('run the MCP server over stdio (for Claude Desktop, Claude Code, Cursor, …)')
  .option('-t, --token <token>', 'API token (or DUCKVIEW_API_TOKEN)')
  .option('-u, --user <email>', 'trusted local user email (dev only)')
  .option('-w, --workspace <id>', 'default workspace id (or DUCKVIEW_WORKSPACE_ID)')
  .action(async (opts: { token?: string; user?: string; workspace?: string }) => {
    const cfg = boot({ stderr: true });
    await initTracing(cfg);
    const ctx = await createContext(cfg);
    const { runStdio } = await import('./mcp/stdio.js');
    try {
      await runStdio(ctx, { token: opts.token ?? process.env.DUCKVIEW_API_TOKEN, userEmail: opts.user ?? process.env.DUCKVIEW_MCP_USER, workspaceId: opts.workspace ?? process.env.DUCKVIEW_WORKSPACE_ID });
    } finally {
      await ctx.shutdown();
      await shutdownTracing();
      process.exit(0);
    }
  });

program
  .command('migrate')
  .description('apply metadata store migrations and exit')
  .action(async () => {
    const cfg = boot();
    cfg.database.run_migrations = true;
    const ctx = await createContext(cfg);
    await ctx.shutdown();
    logger().info('Migrations applied');
  });

program
  .command('create-user')
  .requiredOption('--email <email>')
  .requiredOption('--password <password>')
  .option('--role <role>', 'ADMIN | USER | READ_ONLY', 'USER')
  .action(async (opts: { email: string; password: string; role: 'ADMIN' | 'USER' | 'READ_ONLY' }) => {
    const cfg = boot();
    const ctx = await createContext(cfg);
    const u = await ctx.auth.createLocalUser({ email: opts.email, password: opts.password, role: opts.role });
    ctx.audit.log({ userId: u.id, actorType: 'SYSTEM', action: 'cli.user_create', resource: `user:${u.id}` });
    await new Promise((r) => setTimeout(r, 100));
    await ctx.shutdown();
    process.stdout.write(`Created ${u.role} user ${u.email} (${u.id})\n`);
  });

program
  .command('create-token')
  .requiredOption('--email <email>', 'owner of the token')
  .requiredOption('--name <name>')
  .option('--scopes <scopes>', 'comma-separated: read,write,admin,mcp', 'read,mcp')
  .option('--workspace <id>', 'restrict to one workspace')
  .option('--days <n>', 'expiry in days')
  .action(async (opts: { email: string; name: string; scopes: string; workspace?: string; days?: string }) => {
    const cfg = boot();
    const ctx = await createContext(cfg);
    const user = await ctx.auth.findByEmail(opts.email);
    if (!user) throw new Error(`No user ${opts.email}`);
    const { token, record } = await ctx.auth.createToken(user, {
      name: opts.name,
      scopes: opts.scopes.split(',').map((s) => s.trim()) as ('read' | 'write' | 'admin' | 'mcp')[],
      workspaceId: opts.workspace ?? null,
      expiresAt: opts.days ? new Date(Date.now() + Number(opts.days) * 86_400_000) : null,
    });
    ctx.audit.log({ userId: user.id, actorType: 'SYSTEM', action: 'cli.token_create', resource: `token:${record.id}` });
    await new Promise((r) => setTimeout(r, 100));
    await ctx.shutdown();
    process.stdout.write(`${token}\n`);
  });

program
  .command('config')
  .description('print the effective configuration (secrets redacted)')
  .action(() => {
    const cfg = boot();
    process.stdout.write(JSON.stringify(redactConfig(cfg), null, 2) + '\n');
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`duckview: ${(err as Error).message}\n`);
  process.exit(1);
});
