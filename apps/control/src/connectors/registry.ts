import type { Connector } from './types.js';

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.manifest.id)) {
      throw new Error(`connector already registered: ${connector.manifest.id}`);
    }
    this.connectors.set(connector.manifest.id, connector);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  list(): readonly Connector[] {
    return [...this.connectors.values()];
  }
}
