//go:build !linux

package main

// 非 Linux 平台没有 AF_PACKET 抓包能力，HTTP/gRPC 请求级计数为空实现：
// 不采集、心跳不带 httpRequestWindows，其余逻辑保持不变。
func startHTTPObserver() *httpWindowReporter {
	return nil
}
