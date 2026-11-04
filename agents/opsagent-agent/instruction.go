package main

import (
	"fmt"
	"regexp"
	"strings"
)

var serviceNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$`)

// runAgentInstruction executes a server-planned instruction.
// The natural language text is never passed to a shell.
func runAgentInstruction(input map[string]any) map[string]any {
	result := map[string]any{"type": "agent_instruction", "ok": false}
	instruction, _ := input["instruction"].(string)
	instruction = strings.TrimSpace(instruction)
	if instruction == "" {
		result["error"] = "instruction is required"
		return result
	}
	intent := map[string]any{}
	if value, ok := input["intent"].(map[string]any); ok {
		intent = value
	}
	kind, _ := intent["kind"].(string)
	if kind == "" {
		kind = "inspect"
	}
	if kind == "service_restart" || kind == "service_stop" {
		readOnly, _ := input["readOnly"].(bool)
		if readOnly {
			result["error"] = "service action cannot be read-only"
			result["intent"] = intent
			return result
		}
		params, _ := intent["params"].(map[string]any)
		service, _ := params["service"].(string)
		service = strings.TrimSpace(service)
		if !serviceNamePattern.MatchString(service) {
			result["error"] = "invalid service name"
			result["intent"] = intent
			return result
		}
		action := "restart"
		label := "重启"
		if kind == "service_stop" {
			action = "stop"
			label = "停止"
		}
		output, err := controlService(action, service)
		result["instruction"] = instruction
		result["intent"] = intent
		result["toolsUsed"] = []string{"service." + action}
		result["evidence"] = map[string]string{"service": service, "action": action, "output": trimEvidence(output)}
		if err != nil {
			result["error"] = fmt.Sprintf("%s %s failed: %v", action, service, err)
			result["answer"] = fmt.Sprintf("服务 %s %s失败：%v\n%s", service, label, err, trimEvidence(output))
			return result
		}
		result["ok"] = true
		result["answer"] = fmt.Sprintf("服务 %s 已%s。\n%s", service, label, trimEvidence(output))
		return result
	}
	if kind != "inspect" {
		result["error"] = "unsupported intent: " + kind
		result["intent"] = intent
		return result
	}
	question := instruction
	if params, ok := intent["params"].(map[string]any); ok {
		if value, ok := params["question"].(string); ok && strings.TrimSpace(value) != "" {
			question = value
		}
	}
	inspection := inspectHost(question, hostMetrics())
	result["ok"] = true
	result["instruction"] = instruction
	result["intent"] = intent
	result["answer"] = inspection["answer"]
	result["evidence"] = inspection["evidence"]
	result["toolsUsed"] = []string{"inspect"}
	return result
}
