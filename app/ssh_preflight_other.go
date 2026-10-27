//go:build !windows

package main

func nativeSshPreflight() SshPreflight {
	return SshPreflight{Platform: "unsupported", Issues: []SshPreflightIssue{{"SSH_PLATFORM_UNSUPPORTED", "本地 SSH 开发目前仅支持 Windows 桌面。"}}}
}
