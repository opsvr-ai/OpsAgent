package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeEBPFConnEdges(t *testing.T, dir string, edges []ebpfConnEdge, mtime time.Time) {
	t.Helper()
	body, err := json.Marshal(edges)
	if err != nil {
		t.Fatalf("marshal ebpf edges: %v", err)
	}
	path := filepath.Join(dir, connEBPFFileName)
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write ebpf edges: %v", err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatalf("chtimes ebpf edges: %v", err)
	}
}

func connTestFindEBPFEdge(t *testing.T, edges []connEdge, direction, peer string, port int) connEdge {
	t.Helper()
	for _, edge := range edges {
		if edge.Direction != direction || edge.PeerAddress != peer {
			continue
		}
		if connEdgeServicePort(edge) == port {
			return edge
		}
	}
	t.Fatalf("ebpf edge not found direction=%s peer=%s port=%d edges=%#v", direction, peer, port, edges)
	return connEdge{}
}

func TestEBPFEdgeTrackerReadsDeltasAndMaps(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	tracker := newEBPFEdgeTracker(dir)
	tracker.poll(now)

	initial := []ebpfConnEdge{
		{Dir: "out", Comm: "java", Peer: "10.0.0.9", Port: 3306, ConnsOpened: 10, ConnsClosed: 2, ConnsFailed: 1, LastSeen: "2026-11-10T12:00:10Z"},
		{Dir: "in", Comm: "container:nginx", Peer: "203.0.113.5", Port: 8080, ConnsOpened: 100, ConnsClosed: 90, ConnsFailed: 3, LastSeen: "2026-11-10T12:00:09Z"},
	}
	writeEBPFConnEdges(t, dir, initial, now)
	tracker.poll(now)
	start := now
	end := now.Add(10 * time.Second)
	if edges := tracker.take(start, end); len(edges) != 0 {
		t.Fatalf("first eBPF read must only seed baseline, got %#v", edges)
	}

	updated := []ebpfConnEdge{
		{Dir: "out", Comm: "java", Peer: "10.0.0.9", Port: 3306, ConnsOpened: 13, ConnsClosed: 3, ConnsFailed: 1, LastSeen: "2026-11-10T12:00:20Z"},
		{Dir: "in", Comm: "container:nginx", Peer: "203.0.113.5", Port: 8080, ConnsOpened: 104, ConnsClosed: 91, ConnsFailed: 3, LastSeen: "2026-11-10T12:00:19Z"},
	}
	writeEBPFConnEdges(t, dir, updated, now.Add(time.Second))
	tracker.poll(now.Add(time.Second))

	edges := tracker.take(start, end)
	if len(edges) != 2 {
		t.Fatalf("expected 2 eBPF edges, got %d: %#v", len(edges), edges)
	}
	outbound := connTestFindEBPFEdge(t, edges, connDirectionOut, "10.0.0.9", 3306)
	if outbound.Opened != 3 || outbound.Closed != 1 || outbound.Failed != 0 {
		t.Fatalf("outbound counts opened=%d closed=%d failed=%d, want 3/1/0", outbound.Opened, outbound.Closed, outbound.Failed)
	}
	if outbound.Process != "java" || outbound.LocalPort != 0 || outbound.PeerPort != 3306 || outbound.PID != 0 {
		t.Fatalf("outbound mapping = %#v", outbound)
	}
	if outbound.LastSeen != "2026-11-10T12:00:20Z" {
		t.Fatalf("outbound lastSeen = %q, want file last_seen", outbound.LastSeen)
	}

	inbound := connTestFindEBPFEdge(t, edges, connDirectionIn, "203.0.113.5", 8080)
	if inbound.Opened != 4 || inbound.Closed != 1 || inbound.Failed != 0 {
		t.Fatalf("inbound counts opened=%d closed=%d failed=%d, want 4/1/0", inbound.Opened, inbound.Closed, inbound.Failed)
	}
	if inbound.Process != "nginx" || inbound.Container != "nginx" {
		t.Fatalf("container prefix mapping = %#v", inbound)
	}
	if inbound.LocalPort != 8080 || inbound.PeerPort != 0 {
		t.Fatalf("inbound mapping localPort=%d peerPort=%d, want 8080/0", inbound.LocalPort, inbound.PeerPort)
	}

	if again := tracker.take(start, end); len(again) != 0 {
		t.Fatalf("pending must be consumed after take, got %#v", again)
	}
}

func TestEBPFEdgeTrackerToleratesBadFiles(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	tracker := newEBPFEdgeTracker(dir)
	tracker.poll(now) // 目录为空：不报错、不产生数据

	path := filepath.Join(dir, connEBPFFileName)
	if err := os.WriteFile(path, []byte("{not-json"), 0o644); err != nil {
		t.Fatalf("write malformed file: %v", err)
	}
	if err := os.Chtimes(path, now, now); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	tracker.poll(now)
	if edges := tracker.take(now, now.Add(10*time.Second)); len(edges) != 0 {
		t.Fatalf("malformed file must not produce edges, got %#v", edges)
	}

	// 损坏文件恢复后应能继续工作：首次合法读取只建基线。
	writeEBPFConnEdges(t, dir, []ebpfConnEdge{
		{Dir: "out", Comm: "curl", Peer: "1.2.3.4", Port: 443, ConnsOpened: 1},
	}, now.Add(time.Second))
	tracker.poll(now.Add(time.Second))
	if edges := tracker.take(now, now.Add(10*time.Second)); len(edges) != 0 {
		t.Fatalf("recovered file must seed baseline, got %#v", edges)
	}
	writeEBPFConnEdges(t, dir, []ebpfConnEdge{
		{Dir: "out", Comm: "curl", Peer: "1.2.3.4", Port: 443, ConnsOpened: 2},
	}, now.Add(2*time.Second))
	tracker.poll(now.Add(2 * time.Second))
	if edges := tracker.take(now, now.Add(10*time.Second)); len(edges) != 1 || edges[0].Opened != 1 {
		t.Fatalf("recovered tracker delta = %#v, want opened 1", edges)
	}
}

func TestEBPFEdgeTrackerIgnoresStaleFile(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	writeEBPFConnEdges(t, dir, []ebpfConnEdge{
		{Dir: "out", Comm: "java", Peer: "10.0.0.9", Port: 3306, ConnsOpened: 5},
	}, now.Add(-2*time.Minute))
	tracker := newEBPFEdgeTracker(dir)
	tracker.poll(now)
	if !tracker.lastMtime.IsZero() {
		t.Fatalf("stale file must be ignored, lastMtime = %v", tracker.lastMtime)
	}
	if edges := tracker.take(now, now.Add(10*time.Second)); len(edges) != 0 {
		t.Fatalf("stale file must not produce edges, got %#v", edges)
	}
}

func TestEBPFEdgeTrackerHandlesCounterReset(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	writeEBPFConnEdges(t, dir, []ebpfConnEdge{
		{Dir: "out", Comm: "java", Peer: "10.0.0.9", Port: 3306, ConnsOpened: 100, ConnsClosed: 50},
	}, now)
	tracker := newEBPFEdgeTracker(dir)
	tracker.poll(now) // 基线
	writeEBPFConnEdges(t, dir, []ebpfConnEdge{
		{Dir: "out", Comm: "java", Peer: "10.0.0.9", Port: 3306, ConnsOpened: 5, ConnsClosed: 1},
	}, now.Add(time.Second))
	tracker.poll(now.Add(time.Second))
	edges := tracker.take(now, now.Add(10*time.Second))
	if len(edges) != 1 {
		t.Fatalf("expected 1 edge after reset, got %#v", edges)
	}
	if edges[0].Opened != 5 || edges[0].Closed != 1 {
		t.Fatalf("reset delta opened=%d closed=%d, want current counters 5/1", edges[0].Opened, edges[0].Closed)
	}
}

func connTestEBPFWindow() connEdgeWindow {
	return connEdgeWindow{
		Start:  "2026-11-10T12:00:00Z",
		End:    "2026-11-10T12:00:10Z",
		Source: connSourceProcfs,
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
			Active:       3,
			FirstSeen:    "2026-11-10T11:59:50Z",
			LastSeen:     "2026-11-10T12:00:09Z",
			Baseline:     true,
		}},
		Stats: &connWindowStats{Scans: 2, ActiveConnections: 3},
	}
}

func TestMergeConnWindowWithEBPF(t *testing.T) {
	window := connTestEBPFWindow()
	ebpfEdges := []connEdge{
		{
			Direction: connDirectionOut, Process: "java", PeerAddress: "10.0.0.9", PeerPort: 3306,
			Protocol: connProtocolTCP, Opened: 5, Closed: 2, Failed: 1,
			LastSeen: "2026-11-10T12:00:05Z",
		},
		{
			Direction: connDirectionIn, Process: "nginx", PeerAddress: "203.0.113.5", LocalPort: 8080,
			Protocol: connProtocolTCP, Opened: 4, Container: "nginx",
			LastSeen: "2026-11-10T12:00:07Z",
		},
	}
	merged := mergeConnWindowWithEBPF(window, ebpfEdges)
	if merged.Source != connSourceHybrid {
		t.Fatalf("source = %q, want hybrid", merged.Source)
	}
	if len(merged.Edges) != 2 {
		t.Fatalf("edges = %d, want 2", len(merged.Edges))
	}
	matched := merged.Edges[0]
	if matched.Opened != 5 || matched.Closed != 2 || matched.Failed != 1 {
		t.Fatalf("matched eBPF counts opened=%d closed=%d failed=%d, want 5/2/1", matched.Opened, matched.Closed, matched.Failed)
	}
	if matched.Active != 3 || matched.PID != 100 || matched.Service != "order" || !matched.Baseline {
		t.Fatalf("procfs-only fields must be preserved: %#v", matched)
	}
	if matched.LastSeen != "2026-11-10T12:00:09Z" {
		t.Fatalf("lastSeen = %q, want later procfs timestamp", matched.LastSeen)
	}
	appended := merged.Edges[1]
	if appended.Direction != connDirectionIn || appended.LocalPort != 8080 || appended.PeerPort != 0 {
		t.Fatalf("appended eBPF edge mapping = %#v", appended)
	}
	if appended.Container != "nginx" {
		t.Fatalf("appended container = %q, want nginx", appended.Container)
	}
}

func TestMergeConnWindowWithEBPFOnly(t *testing.T) {
	window := connEdgeWindow{Start: "2026-11-10T12:00:00Z", End: "2026-11-10T12:00:10Z", Source: connSourceProcfs, Stats: &connWindowStats{}}
	merged := mergeConnWindowWithEBPF(window, []connEdge{{
		Direction: connDirectionOut, Process: "curl", PeerAddress: "1.2.3.4", PeerPort: 443,
		Protocol: connProtocolTCP, Opened: 1,
	}})
	if merged.Source != connSourceEBPF {
		t.Fatalf("source = %q, want ebpf", merged.Source)
	}
	if len(merged.Edges) != 1 || merged.Edges[0].PeerPort != 443 || merged.Edges[0].LocalPort != 0 {
		t.Fatalf("unexpected merged edges: %#v", merged.Edges)
	}
}

func TestMergeConnWindowWithoutEBPFKeepsSource(t *testing.T) {
	window := connTestEBPFWindow()
	merged := mergeConnWindowWithEBPF(window, nil)
	if merged.Source != connSourceProcfs {
		t.Fatalf("source = %q, want procfs", merged.Source)
	}
	if len(merged.Edges) != 1 {
		t.Fatalf("edges = %d, want 1", len(merged.Edges))
	}
}
