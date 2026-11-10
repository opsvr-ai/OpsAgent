package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

type registerRequest struct {
	TenantID        string           `json:"tenantId"`
	Name            string           `json:"name"`
	Hostname        string           `json:"hostname"`
	OS              string           `json:"os"`
	Arch            string           `json:"arch"`
	Version         string           `json:"version"`
	Capabilities    []string         `json:"capabilities"`
	ResultPublicKey string           `json:"resultPublicKey,omitempty"`
	Discovery       *discoveryReport `json:"discovery,omitempty"`
}

type registerResponse struct {
	Agent struct {
		ID string `json:"id"`
	} `json:"agent"`
	AgentKey          string       `json:"agentKey"`
	CommandPublicKey  string       `json:"commandPublicKey"`
	CommandKeyID      string       `json:"commandKeyId"`
	CommandPublicKeys []commandKey `json:"commandPublicKeys"`
}

type heartbeatRequest struct {
	AgentKey          string           `json:"agentKey"`
	Metrics           map[string]any   `json:"metrics"`
	Discovery         *discoveryReport `json:"discovery,omitempty"`
	ConnectionWindows []connEdgeWindow `json:"connectionWindows,omitempty"`
	CommandKeyID      string           `json:"commandKeyId,omitempty"`
	TLSCertExpiresAt  string           `json:"tlsCertExpiresAt,omitempty"`
	TLSCertSerial     string           `json:"tlsCertSerial,omitempty"`
}

type heartbeatResponse struct {
	CommandKeyID      string       `json:"commandKeyId"`
	CommandPublicKeys []commandKey `json:"commandPublicKeys"`
}

var agentStarted = time.Now()

type agentCommand struct {
	ID            string         `json:"id"`
	Type          string         `json:"type"`
	Input         map[string]any `json:"input"`
	SignedPayload string         `json:"signedPayload"`
	Signature     string         `json:"signature"`
}

func runCommand(commandType string, metrics map[string]any) map[string]any {
	return runCommandWithInput(commandType, metrics, nil)
}

func runCommandWithInput(commandType string, metrics map[string]any, input map[string]any) map[string]any {
	result := map[string]any{"type": commandType, "ok": true}
	switch commandType {
	case "agent_instruction":
		return runAgentInstruction(input)
	case "diagnostics":
		result["metrics"] = metrics
	case "deployment_execute":
		return runDeploymentCommand(input)
	case "disk_check":
		result["diskTotalGB"] = metrics["diskTotalGB"]
		result["diskFreeGB"] = metrics["diskFreeGB"]
	case "memory_check":
		result["memTotalGB"] = metrics["memTotalGB"]
		result["memAvailableGB"] = metrics["memAvailableGB"]
		result["memLoadPct"] = metrics["memLoadPct"]
	case "ai_diagnose":
		analysis, err := aiDiagnose(metrics)
		if err != nil {
			result["ok"] = false
			result["error"] = err.Error()
		} else {
			result["analysis"] = analysis
		}
	case "discovery":
		result["discovery"] = collectDiscovery(agentStarted, metrics)
	case "inspect":
		question := ""
		if input != nil {
			if value, ok := input["question"].(string); ok {
				question = value
			}
		}
		result = inspectHost(question, metrics)
		rememberObservation("inspect", question, map[string]any{"type": "inspect"})
	case "skills":
		result["skills"] = listSkills()
	case "skill":
		name := ""
		if input != nil {
			if value, ok := input["name"].(string); ok {
				name = value
			}
		}
		result = runSkill(name, metrics)
	case "memory":
		limit := 20
		if input != nil {
			if value, ok := input["limit"].(float64); ok {
				limit = int(value)
			}
		}
		result = memorySummary(limit)
	case "script":
		result = runScriptCommand(input)
	case "skill_sync":
		result = syncSkillsCommand(input)
	case "exec":
		result = execHost(input)
	default:
		result["ok"] = false
		result["error"] = "unsupported_command"
	}
	return result
}

func redactURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	query := parsed.Query()
	for _, key := range []string{"agentKey", "token"} {
		if query.Has(key) {
			query.Set(key, "***")
		}
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func getJSON(url string, target any) (int, error) {
	started := time.Now()
	client := newHTTPClient(15 * time.Second)
	response, err := client.Get(url)
	if err != nil {
		log.Printf("http GET %s failed duration=%s error=%v", redactURL(url), time.Since(started), err)
		return 0, err
	}
	defer response.Body.Close()
	log.Printf("http GET %s status=%d duration=%s", redactURL(url), response.StatusCode, time.Since(started))
	if response.StatusCode == http.StatusNoContent {
		return response.StatusCode, nil
	}
	if response.StatusCode >= 300 {
		return response.StatusCode, fmt.Errorf("GET %s returned %d", url, response.StatusCode)
	}
	return response.StatusCode, json.NewDecoder(response.Body).Decode(target)
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func post(url string, headers map[string]string, payload any, target any) error {
	started := time.Now()
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	client := newHTTPClient(15 * time.Second)
	response, err := client.Do(request)
	if err != nil {
		log.Printf("http POST %s failed duration=%s error=%v", redactURL(url), time.Since(started), err)
		return err
	}
	defer response.Body.Close()
	log.Printf("http POST %s status=%d duration=%s bytes=%d", redactURL(url), response.StatusCode, time.Since(started), len(body))
	if response.StatusCode >= 300 {
		return fmt.Errorf("%s returned %d", url, response.StatusCode)
	}
	if target == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(target)
}

func main() {
	paths := resolveAgentPaths()
	loadAgentConfig(paths.Config)
	service := os.Getenv("OPSAGENT_SERVICE_MODE") == "1"
	for _, arg := range os.Args[1:] {
		switch arg {
		case "--service", "daemon":
			service = true
		case "--version", "-v":
			fmt.Printf("opsagent-agent %s (%s/%s)\n", agentVersion, runtime.GOOS, runtime.GOARCH)
			return
		case "--help", "-h":
			fmt.Println("OpsAgent 操作系统智能体")
			fmt.Println("  opsagent-agent            进入交互式对话")
			fmt.Println("  opsagent-agent --service  以后台服务模式运行")
			fmt.Println("  opsagent-agent --version  显示版本")
			return
		}
	}
	if !service {
		runCLI(paths)
		return
	}
	applyResourceLimits()
	runDaemon(paths)
}

func runDaemon(paths agentPaths) {
	if err := paths.ensure(); err != nil {
		log.Fatalf("prepare agent directories: %v", err)
	}
	logFile, logErr := setupLogging(paths)
	if logErr != nil {
		log.Printf("file logging disabled: %v", logErr)
	} else {
		defer logFile.Close()
	}
	log.Printf("agent starting version=%s home=%s config=%s logs=%s snapshots=%s", agentVersion, paths.Root, paths.Config, paths.Logs, paths.Snapshots)

	controlURL := env("OPSAGENT_CONTROL_URL", "http://127.0.0.1:8080")
	tenantID := os.Getenv("OPSAGENT_TENANT_ID")
	if tenantID == "" {
		log.Fatal("OPSAGENT_TENANT_ID is required")
	}
	hostname, err := os.Hostname()
	if err != nil {
		log.Fatal(err)
	}
	name := env("OPSAGENT_AGENT_NAME", hostname)
	token := os.Getenv("OPSAGENT_AGENT_ENROLLMENT_TOKEN")
	log.Printf("agent identity tenant=%s hostname=%s name=%s control=%s", tenantID, hostname, name, controlURL)

	headers := map[string]string{}
	if token != "" {
		headers["x-opsagent-enrollment-token"] = token
	}
	registered := registerResponse{}
	agentStarted = time.Now()
	started := agentStarted
	// 建连边表窗口采集：Linux 上启动采样，其它平台为空实现（nil）。
	// 窗口缓存由 connWindowReporter 托管，心跳成功后确认清空，失败保留重发。
	connReporter := startConnEdgeSampler()
	if connReporter != nil {
		log.Printf("connection window reporter enabled")
	}
	var resultPrivateKey ed25519.PrivateKey
	resultPrivateSeedBase64 := ""
	resultPublicKeyBase64 := ""
	if existing, err := loadAgentState(paths); err == nil && existing.ResultPrivateKey != "" {
		if seed, decodeErr := base64.StdEncoding.DecodeString(existing.ResultPrivateKey); decodeErr == nil && len(seed) == ed25519.SeedSize {
			resultPrivateKey = ed25519.NewKeyFromSeed(seed)
			resultPrivateSeedBase64 = existing.ResultPrivateKey
			resultPublicKeyBase64 = base64.StdEncoding.EncodeToString(resultPrivateKey.Public().(ed25519.PublicKey))
			log.Printf("result signing key loaded keyId=%s", commandKeyID(resultPrivateKey.Public().(ed25519.PublicKey)))
		}
	}
	if resultPrivateKey == nil {
		resultPublicKey, generatedPrivateKey, generateErr := ed25519.GenerateKey(rand.Reader)
		if generateErr != nil {
			log.Fatalf("generate result key: %v", generateErr)
		}
		resultPrivateKey = generatedPrivateKey
		resultPrivateSeedBase64 = base64.StdEncoding.EncodeToString(generatedPrivateKey.Seed())
		resultPublicKeyBase64 = base64.StdEncoding.EncodeToString(resultPublicKey)
	}
	initialMetrics := hostMetrics()
	initialDiscovery := collectDiscovery(started, initialMetrics)
	if err := paths.writeSnapshot("discovery.json", initialDiscovery); err != nil {
		log.Printf("initial discovery snapshot: %v", err)
	}
	if err := post(controlURL+"/api/agents/register", headers, registerRequest{
		TenantID:        tenantID,
		Name:            name,
		Hostname:        hostname,
		OS:              runtime.GOOS,
		Arch:            runtime.GOARCH,
		Version:         agentVersion,
		Capabilities:    []string{"cpu", "memory", "disk", "network", "uptime", "load", "processes", "system.discover", "applications.discover", "self.patrol", "inspect", "skills", "memory", "script", "agent.instruction", "snapshot", "deployment.execute", "platform.model"},
		ResultPublicKey: resultPublicKeyBase64,
		Discovery:       &initialDiscovery,
	}, &registered); err != nil {
		log.Fatalf("register: %v", err)
	}
	log.Printf("registered agent id=%s key=%s", registered.Agent.ID, mask(registered.AgentKey))
	if err := saveAgentState(paths, agentState{
		AgentID:           registered.Agent.ID,
		AgentKey:          registered.AgentKey,
		Hostname:          hostname,
		ControlURL:        controlURL,
		TenantID:          tenantID,
		CommandPublicKey:  registered.CommandPublicKey,
		CommandKeyID:      registered.CommandKeyID,
		CommandPublicKeys: registered.CommandPublicKeys,
		ResultPrivateKey:  resultPrivateSeedBase64,
		ResultPublicKey:   resultPublicKeyBase64,
	}); err != nil {
		log.Printf("save agent state: %v", err)
	} else {
		log.Printf("agent state saved path=%s", statePath(paths))
	}
	if err := enrollAgentCertificate(controlURL, registered.Agent.ID, registered.AgentKey, hostname, paths); err != nil {
		log.Printf("certificate enrollment: %v", err)
	} else if os.Getenv("OPSAGENT_AUTO_CSR") == "true" {
		log.Printf("certificate enrollment complete control=%s", controlURL)
	}
	lastDiscovery := time.Now()
	lastPatrol := time.Time{}
	lastMetricsSnapshot := time.Time{}
	lastCertificateCheck := time.Time{}
	lastPolicyRefresh := time.Time{}
	currentPatrolPolicy := defaultPatrolPolicy()
	activePatrol := map[string]bool{}
	var diagnosticsCache map[string]any
	var diagnosticsAt time.Time
	var lastPatrolAnalysisAt time.Time
	var lastPatrolAnalysis string

	reportPatrol := func(metrics map[string]any) {
		if time.Since(lastPolicyRefresh) > 15*time.Second {
			if loaded, err := loadPatrolPolicy(controlURL, registered.Agent.ID, registered.AgentKey); err != nil {
				log.Printf("patrol policy refresh: %v", err)
			} else {
				currentPatrolPolicy = loaded
				lastPolicyRefresh = time.Now()
				log.Printf("patrol policy loaded enabled=%v interval=%ds diskFreePct=%.1f memLoadPct=%.1f load1=%.2f",
					loaded.Enabled, loaded.IntervalSeconds, loaded.DiskFreePct, loaded.MemLoadPct, loaded.Load1)
			}
		}
		current := patrolEventsWithThresholds(metrics, currentPatrolPolicy.DiskFreePct, currentPatrolPolicy.MemLoadPct, currentPatrolPolicy.Load1, currentPatrolPolicy.Watch)
		if !currentPatrolPolicy.Enabled {
			current = nil
		}
		currentSet := map[string]bool{}
		if len(current) > 0 && (lastPatrolAnalysisAt.IsZero() || time.Since(lastPatrolAnalysisAt) > 5*time.Minute) {
			analysis, err := platformAnalyze(
				controlURL,
				registered.Agent.ID,
				registered.AgentKey,
				os.Getenv("OPSAGENT_AGENT_ENROLLMENT_TOKEN"),
				metrics,
				current,
				"自主巡航发现指标异常，请分析原因并给出处置建议",
			)
			if err != nil {
				log.Printf("patrol platform analysis: %v", err)
			} else {
				lastPatrolAnalysis = analysis
				lastPatrolAnalysisAt = time.Now()
			}
		}
		analysis := lastPatrolAnalysis
		payload := make([]patrolEvent, 0, len(current)+len(activePatrol))
		for _, event := range current {
			currentSet[event.Fingerprint] = true
			if analysis != "" {
				event.Analysis = analysis
				event.Detail += "\n\nAI 分析：" + analysis
			}
			payload = append(payload, event)
		}
		for fingerprint := range activePatrol {
			if !currentSet[fingerprint] {
				payload = append(payload, patrolEvent{
					Fingerprint: fingerprint,
					Resolved:    true,
					DetectedAt:  time.Now().UTC().Format(time.RFC3339),
				})
			}
		}
		if len(current) > 0 && (diagnosticsCache == nil || time.Since(diagnosticsAt) > 5*time.Minute) {
			log.Printf("collecting diagnostics bundle events=%d", len(current))
			report := collectDiscovery(started, metrics)
			diagnosticsCache = collectDiagnosticsBundle(metrics, report)
			diagnosticsAt = time.Now()
		}
		_ = paths.writeSnapshot("patrol.json", map[string]any{
			"events":               payload,
			"checkedAt":            time.Now().UTC().Format(time.RFC3339),
			"diagnosticsAvailable": diagnosticsCache != nil,
		})
		if err := post(controlURL+"/api/agents/"+registered.Agent.ID+"/events", nil, map[string]any{
			"agentKey":       registered.AgentKey,
			"events":         payload,
			"resolveMissing": true,
			"diagnostics":    diagnosticsCache,
		}, nil); err != nil {
			log.Printf("patrol report: %v", err)
			return
		}
		if len(payload) > 0 {
			log.Printf("patrol reported events=%d fingerprints=%v", len(payload), fingerprints(payload))
		}
		for fingerprint := range activePatrol {
			if !currentSet[fingerprint] {
				delete(activePatrol, fingerprint)
			}
		}
		for fingerprint := range currentSet {
			activePatrol[fingerprint] = true
		}
	}

	beat := func() {
		if os.Getenv("OPSAGENT_AUTO_CSR") == "true" && time.Since(lastCertificateCheck) >= 6*time.Hour {
			if err := enrollAgentCertificate(controlURL, registered.Agent.ID, registered.AgentKey, hostname, paths); err != nil {
				log.Printf("certificate renewal: %v", err)
			}
			lastCertificateCheck = time.Now()
		}
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		metrics := hostMetrics()
		metrics["cpuCores"] = runtime.NumCPU()
		metrics["goroutines"] = runtime.NumGoroutine()
		metrics["heapMB"] = float64(memory.HeapAlloc) / 1024 / 1024
		metrics["uptimeSec"] = int64(time.Since(started).Seconds())
		if connReporter != nil {
			metrics["connSampler"] = connReporter.metrics()
		}
		var discovery *discoveryReport
		if time.Since(lastDiscovery) >= 5*time.Minute {
			report := collectDiscovery(started, metrics)
			discovery = &report
			lastDiscovery = time.Now()
			if err := paths.writeSnapshot("discovery.json", report); err != nil {
				log.Printf("discovery snapshot: %v", err)
			}
		}
		if time.Since(lastMetricsSnapshot) >= time.Minute {
			if err := paths.writeSnapshot("metrics.json", map[string]any{
				"metrics":      metrics,
				"capturedAt":   time.Now().UTC().Format(time.RFC3339),
				"agentVersion": agentVersion,
			}); err != nil {
				log.Printf("metrics snapshot: %v", err)
			}
			lastMetricsSnapshot = time.Now()
		}
		var connectionWindows []connEdgeWindow
		if connReporter != nil {
			connectionWindows = connReporter.snapshot()
		}
		var heartbeat heartbeatResponse
		certPath := os.Getenv("OPSAGENT_TLS_CERT")
		if certPath == "" {
			certPath = filepath.Join(paths.Root, "tls", "agent.pem")
		}
		certExpiresAt, certSerial := certificateMetadata(certPath)
		heartbeatErr := post(controlURL+"/api/agents/"+registered.Agent.ID+"/heartbeat", nil, heartbeatRequest{
			AgentKey:          registered.AgentKey,
			Metrics:           metrics,
			Discovery:         discovery,
			ConnectionWindows: connectionWindows,
			CommandKeyID:      registered.CommandKeyID,
			TLSCertExpiresAt:  certExpiresAt,
			TLSCertSerial:     certSerial,
		}, &heartbeat)
		if heartbeatErr != nil {
			log.Printf("heartbeat: %v", heartbeatErr)
			// 心跳失败时窗口保留在 reporter 中，下次心跳成功后重发。
		} else if connReporter != nil {
			connReporter.ack(len(connectionWindows))
		}
		if heartbeatErr == nil && len(heartbeat.CommandPublicKeys) > 0 {
			registered.CommandKeyID = heartbeat.CommandKeyID
			registered.CommandPublicKeys = heartbeat.CommandPublicKeys
			registered.CommandPublicKey = heartbeat.CommandPublicKeys[0].PublicKey
			if err := saveAgentState(paths, agentState{
				AgentID:           registered.Agent.ID,
				AgentKey:          registered.AgentKey,
				Hostname:          hostname,
				ControlURL:        controlURL,
				TenantID:          tenantID,
				CommandPublicKey:  registered.CommandPublicKey,
				CommandKeyID:      registered.CommandKeyID,
				CommandPublicKeys: registered.CommandPublicKeys,
				ResultPrivateKey:  resultPrivateSeedBase64,
				ResultPublicKey:   resultPublicKeyBase64,
			}); err != nil {
				log.Printf("save rotated command keys: %v", err)
			}
		}
		patrolInterval := time.Duration(currentPatrolPolicy.IntervalSeconds) * time.Second
		if patrolInterval < 30*time.Second {
			patrolInterval = 30 * time.Second
		}
		if time.Since(lastPatrol) >= patrolInterval {
			reportPatrol(metrics)
			lastPatrol = time.Now()
		}

		commandURL := controlURL + "/api/agents/" + registered.Agent.ID + "/commands/pending?agentKey=" + url.QueryEscape(registered.AgentKey)
		var command agentCommand
		status, err := getJSON(commandURL, &command)
		if err != nil {
			log.Printf("command poll: %v", err)
		} else if status == http.StatusOK && command.ID != "" {
			signatureValid := true
			if registered.CommandPublicKey != "" {
				commandKeys := registered.CommandPublicKeys
				if len(commandKeys) == 0 {
					commandKeys = []commandKey{{KeyID: registered.CommandKeyID, PublicKey: registered.CommandPublicKey}}
				}
				nonce, verifyErr := verifyCommandSignature(commandKeys, command.SignedPayload, command.Signature)
				if verifyErr == nil && commandNonceSeen(nonce) {
					verifyErr = fmt.Errorf("command replay detected")
				}
				if verifyErr != nil {
					signatureValid = false
					log.Printf("command rejected id=%s: %v", command.ID, verifyErr)
					if postErr := post(
						controlURL+"/api/agents/"+registered.Agent.ID+"/commands/"+command.ID+"/complete",
						nil,
						map[string]any{
							"agentKey": registered.AgentKey,
							"result":   map[string]any{"ok": false, "error": "invalid_signature", "detail": verifyErr.Error()},
						},
						nil,
					); postErr != nil {
						log.Printf("command reject upload id=%s: %v", command.ID, postErr)
					}
				}
			}
			if signatureValid {
				log.Printf("command received id=%s type=%s input=%s", command.ID, command.Type, compactJSON(command.Input))
				commandStarted := time.Now()
				result := runCommandWithInput(command.Type, metrics, command.Input)
				commandDuration := time.Since(commandStarted)
				log.Printf("command completed id=%s type=%s duration=%s ok=%v", command.ID, command.Type, commandDuration, result["ok"])
				resultSnapshot := map[string]any{
					"commandId":  command.ID,
					"type":       command.Type,
					"input":      command.Input,
					"result":     result,
					"startedAt":  commandStarted.UTC().Format(time.RFC3339),
					"finishedAt": time.Now().UTC().Format(time.RFC3339),
					"durationMs": commandDuration.Milliseconds(),
				}
				if err := paths.writeSnapshot(commandSnapshotName(command.ID), resultSnapshot); err != nil {
					log.Printf("command snapshot: %v", err)
				}
				if err := paths.writeSnapshot("last-command.json", resultSnapshot); err != nil {
					log.Printf("last command snapshot: %v", err)
				}
				pruneCommandSnapshots(paths, 20)
				resultSigned, marshalErr := json.Marshal(result)
				if marshalErr != nil {
					log.Printf("command result marshal id=%s: %v", command.ID, marshalErr)
					resultSigned = []byte("{}")
				}
				resultSignature := ed25519.Sign(resultPrivateKey, resultSigned)
				if err := post(
					controlURL+"/api/agents/"+registered.Agent.ID+"/commands/"+command.ID+"/complete",
					nil,
					map[string]any{
						"agentKey":        registered.AgentKey,
						"result":          result,
						"resultSigned":    string(resultSigned),
						"resultSignature": base64.StdEncoding.EncodeToString(resultSignature),
					},
					nil,
				); err != nil {
					log.Printf("command complete id=%s: %v", command.ID, err)
				} else {
					log.Printf("command result uploaded id=%s", command.ID)
				}
			}
		}
	}

	beat()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			log.Print("agent stopping")
			return
		case <-ticker.C:
			beat()
		}
	}
}
