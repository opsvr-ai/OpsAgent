package main

// 建连边表窗口采集（平台无关部分）。
//
// 本文件实现「固定时间窗内的建连关系」的数据模型与纯逻辑，供 Linux 采样器
// （conntrack_linux.go）与 eBPF 边表合并（conntrack_ebpf.go）复用：
//   - /proc/net/tcp{,6} 行解析（小端 IP、端口、LISTEN/ESTABLISHED、IPv6 v4-mapped）
//   - 连接快照差分聚合：opened / closed / active / baseline / 方向
//   - 边窗口排序与条数、字节上限截断（400 条 / 256KB）
//   - 心跳上报缓存 connWindowReporter（上次心跳成功后清空，失败保留重发）
//
// 字段名与 Control 侧 ConnectionWindowReport / ConnectionEdgeReport 逐字对应，
// 修改时须同步 packages/contracts/src/topology.ts。非 Linux 平台只使用本文件的
// 类型与聚合逻辑（采样由 conntrack_other.go 空实现），因此本文件不得 import
// 任何仅 Linux 可用的包。

import (
	"encoding/hex"
	"encoding/json"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	connDirectionOut = "out"
	connDirectionIn  = "in"

	connProtocolTCP = "tcp"

	connSourceProcfs = "procfs"
	connSourceEBPF   = "ebpf"
	connSourceHybrid = "hybrid"

	// 每窗口边数上限与单窗口 JSON 序列化后的字节上限（含 start/end/source/stats）。
	connMaxEdgesPerWindow = 400
	connMaxWindowBytes    = 256 * 1024
	// procfs 模式无法区分建连失败，failed 恒为 0。
	// command 字段按字符数截断，避免长 cmdline 撑爆心跳。
	connCommandMaxRunes = 512

	// 4 元组连续缺席的采样次数达到该值才计 closed，避免采样抖动误报。
	connClosedAfterMisses = 2

	// /proc/net/tcp{,6} 状态码。
	procTCPEstablished = "01"
	procTCPListen      = "0A"
)

// connEdge 是上报给 Control 的一条聚合边（“谁访问谁”），字段名与契约一致。
//
// 聚合口径：同一 (direction, pid, process, peerAddress, 服务端口) 的并发连接
// 合并为一行；临时端口不参与聚合，因此 localPort（direction=out 时）与
// peerPort（direction=in 时）恒为 0。opened/closed/active 按去重后的连接
// 4 元组统计，因此可以大于 1。
type connEdge struct {
	Direction    string `json:"direction"` // out / in
	Process      string `json:"process"`
	PID          int    `json:"pid"`
	Service      string `json:"service"` // 本机侧服务名（监听进程名 / jar 名）
	Command      string `json:"command"` // 进程 cmdline，最多 512 字符
	LocalAddress string `json:"localAddress"`
	LocalPort    int    `json:"localPort"`
	PeerAddress  string `json:"peerAddress"`
	PeerPort     int    `json:"peerPort"`
	Protocol     string `json:"protocol"` // 固定 tcp
	Opened       int    `json:"opened"`
	Closed       int    `json:"closed"`
	Failed       int    `json:"failed"`
	Active       int    `json:"active"`
	FirstSeen    string `json:"firstSeen"` // RFC3339
	LastSeen     string `json:"lastSeen"`  // RFC3339
	Container    string `json:"container"` // docker/containerd 容器短 ID 或名字，未知为空
	Baseline     bool   `json:"baseline"`  // 采集启动时已存在的长连接
}

// connWindowStats 是窗口统计信息（可选字段，omitempty）。
type connWindowStats struct {
	Scans             int `json:"scans"`
	ActiveConnections int `json:"activeConnections"`
	Dropped           int `json:"dropped"`
}

// connEdgeWindow 是一个固定时间窗的建连边表，心跳 connectionWindows 的元素。
type connEdgeWindow struct {
	Start  string           `json:"start"` // RFC3339
	End    string           `json:"end"`   // RFC3339
	Source string           `json:"source"`
	Edges  []connEdge       `json:"edges"`
	Stats  *connWindowStats `json:"stats,omitempty"`
}

// connTuple 是连接 4 元组 + 方向的去重键（另含 pid 用于把同一连接的多次
// 采样归并成一次 opened）。opened 严格按该键去重，临时端口变化视为新连接。
type connTuple struct {
	Direction    string
	LocalAddress string
	LocalPort    int
	PeerAddress  string
	PeerPort     int
	PID          int
}

// connObservation 是采样器对一条 ESTABLISHED 连接的观测结果。
// 平台无关：Linux 采样器解析 /proc 后填充，单测可直接构造。
type connObservation struct {
	Direction    string
	LocalAddress string
	LocalPort    int
	PeerAddress  string
	PeerPort     int
	PID          int
	Process      string
	Service      string
	Command      string
	Container    string
}

func (o connObservation) valid() bool {
	if o.Direction != connDirectionOut && o.Direction != connDirectionIn {
		return false
	}
	if o.LocalPort <= 0 || o.PeerPort <= 0 || o.LocalAddress == "" || o.PeerAddress == "" {
		return false
	}
	return true
}

func (o connObservation) tuple() connTuple {
	return connTuple{
		Direction:    o.Direction,
		LocalAddress: o.LocalAddress,
		LocalPort:    o.LocalPort,
		PeerAddress:  o.PeerAddress,
		PeerPort:     o.PeerPort,
		PID:          o.PID,
	}
}

// servicePort 归一化为“服务端口”：入向是本机监听端口，出向是对端服务端口。
func (o connObservation) servicePort() int {
	if o.Direction == connDirectionIn {
		return o.LocalPort
	}
	return o.PeerPort
}

// connEdgeKey 是边聚合键：临时端口不参与聚合。
type connEdgeKey struct {
	Direction   string
	PID         int
	Process     string
	PeerAddress string
	ServicePort int
}

func (o connObservation) edgeKey() connEdgeKey {
	return connEdgeKey{
		Direction:   o.Direction,
		PID:         o.PID,
		Process:     o.Process,
		PeerAddress: o.PeerAddress,
		ServicePort: o.servicePort(),
	}
}

// edgeDisplay 生成边行的展示字段。局部端口/对端临时端口按方向归零：
//   - direction=out：本机是客户端，localPort 为临时端口，置 0；
//   - direction=in ：本机是服务端，peerPort 为客户端临时端口，置 0。
func (o connObservation) edgeDisplay() connEdge {
	edge := connEdge{
		Direction:    o.Direction,
		Process:      o.Process,
		PID:          o.PID,
		Service:      o.Service,
		Command:      truncateConnCommand(o.Command),
		LocalAddress: o.LocalAddress,
		PeerAddress:  o.PeerAddress,
		Protocol:     connProtocolTCP,
		Container:    o.Container,
	}
	if edge.Service == "" {
		edge.Service = edge.Process
	}
	if o.Direction == connDirectionIn {
		edge.LocalPort = o.LocalPort
		edge.PeerPort = 0
	} else {
		edge.LocalPort = 0
		edge.PeerPort = o.PeerPort
	}
	return edge
}

// connTracked 是聚合器内部跟踪的一条存活连接。
type connTracked struct {
	tuple       connTuple
	observation connObservation
	firstSeen   time.Time
	lastSeen    time.Time
	missing     int
	baseline    bool
}

// connEdgeAccum 是一个窗口内某条聚合边的累计值。
type connEdgeAccum struct {
	edge      connEdge
	firstSeen time.Time
	lastSeen  time.Time
	baseline  bool
}

// connWindowAggregator 把连续采样快照差分聚合为固定时间窗边表。
//
// 状态机：
//   - 首个快照写法基线（baseline=true），已存在连接只计 active，不计 opened；
//   - 之后新出现的 4 元组 opened++；
//   - 4 元组连续缺席 connClosedAfterMisses 次才 closed++（消失 1 个采样周期，
//     防止瞬时抖动把连接误判为关闭）；
//   - 窗口结束时仍存活的连接按聚合边计 active；
//   - 长连接跨窗口存活，每个窗口都会以 active 出现。
//
// 非并发安全：仅由采样器单个 goroutine 调用。
type connWindowAggregator struct {
	window            time.Duration
	maxEdges          int
	maxBytes          int
	closedAfterMisses int

	start   time.Time
	scans   int
	tracked map[connTuple]*connTracked
	edges   map[connEdgeKey]*connEdgeAccum
}

func newConnWindowAggregator(window time.Duration) *connWindowAggregator {
	if window <= 0 {
		window = 10 * time.Second
	}
	return &connWindowAggregator{
		window: window,
		// 条数/字节上限由上报前统一执行（trimConnWindow）：eBPF 合并需要看到
		// 完整 procfs 边表，先截断会导致 eBPF 命中被丢弃的边而丢失进程/active 信息。
		maxEdges:          0,
		maxBytes:          0,
		closedAfterMisses: connClosedAfterMisses,
		tracked:           make(map[connTuple]*connTracked),
		edges:             make(map[connEdgeKey]*connEdgeAccum),
	}
}

// Started 表示基线已写入。
func (a *connWindowAggregator) Started() bool {
	return !a.start.IsZero()
}

// SeedBaseline 写入启动基线：已存在的连接标记 baseline，只计 active 不计 opened。
func (a *connWindowAggregator) SeedBaseline(now time.Time, observations []connObservation) {
	a.start = now
	a.scans = 1
	for _, observation := range observations {
		if !observation.valid() {
			continue
		}
		tuple := observation.tuple()
		a.tracked[tuple] = &connTracked{
			tuple:       tuple,
			observation: observation,
			firstSeen:   now,
			lastSeen:    now,
			baseline:    true,
		}
	}
}

// Observe 输入一次采样快照，返回本次调用结束时已到期的窗口（通常 0 或 1 个）。
// 首次调用（未写基线时）自动当作基线，不产生 opened。
func (a *connWindowAggregator) Observe(now time.Time, observations []connObservation) []connEdgeWindow {
	if !a.Started() {
		a.SeedBaseline(now, observations)
		return nil
	}

	present := make(map[connTuple]connObservation, len(observations))
	for _, observation := range observations {
		if !observation.valid() {
			continue
		}
		present[observation.tuple()] = observation
	}

	for tuple, observation := range present {
		tracked := a.tracked[tuple]
		if tracked == nil {
			tracked = &connTracked{
				tuple:       tuple,
				observation: observation,
				firstSeen:   now,
				lastSeen:    now,
			}
			a.tracked[tuple] = tracked
			a.accumulate(tracked).edge.Opened++
			continue
		}
		// 短暂缺席后重新出现：还没到 closed 阈值，视为同一条连接，不重复计 opened。
		tracked.missing = 0
		tracked.lastSeen = now
		tracked.observation = observation
	}

	for tuple, tracked := range a.tracked {
		if _, ok := present[tuple]; ok {
			continue
		}
		tracked.missing++
		if tracked.missing < a.closedAfterMisses {
			continue
		}
		a.accumulate(tracked).edge.Closed++
		delete(a.tracked, tuple)
	}

	a.scans++
	if now.Sub(a.start) < a.window {
		return nil
	}
	window := a.flush(now)
	if window == nil {
		return nil
	}
	return []connEdgeWindow{*window}
}

// accumulate 取得（必要时创建）某连接所在聚合边的本窗口累计器，并合并展示字段。
func (a *connWindowAggregator) accumulate(tracked *connTracked) *connEdgeAccum {
	key := tracked.observation.edgeKey()
	accum := a.edges[key]
	if accum == nil {
		accum = &connEdgeAccum{
			edge:      tracked.observation.edgeDisplay(),
			firstSeen: tracked.firstSeen,
			lastSeen:  tracked.lastSeen,
			baseline:  tracked.baseline,
		}
		a.edges[key] = accum
	}
	if tracked.firstSeen.Before(accum.firstSeen) {
		accum.firstSeen = tracked.firstSeen
	}
	if tracked.lastSeen.After(accum.lastSeen) {
		accum.lastSeen = tracked.lastSeen
	}
	if tracked.baseline {
		accum.baseline = true
	}
	if accum.edge.Command == "" {
		accum.edge.Command = truncateConnCommand(tracked.observation.Command)
	}
	if accum.edge.Container == "" {
		accum.edge.Container = tracked.observation.Container
	}
	if accum.edge.Service == "" {
		accum.edge.Service = tracked.observation.Service
		if accum.edge.Service == "" {
			accum.edge.Service = accum.edge.Process
		}
	}
	if accum.edge.LocalAddress == "" {
		accum.edge.LocalAddress = tracked.observation.LocalAddress
	}
	return accum
}

// flush 结束当前窗口：把本窗口事件与存活连接合并成边表，重置窗口内累计值。
// tracked 跨窗口保留（长连接每个窗口都要体现 active）。
func (a *connWindowAggregator) flush(now time.Time) *connEdgeWindow {
	end := a.start.Add(a.window)

	live := make(map[connEdgeKey]int, len(a.tracked))
	for _, tracked := range a.tracked {
		live[tracked.observation.edgeKey()]++
	}
	// 存活连接即使本窗口没有 opened/closed，也要以 active 出现在窗口里。
	for _, tracked := range a.tracked {
		a.accumulate(tracked)
	}

	window := connEdgeWindow{
		Start:  a.start.UTC().Format(time.RFC3339),
		End:    end.UTC().Format(time.RFC3339),
		Source: connSourceProcfs,
		Edges:  make([]connEdge, 0, len(a.edges)),
		Stats: &connWindowStats{
			Scans:             a.scans,
			ActiveConnections: len(a.tracked),
		},
	}
	for key, accum := range a.edges {
		edge := accum.edge
		edge.Active = live[key]
		edge.FirstSeen = accum.firstSeen.UTC().Format(time.RFC3339)
		edge.LastSeen = accum.lastSeen.UTC().Format(time.RFC3339)
		edge.Baseline = accum.baseline
		if edge.Service == "" {
			edge.Service = edge.Process
		}
		window.Edges = append(window.Edges, edge)
	}

	a.edges = make(map[connEdgeKey]*connEdgeAccum)
	a.scans = 0
	a.start = end
	// 采样停顿过久时不补发多个空窗口，直接从当前时刻重新计时。
	if now.Sub(a.start) >= a.window {
		a.start = now
	}

	trimmed, _ := trimConnWindow(window, a.maxEdges, a.maxBytes)
	return &trimmed
}

// parseProcNetLine 解析 /proc/net/tcp 或 /proc/net/tcp6 的一行。
// v6 表示来自 /proc/net/tcp6（地址为 16 字节）。表头、非 TCP 状态行返回 false。
func parseProcNetLine(line string, v6 bool) (procNetConn, bool) {
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) < 10 {
		return procNetConn{}, false
	}
	localAddress, localPort, ok := parseProcNetAddress(fields[1], v6)
	if !ok {
		return procNetConn{}, false
	}
	peerAddress, peerPort, ok := parseProcNetAddress(fields[2], v6)
	if !ok {
		return procNetConn{}, false
	}
	inode, err := strconv.ParseUint(fields[9], 10, 64)
	if err != nil {
		return procNetConn{}, false
	}
	return procNetConn{
		State:        fields[3],
		LocalAddress: localAddress,
		LocalPort:    localPort,
		PeerAddress:  peerAddress,
		PeerPort:     peerPort,
		Inode:        inode,
		IPv6:         v6,
	}, true
}

// procNetConn 是 /proc/net/tcp{,6} 一行的解析结果。
type procNetConn struct {
	State        string // 01=ESTABLISHED，0A=LISTEN
	LocalAddress string
	LocalPort    int
	PeerAddress  string
	PeerPort     int
	Inode        uint64
	IPv6         bool
}

// validEstablished 判断一条 ESTABLISHED 行是否可用（排除占位的空地址）。
func (conn procNetConn) validEstablished() bool {
	if conn.LocalPort <= 0 || conn.PeerPort <= 0 {
		return false
	}
	if conn.LocalAddress == "" || conn.PeerAddress == "" {
		return false
	}
	if conn.PeerAddress == "0.0.0.0" || conn.PeerAddress == "::" {
		return false
	}
	return true
}

// parseProcNetAddress 解析 "HEXIP:HEXPORT"（小端 IP、大端端口）。
func parseProcNetAddress(value string, v6 bool) (string, int, bool) {
	index := strings.LastIndex(value, ":")
	if index <= 0 || index == len(value)-1 {
		return "", 0, false
	}
	port, err := strconv.ParseUint(value[index+1:], 16, 16)
	if err != nil {
		return "", 0, false
	}
	raw, err := hex.DecodeString(value[:index])
	if err != nil {
		return "", 0, false
	}
	want := net.IPv4len
	if v6 {
		want = net.IPv6len
	}
	if len(raw) != want {
		return "", 0, false
	}
	return decodeProcNetIP(raw, v6).String(), int(port), true
}

// decodeProcNetIP 还原 /proc/net/tcp{,6} 的小端地址。
// tcp6 每 4 字节为一组按主机字节序输出，需按组反转；v4-mapped 归一化为 IPv4。
func decodeProcNetIP(raw []byte, v6 bool) net.IP {
	if !v6 {
		ip := make(net.IP, net.IPv4len)
		for i := 0; i < net.IPv4len; i++ {
			ip[i] = raw[net.IPv4len-1-i]
		}
		return ip
	}
	ip := make(net.IP, net.IPv6len)
	for word := 0; word < 4; word++ {
		for i := 0; i < 4; i++ {
			ip[word*4+i] = raw[word*4+3-i]
		}
	}
	if ip4 := ip.To4(); ip4 != nil {
		return ip4
	}
	return ip
}

// connectionDirection 判定方向：本机端口命中监听表 → 本机是服务端(in)，否则 out。
func connectionDirection(localPort int, listeningPorts map[int]bool) string {
	if listeningPorts[localPort] {
		return connDirectionIn
	}
	return connDirectionOut
}

// connEdgeServicePort 返回一条边的服务端口：入向为监听端口，出向为对端服务端口。
func connEdgeServicePort(edge connEdge) int {
	if edge.Direction == connDirectionIn {
		return edge.LocalPort
	}
	return edge.PeerPort
}

// truncateConnCommand 清洗 cmdline（NUL → 空格）并按字符数截断。
func truncateConnCommand(command string) string {
	command = strings.TrimSpace(strings.ReplaceAll(command, "\x00", " "))
	if command == "" {
		return ""
	}
	runes := []rune(command)
	if len(runes) <= connCommandMaxRunes {
		return command
	}
	return string(runes[:connCommandMaxRunes])
}

// sortConnEdgesByWeight 按 opened+active 降序排序（同权重按 opened、active、
// failed、lastSeen 及地址端口做稳定兜底，保证输出确定）。
func sortConnEdgesByWeight(edges []connEdge) {
	sort.SliceStable(edges, func(i, j int) bool {
		return connEdgeLess(edges[i], edges[j])
	})
}

func connEdgeLess(left, right connEdge) bool {
	leftWeight := left.Opened + left.Active
	rightWeight := right.Opened + right.Active
	if leftWeight != rightWeight {
		return leftWeight > rightWeight
	}
	if left.Opened != right.Opened {
		return left.Opened > right.Opened
	}
	if left.Active != right.Active {
		return left.Active > right.Active
	}
	if left.Failed != right.Failed {
		return left.Failed > right.Failed
	}
	if left.LastSeen != right.LastSeen {
		return left.LastSeen > right.LastSeen
	}
	if left.PeerAddress != right.PeerAddress {
		return left.PeerAddress < right.PeerAddress
	}
	if left.PeerPort != right.PeerPort {
		return left.PeerPort < right.PeerPort
	}
	if left.LocalPort != right.LocalPort {
		return left.LocalPort < right.LocalPort
	}
	if left.Direction != right.Direction {
		return left.Direction < right.Direction
	}
	if left.PID != right.PID {
		return left.PID < right.PID
	}
	return left.Process < right.Process
}

// trimConnWindow 排序后按条数上限截断，再按序列化字节上限收缩，返回被丢弃的边数与
// 清理后的窗口。Stats.Dropped 会累加（允许先聚合截断、合并 eBPF 后再次截断）。
func trimConnWindow(window connEdgeWindow, maxEdges, maxBytes int) (connEdgeWindow, int) {
	if window.Stats != nil {
		stats := *window.Stats
		window.Stats = &stats
	}
	edges := make([]connEdge, len(window.Edges))
	copy(edges, window.Edges)
	sortConnEdgesByWeight(edges)

	dropped := 0
	if maxEdges > 0 && len(edges) > maxEdges {
		dropped += len(edges) - maxEdges
		edges = edges[:maxEdges]
	}
	window.Edges = edges

	if maxBytes > 0 && len(edges) > 0 {
		if body, err := json.Marshal(window); err == nil && len(body) > maxBytes {
			low, high := 0, len(edges)
			for low < high {
				mid := (low + high + 1) / 2
				window.Edges = edges[:mid]
				body, err := json.Marshal(window)
				if err == nil && len(body) <= maxBytes {
					low = mid
				} else {
					high = mid - 1
				}
			}
			dropped += len(edges) - low
			edges = edges[:low]
		}
	}
	if edges == nil {
		edges = make([]connEdge, 0)
	}
	window.Edges = edges
	if window.Stats != nil {
		window.Stats.Dropped += dropped
	}
	return window, dropped
}

// parseConnWindowTime 解析窗口时间；窗口结构里存的是 RFC3339 字符串。
func parseConnWindowTime(value string, fallback time.Time) time.Time {
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed
	}
	return fallback
}

// connWindowReporter 缓存「上次心跳成功后新产生的窗口」，心跳 POST 成功后才确认
// 清空；心跳失败窗口保留，下次心跳重发。最多缓存 12 个窗口或 120 秒。
type connWindowReporter struct {
	mu sync.Mutex

	sampleSeconds int
	windowSeconds int
	source        string

	pending       []connEdgeWindow
	lastWindowAt  time.Time
	lastEdgeCount int
	received      int
}

const (
	connReporterMaxWindows   = 12
	connReporterMaxWindowAge = 120 * time.Second
)

func newConnWindowReporter(sampleInterval, window time.Duration) *connWindowReporter {
	return &connWindowReporter{
		sampleSeconds: int(sampleInterval / time.Second),
		windowSeconds: int(window / time.Second),
		source:        connSourceProcfs,
	}
}

// push 记录一个已产出的窗口（时间取当前时刻）。
func (r *connWindowReporter) push(window connEdgeWindow) {
	r.pushAt(window, time.Now())
}

// pushAt 记录一个已产出的窗口，now 为产出时刻（单测可注入）。
// 无边窗口只更新观测指标，不进入待发送队列，避免安静主机持续发送空窗口。
func (r *connWindowReporter) pushAt(window connEdgeWindow, now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.received++
	r.source = window.Source
	r.lastWindowAt = now
	r.lastEdgeCount = len(window.Edges)
	if len(window.Edges) == 0 {
		return
	}
	r.pending = append(r.pending, window)
	if len(r.pending) > connReporterMaxWindows {
		r.pending = append([]connEdgeWindow(nil), r.pending[len(r.pending)-connReporterMaxWindows:]...)
	}
	cutoff := now.Add(-connReporterMaxWindowAge)
	for len(r.pending) > 0 {
		end := parseConnWindowTime(r.pending[0].End, now)
		if !end.Before(cutoff) {
			break
		}
		r.pending = r.pending[1:]
	}
	if len(r.pending) == 0 {
		r.pending = nil
	}
}

// snapshot 返回待上报窗口的浅拷贝（窗口内容推送后不再修改）。
func (r *connWindowReporter) snapshot() []connEdgeWindow {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.pending) == 0 {
		return nil
	}
	out := make([]connEdgeWindow, len(r.pending))
	copy(out, r.pending)
	return out
}

// ack 心跳成功后确认前 sent 个窗口已送达（发送期间新产生的窗口保留）。
func (r *connWindowReporter) ack(sent int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if sent <= 0 || len(r.pending) == 0 {
		return
	}
	if sent >= len(r.pending) {
		r.pending = nil
		return
	}
	r.pending = append([]connEdgeWindow(nil), r.pending[sent:]...)
}

// metrics 生成心跳 metrics.connSampler，便于 Control 观测采样状态。
func (r *connWindowReporter) metrics() map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := map[string]any{
		"enabled":        true,
		"source":         r.source,
		"sampleSeconds":  r.sampleSeconds,
		"windowSeconds":  r.windowSeconds,
		"edgeCount":      r.lastEdgeCount,
		"pendingWindows": len(r.pending),
	}
	if !r.lastWindowAt.IsZero() {
		result["lastWindowAt"] = r.lastWindowAt.UTC().Format(time.RFC3339)
	}
	return result
}
