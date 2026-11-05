package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	defaultLinuxRoot   = "/opt/opsagent"
	defaultWindowsRoot = "OpsAgent"
)

type agentPaths struct {
	Root        string
	Bin         string
	Config      string
	Tools       string
	Logs        string
	Snapshots   string
	Run         string
	Skills      string
	State       string
	Sessions    string
	Checkpoints string
	Workspace   string
	Audit       string
}

func resolveAgentPaths() agentPaths {
	root := os.Getenv("OPSAGENT_HOME")
	if root == "" {
		if runtime.GOOS == "windows" {
			base := os.Getenv("ProgramData")
			if base == "" {
				base = `C:\ProgramData`
			}
			root = filepath.Join(base, defaultWindowsRoot)
		} else {
			root = defaultLinuxRoot
		}
	}
	config := os.Getenv("OPSAGENT_AGENT_CONFIG")
	if config == "" {
		config = filepath.Join(root, "config", "agent.env")
	}
	logs := os.Getenv("OPSAGENT_LOG_DIR")
	if logs == "" {
		logs = filepath.Join(root, "logs")
	}
	snapshots := os.Getenv("OPSAGENT_SNAPSHOT_DIR")
	if snapshots == "" {
		snapshots = filepath.Join(root, "snapshots")
	}
	tools := os.Getenv("OPSAGENT_TOOLS_DIR")
	if tools == "" {
		tools = filepath.Join(root, "tools")
	}
	skills := os.Getenv("OPSAGENT_SKILLS_DIR")
	if skills == "" {
		skills = filepath.Join(root, "skills")
	}
	state := os.Getenv("OPSAGENT_STATE_DIR")
	if state == "" {
		state = filepath.Join(root, "state")
	}
	workspace := os.Getenv("OPSAGENT_WORKSPACE_DIR")
	if workspace == "" {
		workspace = filepath.Join(root, "workspace")
	}
	return agentPaths{
		Root:        root,
		Bin:         filepath.Join(root, "bin"),
		Config:      config,
		Tools:       tools,
		Logs:        logs,
		Snapshots:   snapshots,
		Run:         filepath.Join(root, "run"),
		Skills:      skills,
		State:       state,
		Sessions:    filepath.Join(state, "sessions"),
		Checkpoints: filepath.Join(state, "checkpoints"),
		Workspace:   workspace,
		Audit:       filepath.Join(root, "audit"),
	}
}

func (p agentPaths) ensure() error {
	directories := []string{
		p.Root, p.Bin, filepath.Dir(p.Config), p.Tools, p.Logs, p.Snapshots, p.Run,
		p.Skills, p.State, p.Sessions, p.Checkpoints, p.Workspace, p.Audit,
	}
	for _, directory := range directories {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			return fmt.Errorf("create %s: %w", directory, err)
		}
		if err := os.Chmod(directory, 0o750); err != nil {
			return fmt.Errorf("chmod %s: %w", directory, err)
		}
	}
	readmes := map[string]string{
		filepath.Join(p.Tools, "README.txt"):       "OpsAgent 工具目录：放置主机诊断辅助脚本/工具，默认只读检查。\n",
		filepath.Join(p.Snapshots, "README.txt"):   "OpsAgent 快照目录：保存最近一次配置发现、性能指标、自巡航和命令结果快照。\n",
		filepath.Join(p.Skills, "README.txt"):      "OpsAgent 技能目录：每个技能一个子目录，包含 SKILL.md（Eino skill.LocalBackend 格式）。\n",
		filepath.Join(p.Workspace, "README.txt"):   "Agent 工作区：脚本、临时产物和模型生成文件；执行后按保留策略清理。\n",
		filepath.Join(p.Sessions, "README.txt"):    "Eino 会话目录：按 sessionId 保存对话历史和运行状态。\n",
		filepath.Join(p.Checkpoints, "README.txt"): "Eino checkpoint 目录：Runner 中断恢复使用，key 经过安全编码。\n",
	}
	for path, content := range readmes {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			_ = os.WriteFile(path, []byte(content), 0o640)
		}
	}
	migrateLegacyMemory(p)
	seedBuiltinSkills(p)
	if _, err := os.Stat(p.Config); os.IsNotExist(err) {
		content := fmt.Sprintf("OPSAGENT_HOME=%s\nOPSAGENT_CONTROL_URL=%s\nOPSAGENT_TENANT_ID=%s\nOPSAGENT_AGENT_CONFIG=%s\nOPSAGENT_LOG_DIR=%s\nOPSAGENT_SNAPSHOT_DIR=%s\nOPSAGENT_TOOLS_DIR=%s\nOPSAGENT_SKILLS_DIR=%s\nOPSAGENT_STATE_DIR=%s\nOPSAGENT_WORKSPACE_DIR=%s\n",
			p.Root,
			os.Getenv("OPSAGENT_CONTROL_URL"),
			os.Getenv("OPSAGENT_TENANT_ID"),
			p.Config,
			p.Logs,
			p.Snapshots,
			p.Tools,
			p.Skills,
			p.State,
			p.Workspace,
		)
		_ = os.WriteFile(p.Config, []byte(content), 0o600)
	} else {
		appendMissingConfig(p)
	}
	return nil
}

func appendMissingConfig(p agentPaths) {
	data, err := os.ReadFile(p.Config)
	if err != nil {
		return
	}
	content := string(data)
	additions := []struct {
		key   string
		value string
	}{
		{"OPSAGENT_SKILLS_DIR", p.Skills},
		{"OPSAGENT_STATE_DIR", p.State},
		{"OPSAGENT_WORKSPACE_DIR", p.Workspace},
	}
	changed := false
	for _, addition := range additions {
		if strings.Contains(content, addition.key+"=") {
			continue
		}
		if !strings.HasSuffix(content, "\n") {
			content += "\n"
		}
		content += addition.key + "=" + addition.value + "\n"
		changed = true
	}
	if changed {
		_ = os.WriteFile(p.Config, []byte(content), 0o600)
	}
}

func migrateLegacyMemory(p agentPaths) {
	legacy := filepath.Join(p.Snapshots, "memory.json")
	current := filepath.Join(p.State, "memory.json")
	if _, err := os.Stat(current); err == nil {
		return
	}
	data, err := os.ReadFile(legacy)
	if err != nil {
		return
	}
	if err := os.WriteFile(current, data, 0o640); err == nil {
		_ = os.Rename(legacy, legacy+".migrated")
	}
}

func (p agentPaths) writeSnapshot(name string, payload any) error {
	body, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	target := filepath.Join(p.Snapshots, strings.TrimSpace(name))
	temp := target + ".tmp"
	if err := os.WriteFile(temp, body, 0o640); err != nil {
		return err
	}
	return os.Rename(temp, target)
}

func setupLogging(paths agentPaths) (*os.File, error) {
	logFile := filepath.Join(paths.Logs, "agent.log")
	if info, err := os.Stat(logFile); err == nil && info.Size() > 10*1024*1024 {
		for index := 4; index >= 1; index-- {
			previous := fmt.Sprintf("%s.%d", logFile, index)
			next := fmt.Sprintf("%s.%d", logFile, index+1)
			_ = os.Rename(previous, next)
		}
		_ = os.Rename(logFile, logFile+".1")
	}
	file, err := os.OpenFile(logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o640)
	if err != nil {
		return nil, err
	}
	log.SetOutput(io.MultiWriter(os.Stderr, file))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds | log.Lshortfile)
	log.Printf("log initialized file=%s", logFile)
	return file, nil
}

func commandSnapshotName(commandID string) string {
	clean := strings.Map(func(char rune) rune {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' {
			return char
		}
		return '-'
	}, commandID)
	if clean == "" {
		clean = time.Now().UTC().Format("20060102T150405")
	}
	return "command-" + clean + ".json"
}

func pruneCommandSnapshots(paths agentPaths, keep int) {
	entries, err := os.ReadDir(paths.Snapshots)
	if err != nil {
		return
	}
	type item struct {
		name string
		mod  time.Time
	}
	files := make([]item, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "command-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, item{name: entry.Name(), mod: info.ModTime()})
	}
	if len(files) <= keep {
		return
	}
	for index := 0; index < len(files)-keep; index++ {
		for inner := index + 1; inner < len(files); inner++ {
			if files[inner].mod.Before(files[index].mod) {
				files[index], files[inner] = files[inner], files[index]
			}
		}
		_ = os.Remove(filepath.Join(paths.Snapshots, files[index].name))
	}
}

func mask(value string) string {
	if value == "" {
		return ""
	}
	if len(value) <= 8 {
		return "***"
	}
	return value[:4] + "..." + value[len(value)-4:]
}

func compactJSON(value any) string {
	body, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	text := string(body)
	return text
}

func fingerprints(events []patrolEvent) []string {
	result := make([]string, 0, len(events))
	for _, event := range events {
		if event.Fingerprint != "" {
			result = append(result, event.Fingerprint)
		}
	}
	return result
}
