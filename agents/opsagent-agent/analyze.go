package main

import (
	"fmt"
	"strings"
)

// analyzeEvidence gives a deterministic, human-readable first pass for CLI and
// offline use. The platform model is still used for deeper root-cause analysis.
func analyzeEvidence(question string, evidence map[string]string) string {
	lower := strings.ToLower(question)
	if strings.Contains(lower, "日志") || strings.Contains(lower, "log") || strings.Contains(lower, "journal") {
		return analyzeLogs(evidence)
	}
	if strings.Contains(lower, "用户") || strings.Contains(lower, "在线") || strings.Contains(lower, "who") {
		users := strings.TrimSpace(evidence["users"])
		if users == "" {
			return "当前没有交互式登录用户。"
		}
		lines := nonEmptyLines(users)
		if len(lines) > 5 {
			lines = lines[:5]
		}
		return fmt.Sprintf("当前在线用户 %d 个：\n- %s", len(nonEmptyLines(users)), strings.Join(lines, "\n- "))
	}
	if strings.Contains(lower, "磁盘") || strings.Contains(lower, "disk") || strings.Contains(lower, "分区") {
		usage := strings.TrimSpace(evidence["disk-usage"])
		if usage != "" {
			lines := nonEmptyLines(usage)
			if len(lines) > 1 {
				return fmt.Sprintf("磁盘检查完成，共 %d 个挂载点。重点关注：\n%s", len(lines)-1, strings.Join(lines[:minInt(len(lines), 6)], "\n"))
			}
		}
	}
	if strings.Contains(lower, "网络") || strings.Contains(lower, "ip") || strings.Contains(lower, "网卡") {
		interfaces := evidence["interfaces"]
		addresses := ipv4Addresses(interfaces)
		if len(addresses) > 0 {
			return fmt.Sprintf("主机 IPv4 地址：%s。", strings.Join(addresses, "、"))
		}
	}
	if strings.Contains(lower, "容器") || strings.Contains(lower, "docker") {
		containers := nonEmptyLines(evidence["docker"])
		if len(containers) == 0 {
			return "当前没有运行中的容器。"
		}
		return fmt.Sprintf("当前运行 %d 个容器。", len(containers))
	}
	return ""
}

func analyzeLogs(evidence map[string]string) string {
	combined := strings.TrimSpace(evidence["journal"] + "\n" + evidence["messages"])
	if combined == "" {
		return "没有读取到系统日志内容。"
	}
	lines := nonEmptyLines(combined)
	interesting := make([]string, 0, 5)
	for _, line := range lines {
		lower := strings.ToLower(line)
		for _, keyword := range []string{"error", "failed", "failure", "critical", "panic", "oom", "out of memory", "no space", "denied", "fatal"} {
			if strings.Contains(lower, keyword) {
				interesting = append(interesting, line)
				break
			}
		}
		if len(interesting) >= 5 {
			break
		}
	}
	if len(interesting) == 0 {
		return fmt.Sprintf("最近系统日志共 %d 行，未发现明显的 error/failed/panic/OOM/磁盘空间错误。", len(lines))
	}
	return fmt.Sprintf("最近系统日志共 %d 行，发现 %d 条需要关注的错误，摘录：\n- %s", len(lines), len(interesting), strings.Join(interesting, "\n- "))
}

func nonEmptyLines(value string) []string {
	result := make([]string, 0)
	for _, line := range strings.Split(value, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			result = append(result, line)
		}
	}
	return result
}

func ipv4Addresses(interfaces string) []string {
	result := make([]string, 0)
	seen := map[string]bool{}
	for _, line := range strings.Split(interfaces, "\n") {
		fields := strings.Fields(line)
		for index, field := range fields {
			if field != "inet" || index+1 >= len(fields) {
				continue
			}
			address := strings.Split(fields[index+1], "/")[0]
			if address != "127.0.0.1" && !seen[address] {
				seen[address] = true
				result = append(result, address)
			}
		}
	}
	return result
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
