package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const agentVersion = "0.5.4"

type discoveryReport struct {
	System       map[string]any   `json:"system"`
	Applications []map[string]any `json:"applications"`
	Agent        map[string]any   `json:"agent"`
	Operations   map[string]any   `json:"operations,omitempty"`
	DiscoveredAt string           `json:"discoveredAt"`
}

func commandOutput(timeout time.Duration, name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func parseOSRelease() map[string]string {
	values := map[string]string{}
	file, err := os.Open("/etc/os-release")
	if err != nil {
		return values
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		values[key] = strings.Trim(strings.TrimSpace(value), `"`)
	}
	return values
}

func hostIPs() []string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var addresses []string
	for _, iface := range interfaces {
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ip, _, err := net.ParseCIDR(addr.String())
			if err != nil || ip.IsLoopback() {
				continue
			}
			addresses = append(addresses, ip.String())
		}
	}
	return addresses
}

func hostUptimeSeconds() int64 {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	parts := strings.Fields(string(data))
	if len(parts) == 0 {
		return 0
	}
	value, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return 0
	}
	return int64(value)
}

func listeningPorts() []int {
	output := commandOutput(2*time.Second, "ss", "-lntu")
	if output == "" {
		return nil
	}
	seen := map[int]bool{}
	ports := []int{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		address := fields[4]
		index := strings.LastIndex(address, ":")
		if index < 0 {
			continue
		}
		port, err := strconv.Atoi(address[index+1:])
		if err != nil || port <= 0 || seen[port] {
			continue
		}
		seen[port] = true
		ports = append(ports, port)
	}
	return ports
}

func systemdApplications() []map[string]any {
	output := commandOutput(3*time.Second, "systemctl", "list-units", "--type=service", "--state=running", "--no-pager", "--plain", "--no-legend")
	if output == "" {
		return nil
	}
	applications := []map[string]any{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || !strings.HasSuffix(fields[0], ".service") {
			continue
		}
		name := strings.TrimSuffix(fields[0], ".service")
		description := ""
		if len(fields) > 4 {
			description = strings.Join(fields[4:], " ")
		}
		applications = append(applications, map[string]any{
			"name":        name,
			"kind":        "systemd",
			"status":      "running",
			"description": description,
		})
		if len(applications) >= 30 {
			break
		}
	}
	return applications
}

func dockerApplications() []map[string]any {
	output := commandOutput(3*time.Second, "docker", "ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}")
	if output == "" {
		return nil
	}
	applications := []map[string]any{}
	for _, line := range strings.Split(output, "\n") {
		parts := strings.SplitN(line, "\t", 4)
		if len(parts) < 3 || strings.TrimSpace(parts[0]) == "" {
			continue
		}
		app := map[string]any{
			"name":   strings.TrimSpace(parts[0]),
			"kind":   "docker",
			"image":  strings.TrimSpace(parts[1]),
			"status": strings.TrimSpace(parts[2]),
			"deploy": "docker",
		}
		if len(parts) == 4 && strings.TrimSpace(parts[3]) != "" {
			app["ports"] = strings.TrimSpace(parts[3])
		}
		applications = append(applications, app)
		if len(applications) >= 30 {
			break
		}
	}
	return applications
}

func windowsApplications() []map[string]any {
	script := "Get-Service | Where-Object {$_.Status -eq 'Running'} | Select-Object -First 40 Name,DisplayName | ConvertTo-Json -Compress"
	output := commandOutput(5*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	if output == "" {
		return nil
	}
	var rows []struct {
		Name        string `json:"Name"`
		DisplayName string `json:"DisplayName"`
	}
	if err := json.Unmarshal([]byte(output), &rows); err != nil {
		var row struct {
			Name        string `json:"Name"`
			DisplayName string `json:"DisplayName"`
		}
		if json.Unmarshal([]byte(output), &row) != nil {
			return nil
		}
		rows = append(rows, row)
	}
	applications := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if row.Name == "" {
			continue
		}
		applications = append(applications, map[string]any{
			"name":        row.Name,
			"kind":        "windows-service",
			"status":      "running",
			"description": row.DisplayName,
			"deploy":      "service",
		})
	}
	return applications
}

func detectPackageManager() string {
	for _, candidate := range []string{"apk", "apt-get", "dnf", "yum", "zypper", "pacman"} {
		if _, err := exec.LookPath(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

func virtualization() string {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return "docker"
	}
	data, err := os.ReadFile("/proc/1/cgroup")
	if err == nil {
		content := string(data)
		for _, marker := range []string{"kubepods", "docker", "containerd", "lxc"} {
			if strings.Contains(content, marker) {
				return "container"
			}
		}
	}
	return ""
}

func collectDiscovery(started time.Time, metrics map[string]any) discoveryReport {
	osRelease := parseOSRelease()
	ips := hostIPs()
	kernel := ""
	if runtime.GOOS == "linux" {
		kernel = commandOutput(2*time.Second, "uname", "-r")
	}
	if runtime.GOOS == "windows" {
		kernel = commandOutput(3*time.Second, "cmd", "/c", "ver")
	}
	applications := systemdApplications()
	applications = append(applications, dockerApplications()...)
	if runtime.GOOS == "windows" {
		applications = append(applications, windowsApplications()...)
	}
	system := map[string]any{
		"hostname":       mustHostname(),
		"os":             runtime.GOOS,
		"arch":           runtime.GOARCH,
		"osName":         osRelease["NAME"],
		"osVersion":      osRelease["VERSION_ID"],
		"osPretty":       osRelease["PRETTY_NAME"],
		"kernel":         kernel,
		"virtualization": virtualization(),
		"cpuCores":       runtime.NumCPU(),
		"memoryTotalGB":  metrics["memTotalGB"],
		"diskTotalGB":    metrics["diskTotalGB"],
		"diskFreeGB":     metrics["diskFreeGB"],
		"uptimeSec":      hostUptimeSeconds(),
		"timezone":       time.Now().Location().String(),
		"packageManager": detectPackageManager(),
		"ip":             "",
		"ipAddresses":    ips,
		"listeningPorts": listeningPorts(),
	}
	if len(ips) > 0 {
		system["ip"] = ips[0]
	}
	if uptime := hostUptimeSeconds(); uptime > 0 {
		system["bootTime"] = time.Now().Add(-time.Duration(uptime) * time.Second).UTC().Format(time.RFC3339)
	}
	executable, _ := os.Executable()
	paths := resolveAgentPaths()
	agentInfo := map[string]any{
		"version":       agentVersion,
		"installPath":   executable,
		"homePath":      paths.Root,
		"binPath":       executable,
		"toolsPath":     paths.Tools,
		"serviceName":   env("OPSAGENT_AGENT_SERVICE", "opsagent-agent"),
		"serviceStatus": "running",
		"configPath":    paths.Config,
		"skillsPath":    paths.Skills,
		"statePath":     paths.State,
		"sessionsPath":  paths.Sessions,
		"workspacePath": paths.Workspace,
		"logPath":       filepath.Join(paths.Logs, "agent.log"),
		"snapshotPath":  paths.Snapshots,
		"controlURL":    env("OPSAGENT_CONTROL_URL", ""),
		"startedAt":     started.UTC().Format(time.RFC3339),
		"capabilities":  []string{"system.discover", "applications.discover", "metrics", "uptime", "load", "processes", "diagnostics", "controlled_exec", "self.patrol", "inspect", "skills", "memory", "script", "agent.instruction", "snapshot", "platform.model"},
		"skills":        skillsManifest(),
	}
	inventory := collectApplicationInventory()
	agentInfo["inventory"] = inventory
	return discoveryReport{
		System:       system,
		Applications: applications,
		Agent:        agentInfo,
		Operations: map[string]any{
			"services":  inventory["services"],
			"processes": inventory["processes"],
			"ports":     inventory["ports"],
			"opsTools":  collectOperationsTools()["tools"],
		},
		DiscoveredAt: time.Now().UTC().Format(time.RFC3339),
	}
}

func mustHostname() string {
	hostname, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return hostname
}

func discoveryJSON(started time.Time, metrics map[string]any) string {
	data, err := json.Marshal(collectDiscovery(started, metrics))
	if err != nil {
		return fmt.Sprintf(`{"error":%q}`, err.Error())
	}
	return string(data)
}
