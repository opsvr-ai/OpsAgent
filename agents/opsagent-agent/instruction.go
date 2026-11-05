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
	if kind == "service_status" {
		params, _ := intent["params"].(map[string]any)
		service, _ := params["service"].(string)
		service = strings.TrimSpace(service)
		if !serviceNamePattern.MatchString(service) {
			result["error"] = "invalid service name"
			result["intent"] = intent
			return result
		}
		output, err := serviceStatus(service)
		result["instruction"] = instruction
		result["intent"] = intent
		result["toolsUsed"] = []string{"service.status"}
		result["evidence"] = map[string]string{"service": service, "output": trimEvidence(output)}
		if err != nil {
			result["error"] = fmt.Sprintf("service %s status failed: %v", service, err)
			result["answer"] = fmt.Sprintf("服务 %s 状态查询失败：%v\n%s", service, err, trimEvidence(output))
			return result
		}
		result["ok"] = true
		result["answer"] = fmt.Sprintf("服务 %s 状态：%s", service, strings.TrimSpace(output))
		return result
	}

	if kind == "service_restart" || kind == "service_stop" || kind == "service_start" ||
		kind == "service_reload" || kind == "service_enable" || kind == "service_disable" {
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
		} else if kind == "service_start" {
			action = "start"
			label = "启动"
		} else if kind == "service_reload" {
			action = "reload"
			label = "重新加载"
		} else if kind == "service_enable" {
			action = "enable"
			label = "启用"
		} else if kind == "service_disable" {
			action = "disable"
			label = "禁用"
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
		answer := fmt.Sprintf("服务 %s 已%s。", service, label)
		expectedState := ""
		switch kind {
		case "service_start", "service_restart", "service_reload":
			expectedState = "active"
		case "service_stop":
			expectedState = "inactive"
		}
		if expectedState != "" {
			if state, _ := serviceStatus(service); strings.TrimSpace(state) != "" {
				trimmed := strings.TrimSpace(state)
				answer += fmt.Sprintf("当前状态：%s", trimmed)
				if evidence, ok := result["evidence"].(map[string]string); ok {
					evidence["state"] = trimmed
				}
				if trimmed != expectedState {
					result["ok"] = false
					result["error"] = fmt.Sprintf("service %s state %s, expected %s", service, trimmed, expectedState)
					answer += fmt.Sprintf("（预期 %s）", expectedState)
				}
			}
		}
		if kind == "service_enable" || kind == "service_disable" {
			expectedEnabled := "enabled"
			if kind == "service_disable" {
				expectedEnabled = "disabled"
			}
			if enabled, _ := serviceEnabledState(service); strings.TrimSpace(enabled) != "" {
				trimmed := strings.TrimSpace(enabled)
				answer += fmt.Sprintf("开机状态：%s", trimmed)
				if evidence, ok := result["evidence"].(map[string]string); ok {
					evidence["enabledState"] = trimmed
				}
				if trimmed != expectedEnabled {
					result["ok"] = false
					result["error"] = fmt.Sprintf("service %s enabled state %s, expected %s", service, trimmed, expectedEnabled)
					answer += fmt.Sprintf("（预期 %s）", expectedEnabled)
				}
			}
		}
		outputText := trimEvidence(output)
		if outputText != "" {
			answer += "\n" + outputText
		}
		result["answer"] = answer
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
	result["analysis"] = inspection["analysis"]
	result["evidence"] = inspection["evidence"]
	result["toolsUsed"] = []string{"inspect"}
	return result
}
