//go:build linux

package main

// HTTP/gRPC 请求级计数观察器（Linux AF_PACKET 明文旁路）。
//
// 通过 AF_PACKET raw socket 抓取本机网卡上的 TCP 报文（默认所有网卡），
// 交给 http_parse.go 的流重组/HTTP 解析，按固定窗口聚合后推入
// httpWindowReporter，随心跳 httpRequestWindows 上报。
//
// 限制：
//   - 只能看到明文 HTTP/1、HTTP/2 与明文 gRPC；HTTPS/gRPC-TLS 无法解密，不计数；
//   - 需要 root 或 CAP_NET_RAW；权限不足时日志一次后自动禁用，不影响主流程；
//   - 本机内部/loopback 流量不计入（与 TCP 建连边表口径一致）。
//
// 环境变量：
//   - OPSAGENT_HTTP_METRICS=true|false       总开关（默认 true）
//   - OPSAGENT_HTTP_IFACE=eth0               监听指定网卡；空=所有网卡
//   - OPSAGENT_GRPC_PORTS=50051,9090         gRPC 端口集合
//   - OPSAGENT_HTTP_MAX_EDGES=200            每窗口边数上限
//   - OPSAGENT_HTTP_WINDOW_SECONDS=10        聚合窗口（默认与 TCP 窗口对齐）

import (
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	httpListenRefresh   = 10 * time.Second
	httpPruneInterval   = 30 * time.Second
	httpReadTimeout     = 500 * time.Millisecond
	httpSocketRcvBuf    = 4 << 20
	httpPacketBufferLen = 1 << 16
)

// httpObserverConfig 是 AF_PACKET 观察器配置。
type httpObserverConfig struct {
	enabled   bool
	iface     string
	grpcPorts map[int]bool
	maxEdges  int
	window    time.Duration
}

func httpObserverConfigFromEnv() httpObserverConfig {
	config := httpObserverConfig{
		enabled:   true,
		grpcPorts: parseHTTPPorts(env("OPSAGENT_GRPC_PORTS", httpDefaultGRPCPorts)),
		maxEdges:  httpEnvInt("OPSAGENT_HTTP_MAX_EDGES", httpDefaultMaxEdges, 1, 2000),
		window:    connEnvSeconds("OPSAGENT_HTTP_WINDOW_SECONDS", httpDefaultWindow, time.Second, 600*time.Second),
	}
	if raw := strings.TrimSpace(os.Getenv("OPSAGENT_HTTP_METRICS")); raw != "" {
		if enabled, err := strconv.ParseBool(raw); err == nil {
			config.enabled = enabled
		}
	}
	config.iface = strings.TrimSpace(os.Getenv("OPSAGENT_HTTP_IFACE"))
	return config
}

func httpEnvInt(key string, fallback, minimum, maximum int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func parseHTTPPorts(raw string) map[int]bool {
	ports := map[int]bool{}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		port, err := strconv.Atoi(item)
		if err != nil || port <= 0 || port > 65535 {
			continue
		}
		ports[port] = true
	}
	return ports
}

// startHTTPObserver 启动 HTTP/gRPC 明文请求计数观察器。
// OPSAGENT_HTTP_METRICS=false 或缺少 CAP_NET_RAW 时返回 nil（日志一次，不影响主流程）。
func startHTTPObserver() *httpWindowReporter {
	config := httpObserverConfigFromEnv()
	if !config.enabled {
		log.Printf("http request observer disabled by OPSAGENT_HTTP_METRICS")
		return nil
	}
	fd, err := openHTTPPacketSocket(config.iface)
	if err != nil {
		log.Printf(
			"http request observer disabled: cannot open AF_PACKET socket (需要 root 或 CAP_NET_RAW): %v",
			err,
		)
		return nil
	}
	reporter := newHTTPWindowReporter(config.window)
	observer := &httpObserver{
		config:     config,
		reporter:   reporter,
		engine:     newHTTPFlowEngine(httpDefaultMaxFlows),
		aggregator: newHTTPWindowAggregator(config.window, config.maxEdges),
		localIPs:   newConnLocalIPSet(),
		processes:  newConnProcessCache(connProcessCacheTTL),
		listening:  map[int]bool{},
		services:   map[int]string{},
	}
	go observer.run(fd)
	return reporter
}

// openHTTPPacketSocket 打开 AF_PACKET raw socket 并绑定网卡（ifindex=0 表示所有网卡）。
func openHTTPPacketSocket(iface string) (int, error) {
	protocol := htonsHTTP(unix.ETH_P_ALL)
	fd, err := unix.Socket(unix.AF_PACKET, unix.SOCK_RAW|unix.SOCK_CLOEXEC, int(protocol))
	if err != nil {
		return -1, err
	}
	ifindex := 0
	if iface != "" {
		device, err := net.InterfaceByName(iface)
		if err != nil {
			unix.Close(fd)
			return -1, err
		}
		ifindex = device.Index
	}
	sockaddr := &unix.SockaddrLinklayer{Protocol: protocol, Ifindex: ifindex}
	if err := unix.Bind(fd, sockaddr); err != nil {
		unix.Close(fd)
		return -1, err
	}
	// 抓包不要阻塞窗口 flush：SO_RCVTIMEO 让 Recvfrom 定期返回 EAGAIN。
	_ = unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_RCVBUF, httpSocketRcvBuf)
	timeout := unix.NsecToTimeval(int64(httpReadTimeout))
	_ = unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &timeout)
	return fd, nil
}

func htonsHTTP(value uint16) uint16 {
	return value<<8 | value>>8
}

// httpObserver 是观察器运行态（单 goroutine 持有，无需加锁）。
type httpObserver struct {
	config     httpObserverConfig
	reporter   *httpWindowReporter
	engine     *httpFlowEngine
	aggregator *httpWindowAggregator
	localIPs   *connLocalIPSet
	processes  *connProcessCache

	listening map[int]bool
	services  map[int]string
	localAt   time.Time
	listenAt  time.Time
	pruneAt   time.Time
}

func (observer *httpObserver) run(fd int) {
	defer unix.Close(fd)
	log.Printf(
		"http request observer started: iface=%q window=%s maxEdges=%d grpcPorts=%v",
		observer.config.iface, observer.config.window, observer.config.maxEdges, observer.config.grpcPorts,
	)
	buffer := make([]byte, httpPacketBufferLen)
	now := time.Now()
	observer.refresh(now)
	observer.aggregator.Start(now)
	for {
		n, _, err := unix.Recvfrom(fd, buffer, 0)
		now = time.Now()
		if err != nil {
			if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EINTR) {
				observer.maybeFlush(now)
				continue
			}
			if errors.Is(err, unix.ENOBUFS) {
				observer.aggregator.AddDropped(1)
				observer.maybeFlush(now)
				continue
			}
			log.Printf("http request observer stopped: %v", err)
			return
		}
		if n > 0 {
			if packet, ok := decodeHTTPFrame(buffer[:n]); ok {
				observer.engine.HandlePacket(packet, now)
				observer.aggregator.CountPacket()
			}
		}
		observer.maybeFlush(now)
	}
}

// maybeFlush 处理待上报观测、刷新监听表/本机 IP、到期窗口 push。
func (observer *httpObserver) maybeFlush(now time.Time) {
	for _, observation := range observer.engine.Drain() {
		edge, ok := mapHTTPObservation(
			observation,
			observer.localIPs.isLocal,
			observer.listening,
			observer.services,
			observer.config.grpcPorts,
		)
		if !ok {
			continue
		}
		observer.aggregator.Add(edge, now)
	}
	observer.aggregator.AddDropped(observer.engine.TakeDropped())
	observer.refresh(now)
	if window := observer.aggregator.FlushIfDue(now, observer.engine.FlowCount()); window != nil {
		observer.reporter.pushAt(*window, now)
		if httpObserverDebug() {
			requests := 0
			details := make([]string, 0, len(window.Requests))
			for index, edge := range window.Requests {
				requests += edge.Requests
				if index < 5 {
					details = append(details, fmt.Sprintf(
						"%s/%s/%s/%s:%d->%s:%d req=%d err=%d",
						edge.Direction, edge.Protocol, edge.Method,
						edge.LocalAddress, edge.LocalPort,
						edge.PeerAddress, edge.PeerPort,
						edge.Requests, edge.Errors,
					))
				}
			}
			log.Printf(
				"http request window: %s..%s packets=%d flows=%d dropped=%d edges=%d requests=%d %s",
				window.Start, window.End, window.Stats.Packets, window.Stats.Flows,
				window.Stats.Dropped, len(window.Requests), requests, strings.Join(details, "; "),
			)
		}
	}
}

// httpObserverDebug 打开后每个窗口打印一行摘要（OPSAGENT_HTTP_DEBUG=true），
// 便于上线前小流量验证；默认关闭避免日志噪音。
func httpObserverDebug() bool {
	raw := strings.TrimSpace(os.Getenv("OPSAGENT_HTTP_DEBUG"))
	if raw == "" {
		return false
	}
	enabled, err := strconv.ParseBool(raw)
	return err == nil && enabled
}

// refresh 周期性刷新本机 IP 集合（30s）、本地监听端口→服务名（10s）、流清理（30s）。
func (observer *httpObserver) refresh(now time.Time) {
	if observer.localAt.IsZero() || now.Sub(observer.localAt) >= connLocalIPRefresh {
		observer.localIPs.refresh(now)
		observer.localAt = now
	}
	if observer.listenAt.IsZero() || now.Sub(observer.listenAt) >= httpListenRefresh {
		ports, services := scanHTTPListeners(observer.processes, now)
		observer.listening = ports
		observer.services = services
		observer.listenAt = now
		servicePorts := make(map[int]bool, len(ports)+len(observer.config.grpcPorts))
		for port := range ports {
			servicePorts[port] = true
		}
		for port := range observer.config.grpcPorts {
			servicePorts[port] = true
		}
		observer.engine.SetServicePorts(servicePorts)
	}
	if observer.pruneAt.IsZero() || now.Sub(observer.pruneAt) >= httpPruneInterval {
		observer.engine.Prune(now)
		observer.pruneAt = now
	}
}

// scanHTTPListeners 扫描 /proc/net/tcp{,6} 的 LISTEN 端口，并尽力归因进程服务名，
// 用于方向兜底与“本地服务名含 grpc”识别。失败时返回空表，不影响抓包主流程。
func scanHTTPListeners(processes *connProcessCache, now time.Time) (map[int]bool, map[int]string) {
	ports := map[int]bool{}
	services := map[int]string{}
	portInode := map[int]uint64{}
	for _, source := range []struct {
		path string
		v6   bool
	}{
		{path: "/proc/net/tcp", v6: false},
		{path: "/proc/net/tcp6", v6: true},
	} {
		body, err := os.ReadFile(source.path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(body), "\n") {
			row, ok := parseProcNetLine(line, source.v6)
			if !ok || row.State != procTCPListen || row.LocalPort <= 0 {
				continue
			}
			ports[row.LocalPort] = true
			if row.Inode != 0 {
				portInode[row.LocalPort] = row.Inode
			}
		}
	}
	if len(portInode) == 0 {
		return ports, services
	}
	wanted := make(map[uint64]struct{}, len(portInode))
	for _, inode := range portInode {
		wanted[inode] = struct{}{}
	}
	owners := scanConnInodeOwners(wanted)
	for port, inode := range portInode {
		pid := owners[inode]
		if pid <= 0 {
			continue
		}
		info := processes.get(pid, now)
		if service := info.service(); service != "" {
			services[port] = service
		}
	}
	return ports, services
}
