package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// collectApplicationInventory discovers system services, application processes,
// their executable paths, configuration and log locations.
func collectApplicationInventory() map[string]any {
	services := []map[string]any{}
	units := commandOutput(4*time.Second, "systemctl", "list-units", "--type=service", "--state=running", "--no-pager", "--plain", "--no-legend")
	for _, line := range strings.Split(units, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || !strings.HasSuffix(fields[0], ".service") || len(services) >= 40 {
			continue
		}
		unit := fields[0]
		name := strings.TrimSuffix(unit, ".service")
		entry := map[string]any{"name": name, "unit": unit, "kind": "systemd", "status": "running"}
		show := commandOutput(2*time.Second, "systemctl", "show", unit,
			"-p", "FragmentPath", "-p", "ExecStart", "-p", "WorkingDirectory",
			"-p", "StandardOutput", "-p", "StandardError", "-p", "User", "-p", "Group")
		values := parseKeyValue(show)
		if value := values["FragmentPath"]; value != "" {
			entry["unitPath"] = value
			entry["configPaths"] = []string{value}
			entry["configDir"] = filepath.Dir(value)
		}
		if value := values["ExecStart"]; value != "" {
			entry["execStart"] = strings.TrimSpace(strings.SplitN(value, ";", 2)[0])
			if path := executableFromCommand(entry["execStart"].(string)); path != "" {
				entry["installPath"] = path
			}
		}
		if value := values["WorkingDirectory"]; value != "" {
			entry["workingDirectory"] = value
		}
		logPaths := make([]string, 0, 3)
		for _, key := range []string{"StandardOutput", "StandardError"} {
			value := values[key]
			if strings.HasPrefix(value, "append:") || strings.HasPrefix(value, "file:") {
				logPaths = append(logPaths, strings.TrimPrefix(strings.TrimPrefix(value, "append:"), "file:"))
			}
		}
		for _, candidate := range []string{
			filepath.Join("/var/log", name),
			filepath.Join("/var/log", name+".log"),
			filepath.Join("/var/log", name, name+".log"),
		} {
			if _, err := os.Stat(candidate); err == nil {
				logPaths = append(logPaths, candidate)
			}
		}
		if len(logPaths) > 0 {
			entry["logPaths"] = uniqueStrings(logPaths)
		}
		services = append(services, entry)
	}

	processes := []map[string]any{}
	ps := commandOutput(4*time.Second, "ps", "-eo", "pid=,ppid=,user=,comm=,args=")
	primaryFormat := strings.TrimSpace(ps) != ""
	if !primaryFormat {
		ps = commandOutput(4*time.Second, "ps", "aux")
	}
	for index, line := range strings.Split(ps, "\n") {
		if index == 0 || index > 120 {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		if strings.EqualFold(fields[0], "PID") || strings.EqualFold(fields[0], "USER") {
			continue
		}
		pid := ""
		ppid := ""
		user := ""
		comm := ""
		args := ""
		if primaryFormat {
			pid = fields[0]
			ppid = fields[1]
			user = fields[2]
			comm = fields[3]
			args = strings.Join(fields[4:], " ")
		} else {
			// BusyBox ps aux: PID USER TIME COMMAND
			pid = fields[0]
			user = fields[1]
			comm = fields[3]
			args = strings.Join(fields[3:], " ")
		}
		comm = filepath.Base(strings.TrimSpace(comm))
		if comm == "" || strings.HasPrefix(comm, "[") || strings.HasPrefix(args, "[") {
			continue
		}
		classification := "application"
		if isSystemProcess(pid, comm, args) {
			classification = "system"
		}
		entry := map[string]any{
			"pid": pid, "ppid": ppid, "user": user, "name": comm,
			"command": args, "classification": classification,
		}
		if exe, err := os.Readlink(filepath.Join("/proc", pid, "exe")); err == nil {
			entry["executable"] = exe
			entry["installPath"] = filepath.Dir(exe)
		}
		processes = append(processes, entry)
		if len(processes) >= 100 {
			break
		}
	}

	return map[string]any{
		"services":   services,
		"processes":  processes,
		"ports":      applicationPorts(),
		"systemd":    detectSystemd(),
		"containers": dockerApplications(),
		"counts": map[string]any{
			"services":  len(services),
			"processes": len(processes),
		},
	}
}

func applicationPorts() []map[string]any {
	output := commandOutput(3*time.Second, "ss", "-lntup")
	ports := []map[string]any{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || (fields[0] != "LISTEN" && !strings.HasPrefix(fields[0], "udp")) {
			continue
		}
		address := fields[4]
		process := ""
		if len(fields) >= 7 {
			process = strings.Join(fields[6:], " ")
		}
		ports = append(ports, map[string]any{"address": address, "process": process})
		if len(ports) >= 80 {
			break
		}
	}
	return ports
}

func parseKeyValue(output string) map[string]string {
	values := map[string]string{}
	for _, line := range strings.Split(output, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return values
}

func executableFromCommand(command string) string {
	fields := strings.Fields(strings.TrimPrefix(strings.TrimSpace(command), "-"))
	if len(fields) == 0 {
		return ""
	}
	path := fields[0]
	if strings.HasPrefix(path, "/") {
		return path
	}
	if resolved, err := exec.LookPath(path); err == nil {
		return resolved
	}
	return ""
}

func isSystemProcess(pid, name, args string) bool {
	if pid == "1" || pid == "2" {
		return true
	}
	lower := strings.ToLower(name + " " + args)
	for _, marker := range []string{"systemd", "kthreadd", "kworker", "sshd", "dbus-daemon", "chronyd", "rsyslogd", "crond", "udevd", "auditd", "polkitd"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return strings.HasPrefix(name, "[")
}

func detectSystemd() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	_, err := os.Stat("/run/systemd/system")
	return err == nil
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func collectOperationsTools() map[string]any {
	known := []string{
		"easyops", "zabbix_agentd", "zabbix-agent", "node_exporter", "telegraf",
		"filebeat", "metricbeat", "datadog-agent", "nagios", "nrpe", "falcon-agent",
		"salt-minion", "puppet", "chef-client", "ansible", "promtail", "vector",
		"fluent-bit", "td-agent", "filebeat", "opsagent-agent",
	}
	tools := make([]map[string]any, 0, len(known))
	unitFiles := commandOutput(3*time.Second, "systemctl", "list-unit-files", "--type=service", "--no-pager", "--plain", "--no-legend")
	for _, name := range known {
		path := findToolPath(name)
		serviceFound := strings.Contains(unitFiles, name)
		if path == "" && !serviceFound {
			continue
		}
		entry := map[string]any{"name": name, "installed": true}
		if path != "" {
			entry["path"] = path
		}
		if serviceFound {
			entry["service"] = name
		}
		if path != "" {
			if output := commandOutput(2*time.Second, path, "--version"); output != "" {
				entry["version"] = firstLine(output)
			}
		}
		tools = append(tools, entry)
	}
	return map[string]any{"tools": tools, "count": len(tools)}
}

func findToolPath(name string) string {
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	for _, root := range []string{"/opt", "/usr/local", "/usr/lib", "/var/lib"} {
		var found string
		_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err != nil || found != "" {
				return nil
			}
			if entry.IsDir() {
				if strings.Count(strings.TrimPrefix(path, root), string(os.PathSeparator)) >= 4 {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.Name() == name {
				found = path
			}
			return nil
		})
		if found != "" {
			return found
		}
	}
	return ""
}

func firstLine(value string) string {
	line := strings.TrimSpace(strings.SplitN(value, "\n", 2)[0])
	if len(line) > 200 {
		return line[:200]
	}
	return line
}

func collectPerformanceFindings(metrics map[string]any) map[string]any {
	findings := []map[string]any{}
	number := func(key string) float64 {
		switch value := metrics[key].(type) {
		case float64:
			return value
		case int:
			return float64(value)
		case int64:
			return float64(value)
		default:
			return 0
		}
	}
	if total := number("diskTotalGB"); total > 0 {
		free := number("diskFreeGB")
		pct := free / total * 100
		if pct < 15 {
			findings = append(findings, finding("critical", "磁盘可用空间不足", fmt.Sprintf("根分区可用 %.1f%%，低于 15%%。", pct), "检查大文件/日志并清理或扩容。"))
		}
	}
	if load := number("load1"); load > 0 && load > float64(runtime.NumCPU())*1.5 {
		findings = append(findings, finding("warning", "系统负载偏高", fmt.Sprintf("1 分钟负载 %.2f，CPU 核数 %d。", load, runtime.NumCPU()), "排查高 CPU 进程和 IO 等待。"))
	}
	if mem := number("memLoadPct"); mem > 85 {
		findings = append(findings, finding("warning", "内存使用率过高", fmt.Sprintf("内存使用率 %.1f%%。", mem), "检查内存占用进程和 swap 使用。"))
	}
	for _, key := range []string{"cpu", "memory", "io"} {
		pressure := commandOutput(2*time.Second, "cat", "/proc/pressure/"+key)
		if pressure != "" {
			findings = append(findings, map[string]any{"severity": "info", "title": "PSI " + key, "detail": firstLine(pressure)})
		}
	}
	return map[string]any{"findings": findings, "count": len(findings)}
}

func finding(severity, title, detail, action string) map[string]any {
	return map[string]any{"severity": severity, "title": title, "detail": detail, "action": action}
}

func collectTroubleshooting() map[string]any {
	evidence := map[string]any{}
	evidence["failedUnits"] = commandOutput(3*time.Second, "systemctl", "--failed", "--no-pager", "--plain", "--no-legend")
	evidence["dmesgErrors"] = firstLines(commandOutput(3*time.Second, "dmesg", "-T"), 80, "error", "fail", "oom", "panic", "warn")
	evidence["oom"] = commandOutput(3*time.Second, "journalctl", "-k", "-n", "40", "--no-pager")
	evidence["disk"] = commandOutput(3*time.Second, "df", "-hT")
	return evidence
}

func firstLines(value string, limit int, keywords ...string) string {
	result := make([]string, 0, limit)
	for _, line := range strings.Split(value, "\n") {
		lower := strings.ToLower(line)
		for _, keyword := range keywords {
			if strings.Contains(lower, keyword) {
				result = append(result, line)
				break
			}
		}
		if len(result) >= limit {
			break
		}
	}
	return strings.Join(result, "\n")
}

func collectSystemConfiguration() map[string]any {
	config := map[string]any{
		"hostname":     mustHostname(),
		"osRelease":    parseOSRelease(),
		"kernel":       commandOutput(2*time.Second, "uname", "-a"),
		"cpu":          commandOutput(2*time.Second, "lscpu"),
		"memory":       commandOutput(2*time.Second, "free", "-h"),
		"disk":         commandOutput(2*time.Second, "df", "-hT"),
		"mounts":       commandOutput(2*time.Second, "mount"),
		"network":      commandOutput(2*time.Second, "ip", "addr"),
		"routes":       commandOutput(2*time.Second, "ip", "route"),
		"dns":          commandOutput(2*time.Second, "cat", "/etc/resolv.conf"),
		"timezone":     time.Now().Format(time.RFC3339 + " MST"),
		"sysctlKernel": commandOutput(2*time.Second, "sysctl", "kernel.hostname", "kernel.pid_max", "kernel.shmall", "kernel.shmmax", "net.ipv4.ip_local_port_range"),
		"ulimits":      commandOutput(2*time.Second, "sh", "-c", "ulimit -a"),
		"selinux":      commandOutput(2*time.Second, "getenforce"),
		"firewall":     commandOutput(2*time.Second, "sh", "-c", "command -v firewall-cmd >/dev/null && firewall-cmd --state || true"),
	}
	return config
}

func operationalSkillResult(name string) map[string]any {
	var report map[string]any
	switch name {
	case "application.discovery":
		report = collectApplicationInventory()
	case "ops.tools":
		report = collectOperationsTools()
	case "performance.analysis":
		report = collectPerformanceFindings(hostMetrics())
	case "troubleshooting":
		report = collectTroubleshooting()
	case "system.configuration":
		report = collectSystemConfiguration()
	default:
		return nil
	}
	payload, _ := json.Marshal(report)
	analysis := fmt.Sprintf("技能 %s 已完成扫描，结果包含 %d 个顶层字段。", name, len(report))
	if findings, ok := report["findings"].([]map[string]any); ok {
		analysis = fmt.Sprintf("技能 %s 发现 %d 个问题。", name, len(findings))
	}
	switch name {
	case "application.discovery":
		services := len(report["services"].([]map[string]any))
		processes := len(report["processes"].([]map[string]any))
		analysis = fmt.Sprintf("发现 %d 个运行服务、%d 个进程，包含安装路径、配置文件和日志位置。", services, processes)
	case "ops.tools":
		count := len(report["tools"].([]map[string]any))
		analysis = fmt.Sprintf("发现 %d 个运维/监控客户端。", count)
	case "troubleshooting":
		analysis = "故障证据采集完成，包含失败服务、内核错误、OOM 和磁盘检查结果。"
	case "system.configuration":
		analysis = "系统配置采集完成，包含 OS、内核、CPU、内存、磁盘、网络、sysctl 和 ulimit。"
	}
	return map[string]any{
		"type": "skill", "ok": true, "skill": name, "analysis": analysis,
		"evidence": map[string]string{"report": string(payload)},
		"report":   report,
	}
}

func operationalIntent(question string) string {
	lower := strings.ToLower(question)
	contains := func(words ...string) bool {
		for _, word := range words {
			if strings.Contains(lower, word) {
				return true
			}
		}
		return false
	}
	switch {
	case contains("运维客户端", "运维工具", "监控客户端", "easyops", "zabbix", "node_exporter", "filebeat", "运维类") ||
		(contains("运维") && contains("客户端", "工具", "agent")):
		return "ops.tools"
	case contains("应用发现", "部署了哪些服务", "部署哪些服务", "应用进程", "安装路径", "配置在哪", "日志在哪", "服务部署") ||
		(contains("应用") && contains("发现", "部署")):
		return "application.discovery"
	case contains("性能瓶颈", "性能分析", "系统瓶颈", "瓶颈", "cpu 高", "内存高", "负载高", "io 高"):
		return "performance.analysis"
	case contains("排障", "故障诊断", "系统出了什么故障", "故障原因", "怎么解决"):
		return "troubleshooting"
	case contains("配置详情", "系统配置", "配置采集", "内核参数", "sysctl"):
		return "system.configuration"
	default:
		return ""
	}
}
