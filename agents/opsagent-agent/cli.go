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
	AgentID           string       `json:"agentId"`
	AgentKey          string       `json:"agentKey"`
	Hostname          string       `json:"hostname"`
	ControlURL        string       `json:"controlUrl"`
	TenantID          string       `json:"tenantId"`
	CommandPublicKey  string       `json:"commandPublicKey,omitempty"`
	CommandKeyID      string       `json:"commandKeyId,omitempty"`
	CommandPublicKeys []commandKey `json:"commandPublicKeys,omitempty"`
	ResultPrivateKey  string       `json:"resultPrivateKey,omitempty"`
	ResultPublicKey   string       `json:"resultPublicKey,omitempty"`
	UpdatedAt         string       `json:"updatedAt"`
}

func statePath(paths agentPaths) string {
	return filepath.Join(filepath.Dir(paths.Config), "agent-state.json")
}

func saveAgentState(paths agentPaths, state agentState) error {
	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if state.ResultPrivateKey != "" {
		encrypted, err := encryptStateSecret(state.ResultPrivateKey, os.Getenv("OPSAGENT_STATE_SECRET"))
		if err != nil {
			return err
		}
		state.ResultPrivateKey = encrypted
	}
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
	if state.ResultPrivateKey != "" {
		decrypted, err := decryptStateSecret(state.ResultPrivateKey, os.Getenv("OPSAGENT_STATE_SECRET"))
		if err != nil {
			return state, err
		}
		state.ResultPrivateKey = decrypted
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
	client := newHTTPClient(120 * time.Second)
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
	client := newHTTPClient(120 * time.Second)
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

func isSkillsQuestion(question string) bool {
	normalized := strings.ToLower(question)
	for _, word := range []string{"技能", "skill"} {
		if strings.Contains(normalized, word) {
			return true
		}
	}
	return false
}

func isCapabilityQuestion(question string) bool {
	normalized := strings.ToLower(question)
	for _, word := range []string{"能力", "能做什么", "会什么", "能帮我做什么", "使用帮助", "help", "哪些功能", "那些功能"} {
		if strings.Contains(normalized, word) {
			return true
		}
	}
	return false
}

// skillRequest matches only an explicit "use skill X" request, not "list skills".
// This is what makes CLI requests actually execute a skill instead of printing
// the skill catalog.
func skillRequest(question string) (skillDefinition, bool) {
	normalized := strings.ToLower(question)
	action := false
	for _, word := range []string{"使用技能", "调用技能", "执行技能", "用技能", "use skill", "run skill", "应用技能"} {
		if strings.Contains(normalized, word) {
			action = true
			break
		}
	}
	if !action {
		return skillDefinition{}, false
	}
	for _, skill := range listSkills() {
		name := strings.ToLower(skill.Name)
		canonical := canonicalSkillName(skill.Name)
		if strings.Contains(normalized, name) || strings.Contains(normalized, canonical) {
			return skill, true
		}
	}
	return skillDefinition{}, false
}

func executeSkillForCLI(skill skillDefinition, question string, state agentState, stateErr error) string {
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	metrics := hostMetrics()
	metrics["cpuCores"] = runtime.NumCPU()
	metrics["heapMB"] = float64(memory.HeapAlloc) / 1024 / 1024
	result := runSkill(skill.Name, metrics)
	if evidence, ok := result["evidence"].(map[string]string); ok && stateErr == nil && len(evidence) > 0 {
		if analysis, err := askPlatformExplain(state, question, evidence); err == nil && strings.TrimSpace(analysis) != "" {
			return analysis
		}
	}
	if analysis, ok := result["analysis"].(string); ok && strings.TrimSpace(analysis) != "" {
		return analysis
	}
	return fmt.Sprintf("技能 %s 已执行完成，但没有取得可分析的证据。", skill.Name)
}

func capabilitiesAnswer() string {
	return strings.Join([]string{
		fmt.Sprintf("我是 **%s** 上的 OpsAgent，具备以下运维能力：", mustHostname()),
		"",
		"- **主机巡检**：CPU、内存、磁盘、负载、进程、端口、服务、网络、日志、容器",
		"- **运维技能**：调用 `/opt/opsagent/skills` 下的技能执行只读检查",
		"- **记忆**：保留最近 50 条检查和技能观察",
		"- **平台数据**：纳管主机、应用系统、告警和健康检查",
		"- **故障分析**：跨节点异常关联、根因定位和处置建议",
		"- **自主巡航**：30 秒级指标巡检，超阈值自动触发平台模型分析",
		"",
		"直接输入运维问题即可，例如「查看磁盘分区」「看看最近的系统日志」「当前有哪些告警」。",
	}, "\n")
}

func skillsAnswer() string {
	paths := resolveAgentPaths()
	items := listSkills()
	lines := []string{
		fmt.Sprintf("我是 **%s** 上的 OpsAgent，当前已加载 %d 个技能：", mustHostname(), len(items)),
		"",
	}
	for _, skill := range items {
		lines = append(lines, fmt.Sprintf("- `%s`：%s", skill.Name, skill.Description))
	}
	lines = append(lines,
		"",
		fmt.Sprintf("技能目录：`%s`", paths.Skills),
		fmt.Sprintf("记忆目录：`%s`", paths.State),
		fmt.Sprintf("工作区：`%s`", paths.Workspace),
		"",
		"直接输入问题即可调用对应技能，例如「查看磁盘分区」「查看网络配置」「最近有什么日志错误」。",
	)
	return strings.Join(lines, "\n")
}

func askPlatformExplain(state agentState, question string, evidence map[string]string) (string, error) {
	if state.AgentID == "" || state.AgentKey == "" {
		return "", fmt.Errorf("agent state is missing")
	}
	controlURL := state.ControlURL
	if controlURL == "" {
		controlURL = env("OPSAGENT_CONTROL_URL", "http://127.0.0.1:8080")
	}
	var reply struct {
		Analysis string `json:"analysis"`
		Error    string `json:"error"`
	}
	if err := cliPost(
		strings.TrimRight(controlURL, "/")+"/api/agents/"+state.AgentID+"/explain",
		map[string]any{"agentKey": state.AgentKey, "question": question, "evidence": evidence},
		&reply,
	); err != nil {
		return "", err
	}
	if reply.Analysis == "" {
		return "", fmt.Errorf("empty platform analysis")
	}
	return reply.Analysis, nil
}

func isFollowUpQuestion(question string) bool {
	normalized := strings.ToLower(question)
	for _, word := range []string{"这个日志", "这段日志", "这些日志", "上一条", "上面的日志", "刚才的日志", "报错什么意思", "什么意思", "什么原因", "怎么解决", "如何处理"} {
		if strings.Contains(normalized, word) {
			return true
		}
	}
	return false
}

func explainPreviousAnswer(question, previous string) string {
	if strings.TrimSpace(previous) == "" {
		return "没有可分析的上一轮结果。"
	}
	lower := strings.ToLower(previous)
	type finding struct {
		keyword string
		meaning string
		action  string
	}
	findings := []finding{
		{
			keyword: "connection refused",
			meaning: "Agent 无法连接控制面：目标端口没有服务监听，或控制面容器/进程未启动，也可能是网络或端口配置错误。",
			action:  "在 Agent 主机执行 `curl -v http://<控制面地址>:8080/health`，并检查 control 容器、防火墙和 OPSAGENT_CONTROL_URL。",
		},
		{
			keyword: "maximum number of sessions",
			meaning: "PAM/systemd 会话数达到上限，新的登录或 crond 会话无法创建。常见于会话未释放、连接数过多或 systemd-logind 限制过低。",
			action:  "检查 `loginctl list-sessions` 和 `systemctl status systemd-logind`，清理僵尸会话并评估会话/进程上限。",
		},
		{
			keyword: "no such file or directory",
			meaning: "进程启动命令或脚本路径不存在，supervisord 无法执行配置里的可执行文件。",
			action:  "核对 supervisor 配置中的 command 路径和解释器路径，确认文件存在且可执行。",
		},
		{
			keyword: "out of memory",
			meaning: "系统内存不足，内核 OOM 可能已经杀掉了进程。",
			action:  "检查 `free -h`、`dmesg -T | grep -i oom`，定位异常进程并评估内存上限。",
		},
		{
			keyword: "no space left",
			meaning: "磁盘空间不足，写入日志、临时文件或数据库都会失败。",
			action:  "检查 `df -h` 和占用最大的目录，清理日志或扩容。",
		},
	}
	matched := make([]finding, 0, 2)
	for _, item := range findings {
		if strings.Contains(lower, item.keyword) {
			matched = append(matched, item)
		}
	}
	if len(matched) == 0 {
		if strings.Contains(previous, "未发现明显") || strings.Contains(previous, "没有识别到") {
			return "上一轮日志没有发现明确错误，暂时无法判断具体报错含义。可以给出错误行或时间范围，我再按关键字定位。"
		}
		return "上一轮内容里没有识别到明确错误类型。可以贴出报错行，或指定日志文件和时间范围，我再分析。"
	}
	lines := []string{"上一条日志的主要报错含义："}
	for _, item := range matched {
		lines = append(lines, "- "+item.meaning, "  建议："+item.action)
	}
	return strings.Join(lines, "\n")
}

func localAnswer(question string, state agentState, stateErr error) string {
	if isCapabilityQuestion(question) {
		return capabilitiesAnswer()
	}
	if isSkillsQuestion(question) {
		return skillsAnswer()
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	metrics := hostMetrics()
	metrics["cpuCores"] = runtime.NumCPU()
	metrics["heapMB"] = float64(memory.HeapAlloc) / 1024 / 1024
	result := inspectHost(question, metrics)
	if evidence, ok := result["evidence"].(map[string]string); ok && stateErr == nil && len(evidence) > 0 {
		if analysis, err := askPlatformExplain(state, question, evidence); err == nil && strings.TrimSpace(analysis) != "" {
			return analysis
		}
	}
	if analysis, ok := result["analysis"].(string); ok && strings.TrimSpace(analysis) != "" {
		return analysis
	}
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
	lastQuestion := ""
	lastAnswer := ""
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
				fmt.Printf("Agent ID: %s\n主机: %s\n控制面: %s\n配置文件: %s\n日志: %s\n快照: %s\n技能: %s\n状态: %s\n工作区: %s\n",
					state.AgentID, state.Hostname, state.ControlURL, paths.Config, paths.Logs, paths.Snapshots, paths.Skills, paths.State, paths.Workspace)
			}
			continue
		}
		if isFollowUpQuestion(question) && lastAnswer != "" {
			fmt.Println()
			analysis := ""
			if stateErr == nil {
				if result, err := askPlatformExplain(state, question, map[string]string{
					"previous_question": lastQuestion,
					"previous_answer":   lastAnswer,
				}); err == nil {
					analysis = result
				}
			}
			if analysis == "" {
				analysis = explainPreviousAnswer(question, lastAnswer)
			}
			fmt.Println(analysis)
			fmt.Println()
			lastQuestion = question
			lastAnswer = analysis
			continue
		}
		if skill, ok := skillRequest(question); ok {
			fmt.Println()
			fmt.Printf("正在执行技能 `%s`…\n\n", skill.Name)
			answer := executeSkillForCLI(skill, question, state, stateErr)
			fmt.Println(answer)
			fmt.Println()
			lastQuestion = question
			lastAnswer = answer
			continue
		}
		if isCapabilityQuestion(question) {
			fmt.Println()
			fmt.Println(capabilitiesAnswer())
			fmt.Println()
			continue
		}
		if isSkillsQuestion(question) {
			fmt.Println()
			fmt.Println(skillsAnswer())
			fmt.Println()
			continue
		}
		if stateErr == nil {
			printed := false
			var streamed strings.Builder
			onDelta := func(text string) {
				if !printed {
					fmt.Println()
					printed = true
				}
				streamed.WriteString(text)
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
				lastQuestion = question
				lastAnswer = streamed.String()
				continue
			}
			if err == nil {
				answer, supported, fallbackErr := askPlatform(state, question)
				if fallbackErr == nil && supported && answer != "" {
					fmt.Println()
					fmt.Println(strings.TrimSpace(answer))
					fmt.Println()
					lastQuestion = question
					lastAnswer = answer
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
		answer := strings.TrimSpace(localAnswer(question, state, stateErr))
		fmt.Println(answer)
		fmt.Println()
		lastQuestion = question
		lastAnswer = answer
	}
}
