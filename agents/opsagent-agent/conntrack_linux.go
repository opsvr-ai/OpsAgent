//go:build linux

package main

// 建连边表窗口采集器（Linux / procfs）。
//
// 采样周期默认 5s：读取 /proc/net/tcp{,6} 的 ESTABLISHED 连接与 LISTEN 表，
// 扫 /proc/<pid>/fd 把 socket inode 归因到进程，过滤 loopback/本机内部流量，
// 用监听表判定方向（本机端口是监听端口 → in，否则 out），按 10s 固定窗口聚合
// 后推入 connWindowReporter，随心跳 connectionWindows 上报。
//
// 进程信息（comm/cmdline/service/container）缓存 30s；本机 IP 集合 30s 刷新。
// 可选合并 conn_collector 的 edges.json（eBPF 精确计数），见 conntrack_ebpf.go。
//
// 环境变量：
//   - OPSAGENT_CONN_EDGES=false                 整体关闭（默认开启）
//   - OPSAGENT_CONN_SAMPLE_INTERVAL_SECONDS=5  采样周期（1~60s）
//   - OPSAGENT_CONN_WINDOW_SECONDS=10          聚合窗口（5~600s）
//   - OPSAGENT_CONN_COLLECTOR_DIR=/var/log/conn_collector  eBPF 边表目录

import (
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	connDefaultSampleInterval = 5 * time.Second
	connDefaultWindow         = 10 * time.Second
	connMinSampleInterval     = time.Second
	connMaxSampleInterval     = 60 * time.Second
	connMinWindowSeconds      = time.Second
	connMaxWindowSeconds      = 600 * time.Second
	connLocalIPRefresh        = 30 * time.Second
	connProcessCacheTTL       = 30 * time.Second
	connProcessCacheLimit     = 4096
)

// connSamplerConfig 是采样器配置（环境变量覆盖默认值）。
type connSamplerConfig struct {
	enabled        bool
	sampleInterval time.Duration
	window         time.Duration
	collectorDir   string
}

func connSamplerConfigFromEnv() connSamplerConfig {
	config := connSamplerConfig{
		enabled:        true,
		sampleInterval: connDefaultSampleInterval,
		window:         connDefaultWindow,
		collectorDir:   connEBPFDefaultDir,
	}
	if raw := strings.TrimSpace(os.Getenv("OPSAGENT_CONN_EDGES")); raw != "" {
		if enabled, err := strconv.ParseBool(raw); err == nil {
			config.enabled = enabled
		}
	}
	config.sampleInterval = connEnvSeconds(
		"OPSAGENT_CONN_SAMPLE_INTERVAL_SECONDS", config.sampleInterval,
		connMinSampleInterval, connMaxSampleInterval,
	)
	config.window = connEnvSeconds(
		"OPSAGENT_CONN_WINDOW_SECONDS", config.window,
		connMinWindowSeconds, connMaxWindowSeconds,
	)
	if raw := strings.TrimSpace(os.Getenv("OPSAGENT_CONN_COLLECTOR_DIR")); raw != "" {
		config.collectorDir = raw
	}
	return config
}

func connEnvSeconds(key string, fallback, minimum, maximum time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	seconds, err := strconv.ParseFloat(raw, 64)
	if err != nil || seconds <= 0 {
		return fallback
	}
	value := time.Duration(seconds * float64(time.Second))
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

// startConnEdgeSampler 启动 Linux 连接窗口采样器并返回心跳上报缓存。
// OPSAGENT_CONN_EDGES=false 时返回 nil（不采样、不上报）。
func startConnEdgeSampler() *connWindowReporter {
	config := connSamplerConfigFromEnv()
	if !config.enabled {
		log.Printf("connection window collector disabled by OPSAGENT_CONN_EDGES")
		return nil
	}
	reporter := newConnWindowReporter(config.sampleInterval, config.window)
	sampler := &connEdgeSampler{
		config:     config,
		reporter:   reporter,
		aggregator: newConnWindowAggregator(config.window),
		localIPs:   newConnLocalIPSet(),
		processes:  newConnProcessCache(connProcessCacheTTL),
		ebpf:       newEBPFEdgeTracker(config.collectorDir),
	}
	go sampler.run()
	return reporter
}

// connEdgeSampler 是 procfs 采样器的运行态。
type connEdgeSampler struct {
	config     connSamplerConfig
	reporter   *connWindowReporter
	aggregator *connWindowAggregator
	localIPs   *connLocalIPSet
	processes  *connProcessCache
	ebpf       *ebpfEdgeTracker
}

func (s *connEdgeSampler) run() {
	log.Printf(
		"connection window collector started: sample=%s window=%s ebpf_dir=%s",
		s.config.sampleInterval, s.config.window, s.config.collectorDir,
	)
	s.localIPs.refresh(time.Now())
	ticker := time.NewTicker(s.config.sampleInterval)
	defer ticker.Stop()
	for {
		s.collect(time.Now())
		<-ticker.C
	}
}

// collect 执行一次采样并推送到期窗口。
func (s *connEdgeSampler) collect(now time.Time) {
	if now.Sub(s.localIPs.refreshedAt()) >= connLocalIPRefresh {
		s.localIPs.refresh(now)
	}
	s.ebpf.poll(now)

	observations, ok := s.snapshot(now)
	if !ok {
		log.Printf("connection window collector: /proc/net/tcp unavailable, skip sample")
		return
	}
	if !s.aggregator.Started() {
		s.aggregator.SeedBaseline(now, observations)
		log.Printf("connection window baseline: %d established connections", len(observations))
		return
	}

	for _, window := range s.aggregator.Observe(now, observations) {
		windowStart := parseConnWindowTime(window.Start, now)
		windowEnd := parseConnWindowTime(window.End, now)
		if extra := s.ebpf.take(windowStart, windowEnd); len(extra) > 0 {
			window = mergeConnWindowWithEBPF(window, extra)
		}
		window, _ = trimConnWindow(window, connMaxEdgesPerWindow, connMaxWindowBytes)
		s.reporter.pushAt(window, now)
	}
}

// snapshot 读取一次 procfs 连接快照并完成进程归因、方向判定与内部流量过滤。
// 返回 false 表示 /proc/net/tcp 与 tcp6 都无法读取（本次采样跳过，避免误判连接消失）。
func (s *connEdgeSampler) snapshot(now time.Time) ([]connObservation, bool) {
	var rows []procNetConn
	readable := 0
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
		readable++
		for _, line := range strings.Split(string(body), "\n") {
			row, ok := parseProcNetLine(line, source.v6)
			if !ok {
				continue
			}
			if row.State != procTCPEstablished && row.State != procTCPListen {
				continue
			}
			rows = append(rows, row)
		}
	}
	if readable == 0 {
		return nil, false
	}

	wanted := make(map[uint64]struct{}, len(rows))
	for _, row := range rows {
		if row.Inode != 0 {
			wanted[row.Inode] = struct{}{}
		}
	}
	owners := map[uint64]int{}
	if len(wanted) > 0 {
		owners = scanConnInodeOwners(wanted)
	}

	// 监听表：端口 → 进程信息，用于方向判定与 in 方向的服务名归因。
	listeningPorts := make(map[int]bool, len(rows))
	listenerInfo := make(map[int]connProcInfo, len(rows))
	for _, row := range rows {
		if row.State != procTCPListen {
			continue
		}
		listeningPorts[row.LocalPort] = true
		pid := owners[row.Inode]
		if pid <= 0 {
			continue
		}
		listenerInfo[row.LocalPort] = s.processes.get(pid, now)
	}

	observations := make([]connObservation, 0, len(rows))
	for _, row := range rows {
		if row.State != procTCPEstablished || !row.validEstablished() {
			continue
		}
		// 过滤 loopback 与两端都是本机 IP 的内部流量（含容器 veth 场景）。
		if s.localIPs.internal(row.LocalAddress, row.PeerAddress) {
			continue
		}
		direction := connectionDirection(row.LocalPort, listeningPorts)

		pid := owners[row.Inode]
		info := connProcInfo{}
		if pid > 0 {
			info = s.processes.get(pid, now)
		}
		if direction == connDirectionIn {
			listener := listenerInfo[row.LocalPort]
			// 入向优先用监听进程信息（进程名/jar 名），socket 归属拿不到时兜底。
			if info.process == "" && listener.process != "" {
				info = listener
				pid = listener.pid
			}
			if listener.service() != "" {
				info.serviceName = listener.service()
			}
			if info.process == "" && listener.process != "" {
				info.process = listener.process
			}
		}

		observations = append(observations, connObservation{
			Direction:    direction,
			LocalAddress: row.LocalAddress,
			LocalPort:    row.LocalPort,
			PeerAddress:  row.PeerAddress,
			PeerPort:     row.PeerPort,
			PID:          pid,
			Process:      info.process,
			Service:      info.service(),
			Command:      info.command,
			Container:    info.container,
		})
	}
	return observations, true
}

// scanConnInodeOwners 扫 /proc/<pid>/fd，建立 socket inode → pid 映射。
// 只保留 wanted 里的 inode，减少无谓匹配；找到全部后提前退出。
func scanConnInodeOwners(wanted map[uint64]struct{}) map[uint64]int {
	owners := make(map[uint64]int, len(wanted))
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return owners
	}
scan:
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 {
			continue
		}
		fdDir := filepath.Join("/proc", entry.Name(), "fd")
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		for _, fd := range fds {
			link, err := os.Readlink(filepath.Join(fdDir, fd.Name()))
			if err != nil {
				continue
			}
			inode, ok := parseConnSocketLink(link)
			if !ok {
				continue
			}
			if _, needed := wanted[inode]; !needed {
				continue
			}
			if _, exists := owners[inode]; !exists {
				owners[inode] = pid
			}
		}
		if len(owners) >= len(wanted) {
			break scan
		}
	}
	return owners
}

// parseConnSocketLink 解析 "socket:[12345]"。
func parseConnSocketLink(link string) (uint64, bool) {
	const prefix = "socket:["
	if !strings.HasPrefix(link, prefix) || !strings.HasSuffix(link, "]") {
		return 0, false
	}
	value, err := strconv.ParseUint(link[len(prefix):len(link)-1], 10, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// connProcInfo 是进程归因所需的信息快照。
type connProcInfo struct {
	pid         int
	process     string
	command     string
	serviceName string
	container   string
}

func (info connProcInfo) service() string {
	if info.serviceName != "" {
		return info.serviceName
	}
	return info.process
}

// connProcessCache 缓存进程信息 30s，降低每轮扫描的 /proc 读取开销。
type connProcessCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	entries map[int]connProcCacheEntry
}

type connProcCacheEntry struct {
	info    connProcInfo
	expires time.Time
}

func newConnProcessCache(ttl time.Duration) *connProcessCache {
	return &connProcessCache{ttl: ttl, entries: make(map[int]connProcCacheEntry)}
}

func (cache *connProcessCache) get(pid int, now time.Time) connProcInfo {
	if pid <= 0 {
		return connProcInfo{}
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if entry, ok := cache.entries[pid]; ok && now.Before(entry.expires) {
		return entry.info
	}
	info := readConnProcInfo(pid)
	cache.entries[pid] = connProcCacheEntry{info: info, expires: now.Add(cache.ttl)}
	if len(cache.entries) > connProcessCacheLimit {
		for key, entry := range cache.entries {
			if !now.Before(entry.expires) {
				delete(cache.entries, key)
			}
		}
	}
	return info
}

// readConnProcInfo 读取 /proc/<pid>/{comm,cmdline,cgroup} 并推导服务名与容器。
func readConnProcInfo(pid int) connProcInfo {
	info := connProcInfo{pid: pid}
	base := filepath.Join("/proc", strconv.Itoa(pid))
	if body, err := os.ReadFile(filepath.Join(base, "comm")); err == nil {
		info.process = strings.TrimSpace(string(body))
	}
	if body, err := os.ReadFile(filepath.Join(base, "cmdline")); err == nil {
		info.command = truncateConnCommand(string(body))
	}
	if info.process == "" && info.command != "" {
		if fields := strings.Fields(info.command); len(fields) > 0 {
			info.process = filepath.Base(fields[0])
		}
	}
	// 复用应用发现里的 jar 名解析：-jar order-service.jar → order-service。
	info.serviceName = serviceFromCommand(info.command, info.process)
	if info.serviceName == info.process {
		info.serviceName = ""
	}
	info.container = readConnContainerID(base)
	return info
}

var (
	connContainerIDPattern = regexp.MustCompile(`[0-9a-f]{64}`)
	connKubepodsPodPattern = regexp.MustCompile(`pod([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`)
)

// readConnContainerID 从 cgroup 识别容器：docker/containerd 的 64 位容器 ID 取
// 前 12 位短 ID；kubepods 场景退回 pod UID 前缀。非容器进程返回空。
func readConnContainerID(procBase string) string {
	body, err := os.ReadFile(filepath.Join(procBase, "cgroup"))
	if err != nil {
		return ""
	}
	content := strings.ToLower(string(body))
	if !strings.Contains(content, "docker") &&
		!strings.Contains(content, "kubepods") &&
		!strings.Contains(content, "containerd") &&
		!strings.Contains(content, "crio") {
		return ""
	}
	if match := connContainerIDPattern.FindString(content); match != "" {
		return match[:12]
	}
	if match := connKubepodsPodPattern.FindStringSubmatch(content); len(match) > 1 {
		return "pod-" + match[1][:12]
	}
	return ""
}

// connLocalIPSet 是本机 IP 集合（含 loopback），用于过滤本机内部流量。
type connLocalIPSet struct {
	mu               sync.Mutex
	addresses        map[string]struct{}
	refreshedAtValue time.Time
}

func newConnLocalIPSet() *connLocalIPSet {
	return &connLocalIPSet{addresses: make(map[string]struct{})}
}

func (set *connLocalIPSet) refreshedAt() time.Time {
	set.mu.Lock()
	defer set.mu.Unlock()
	return set.refreshedAtValue
}

func (set *connLocalIPSet) refresh(now time.Time) {
	addresses := make(map[string]struct{})
	if interfaces, err := net.Interfaces(); err == nil {
		for _, iface := range interfaces {
			interfaceAddrs, err := iface.Addrs()
			if err != nil {
				continue
			}
			for _, addr := range interfaceAddrs {
				if ip := connAddrIP(addr); ip != nil {
					addresses[connIPKey(ip)] = struct{}{}
				}
			}
		}
	}
	addresses["127.0.0.1"] = struct{}{}
	addresses["::1"] = struct{}{}
	set.mu.Lock()
	set.addresses = addresses
	set.refreshedAtValue = now
	set.mu.Unlock()
}

func connAddrIP(addr net.Addr) net.IP {
	switch value := addr.(type) {
	case *net.IPNet:
		return value.IP
	case *net.IPAddr:
		return value.IP
	}
	host := addr.String()
	if index := strings.LastIndex(host, "/"); index >= 0 {
		host = host[:index]
	}
	return net.ParseIP(strings.Trim(host, "[]"))
}

func connIPKey(ip net.IP) string {
	if ip4 := ip.To4(); ip4 != nil {
		return ip4.String()
	}
	return ip.String()
}

func (set *connLocalIPSet) isLocal(address string) bool {
	if address == "" {
		return false
	}
	ip := net.ParseIP(strings.Trim(address, "[]"))
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	key := connIPKey(ip)
	set.mu.Lock()
	defer set.mu.Unlock()
	_, ok := set.addresses[key]
	return ok
}

// internal 判断是否为 loopback 或两端都在本机的内部流量。
func (set *connLocalIPSet) internal(localAddress, peerAddress string) bool {
	if ip := net.ParseIP(localAddress); ip != nil && ip.IsLoopback() {
		return true
	}
	if ip := net.ParseIP(peerAddress); ip != nil && ip.IsLoopback() {
		return true
	}
	return set.isLocal(localAddress) && set.isLocal(peerAddress)
}
