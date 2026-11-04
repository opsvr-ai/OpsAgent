# OpsAgent Desktop

P1.5 薄客户端：Electron 外壳加载 OpsAgent Web，复用登录、会话、审批和通知能力，并通过系统密钥链保存桌面设备凭证。

## 启动

先启动控制面和 Web：

```bash
pnpm dev:docker
```

然后：

```bash
pnpm --filter @opsagent/desktop start
```

默认加载 `http://127.0.0.1:5173`，可通过环境变量覆盖：

```bash
OPSAGENT_DESKTOP_URL=http://127.0.0.1:8080 pnpm --filter @opsagent/desktop start
```

如果 Electron 二进制下载失败，可配置镜像后重新安装：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm install
```

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
