package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

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
}

func listSkills() []skillDefinition {
	return skills
}

func findSkill(name string) (skillDefinition, bool) {
	normalized := strings.ToLower(strings.TrimSpace(name))
	for _, skill := range skills {
		if strings.ToLower(skill.Name) == normalized {
			return skill, true
		}
	}
	return skillDefinition{}, false
}

func runSkill(name string, metrics map[string]any) map[string]any {
	skill, ok := findSkill(name)
	if !ok {
		return map[string]any{"type": "skill", "ok": false, "error": "unknown_skill", "skills": skills}
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
	return filepath.Join(paths.Snapshots, "memory.json")
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
	if err := os.MkdirAll(paths.Snapshots, 0o750); err != nil {
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
