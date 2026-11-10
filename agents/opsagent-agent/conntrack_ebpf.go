package main

// eBPF 边表通道（平台无关）。
//
// 可选数据源：conn_collector 在 OPSAGENT_CONN_COLLECTOR_DIR（默认
// /var/log/conn_collector）下每 60s 覆盖写出的 edges.json。格式见
// .dsh-runtime/ebpf-coll/events.go 的 edge 结构：
//
//	{dir, comm, peer, port, conns_opened, conns_closed, conns_failed, last_seen}
//
// 该文件的计数是采集器进程生命周期内的累计值（非窗口增量），因此这里用
// mtime 判断更新，对累计值做差分得到窗口增量，再合并进 procfs 窗口：
//   - dir=out → direction=out，peer/port 是对端地址与对端服务端口；
//   - dir=in  → direction=in ，peer 是客户端地址，port 是本机监听端口；
//   - comm 可能带 "container:" 前缀，拆进程名与容器信息；
//   - 命中的 procfs 边用 eBPF 精确 opened/closed/failed 覆盖估算值，
//     未命中的边追加为 eBPF 来源边。
//
// 文件缺失、格式错误、超过 60s 未更新、计数器重置都必须容错，不影响主流程。

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	connEBPFDefaultDir  = "/var/log/conn_collector"
	connEBPFFileName    = "edges.json"
	connEBPFMaxAge      = 60 * time.Second
	connEBPFErrorLogGap = time.Minute
)

// ebpfConnEdge 是 edges.json 数组元素（对应 ebpf-coll events.go 的 edge）。
type ebpfConnEdge struct {
	Dir         string `json:"dir"`
	Comm        string `json:"comm"`
	Peer        string `json:"peer"`
	Port        uint16 `json:"port"`
	ConnsOpened uint64 `json:"conns_opened"`
	ConnsClosed uint64 `json:"conns_closed"`
	ConnsFailed uint64 `json:"conns_failed"`
	LastSeen    string `json:"last_seen"`
}

// ebpfEdgeKey 是 eBPF 边的聚合键（与服务端 events.go 的 edgeKey 一致）。
type ebpfEdgeKey struct {
	Direction string
	Process   string
	Peer      string
	Port      int
}

type ebpfEdgeCounts struct {
	Opened uint64
	Closed uint64
	Failed uint64
}

func (counts ebpfEdgeCounts) zero() bool {
	return counts.Opened == 0 && counts.Closed == 0 && counts.Failed == 0
}

// ebpfEdgeTracker 跟踪 edges.json 的累计计数并生成窗口增量。
// 非并发安全：仅由采样器单个 goroutine 调用。
type ebpfEdgeTracker struct {
	dir    string
	maxAge time.Duration

	lastMtime time.Time
	seeded    bool
	known     map[ebpfEdgeKey]ebpfEdgeCounts
	pending   map[ebpfEdgeKey]ebpfEdgeCounts
	lastSeen  map[ebpfEdgeKey]string

	lastErrorAt time.Time
}

func newEBPFEdgeTracker(dir string) *ebpfEdgeTracker {
	if strings.TrimSpace(dir) == "" {
		dir = connEBPFDefaultDir
	}
	return &ebpfEdgeTracker{
		dir:      dir,
		maxAge:   connEBPFMaxAge,
		known:    make(map[ebpfEdgeKey]ebpfEdgeCounts),
		pending:  make(map[ebpfEdgeKey]ebpfEdgeCounts),
		lastSeen: make(map[ebpfEdgeKey]string),
	}
}

// poll 检查 edges.json 是否更新；有新内容时把累计值差分后累加到 pending。
// 首次读到有效文件只记基线，不产生增量（与 procfs 基线口径一致）。
func (t *ebpfEdgeTracker) poll(now time.Time) {
	path := filepath.Join(t.dir, connEBPFFileName)
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	if !info.ModTime().After(t.lastMtime) {
		return
	}
	if now.Sub(info.ModTime()) > t.maxAge {
		// 采集器超过 60s 没更新：数据不可信，等下一次更新再恢复。
		return
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.logError(now, "读取 eBPF 边表失败: %v", err)
		return
	}
	var raw []ebpfConnEdge
	if err := json.Unmarshal(body, &raw); err != nil {
		t.logError(now, "解析 eBPF 边表失败: %v", err)
		return
	}

	current := make(map[ebpfEdgeKey]ebpfEdgeCounts, len(raw))
	seen := make(map[ebpfEdgeKey]string, len(raw))
	for _, item := range raw {
		if item.Dir != connDirectionOut && item.Dir != connDirectionIn {
			continue
		}
		if item.Peer == "" || item.Port == 0 {
			continue
		}
		key := ebpfEdgeKey{
			Direction: item.Dir,
			Process:   strings.TrimSpace(item.Comm),
			Peer:      item.Peer,
			Port:      int(item.Port),
		}
		current[key] = ebpfEdgeCounts{
			Opened: item.ConnsOpened,
			Closed: item.ConnsClosed,
			Failed: item.ConnsFailed,
		}
		seen[key] = item.LastSeen
	}
	t.lastMtime = info.ModTime()

	if !t.seeded {
		t.known = current
		t.lastSeen = seen
		t.seeded = true
		return
	}

	reset := ebpfCountersReset(t.known, current)
	for key, counts := range current {
		delta := ebpfCountsDelta(t.known[key], counts, reset)
		if !delta.zero() {
			accumulated := t.pending[key]
			accumulated.Opened += delta.Opened
			accumulated.Closed += delta.Closed
			accumulated.Failed += delta.Failed
			t.pending[key] = accumulated
		}
		if value := seen[key]; value != "" {
			t.lastSeen[key] = value
		}
	}
	t.known = current
}

// take 把 pending 增量转换成项目边（一次窗口消费完后清空）。
func (t *ebpfEdgeTracker) take(windowStart, windowEnd time.Time) []connEdge {
	if len(t.pending) == 0 {
		return nil
	}
	startText := windowStart.UTC().Format(time.RFC3339)
	endText := windowEnd.UTC().Format(time.RFC3339)
	edges := make([]connEdge, 0, len(t.pending))
	for key, counts := range t.pending {
		process, container := splitEBPFProcess(key.Process)
		edge := connEdge{
			Direction:   key.Direction,
			Process:     process,
			PID:         0, // eBPF 边只有进程名，没有 pid
			Service:     process,
			Command:     "",
			PeerAddress: key.Peer,
			Protocol:    connProtocolTCP,
			Opened:      int(counts.Opened),
			Closed:      int(counts.Closed),
			Failed:      int(counts.Failed),
			FirstSeen:   startText,
			LastSeen:    endText,
			Container:   container,
			Baseline:    false,
		}
		if key.Direction == connDirectionIn {
			edge.LocalPort = key.Port
			edge.PeerPort = 0
		} else {
			edge.LocalPort = 0
			edge.PeerPort = key.Port
		}
		if lastSeen := t.lastSeen[key]; lastSeen != "" {
			if parsed, err := time.Parse(time.RFC3339, lastSeen); err == nil {
				edge.LastSeen = parsed.UTC().Format(time.RFC3339)
			}
		}
		edges = append(edges, edge)
	}
	t.pending = make(map[ebpfEdgeKey]ebpfEdgeCounts)
	return edges
}

// splitEBPFProcess 拆分 "container:" 前缀：容器内进程名同时写入 process 与
// container（eBPF 侧拿不到容器 ID，这里用进程名作为容器标识的兜底）。
func splitEBPFProcess(comm string) (process, container string) {
	comm = strings.TrimSpace(comm)
	if !strings.HasPrefix(comm, "container:") {
		return comm, ""
	}
	rest := strings.TrimSpace(strings.TrimPrefix(comm, "container:"))
	if rest == "" {
		return "container", "container"
	}
	return rest, rest
}

// ebpfCountersReset 判断 edges.json 是否发生了采集器重启导致的计数器重置。
func ebpfCountersReset(previous, current map[ebpfEdgeKey]ebpfEdgeCounts) bool {
	var previousSum, currentSum uint64
	for _, counts := range previous {
		previousSum += counts.Opened + counts.Closed + counts.Failed
	}
	for _, counts := range current {
		currentSum += counts.Opened + counts.Closed + counts.Failed
	}
	if currentSum < previousSum {
		return true
	}
	for key, counts := range current {
		before, ok := previous[key]
		if !ok {
			continue
		}
		if counts.Opened < before.Opened || counts.Closed < before.Closed || counts.Failed < before.Failed {
			return true
		}
	}
	return false
}

// ebpfCountsDelta 计算单个 key 的窗口增量；重置时当前值即增量。
func ebpfCountsDelta(previous, current ebpfEdgeCounts, reset bool) ebpfEdgeCounts {
	if reset {
		return current
	}
	return ebpfEdgeCounts{
		Opened: saturatingCountDelta(current.Opened, previous.Opened),
		Closed: saturatingCountDelta(current.Closed, previous.Closed),
		Failed: saturatingCountDelta(current.Failed, previous.Failed),
	}
}

func saturatingCountDelta(current, previous uint64) uint64 {
	if current <= previous {
		return 0
	}
	return current - previous
}

// logError 对 eBPF 通道错误限频打日志：文件问题不影响 procfs 主流程。
func (t *ebpfEdgeTracker) logError(now time.Time, format string, args ...any) {
	if !t.lastErrorAt.IsZero() && now.Sub(t.lastErrorAt) < connEBPFErrorLogGap {
		return
	}
	t.lastErrorAt = now
	log.Printf(format, args...)
}

// mergeConnWindowWithEBPF 把 eBPF 窗口增量合并进 procfs 窗口：
//   - 按 (direction, peer, 服务端口, process) 匹配 procfs 边，命中则用 eBPF 的
//     opened/closed/failed 覆盖估算值（active/pid/command/service 保留 procfs）；
//   - 未命中的 eBPF 边追加到窗口；
//   - source 置为 hybrid（procfs 边存在）或 ebpf（只有 eBPF 数据）。
func mergeConnWindowWithEBPF(window connEdgeWindow, ebpfEdges []connEdge) connEdgeWindow {
	if len(ebpfEdges) == 0 {
		return window
	}
	edges := make([]connEdge, len(window.Edges))
	copy(edges, window.Edges)
	hadProcfsEdges := len(edges) > 0

	used := make(map[int]bool, len(edges))
	for _, extra := range ebpfEdges {
		index, ok := findConnEdgeForEBPF(edges, used, extra)
		if !ok {
			edges = append(edges, extra)
			continue
		}
		used[index] = true
		candidate := &edges[index]
		candidate.Opened = extra.Opened
		candidate.Closed = extra.Closed
		candidate.Failed = extra.Failed
		if candidate.LastSeen < extra.LastSeen {
			candidate.LastSeen = extra.LastSeen
		}
		if candidate.Container == "" {
			candidate.Container = extra.Container
		}
	}
	if edges == nil {
		edges = make([]connEdge, 0)
	}
	window.Edges = edges
	if hadProcfsEdges {
		window.Source = connSourceHybrid
	} else {
		window.Source = connSourceEBPF
	}
	return window
}

// findConnEdgeForEBPF 先在未使用的 procfs 边里做进程名精确匹配，再退回
// (direction, peer, 服务端口) 宽松匹配（eBPF 的 in 方向 comm 可能为空）。
func findConnEdgeForEBPF(edges []connEdge, used map[int]bool, extra connEdge) (int, bool) {
	targetPort := connEdgeServicePort(extra)
	for i := range edges {
		if used[i] {
			continue
		}
		candidate := edges[i]
		if candidate.Direction != extra.Direction || candidate.PeerAddress != extra.PeerAddress {
			continue
		}
		if connEdgeServicePort(candidate) != targetPort {
			continue
		}
		if candidate.Process == extra.Process {
			return i, true
		}
	}
	for i := range edges {
		if used[i] {
			continue
		}
		candidate := edges[i]
		if candidate.Direction != extra.Direction || candidate.PeerAddress != extra.PeerAddress {
			continue
		}
		if connEdgeServicePort(candidate) == targetPort {
			return i, true
		}
	}
	return -1, false
}
