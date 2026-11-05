package main

import (
	"fmt"
	"sort"
	"strconv"
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
	if strings.Contains(lower, "进程") || strings.Contains(lower, "process") {
		if summary := analyzeProcesses(evidence["processes"]); summary != "" {
			return summary
		}
	}
	if strings.Contains(lower, "内存") || strings.Contains(lower, "memory") {
		if summary := analyzeMemory(evidence["memory"]); summary != "" {
			return summary
		}
	}
	if strings.Contains(lower, "网络") || strings.Contains(lower, "ip") || strings.Contains(lower, "网卡") {
		interfaces := evidence["interfaces"]
		addresses := ipv4Addresses(interfaces)
		if len(addresses) > 0 {
			summary := fmt.Sprintf("主机 IPv4 地址：%s。", strings.Join(addresses, "、"))
			if route := defaultRoute(evidence["routes"]); route != "" {
				summary += " 默认路由：" + route + "。"
			}
			if dns := dnsServers(evidence["dns"]); len(dns) > 0 {
				summary += " DNS：" + strings.Join(dns, "、") + "。"
			}
			return summary
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

func analyzeProcesses(output string) string {
	type process struct {
		user string
		pid  string
		cpu  float64
		mem  float64
		cmd  string
	}
	processes := make([]process, 0)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 || strings.EqualFold(fields[0], "PID") || strings.EqualFold(fields[0], "USER") {
			continue
		}
		pidIndex, userIndex, cmdIndex := 0, 1, 3
		if len(fields) >= 11 {
			pidIndex, userIndex, cmdIndex = 1, 0, 10
		}
		cpu, _ := strconv.ParseFloat(fields[2], 64)
		mem, _ := strconv.ParseFloat(fields[3], 64)
		processes = append(processes, process{
			user: fields[userIndex], pid: fields[pidIndex], cpu: cpu, mem: mem,
			cmd: strings.Join(fields[cmdIndex:], " "),
		})
	}
	if len(processes) == 0 {
		return ""
	}
	sort.Slice(processes, func(i, j int) bool { return processes[i].mem > processes[j].mem })
	lines := []string{fmt.Sprintf("当前进程 %d 个，内存占用最高的进程：", len(processes))}
	for index, item := range processes {
		if index >= 5 {
			break
		}
		command := item.cmd
		if len(command) > 120 {
			command = command[:120]
		}
		lines = append(lines, fmt.Sprintf("- PID %s %s：内存 %.1f%%，CPU %.1f%%，%s", item.pid, item.user, item.mem, item.cpu, command))
	}
	return strings.Join(lines, "\n")
}

func analyzeMemory(output string) string {
	lines := nonEmptyLines(output)
	if len(lines) == 0 {
		return ""
	}
	for _, line := range lines {
		if strings.Contains(line, "Mem:") || strings.Contains(line, "MemTotal") {
			return "内存概况：" + line
		}
	}
	return "内存概况：" + strings.Join(lines[:minInt(len(lines), 3)], "；")
}

func analyzeLogs(evidence map[string]string) string {
	agentLog := strings.TrimSpace(evidence["agent-log"])
	combined := strings.TrimSpace(evidence["journal"] + "\n" + evidence["messages"] + "\n" + agentLog)
	label := "系统日志"
	if agentLog != "" {
		label = "OpsAgent 日志"
	}
	if combined == "" {
		return "没有读取到" + label + "内容。"
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
		return fmt.Sprintf("最近 %s 共 %d 行，未发现明显的 error/failed/panic/OOM/磁盘空间错误。", label, len(lines))
	}
	return fmt.Sprintf("最近 %s 共 %d 行，发现 %d 条需要关注的错误，摘录：\n- %s", label, len(lines), len(interesting), strings.Join(interesting, "\n- "))
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

func defaultRoute(routes string) string {
	for _, line := range strings.Split(routes, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "default ") {
			return line
		}
	}
	return ""
}

func dnsServers(config string) []string {
	result := make([]string, 0)
	for _, line := range strings.Split(config, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) >= 2 && fields[0] == "nameserver" {
			result = append(result, fields[1])
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
