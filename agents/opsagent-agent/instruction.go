package main

import "strings"

// runAgentInstruction executes a server-planned, read-only instruction.
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
