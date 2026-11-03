import { useEffect, useState } from 'react';
import type { HomeResponse, MeResponse } from '@opsagent/contracts';
import { createSession, getHome, getMe } from './api/client.js';
import { Login } from './routes/login.js';
import { Home } from './routes/home.js';
import { Chat } from './routes/chat.js';
import { Scenarios } from './routes/scenarios.js';
import { Audit } from './routes/audit.js';
import { Shares } from './routes/shares.js';
import { Studio } from './routes/studio.js';
import { Incidents } from './routes/incidents.js';
import { Approvals } from './routes/approvals.js';

export function App() {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<'home' | 'scenarios' | 'audit' | 'shares' | 'studio' | 'incidents' | 'approvals'>('home');

  async function refresh() {
    const current = await getMe();
    setMe(current);
    if (current) setHome(await getHome());
  }

  async function startSession() {
    if (!home) return;
    const session = await createSession(home.tenantId, home.roleView);
    setSessionId(session.sessionId);
  }

  useEffect(() => {
    void refresh().catch(() => setMe(null));
  }, []);

  if (me === undefined) return <div className="loading">加载中…</div>;
  if (me === null) return <Login onSuccess={() => void refresh()} />;
  if (sessionId) {
    return (
      <Chat
        sessionId={sessionId}
        roleView={home?.roleView ?? 'default'}
        onBack={() => setSessionId(null)}
      />
    );
  }
  if (view === 'scenarios') return <Scenarios onBack={() => setView('home')} />;
  if (view === 'audit') return <Audit onBack={() => setView('home')} />;
  if (view === 'shares') return <Shares onBack={() => setView('home')} />;
  if (view === 'studio') return <Studio onBack={() => setView('home')} />;
  if (view === 'incidents') return <Incidents onBack={() => setView('home')} />;
  if (view === 'approvals') return <Approvals onBack={() => setView('home')} />;
  if (!home) return <div className="loading">加载工作台…</div>;
  return (
    <Home
      me={me}
      home={home}
      onStartSession={() => void startSession()}
      onOpenScenarios={() => setView('scenarios')}
      onOpenAudit={() => setView('audit')}
      onOpenShares={() => setView('shares')}
      onOpenStudio={() => setView('studio')}
      onOpenIncidents={() => setView('incidents')}
      onOpenApprovals={() => setView('approvals')}
    />
  );
}
