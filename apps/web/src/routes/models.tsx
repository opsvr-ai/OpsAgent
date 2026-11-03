import { useEffect, useState } from 'react';
import { createModel, deleteModel, listModels, type ModelProvider } from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface ModelsProps {
  readonly onBack: () => void;
}

export function Models({ onBack }: ModelsProps) {
  const [models, setModels] = useState<ModelProvider[] | null>(null);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('deepseek');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com');
  const [model, setModel] = useState('deepseek-chat');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listModels()
      .then(setModels)
      .catch(() => setError('模型配置加载失败'));
  }, []);

  async function create() {
    if (!name.trim() || !apiKey.trim()) {
      setError('请填写名称和 API Key');
      return;
    }
    setError(null);
    try {
      const created = await createModel({
        name: name.trim(),
        provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      });
      setModels((current) => [created, ...(current ?? [])]);
      setApiKey('');
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

  return (
    <DesignShell
      active="models"
      eyebrow="Models"
      title="模型配置"
      subtitle="租户 BYOK；密钥 AES-256-GCM 加密存储，接口不返回明文。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      <section className="card">
        <div className="card-head"><h2>新增模型</h2><span className="muted">仅当前租户可用</span></div>
        <div className="card-body">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="model-name">名称</label>
              <input id="model-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="deepseek-prod" />
            </div>
            <div className="field">
              <label htmlFor="model-provider">Provider</label>
              <input id="model-provider" value={provider} onChange={(event) => setProvider(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="model-base">Base URL</label>
              <input id="model-base" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="model-id">模型</label>
              <input id="model-id" value={model} onChange={(event) => setModel(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="model-key">API Key</label>
              <input id="model-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." />
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={() => void create()}>保存模型</button>
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
