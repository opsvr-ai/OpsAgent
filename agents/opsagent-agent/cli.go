package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type agentState struct {
	AgentID    string `json:"agentId"`
	AgentKey   string `json:"agentKey"`
	Hostname   string `json:"hostname"`
	ControlURL string `json:"controlUrl"`
	TenantID   string `json:"tenantId"`
	UpdatedAt  string `json:"updatedAt"`
}

func statePath(paths agentPaths) string {
	return filepath.Join(filepath.Dir(paths.Config), "agent-state.json")
}

func saveAgentState(paths agentPaths, state agentState) error {
	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	target := statePath(paths)
	temp := target + ".tmp"
	if err := os.WriteFile(temp, body, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, target)
}

func loadAgentState(paths agentPaths) (agentState, error) {
	var state agentState
	body, err := os.ReadFile(statePath(paths))
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(body, &state); err != nil {
		return state, err
	}
	return state, nil
}

func loadAgentConfig(path string) {
	body, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key != "" && os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
}

type cliReply struct {
	Answer    string `json:"answer"`
	Supported bool   `json:"supported"`
	Hostname  string `json:"hostname"`
}

func cliPost(url string, payload any, target any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 120 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return fmt.Errorf("%s returned %d", url, response.StatusCode)
	}
	return json.NewDecoder(response.Body).Decode(target)
}

func askPlatformStream(state agentState, question string, onDelta func(string), onStatus func(string)) (bool, error) {
	if state.AgentID == "" || state.AgentKey == "" {
		return false, fmt.Errorf("agent state is missing; start opsagent-agent --service first")
	}
	controlURL := state.ControlURL
	if controlURL == "" {
		controlURL = env("OPSAGENT_CONTROL_URL", "http://127.0.0.1:8080")
	}
	body, err := json.Marshal(map[string]any{"agentKey": state.AgentKey, "question": question})
	if err != nil {
		return false, err
	}
	request, err := http.NewRequest(http.MethodPost, strings.TrimRight(controlURL, "/")+"/api/agents/"+state.AgentID+"/chat/stream", bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", "text/event-stream")
	client := &http.Client{Timeout: 120 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false, fmt.Errorf("stream returned %d", response.StatusCode)
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	var eventType string
	var data string
	got := false
	streamError := ""
	dispatch := func() {
		if eventType == "" || data == "" {
			eventType, data = "", ""
			return
		}
		var payload struct {
			Text    string `json:"text"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal([]byte(data), &payload); err != nil {
			eventType, data = "", ""
			return
		}
		switch eventType {
		case "delta":
			if payload.Text != "" {
				onDelta(payload.Text)
				got = true
			}
		case "status":
			if onStatus != nil && payload.Text != "" {
				onStatus(payload.Text)
			}
		case "error":
			streamError = payload.Message
		}
		eventType, data = "", ""
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			dispatch()
			continue
		}
		if strings.HasPrefix(line, "event: ") {
			eventType = strings.TrimSpace(strings.TrimPrefix(line, "event: "))
			continue
		}
		if strings.HasPrefix(line, "data: ") {
			data = strings.TrimPrefix(line, "data: ")
		}
	}
	dispatch()
	if err := scanner.Err(); err != nil && !got {
		return got, err
	}
	if streamError != "" {
		fmt.Println()
		fmt.Println(streamError)
		return true, nil
	}
	return got, nil
}

func askPlatform(state agentState, question string) (string, bool, error) {
	if state.AgentID == "" || state.AgentKey == "" {
		return "", false, fmt.Errorf("agent state is missing; start opsagent-agent --service first")
	}
	controlURL := state.ControlURL
	if controlURL == "" {
		controlURL = env("OPSAGENT_CONTROL_URL", "http://127.0.0.1:8080")
	}
	var reply cliReply
	err := cliPost(
		strings.TrimRight(controlURL, "/")+"/api/agents/"+state.AgentID+"/chat",
		map[string]any{"agentKey": state.AgentKey, "question": question},
		&reply,
	)
	if err != nil {
		return "", false, err
	}
	return reply.Answer, reply.Supported, nil
}

func localAnswer(question string) string {
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	metrics := hostMetrics()
	metrics["cpuCores"] = runtime.NumCPU()
	metrics["heapMB"] = float64(memory.HeapAlloc) / 1024 / 1024
	result := inspectHost(question, metrics)
	if answer, ok := result["answer"].(string); ok && answer != "" {
		return answer
	}
	return "本机检查已完成，但没有生成可读结果。"
}

func printCliBanner(paths agentPaths, state agentState, stateErr error) {
	fmt.Println("OpsAgent 操作系统智能体")
	fmt.Println("  根目录:", paths.Root)
	fmt.Println("  配置文件:", paths.Config)
	fmt.Println("  快照目录:", paths.Snapshots)
	if stateErr != nil {
		fmt.Println("  状态: 未找到本地 Agent 注册状态，仅支持本机检查")
		fmt.Println("  提示: 先启动服务 opsagent-agent --service")
	} else {
		fmt.Println("  主机:", state.Hostname)
		fmt.Println("  Agent ID:", state.AgentID)
		fmt.Println("  控制面:", state.ControlURL)
	}
	fmt.Println("输入问题开始对话；/help 查看命令，exit 退出。")
}

func runCLI(paths agentPaths) {
	log.SetOutput(io.Discard)
	loadAgentConfig(paths.Config)
	state, stateErr := loadAgentState(paths)
	printCliBanner(paths, state, stateErr)
	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("opsagent> ")
		if !scanner.Scan() {
			fmt.Println()
			return
		}
		question := strings.TrimSpace(scanner.Text())
		if question == "" {
			continue
		}
		switch strings.ToLower(question) {
		case "exit", "quit", "/exit", "/quit":
			return
		case "/help", "help":
			fmt.Println("直接输入运维问题，例如：")
			fmt.Println("  磁盘分区什么样")
			fmt.Println("  当前纳管了多少操作系统智能体")
			fmt.Println("  订单中心健康情况和故障根因")
			fmt.Println("  /status 查看 Agent 状态，exit 退出")
			continue
		case "/status", "status":
			if stateErr != nil {
				fmt.Println("未找到 Agent 注册状态")
			} else {
				fmt.Printf("Agent ID: %s\n主机: %s\n控制面: %s\n配置文件: %s\n日志: %s\n快照: %s\n",
					state.AgentID, state.Hostname, state.ControlURL, paths.Config, paths.Logs, paths.Snapshots)
			}
			continue
		}
		if stateErr == nil {
			printed := false
			onDelta := func(text string) {
				if !printed {
					fmt.Println()
					printed = true
				}
				fmt.Print(text)
			}
			onStatus := func(text string) {
				if !printed {
					fmt.Printf("\n[OpsAgent] %s\n", text)
				}
			}
			_, err := askPlatformStream(state, question, onDelta, onStatus)
			if printed {
				fmt.Println()
				fmt.Println()
				continue
			}
			if err == nil {
				answer, supported, fallbackErr := askPlatform(state, question)
				if fallbackErr == nil && supported && answer != "" {
					fmt.Println()
					fmt.Println(strings.TrimSpace(answer))
					fmt.Println()
					continue
				}
				if fallbackErr != nil {
					err = fallbackErr
				}
			}
			if err != nil {
				fmt.Printf("平台对话不可用（%v），切换为本机只读检查。\n", err)
			}
		}
		fmt.Println()
		fmt.Println(strings.TrimSpace(localAnswer(question)))
		fmt.Println()
	}
}
