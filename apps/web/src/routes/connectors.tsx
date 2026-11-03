import { useEffect, useState } from 'react';
import {
  createConnector,
  getConnector,
  listConnectors,
  saveConnectorCredentials,
  testConnector,
  type ConnectorDetail,
  type ConnectorSummary,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface ConnectorsProps {
  readonly onBack: () => void;
}

const TYPES = ['prometheus', 'grafana', 'alertmanager', 'zabbix', 'clickhouse', 'postgres', 'mysql', 'redis', 'ssh', 'http'];

export function Connectors({ onBack }: ConnectorsProps) {
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState('prometheus');
  const [baseUrl, setBaseUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<ConnectorDetail | null>(null);
  const [credentialsText, setCredentialsText] = useState('');

  useEffect(() => {
    void listConnectors()
      .then(setConnectors)
      .catch(() => setError('连接器加载失败'));
  }, []);

  async function create() {
    if (!name.trim()) {
      setError('请填写名称');
      return;
    }
    setError(null);
    try {
      const connector = await createConnector({
        connectorType: type,
        name: name.trim(),
        config: baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {},
      });
      setConnectors((current) => [connector, ...(current ?? [])]);
      setName('');
      setBaseUrl('');
    } catch {
      setError('创建失败');
    }
  }

  async function test(id: string) {
    setError(null);
    try {
      const result = await testConnector(id);
      setProbe((current) => ({ ...current, [id]: `${result.status} · ${result.latencyMs}ms` }));
    } catch {
      setProbe((current) => ({ ...current, [id]: '探测失败' }));
    }
  }

  async function openDetail(id: string) {
    setError(null);
    try {
      setDetail(await getConnector(id));
      setCredentialsText('');
    } catch {
      setError('连接器详情加载失败');
    }
  }

  async function saveCredentials() {
    if (!detail) return;
    setError(null);
    try {
      const parsed = JSON.parse(credentialsText) as Record<string, unknown>;
      await saveConnectorCredentials(detail.id, parsed);
      setDetail({ ...detail, hasCredentials: true });
      setCredentialsText('');
    } catch {
      setError('凭据保存失败，需为 JSON 对象');
    }
  }

  return (
    <DesignShell
      active="connectors"
      eyebrow="Integrations"
      title="集成与连接器"
      subtitle="9 类标准连接器：配置、健康探测与租户隔离。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      <section className="card">
        <div className="card-head"><h2>新建连接器</h2><span className="muted">凭据保存后可探测</span></div>
        <div className="card-body">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="connector-name">名称</label>
              <input id="connector-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 prod-prometheus" />
            </div>
            <div className="field">
              <label htmlFor="connector-type">类型</label>
              <select id="connector-type" value={type} onChange={(event) => setType(event.target.value)}>
                {TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="connector-url">Base URL（HTTP 类）</label>
              <input id="connector-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://prometheus:9090" />
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={() => void create()}>创建连接器</button>
          </div>
        </div>
      </section>

      {connectors === null ? <p className="muted">加载中…</p> : null}
      {connectors?.length === 0 ? <p className="muted">暂无连接器</p> : null}
      <section className="grid grid-3">
        {connectors?.map((connector) => (
          <article key={connector.id} className="card">
            <div className="card-body">
              <div className="scenario-top">
                <span className="icon-tile is-blue"><svg><use href="/icons.svg#i-plug" /></svg></span>
                <span className="badge badge-neutral">{connector.connectorType}</span>
                <span className="badge badge-neutral">{connector.status}</span>
              </div>
              <h3>{connector.name}</h3>
              <p className="muted mono">{connector.credentialRef ?? (Object.keys(connector.config).length > 0 ? JSON.stringify(connector.config) : '未配置凭据')}</p>
              {probe[connector.id] ? <p className="muted">{probe[connector.id]}</p> : null}
              <div className="row-sm">
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void test(connector.id)}>测试连接</button>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void openDetail(connector.id)}>详情</button>
              </div>
            </div>
          </article>
        ))}
      </section>
      {detail ? (
        <section className="card">
          <div className="card-body">
            <div className="row-between">
              <h2>{detail.name}</h2>
              <span className="badge badge-neutral">{detail.hasCredentials ? '已配置凭据' : '无凭据'}</span>
            </div>
            <p className="muted mono">{JSON.stringify(detail.config)}</p>
            <label htmlFor="connector-credentials">凭据 JSON（保存后不可回读）</label>
            <textarea
              id="connector-credentials"
              value={credentialsText}
              onChange={(event) => setCredentialsText(event.target.value)}
              rows={4}
            />
            <button type="button" className="btn btn-primary" onClick={() => void saveCredentials()}>保存凭据</button>
          </div>
        </section>
      ) : null}
    </DesignShell>
  );
}
