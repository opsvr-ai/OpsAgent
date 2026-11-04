package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"
)

type registerRequest struct {
	TenantID     string           `json:"tenantId"`
	Name         string           `json:"name"`
	Hostname     string           `json:"hostname"`
	OS           string           `json:"os"`
	Arch         string           `json:"arch"`
	Version      string           `json:"version"`
	Capabilities []string         `json:"capabilities"`
	Discovery    *discoveryReport `json:"discovery,omitempty"`
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
	AgentKey  string           `json:"agentKey"`
	Metrics   map[string]any   `json:"metrics"`
	Discovery *discoveryReport `json:"discovery,omitempty"`
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
	case "diagnostics":
		result["metrics"] = metrics
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
	client := &http.Client{Timeout: 15 * time.Second}
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
	client := &http.Client{Timeout: 15 * time.Second}
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
	initialMetrics := hostMetrics()
	initialDiscovery := collectDiscovery(started, initialMetrics)
	if err := paths.writeSnapshot("discovery.json", initialDiscovery); err != nil {
		log.Printf("initial discovery snapshot: %v", err)
	}
	if err := post(controlURL+"/api/agents/register", headers, registerRequest{
		TenantID:     tenantID,
		Name:         name,
		Hostname:     hostname,
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
		Version:      agentVersion,
		Capabilities: []string{"cpu", "memory", "disk", "network", "system.discover", "applications.discover", "self.patrol", "inspect", "snapshot"},
		Discovery:    &initialDiscovery,
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
	}); err != nil {
		log.Printf("save agent state: %v", err)
	} else {
		log.Printf("agent state saved path=%s", statePath(paths))
	}
	lastDiscovery := time.Now()
	lastPatrol := time.Time{}
	lastMetricsSnapshot := time.Time{}
	activePatrol := map[string]bool{}
	var diagnosticsCache map[string]any
	var diagnosticsAt time.Time

	reportPatrol := func(metrics map[string]any) {
		current := patrolEvents(metrics)
		currentSet := map[string]bool{}
		payload := make([]patrolEvent, 0, len(current)+len(activePatrol))
		for _, event := range current {
			currentSet[event.Fingerprint] = true
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
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		metrics := hostMetrics()
		metrics["cpuCores"] = runtime.NumCPU()
		metrics["goroutines"] = runtime.NumGoroutine()
		metrics["heapMB"] = float64(memory.HeapAlloc) / 1024 / 1024
		metrics["uptimeSec"] = int64(time.Since(started).Seconds())
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
		if err := post(controlURL+"/api/agents/"+registered.Agent.ID+"/heartbeat", nil, heartbeatRequest{
			AgentKey:  registered.AgentKey,
			Metrics:   metrics,
			Discovery: discovery,
		}, nil); err != nil {
			log.Printf("heartbeat: %v", err)
		}
		if time.Since(lastPatrol) >= 30*time.Second {
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
				if err := post(
					controlURL+"/api/agents/"+registered.Agent.ID+"/commands/"+command.ID+"/complete",
					nil,
					map[string]any{"agentKey": registered.AgentKey, "result": result},
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
