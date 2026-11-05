package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
)

// fileCheckpointStore implements Eino compose.CheckPointStore on disk.
// It is intentionally small and dependency-free so interrupted ADK runs can be
// resumed after an agent restart.
type fileCheckpointStore struct {
	dir string
}

func newFileCheckpointStore(dir string) (*fileCheckpointStore, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	return &fileCheckpointStore{dir: dir}, nil
}

func (s *fileCheckpointStore) path(key string) string {
	encoded := base64.RawURLEncoding.EncodeToString([]byte(key))
	return filepath.Join(s.dir, encoded+".checkpoint")
}

func (s *fileCheckpointStore) Get(_ context.Context, key string) ([]byte, bool, error) {
	data, err := os.ReadFile(s.path(key))
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

func (s *fileCheckpointStore) Set(_ context.Context, key string, value []byte) error {
	target := s.path(key)
	temp := target + ".tmp"
	if err := os.WriteFile(temp, value, 0o640); err != nil {
		return fmt.Errorf("write checkpoint: %w", err)
	}
	if err := os.Rename(temp, target); err != nil {
		_ = os.Remove(temp)
		return fmt.Errorf("commit checkpoint: %w", err)
	}
	return nil
}
