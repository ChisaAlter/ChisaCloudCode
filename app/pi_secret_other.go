//go:build !windows

package main

import "fmt"

func protectPiSecret([]byte) ([]byte, error) { return nil, fmt.Errorf("Pi 密钥存储需要 Windows") }
func unprotectPiSecret([]byte) ([]byte, error) {
	return nil, fmt.Errorf("Pi 密钥存储需要 Windows")
}
