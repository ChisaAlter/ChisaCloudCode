package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

type piDataBlob struct {
	Size uint32
	Data *byte
}

var piCrypt32 = syscall.NewLazyDLL("crypt32.dll")
var piProtectData = piCrypt32.NewProc("CryptProtectData")
var piUnprotectData = piCrypt32.NewProc("CryptUnprotectData")
var piLocalFree = syscall.NewLazyDLL("kernel32.dll").NewProc("LocalFree")

func protectPiSecret(value []byte) ([]byte, error)   { return piCryptData(piProtectData, value) }
func unprotectPiSecret(value []byte) ([]byte, error) { return piCryptData(piUnprotectData, value) }

func piCryptData(procedure *syscall.LazyProc, value []byte) ([]byte, error) {
	if len(value) == 0 {
		return nil, fmt.Errorf("密钥为空")
	}
	input := piDataBlob{Size: uint32(len(value)), Data: &value[0]}
	var output piDataBlob
	// DPAPI binds this secret to the current Windows user; UI prompting is disabled.
	result, _, err := procedure.Call(uintptr(unsafe.Pointer(&input)), 0, 0, 0, 0, 1, uintptr(unsafe.Pointer(&output)))
	if result == 0 {
		return nil, err
	}
	defer piLocalFree.Call(uintptr(unsafe.Pointer(output.Data)))
	return append([]byte(nil), unsafe.Slice(output.Data, output.Size)...), nil
}
