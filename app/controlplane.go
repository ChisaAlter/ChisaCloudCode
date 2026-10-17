package main

import (
	"fmt"
	"net"
	"net/http"
	"time"
)

// Only authenticated, epoch-bound workspace RPC is reachable through SSH.
func StartControlPlane(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return fmt.Errorf("工作区控制面必须绑定回环地址")
	}
	mux := http.NewServeMux()
	registerFSEndpoints(mux)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			fmt.Println("workspace listener:", err)
		}
	}()
	return nil
}
