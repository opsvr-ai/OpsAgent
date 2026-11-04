export interface NormalizedIncidentSource {
  readonly source: 'alertmanager' | 'zabbix';
  readonly sourceRef: string;
  readonly title: string;
  readonly severity: string;
  readonly rootCause?: string;
  readonly appSystemId?: string;
  readonly evidence: Array<{
    kind: string;
    source: string;
    summary: string;
    payload?: Record<string, unknown>;
  }>;
}

function object(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function string(input: unknown): string {
  return typeof input === 'string' ? input : '';
}

function severityFromAlertmanager(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === 'critical' || normalized === 'page') return 'P1';
  if (normalized === 'warning') return 'P2';
  return 'P3';
}

function severityFromZabbix(value: unknown): string {
  const normalized = String(value ?? '').toLowerCase();
  if (['disaster', 'high', '5', '4'].includes(normalized)) return 'P1';
  if (['average', '3'].includes(normalized)) return 'P2';
  return 'P3';
}

export function normalizeAlertmanager(
  payload: unknown,
  defaultAppSystemId?: string,
): NormalizedIncidentSource[] {
  const body = object(payload);
  const alerts = Array.isArray(body.alerts) ? body.alerts : [];
  const result: NormalizedIncidentSource[] = [];
  for (const raw of alerts) {
    const alert = object(raw);
    if (string(alert.status) !== 'firing') continue;
    const labels = object(alert.labels);
    const annotations = object(alert.annotations);
    const fingerprint = string(alert.fingerprint);
    const alertname = string(labels.alertname) || 'Alertmanager alert';
    const instance = string(labels.instance);
    const summary = string(annotations.summary) || string(annotations.description) || alertname;
    const sourceRef = fingerprint || `${alertname}:${instance}:${string(alert.startsAt)}`;
    const appSystemId = string(labels.appSystemId) || defaultAppSystemId;
    result.push({
      source: 'alertmanager',
      sourceRef,
      title: instance ? `${summary}（${instance}）` : summary,
      severity: severityFromAlertmanager(string(labels.severity)),
      ...(string(annotations.description) ? { rootCause: string(annotations.description) } : {}),
      ...(appSystemId ? { appSystemId } : {}),
      evidence: [{
        kind: 'alert',
        source: 'alertmanager',
        summary,
        payload: { labels, annotations },
      }],
    });
  }
  return result;
}

export function normalizeZabbix(
  payload: unknown,
  defaultAppSystemId?: string,
): NormalizedIncidentSource[] {
  const body = object(payload);
  const eventId = string(body.eventId) || string(body.eventid) || string(body.event_id);
  const title = string(body.title) || string(body.name) || string(body.trigger) || 'Zabbix event';
  const host = string(body.host) || string(body.hostName);
  const message = string(body.message) || string(body.description);
  const appSystemId = string(body.appSystemId) || defaultAppSystemId;
  return [{
    source: 'zabbix',
    sourceRef: eventId || `${title}:${host}:${string(body.clock)}`,
    title: host ? `${title}（${host}）` : title,
    severity: severityFromZabbix(body.severity),
    ...(message ? { rootCause: message } : {}),
    ...(appSystemId ? { appSystemId } : {}),
    evidence: [{
      kind: 'event',
      source: 'zabbix',
      summary: message || title,
      payload: body,
    }],
  }];
}
