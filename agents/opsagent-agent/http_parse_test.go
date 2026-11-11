package main

import (
	"encoding/binary"
	"encoding/json"
	"net"
	"sort"
	"strings"
	"testing"
	"time"
)

// ===========================================================================
// 测试用报文构造
// ===========================================================================

func httpTestEthernetFrame(etherType uint16, payload []byte, vlan bool) []byte {
	macDst := []byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x01}
	macSrc := []byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x02}
	frame := make([]byte, 0, 18+len(payload))
	frame = append(frame, macDst...)
	frame = append(frame, macSrc...)
	if vlan {
		frame = append(frame, 0x81, 0x00, 0x00, 0x64) // VLAN id 100
	}
	frame = append(frame, byte(etherType>>8), byte(etherType))
	frame = append(frame, payload...)
	return frame
}

func httpTestTCPHeader(srcPort, dstPort int, seq uint32, flags uint8, payload []byte) []byte {
	header := make([]byte, 20)
	binary.BigEndian.PutUint16(header[0:2], uint16(srcPort))
	binary.BigEndian.PutUint16(header[2:4], uint16(dstPort))
	binary.BigEndian.PutUint32(header[4:8], seq)
	header[12] = 5 << 4 // data offset 20
	header[13] = flags
	return append(header, payload...)
}

func httpTestIPv4Packet(src, dst string, protocol byte, l4 []byte, fragment bool) []byte {
	srcIP := net.ParseIP(src).To4()
	dstIP := net.ParseIP(dst).To4()
	header := make([]byte, 20)
	header[0] = 0x45
	binary.BigEndian.PutUint16(header[2:4], uint16(20+len(l4)))
	header[8] = 64
	header[9] = protocol
	if fragment {
		binary.BigEndian.PutUint16(header[6:8], 0x2000)
	}
	copy(header[12:16], srcIP)
	copy(header[16:20], dstIP)
	return append(header, l4...)
}

func httpTestIPv6Packet(src, dst string, nextHeader byte, l4 []byte) []byte {
	srcIP := net.ParseIP(src).To16()
	dstIP := net.ParseIP(dst).To16()
	header := make([]byte, 40)
	header[0] = 0x60
	binary.BigEndian.PutUint16(header[4:6], uint16(len(l4)))
	header[6] = nextHeader
	header[7] = 64
	copy(header[8:24], srcIP)
	copy(header[24:40], dstIP)
	return append(header, l4...)
}

func httpTestPacket(payload string, seq uint32, flags uint8) httpTCPPacket {
	return httpTCPPacket{
		SrcIP:   net.ParseIP("192.0.2.10"),
		DstIP:   net.ParseIP("198.51.100.5"),
		SrcPort: 40000,
		DstPort: 8080,
		Seq:     seq,
		Flags:   flags,
		Payload: []byte(payload),
	}
}

func httpTestH2Frame(frameType, flags byte, streamID uint32, payload []byte) []byte {
	frame := make([]byte, 9+len(payload))
	frame[0] = byte(len(payload) >> 16)
	frame[1] = byte(len(payload) >> 8)
	frame[2] = byte(len(payload))
	frame[3] = frameType
	frame[4] = flags
	binary.BigEndian.PutUint32(frame[5:9], streamID&0x7fffffff)
	copy(frame[9:], payload)
	return frame
}

// ===========================================================================
// 二层~四层解析
// ===========================================================================

func TestDecodeHTTPFrameIPv4(t *testing.T) {
	tcp := httpTestTCPHeader(40000, 8080, 1234, httpTCPFlagACK|httpTCPFlagPSH, []byte("GET / HTTP/1.1\r\n\r\n"))
	frame := httpTestEthernetFrame(0x0800, httpTestIPv4Packet("10.0.0.2", "10.0.0.9", 6, tcp, false), false)
	packet, ok := decodeHTTPFrame(frame)
	if !ok {
		t.Fatalf("expected IPv4/TCP frame to decode")
	}
	if packet.SrcIP.String() != "10.0.0.2" || packet.DstIP.String() != "10.0.0.9" {
		t.Fatalf("addresses = %s -> %s", packet.SrcIP, packet.DstIP)
	}
	if packet.SrcPort != 40000 || packet.DstPort != 8080 {
		t.Fatalf("ports = %d -> %d", packet.SrcPort, packet.DstPort)
	}
	if packet.Seq != 1234 || packet.Flags&httpTCPFlagPSH == 0 {
		t.Fatalf("seq/flags = %d/%#x", packet.Seq, packet.Flags)
	}
	if string(packet.Payload) != "GET / HTTP/1.1\r\n\r\n" {
		t.Fatalf("payload = %q", packet.Payload)
	}
}

func TestDecodeHTTPFrameVLAN(t *testing.T) {
	tcp := httpTestTCPHeader(443, 51000, 77, httpTCPFlagACK, []byte("x"))
	frame := httpTestEthernetFrame(0x0800, httpTestIPv4Packet("198.51.100.5", "10.0.0.2", 6, tcp, false), true)
	packet, ok := decodeHTTPFrame(frame)
	if !ok {
		t.Fatalf("expected VLAN frame to decode")
	}
	if packet.SrcPort != 443 || packet.DstPort != 51000 || packet.Seq != 77 {
		t.Fatalf("unexpected vlan decoded packet: %#v", packet)
	}
}

func TestDecodeHTTPFrameIPv6(t *testing.T) {
	tcp := httpTestTCPHeader(50051, 42000, 900, httpTCPFlagACK|httpTCPFlagPSH, []byte("x"))
	frame := httpTestEthernetFrame(0x86DD, httpTestIPv6Packet("2001:db8::1", "2001:db8::2", 6, tcp), false)
	packet, ok := decodeHTTPFrame(frame)
	if !ok {
		t.Fatalf("expected IPv6/TCP frame to decode")
	}
	if packet.SrcIP.String() != "2001:db8::1" || packet.DstIP.String() != "2001:db8::2" {
		t.Fatalf("addresses = %s -> %s", packet.SrcIP, packet.DstIP)
	}
	if packet.SrcPort != 50051 || packet.DstPort != 42000 {
		t.Fatalf("ports = %d -> %d", packet.SrcPort, packet.DstPort)
	}
}

func TestDecodeHTTPFrameSkipsNonTCPAndTruncated(t *testing.T) {
	udp := httpTestIPv4Packet("10.0.0.2", "10.0.0.9", 17, make([]byte, 8), false)
	if _, ok := decodeHTTPFrame(httpTestEthernetFrame(0x0800, udp, false)); ok {
		t.Fatalf("UDP frame must not decode as TCP")
	}
	fragment := httpTestIPv4Packet("10.0.0.2", "10.0.0.9", 6, httpTestTCPHeader(1, 2, 3, 0, nil), true)
	if _, ok := decodeHTTPFrame(httpTestEthernetFrame(0x0800, fragment, false)); ok {
		t.Fatalf("fragmented IPv4 frame must be skipped")
	}
	if _, ok := decodeHTTPFrame([]byte{1, 2, 3}); ok {
		t.Fatalf("truncated frame must not decode")
	}
	shortTCP := httpTestIPv4Packet("10.0.0.2", "10.0.0.9", 6, []byte{1, 2, 3}, false)
	if _, ok := decodeHTTPFrame(httpTestEthernetFrame(0x0800, shortTCP, false)); ok {
		t.Fatalf("short TCP header must not decode")
	}
}

// ===========================================================================
// HTTP/1
// ===========================================================================

func TestHTTP1SingleRequest(t *testing.T) {
	stream := newHTTP1Stream()
	messages := stream.Push([]byte("GET /health HTTP/1.1\r\nHost: example\r\n\r\n"))
	if len(messages) != 1 {
		t.Fatalf("messages = %d, want 1", len(messages))
	}
	if !messages[0].IsRequest || messages[0].Method != "GET" {
		t.Fatalf("unexpected message %#v", messages[0])
	}
}

func TestHTTP1KeepAliveTwoRequests(t *testing.T) {
	stream := newHTTP1Stream()
	payload := "GET /a HTTP/1.1\r\nHost: x\r\n\r\n" +
		"POST /b HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello" +
		"GET /c HTTP/1.1\r\nHost: x\r\n\r\n"
	messages := stream.Push([]byte(payload))
	if len(messages) != 3 {
		t.Fatalf("messages = %d, want 3: %#v", len(messages), messages)
	}
	if messages[0].Method != "GET" || messages[1].Method != "POST" || messages[2].Method != "GET" {
		t.Fatalf("methods = %q/%q/%q", messages[0].Method, messages[1].Method, messages[2].Method)
	}
}

func TestHTTP1FragmentedRequestLine(t *testing.T) {
	stream := newHTTP1Stream()
	var messages []http1Message
	for _, fragment := range []string{"GE", "T /fr", "ag HT", "TP/1.1\r\n", "\r\n"} {
		messages = append(messages, stream.Push([]byte(fragment))...)
	}
	if len(messages) != 1 || messages[0].Method != "GET" {
		t.Fatalf("fragmented request messages = %#v", messages)
	}
}

func TestHTTP1ContentLengthBodySkipped(t *testing.T) {
	stream := newHTTP1Stream()
	payload := "POST /upload HTTP/1.1\r\nContent-Length: 11\r\n\r\nhello worldGET /next HTTP/1.1\r\n\r\n"
	messages := stream.Push([]byte(payload))
	if len(messages) != 2 || messages[0].Method != "POST" || messages[1].Method != "GET" {
		t.Fatalf("messages = %#v, want POST then GET", messages)
	}
}

func TestHTTP1ContentLengthBodyFragmented(t *testing.T) {
	stream := newHTTP1Stream()
	messages := stream.Push([]byte("POST /u HTTP/1.1\r\nContent-Length: 10\r\n\r\n123"))
	if len(messages) != 1 {
		t.Fatalf("expected request header parsed before body, got %#v", messages)
	}
	messages = stream.Push([]byte("4567890GET /after HTTP/1.1\r\n\r\n"))
	if len(messages) != 1 || messages[0].Method != "GET" {
		t.Fatalf("body tail handling = %#v, want GET", messages)
	}
}

func TestHTTP1ChunkedBodySkipped(t *testing.T) {
	stream := newHTTP1Stream()
	payload := "POST /upload HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n" +
		"5\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: v\r\n\r\n" +
		"GET /after HTTP/1.1\r\n\r\n"
	messages := stream.Push([]byte(payload))
	if len(messages) != 2 || messages[0].Method != "POST" || messages[1].Method != "GET" {
		t.Fatalf("chunked messages = %#v", messages)
	}
}

func TestHTTP1ChunkedBodyFragmented(t *testing.T) {
	stream := newHTTP1Stream()
	data := []byte("POST /u HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\nGET /n HTTP/1.1\r\n\r\n")
	var messages []http1Message
	for index := 0; index < len(data); index += 7 {
		end := index + 7
		if end > len(data) {
			end = len(data)
		}
		messages = append(messages, stream.Push(data[index:end])...)
	}
	if len(messages) != 2 || messages[1].Method != "GET" {
		t.Fatalf("fragmented chunked messages = %#v", messages)
	}
}

func TestHTTP1ResponseStatusLine(t *testing.T) {
	stream := newHTTP1Stream()
	messages := stream.Push([]byte("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n"))
	if len(messages) != 1 || messages[0].IsRequest || messages[0].StatusCode != 503 {
		t.Fatalf("response parse = %#v", messages)
	}
}

func TestHTTP1InvalidStartLineNotCounted(t *testing.T) {
	stream := newHTTP1Stream()
	messages := stream.Push([]byte("SSH-2.0-OpenSSH_9.6\r\n\r\n"))
	if len(messages) != 0 {
		t.Fatalf("invalid start line must not produce messages: %#v", messages)
	}
	if stream.TakeInvalid() == 0 {
		t.Fatalf("invalid start line should be counted for stats")
	}
}

func TestNormalizeHTTPMethod(t *testing.T) {
	if method, ok := normalizeHTTPMethod("get"); !ok || method != "GET" {
		t.Fatalf("lowercase method = %q/%v, want GET", method, ok)
	}
	long := strings.Repeat("A", 40)
	method, ok := normalizeHTTPMethod(long)
	if !ok || len(method) != httpMaxMethodLen {
		t.Fatalf("long method len = %d/%v, want %d", len(method), ok, httpMaxMethodLen)
	}
	if _, ok := normalizeHTTPMethod("GET /"); ok {
		t.Fatalf("method with space must be rejected")
	}
}

// ===========================================================================
// HTTP/2
// ===========================================================================

func TestHTTP2HeadersAcrossPackets(t *testing.T) {
	stream := newHTTP2Stream()
	frame := httpTestH2Frame(http2FrameHeaders, http2FlagEndHeaders, 1, []byte{0x83}) // :method POST
	var requests []http2Request
	// 拆成 4 段，覆盖帧头跨包与载荷跨包。
	for _, chunk := range [][]byte{frame[:3], frame[3:7], frame[7:9], frame[9:]} {
		requests = append(requests, stream.Push(chunk, true)...)
	}
	if len(requests) != 1 || requests[0].StreamID != 1 || requests[0].Method != "POST" {
		t.Fatalf("requests = %#v, want one POST on stream 1", requests)
	}
	// 同一 stream 的重复 HEADERS 不应重复计数。
	if extra := stream.Push(frame, true); len(extra) != 0 {
		t.Fatalf("duplicate stream must not count again: %#v", extra)
	}
	// 新 stream 正常计数。
	next := httpTestH2Frame(http2FrameHeaders, http2FlagEndHeaders, 3, []byte{0x82})
	if requests := stream.Push(next, true); len(requests) != 1 || requests[0].Method != "GET" {
		t.Fatalf("new stream requests = %#v", requests)
	}
}

func TestHTTP2ContinuationEndHeaders(t *testing.T) {
	stream := newHTTP2Stream()
	headers := httpTestH2Frame(http2FrameHeaders, 0, 5, []byte{0x83})
	if requests := stream.Push(headers, true); len(requests) != 0 {
		t.Fatalf("HEADERS without END_HEADERS must wait for CONTINUATION: %#v", requests)
	}
	continuation := httpTestH2Frame(http2FrameContinuation, http2FlagEndHeaders, 5, nil)
	requests := stream.Push(continuation, true)
	if len(requests) != 1 || requests[0].StreamID != 5 || requests[0].Method != "POST" {
		t.Fatalf("continuation requests = %#v", requests)
	}
}

func TestHTTP2ServerDirectionNotCounted(t *testing.T) {
	stream := newHTTP2Stream()
	frame := httpTestH2Frame(http2FrameHeaders, http2FlagEndHeaders, 1, nil)
	if requests := stream.Push(frame, false); len(requests) != 0 {
		t.Fatalf("server->client HEADERS must not count: %#v", requests)
	}
}

func TestHTTP2NonHeadersFramesIgnored(t *testing.T) {
	stream := newHTTP2Stream()
	data := httpTestH2Frame(0x0, 0, 1, []byte("hello"))
	settings := httpTestH2Frame(0x4, 0, 0, make([]byte, 6))
	requests := stream.Push(append(append(data, settings...), data...), true)
	if len(requests) != 0 {
		t.Fatalf("non-HEADERS frames must not count: %#v", requests)
	}
}

// ===========================================================================
// TCP 流重组 / 协议识别 / TLS
// ===========================================================================

func TestHTTPStreamSequenceDedupAndKeepAlive(t *testing.T) {
	stream := newHTTPStream()
	first := httpTestPacket("GET /a HTTP/1.1\r\n\r\n", 1000, httpTCPFlagACK|httpTCPFlagPSH)
	events := stream.Push(first, false)
	if len(events) != 1 || events[0].Method != "GET" {
		t.Fatalf("first events = %#v", events)
	}
	// 重传完全相同的报文：seq 已推进，不应重复计数。
	if events := stream.Push(first, false); len(events) != 0 {
		t.Fatalf("duplicate packet must be ignored: %#v", events)
	}
	next := httpTestPacket("GET /b HTTP/1.1\r\n\r\n", 1000+uint32(len(first.Payload)), httpTCPFlagACK|httpTCPFlagPSH)
	if events := stream.Push(next, false); len(events) != 1 {
		t.Fatalf("second request events = %#v", events)
	}
}

func TestHTTPStreamOverlapRetransmit(t *testing.T) {
	stream := newHTTPStream()
	payload := "GET /overlap HTTP/1.1\r\n\r\n"
	first := httpTestPacket(payload[:10], 2000, httpTCPFlagACK)
	if events := stream.Push(first, false); len(events) != 0 {
		t.Fatalf("partial request must not count yet")
	}
	// 从偏移 5 开始重传重叠数据，应只补足一次。
	overlap := httpTestPacket(payload[5:], 2005, httpTCPFlagACK)
	events := stream.Push(overlap, false)
	if len(events) != 1 || events[0].Method != "GET" {
		t.Fatalf("overlap events = %#v", events)
	}
}

func TestHTTPStreamGapResetDoesNotCrashAndRecovers(t *testing.T) {
	stream := newHTTPStream()
	first := httpTestPacket("GET /a HTTP/1.1\r\n\r\n", 3000, httpTCPFlagACK)
	if events := stream.Push(first, false); len(events) != 1 {
		t.Fatalf("first events = %#v", events)
	}
	// 模拟丢包：seq 跳变，流状态重置。
	gap := httpTestPacket("GET /b HTTP/1.1\r\n\r\n", 9000, httpTCPFlagACK)
	events := stream.Push(gap, false)
	if len(events) != 1 || events[0].Method != "GET" {
		t.Fatalf("after gap events = %#v, want recovered GET", events)
	}
	if stream.TakeDropped() == 0 {
		t.Fatalf("gap should be counted as dropped")
	}
}

func TestHTTPStreamFragmentedRequestLine(t *testing.T) {
	stream := newHTTPStream()
	if events := stream.Push(httpTestPacket("GE", 4000, httpTCPFlagACK), false); len(events) != 0 {
		t.Fatalf("fragment must not count yet: %#v", events)
	}
	events := stream.Push(httpTestPacket("T /frag HTTP/1.1\r\n\r\n", 4002, httpTCPFlagACK), false)
	if len(events) != 1 || events[0].Method != "GET" {
		t.Fatalf("fragmented request events = %#v", events)
	}
}

func TestHTTPStreamTLSNotParsed(t *testing.T) {
	stream := newHTTPStream()
	clientHello := []byte{0x16, 0x03, 0x01, 0x00, 0x35, 0x01, 0x00, 0x00, 0x31}
	if events := stream.Push(httpTestPacket(string(clientHello), 5000, httpTCPFlagACK), false); len(events) != 0 {
		t.Fatalf("TLS must not parse: %#v", events)
	}
	// 同方向后续即使出现 HTTP 文本也不应被误判（seq 连续，仍在同一 TLS 流内）。
	if events := stream.Push(httpTestPacket("GET /x HTTP/1.1\r\n\r\n", 5009, httpTCPFlagACK), false); len(events) != 0 {
		t.Fatalf("TLS stream must stay opaque: %#v", events)
	}
}

func TestHTTPStreamNonHTTPTrafficIgnored(t *testing.T) {
	stream := newHTTPStream()
	rawBinary := []byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f}
	if events := stream.Push(httpTestPacket(string(rawBinary), 6000, httpTCPFlagACK), false); len(events) != 0 {
		t.Fatalf("binary stream must not count: %#v", events)
	}
	// SSH banner（首行不是合法 HTTP 请求），不产生请求事件。
	ssh := newHTTPStream()
	if events := ssh.Push(httpTestPacket("SSH-2.0-OpenSSH_9.6\r\n", 7000, httpTCPFlagACK), false); len(events) != 0 {
		t.Fatalf("SSH banner must not count: %#v", events)
	}
}

// ===========================================================================
// 流引擎与方向映射
// ===========================================================================

func TestHTTPFlowEngineCountsRequest(t *testing.T) {
	engine := newHTTPFlowEngine(16)
	syn := httpTCPPacket{
		SrcIP: net.ParseIP("192.0.2.10"), DstIP: net.ParseIP("198.51.100.5"),
		SrcPort: 40000, DstPort: 8080, Seq: 1000, Flags: httpTCPFlagSYN,
	}
	engine.HandlePacket(syn, time.Now())
	request := httpTCPPacket{
		SrcIP: net.ParseIP("192.0.2.10"), DstIP: net.ParseIP("198.51.100.5"),
		SrcPort: 40000, DstPort: 8080, Seq: 1001, Flags: httpTCPFlagACK | httpTCPFlagPSH,
		Payload: []byte("GET /api HTTP/1.1\r\nHost: x\r\n\r\n"),
	}
	engine.HandlePacket(request, time.Now())
	observations := engine.Drain()
	if len(observations) != 1 {
		t.Fatalf("observations = %#v, want 1", observations)
	}
	observation := observations[0]
	if observation.ClientAddress != "192.0.2.10" || observation.ClientPort != 40000 ||
		observation.ServerAddress != "198.51.100.5" || observation.ServerPort != 8080 {
		t.Fatalf("unexpected observation: %#v", observation)
	}
	if observation.Protocol != httpProtocolHTTP1 || observation.Method != "GET" {
		t.Fatalf("protocol/method = %q/%q", observation.Protocol, observation.Method)
	}
}

func TestHTTPFlowEngineHTTP2WithoutSYNUsesServicePorts(t *testing.T) {
	engine := newHTTPFlowEngine(16)
	engine.SetServicePorts(map[int]bool{50051: true})
	headers := httpTestH2Frame(http2FrameHeaders, http2FlagEndHeaders, 1, []byte{0x83})
	packet := httpTCPPacket{
		SrcIP: net.ParseIP("192.0.2.10"), DstIP: net.ParseIP("198.51.100.5"),
		SrcPort: 40000, DstPort: 50051, Seq: 5000, Flags: httpTCPFlagACK | httpTCPFlagPSH,
		Payload: headers,
	}
	engine.HandlePacket(packet, time.Now())
	observations := engine.Drain()
	if len(observations) != 1 {
		t.Fatalf("observations = %#v, want 1", observations)
	}
	if observations[0].Protocol != httpProtocolHTTP2 || observations[0].Method != "POST" {
		t.Fatalf("unexpected observation: %#v", observations[0])
	}
}

func TestMapHTTPObservationDirections(t *testing.T) {
	services := map[int]string{8080: "order-service", 50051: "grpc-server"}
	grpcPorts := map[int]bool{50051: true}
	localIPs := map[string]bool{"10.0.0.2": true, "127.0.0.1": true}
	isLocal := func(address string) bool { return localIPs[address] }
	listening := map[int]bool{8080: true, 50051: true}

	// 本机是服务端 → in。
	inbound, ok := mapHTTPObservation(httpRequestObservation{
		ClientAddress: "203.0.113.7", ClientPort: 51000,
		ServerAddress: "10.0.0.2", ServerPort: 8080,
		Protocol: httpProtocolHTTP1, Method: "GET",
	}, isLocal, listening, services, grpcPorts)
	if !ok || inbound.Direction != connDirectionIn || inbound.LocalPort != 8080 || inbound.PeerPort != 51000 || inbound.Service != "order-service" {
		t.Fatalf("inbound edge = %#v/%v", inbound, ok)
	}

	// 本机是客户端 → out。
	outbound, ok := mapHTTPObservation(httpRequestObservation{
		ClientAddress: "10.0.0.2", ClientPort: 41000,
		ServerAddress: "203.0.113.9", ServerPort: 8080,
		Protocol: httpProtocolHTTP1, Method: "POST",
	}, isLocal, listening, services, grpcPorts)
	if !ok || outbound.Direction != connDirectionOut || outbound.LocalPort != 41000 || outbound.PeerPort != 8080 {
		t.Fatalf("outbound edge = %#v/%v", outbound, ok)
	}

	// 两端本机（内部流量）→ 丢弃。
	if _, ok := mapHTTPObservation(httpRequestObservation{
		ClientAddress: "10.0.0.2", ClientPort: 41000,
		ServerAddress: "10.0.0.2", ServerPort: 8080,
		Protocol: httpProtocolHTTP1, Method: "GET",
	}, isLocal, listening, services, grpcPorts); ok {
		t.Fatalf("internal traffic must be skipped")
	}

	// gRPC 端口 → protocol=grpc、方法补 POST。
	grpc, ok := mapHTTPObservation(httpRequestObservation{
		ClientAddress: "10.0.0.2", ClientPort: 41000,
		ServerAddress: "203.0.113.9", ServerPort: 50051,
		Protocol: httpProtocolHTTP2,
	}, isLocal, listening, services, grpcPorts)
	if !ok || grpc.Protocol != httpProtocolGRPC || grpc.Method != "POST" {
		t.Fatalf("grpc edge = %#v/%v", grpc, ok)
	}
}

// ===========================================================================
// 窗口聚合 / JSON / 上报缓存
// ===========================================================================

func httpTestEdge(method, peer string, peerPort int) httpRequestEdge {
	return httpRequestEdge{
		Direction:    connDirectionOut,
		Protocol:     httpProtocolHTTP1,
		Method:       method,
		LocalAddress: "10.0.0.2",
		LocalPort:    40000,
		PeerAddress:  peer,
		PeerPort:     peerPort,
		Requests:     1,
	}
}

func TestHTTPWindowAggregatorAggregatesAndFlushes(t *testing.T) {
	base := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	aggregator := newHTTPWindowAggregator(10*time.Second, 200)
	aggregator.Start(base)
	aggregator.CountPacket()
	aggregator.AddDropped(2)

	edge := httpTestEdge("GET", "10.0.0.9", 8080)
	aggregator.Add(edge, base.Add(time.Second))
	aggregator.Add(edge, base.Add(2*time.Second))

	if window := aggregator.FlushIfDue(base.Add(5*time.Second), 3); window != nil {
		t.Fatalf("window must not flush mid-window")
	}
	window := aggregator.FlushIfDue(base.Add(10*time.Second), 3)
	if window == nil {
		t.Fatalf("expected window at boundary")
	}
	if len(window.Requests) != 1 {
		t.Fatalf("requests = %#v, want 1 aggregated edge", window.Requests)
	}
	result := window.Requests[0]
	if result.Requests != 2 || result.FirstSeen != "2026-11-11T10:00:01Z" || result.LastSeen != "2026-11-11T10:00:02Z" {
		t.Fatalf("aggregated edge = %#v", result)
	}
	if window.Start != "2026-11-11T10:00:00Z" || window.End != "2026-11-11T10:00:10Z" || window.Source != httpSourceUserspace {
		t.Fatalf("window bounds/source = %s..%s/%s", window.Start, window.End, window.Source)
	}
	if window.Stats == nil || window.Stats.Packets != 1 || window.Stats.Flows != 3 || window.Stats.Dropped != 2 {
		t.Fatalf("stats = %#v", window.Stats)
	}
}

func TestHTTPWindowAggregatorMaxEdges(t *testing.T) {
	base := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	aggregator := newHTTPWindowAggregator(10*time.Second, 2)
	aggregator.Start(base)
	for index := 0; index < 5; index++ {
		edge := httpTestEdge("GET", "10.0.0."+string(rune('1'+index)), 8080)
		edge.Requests = index + 1
		aggregator.Add(edge, base.Add(time.Second))
	}
	window := aggregator.FlushIfDue(base.Add(10*time.Second), 1)
	if window == nil || len(window.Requests) != 2 {
		t.Fatalf("window edges = %d, want 2", len(window.Requests))
	}
	if window.Stats.Dropped != 3 {
		t.Fatalf("dropped = %d, want 3", window.Stats.Dropped)
	}
	if window.Requests[0].Requests < window.Requests[1].Requests {
		t.Fatalf("edges not sorted by weight: %#v", window.Requests)
	}
}

func TestHTTPWindowJSONStructure(t *testing.T) {
	window := httpRequestWindow{
		Start:  "2026-11-11T10:00:00Z",
		End:    "2026-11-11T10:00:10Z",
		Source: httpSourceUserspace,
		Requests: []httpRequestEdge{{
			Direction:    connDirectionIn,
			Protocol:     httpProtocolGRPC,
			Method:       "POST",
			LocalAddress: "10.0.0.2",
			LocalPort:    50051,
			PeerAddress:  "203.0.113.7",
			PeerPort:     51000,
			Service:      "grpc-server",
			Requests:     3,
			Errors:       1,
			FirstSeen:    "2026-11-11T10:00:01Z",
			LastSeen:     "2026-11-11T10:00:09Z",
		}},
		Stats: &httpRequestStats{Packets: 10, Flows: 2, Dropped: 0},
	}
	body, err := json.Marshal(window)
	if err != nil {
		t.Fatalf("marshal window: %v", err)
	}
	t.Logf("http request window payload example: %s", body)

	var generic map[string]json.RawMessage
	if err := json.Unmarshal(body, &generic); err != nil {
		t.Fatalf("unmarshal window: %v", err)
	}
	httpTestAssertKeys(t, generic, []string{"start", "end", "source", "requests", "stats"})

	var requests []json.RawMessage
	if err := json.Unmarshal(generic["requests"], &requests); err != nil || len(requests) != 1 {
		t.Fatalf("unmarshal requests: err=%v len=%d", err, len(requests))
	}
	var edge map[string]json.RawMessage
	if err := json.Unmarshal(requests[0], &edge); err != nil {
		t.Fatalf("unmarshal edge: %v", err)
	}
	httpTestAssertKeys(t, edge, []string{
		"direction", "protocol", "method", "localAddress", "localPort", "peerAddress",
		"peerPort", "service", "requests", "errors", "firstSeen", "lastSeen",
	})

	var stats map[string]json.RawMessage
	if err := json.Unmarshal(generic["stats"], &stats); err != nil {
		t.Fatalf("unmarshal stats: %v", err)
	}
	httpTestAssertKeys(t, stats, []string{"packets", "flows", "dropped"})
}

func TestHTTPWindowReporterCachesAndAcks(t *testing.T) {
	reporter := newHTTPWindowReporter(10 * time.Second)
	base := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	reporter.pushAt(httpRequestWindow{Start: connWindowStart(base), End: connWindowEnd(base), Source: httpSourceUserspace, Requests: []httpRequestEdge{}}, base)
	if pending := reporter.snapshot(); len(pending) != 0 {
		t.Fatalf("empty window must not queue: %d", len(pending))
	}
	for index := 0; index < 15; index++ {
		start := base.Add(time.Duration(index) * 10 * time.Second)
		reporter.pushAt(httpRequestWindow{
			Start: connWindowStart(start), End: connWindowEnd(start), Source: httpSourceUserspace,
			Requests: []httpRequestEdge{httpTestEdge("GET", "10.0.0.9", 8080)},
		}, base)
	}
	if pending := reporter.snapshot(); len(pending) != httpReporterMaxWindows {
		t.Fatalf("pending = %d, want %d", len(pending), httpReporterMaxWindows)
	}
	reporter.ack(5)
	if pending := reporter.snapshot(); len(pending) != httpReporterMaxWindows-5 {
		t.Fatalf("pending after ack = %d", len(pending))
	}
	metrics := reporter.metrics()
	if metrics["source"] != httpSourceUserspace || metrics["windowSeconds"] != 10 {
		t.Fatalf("metrics = %#v", metrics)
	}
}

func TestHeartbeatRequestHTTPRequestWindowsJSON(t *testing.T) {
	window := httpRequestWindow{
		Start:  "2026-11-11T10:00:00Z",
		End:    "2026-11-11T10:00:10Z",
		Source: httpSourceUserspace,
		Requests: []httpRequestEdge{{
			Direction: connDirectionOut, Protocol: httpProtocolHTTP1, Method: "GET",
			LocalAddress: "10.0.0.2", LocalPort: 41000, PeerAddress: "10.0.0.9", PeerPort: 8080,
			Requests: 5, Errors: 0,
		}},
		Stats: &httpRequestStats{Packets: 40, Flows: 2, Dropped: 0},
	}
	body, err := json.Marshal(heartbeatRequest{
		AgentKey:           "key",
		Metrics:            map[string]any{"cpuCores": 2},
		HTTPRequestWindows: []httpRequestWindow{window},
	})
	if err != nil {
		t.Fatalf("marshal heartbeat: %v", err)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("unmarshal heartbeat: %v", err)
	}
	if _, ok := payload["httpRequestWindows"]; !ok {
		t.Fatalf("heartbeat must include httpRequestWindows: %s", body)
	}
	if _, ok := payload["connectionWindows"]; ok {
		t.Fatalf("empty connectionWindows must be omitted: %s", body)
	}
	var windows []httpRequestWindow
	if err := json.Unmarshal(payload["httpRequestWindows"], &windows); err != nil || len(windows) != 1 {
		t.Fatalf("unmarshal windows: err=%v len=%d", err, len(windows))
	}
	if windows[0].Requests[0].Requests != 5 || windows[0].Source != httpSourceUserspace {
		t.Fatalf("unexpected window: %#v", windows[0])
	}
}

func httpTestAssertKeys(t *testing.T, object map[string]json.RawMessage, expected []string) {
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

func connWindowStart(value time.Time) string {
	return value.UTC().Format(time.RFC3339)
}

func connWindowEnd(value time.Time) string {
	return value.Add(10 * time.Second).UTC().Format(time.RFC3339)
}
