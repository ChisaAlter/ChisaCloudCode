# Security Audit Report — cloudcli-plugin-session-manager v1.0.0

**Date:** 2026-05-24
**Auditor:** Independent review prior to public release
**Scope:** All source files (server.js, index.js, manifest.json, package.json, icon.svg)
**Status:** PASS — all critical and medium issues addressed

---

## Summary

The session-manager plugin was audited for security vulnerabilities, privilege escalation risks, information disclosure, and code quality prior to public release. Several HIGH severity issues were identified and fixed.

## Architecture Security

| Property | Status |
|----------|--------|
| Server binds to `127.0.0.1` only | PASS |
| Kill endpoint validates PID is a Claude process | PASS (fixed) |
| Resume endpoint validates all inputs | PASS (fixed) |
| No shell injection vectors | PASS (fixed) |
| No privilege escalation via client input | PASS (fixed) |
| Request body size limits | PASS (fixed) |
| HTML attribute injection prevention | PASS (fixed) |
| No hardcoded credentials or secrets | PASS |
| No personal information in source | PASS |
| Configurable home directories via env var | PASS |

## Findings (All Resolved)

### 1. Command Injection via `execSync` — Fixed
**Severity:** HIGH
**Issue:** UID-to-username resolution used `execSync` with string interpolation, which invokes a shell.
**Resolution:** Replaced with `execFileSync('id', ['-un', String(uid)])` — argument array avoids shell entirely.

### 2. Shell Injection via `spawn('su', ...)` — Fixed
**Severity:** HIGH
**Issue:** The resume handler constructed a shell command string with `JSON.stringify`, which does not produce shell-safe output. Attacker-controlled `cwd` and `sessionId` could break out of quotes.
**Resolution:**
- `sessionId` validated against strict regex: `/^[0-9a-f-]{8,64}$/i`
- `cwd` validated against safe path regex: `/^\/[^\0;&|`$<>'"\\!]+$/`
- Shell arguments use proper single-quote escaping (`'\\''` pattern)

### 3. Privilege Escalation via Client-Supplied User — Fixed
**Severity:** HIGH
**Issue:** The resume endpoint accepted a `user` field from the HTTP request and passed it to `su`, allowing any caller to specify `root` or other privileged users.
**Resolution:** Client-supplied `user` is now ignored. The server always uses `SESSION_MANAGER_USER` env var (defaults to the current OS user).

### 4. Arbitrary Process Kill — Fixed
**Severity:** HIGH
**Issue:** `POST /sessions/:pid/kill` would signal any PID on the system without verifying it belonged to a Claude process.
**Resolution:** Added `findClaudePids()` check before signaling — returns 403 if the PID is not in the live Claude process list.

### 5. Unbounded Request Body — Fixed
**Severity:** MEDIUM
**Issue:** The resume endpoint accumulated request body data with no size limit, enabling memory exhaustion.
**Resolution:** Added 4 KB body size limit with 413 response on overflow.

### 6. HTML Attribute Injection via `escHtml` — Fixed
**Severity:** MEDIUM
**Issue:** `escHtml` did not escape single quotes. The `data-resume` attribute used single-quote delimiters, allowing attribute breakout via `cwd` or `user` values containing `'`.
**Resolution:** Added `'` → `&#39;` to `escHtml`.

## Accepted Design Decisions

### CORS Wildcard
The server sets `Access-Control-Allow-Origin: *`. Mitigated by `127.0.0.1` binding and CloudCLI's plugin RPC proxy handling authentication. If deploying outside CloudCLI, restrict the origin.

### Session Context Exposure
The `/sessions/:pid/context` endpoint returns conversation excerpts (last prompt, away summary, last output). This data may include sensitive content. Access is limited to `127.0.0.1` and CloudCLI's authenticated proxy.

### Linux-Only `/proc` Dependency
The plugin uses `/proc` for process inspection, making it Linux-only. This is documented in the README and is intentional for the target environment (Docker containers).

## Recommendations for Deployers

1. Set `SESSION_MANAGER_USER` to the non-root user running Claude Code
2. Do not run the plugin server as root if avoidable
3. Ensure CloudCLI authentication is enabled when exposed to networks
4. Set `SESSION_MANAGER_HOMES` to only the home directories that should be scanned
5. The plugin should only be used in trusted, single-user or team environments

## Clean Items

- No hardcoded credentials, tokens, API keys, or passwords
- No personal identifiers, IP addresses, or hostnames
- No environment-specific paths (all configurable via env vars)
- SVG icon contains only geometry, no embedded data
- MIT license with no restrictive clauses
