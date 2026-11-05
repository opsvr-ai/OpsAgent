package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

//go:embed builtin-skills
var builtinSkillFS embed.FS

func seedBuiltinSkills(paths agentPaths) {
	entries, err := fs.ReadDir(builtinSkillFS, "builtin-skills")
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		content, err := fs.ReadFile(builtinSkillFS, "builtin-skills/"+entry.Name()+"/SKILL.md")
		if err != nil {
			continue
		}
		directory := filepath.Join(paths.Skills, entry.Name())
		if err := os.MkdirAll(directory, 0o750); err != nil {
			continue
		}
		target := filepath.Join(directory, "SKILL.md")
		if _, err := os.Stat(target); os.IsNotExist(err) {
			_ = os.WriteFile(target, content, 0o640)
		}
	}
}

type skillDefinition struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Question    string `json:"question"`
}

var skills = []skillDefinition{
	{Name: "system.overview", Description: "主机基础信息、负载和运行时长", Question: "查看系统概况、CPU、内存、磁盘和负载"},
	{Name: "disk.usage", Description: "磁盘分区和可用空间", Question: "查看磁盘分区和可用空间"},
	{Name: "memory.usage", Description: "内存和 swap 使用情况", Question: "查看内存和 swap 使用情况"},
	{Name: "network.status", Description: "网卡、IP、路由和 DNS", Question: "查看网卡、IP、路由和 DNS"},
	{Name: "service.status", Description: "运行中的服务或进程", Question: "查看运行中的服务和进程"},
	{Name: "process.top", Description: "进程列表和资源占用", Question: "查看进程列表和资源占用"},
	{Name: "logs.recent", Description: "最近系统日志", Question: "查看最近系统日志"},
	{Name: "container.status", Description: "容器运行状态", Question: "查看容器运行状态"},
	{Name: "agent.health", Description: "Agent 安装、配置和日志路径", Question: "查看 Agent 部署路径和运行状态"},
	{Name: "application.discovery", Description: "发现系统服务、应用进程、安装路径、配置与日志位置", Question: "发现系统部署了哪些服务和应用进程"},
	{Name: "ops.tools", Description: "发现 easyops、zabbix、node_exporter 等运维客户端", Question: "发现系统安装了哪些运维客户端和监控工具"},
	{Name: "performance.analysis", Description: "分析 CPU、内存、磁盘、负载和 PSI 性能瓶颈", Question: "分析系统性能和瓶颈"},
	{Name: "troubleshooting", Description: "采集失败服务、内核错误、OOM 和磁盘异常并排障", Question: "诊断系统故障和排障"},
	{Name: "system.configuration", Description: "采集操作系统内核、CPU、内存、磁盘、网络、sysctl 等配置", Question: "采集操作系统配置详情"},
	{Name: "process.discovery", Description: "诊断 Java、Python、Node 等应用进程为什么未被发现", Question: "诊断进程发现结果"},
}

func syncSkillsCommand(input map[string]any) map[string]any {
	result := map[string]any{"type": "skill_sync", "ok": true, "synced": []string{}}
	raw, _ := input["skills"].([]any)
	paths := resolveAgentPaths()
	synced := []string{}
	for _, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := entry["name"].(string)
		content, _ := entry["content"].(string)
		name = strings.TrimSpace(name)
		if name == "" || content == "" || strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
			continue
		}
		directory := filepath.Join(paths.Skills, name)
		if err := os.MkdirAll(directory, 0o750); err != nil {
			continue
		}
		if err := os.WriteFile(filepath.Join(directory, "SKILL.md"), []byte(content), 0o640); err != nil {
			continue
		}
		synced = append(synced, name)
	}
	result["synced"] = synced
	return result
}

func skillsManifest() []map[string]any {
	paths := resolveAgentPaths()
	items := listSkills()
	result := make([]map[string]any, 0, len(items))
	for _, skill := range items {
		content := ""
		for _, directory := range []string{skill.Name, canonicalSkillName(skill.Name)} {
			if data, err := os.ReadFile(filepath.Join(paths.Skills, directory, "SKILL.md")); err == nil {
				content = string(data)
				break
			}
		}
		if content == "" {
			content = fmt.Sprintf("---\nname: %s\ndescription: %s\n---\n# %s\n", skill.Name, skill.Description, skill.Description)
		}
		sum := sha256.Sum256([]byte(content))
		result = append(result, map[string]any{
			"name":        skill.Name,
			"description": skill.Description,
			"content":     content,
			"checksum":    hex.EncodeToString(sum[:]),
			"source":      "builtin",
		})
	}
	return result
}

func listSkills() []skillDefinition {
	seen := map[string]bool{}
	result := make([]skillDefinition, 0, len(skills))
	for _, skill := range skills {
		seen[canonicalSkillName(skill.Name)] = true
		result = append(result, skill)
	}
	for _, skill := range filesystemSkills(resolveAgentPaths()) {
		key := canonicalSkillName(skill.Name)
		if seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, skill)
	}
	return result
}

func canonicalSkillName(name string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(name)), ".", "-")
}

func filesystemSkills(paths agentPaths) []skillDefinition {
	entries, err := os.ReadDir(paths.Skills)
	if err != nil {
		return nil
	}
	result := make([]skillDefinition, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(paths.Skills, entry.Name(), "SKILL.md"))
		if err != nil {
			continue
		}
		content := string(data)
		name := ""
		description := ""
		if strings.HasPrefix(strings.TrimSpace(content), "---") {
			parts := strings.SplitN(strings.TrimSpace(content), "---", 3)
			if len(parts) >= 3 {
				for _, line := range strings.Split(parts[1], "\n") {
					key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
					if !ok {
						continue
					}
					switch strings.TrimSpace(key) {
					case "name":
						name = strings.TrimSpace(value)
					case "description":
						description = strings.TrimSpace(value)
					}
				}
			}
		}
		if name == "" {
			name = entry.Name()
		}
		result = append(result, skillDefinition{
			Name:        name,
			Description: description,
			Question:    description,
		})
	}
	return result
}

func findSkill(name string) (skillDefinition, bool) {
	normalized := canonicalSkillName(name)
	for _, skill := range listSkills() {
		if canonicalSkillName(skill.Name) == normalized {
			return skill, true
		}
	}
	return skillDefinition{}, false
}

func runSkill(name string, metrics map[string]any) map[string]any {
	skill, ok := findSkill(name)
	if !ok {
		return map[string]any{"type": "skill", "ok": false, "error": "unknown_skill", "skills": listSkills()}
	}
	if result := operationalSkillResult(skill.Name); result != nil {
		rememberObservation("skill", skill.Name, map[string]any{"description": skill.Description})
		return result
	}
	result := inspectHost(skill.Question, metrics)
	result["type"] = "skill"
	result["skill"] = skill.Name
	rememberObservation("skill", skill.Name, map[string]any{"description": skill.Description})
	return result
}

type memoryObservation struct {
	At      string         `json:"at"`
	Kind    string         `json:"kind"`
	Summary string         `json:"summary"`
	Data    map[string]any `json:"data,omitempty"`
}

type agentMemory struct {
	Observations []memoryObservation `json:"observations"`
}

func memoryFile() string {
	paths := resolveAgentPaths()
	return filepath.Join(paths.State, "memory.json")
}

func loadMemory() agentMemory {
	data, err := os.ReadFile(memoryFile())
	if err != nil {
		return agentMemory{}
	}
	var memory agentMemory
	if err := json.Unmarshal(data, &memory); err != nil {
		return agentMemory{}
	}
	return memory
}

func rememberObservation(kind, summary string, data map[string]any) {
	memory := loadMemory()
	memory.Observations = append(memory.Observations, memoryObservation{
		At:      time.Now().UTC().Format(time.RFC3339),
		Kind:    kind,
		Summary: summary,
		Data:    data,
	})
	if len(memory.Observations) > 50 {
		memory.Observations = memory.Observations[len(memory.Observations)-50:]
	}
	paths := resolveAgentPaths()
	if err := os.MkdirAll(paths.State, 0o750); err != nil {
		return
	}
	payload, err := json.MarshalIndent(memory, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(memoryFile(), payload, 0o640)
}

func memorySummary(limit int) map[string]any {
	memory := loadMemory()
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	observations := memory.Observations
	if len(observations) > limit {
		observations = observations[len(observations)-limit:]
	}
	reversed := make([]memoryObservation, 0, len(observations))
	for index := len(observations) - 1; index >= 0; index -= 1 {
		reversed = append(reversed, observations[index])
	}
	return map[string]any{
		"type":         "memory",
		"ok":           true,
		"count":        len(memory.Observations),
		"observations": reversed,
		"updatedAt":    time.Now().UTC().Format(time.RFC3339),
	}
}

// memoryContext returns a compact, deterministic view for model prompts.
func memoryContext(limit int) string {
	memory := loadMemory()
	if limit <= 0 || limit > 20 {
		limit = 10
	}
	start := len(memory.Observations) - limit
	if start < 0 {
		start = 0
	}
	lines := make([]string, 0, len(memory.Observations)-start)
	for _, observation := range memory.Observations[start:] {
		lines = append(lines, fmt.Sprintf("- %s %s: %s", observation.At, observation.Kind, observation.Summary))
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i] > lines[j] })
	return strings.Join(lines, "\n")
}
