package main

import "encoding/json"

// Plain go builds remain explicitly unknown; the packaging hook embeds metadata.
var nativeBuildIdentityJSON = `{"version":null,"commit":null,"dirty":null,"builtAt":null}`

// GetBuildIdentity is a read-only view of the running desktop binary, with no CLI calls.
func (FrontendBridge) GetBuildIdentity() map[string]any {

	var identity map[string]any
	_ = json.Unmarshal([]byte(nativeBuildIdentityJSON), &identity)
	return identity
}
