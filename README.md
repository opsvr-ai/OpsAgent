# OpsAgent

Multi-tenant AIOps agent platform: dsh runtime + control plane + connector tools + Commander + Eino-based host agents.

> Status: development started. Current increment = P1 Sprint 1 foundation: workspace, contracts, control health, PostgreSQL/RLS/seed, LDAP + local-admin login/session, tenant select/home, audit writer/redaction. Current: 9 connector logic + config/list/health; HTTP probes for Prom/Grafana/Alertmanager/ClickHouse/Zabbix. Next = scenario UI/scheduling, DB/Redis/SSH probes, DshRuntime.

## Quick start

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm test
pnpm build
pnpm --filter @opsagent/control dev
curl http://localhost:8080/healthz
```

## Layout

```text
apps/control          Fastify control plane
packages/contracts    roles, permissions, theme, runtime/API contracts
runtime/              dsh bundle (next)
apps/web              React console (next)
design/               HTML design prototypes
docs/design/          architecture, plan, contracts, audits
```

## Tests

```bash
pnpm test             # unit/component tests\npnpm e2e              # Playwright G1 browser flow
pnpm build            # TypeScript builds
```

## Next

1. PostgreSQL schema + RLS + seed.
2. LDAP/local-admin auth + sessions.
3. Tenant context / multi-role guards.
4. Audit writer + redaction.
5. Fake/dsh runtime + mock tools + approvals.
6. Web login/home/theme.
7. G1 E2E.

Plan: `docs/design/plans/2026-11-03-p1-sprint-1.md`.
