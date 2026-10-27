//go:build !windows

package main

import "errors"

func newSshProcessOwner() (sshProcessOwner, error) {
	return nil, errors.New("native SSH tunnels require Windows")
}
