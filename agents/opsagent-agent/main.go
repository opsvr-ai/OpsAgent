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
	AgentKey string `json:"agentKey"`
}

type heartbeatRequest struct {
	AgentKey  string           `json:"agentKey"`
	Metrics   map[string]any   `json:"metrics"`
	Discovery *discoveryReport `json:"discovery,omitempty"`
}

var agentStarted = time.Now()

type agentCommand struct {
	ID    string         `json:"id"`
	Type  string         `json:"type"`
	Input map[string]any `json:"input"`
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
	default:
		result["ok"] = false
		result["error"] = "unsupported_command"
	}
	return result
}

func getJSON(url string, target any) (int, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Get(url)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
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
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return fmt.Errorf("%s returned %d", url, response.StatusCode)
	}
	if target == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(target)
}

func main() {
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

	headers := map[string]string{}
	if token != "" {
		headers["x-opsagent-enrollment-token"] = token
	}
	registered := registerResponse{}
	agentStarted = time.Now()
	started := agentStarted
	initialMetrics := hostMetrics()
	initialDiscovery := collectDiscovery(started, initialMetrics)
	if err := post(controlURL+"/api/agents/register", headers, registerRequest{
		TenantID:     tenantID,
		Name:         name,
		Hostname:     hostname,
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
		Version:      agentVersion,
		Capabilities: []string{"cpu", "memory", "disk", "network", "system.discover", "applications.discover"},
		Discovery:    &initialDiscovery,
	}, &registered); err != nil {
		log.Fatalf("register: %v", err)
	}
	log.Printf("registered agent %s", registered.Agent.ID)
	lastDiscovery := time.Now()
	lastPatrol := time.Time{}
	activePatrol := map[string]bool{}

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
		if err := post(controlURL+"/api/agents/"+registered.Agent.ID+"/events", nil, map[string]any{
			"agentKey":       registered.AgentKey,
			"events":         payload,
			"resolveMissing": true,
		}, nil); err != nil {
			log.Printf("patrol report: %v", err)
			return
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
			result := runCommandWithInput(command.Type, metrics, command.Input)
			if err := post(
				controlURL+"/api/agents/"+registered.Agent.ID+"/commands/"+command.ID+"/complete",
				nil,
				map[string]any{"agentKey": registered.AgentKey, "result": result},
				nil,
			); err != nil {
				log.Printf("command complete: %v", err)
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
