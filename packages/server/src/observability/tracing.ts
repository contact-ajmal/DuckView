/**
 * OpenTelemetry tracing hooks. Tracing is always available through the API (no-op when disabled);
 * when `observability.otel.enabled` is true, a NodeTracerProvider with an OTLP/HTTP exporter is installed.
 */
import { trace, context, SpanStatusCode, type Span, type Tracer, type Attributes } from '@opentelemetry/api';
import type { DuckViewConfig } from '../config/index.js';
import { logger } from './logger.js';

let provider: { shutdown(): Promise<void> } | null = null;

export async function initTracing(cfg: DuckViewConfig): Promise<void> {
  const o = cfg.observability.otel;
  if (!o.enabled) return;
  const [{ NodeTracerProvider }, { BatchSpanProcessor, SimpleSpanProcessor, ConsoleSpanExporter }, { OTLPTraceExporter }, resources, semconv] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ]);
  const resource = resources.resourceFromAttributes({ [semconv.ATTR_SERVICE_NAME]: o.service_name, [semconv.ATTR_SERVICE_VERSION]: '1.2.0' });
  const spanProcessors = [];
  if (o.exporter_otlp_endpoint) spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: o.exporter_otlp_endpoint })));
  if (o.console_exporter) spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  const p = new NodeTracerProvider({ resource, spanProcessors });
  p.register();
  provider = p;
  logger().info({ endpoint: o.exporter_otlp_endpoint, service: o.service_name }, 'OpenTelemetry tracing enabled');
}

export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown();
}

export function tracer(): Tracer {
  return trace.getTracer('duckview', '1.2.0');
}

/** Runs `fn` inside a span; records exceptions and sets status. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export { context, trace };
