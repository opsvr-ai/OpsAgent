import { ProbeRegistry, type ConnectorProbe, type ProbeResult } from './probe.js';
import type { ConnectorRecord } from './service.js';

export interface HttpProbeOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function baseUrl(record: ConnectorRecord): string {
  const value = record.config.baseUrl;
  if (typeof value !== 'string') throw new Error('baseUrl is required');
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('baseUrl must be http(s)');
  }
  return url.toString();
}

async function timed(
  options: HttpProbeOptions,
  run: (fetchImpl: typeof fetch, signal: AbortSignal) => Promise<boolean>,
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const ok = await run(options.fetch ?? fetch, AbortSignal.timeout(options.timeoutMs ?? 5000));
    return { ok, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'probe_failed',
    };
  }
}

export function createPrometheusProbe(options: HttpProbeOptions = {}): ConnectorProbe {
  return {
    async probe(record) {
      return timed(options, async (fetchImpl, signal) => {
        const url = new URL('/api/v1/query', baseUrl(record));
        url.searchParams.set('query', 'vector(1)');
        const response = await fetchImpl(url, { signal, redirect: 'error' });
        if (!response.ok) throw new Error(`prometheus_http_${response.status}`);
        const body = (await response.json()) as { status?: string };
        if (body.status !== 'success') throw new Error('prometheus_query_failed');
        return true;
      });
    },
  };
}

export function createGrafanaProbe(options: HttpProbeOptions = {}): ConnectorProbe {
  return {
    async probe(record) {
      return timed(options, async (fetchImpl, signal) => {
        const response = await fetchImpl(new URL('/api/health', baseUrl(record)), {
          signal,
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`grafana_http_${response.status}`);
        return true;
      });
    },
  };
}

export function createAlertmanagerProbe(options: HttpProbeOptions = {}): ConnectorProbe {
  return {
    async probe(record) {
      return timed(options, async (fetchImpl, signal) => {
        const response = await fetchImpl(new URL('/api/v2/status', baseUrl(record)), {
          signal,
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`alertmanager_http_${response.status}`);
        return true;
      });
    },
  };
}

export function createHttpProbe(options: HttpProbeOptions = {}): ConnectorProbe {
  return {
    async probe(record) {
      return timed(options, async (fetchImpl, signal) => {
        const response = await fetchImpl(baseUrl(record), { signal, redirect: 'error' });
        if (!response.ok) throw new Error(`http_${response.status}`);
        return true;
      });
    },
  };
}

export function createDefaultProbeRegistry(): ProbeRegistry {
  const registry = new ProbeRegistry();
  registry.register('prometheus', createPrometheusProbe());
  registry.register('grafana', createGrafanaProbe());
  registry.register('alertmanager', createAlertmanagerProbe());
  registry.register('http', createHttpProbe());
  return registry;
}
