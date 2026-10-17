package main

import "testing"

func TestGetBuildIdentityUsesEmbeddedMetadata(t *testing.T) {
	original := nativeBuildIdentityJSON
	t.Cleanup(func() { nativeBuildIdentityJSON = original })
	nativeBuildIdentityJSON = `{"version":"0.1.6","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","dirty":true,"builtAt":null}`
	identity := (FrontendBridge{}).GetBuildIdentity()
	if identity["version"] != "0.1.6" || identity["dirty"] != true {
		t.Fatalf("unexpected embedded identity: %#v", identity)
	}
}
