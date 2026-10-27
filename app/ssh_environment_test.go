package main

import (
	"strings"
	"testing"
)

func TestSshTunnelEnvironmentDoesNotInheritProviderSecretsOrAskpass(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "test-provider-secret")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test-cloud-secret")
	t.Setenv("SSH_ASKPASS", "untrusted-askpass.exe")
	t.Setenv("SSH_ASKPASS_REQUIRE", "force")
	t.Setenv("SSH_AUTH_SOCK", "configured-unlocked-agent")
	values := strings.Join(sshTunnelEnvironment(), "\n")
	for _, forbidden := range []string{"test-provider-secret", "test-cloud-secret", "untrusted-askpass.exe", "SSH_ASKPASS_REQUIRE=force"} {
		if strings.Contains(values, forbidden) {
			t.Fatal("SSH inherited a secret or executable discovery override")
		}
	}
	if !strings.Contains(values, "SSH_ASKPASS_REQUIRE=never") || !strings.Contains(values, "SSH_AUTH_SOCK=configured-unlocked-agent") {
		t.Fatal("noninteractive SSH environment lost required explicit values")
	}
}
