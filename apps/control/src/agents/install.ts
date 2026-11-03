import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Pool } from 'pg';
import { SESSION_COOKIE, readSession } from '../auth/session.js';
import { createMembershipRepository } from '../tenancy/db-repo.js';
import { resolveTenantContext } from '../tenancy/context.js';
import { ForbiddenError, requirePermission } from '../tenancy/guards.js';

export type InstallOs = 'linux' | 'windows';

export interface InstallOptions {
  readonly distDir: string;
  readonly publicUrl?: string;
}

function safe(value: string): string {
  return value.replaceAll("'", "'\\''");
}

function scriptUrl(baseUrl: string, tenantId: string, token: string, os: InstallOs): string {
  const path = os === 'linux' ? 'install.sh' : 'install.ps1';
  return `${baseUrl}/api/agents/${path}?tenantId=${encodeURIComponent(tenantId)}&token=${encodeURIComponent(token)}`;
}

export function buildInstallCommand(input: {
  os: InstallOs;
  baseUrl: string;
  tenantId: string;
  token: string;
}): string {
  const url = scriptUrl(input.baseUrl, input.tenantId, input.token, input.os);
  if (input.os === 'linux') {
    return `curl -fsSL '${url}' | sudo bash`;
  }
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr '${url}' -UseBasicParsing | iex"`;
}

export function buildInstallScript(input: {
  os: InstallOs;
  baseUrl: string;
  tenantId: string;
  token: string;
}): string {
  if (input.os === 'linux') {
    return `#!/usr/bin/env bash
set -euo pipefail
CONTROL_URL='${safe(input.baseUrl)}'
TENANT_ID='${safe(input.tenantId)}'
TOKEN='${safe(input.token)}'
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$CONTROL_URL/api/agents/binary?os=linux&arch=$ARCH&token=$TOKEN" -o "$TMP"
install -m 0755 "$TMP" /usr/local/bin/opsagent-agent
install -d -m 0755 /etc/opsagent
cat > /etc/opsagent/agent.env <<EOF
OPSAGENT_CONTROL_URL=$CONTROL_URL
OPSAGENT_TENANT_ID=$TENANT_ID
OPSAGENT_AGENT_ENROLLMENT_TOKEN=$TOKEN
EOF
chmod 0600 /etc/opsagent/agent.env
cat > /etc/systemd/system/opsagent-agent.service <<'EOF'
[Unit]
Description=OpsAgent host agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/opsagent/agent.env
ExecStart=/usr/local/bin/opsagent-agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now opsagent-agent
echo "OpsAgent agent installed and started"
`;
  }
  const ps = (value: string): string => value.replaceAll("'", "''");
  return `$ErrorActionPreference = 'Stop'
$ControlUrl = '${ps(input.baseUrl)}'
$TenantId = '${ps(input.tenantId)}'
$Token = '${ps(input.token)}'
$Dir = Join-Path $env:ProgramData 'OpsAgent'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Binary = Join-Path $Dir 'opsagent-agent.exe'
Invoke-WebRequest -Uri "$ControlUrl/api/agents/binary?os=windows&arch=amd64&token=$Token" -OutFile $Binary -UseBasicParsing
[Environment]::SetEnvironmentVariable('OPSAGENT_CONTROL_URL', $ControlUrl, 'Machine')
[Environment]::SetEnvironmentVariable('OPSAGENT_TENANT_ID', $TenantId, 'Machine')
[Environment]::SetEnvironmentVariable('OPSAGENT_AGENT_ENROLLMENT_TOKEN', $Token, 'Machine')
$Action = $Binary
schtasks /Create /TN "OpsAgent" /TR $Action /SC ONSTART /RU SYSTEM /RL HIGHEST /F | Out-Null
schtasks /Run /TN "OpsAgent" | Out-Null
Write-Host "OpsAgent agent installed and started"
`;
}

async function userContext(pool: Pool, request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await readSession(pool, token);
  if (!session?.selectedTenantId) return null;
  return resolveTenantContext(
    { userId: session.user.id, tenantId: session.selectedTenantId },
    createMembershipRepository(pool),
  );
}

function tokenMatches(expected: string | undefined, provided: unknown): boolean {
  return Boolean(expected && typeof provided === 'string' && provided === expected);
}

export function registerAgentInstallRoutes(
  app: FastifyInstance,
  pool: Pool,
  enrollmentToken: string | undefined,
  options: InstallOptions,
): void {
  function baseUrl(request: FastifyRequest): string {
    return options.publicUrl ?? `${request.protocol}://${request.headers.host ?? '127.0.0.1:8080'}`;
  }

  app.get<{ Querystring: { os?: string } }>(
    '/api/agents/install-command',
    async (request, reply) => {
      const ctx = await userContext(pool, request);
      if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
      try {
        requirePermission(ctx, 'agent.manage');
      } catch (error) {
        if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
        throw error;
      }
      if (!enrollmentToken) {
        return reply.code(503).send({ error: 'enrollment_token_not_configured' });
      }
      const os = request.query.os === 'windows' ? 'windows' : 'linux';
      const url = baseUrl(request);
      return reply.send({
        os,
        command: buildInstallCommand({
          os,
          baseUrl: url,
          tenantId: ctx.tenantId,
          token: enrollmentToken,
        }),
      });
    },
  );

  app.get<{ Querystring: { tenantId?: string; token?: string } }>(
    '/api/agents/install.sh',
    async (request, reply) => {
      if (!tokenMatches(enrollmentToken, request.query.token)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!request.query.tenantId) return reply.code(400).send({ error: 'tenant_required' });
      return reply
        .header('content-type', 'text/x-shellscript; charset=utf-8')
        .send(
          buildInstallScript({
            os: 'linux',
            baseUrl: baseUrl(request),
            tenantId: request.query.tenantId,
            token: request.query.token ?? '',
          }),
        );
    },
  );

  app.get<{ Querystring: { tenantId?: string; token?: string } }>(
    '/api/agents/install.ps1',
    async (request, reply) => {
      if (!tokenMatches(enrollmentToken, request.query.token)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!request.query.tenantId) return reply.code(400).send({ error: 'tenant_required' });
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .send(
          buildInstallScript({
            os: 'windows',
            baseUrl: baseUrl(request),
            tenantId: request.query.tenantId,
            token: request.query.token ?? '',
          }),
        );
    },
  );

  app.get<{ Querystring: { os?: string; arch?: string; token?: string } }>(
    '/api/agents/binary',
    async (request, reply) => {
      if (!tokenMatches(enrollmentToken, request.query.token)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const os = request.query.os === 'windows' ? 'windows' : 'linux';
      const arch = request.query.arch === 'arm64' ? 'arm64' : 'amd64';
      const name = os === 'windows' ? `opsagent-agent-windows-${arch}.exe` : `opsagent-agent-linux-${arch}`;
      const dir = isAbsolute(options.distDir) ? options.distDir : join(process.cwd(), options.distDir);
      const file = join(dir, name);
      if (!existsSync(file)) {
        return reply.code(404).send({ error: 'binary_not_available' });
      }
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${name}"`)
        .send(createReadStream(file));
    },
  );
}
