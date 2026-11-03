import type { ConnectorRecord } from './service.js';

export interface ProbeResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

export interface ConnectorProbe {
  probe(connector: ConnectorRecord): Promise<ProbeResult>;
}

export class ProbeRegistry {
  private readonly probes = new Map<string, ConnectorProbe>();

  register(type: string, probe: ConnectorProbe): void {
    this.probes.set(type, probe);
  }

  get(type: string): ConnectorProbe | undefined {
    return this.probes.get(type);
  }
}
