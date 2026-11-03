export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3';

export interface ConnectorManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export interface ConnectorContext {
  readonly tenantId: string;
  readonly signal?: AbortSignal;
}

export interface ConnectorTool {
  readonly name: string;
  readonly risk: RiskLevel;
  execute(
    input: Readonly<Record<string, unknown>>,
    context: ConnectorContext,
  ): Promise<unknown>;
}

export interface Connector {
  readonly manifest: ConnectorManifest;
  readonly tools: readonly ConnectorTool[];
}
