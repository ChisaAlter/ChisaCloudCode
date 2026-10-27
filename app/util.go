package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
)

func jsonResp(w http.ResponseWriter, code int, obj any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	b, _ := json.Marshal(obj)
	_, _ = w.Write(b)
}

func exeDir() string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Dir(exe)
	}
	wd, _ := os.Getwd()
	return wd
}
