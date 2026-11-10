//go:build !linux

package main

// 非 Linux 平台没有 /proc/net/tcp 与 /proc/<pid>/fd，连接窗口采样器为空实现，
// 心跳不携带 connectionWindows（omitempty），其余采集/发现逻辑保持不变。
func startConnEdgeSampler() *connWindowReporter {
	return nil
}
