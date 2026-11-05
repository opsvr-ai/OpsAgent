package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

func trimEvidence(output string) string {
	return strings.TrimSpace(output)
}

func existsCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func packageManagerEvidence() string {
	switch {
	case existsCommand("apk"):
		return commandOutput(5*time.Second, "apk", "info")
	case existsCommand("dpkg-query"):
		return commandOutput(5*time.Second, "dpkg-query", "-l")
	case existsCommand("rpm"):
		return commandOutput(5*time.Second, "rpm", "-qa")
	case existsCommand("dnf"):
		return commandOutput(5*time.Second, "dnf", "list", "installed")
	case existsCommand("yum"):
		return commandOutput(5*time.Second, "yum", "list", "installed")
	}
	return ""
}

var evidenceLabels = map[string]string{
	"disk-usage":      "磁盘使用情况",
	"block-devices":   "块设备与文件系统",
	"mounts":          "挂载点",
	"memory":          "内存",
	"meminfo":         "内存详情",
	"cpu":             "CPU",
	"load":            "负载",
	"services":        "运行中的服务",
	"service-manager": "服务管理器状态",
	"ports":           "监听端口",
	"processes":       "进程",
	"packages":        "已安装软件包",
	"network":         "网络地址",
	"interfaces":      "网卡",
	"routes":          "路由",
	"dns":             "DNS 配置",
	"journal":         "系统日志",
	"messages":        "系统消息",
	"agent-log":       "OpsAgent 日志",
	"users":           "在线用户",
	"docker":          "容器",
	"agent":           "Agent 部署情况",
	"kernel":          "内核",
	"hostname":        "主机名",
	"time":            "时间",
	"timezone":        "时区",
	"uptime":          "系统运行时长",
}

func compactDf(output string) string {
	lines := strings.Split(output, "\n")
	kept := make([]string, 0, len(lines))
	for index, line := range lines {
		if index > 0 && (strings.Contains(line, " /proc/") || strings.Contains(line, " /sys/")) {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func formatUptime(seconds int64) string {
	if seconds <= 0 {
		return "未知"
	}
	days := seconds / 86400
	hours := (seconds % 86400) / 3600
	minutes := (seconds % 3600) / 60
	if days > 0 {
		return fmt.Sprintf("%d 天 %d 小时 %d 分钟", days, hours, minutes)
	}
	if hours > 0 {
		return fmt.Sprintf("%d 小时 %d 分钟", hours, minutes)
	}
	return fmt.Sprintf("%d 分钟", minutes)
}

func inspectHost(question string, metrics map[string]any) map[string]any {
	log.Printf("inspect start question=%q", question)
	lower := strings.ToLower(question)
	scope := strings.ReplaceAll(lower, strings.ToLower(mustHostname()), "")
	scope = strings.ReplaceAll(scope, "opsagent", "")
	evidence := map[string]string{}
	include := map[string]bool{}
	add := func(key string, args ...string) {
		if len(args) == 0 {
			return
		}
		output := commandOutput(5*time.Second, args[0], args[1:]...)
		log.Printf("inspect probe key=%s command=%s bytes=%d", key, strings.Join(args, " "), len(output))
		if output != "" {
			evidence[key] = trimEvidence(output)
		}
	}
	addFirst := func(key string, commands ...[]string) {
		for _, args := range commands {
			if len(args) == 0 {
				continue
			}
			output := commandOutput(5*time.Second, args[0], args[1:]...)
			log.Printf("inspect probe key=%s command=%s bytes=%d", key, strings.Join(args, " "), len(output))
			if output != "" {
				evidence[key] = trimEvidence(output)
				return
			}
		}
	}

	wants := func(words ...string) bool {
		for _, word := range words {
			if strings.Contains(scope, strings.ToLower(word)) {
				return true
			}
		}
		return false
	}

	if intent := operationalIntent(scope); intent != "" {
		result := operationalSkillResult(intent)
		if result != nil {
			result["question"] = question
			result["answer"] = result["analysis"]
			result["collectedAt"] = time.Now().UTC().Format(time.RFC3339)
			return result
		}
	}

	if wants("时间", "time", "时区", "timezone", "运行", "多久", "uptime", "启动", "开机", "boot") {
		include["time"] = true
		include["timezone"] = true
		add("time", "date", "-R")
		add("timezone", "cat", "/etc/timezone")
	}
	if wants("运行", "多久", "uptime", "启动", "开机", "boot") {
		include["uptime"] = true
	}
	if !wants("日志", "log", "journal", "error") && wants("配置", "系统", "概况", "overview", "资源", "状态") {
		include["memory"] = true
		include["disk-usage"] = true
		include["cpu"] = true
		add("memory", "free", "-h")
		add("disk-usage", "df", "-hT")
		addFirst("cpu", []string{"lscpu"}, []string{"cat", "/proc/cpuinfo"})
	}
	if wants("磁盘", "分区", "文件系统", "挂载", "disk", "partition", "mount", "filesystem") {
		include["disk-usage"] = true
		include["block-devices"] = true
		add("disk-usage", "df", "-hT")
		addFirst("block-devices", []string{"lsblk", "-f"})
	}
	if wants("cpu", "处理器", "核数", "负载", "load") {
		include["cpu"] = true
		include["load"] = true
		addFirst("cpu", []string{"lscpu"}, []string{"cat", "/proc/cpuinfo"})
		add("load", "cat", "/proc/loadavg")
	}
	if wants("内存", "memory", "swap") {
		include["memory"] = true
		include["meminfo"] = true
		add("memory", "free", "-h")
		add("meminfo", "cat", "/proc/meminfo")
	}
	if wants("服务", "service", "systemd", "unit") {
		include["services"] = true
		addFirst("services", []string{"systemctl", "list-units", "--type=service", "--state=running", "--no-pager", "--no-legend"}, []string{"rc-status"})
		if evidence["services"] == "" {
			include["service-manager"] = true
			evidence["service-manager"] = "未检测到 systemd/OpenRC 服务管理器（当前环境可能是容器）。以下进程列表可代表正在运行的服务/程序。"
			include["processes"] = true
			addFirst("processes", []string{"ps", "aux"}, []string{"ps", "-ef"})
		}
	}
	if wants("端口", "port", "监听", "listen", "socket") {
		include["ports"] = true
		addFirst("ports", []string{"ss", "-lntup"}, []string{"netstat", "-lntp"})
	}
	if wants("进程", "process", "pstree", "top") {
		include["processes"] = true
		addFirst("processes",
			[]string{"ps", "-eo", "pid,user,%cpu,%mem,comm,args", "--sort=-%mem"},
			[]string{"ps", "aux"},
			[]string{"ps", "-ef"},
		)
	}
	if wants("包", "package", "安装", "installed", "version", "版本") {
		include["packages"] = true
		evidence["packages"] = trimEvidence(packageManagerEvidence())
	}
	if wants("网络", "network", "ip", "ip地址", "路由", "route", "dns", "网卡") {
		include["network"] = true
		include["interfaces"] = true
		include["routes"] = true
		include["dns"] = true
		add("interfaces", "ip", "addr")
		add("routes", "ip", "route")
		add("dns", "cat", "/etc/resolv.conf")
	}
	agentLogIntent := strings.Contains(lower, "opsagent") && wants("日志", "log")
	if agentLogIntent {
		include["agent-log"] = true
		add("agent-log", "tail", "-n", "200", filepath.Join(resolveAgentPaths().Logs, "agent.log"))
	} else if wants("日志", "log", "journal", "error") {
		include["journal"] = true
		include["messages"] = true
		add("journal", "journalctl", "-n", "80", "--no-pager", "-p", "warning")
		add("messages", "tail", "-n", "80", "/var/log/messages")
	}
	if wants("用户", "user", "who", "登录") {
		include["users"] = true
		addFirst("users", []string{"who"}, []string{"w"})
	}
	if wants("容器", "docker", "container") {
		include["docker"] = true
		add("docker", "docker", "ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}")
	}
	if wants("部署", "路径", "安装", "配置文件", "agent状态", "agent版本", "智能体") {
		include["agent"] = true
		executable, _ := os.Executable()
		paths := resolveAgentPaths()
		evidence["agent"] = fmt.Sprintf("版本: %s\n根目录: %s\n安装路径: %s\n配置文件: %s\n工具目录: %s\n技能目录: %s\n状态目录: %s\n会话目录: %s\n工作区: %s\n日志目录: %s\n快照目录: %s\n服务名: %s\n服务状态: running",
			agentVersion, paths.Root, executable, paths.Config, paths.Tools, paths.Skills, paths.State,
			paths.Sessions, paths.Workspace, paths.Logs, paths.Snapshots,
			env("OPSAGENT_AGENT_SERVICE", "opsagent-agent"))
	}

	osRelease := parseOSRelease()
	systemName := osRelease["PRETTY_NAME"]
	if systemName == "" {
		systemName = fmt.Sprintf("%s %s", runtime.GOOS, runtime.GOARCH)
	}
	if value, ok := evidence["disk-usage"]; ok {
		evidence["disk-usage"] = compactDf(value)
	}
	keys := make([]string, 0, len(evidence))
	for key := range evidence {
		if include[key] {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	specific := wants("日志", "log", "journal", "error", "磁盘", "disk", "分区", "内存", "memory", "cpu", "处理器", "网络", "network", "ip", "路由", "dns", "网卡", "服务", "service", "端口", "port", "进程", "process", "容器", "docker", "用户", "user", "在线", "who", "时间", "time", "uptime", "agent", "智能体")
	overview := !specific && wants("配置", "系统", "概况", "overview", "资源", "状态")
	lines := []string{
		"## 主机检查结果",
		"",
		fmt.Sprintf("问题：**%s**", question),
		"",
		"已执行只读检查，未修改主机。",
	}
	if overview || (len(keys) == 0 && !specific) {
		lines = append(lines,
			"",
			"### 核心信息",
			fmt.Sprintf("- 主机名：**%s**", mustHostname()),
			fmt.Sprintf("- 操作系统：**%s**", systemName),
			fmt.Sprintf("- 内核：**%s**", strings.TrimSpace(commandOutput(3*time.Second, "uname", "-r"))),
			fmt.Sprintf("- CPU：**%d 核**", runtime.NumCPU()),
			fmt.Sprintf("- 内存总量 / 可用：**%.1f / %.1f GB**", numberValue(metrics["memTotalGB"]), numberValue(metrics["memAvailableGB"])),
			fmt.Sprintf("- 磁盘总量 / 可用：**%.1f / %.1f GB**", numberValue(metrics["diskTotalGB"]), numberValue(metrics["diskFreeGB"])),
		)
		if uptimeSeconds := int64(numberValue(metrics["hostUptimeSec"])); uptimeSeconds > 0 {
			bootAt := ""
			if value, ok := metrics["bootTime"].(string); ok {
				bootAt = fmt.Sprintf("（启动于 %s）", value)
			}
			lines = append(lines, fmt.Sprintf("- 系统运行时长：**%s**%s", formatUptime(uptimeSeconds), bootAt))
		}
		if processCount := int(numberValue(metrics["processCount"])); processCount > 0 {
			lines = append(lines, fmt.Sprintf("- 进程数：**%d**", processCount))
		}
		if load1, ok := metrics["load1"]; ok {
			lines = append(lines, fmt.Sprintf("- 1 分钟负载：**%.2f**", numberValue(load1)))
		}
	}
	for _, key := range keys {
		lines = append(lines, "", fmt.Sprintf("### %s", evidenceLabels[key]), "```text", evidence[key], "```")
	}
	if len(keys) == 0 {
		lines = append(lines, "", "该问题未匹配到特定检查项，已返回主机基础信息；可以继续问磁盘分区、服务、端口、进程、内存、日志或 Agent 部署路径。")
	}
	analysis := analyzeEvidence(question, evidence)
	if analysis != "" {
		lines = append(lines, "", "### 分析", analysis)
	}
	return map[string]any{
		"type":        "inspect",
		"ok":          true,
		"question":    question,
		"answer":      strings.Join(lines, "\n"),
		"analysis":    analysis,
		"evidence":    evidence,
		"memory":      memoryContext(10),
		"collectedAt": time.Now().UTC().Format(time.RFC3339),
	}
}

func numberValue(input any) float64 {
	switch value := input.(type) {
	case float64:
		return value
	case float32:
		return float64(value)
	case int:
		return float64(value)
	case int64:
		return float64(value)
	default:
		return 0
	}
}
