//go:build !windows

package main

import "os"

func credentialReparsePoint(os.FileInfo) bool { return false }
func secureAccountCredential(path string, directory bool) error {
	mode := os.FileMode(0600)
	if directory {
		mode = 0700
	}
	return os.Chmod(path, mode)
}
func protectAccountCredential(raw []byte) ([]byte, error)   { return raw, nil }
func unprotectAccountCredential(raw []byte) ([]byte, error) { return raw, nil }
