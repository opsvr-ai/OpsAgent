import { useEffect, useState } from 'react';
import type { HomeResponse, MeResponse } from '@opsagent/contracts';
import { getHome, getMe } from './api/client.js';
import { Login } from './routes/login.js';
import { Home } from './routes/home.js';

export function App() {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  const [home, setHome] = useState<HomeResponse | null>(null);

  async function refresh() {
    const current = await getMe();
    setMe(current);
    if (current) setHome(await getHome());
  }

  useEffect(() => {
    void refresh().catch(() => setMe(null));
  }, []);

  if (me === undefined) return <div className="loading">加载中…</div>;
  if (me === null) return <Login onSuccess={() => void refresh()} />;
  if (!home) return <div className="loading">加载工作台…</div>;
  return <Home me={me} home={home} />;
}
