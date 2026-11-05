import { useEffect, useState } from 'react';
import {
  createModelsBatch,
  deleteModel,
  discoverModels,
  listModels,
  type DiscoveredModel,
  type ModelProvider,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface ModelsProps {
  readonly onBack: () => void;
}

const PROVIDER_DEFAULTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com/v1',
};

export function Models({ onBack }: ModelsProps) {
  const [models, setModels] = useState<ModelProvider[] | null>(null);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('openai');
  const [baseUrl, setBaseUrl] = useState(PROVIDER_DEFAULTS.openai ?? '');
  const [apiKey, setApiKey] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [candidates, setCandidates] = useState<DiscoveredModel[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listModels()
      .then(setModels)
      .catch(() => setError('模型配置加载失败'));
  }, []);

  function changeProvider(next: string) {
    setProvider(next);
    setBaseUrl(PROVIDER_DEFAULTS[next] ?? baseUrl);
    setCandidates([]);
    setSelectedModels([]);
    setDiscoveryError(null);
  }

  function toggleModel(id: string) {
    setSelectedModels((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  }

  function addManualModel() {
    const id = manualModel.trim();
    if (!id) return;
    if (!selectedModels.includes(id)) setSelectedModels((current) => [...current, id]);
    setManualModel('');
  }

  async function discover() {
    if (!baseUrl.trim() || !apiKey.trim()) {
      setDiscoveryError('请先填写 Base URL 和 API Key');
      return;
    }
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const found = await discoverModels({ provider, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
      setCandidates(found);
      setSelectedModels(found.map((model) => model.id));
      if (found.length === 0) setDiscoveryError('接口没有返回模型，可手工填写模型 ID');
    } catch {
      setDiscoveryError('发现失败，可手工填写模型 ID 后保存');
    } finally {
      setDiscovering(false);
    }
  }

  async function create() {
    if (selectedModels.length === 0) {
      setError('请先发现或手工添加至少一个模型');
      return;
    }
    if (!baseUrl.trim() || !apiKey.trim()) {
      setError('请填写 Base URL 和 API Key');
      return;
    }
    setError(null);
    try {
      const created = await createModelsBatch({
        name: name.trim(),
        provider,
        baseUrl: baseUrl.trim(),
        models: selectedModels,
        apiKey: apiKey.trim(),
      });
      setModels((current) => [...created, ...(current ?? [])]);
      setApiKey('');
      setSelectedModels([]);
      setCandidates([]);
      setManualModel('');
      setName('');
    } catch {
      setError('创建失败');
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await deleteModel(id);
      setModels((current) => current?.filter((item) => item.id !== id) ?? current);
    } catch {
      setError('删除失败');
    }
  }

  const candidateIds = new Set(candidates.map((model) => model.id));
  const manualSelected = selectedModels.filter((id) => !candidateIds.has(id));

  return (
    <DesignShell
      active="models"
      eyebrow="Models"
      title="模型配置"
      subtitle="租户 BYOK；支持 OpenAI 兼容和 Anthropic API，可发现一个地址下的多个模型。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      <div className="status-strip" style={{ marginBottom: 18 }}>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-shield" /></svg></span><div><strong>模型配置</strong><span>{models?.length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>已启用</strong><span>{models?.filter((item) => item.status === 'active').length ?? 0} 个</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-grid" /></svg></span><div><strong>供应商</strong><span>{new Set((models ?? []).map((item) => item.provider)).size} 种</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-lock" /></svg></span><div><strong>密钥存储</strong><span>AES-256-GCM</span></div></div>
      </div>
      <section className="card">
        <div className="card-head"><h2>新增模型</h2><span className="muted">同一个 Base URL 可保存多个模型</span></div>
        <div className="card-body">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="model-name">名称</label>
              <input id="model-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="内网模型" />
            </div>
            <div className="field">
              <label htmlFor="model-provider">Provider</label>
              <select id="model-provider" value={provider} onChange={(event) => changeProvider(event.target.value)}>
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic API</option>
                <option value="deepseek">DeepSeek</option>
              </select>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="model-base">Base URL</label>
              <input id="model-base" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://llm.example/v1" />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="model-key">API Key</label>
              <input id="model-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." />
            </div>
          </div>
          <div className="row-sm" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-outline" disabled={discovering} onClick={() => void discover()}>
              {discovering ? '发现中…' : '发现模型'}
            </button>
            <span className="muted">发现不了时可手工填写模型 ID</span>
          </div>
          {discoveryError ? <p className="muted" style={{ marginTop: 8 }}>{discoveryError}</p> : null}
          {candidates.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="eyebrow">发现结果 · 选择要保存的模型</div>
              <div className="grid grid-2" style={{ marginTop: 8 }}>
                {candidates.map((model) => (
                  <label key={model.id} className="check-row">
                    <input
                      type="checkbox"
                      checked={selectedModels.includes(model.id)}
                      onChange={() => toggleModel(model.id)}
                    />
                    <span>{model.displayName ?? model.id}</span>
                    <span className="mono muted">{model.id}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          <div className="row-sm" style={{ marginTop: 12 }}>
            <input
              aria-label="手工模型 ID"
              value={manualModel}
              onChange={(event) => setManualModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addManualModel();
                }
              }}
              placeholder="手工填写，例如 qwen3-72b"
            />
            <button type="button" className="btn btn-outline btn-sm" onClick={addManualModel}>添加模型</button>
          </div>
          {selectedModels.length > 0 ? (
            <div className="row-sm" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              <span className="muted">将保存 {selectedModels.length} 个：</span>
              {selectedModels.map((id) => (
                <span key={id} className="badge badge-neutral mono">{id}</span>
              ))}
            </div>
          ) : null}
          {manualSelected.length > 0 ? (
            <div className="row-sm" style={{ marginTop: 8 }}>
              {manualSelected.map((id) => (
                <button key={id} type="button" className="btn btn-ghost btn-sm" onClick={() => toggleModel(id)}>
                  移除 {id}
                </button>
              ))}
            </div>
          ) : null}
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={selectedModels.length === 0} onClick={() => void create()}>
              保存 {selectedModels.length > 0 ? `${selectedModels.length} 个模型` : '模型'}
            </button>
          </div>
        </div>
      </section>
      {models === null ? <p className="muted">加载中…</p> : null}
      {models?.length === 0 ? <p className="muted">暂无模型配置</p> : null}
      <section className="grid grid-3">
        {models?.map((item) => (
          <article key={item.id} className="card">
            <div className="card-body">
              <span className="badge badge-neutral">{item.provider}</span>
              <h3>{item.name}</h3>
              <p className="muted mono">{item.model}</p>
              <p className="muted">{item.baseUrl}</p>
              <button type="button" className="btn btn-outline" onClick={() => void remove(item.id)}>删除</button>
            </div>
          </article>
        ))}
      </section>
    </DesignShell>
  );
}
