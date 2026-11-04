# OpsAgent Desktop

P1.5 薄客户端：Electron 外壳加载 OpsAgent Web，复用登录、会话、审批和通知能力，并通过系统密钥链保存桌面设备凭证。

Desktop 作为独立 npm 包维护，不在根 pnpm workspace 中，避免控制面容器安装 Electron 构建依赖。首次使用需在 `apps/desktop` 内单独安装依赖。

## 启动

先启动控制面和 Web：

```bash
pnpm dev:docker
```

然后：

```bash
cd apps/desktop
pnpm install --ignore-workspace
pnpm start
```

默认加载 `http://127.0.0.1:5173`，可通过环境变量覆盖：

```bash
cd apps/desktop
OPSAGENT_DESKTOP_URL=http://127.0.0.1:8080 pnpm start
```

如果 Electron 二进制下载失败，可配置镜像后重新安装：

```bash
cd apps/desktop
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm install --ignore-workspace
```

## 打包

生成 Windows 免安装目录：

```bash
cd apps/desktop
pnpm package:dir
```

产物：

```text
apps/desktop/release/win-unpacked/OpsAgent.exe
```

生成 Windows 便携 ZIP：

```bash
cd apps/desktop
pnpm package:zip
```

产物：

```text
apps/desktop/release/OpsAgent-win-x64.zip
```

生成 Windows NSIS 安装包：

```bash
cd apps/desktop
pnpm package:win
```

产物：

```text
apps/desktop/release/OpsAgent Setup 0.2.0.exe
```

安装包已验证可生成；当前未配置代码签名证书，Windows 会显示未签名提示。

## 自动更新

安装版启动时如果设置：

```bash
OPSAGENT_DESKTOP_UPDATE_URL=https://updates.example/opsagent/
```

会通过 `electron-updater` 检查更新。更新源需要放置：

```text
latest.yml
OpsAgent Setup 0.2.0.exe
OpsAgent Setup 0.2.0.exe.blockmap
```

下载完成后提示重启安装。当前更新包未做代码签名，生产环境应配置证书。

生成更新目录：

```bash
cd apps/desktop
pnpm package:feed
```

产物：

```text
apps/desktop/release/feed/latest.yml
apps/desktop/release/feed/OpsAgent Setup 0.2.0.exe
apps/desktop/release/feed/OpsAgent Setup 0.2.0.exe.blockmap
```

将该目录部署到静态服务器后，设置 `OPSAGENT_DESKTOP_UPDATE_URL` 即可。

控制面也可以直接托管该目录：

```bash
OPSAGENT_DESKTOP_UPDATE_DIR=/app/apps/desktop/release/feed
```

启动后访问：

```text
http://127.0.0.1:8080/desktop/updates/latest.yml
```

Desktop 设置：

```bash
OPSAGENT_DESKTOP_UPDATE_URL=http://127.0.0.1:8080/desktop/updates/
```

## 代码签名

配置 Electron Builder 标准环境变量后重新打包：

```bash
CSC_LINK=/path/to/certificate.pfx
CSC_KEY_PASSWORD=***
cd apps/desktop
pnpm package:win
```

配置后安装包会使用证书签名；未配置时保持未签名。

开发环境自签名验证：

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=OpsAgent Dev' -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy Exportable
$pwd = ConvertTo-SecureString 'OpsAgent-Dev' -Force -AsPlainText
$pfx = Join-Path $env:TEMP 'opsagent-dev-sign.pfx'
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pwd
$env:CSC_LINK = $pfx
$env:CSC_KEY_PASSWORD = 'OpsAgent-Dev'
cd apps/desktop
pnpm package:win
```

已实测可生成签名安装包；因自签名根证书不受信任，Windows 会显示 Unknown Publisher。

打包脚本会自动定位本机 Electron 二进制，不依赖 GitHub 下载。

## 安全

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- 外部链接交给系统浏览器
- 设备凭证通过 Electron `safeStorage`（Windows DPAPI / macOS Keychain）保存
- 预加载暴露：
  - `opsagentDesktop.secureStore(value)`
  - `opsagentDesktop.secureLoad()`

## 当前范围

- 复用 Web 的登录、会话、审批、通知
- 桌面系统密钥链存储接口
- 本地执行节点（mTLS、内网 SSH/终端）仍属于 P2
