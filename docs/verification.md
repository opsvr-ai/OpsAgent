# Live verification

## SSH driver

An in-process `ssh2` server is started by `apps/control/test/ssh-driver.integration.test.ts`.
It accepts password authentication and handles `exec`; the connector executes the
allowlisted `uptime` check.

```bash
pnpm --filter @opsagent/control test test/ssh-driver.integration.test.ts
```

## MySQL-compatible driver

Docker image pulls were not usable in the development environment, so the live
check was run against a portable MariaDB 11.4.5 server on port 3307.

```powershell
# one-time: install system tables and start the server
$root = "$env:TEMP\mariadb-11.4.5\mariadb-11.4.5-winx64"
& "$root\bin\mysql_install_db.exe" --datadir="$env:TEMP\mariadb-data" --password=root --port=3307
& "$root\bin\mysqld.exe" --no-defaults --basedir=$root --datadir="$env:TEMP\mariadb-data" --port=3307 --bind-address=127.0.0.1

# run the integration suite
$env:RUN_INTEGRATION = '1'
$env:MYSQL_TEST_URL = 'mysql://root:root@127.0.0.1:3307/opsagent_test'
pnpm --filter @opsagent/control test test/drivers.integration.test.ts
```

Observed result: 3 tests passed (PostgreSQL, Redis, MySQL-compatible query).

The Docker path remains available through the `test-tools` compose profile once
the image can be pulled.
