package main

// HTTP/gRPC 请求级计数（平台无关部分）。
//
// 本文件只做纯解析、流重组、窗口聚合与心跳缓存，不直接访问网卡，
// 因此可以在任意平台单测；AF_PACKET 抓包在 http_observe_linux.go。
//
// 解析链路：Ethernet/VLAN → IPv4/IPv6 → TCP → 每方向流重组（seq 顺序）
// → HTTP/1 请求行与消息体跳过 / HTTP/2 帧（HEADERS + END_HEADERS）。
// 仅统计明文流量；TLS（HTTP/2 over TLS、gRPC-TLS）无法解密，不计数。

import (
	"bytes"
	"encoding/binary"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	httpProtocolHTTP1 = "http1"
	httpProtocolHTTP2 = "http2"
	httpProtocolGRPC  = "grpc"

	httpProtocolTLS    = "tls"
	httpProtocolOpaque = "opaque"

	httpSourceUserspace = "userspace"

	httpDefaultWindow    = 10 * time.Second
	httpDefaultMaxEdges  = 200
	httpDefaultGRPCPorts = "50051,9090"

	httpMaxMethodLen    = 16
	httpMaxHeaderBytes  = 32 * 1024
	httpMaxFlowBuffer   = 128 * 1024
	httpMaxH2FrameLen   = 16 * 1024 * 1024
	httpDefaultMaxFlows = 8192
	httpFlowIdleTimeout = 90 * time.Second
	// Control 侧单次心跳最多接收 10 个 HTTP 请求窗口，这里保持一致。
	httpReporterMaxWindows = 10
)

// httpTCPFlags 是 TCP 标志位（与内核一致）。
const (
	httpTCPFlagFIN = 0x01
	httpTCPFlagSYN = 0x02
	httpTCPFlagRST = 0x04
	httpTCPFlagPSH = 0x08
	httpTCPFlagACK = 0x10
)

// httpTCPPacket 是一条解码后的 TCP 报文（仅 TCP，不含 UDP/ICMP）。
type httpTCPPacket struct {
	SrcIP   net.IP
	DstIP   net.IP
	SrcPort int
	DstPort int
	Seq     uint32
	Ack     uint32
	Flags   uint8
	Payload []byte
}

// ===========================================================================
// 二层/三层/四层解析
// ===========================================================================

// decodeHTTPFrame 把 AF_PACKET 抓到的以太网帧解析成 TCP 报文。
func decodeHTTPFrame(frame []byte) (httpTCPPacket, bool) {
	etherType, payload, ok := decodeHTTPEthernet(frame)
	if !ok {
		return httpTCPPacket{}, false
	}
	var srcIP, dstIP net.IP
	var protocol uint8
	var l4 []byte
	switch etherType {
	case 0x0800:
		srcIP, dstIP, protocol, l4, ok = decodeHTTPIPv4(payload)
	case 0x86DD:
		srcIP, dstIP, protocol, l4, ok = decodeHTTPIPv6(payload)
	default:
		return httpTCPPacket{}, false
	}
	if !ok || protocol != 6 { // 6 = IPPROTO_TCP
		return httpTCPPacket{}, false
	}
	header, data, ok := decodeHTTPTCP(l4)
	if !ok {
		return httpTCPPacket{}, false
	}
	return httpTCPPacket{
		SrcIP:   srcIP,
		DstIP:   dstIP,
		SrcPort: header.srcPort,
		DstPort: header.dstPort,
		Seq:     header.seq,
		Ack:     header.ack,
		Flags:   header.flags,
		Payload: data,
	}, true
}

// decodeHTTPEthernet 解析以太网头与单/多层 VLAN 标签(802.1Q / QinQ)。
func decodeHTTPEthernet(frame []byte) (uint16, []byte, bool) {
	if len(frame) < 14 {
		return 0, nil, false
	}
	etherType := binary.BigEndian.Uint16(frame[12:14])
	offset := 14
	for etherType == 0x8100 || etherType == 0x88A8 || etherType == 0x9100 {
		if len(frame) < offset+4 {
			return 0, nil, false
		}
		etherType = binary.BigEndian.Uint16(frame[offset+2 : offset+4])
		offset += 4
	}
	if len(frame) <= offset {
		return 0, nil, false
	}
	return etherType, frame[offset:], true
}

// decodeHTTPIPv4 解析 IPv4 头；分片报文直接跳过（只处理完整 TCP 段）。
func decodeHTTPIPv4(payload []byte) (net.IP, net.IP, uint8, []byte, bool) {
	if len(payload) < 20 || payload[0]>>4 != 4 {
		return nil, nil, 0, nil, false
	}
	headerLen := int(payload[0]&0x0f) * 4
	if headerLen < 20 || headerLen > len(payload) {
		return nil, nil, 0, nil, false
	}
	// 分片标志/偏移非 0：不处理（避免只拿到半个 TCP 段）。
	if binary.BigEndian.Uint16(payload[6:8])&0x3fff != 0 {
		return nil, nil, 0, nil, false
	}
	totalLen := int(binary.BigEndian.Uint16(payload[2:4]))
	if totalLen < headerLen || totalLen > len(payload) {
		totalLen = len(payload)
	}
	src := net.IP(append([]byte(nil), payload[12:16]...))
	dst := net.IP(append([]byte(nil), payload[16:20]...))
	return src, dst, payload[9], payload[headerLen:totalLen], true
}

// decodeHTTPIPv6 解析 IPv6 头与常见扩展头（Hop-by-Hop/Routing/Dest/AH）；
// 分片、ESP、其他非 TCP 负载直接跳过。
func decodeHTTPIPv6(payload []byte) (net.IP, net.IP, uint8, []byte, bool) {
	if len(payload) < 40 || payload[0]>>4 != 6 {
		return nil, nil, 0, nil, false
	}
	payloadLen := int(binary.BigEndian.Uint16(payload[4:6]))
	end := 40 + payloadLen
	if payloadLen == 0 || end > len(payload) {
		end = len(payload)
	}
	src := net.IP(append([]byte(nil), payload[8:24]...))
	dst := net.IP(append([]byte(nil), payload[24:40]...))
	nextHeader := payload[6]
	offset := 40
	for depth := 0; depth < 8; depth++ {
		switch nextHeader {
		case 6: // TCP
			return src, dst, 6, payload[offset:end], true
		case 0, 43, 60: // Hop-by-Hop / Routing / Destination Options
			if offset+2 > end {
				return nil, nil, 0, nil, false
			}
			headerLen := int(payload[offset+1])*8 + 8
			if headerLen < 8 || offset+headerLen > end {
				return nil, nil, 0, nil, false
			}
			nextHeader = payload[offset]
			offset += headerLen
		case 51: // Authentication Header
			if offset+2 > end {
				return nil, nil, 0, nil, false
			}
			headerLen := (int(payload[offset+1]) + 2) * 4
			if headerLen < 8 || offset+headerLen > end {
				return nil, nil, 0, nil, false
			}
			nextHeader = payload[offset]
			offset += headerLen
		default:
			// 44=Fragment / 50=ESP / UDP/ICMP 等：不解析。
			return nil, nil, 0, nil, false
		}
	}
	return nil, nil, 0, nil, false
}

type httpTCPHeader struct {
	srcPort int
	dstPort int
	seq     uint32
	ack     uint32
	flags   uint8
}

// decodeHTTPTCP 解析 TCP 头并返回载荷（已按 data offset 去掉选项）。
func decodeHTTPTCP(l4 []byte) (httpTCPHeader, []byte, bool) {
	if len(l4) < 20 {
		return httpTCPHeader{}, nil, false
	}
	dataOffset := int(l4[12]>>4) * 4
	if dataOffset < 20 || dataOffset > len(l4) {
		return httpTCPHeader{}, nil, false
	}
	return httpTCPHeader{
		srcPort: int(binary.BigEndian.Uint16(l4[0:2])),
		dstPort: int(binary.BigEndian.Uint16(l4[2:4])),
		seq:     binary.BigEndian.Uint32(l4[4:8]),
		ack:     binary.BigEndian.Uint32(l4[8:12]),
		flags:   l4[13],
	}, l4[dataOffset:], true
}

// ===========================================================================
// HTTP/1
// ===========================================================================

type http1Message struct {
	IsRequest  bool
	Method     string
	StatusCode int
}

// http1Stream 是单方向 TCP 字节流上的 HTTP/1 消息解析器：
// 逐条解析消息头，完整跳过 Content-Length / chunked 消息体，支持 keep-alive。
type http1Stream struct {
	buf           []byte
	bodyRemaining int64
	chunked       bool
	chunkRemain   int64
	chunkNeedCRLF bool
	invalid       int
	headerLimit   int
}

func newHTTP1Stream() *http1Stream {
	return &http1Stream{headerLimit: httpMaxHeaderBytes}
}

// Push 追加字节并返回本次能完整解析出的消息（请求或响应）。
func (stream *http1Stream) Push(data []byte) []http1Message {
	if len(data) == 0 {
		return nil
	}
	stream.buf = append(stream.buf, data...)
	var messages []http1Message
	for {
		if stream.bodyRemaining > 0 {
			n := int64(len(stream.buf))
			if n > stream.bodyRemaining {
				n = stream.bodyRemaining
			}
			if n == 0 {
				return messages
			}
			stream.buf = stream.buf[n:]
			stream.bodyRemaining -= n
			if stream.bodyRemaining > 0 {
				return messages
			}
			continue
		}
		if stream.chunked {
			if !stream.consumeChunked() {
				return messages
			}
			continue
		}
		index := bytes.Index(stream.buf, []byte("\r\n\r\n"))
		if index < 0 {
			if len(stream.buf) > stream.headerLimit {
				stream.invalid++
				stream.buf = nil
			}
			return messages
		}
		head := stream.buf[:index]
		stream.buf = stream.buf[index+4:]
		if message, ok := stream.parseHeaderBlock(head); ok {
			messages = append(messages, message)
		}
	}
}

func (stream *http1Stream) parseHeaderBlock(head []byte) (http1Message, bool) {
	lines := bytes.Split(head, []byte("\r\n"))
	message, ok := parseHTTP1StartLine(string(lines[0]))
	if !ok {
		stream.invalid++
		return http1Message{}, false
	}
	contentLength, chunked := parseHTTP1Headers(lines[1:])
	if chunked {
		stream.chunked = true
		stream.chunkRemain = 0
		stream.chunkNeedCRLF = false
	} else if contentLength > 0 {
		stream.bodyRemaining = int64(contentLength)
	}
	return message, true
}

// consumeChunked 推进 chunked 消息体跳过状态机。返回 true 表示有进展，
// 需要主循环继续；false 表示数据不足等待下一次 Push。
func (stream *http1Stream) consumeChunked() bool {
	if stream.chunkNeedCRLF {
		if len(stream.buf) < 2 {
			return false
		}
		if !bytes.HasPrefix(stream.buf, []byte("\r\n")) {
			stream.resetChunked()
			return true
		}
		stream.buf = stream.buf[2:]
		stream.chunkNeedCRLF = false
	}
	if stream.chunkRemain > 0 {
		n := int64(len(stream.buf))
		if n == 0 {
			return false
		}
		if n > stream.chunkRemain {
			n = stream.chunkRemain
		}
		stream.buf = stream.buf[n:]
		stream.chunkRemain -= n
		if stream.chunkRemain > 0 {
			return false
		}
		stream.chunkNeedCRLF = true
		return true
	}
	index := bytes.Index(stream.buf, []byte("\r\n"))
	if index < 0 {
		if len(stream.buf) > 4096 {
			stream.resetChunked()
			stream.invalid++
		}
		return false
	}
	line := strings.TrimSpace(string(stream.buf[:index]))
	stream.buf = stream.buf[index+2:]
	if semi := strings.IndexByte(line, ';'); semi >= 0 {
		line = strings.TrimSpace(line[:semi])
	}
	size, err := strconv.ParseInt(line, 16, 64)
	if err != nil || size < 0 {
		stream.resetChunked()
		stream.invalid++
		return true
	}
	if size == 0 {
		// 末尾可能跟 trailer 头，读到空行为止。
		for {
			index := bytes.Index(stream.buf, []byte("\r\n"))
			if index < 0 {
				return false
			}
			empty := index == 0
			stream.buf = stream.buf[index+2:]
			if empty {
				stream.chunked = false
				return true
			}
		}
	}
	stream.chunkRemain = size
	return true
}

func (stream *http1Stream) resetChunked() {
	stream.chunked = false
	stream.chunkRemain = 0
	stream.chunkNeedCRLF = false
	stream.buf = nil
}

// TakeInvalid 取出并清空无效消息计数（用于窗口 stats.dropped）。
func (stream *http1Stream) TakeInvalid() int {
	value := stream.invalid
	stream.invalid = 0
	return value
}

// parseHTTP1StartLine 解析请求行或响应状态行。
func parseHTTP1StartLine(line string) (http1Message, bool) {
	fields := strings.Fields(line)
	if len(fields) == 3 && strings.HasPrefix(fields[2], "HTTP/1.") {
		method, ok := normalizeHTTPMethod(fields[0])
		if !ok {
			return http1Message{}, false
		}
		return http1Message{IsRequest: true, Method: method}, true
	}
	if len(fields) >= 2 && strings.HasPrefix(fields[0], "HTTP/1.") {
		status, err := strconv.Atoi(fields[1])
		if err != nil || status < 100 || status > 999 {
			return http1Message{}, false
		}
		return http1Message{StatusCode: status}, true
	}
	return http1Message{}, false
}

// parseHTTP1Headers 提取 Content-Length 与 Transfer-Encoding: chunked。
func parseHTTP1Headers(lines [][]byte) (contentLength int, chunked bool) {
	for _, raw := range lines {
		line := bytes.TrimSpace(raw)
		if len(line) == 0 {
			continue
		}
		name, value, ok := bytes.Cut(line, []byte(":"))
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(string(name))) {
		case "content-length":
			if parsed, err := strconv.Atoi(strings.TrimSpace(string(value))); err == nil && parsed > 0 {
				contentLength = parsed
			}
		case "transfer-encoding":
			if strings.Contains(strings.ToLower(string(value)), "chunked") {
				chunked = true
			}
		}
	}
	return contentLength, chunked
}

// normalizeHTTPMethod 校验并归一化方法名：转大写、截断到 16 字符。
func normalizeHTTPMethod(raw string) (string, bool) {
	if raw == "" || len(raw) > 64 {
		return "", false
	}
	upper := strings.ToUpper(raw)
	if !isHTTPMethodChar(upper[0]) || (upper[0] < 'A' || upper[0] > 'Z') {
		return "", false
	}
	for index := 0; index < len(upper); index++ {
		if !isHTTPMethodChar(upper[index]) {
			return "", false
		}
	}
	if len(upper) > httpMaxMethodLen {
		upper = upper[:httpMaxMethodLen]
	}
	return upper, true
}

func isHTTPMethodChar(char byte) bool {
	switch {
	case char >= 'A' && char <= 'Z':
		return true
	case char >= '0' && char <= '9':
		return true
	}
	return strings.ContainsRune("!#$%&'*+-.^_`|~", rune(char))
}

// ===========================================================================
// HTTP/2
// ===========================================================================

const (
	http2FrameHeaders      = 0x1
	http2FrameContinuation = 0x9
	http2FlagEndHeaders    = 0x4
)

type http2Request struct {
	StreamID uint32
	Method   string
}

// http2Stream 解析单方向 HTTP/2 帧流；只在 client→server 方向计数。
// 一个 stream 的首个 HEADERS（或后续 CONTINUATION 带 END_HEADERS）只计一次。
type http2Stream struct {
	buf        []byte
	counted    map[uint32]bool
	pending    map[uint32]string
	maxStreams int
}

func newHTTP2Stream() *http2Stream {
	return &http2Stream{
		counted:    map[uint32]bool{},
		pending:    map[uint32]string{},
		maxStreams: 16384,
	}
}

func (stream *http2Stream) Push(data []byte, clientToServer bool) []http2Request {
	stream.buf = append(stream.buf, data...)
	var requests []http2Request
	for len(stream.buf) >= 9 {
		length := int(stream.buf[0])<<16 | int(stream.buf[1])<<8 | int(stream.buf[2])
		frameType := stream.buf[3]
		flags := stream.buf[4]
		streamID := binary.BigEndian.Uint32(stream.buf[5:9]) & 0x7fffffff
		if length > httpMaxH2FrameLen {
			stream.reset()
			return requests
		}
		if len(stream.buf) < 9+length {
			break
		}
		payload := stream.buf[9 : 9+length]
		stream.buf = stream.buf[9+length:]
		if !clientToServer {
			continue
		}
		switch frameType {
		case http2FrameHeaders:
			if streamID == 0 || stream.counted[streamID] {
				continue
			}
			method := hpackStaticMethod(payload)
			if flags&http2FlagEndHeaders != 0 {
				stream.counted[streamID] = true
				delete(stream.pending, streamID)
				requests = append(requests, http2Request{StreamID: streamID, Method: method})
			} else {
				stream.pending[streamID] = method
			}
		case http2FrameContinuation:
			if streamID == 0 || flags&http2FlagEndHeaders == 0 || stream.counted[streamID] {
				continue
			}
			if method, ok := stream.pending[streamID]; ok {
				stream.counted[streamID] = true
				delete(stream.pending, streamID)
				requests = append(requests, http2Request{StreamID: streamID, Method: method})
			}
		}
	}
	if len(stream.buf) > httpMaxFlowBuffer || len(stream.counted) > stream.maxStreams {
		stream.reset()
	}
	return requests
}

func (stream *http2Stream) reset() {
	stream.buf = nil
	stream.counted = map[uint32]bool{}
	stream.pending = map[uint32]string{}
}

// hpackStaticMethod 从 HEADERS 载荷首字节识别 HPACK 静态表索引的 :method。
// 只处理最常见的 GET(0x82)/POST(0x83)，其余返回空（由上报层补默认值）。
func hpackStaticMethod(payload []byte) string {
	if len(payload) == 0 {
		return ""
	}
	switch payload[0] {
	case 0x82:
		return "GET"
	case 0x83:
		return "POST"
	}
	return ""
}

// ===========================================================================
// TCP 流重组（seq 顺序 + 协议识别）
// ===========================================================================

type httpStreamEventKind int

const (
	httpStreamEventRequest httpStreamEventKind = iota
	httpStreamEventServerError
)

type httpStreamEvent struct {
	Kind       httpStreamEventKind
	Protocol   string
	Method     string
	StatusCode int
}

// httpStream 是单个 TCP 方向的字节流状态：按 seq 去重/排序，识别协议，
// 交给 HTTP/1 或 HTTP/2 解析器。乱序/缺口/超限时重置该方向，保证不崩。
type httpStream struct {
	seqSet        bool
	nextSeq       uint32
	buf           []byte
	protocol      string // "" 未识别 / http1 / http2 / tls / opaque
	http1         *http1Stream
	http2         *http2Stream
	streamDropped int
}

func newHTTPStream() *httpStream {
	return &httpStream{}
}

func (stream *httpStream) reset() {
	stream.seqSet = false
	stream.nextSeq = 0
	stream.buf = nil
	stream.protocol = ""
	stream.http1 = nil
	stream.http2 = nil
}

// resetStream 只重置解析状态（保留 seq 状态），用于确认缺口后从新字节继续。
func (stream *httpStream) resetStream() {
	stream.buf = nil
	stream.protocol = ""
	stream.http1 = nil
	stream.http2 = nil
}

// Push 处理一个 TCP 报文，返回本次识别到的 HTTP 事件。
// clientToServer 仅对 HTTP/2 HEADERS 计数生效（HTTP/1 靠请求行判断方向）。
func (stream *httpStream) Push(packet httpTCPPacket, clientToServer bool) []httpStreamEvent {
	if packet.Flags&httpTCPFlagSYN != 0 {
		stream.reset()
		stream.seqSet = true
		stream.nextSeq = packet.Seq + 1
		if len(packet.Payload) == 0 {
			return nil
		}
		packet.Seq++
	}
	if packet.Flags&httpTCPFlagRST != 0 {
		stream.reset()
		return nil
	}
	if len(packet.Payload) == 0 {
		return nil
	}
	if !stream.seqSet {
		stream.seqSet = true
		stream.nextSeq = packet.Seq
	}
	delta := int32(packet.Seq - stream.nextSeq)
	var data []byte
	switch {
	case delta == 0:
		data = packet.Payload
	case delta < 0:
		overlap := int(-delta)
		if overlap >= len(packet.Payload) {
			return nil // 完全重复的报文
		}
		data = packet.Payload[overlap:]
	default:
		// 缺口/乱序：重置该方向解析状态，避免把缺失字节拼成错误请求。
		stream.resetStream()
		stream.streamDropped++
		data = packet.Payload
	}
	stream.nextSeq = packet.Seq + uint32(len(packet.Payload))
	stream.buf = append(stream.buf, data...)
	if len(stream.buf) > httpMaxFlowBuffer {
		stream.resetStream()
		stream.streamDropped++
		return nil
	}
	stream.ensureProtocol()
	switch stream.protocol {
	case httpProtocolHTTP1:
		if stream.http1 == nil {
			stream.http1 = newHTTP1Stream()
		}
		buffer := stream.buf
		stream.buf = nil
		messages := stream.http1.Push(buffer)
		stream.streamDropped += stream.http1.TakeInvalid()
		var events []httpStreamEvent
		for _, message := range messages {
			switch {
			case message.IsRequest:
				events = append(events, httpStreamEvent{
					Kind:     httpStreamEventRequest,
					Protocol: httpProtocolHTTP1,
					Method:   message.Method,
				})
			case message.StatusCode >= 500:
				events = append(events, httpStreamEvent{
					Kind:       httpStreamEventServerError,
					Protocol:   httpProtocolHTTP1,
					StatusCode: message.StatusCode,
				})
			}
		}
		return events
	case httpProtocolHTTP2:
		if stream.http2 == nil {
			stream.http2 = newHTTP2Stream()
		}
		buffer := stream.buf
		stream.buf = nil
		requests := stream.http2.Push(buffer, clientToServer)
		var events []httpStreamEvent
		for _, request := range requests {
			events = append(events, httpStreamEvent{
				Kind:     httpStreamEventRequest,
				Protocol: httpProtocolHTTP2,
				Method:   request.Method,
			})
		}
		return events
	case httpProtocolTLS, httpProtocolOpaque:
		stream.buf = nil
	}
	return nil
}

// ensureProtocol 根据流起始字节识别协议；识别不了时最多等待 16 字节后标记 opaque。
func (stream *httpStream) ensureProtocol() {
	if stream.protocol != "" || len(stream.buf) == 0 {
		return
	}
	buffer := stream.buf
	// TLS record: handshake(0x16) / application data(0x17) + 版本 0x03。
	if len(buffer) >= 2 && (buffer[0] == 0x16 || buffer[0] == 0x17) && buffer[1] == 0x03 {
		stream.protocol = httpProtocolTLS
		stream.buf = nil
		return
	}
	// HTTP/2 帧头：3 字节长度 + 1 字节类型 + 1 字节标志 + 4 字节 stream id。
	if len(buffer) >= 9 {
		length := int(buffer[0])<<16 | int(buffer[1])<<8 | int(buffer[2])
		frameType := buffer[3]
		streamID := binary.BigEndian.Uint32(buffer[5:9]) & 0x7fffffff
		if length <= httpMaxH2FrameLen && frameType <= 9 &&
			(streamID != 0 || frameType == 4 || frameType == 6 || frameType == 8) {
			stream.protocol = httpProtocolHTTP2
			return
		}
	}
	// HTTP/1 请求行（方法 + 空格）或响应状态行（HTTPS/1.x 前缀）。
	if index := bytes.IndexByte(buffer, ' '); index > 0 && index <= httpMaxMethodLen {
		if _, ok := normalizeHTTPMethod(string(buffer[:index])); ok {
			stream.protocol = httpProtocolHTTP1
			return
		}
	}
	if bytes.HasPrefix(buffer, []byte("HTTP/")) {
		stream.protocol = httpProtocolHTTP1
		return
	}
	if len(buffer) >= 16 {
		stream.protocol = httpProtocolOpaque
		stream.buf = nil
	}
}

// TakeDropped 取出并清空该方向的丢弃计数（缺口重置/解析失败）。
func (stream *httpStream) TakeDropped() int {
	value := stream.streamDropped
	stream.streamDropped = 0
	return value
}

// ===========================================================================
// 流引擎：4 元组 → 双向流 → HTTP 请求观测
// ===========================================================================

type httpEndpoint struct {
	Address string
	Port    int
}

type httpFlowID struct {
	A httpEndpoint
	B httpEndpoint
}

func (endpoint httpEndpoint) less(other httpEndpoint) bool {
	if endpoint.Address != other.Address {
		return endpoint.Address < other.Address
	}
	return endpoint.Port < other.Port
}

// httpRequestObservation 是解析出的一次请求（或 5xx 响应错误）观测。
type httpRequestObservation struct {
	ClientAddress string
	ClientPort    int
	ServerAddress string
	ServerPort    int
	Protocol      string
	Method        string
	IsError       bool
	At            time.Time
}

type httpFlow struct {
	a, b           httpEndpoint
	streams        [2]*httpStream // 0: a→b, 1: b→a
	initiator      int            // 0/1: 从 SYN 推断的 client 方向；-1 未知
	initiatorKnown bool
	lastSeen       time.Time
	lastRequest    *httpRequestObservation
}

// httpFlowEngine 汇聚报文到 4 元组双向流，并输出请求观测。
// 非并发安全：仅由观察器单 goroutine 调用。
type httpFlowEngine struct {
	flows        map[httpFlowID]*httpFlow
	observations []httpRequestObservation
	servicePorts map[int]bool
	maxFlows     int
	packets      int
	dropped      int
}

func newHTTPFlowEngine(maxFlows int) *httpFlowEngine {
	if maxFlows <= 0 {
		maxFlows = httpDefaultMaxFlows
	}
	return &httpFlowEngine{
		flows:        map[httpFlowID]*httpFlow{},
		servicePorts: map[int]bool{},
		maxFlows:     maxFlows,
	}
}

// SetServicePorts 设置“服务端端口”集合（本地监听端口 + gRPC 常见端口），
// 用于没抓到 SYN 的中途连接上推断 HTTP/2 客户端方向。
func (engine *httpFlowEngine) SetServicePorts(ports map[int]bool) {
	engine.servicePorts = ports
}

func (engine *httpFlowEngine) HandlePacket(packet httpTCPPacket, at time.Time) {
	engine.packets++
	src := httpEndpoint{Address: packet.SrcIP.String(), Port: packet.SrcPort}
	dst := httpEndpoint{Address: packet.DstIP.String(), Port: packet.DstPort}
	var id httpFlowID
	var direction int
	if src.less(dst) {
		id = httpFlowID{A: src, B: dst}
		direction = 0
	} else {
		id = httpFlowID{A: dst, B: src}
		direction = 1
	}
	flow := engine.flows[id]
	if flow == nil {
		flow = &httpFlow{a: id.A, b: id.B, initiator: -1}
		flow.streams[0] = newHTTPStream()
		flow.streams[1] = newHTTPStream()
		engine.flows[id] = flow
		engine.evictIfNeeded()
	}
	flow.lastSeen = at
	if packet.Flags&httpTCPFlagSYN != 0 && packet.Flags&httpTCPFlagACK == 0 {
		flow.initiator = direction
		flow.initiatorKnown = true
	}
	clientToServer := false
	if flow.initiatorKnown {
		clientToServer = direction == flow.initiator
	} else if engine.servicePorts[dst.Port] && !engine.servicePorts[src.Port] {
		clientToServer = true
	}
	stream := flow.streams[direction]
	events := stream.Push(packet, clientToServer)
	engine.dropped += stream.TakeDropped()
	for _, event := range events {
		switch event.Kind {
		case httpStreamEventRequest:
			observation := httpRequestObservation{
				ClientAddress: src.Address,
				ClientPort:    src.Port,
				ServerAddress: dst.Address,
				ServerPort:    dst.Port,
				Protocol:      event.Protocol,
				Method:        event.Method,
				At:            at,
			}
			flow.lastRequest = &observation
			engine.observations = append(engine.observations, observation)
		case httpStreamEventServerError:
			if flow.lastRequest == nil {
				continue
			}
			failed := *flow.lastRequest
			failed.IsError = true
			failed.At = at
			engine.observations = append(engine.observations, failed)
		}
	}
}

// Drain 取出并清空自上次调用以来的请求观测。
func (engine *httpFlowEngine) Drain() []httpRequestObservation {
	if len(engine.observations) == 0 {
		return nil
	}
	out := engine.observations
	engine.observations = nil
	return out
}

// TakeDropped 取出并清空丢弃计数（缺口重置、解析失败、流淘汰）。
func (engine *httpFlowEngine) TakeDropped() int {
	value := engine.dropped
	engine.dropped = 0
	return value
}

func (engine *httpFlowEngine) FlowCount() int {
	return len(engine.flows)
}

// Prune 清理空闲超时的流。
func (engine *httpFlowEngine) Prune(now time.Time) {
	for id, flow := range engine.flows {
		if now.Sub(flow.lastSeen) < httpFlowIdleTimeout {
			continue
		}
		for _, stream := range flow.streams {
			engine.dropped += stream.TakeDropped()
		}
		delete(engine.flows, id)
	}
}

func (engine *httpFlowEngine) evictIfNeeded() {
	if len(engine.flows) <= engine.maxFlows {
		return
	}
	var oldestID httpFlowID
	var oldest *httpFlow
	for id, flow := range engine.flows {
		if oldest == nil || flow.lastSeen.Before(oldest.lastSeen) {
			oldestID = id
			oldest = flow
		}
	}
	if oldest != nil {
		for _, stream := range oldest.streams {
			engine.dropped += stream.TakeDropped()
		}
		delete(engine.flows, oldestID)
		engine.dropped++
	}
}

// ===========================================================================
// 观测 → 上报边（方向/本地/对端/gRPC 识别）
// ===========================================================================

// mapHTTPObservation 把请求观测映射成上报边。isLocal 判断 IP 是否属于本机；
// listening 是本地监听端口集合；services 是端口→本机服务名；grpcPorts 是
// gRPC 常见端口集合。两端都在本机（内部流量）或无法判断本地端时返回 false。
func mapHTTPObservation(
	observation httpRequestObservation,
	isLocal func(string) bool,
	listening map[int]bool,
	services map[int]string,
	grpcPorts map[int]bool,
) (httpRequestEdge, bool) {
	if observation.ClientAddress == "" || observation.ServerAddress == "" {
		return httpRequestEdge{}, false
	}
	clientLocal := isLocal(observation.ClientAddress)
	serverLocal := isLocal(observation.ServerAddress)
	if clientLocal && serverLocal {
		return httpRequestEdge{}, false // 本机内部/loopback 流量不算东西向依赖
	}
	edge := httpRequestEdge{
		Protocol: observation.Protocol,
		Method:   observation.Method,
	}
	switch {
	case serverLocal:
		edge.Direction = connDirectionIn
		edge.LocalAddress = observation.ServerAddress
		edge.LocalPort = observation.ServerPort
		edge.PeerAddress = observation.ClientAddress
		edge.PeerPort = observation.ClientPort
		edge.Service = services[observation.ServerPort]
	case clientLocal:
		edge.Direction = connDirectionOut
		edge.LocalAddress = observation.ClientAddress
		edge.LocalPort = observation.ClientPort
		edge.PeerAddress = observation.ServerAddress
		edge.PeerPort = observation.ServerPort
	default:
		// 两端都不是本机 IP（容器/转发流量）：用本地监听表兜底判断。
		switch {
		case listening[observation.ServerPort]:
			edge.Direction = connDirectionIn
			edge.LocalAddress = observation.ServerAddress
			edge.LocalPort = observation.ServerPort
			edge.PeerAddress = observation.ClientAddress
			edge.PeerPort = observation.ClientPort
			edge.Service = services[observation.ServerPort]
		case listening[observation.ClientPort]:
			edge.Direction = connDirectionOut
			edge.LocalAddress = observation.ClientAddress
			edge.LocalPort = observation.ClientPort
			edge.PeerAddress = observation.ServerAddress
			edge.PeerPort = observation.ServerPort
		default:
			return httpRequestEdge{}, false
		}
	}
	if edge.Method == "" {
		edge.Method = "UNKNOWN"
	}
	if edge.Protocol == httpProtocolHTTP2 {
		targetPort := edge.PeerPort
		if edge.Direction == connDirectionIn {
			targetPort = edge.LocalPort
		}
		if grpcPorts[targetPort] || strings.Contains(strings.ToLower(edge.Service), "grpc") {
			edge.Protocol = httpProtocolGRPC
		}
	}
	if edge.Protocol == httpProtocolGRPC && edge.Method == "UNKNOWN" {
		edge.Method = "POST" // gRPC 恒为 POST
	}
	if observation.IsError {
		edge.Errors = 1
	} else {
		edge.Requests = 1
	}
	return edge, true
}

// ===========================================================================
// 窗口聚合与心跳缓存（与 connWindowReporter 同模式的失败保留重发）
// ===========================================================================

type httpRequestEdge struct {
	Direction    string `json:"direction"`
	Protocol     string `json:"protocol"`
	Method       string `json:"method"`
	LocalAddress string `json:"localAddress"`
	LocalPort    int    `json:"localPort"`
	PeerAddress  string `json:"peerAddress"`
	PeerPort     int    `json:"peerPort"`
	Service      string `json:"service,omitempty"`
	Requests     int    `json:"requests"`
	Errors       int    `json:"errors"`
	FirstSeen    string `json:"firstSeen,omitempty"`
	LastSeen     string `json:"lastSeen,omitempty"`
}

type httpRequestStats struct {
	Packets int `json:"packets"`
	Flows   int `json:"flows"`
	Dropped int `json:"dropped"`
}

type httpRequestWindow struct {
	Start    string            `json:"start"`
	End      string            `json:"end"`
	Source   string            `json:"source"`
	Requests []httpRequestEdge `json:"requests"`
	Stats    *httpRequestStats `json:"stats,omitempty"`
}

type httpRequestEdgeKey struct {
	Direction    string
	Protocol     string
	Method       string
	LocalAddress string
	LocalPort    int
	PeerAddress  string
	PeerPort     int
}

type httpEdgeAccum struct {
	edge      httpRequestEdge
	firstSeen time.Time
	lastSeen  time.Time
}

// httpWindowAggregator 把请求观测聚合为固定时间窗边表。
type httpWindowAggregator struct {
	window   time.Duration
	maxEdges int
	start    time.Time
	edges    map[httpRequestEdgeKey]*httpEdgeAccum
	packets  int
	dropped  int
}

func newHTTPWindowAggregator(window time.Duration, maxEdges int) *httpWindowAggregator {
	if window <= 0 {
		window = httpDefaultWindow
	}
	if maxEdges <= 0 {
		maxEdges = httpDefaultMaxEdges
	}
	return &httpWindowAggregator{
		window:   window,
		maxEdges: maxEdges,
		edges:    map[httpRequestEdgeKey]*httpEdgeAccum{},
	}
}

// Start 标记窗口起点（观察器启动时调用；未调用时首次 FlushIfDue 自动开始）。
func (aggregator *httpWindowAggregator) Start(now time.Time) {
	if aggregator.start.IsZero() {
		aggregator.start = now
	}
}

func (aggregator *httpWindowAggregator) CountPacket() {
	aggregator.packets++
}

func (aggregator *httpWindowAggregator) AddDropped(count int) {
	if count > 0 {
		aggregator.dropped += count
	}
}

func (aggregator *httpWindowAggregator) Add(edge httpRequestEdge, at time.Time) {
	key := httpRequestEdgeKey{
		Direction:    edge.Direction,
		Protocol:     edge.Protocol,
		Method:       edge.Method,
		LocalAddress: edge.LocalAddress,
		LocalPort:    edge.LocalPort,
		PeerAddress:  edge.PeerAddress,
		PeerPort:     edge.PeerPort,
	}
	accum := aggregator.edges[key]
	if accum == nil {
		base := edge
		base.Requests = 0
		base.Errors = 0
		base.FirstSeen = ""
		base.LastSeen = ""
		accum = &httpEdgeAccum{edge: base, firstSeen: at, lastSeen: at}
		aggregator.edges[key] = accum
	}
	accum.edge.Requests += edge.Requests
	accum.edge.Errors += edge.Errors
	accum.edge.Service = edge.Service
	if at.Before(accum.firstSeen) {
		accum.firstSeen = at
	}
	if at.After(accum.lastSeen) {
		accum.lastSeen = at
	}
}

// FlushIfDue 到期时返回一个窗口，否则 nil。flows 为窗口结束时的活跃流数量。
func (aggregator *httpWindowAggregator) FlushIfDue(now time.Time, flows int) *httpRequestWindow {
	if aggregator.start.IsZero() {
		aggregator.start = now
		return nil
	}
	if now.Sub(aggregator.start) < aggregator.window {
		return nil
	}
	end := aggregator.start.Add(aggregator.window)
	window := httpRequestWindow{
		Start:    aggregator.start.UTC().Format(time.RFC3339),
		End:      end.UTC().Format(time.RFC3339),
		Source:   httpSourceUserspace,
		Requests: make([]httpRequestEdge, 0, len(aggregator.edges)),
		Stats: &httpRequestStats{
			Packets: aggregator.packets,
			Flows:   flows,
			Dropped: aggregator.dropped,
		},
	}
	for _, accum := range aggregator.edges {
		edge := accum.edge
		edge.FirstSeen = accum.firstSeen.UTC().Format(time.RFC3339)
		edge.LastSeen = accum.lastSeen.UTC().Format(time.RFC3339)
		window.Requests = append(window.Requests, edge)
	}
	sortHTTPRequestEdges(window.Requests)
	if len(window.Requests) > aggregator.maxEdges {
		window.Stats.Dropped += len(window.Requests) - aggregator.maxEdges
		window.Requests = window.Requests[:aggregator.maxEdges]
	}
	if window.Requests == nil {
		window.Requests = make([]httpRequestEdge, 0)
	}

	aggregator.edges = map[httpRequestEdgeKey]*httpEdgeAccum{}
	aggregator.packets = 0
	aggregator.dropped = 0
	aggregator.start = end
	if now.Sub(aggregator.start) >= aggregator.window {
		aggregator.start = now
	}
	return &window
}

// sortHTTPRequestEdges 按 requests+errors 降序，便于窗口超限时保留最热的边。
func sortHTTPRequestEdges(edges []httpRequestEdge) {
	sort.SliceStable(edges, func(i, j int) bool {
		leftWeight := edges[i].Requests + edges[i].Errors
		rightWeight := edges[j].Requests + edges[j].Errors
		if leftWeight != rightWeight {
			return leftWeight > rightWeight
		}
		if edges[i].Requests != edges[j].Requests {
			return edges[i].Requests > edges[j].Requests
		}
		if edges[i].LastSeen != edges[j].LastSeen {
			return edges[i].LastSeen > edges[j].LastSeen
		}
		if edges[i].PeerAddress != edges[j].PeerAddress {
			return edges[i].PeerAddress < edges[j].PeerAddress
		}
		if edges[i].PeerPort != edges[j].PeerPort {
			return edges[i].PeerPort < edges[j].PeerPort
		}
		if edges[i].LocalPort != edges[j].LocalPort {
			return edges[i].LocalPort < edges[j].LocalPort
		}
		if edges[i].Direction != edges[j].Direction {
			return edges[i].Direction < edges[j].Direction
		}
		if edges[i].Protocol != edges[j].Protocol {
			return edges[i].Protocol < edges[j].Protocol
		}
		return edges[i].Method < edges[j].Method
	})
}

// httpWindowReporter 缓存待上报的 HTTP 请求窗口：心跳成功后确认清空，
// 失败保留重发（与 connWindowReporter 相同模式，最多 12 个窗口/120s）。
type httpWindowReporter struct {
	mu sync.Mutex

	windowSeconds int
	source        string
	pending       []httpRequestWindow
	lastWindowAt  time.Time
	lastEdgeCount int
	received      int
}

func newHTTPWindowReporter(window time.Duration) *httpWindowReporter {
	return &httpWindowReporter{
		windowSeconds: int(window / time.Second),
		source:        httpSourceUserspace,
	}
}

func (reporter *httpWindowReporter) push(window httpRequestWindow) {
	reporter.pushAt(window, time.Now())
}

func (reporter *httpWindowReporter) pushAt(window httpRequestWindow, now time.Time) {
	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	reporter.received++
	reporter.source = window.Source
	reporter.lastWindowAt = now
	reporter.lastEdgeCount = len(window.Requests)
	if len(window.Requests) == 0 {
		return
	}
	reporter.pending = append(reporter.pending, window)
	if len(reporter.pending) > httpReporterMaxWindows {
		reporter.pending = append([]httpRequestWindow(nil), reporter.pending[len(reporter.pending)-httpReporterMaxWindows:]...)
	}
	cutoff := now.Add(-connReporterMaxWindowAge)
	for len(reporter.pending) > 0 {
		end := parseConnWindowTime(reporter.pending[0].End, now)
		if !end.Before(cutoff) {
			break
		}
		reporter.pending = reporter.pending[1:]
	}
	if len(reporter.pending) == 0 {
		reporter.pending = nil
	}
}

func (reporter *httpWindowReporter) snapshot() []httpRequestWindow {
	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	if len(reporter.pending) == 0 {
		return nil
	}
	out := make([]httpRequestWindow, len(reporter.pending))
	copy(out, reporter.pending)
	return out
}

func (reporter *httpWindowReporter) ack(sent int) {
	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	if sent <= 0 || len(reporter.pending) == 0 {
		return
	}
	if sent >= len(reporter.pending) {
		reporter.pending = nil
		return
	}
	reporter.pending = append([]httpRequestWindow(nil), reporter.pending[sent:]...)
}

func (reporter *httpWindowReporter) metrics() map[string]any {
	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	result := map[string]any{
		"enabled":        true,
		"source":         reporter.source,
		"windowSeconds":  reporter.windowSeconds,
		"edgeCount":      reporter.lastEdgeCount,
		"pendingWindows": len(reporter.pending),
	}
	if !reporter.lastWindowAt.IsZero() {
		result["lastWindowAt"] = reporter.lastWindowAt.UTC().Format(time.RFC3339)
	}
	return result
}
