import type { HomeResponse, MeResponse } from '@opsagent/contracts';

export interface HomeProps {
  readonly me: MeResponse;
  readonly home: HomeResponse;
}

export function Home({ me, home }: HomeProps) {
  const tenant = me.tenants.find((item) => item.id === home.tenantId);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">OpsAgent</div>
        <div className="tenant">
          <strong>{tenant?.name ?? home.tenantId}</strong>
          <span>{tenant?.slug ?? 'tenant'}</span>
        </div>
        <nav>
          <a href="#home" className="active">工作台</a>
          <a href="#incidents">事件指挥</a>
          <a href="#agents">服务器 Agent</a>
          <a href="#knowledge">知识中心</a>
        </nav>
      </aside>
      <main className="page">
        <header>
          <div className="eyebrow">Role view</div>
          <h1>{home.roleView}</h1>
          <span className="muted">{me.user.displayName}</span>
        </header>
        <section className="cards">
          {home.cards.map((card) => (
            <article key={card.id} className="card">
              <h2>{card.title}</h2>
              <p className="muted">当前租户 · {tenant?.name ?? home.tenantId}</p>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
