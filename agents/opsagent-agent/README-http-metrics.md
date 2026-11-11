# Agent HTTP/gRPC 请求级计数（AF_PACKET 明文旁路）

> 实现：`http_parse.go`（纯解析/流重组/窗口）、`http_observe_linux.go`（AF_PACKET 抓包）、
> `http_observe_other.go`（非 Linux 空实现）。心跳字段：`httpRequestWindows`，
> 契约见 `packages/contracts/src/topology.ts` 的 `HttpRequestWindowReport`。

## 能力与边界

在 Agent 主机上用 AF_PACKET raw socket 旁路抓取本机网卡 TCP 明文流量，解析
HTTP/1 请求行与 HTTP/2 HEADERS 帧，按固定窗口统计「哪台主机/服务向谁发了多少
请求、多少失败」，随心跳上报 Control。

**只能看到明文**：

- 支持：HTTP/1.x、h2c（明文 HTTP/2）、明文 gRPC。
- 不支持：HTTPS（TLS）、gRPC-TLS、HTTP/3；TLS 流量会被识别并跳过，不会误报。
- 不解析/不存储请求头、URL、Body 等内容，只统计方法、协议、端点和计数。

**权限要求**：需要 root 或 `CAP_NET_RAW`。权限不足时 Agent 启动日志打印一次
`http request observer disabled: cannot open AF_PACKET socket`，随后自动禁用该
能力，Agent 注册、心跳、TCP 建连边表等主流程不受影响。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `OPSAGENT_HTTP_METRICS` | `true` | 总开关；`false` 关闭请求级计数 |
| `OPSAGENT_HTTP_IFACE` | 空 | 只监听指定网卡（如 `eth0`）；空=所有网卡 |
| `OPSAGENT_GRPC_PORTS` | `50051,9090` | gRPC 目标端口集合，HTTP/2 命中则标 `grpc` |
| `OPSAGENT_HTTP_MAX_EDGES` | `200` | 每窗口边数上限（1~2000） |
| `OPSAGENT_HTTP_WINDOW_SECONDS` | `10` | 聚合窗口（1~600，默认与 TCP 窗口对齐） |
| `OPSAGENT_HTTP_DEBUG` | `false` | 每个窗口打印一行摘要，供上线前小流量验证 |

## 统计口径

- 每条边：`direction + protocol + method + localAddress/localPort + peerAddress/peerPort`。
- `direction=out`：本机发起的请求（本机是客户端）；`direction=in`：对端发到本机
  监听服务的请求（本机是服务端，`service` 取自监听进程名/jar 名）。
- 两端都是本机（loopback/本机内部流量）不计入，与 TCP 建连边表口径一致。
- `requests`：窗口内解析出的请求数；`errors`：HTTP/1 收到 5xx 响应的次数
  （HTTP/2/gRPC 的状态码在帧/尾字段里，暂不计 errors）。
- `method`：HTTP/1 请求行方法（大写、截断 16 字符）；HTTP/2 从 HPACK 静态表
  尽力识别 GET/POST，识别不了记 `UNKNOWN`，gRPC 补 `POST`。
- `stats.packets`：窗口内解码的 TCP 报文数；`flows`：窗口结束时活跃 TCP 流数；
  `dropped`：乱序缺口重置/解析失败/流淘汰/超限丢弃的计数。

## 心跳示例

```json
{
  "httpRequestWindows": [{
    "start": "2026-11-11T10:00:00Z",
    "end": "2026-11-11T10:00:10Z",
    "source": "userspace",
    "requests": [
      {
        "direction": "out",
        "protocol": "http1",
        "method": "POST",
        "localAddress": "10.0.0.2",
        "localPort": 41000,
        "peerAddress": "10.0.0.9",
        "peerPort": 8080,
        "requests": 12,
        "errors": 1,
        "firstSeen": "2026-11-11T10:00:01Z",
        "lastSeen": "2026-11-11T10:00:09Z"
      }
    ],
    "stats": {"packets": 480, "flows": 6, "dropped": 0}
  }]
}
```

窗口缓存规则与 TCP 建连窗口一致：最多 12 个窗口/120s，心跳 POST 成功后清空，
失败保留重发。心跳 `metrics.httpObserver` 提供 `source/windowSeconds/edgeCount/
pendingWindows/lastWindowAt` 观测字段；非 Linux 或无权限时不出现该字段。

## 验证记录（2026-11-11）

- 单元测试 `go test ./...`：解析/流重组/窗口/上报缓存共 30+ 用例全绿（HTTP/1 单请求、
  keep-alive、Content-Length/chunked/分片、HTTP/2 HEADERS 跨包/CONTINUATION/新 stream、
  TLS 不解析、非 HTTP 不计数、seq 去重/缺口恢复、方向映射、窗口截断与 JSON 结构）。
- Windows `go build ./...` / `go vet ./...` / `go test ./...` 全绿；
  Linux 交叉 `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build/vet/test -c` 全绿。
- **非 root 权限行为**：在 WSL 以普通用户启动 Agent，日志且仅一次输出
  `http request observer disabled: cannot open AF_PACKET socket (...): operation not permitted`，
  注册/心跳/其它采集不受影响。
- **真实 AF_PACKET 抓包**：在 `unshare -rn` 用户+网络命名空间内启动 Agent（获得
  CAP_NET_RAW），用 AF_PACKET 注入真实以太网/TCP 帧（明文 HTTP/1 keep-alive 双请求 +
  h2c HEADERS/gRPC）。窗口日志实测：

```text
http request observer started: iface="" window=2s maxEdges=200 grpcPorts=map[9090:true 50051:true]
http request window: 02:23:15Z..02:23:17Z packets=8 flows=2 dropped=0 edges=3 requests=6
  in/http1/GET/127.0.0.1:8080->198.51.100.10:40000 req=2 err=0
  in/http1/POST/127.0.0.1:8080->198.51.100.10:40000 req=2 err=0
  in/grpc/POST/127.0.0.1:50051->198.51.100.11:40001 req=2 err=0
```

  验证了：Ethernet/IPv4/TCP 解码、方向判定、HTTP/1 keep-alive 多请求、HTTP/2 HEADERS
  计数、gRPC 端口识别、seq 去重（loopback 双份报文不重复计数）、窗口聚合与 0 dropped。
- 已对照 Control `apps/control/src/agents/topology_http_requests.ts`：窗口数上限 10、
  边数 200、protocol 枚举、`peerPort` 非 0 等校验与本实现输出一致。

## 已知限制

- 仅明文；HTTPS/gRPC-TLS/HTTP3 不可见。
- 抓包从 Agent 启动后开始：启动前已建立的长连接上，若没抓到 SYN，HTTP/2 方向
  识别依赖本地监听表/端口兜底，可能漏计；HTTP/1 靠请求行识别不受影响。
- 高并发/大流量下内核 socket 缓冲可能丢包，`stats.dropped` 可观测；需要更精确
  的生产环境建议先小流量验证，或后续使用 eBPF 通道。
- HTTP/2 方法只做 HPACK 静态表 GET/POST 识别；gRPC 失败计数暂缺。
- 抓包只做旁路统计，不阻塞、不注入流量；不保存请求内容。
