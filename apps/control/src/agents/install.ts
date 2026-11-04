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
ROOT='/opt/opsagent'
BIN_DIR="$ROOT/bin"
CONFIG_DIR="$ROOT/config"
TOOLS_DIR="$ROOT/tools"
LOG_DIR="$ROOT/logs"
SNAPSHOT_DIR="$ROOT/snapshots"
RUN_DIR="$ROOT/run"
CONFIG_FILE="$CONFIG_DIR/agent.env"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
systemctl stop opsagent-agent 2>/dev/null || true
install -d -m 0750 "$ROOT" "$BIN_DIR" "$CONFIG_DIR" "$TOOLS_DIR" "$LOG_DIR" "$SNAPSHOT_DIR" "$RUN_DIR"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$CONTROL_URL/api/agents/binary?os=linux&arch=$ARCH&token=$TOKEN" -o "$TMP"
install -m 0755 "$TMP" "$BIN_DIR/opsagent-agent"
cat > "$CONFIG_FILE" <<EOF
OPSAGENT_HOME=$ROOT
OPSAGENT_CONTROL_URL=$CONTROL_URL
OPSAGENT_TENANT_ID=$TENANT_ID
OPSAGENT_AGENT_ENROLLMENT_TOKEN=$TOKEN
OPSAGENT_AGENT_CONFIG=$CONFIG_FILE
OPSAGENT_TOOLS_DIR=$TOOLS_DIR
OPSAGENT_LOG_DIR=$LOG_DIR
OPSAGENT_SNAPSHOT_DIR=$SNAPSHOT_DIR
OPSAGENT_AGENT_SERVICE=opsagent-agent
EOF
chmod 0600 "$CONFIG_FILE"
cat > /etc/systemd/system/opsagent-agent.service <<'EOF'
[Unit]
Description=OpsAgent host agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/opsagent
EnvironmentFile=/opt/opsagent/config/agent.env
ExecStart=/opt/opsagent/bin/opsagent-agent
Restart=always
RestartSec=5
StandardOutput=append:/opt/opsagent/logs/stdout.log
StandardError=append:/opt/opsagent/logs/stderr.log

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/logrotate.d/opsagent <<'EOF'
/opt/opsagent/logs/*.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
}
EOF
systemctl daemon-reload
systemctl enable --now opsagent-agent
echo "OpsAgent agent installed at $ROOT and started"
echo "  binary:    $BIN_DIR/opsagent-agent"
echo "  config:    $CONFIG_FILE"
echo "  logs:      $LOG_DIR/agent.log"
echo "  snapshots: $SNAPSHOT_DIR"
`;
  }
  const ps = (value: string): string => value.replaceAll("'", "''");
  return `$ErrorActionPreference = 'Stop'
$ControlUrl = '${ps(input.baseUrl)}'
$TenantId = '${ps(input.tenantId)}'
$Token = '${ps(input.token)}'
$Root = Join-Path $env:ProgramData 'OpsAgent'
$BinDir = Join-Path $Root 'bin'
$ConfigDir = Join-Path $Root 'config'
$ToolsDir = Join-Path $Root 'tools'
$LogDir = Join-Path $Root 'logs'
$SnapshotDir = Join-Path $Root 'snapshots'
$RunDir = Join-Path $Root 'run'
$ConfigFile = Join-Path $ConfigDir 'agent.env'
New-Item -ItemType Directory -Force -Path $Root,$BinDir,$ConfigDir,$ToolsDir,$LogDir,$SnapshotDir,$RunDir | Out-Null
$Binary = Join-Path $BinDir 'opsagent-agent.exe'
Invoke-WebRequest -Uri "$ControlUrl/api/agents/binary?os=windows&arch=amd64&token=$Token" -OutFile $Binary -UseBasicParsing
@(
  "OPSAGENT_HOME=$Root",
  "OPSAGENT_CONTROL_URL=$ControlUrl",
  "OPSAGENT_TENANT_ID=$TenantId",
  "OPSAGENT_AGENT_ENROLLMENT_TOKEN=$Token",
  "OPSAGENT_AGENT_CONFIG=$ConfigFile",
  "OPSAGENT_TOOLS_DIR=$ToolsDir",
  "OPSAGENT_LOG_DIR=$LogDir",
  "OPSAGENT_SNAPSHOT_DIR=$SnapshotDir",
  "OPSAGENT_AGENT_SERVICE=OpsAgent"
) | Set-Content -Encoding UTF8 $ConfigFile
[Environment]::SetEnvironmentVariable('OPSAGENT_HOME', $Root, 'Machine')
[Environment]::SetEnvironmentVariable('OPSAGENT_CONTROL_URL', $ControlUrl, 'Machine')
[Environment]::SetEnvironmentVariable('OPSAGENT_TENANT_ID', $TenantId, 'Machine')
[Environment]::SetEnvironmentVariable('OPSAGENT_AGENT_ENROLLMENT_TOKEN', $Token, 'Machine')
[Environment]::SetEnvironmentVariable('OPSAGENT_AGENT_CONFIG', $ConfigFile, 'Machine')
[Environment]::SetEnvironmentVariable('OPSAGENT_LOG_DIR', $LogDir, 'Machine')
[Environment]::SetEnvironmentVariable('OPSAGENT_SNAPSHOT_DIR', $SnapshotDir, 'Machine')
[Environment]::SetEnvironmentVariable('OPSAGENT_TOOLS_DIR', $ToolsDir, 'Machine')
$Action = $Binary
schtasks /Create /TN "OpsAgent" /TR $Action /SC ONSTART /RU SYSTEM /RL HIGHEST /F | Out-Null
schtasks /Run /TN "OpsAgent" | Out-Null
Write-Host "OpsAgent agent installed at $Root and started"
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
