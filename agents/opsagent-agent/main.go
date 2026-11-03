package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"
)

type registerRequest struct {
	TenantID     string   `json:"tenantId"`
	Name         string   `json:"name"`
	Hostname     string   `json:"hostname"`
	OS           string   `json:"os"`
	Arch         string   `json:"arch"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

type registerResponse struct {
	Agent struct {
		ID string `json:"id"`
	} `json:"agent"`
	AgentKey string `json:"agentKey"`
}

type heartbeatRequest struct {
	AgentKey string `json:"agentKey"`
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
	if err := post(controlURL+"/api/agents/register", headers, registerRequest{
		TenantID:     tenantID,
		Name:         name,
		Hostname:     hostname,
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
		Version:      "0.1.0",
		Capabilities: []string{"cpu", "memory", "disk", "network"},
	}, &registered); err != nil {
		log.Fatalf("register: %v", err)
	}
	log.Printf("registered agent %s", registered.Agent.ID)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			log.Print("agent stopping")
			return
		case <-ticker.C:
			if err := post(controlURL+"/api/agents/"+registered.Agent.ID+"/heartbeat", nil, heartbeatRequest{
				AgentKey: registered.AgentKey,
			}, nil); err != nil {
				log.Printf("heartbeat: %v", err)
			}
		}
	}
}
