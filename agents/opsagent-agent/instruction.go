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
	if kind == "service_restart" {
		readOnly, _ := input["readOnly"].(bool)
		if readOnly {
			result["error"] = "service restart cannot be read-only"
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
		output, err := restartService(service)
		result["instruction"] = instruction
		result["intent"] = intent
		result["toolsUsed"] = []string{"service.restart"}
		result["evidence"] = map[string]string{"service": service, "output": trimEvidence(output)}
		if err != nil {
			result["error"] = fmt.Sprintf("restart %s failed: %v", service, err)
			result["answer"] = fmt.Sprintf("服务 %s 重启失败：%v\n%s", service, err, trimEvidence(output))
			return result
		}
		result["ok"] = true
		result["answer"] = fmt.Sprintf("服务 %s 已重启。\n%s", service, trimEvidence(output))
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
