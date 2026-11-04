import { useEffect, useState } from 'react';
import {
  createDeployment,
  createRelease,
  decideDeployment,
  executeDeployment,
  listAppSystems,
  listDeployments,
  listReleases,
  preflightDeployment,
  rollbackDeployment,
  type AppSystemSummary,
  type DeploymentSummary,
  type ReleaseSummary,
} from '../api/client.js';
import { formatTime } from '../format.js';
import { DesignShell } from './design-shell.js';

export interface DeploymentsProps {
  readonly onBack: () => void;
}

function statusClass(status: string): string {
  if (['preflighted', 'approved', 'deployed'].includes(status)) return 'badge-ok';
  if (['preflight_failed', 'rejected', 'rolled_back'].includes(status)) return 'badge-danger';
  return 'badge-warn';
}

export function Deployments({ onBack }: DeploymentsProps) {
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [appSystems, setAppSystems] = useState<AppSystemSummary[]>([]);
  const [version, setVersion] = useState('');
  const [artifactUrl, setArtifactUrl] = useState('');
  const [sha256, setSha256] = useState('');
  const [signature, setSignature] = useState('');
  const [deployCommand, setDeployCommand] = useState('');
  const [rollbackCommand, setRollbackCommand] = useState('');
  const [appSystemId, setAppSystemId] = useState('');
  const [selectedRelease, setSelectedRelease] = useState('');
  const [environment, setEnvironment] = useState('staging');
  const [strategy, setStrategy] = useState<'rolling' | 'canary'>('rolling');
  const [canaryPercent, setCanaryPercent] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const [nextReleases, nextDeployments, nextSystems] = await Promise.all([
      listReleases(),
      listDeployments(),
      listAppSystems(),
    ]);
    setReleases(nextReleases);
    setDeployments(nextDeployments);
    setAppSystems(nextSystems);
    if (!selectedRelease && nextReleases[0]) setSelectedRelease(nextReleases[0].id);
  }

  useEffect(() => {
    void reload().catch(() => setError('发布数据加载失败'));
  }, []);

  async function submitRelease() {
    setBusy(true);
    setError(null);
    try {
      await createRelease({
        version,
        artifactUrl,
        sha256,
        signature,
        ...(appSystemId ? { appSystemId } : {}),
        ...(deployCommand ? { deployCommand } : {}),
        ...(rollbackCommand ? { rollbackCommand } : {}),
      });
      setVersion('');
      setArtifactUrl('');
      setSha256('');
      setSignature('');
      setDeployCommand('');
      setRollbackCommand('');
      await reload();
    } catch {
      setError('发布创建失败：签名无效或参数不完整');
    } finally {
      setBusy(false);
    }
  }

  async function submitDeployment() {
    if (!selectedRelease) return;
    setBusy(true);
    setError(null);
    try {
      await createDeployment({
        releaseId: selectedRelease,
        environment,
        strategy,
        ...(strategy === 'canary' ? { canaryPercent } : {}),
      });
      await reload();
    } catch {
      setError('部署创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      await decideDeployment(id, decision);
      await reload();
    } catch {
      setError('部署审批失败');
    } finally {
      setBusy(false);
    }
  }

  async function preflight(id: string) {
    setBusy(true);
    setError(null);
    try {
      await preflightDeployment(id);
      await reload();
    } catch {
      setError('制品预检失败');
    } finally {
      setBusy(false);
    }
  }

  async function execute(id: string) {
    setBusy(true);
    setError(null);
    try {
      await executeDeployment(id);
      await reload();
    } catch {
      setError('部署执行失败');
    } finally {
      setBusy(false);
    }
  }

  async function rollback(id: string) {
    setBusy(true);
    setError(null);
    try {
      await rollbackDeployment(id, 'manual rollback from web');
      await reload();
    } catch {
      setError('回滚失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DesignShell
      active="deployments"
      eyebrow="Release & Deploy"
      title="发布与部署"
      subtitle="签名制品、灰度计划、审批、预检与回滚。"
      onBack={onBack}
    >
      {error ? <p role="alert">{error}</p> : null}
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <section className="card">
          <div className="card-head"><h2>签名发布</h2><span className="muted">Ed25519</span></div>
          <div className="card-body form-grid">
            <div className="field"><label htmlFor="release-version">版本</label><input id="release-version" value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.2.3" /></div>
            <div className="field"><label htmlFor="release-system">应用系统</label><select id="release-system" value={appSystemId} onChange={(event) => setAppSystemId(event.target.value)}><option value="">不关联</option>{appSystems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}</select></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="release-url">制品地址</label><input id="release-url" value={artifactUrl} onChange={(event) => setArtifactUrl(event.target.value)} placeholder="https://artifacts.example/app.tgz" /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="release-sha">SHA-256</label><input id="release-sha" className="mono" value={sha256} onChange={(event) => setSha256(event.target.value)} /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="release-signature">Release 签名（Base64）</label><textarea id="release-signature" rows={4} value={signature} onChange={(event) => setSignature(event.target.value)} /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="release-deploy-command">部署命令</label><textarea id="release-deploy-command" rows={3} value={deployCommand} onChange={(event) => setDeployCommand(event.target.value)} placeholder="使用 $OPSAGENT_ARTIFACT 等环境变量" /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="release-rollback-command">回滚命令</label><textarea id="release-rollback-command" rows={3} value={rollbackCommand} onChange={(event) => setRollbackCommand(event.target.value)} placeholder="可选" /></div>
            <button type="button" className="btn btn-primary" disabled={busy || !version || !artifactUrl || !sha256 || !signature} onClick={() => void submitRelease()}>创建发布</button>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>部署计划</h2><span className="muted">审批后预检</span></div>
          <div className="card-body stack">
            <div className="field"><label htmlFor="deployment-release">发布</label><select id="deployment-release" value={selectedRelease} onChange={(event) => setSelectedRelease(event.target.value)}>{releases.map((release) => <option key={release.id} value={release.id}>{release.version} · {release.status}</option>)}</select></div>
            <div className="field"><label htmlFor="deployment-env">环境</label><select id="deployment-env" value={environment} onChange={(event) => setEnvironment(event.target.value)}><option value="staging">staging</option><option value="production">production</option></select></div>
            <div className="field"><label htmlFor="deployment-strategy">策略</label><select id="deployment-strategy" value={strategy} onChange={(event) => setStrategy(event.target.value as 'rolling' | 'canary')}><option value="rolling">rolling</option><option value="canary">canary</option></select></div>
            {strategy === 'canary' ? <div className="field"><label htmlFor="deployment-canary">灰度比例</label><input id="deployment-canary" type="number" min={1} max={100} value={canaryPercent} onChange={(event) => setCanaryPercent(Number(event.target.value))} /></div> : null}
            <button type="button" className="btn btn-outline" disabled={busy || !selectedRelease} onClick={() => void submitDeployment()}>创建部署计划</button>
          </div>
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>部署状态</h2><span className="muted">{deployments.length} 条</span></div>
        <div className="card-body stack">
          {deployments.map((deployment) => (
            <div key={deployment.id} className="incident-evidence">
              <div className="row-between">
                <div><strong>{deployment.environment} · {deployment.strategy}</strong><div className="muted">{releases.find((release) => release.id === deployment.releaseId)?.version ?? deployment.releaseId.slice(0, 8)} · {formatTime(deployment.createdAt)}</div></div>
                <span className={`badge ${statusClass(deployment.status)}`}>{deployment.status}</span>
              </div>
              {deployment.canaryPercent ? <p className="muted">灰度 {deployment.canaryPercent}%</p> : null}
              {deployment.preflight ? <p className="muted">预检：{deployment.preflight.ok ? '通过' : String(deployment.preflight.error ?? '失败')}</p> : null}
              {deployment.execution ? <p className="muted">执行：{deployment.execution.ok ? '成功' : '失败或未完成'}</p> : null}
              <div className="row-sm" style={{ marginTop: 8 }}>
                {deployment.status === 'pending' ? <><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void decide(deployment.id, 'approve')}>批准</button><button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void decide(deployment.id, 'reject')}>拒绝</button></> : null}
                {['approved', 'pending'].includes(deployment.status) ? <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void preflight(deployment.id)}>制品预检</button> : null}
                {['approved', 'preflighted'].includes(deployment.status) ? <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void execute(deployment.id)}>执行部署</button> : null}
                {['approved', 'preflighted', 'deployed'].includes(deployment.status) ? <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void rollback(deployment.id)}>回滚</button> : null}
              </div>
            </div>
          ))}
          {deployments.length === 0 ? <p className="muted">暂无部署计划</p> : null}
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>发布记录</h2><span className="muted">{releases.length} 条</span></div>
        <div className="card-body">
          <table className="table"><thead><tr><th>版本</th><th>应用系统</th><th>制品</th><th>状态</th><th>创建时间</th></tr></thead><tbody>
            {releases.map((release) => <tr key={release.id}><td className="mono">{release.version}</td><td>{appSystems.find((system) => system.id === release.appSystemId)?.name ?? '—'}</td><td className="mono">{release.artifactUrl}</td><td><span className="badge badge-ok">{release.status}</span></td><td>{formatTime(release.createdAt)}</td></tr>)}
          </tbody></table>
        </div>
      </section>
    </DesignShell>
  );
}
