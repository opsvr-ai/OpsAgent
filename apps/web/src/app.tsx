import { useEffect, useState } from 'react';
import type { HomeResponse, MeResponse } from '@opsagent/contracts';
import { createSession, getHome, getMe } from './api/client.js';
import { Login } from './routes/login.js';
import { Home } from './routes/home.js';
import { Chat } from './routes/chat.js';

export function App() {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

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
  if (!home) return <div className="loading">加载工作台…</div>;
  return <Home me={me} home={home} onStartSession={() => void startSession()} />;
}
