package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/schema"
)

func aiDiagnose(metrics map[string]any) (string, error) {
	apiKey := os.Getenv("DEEPSEEK_API_KEY")
	if apiKey == "" {
		return "", errors.New("model_credentials_missing")
	}
	baseURL := os.Getenv("DEEPSEEK_BASE_URL")
	if baseURL == "" {
		baseURL = "https://api.deepseek.com/v1"
	}
	modelName := os.Getenv("DEEPSEEK_MODEL")
	if modelName == "" {
		modelName = "deepseek-chat"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	chat, err := openai.NewChatModel(ctx, &openai.ChatModelConfig{
		APIKey:  apiKey,
		BaseURL: baseURL,
		Model:   modelName,
	})
	if err != nil {
		return "", err
	}
	payload, _ := json.Marshal(metrics)
	out, err := chat.Generate(ctx, []*schema.Message{
		schema.SystemMessage("你是服务器诊断助手。只根据给定指标给出简短的异常判断、可能原因和下一步检查建议，不要编造指标。"),
		schema.UserMessage(fmt.Sprintf("主机指标：%s", string(payload))),
	})
	if err != nil {
		return "", err
	}
	return out.Content, nil
}
