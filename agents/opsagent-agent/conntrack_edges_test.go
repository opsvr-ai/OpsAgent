package main

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"
	"time"
)

// ---------- /proc/net/tcp{,6} 解析 ----------

func TestParseProcNetLineIPv4Established(t *testing.T) {
	line := "   0: 0100007F:1F90 0500000A:D431 01 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0"
	conn, ok := parseProcNetLine(line, false)
	if !ok {
		t.Fatalf("expected line to parse: %q", line)
	}
	if conn.State != procTCPEstablished {
		t.Fatalf("state = %q, want ESTABLISHED", conn.State)
	}
	if conn.LocalAddress != "127.0.0.1" || conn.LocalPort != 8080 {
		t.Fatalf("local = %s:%d, want 127.0.0.1:8080", conn.LocalAddress, conn.LocalPort)
	}
	if conn.PeerAddress != "10.0.0.5" || conn.PeerPort != 54321 {
		t.Fatalf("peer = %s:%d, want 10.0.0.5:54321", conn.PeerAddress, conn.PeerPort)
	}
	if conn.Inode != 12345 {
		t.Fatalf("inode = %d, want 12345", conn.Inode)
	}
}

func TestParseProcNetLineListen(t *testing.T) {
	line := "   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 999 1 0000000000000000 100 0 0 10 0"
	conn, ok := parseProcNetLine(line, false)
	if !ok {
		t.Fatalf("expected LISTEN line to parse")
	}
	if conn.State != procTCPListen {
		t.Fatalf("state = %q, want LISTEN", conn.State)
	}
	if conn.LocalAddress != "0.0.0.0" || conn.LocalPort != 22 {
		t.Fatalf("local = %s:%d, want 0.0.0.0:22", conn.LocalAddress, conn.LocalPort)
	}
	if conn.Inode != 999 {
		t.Fatalf("inode = %d, want 999", conn.Inode)
	}
}

func TestParseProcNetLineIPv6V4Mapped(t *testing.T) {
	line := "   0: 0000000000000000FFFF00000100007F:0016 0000000000000000FFFF00000200000A:D431 01 00000000:00000000 00:00000000 00000000  1000 0 777 1 0 100 0 0 10 0"
	conn, ok := parseProcNetLine(line, true)
	if !ok {
		t.Fatalf("expected v4-mapped line to parse")
	}
	if conn.LocalAddress != "127.0.0.1" || conn.LocalPort != 22 {
		t.Fatalf("local = %s:%d, want mapped 127.0.0.1:22", conn.LocalAddress, conn.LocalPort)
	}
	if conn.PeerAddress != "10.0.0.2" || conn.PeerPort != 54321 {
		t.Fatalf("peer = %s:%d, want mapped 10.0.0.2:54321", conn.PeerAddress, conn.PeerPort)
	}
	if !conn.IPv6 {
		t.Fatalf("expected IPv6 marker")
	}
}

func TestParseProcNetLineIPv6Pure(t *testing.T) {
	line := "   0: 00000000000000000000000001000000:1F90 00000000000000000000000002000000:3039 01 00000000:00000000 00:00000000 00000000  1000 0 888 1 0 100 0 0 10 0"
	conn, ok := parseProcNetLine(line, true)
	if !ok {
		t.Fatalf("expected pure IPv6 line to parse")
	}
	if conn.LocalAddress != "::1" || conn.LocalPort != 8080 {
		t.Fatalf("local = %s:%d, want ::1:8080", conn.LocalAddress, conn.LocalPort)
	}
	if conn.PeerAddress != "::2" || conn.PeerPort != 12345 {
		t.Fatalf("peer = %s:%d, want ::2:12345", conn.PeerAddress, conn.PeerPort)
	}
}

func TestParseProcNetLineRejectsMalformed(t *testing.T) {
	cases := []string{
		"",
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
		"   0: 0100007F:1F90 0500000A:D431 01",
		"   0: 0100:1F90 0500000A:D431 01 00000000:00000000 00:00000000 00000000  1000 0 12345 1 0",
		"   0: ZZZZ:1F90 0500000A:D431 01 00000000:00000000 00:00000000 00000000  1000 0 12345 1 0",
		"   0: 0100007F:1F90 0500000A:D431 01 00000000:00000000 00:00000000 00000000  1000 0 notanumber 1 0",
	}
	for _, line := range cases {
		if _, ok := parseProcNetLine(line, false); ok {
			t.Fatalf("expected malformed line to be rejected: %q", line)
		}
	}
}

func TestConnectionDirection(t *testing.T) {
	listening := map[int]bool{8080: true, 22: true}
	if got := connectionDirection(8080, listening); got != connDirectionIn {
		t.Fatalf("listening port direction = %q, want in", got)
	}
	if got := connectionDirection(54321, listening); got != connDirectionOut {
		t.Fatalf("ephemeral port direction = %q, want out", got)
	}
	if got := connectionDirection(54321, nil); got != connDirectionOut {
		t.Fatalf("nil listen table direction = %q, want out", got)
	}
}

// ---------- 窗口差分聚合 ----------

func connTestObservation(direction, localAddress string, localPort int, peerAddress string, peerPort, pid int, process string) connObservation {
	return connObservation{
		Direction:    direction,
		LocalAddress: localAddress,
		LocalPort:    localPort,
		PeerAddress:  peerAddress,
		PeerPort:     peerPort,
		PID:          pid,
		Process:      process,
		Service:      process,
	}
}

func connTestTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339)
}

func connTestFindEdge(t *testing.T, window connEdgeWindow, peerAddress string, peerPort, localPort int) connEdge {
	t.Helper()
	for _, edge := range window.Edges {
		if edge.PeerAddress == peerAddress && edge.PeerPort == peerPort && edge.LocalPort == localPort {
			return edge
		}
	}
	t.Fatalf("edge not found peer=%s peerPort=%d localPort=%d edges=%#v", peerAddress, peerPort, localPort, window.Edges)
	return connEdge{}
}

func TestConnWindowAggregatorBaselineAndDeltas(t *testing.T) {
	base := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	aggregator := newConnWindowAggregator(10 * time.Second)

	outA := connTestObservation(connDirectionOut, "10.0.0.2", 40000, "10.0.0.9", 3306, 100, "java")
	outB := connTestObservation(connDirectionOut, "10.0.0.2", 40001, "10.0.0.8", 5432, 100, "java")
	aggregator.SeedBaseline(base, []connObservation{outA})

	if windows := aggregator.Observe(base.Add(5*time.Second), []connObservation{outA}); len(windows) != 0 {
		t.Fatalf("expected no window before first boundary, got %d", len(windows))
	}
	windows := aggregator.Observe(base.Add(10*time.Second), []connObservation{outA})
	if len(windows) != 1 {
		t.Fatalf("expected baseline window, got %d", len(windows))
	}
	baselineWindow := windows[0]
	if baselineWindow.Start != connTestTime(base) || baselineWindow.End != connTestTime(base.Add(10*time.Second)) {
		t.Fatalf("unexpected baseline window bounds: %s .. %s", baselineWindow.Start, baselineWindow.End)
	}
	if baselineWindow.Source != connSourceProcfs {
		t.Fatalf("source = %q, want procfs", baselineWindow.Source)
	}
	baselineEdge := connTestFindEdge(t, baselineWindow, "10.0.0.9", 3306, 0)
	if baselineEdge.Opened != 0 {
		t.Fatalf("baseline edge opened = %d, want 0 (must not re-count existing connections)", baselineEdge.Opened)
	}
	if baselineEdge.Active != 1 || !baselineEdge.Baseline {
		t.Fatalf("baseline edge active=%d baseline=%v, want 1/true", baselineEdge.Active, baselineEdge.Baseline)
	}
	if baselineEdge.Direction != connDirectionOut || baselineEdge.LocalPort != 0 {
		t.Fatalf("outbound edge direction=%q localPort=%d, want out/0", baselineEdge.Direction, baselineEdge.LocalPort)
	}

	// 新连接 outB 在窗口 2 首次出现 → opened=1。
	if windows := aggregator.Observe(base.Add(15*time.Second), []connObservation{outA, outB}); len(windows) != 0 {
		t.Fatalf("expected no window mid-window, got %d", len(windows))
	}
	windows = aggregator.Observe(base.Add(20*time.Second), []connObservation{outA, outB})
	if len(windows) != 1 {
		t.Fatalf("expected second window, got %d", len(windows))
	}
	secondWindow := windows[0]
	newEdge := connTestFindEdge(t, secondWindow, "10.0.0.8", 5432, 0)
	if newEdge.Opened != 1 || newEdge.Active != 1 || newEdge.Baseline {
		t.Fatalf("new edge opened=%d active=%d baseline=%v, want 1/1/false", newEdge.Opened, newEdge.Active, newEdge.Baseline)
	}
	if newEdge.FirstSeen != connTestTime(base.Add(15*time.Second)) || newEdge.LastSeen != connTestTime(base.Add(20*time.Second)) {
		t.Fatalf("new edge first/last = %s/%s", newEdge.FirstSeen, newEdge.LastSeen)
	}
	stillBaseline := connTestFindEdge(t, secondWindow, "10.0.0.9", 3306, 0)
	if stillBaseline.Opened != 0 || stillBaseline.Active != 1 {
		t.Fatalf("long-lived edge opened=%d active=%d, want 0/1", stillBaseline.Opened, stillBaseline.Active)
	}

	// outB 消失：第一次缺席不算 closed。
	if windows := aggregator.Observe(base.Add(25*time.Second), []connObservation{outA}); len(windows) != 0 {
		t.Fatalf("expected no window mid-window, got %d", len(windows))
	}
	// 连续第二次缺席 → closed=1，窗口 3 结束。
	windows = aggregator.Observe(base.Add(30*time.Second), []connObservation{outA})
	if len(windows) != 1 {
		t.Fatalf("expected closing window, got %d", len(windows))
	}
	closingWindow := windows[0]
	closedEdge := connTestFindEdge(t, closingWindow, "10.0.0.8", 5432, 0)
	if closedEdge.Closed != 1 || closedEdge.Active != 0 || closedEdge.Opened != 0 {
		t.Fatalf("closed edge opened=%d closed=%d active=%d, want 0/1/0", closedEdge.Opened, closedEdge.Closed, closedEdge.Active)
	}
	if closingWindow.Stats == nil || closingWindow.Stats.ActiveConnections != 1 {
		t.Fatalf("window stats activeConnections = %#v, want 1", closingWindow.Stats)
	}
	if closingWindow.Stats.Scans != 2 {
		t.Fatalf("window scans = %d, want 2", closingWindow.Stats.Scans)
	}
}

func TestConnWindowAggregatorFirstSampleIsBaseline(t *testing.T) {
	base := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	aggregator := newConnWindowAggregator(10 * time.Second)
	existing := connTestObservation(connDirectionIn, "10.0.0.2", 8080, "203.0.113.5", 50000, 200, "nginx")
	if windows := aggregator.Observe(base, []connObservation{existing}); len(windows) != 0 {
		t.Fatalf("first sample must seed baseline, got window")
	}
	added := connTestObservation(connDirectionIn, "10.0.0.2", 8080, "203.0.113.6", 50001, 200, "nginx")
	windows := aggregator.Observe(base.Add(10*time.Second), []connObservation{existing, added})
	if len(windows) != 1 {
		t.Fatalf("expected first window, got %d", len(windows))
	}
	// 两条入向连接同一服务端进程/端口，只是客户端地址不同 → 两条边。
	var inbound int
	for _, edge := range windows[0].Edges {
		if edge.Direction == connDirectionIn {
			inbound++
			if edge.LocalPort != 8080 || edge.PeerPort != 0 {
				t.Fatalf("inbound edge localPort=%d peerPort=%d, want 8080/0", edge.LocalPort, edge.PeerPort)
			}
		}
	}
	if inbound != 2 {
		t.Fatalf("inbound edges = %d, want 2", inbound)
	}
}

func TestConnWindowAggregatorAggregatesTemporaryPorts(t *testing.T) {
	base := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	aggregator := newConnWindowAggregator(10 * time.Second)
	first := connTestObservation(connDirectionOut, "10.0.0.2", 41000, "10.0.0.9", 3306, 100, "java")
	second := connTestObservation(connDirectionOut, "10.0.0.2", 41001, "10.0.0.9", 3306, 100, "java")
	third := connTestObservation(connDirectionOut, "10.0.0.2", 41002, "10.0.0.9", 3306, 100, "java")
	aggregator.SeedBaseline(base, []connObservation{first, second})

	windows := aggregator.Observe(base.Add(10*time.Second), []connObservation{first, second})
	if len(windows) != 1 {
		t.Fatalf("expected baseline window, got %d", len(windows))
	}
	if len(windows[0].Edges) != 1 {
		t.Fatalf("expected 1 aggregated edge, got %d: %#v", len(windows[0].Edges), windows[0].Edges)
	}
	edge := windows[0].Edges[0]
	if edge.Active != 2 || edge.Opened != 0 || edge.PeerPort != 3306 {
		t.Fatalf("baseline aggregate active=%d opened=%d peerPort=%d, want 2/0/3306", edge.Active, edge.Opened, edge.PeerPort)
	}

	// 新增第三条同目标连接 → opened=1、active=3（临时端口不拆边）。
	windows = aggregator.Observe(base.Add(20*time.Second), []connObservation{first, second, third})
	if len(windows) != 1 {
		t.Fatalf("expected second window, got %d", len(windows))
	}
	edge = windows[0].Edges[0]
	if edge.Opened != 1 || edge.Active != 3 {
		t.Fatalf("second window opened=%d active=%d, want 1/3", edge.Opened, edge.Active)
	}

	// second 消失，连续缺席两次后 closed=1、active=2。
	if windows := aggregator.Observe(base.Add(25*time.Second), []connObservation{first, third}); len(windows) != 0 {
		t.Fatalf("expected no window mid-window")
	}
	windows = aggregator.Observe(base.Add(30*time.Second), []connObservation{first, third})
	if len(windows) != 1 {
		t.Fatalf("expected closing window")
	}
	edge = windows[0].Edges[0]
	if edge.Closed != 1 || edge.Active != 2 || edge.Opened != 0 {
		t.Fatalf("closing window opened=%d closed=%d active=%d, want 0/1/2", edge.Opened, edge.Closed, edge.Active)
	}
}

// ---------- 窗口 JSON 结构与截断 ----------

func TestConnWindowJSONStructure(t *testing.T) {
	window := connEdgeWindow{
		Start:  "2026-11-10T12:00:00Z",
		End:    "2026-11-10T12:00:10Z",
		Source: connSourceHybrid,
		Edges: []connEdge{{
			Direction:    connDirectionOut,
			Process:      "java",
			PID:          100,
			Service:      "order",
			Command:      "java -jar order.jar",
			LocalAddress: "10.0.0.2",
			LocalPort:    0,
			PeerAddress:  "10.0.0.9",
			PeerPort:     3306,
			Protocol:     connProtocolTCP,
			Opened:       2,
			Closed:       1,
			Failed:       0,
			Active:       3,
			FirstSeen:    "2026-11-10T11:59:00Z",
			LastSeen:     "2026-11-10T12:00:09Z",
			Container:    "abc123",
			Baseline:     true,
		}},
		Stats: &connWindowStats{Scans: 2, ActiveConnections: 3, Dropped: 0},
	}
	body, err := json.Marshal(window)
	if err != nil {
		t.Fatalf("marshal window: %v", err)
	}
	t.Logf("connection window payload example: %s", body)

	var generic map[string]json.RawMessage
	if err := json.Unmarshal(body, &generic); err != nil {
		t.Fatalf("unmarshal window: %v", err)
	}
	connTestAssertKeys(t, generic, []string{"start", "end", "source", "edges", "stats"})

	var stats map[string]json.RawMessage
	if err := json.Unmarshal(generic["stats"], &stats); err != nil {
		t.Fatalf("unmarshal stats: %v", err)
	}
	connTestAssertKeys(t, stats, []string{"scans", "activeConnections", "dropped"})

	var edges []json.RawMessage
	if err := json.Unmarshal(generic["edges"], &edges); err != nil || len(edges) != 1 {
		t.Fatalf("unmarshal edges: err=%v len=%d", err, len(edges))
	}
	var edge map[string]json.RawMessage
	if err := json.Unmarshal(edges[0], &edge); err != nil {
		t.Fatalf("unmarshal edge: %v", err)
	}
	connTestAssertKeys(t, edge, []string{
		"direction", "process", "pid", "service", "command", "localAddress", "localPort",
		"peerAddress", "peerPort", "protocol", "opened", "closed", "failed", "active",
		"firstSeen", "lastSeen", "container", "baseline",
	})
}

func connTestAssertKeys(t *testing.T, object map[string]json.RawMessage, expected []string) {
	t.Helper()
	got := make([]string, 0, len(object))
	for key := range object {
		got = append(got, key)
	}
	sort.Strings(got)
	want := append([]string(nil), expected...)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("JSON keys = %v, want %v", got, want)
	}
}

func TestTrimConnWindowByCount(t *testing.T) {
	window := connEdgeWindow{Start: "2026-11-10T12:00:00Z", End: "2026-11-10T12:00:10Z", Source: connSourceProcfs, Stats: &connWindowStats{}}
	for index := 0; index < 500; index++ {
		window.Edges = append(window.Edges, connEdge{
			Direction: connDirectionOut, Process: "proc", PeerAddress: "10.0.0.9", PeerPort: 3306,
			Protocol: connProtocolTCP, Opened: index,
		})
	}
	trimmed, dropped := trimConnWindow(window, connMaxEdgesPerWindow, connMaxWindowBytes)
	if len(trimmed.Edges) != connMaxEdgesPerWindow {
		t.Fatalf("edges = %d, want %d", len(trimmed.Edges), connMaxEdgesPerWindow)
	}
	if dropped != 100 || trimmed.Stats == nil || trimmed.Stats.Dropped != 100 {
		t.Fatalf("dropped=%d stats=%#v, want 100", dropped, trimmed.Stats)
	}
	if trimmed.Edges[0].Opened != 499 {
		t.Fatalf("first edge opened = %d, want highest weight 499", trimmed.Edges[0].Opened)
	}
	for index := 1; index < len(trimmed.Edges); index++ {
		if trimmed.Edges[index-1].Opened < trimmed.Edges[index].Opened {
			t.Fatalf("edges not sorted at %d: %d < %d", index, trimmed.Edges[index-1].Opened, trimmed.Edges[index].Opened)
		}
	}
}

func TestTrimConnWindowByBytes(t *testing.T) {
	window := connEdgeWindow{Start: "2026-11-10T12:00:00Z", End: "2026-11-10T12:00:10Z", Source: connSourceHybrid, Stats: &connWindowStats{}}
	command := strings.Repeat("粘", connCommandMaxRunes)
	for index := 0; index < 400; index++ {
		window.Edges = append(window.Edges, connEdge{
			Direction: connDirectionIn, Process: "java", Service: "order", Command: command,
			LocalAddress: "10.0.0.2", LocalPort: 8080, PeerAddress: "203.0.113.5",
			Protocol: connProtocolTCP, Opened: 1, Active: 1,
		})
	}
	trimmed, dropped := trimConnWindow(window, connMaxEdgesPerWindow, connMaxWindowBytes)
	body, err := json.Marshal(trimmed)
	if err != nil {
		t.Fatalf("marshal trimmed window: %v", err)
	}
	if len(body) > connMaxWindowBytes {
		t.Fatalf("serialized window = %d bytes, want <= %d", len(body), connMaxWindowBytes)
	}
	if len(trimmed.Edges) >= 400 {
		t.Fatalf("expected byte limit to drop some edges, got %d", len(trimmed.Edges))
	}
	if dropped <= 0 || trimmed.Stats == nil || trimmed.Stats.Dropped != dropped {
		t.Fatalf("dropped=%d stats=%#v", dropped, trimmed.Stats)
	}
}

func TestTrimConnWindowEmptyEdgesAreArray(t *testing.T) {
	window := connEdgeWindow{Start: "2026-11-10T12:00:00Z", End: "2026-11-10T12:00:10Z", Source: connSourceProcfs}
	trimmed, dropped := trimConnWindow(window, connMaxEdgesPerWindow, connMaxWindowBytes)
	if dropped != 0 {
		t.Fatalf("dropped = %d, want 0", dropped)
	}
	body, err := json.Marshal(trimmed)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(body), `"edges":[]`) {
		t.Fatalf("empty window must serialize edges as [], got %s", body)
	}
}

func TestTruncateConnCommand(t *testing.T) {
	if got := truncateConnCommand("  a\x00b  "); got != "a b" {
		t.Fatalf("NUL/space handling = %q, want %q", got, "a b")
	}
	if got := truncateConnCommand(strings.Repeat("a", 600)); len([]rune(got)) != connCommandMaxRunes {
		t.Fatalf("ascii command runes = %d, want %d", len([]rune(got)), connCommandMaxRunes)
	}
	multibyte := truncateConnCommand(strings.Repeat("粘", 600))
	if len([]rune(multibyte)) != connCommandMaxRunes {
		t.Fatalf("multibyte command runes = %d, want %d", len([]rune(multibyte)), connCommandMaxRunes)
	}
	if !json.Valid([]byte(`"` + multibyte + `"`)) {
		t.Fatalf("multibyte truncation produced invalid UTF-8")
	}
}

// ---------- 心跳上报缓存 ----------

func connTestWindowAt(start time.Time, edgePeer string) connEdgeWindow {
	window := connEdgeWindow{
		Start:  connTestTime(start),
		End:    connTestTime(start.Add(10 * time.Second)),
		Source: connSourceProcfs,
		Stats:  &connWindowStats{Scans: 2},
	}
	if edgePeer != "" {
		window.Edges = []connEdge{{
			Direction: connDirectionOut, Process: "java", PeerAddress: edgePeer, PeerPort: 3306,
			Protocol: connProtocolTCP, Opened: 1, Active: 1,
		}}
	}
	return window
}

func TestConnWindowReporterCachesAndAcks(t *testing.T) {
	reporter := newConnWindowReporter(5*time.Second, 10*time.Second)
	base := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

	metrics := reporter.metrics()
	if metrics["source"] != connSourceProcfs || metrics["windowSeconds"] != 10 {
		t.Fatalf("unexpected initial metrics: %#v", metrics)
	}
	if _, exists := metrics["lastWindowAt"]; exists {
		t.Fatalf("lastWindowAt must be omitted before first window: %#v", metrics)
	}

	// 空窗口只更新观测指标，不进入待发送队列。
	reporter.pushAt(connTestWindowAt(base, ""), base)
	if metrics := reporter.metrics(); metrics["lastWindowAt"] != connTestTime(base) {
		t.Fatalf("lastWindowAt = %#v, want %s", metrics["lastWindowAt"], connTestTime(base))
	}
	if pending := reporter.snapshot(); len(pending) != 0 {
		t.Fatalf("empty window must not be queued, got %d", len(pending))
	}

	for index := 0; index < 15; index++ {
		reporter.pushAt(connTestWindowAt(base.Add(time.Duration(index)*10*time.Second), "10.0.0.9"), base)
	}
	pending := reporter.snapshot()
	if len(pending) != connReporterMaxWindows {
		t.Fatalf("pending windows = %d, want %d", len(pending), connReporterMaxWindows)
	}
	if pending[0].Start != connTestTime(base.Add(3*10*time.Second)) {
		t.Fatalf("oldest retained window start = %s, want %s", pending[0].Start, connTestTime(base.Add(30*time.Second)))
	}

	reporter.ack(2)
	if pending := reporter.snapshot(); len(pending) != connReporterMaxWindows-2 {
		t.Fatalf("pending after ack(2) = %d, want %d", len(pending), connReporterMaxWindows-2)
	}
	reporter.ack(1000)
	if pending := reporter.snapshot(); len(pending) != 0 {
		t.Fatalf("pending after full ack = %d, want 0", len(pending))
	}
}

func TestConnWindowReporterDropsExpiredWindows(t *testing.T) {
	reporter := newConnWindowReporter(5*time.Second, 10*time.Second)
	base := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	reporter.pushAt(connTestWindowAt(base, "10.0.0.8"), base)
	// 200 秒后才上报：120 秒之前的窗口应被丢弃。
	reporter.pushAt(connTestWindowAt(base.Add(200*time.Second), "10.0.0.9"), base.Add(200*time.Second))
	pending := reporter.snapshot()
	if len(pending) != 1 || pending[0].Start != connTestTime(base.Add(200*time.Second)) {
		t.Fatalf("pending = %#v, want only newest window", pending)
	}
}

func TestConnEdgeServicePort(t *testing.T) {
	outbound := connEdge{Direction: connDirectionOut, LocalPort: 0, PeerPort: 3306}
	inbound := connEdge{Direction: connDirectionIn, LocalPort: 8080, PeerPort: 0}
	if got := connEdgeServicePort(outbound); got != 3306 {
		t.Fatalf("outbound service port = %d, want 3306", got)
	}
	if got := connEdgeServicePort(inbound); got != 8080 {
		t.Fatalf("inbound service port = %d, want 8080", got)
	}
}
