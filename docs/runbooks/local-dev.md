# Local development

## Prerequisites

- Node.js >= 24.9
- pnpm 11
- Docker Desktop / Docker Engine with Compose

## Bootstrap

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm test
pnpm build
```

## Control plane

```bash
pnpm --filter @opsagent/control dev
curl http://localhost:8080/healthz
```

Expected:

```json
{"status":"ok","service":"opsagent-control"}
```

## Contracts

```bash
pnpm --filter @opsagent/contracts test
```

## Current scope

This repository currently contains the P1 Sprint 1 scaffold:

- pnpm workspace
- shared role/permission/theme/runtime contracts
- control-plane health endpoint
- PostgreSQL/pgvector, Redis, MinIO local compose

Next: database schema/RLS, local admin/LDAP, tenant context, audit, runtime contract, web login.
