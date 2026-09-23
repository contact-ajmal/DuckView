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
import { CopilotAdminService } from './services/copilot-admin.js';
import { WorkspaceCloudSync } from './services/workspace-cloud.js';
import { DatabaseConnectionService } from './services/databases.js';
import { DataSyncService } from './services/syncs.js';
import { ConnectorConnectionService } from './services/connector-connections.js';
import { DataAppService } from './services/apps.js';
import { NotificationService } from './services/notifications.js';
import { AlertService } from './services/alerts.js';
import { SnapshotService } from './services/snapshots.js';
import { PolicyService } from './services/policies.js';
import { LineageService } from './services/lineage.js';
import { AuditExportService } from './services/audit-export.js';
import path from 'node:path';
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
  copilotAdmin: CopilotAdminService;
  cloudSync: WorkspaceCloudSync;
  databases: DatabaseConnectionService;
  syncs: DataSyncService;
  connectors: ConnectorConnectionService;
  apps: DataAppService;
  notifications: NotificationService;
  alerts: AlertService;
  snapshots: SnapshotService;
  policies: PolicyService;
  lineage: LineageService;
  auditExport: AuditExportService;
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
  const databases = new DatabaseConnectionService(store, cipher, engines, cfg);
  workspaces.databases = databases;
  const policies = new PolicyService(store, workspaces, groups, audit, cfg.mosaic.schema);
  workspaces.policies = policies;
  const cache = new ResultCache(cfg, workspaces, engines.jail);
  cache.policyScope = async (p, workspaceId, role) => (await policies.restrictionFor(p, workspaceId, role))?.scope ?? null;
  workspaces.onVersion((id) => cache.invalidateWorkspace(id));
  const cloudSync = new WorkspaceCloudSync(store, engines, cloud, cfg.duckdb.cloud_sync_delay_seconds);
  workspaces.cloudSync = cloudSync;
  // Mutating SQL on a cloud-backed workspace schedules a push once things go quiet.
  workspaces.onVersion((id, _v, reason) => {
    if (!reason.startsWith('sql:')) return;
    void workspaces.rowById(id).then((w) => w && workspaces.storageOf(w) === 'cloud' && cloudSync.markDirty(w)).catch(() => undefined);
  });
  const queries = new QueryService(cfg, workspaces, audit, cache);
  const files = new FileService(cfg, workspaces, audit);
  const storage = new StorageService(cfg, workspaces, cloud, audit, cache);
  const exportsSvc = new ExportService(cfg, workspaces, audit);
  const savedQueries = new SavedQueryService(store, workspaces);
  const dashboards = new DashboardService(store, workspaces);
  const chat = new ChatHistoryService(store, workspaces);
  const copilot = new CopilotService(cfg, workspaces, queries, cloud, chat, audit, opts.providerFactory, opts.awsBridge);
  const copilotAdmin = new CopilotAdminService(store, cipher);
  copilot.admin = copilotAdmin;
  const agents = new AgentService(cfg, store, auth, workspaces, audit, opts.awsBridge);
  const mosaic = new MosaicService(cfg, workspaces, queries, engines, audit);
  const syncs = new DataSyncService(store, workspaces, queries, auth, audit);
  syncs.aliasOf = async (userId, id) => {
    try {
      return (await databases.getOwned(userId, id)).alias;
    } catch {
      return null;
    }
  };
  const connectors = new ConnectorConnectionService(store, cipher, cfg);
  syncs.connectors = connectors;
  syncs.stageDir = path.join(engines.jail.baseDir, '.duckview', 'sync');
  if (cfg.duckdb.sync_scheduler_enabled) syncs.start();
  const notifications = new NotificationService(store, cfg, cipher, workspaces, audit);
  const alerts = new AlertService(store, cfg, workspaces, queries, auth, notifications, audit);

  const apps = new DataAppService(store, cfg, workspaces, auth, audit);
  apps.bind({ dashboards, savedQueries });
  const snapshots = new SnapshotService(store, cfg, workspaces, dashboards, apps, auth, notifications, audit);
  if (cfg.notifications.scheduler_enabled) {
    alerts.start();
    snapshots.start();
  }
  await apps.init();
  copilot.mosaic = mosaic;
  mosaic.policies = policies;
  const lineage = new LineageService(store, cfg, workspaces, audit);
  copilot.lineage = lineage;
  const auditExport = new AuditExportService(store, cfg, cipher, audit, cloud);
  if (cfg.notifications.scheduler_enabled) auditExport.start();
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
    copilotAdmin,
    cloudSync,
    databases,
    syncs,
    connectors,
    apps,
    notifications,
    alerts,
    snapshots,
    policies,
    lineage,
    auditExport,
    lakehouse,
    agents,
    groups,
    cache,
    mosaic,
    startedAt: new Date(),
    async shutdown() {
      syncs.stop();
      alerts.stop();
      snapshots.stop();
      auditExport.stop();
      await apps.shutdown().catch(() => undefined);
      await agents.flush();
      await cloudSync.flush().catch(() => undefined);
      exportsSvc.close();
      engines.closeAll();
      await store.close();
    },
  };
  agents.bind(ctx);
  return ctx;
}
