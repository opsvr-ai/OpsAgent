import { useEffect, useState } from 'react';
import {
  createConnector,
  listConnectors,
  testConnector,
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
        <div className="card-body">
          <h2>新建连接器</h2>
          <label htmlFor="connector-name">名称</label>
          <input id="connector-name" value={name} onChange={(event) => setName(event.target.value)} />
          <label htmlFor="connector-type">类型</label>
          <select id="connector-type" value={type} onChange={(event) => setType(event.target.value)}>
            {TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <label htmlFor="connector-url">Base URL（HTTP 类）</label>
          <input id="connector-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          <button type="button" className="btn btn-primary" onClick={() => void create()}>创建</button>
        </div>
      </section>

      {connectors === null ? <p className="muted">加载中…</p> : null}
      {connectors?.length === 0 ? <p className="muted">暂无连接器</p> : null}
      <section className="grid grid-3">
        {connectors?.map((connector) => (
          <article key={connector.id} className="card">
            <div className="card-body">
              <div className="scenario-top">
                <span className="badge badge-neutral">{connector.connectorType}</span>
                <span className="badge badge-neutral">{connector.status}</span>
              </div>
              <h3>{connector.name}</h3>
              {probe[connector.id] ? <p className="muted">{probe[connector.id]}</p> : null}
              <button type="button" className="btn btn-outline" onClick={() => void test(connector.id)}>测试连接</button>
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
