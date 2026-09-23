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
import { ScimService } from './services/scim.js';
import { DbtService } from './services/dbt.js';
import { SemanticService } from './services/semantic.js';
import { QualityService } from './services/quality.js';
import { InsightService } from './services/insights.js';
import { ReverseEtlService } from './services/reverse-etl.js';
import { NotebookService } from './services/notebooks.js';
import { CommentService } from './services/comments.js';
import { RevisionService } from './services/revisions.js';
import { GitSyncService } from './services/git-sync.js';
import { EmbedService } from './services/embeds.js';
import { BuilderService } from './services/builder.js';
import { eq } from 'drizzle-orm';
import type { DashboardWidget, LayoutItem, NotebookCell } from './db/schema/sqlite.js';
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
  scim: ScimService;
  dbt: DbtService;
  semantic: SemanticService;
  quality: QualityService;
  insights: InsightService;
  reverse: ReverseEtlService;
  notebooks: NotebookService;
  comments: CommentService;
  revisions: RevisionService;
  git: GitSyncService;
  embeds: EmbedService;
  builder: BuilderService;
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
  const scim = new ScimService(store, cfg, auth, workspaces);
  const dbt = new DbtService(store, cfg, workspaces, queries, auth, audit, lineage, engines.jail.baseDir);
  lineage.dbt = dbt;
  copilot.dbt = dbt;
  const semantic = new SemanticService(store, workspaces, queries, audit, cfg.duckdb.max_result_rows);
  dbt.semantic = semantic;
  copilot.semantic = semantic;
  const quality = new QualityService(store, workspaces, queries, auth, notifications, audit);
  quality.dbt = dbt;
  copilot.quality = quality;
  const insights = new InsightService(store, workspaces, semantic, auth, notifications, audit);
  copilot.insights = insights;
  const reverse = new ReverseEtlService(store, cfg, cipher, engines, workspaces, databases, cloud, auth, notifications, audit);
  copilot.reverse = reverse;
  const notebooks = new NotebookService(store, workspaces, queries, audit);
  copilot.notebooks = notebooks;
  const comments = new CommentService(store, workspaces, notifications, audit);
  copilot.comments = comments;
  const revisions = new RevisionService(store, workspaces, audit);
  notebooks.revisions = revisions;
  savedQueries.revisions = revisions;
  dashboards.revisions = revisions;
  semantic.revisions = revisions;
  dbt.revisions = revisions;
  revisions.restorers = {
    notebook: async (p, _ws, id, snap) => void (await notebooks.update(p, id, { title: snap.title as string, cells: snap.cells as NotebookCell[] })),
    query: async (p, ws, id, snap) => void (await savedQueries.update(p, ws, id, { name: snap.name as string, folder: snap.folder as string, description: (snap.description as string | null) ?? null, sql_text: snap.sql_text as string, tags: (snap.tags as string[]) ?? [] })),
    semantic: async (p, ws, _id, snap) => void (await semantic.save(p, ws, String(snap.yaml ?? ''), { force: true })),
    dbt: async (p, _ws, id, snap) => void (await dbt.update(p, id, { name: snap.name as string, files: snap.files as Record<string, string>, vars: (snap.vars as Record<string, unknown>) ?? {}, target_schema: snap.target_schema as string })),
    // A dashboard comes back with its widgets under their old ids, so the layout still points at them.
    dashboard: async (p, _ws, id, snap) => {
      await dashboards.get(p, id, 'EDITOR');
      const now = new Date();
      await store.db.update(store.schema.dashboards).set({ name: snap.name as string, description: (snap.description as string | null) ?? null, layout: (snap.layout as LayoutItem[]) ?? [], spec: (snap.spec as Record<string, unknown> | null) ?? null, updated_at: now }).where(eq(store.schema.dashboards.id, id));
      await store.db.delete(store.schema.dashboardWidgets).where(eq(store.schema.dashboardWidgets.dashboard_id, id));
      for (const w of (snap.widgets as Omit<DashboardWidget, 'dashboard_id' | 'created_at' | 'updated_at'>[]) ?? []) await store.db.insert(store.schema.dashboardWidgets).values({ ...w, dashboard_id: id, created_at: now, updated_at: now });
    },
  };
  const builder = new BuilderService(queries, dashboards, apps);
  copilot.builder = builder;
  const embeds = new EmbedService(store, cipher, workspaces, auth, audit, dashboards, notebooks, queries, () => cfg.server.public_url?.replace(/\/+$/, '') ?? null);
  const git = new GitSyncService(store, cfg, cipher, engines.jail.baseDir, workspaces, audit, { revisions, notebooks, savedQueries, dashboards, semantic, dbt });
  if (cfg.transform.scheduler_enabled) {
    dbt.startScheduler();
    quality.start();
    insights.start();
    reverse.start();
  }
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
    scim,
    dbt,
    semantic,
    quality,
    insights,
    reverse,
    notebooks,
    comments,
    revisions,
    git,
    embeds,
    builder,
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
      dbt.stop();
      quality.stop();
      insights.stop();
      reverse.stop();
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
