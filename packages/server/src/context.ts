import type { DuckViewConfig } from './config/index.js';
import { createMetadataStore, type MetadataStore } from './db/index.js';
import { EngineManager } from './engine/duckdb.js';
import { CredentialCipher } from './security/crypto.js';
import { AuditService } from './services/audit.js';
import { AuthService } from './services/auth.js';
import { ConnectionService } from './services/connections.js';
import { WorkspaceService } from './services/workspaces.js';
import { QueryService } from './services/query.js';
import { FileService } from './services/files.js';
import { CloudConnectionService } from './services/cloud.js';
import { StorageService } from './services/storage.js';
import { ExportService } from './services/exports.js';
import { SavedQueryService, DashboardService } from './services/bi.js';
import { ChatHistoryService } from './services/chat.js';
import { CopilotService } from './services/copilot.js';
import { LakehouseService } from './services/lakehouse.js';
import { AgentService } from './services/agents.js';
import { GroupService } from './services/groups.js';
import { ResultCache } from './services/cache.js';
import { MosaicService } from './services/mosaic.js';
import type { AwsBridge } from './services/aws.js';
import type { ProviderFactory } from './services/llm.js';
import { logger } from './observability/logger.js';

export interface AppContext {
  cfg: DuckViewConfig;
  store: MetadataStore;
  engines: EngineManager;
  cipher: CredentialCipher;
  audit: AuditService;
  auth: AuthService;
  connections: ConnectionService;
  workspaces: WorkspaceService;
  queries: QueryService;
  files: FileService;
  cloud: CloudConnectionService;
  storage: StorageService;
  exports: ExportService;
  savedQueries: SavedQueryService;
  dashboards: DashboardService;
  chat: ChatHistoryService;
  copilot: CopilotService;
  lakehouse: LakehouseService;
  agents: AgentService;
  groups: GroupService;
  cache: ResultCache;
  mosaic: MosaicService;
  startedAt: Date;
  shutdown(): Promise<void>;
}

export async function createContext(cfg: DuckViewConfig, opts: { providerFactory?: ProviderFactory; awsBridge?: AwsBridge } = {}): Promise<AppContext> {
  const store = await createMetadataStore(cfg.database.metadata_url);
  if (cfg.database.run_migrations) {
    await store.migrate();
    logger().info({ dialect: store.dialect }, 'Metadata store migrated');
  }
  const cipher = new CredentialCipher(cfg.security.encryption_key);
  const engines = new EngineManager(cfg);
  const audit = new AuditService(store);
  const auth = new AuthService(store, cfg);
  const connections = new ConnectionService(store, cipher);
  const cloud = new CloudConnectionService(store, cipher);
  const groups = new GroupService(store);
  const workspaces = new WorkspaceService(store, engines, connections, cloud, groups);
  const lakehouse = new LakehouseService(cfg, store, cipher, engines);
  lakehouse.bind(workspaces, audit);
  const cache = new ResultCache(cfg, workspaces, engines.jail);
  workspaces.onVersion((id) => cache.invalidateWorkspace(id));
  const queries = new QueryService(cfg, workspaces, audit, cache);
  const files = new FileService(cfg, workspaces, audit);
  const storage = new StorageService(cfg, workspaces, cloud, audit, cache);
  const exportsSvc = new ExportService(cfg, workspaces, audit);
  const savedQueries = new SavedQueryService(store, workspaces);
  const dashboards = new DashboardService(store, workspaces);
  const chat = new ChatHistoryService(store, workspaces);
  const copilot = new CopilotService(cfg, workspaces, queries, cloud, chat, audit, opts.providerFactory, opts.awsBridge);
  const agents = new AgentService(cfg, store, auth, workspaces, audit, opts.awsBridge);
  const mosaic = new MosaicService(cfg, workspaces, queries, engines, audit);
  // Pre-aggregates are only valid for the epoch they were built in.
  workspaces.onVersion((id) => void mosaic.dropSchema(id));
  await auth.bootstrapAdmin();
  if (cfg.security.filesystem_mode === 'full') {
    logger().warn({ dataDir: cfg.security.data_jail_directory }, 'filesystem_mode=full: users can mount any local folder and DuckDB may read anywhere this process can. Set security.filesystem_mode=sandboxed for multi-tenant deployments.');
  }
  if (cfg.ephemeralSecrets) {
    logger().warn('JWT_SECRET / ENCRYPTION_KEY not configured — using ephemeral secrets. Sessions and stored credentials will NOT survive a restart. Set them before production use.');
  }
  const ctx: AppContext = {
    cfg,
    store,
    engines,
    cipher,
    audit,
    auth,
    connections,
    workspaces,
    queries,
    files,
    cloud,
    storage,
    exports: exportsSvc,
    savedQueries,
    dashboards,
    chat,
    copilot,
    lakehouse,
    agents,
    groups,
    cache,
    mosaic,
    startedAt: new Date(),
    async shutdown() {
      await agents.flush();
      exportsSvc.close();
      engines.closeAll();
      await store.close();
    },
  };
  agents.bind(ctx);
  return ctx;
}
