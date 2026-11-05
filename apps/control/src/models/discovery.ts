export interface DiscoverInput {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface DiscoveredModel {
  readonly id: string;
  readonly displayName?: string;
}

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function openAiModelsUrl(baseUrl: string): string {
  const base = trimBase(baseUrl);
  if (/\/v1$/i.test(base) || /\/v\d+$/i.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
}

function anthropicModelsUrl(baseUrl: string): string {
  const base = trimBase(baseUrl);
  if (/\/v1$/i.test(base) || /\/v\d+$/i.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
}

async function readModels(response: Response): Promise<DiscoveredModel[]> {
  if (!response.ok) throw new Error(`model_discovery_http_${response.status}`);
  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown; display_name?: unknown; name?: unknown }>;
    models?: Array<{ id?: unknown; display_name?: unknown; name?: unknown }>;
  };
  const rows = payload.data ?? payload.models ?? [];
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id.length === 0 || seen.has(row.id)) continue;
    seen.add(row.id);
    const displayName = typeof row.display_name === 'string'
      ? row.display_name
      : typeof row.name === 'string'
        ? row.name
        : undefined;
    models.push({ id: row.id, ...(displayName ? { displayName } : {}) });
  }
  return models;
}

export async function discoverModels(input: DiscoverInput, fetchImpl: typeof fetch = fetch): Promise<DiscoveredModel[]> {
  if (!/^https?:\/\//i.test(input.baseUrl)) throw new Error('invalid_base_url');
  const provider = input.provider.toLowerCase();
  const headers: Record<string, string> = { accept: 'application/json' };
  let url: string;
  if (provider === 'anthropic') {
    url = anthropicModelsUrl(input.baseUrl);
    headers['x-api-key'] = input.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider === 'openai' || provider === 'deepseek') {
    url = openAiModelsUrl(input.baseUrl);
    headers.authorization = `Bearer ${input.apiKey}`;
  } else {
    throw new Error('unsupported_provider');
  }
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  return readModels(response);
}
