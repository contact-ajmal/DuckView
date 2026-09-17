import pino, { type Logger } from 'pino';

let root: Logger | null = null;

export interface LoggerOptions {
  level?: string;
  /** Force stderr — REQUIRED for MCP stdio mode, where stdout carries JSON-RPC frames. */
  stderr?: boolean;
  pretty?: boolean;
}

export function initLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info';
  const useStderr = opts.stderr ?? process.env.DUCKVIEW_LOG_DESTINATION === 'stderr';
  const pretty = opts.pretty ?? (process.env.NODE_ENV !== 'production' && (useStderr ? process.stderr.isTTY : process.stdout.isTTY));
  const fd = useStderr ? 2 : 1;
  if (pretty) {
    root = pino(
      { level, base: { service: 'duckview' } },
      pino.transport({ target: 'pino-pretty', options: { destination: fd, colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' } }),
    );
  } else {
    root = pino({ level, base: { service: 'duckview' }, timestamp: pino.stdTimeFunctions.isoTime }, pino.destination({ fd, sync: false }));
  }
  return root;
}

export function logger(): Logger {
  if (!root) root = initLogger();
  return root;
}
