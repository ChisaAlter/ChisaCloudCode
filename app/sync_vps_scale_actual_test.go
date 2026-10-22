//go:build windows && vpsqa

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// This separate opt-in run requires its own fresh manifest root. Both replicas
// are populated by the real product import and engine SSH transfer, never a
// fixture copy. The tiny full-chain test keeps its independent project root.
func TestVPSProductLargeRepositoryPerformance(t *testing.T) {
	manifest := readProductVPSManifest(t)
	if manifest.TrackedFiles < 37000 || manifest.TrackedFiles > 100000 || manifest.SaveSamples < 20 || manifest.SaveSamples > 100 || manifest.IdleSeconds < 105 || manifest.IdleSeconds > 600 || !filepath.IsAbs(manifest.EvidencePath) {
		t.Fatal("scale manifest requires trackedFiles37000..100000, saveSamples20..100, idleSeconds105..600, absolute evidencePath")
	}
	if manifest.NodeCommandFile != "" {
		t.Fatal("scale fixture requires an independent root without a Node barrier")
	}
	evidenceAbsolute := filepath.Clean(manifest.EvidencePath)
	if filepath.Base(filepath.Dir(evidenceAbsolute)) != "final-scale" || filepath.Ext(evidenceAbsolute) != ".json" {
		t.Fatal("scale evidence must be a new JSON file in the explicit final-scale directory")
	}
	if err := os.MkdirAll(filepath.Dir(evidenceAbsolute), 0700); err != nil {
		t.Fatal(err)
	}
	evidenceFile, err := os.OpenFile(evidenceAbsolute, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal("scale evidence path already exists or is unavailable", err)
	}
	t.Cleanup(func() { _ = evidenceFile.Close() })
	f := newProductVPSFixture(t, manifest)
	m := f.mapping
	evidence := map[string]any{"runId": manifest.RunID, "kind": "actual-native-Windows-SSH-Linux", "trackedFiles": manifest.TrackedFiles, "ignoredFiles": 4096, "saveSamples": manifest.SaveSamples, "idleSeconds": manifest.IdleSeconds, "sourceRoot": m.ServerPath, "passed": false, "scope": "manual seeded connection; no account login/provider-model claim"}
	defer func() {
		encoded, _ := json.MarshalIndent(evidence, "", "  ")
		if _, err := evidenceFile.Write(append(encoded, '\n')); err != nil {
			t.Error("scale evidence write", err)
		}
		if err := evidenceFile.Sync(); err != nil {
			t.Error("scale evidence sync", err)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
	defer cancel()
	seedStarted := time.Now()
	if _, err := gitOutputContext(ctx, m.LocalPath, "init", "-b", "main"); err != nil {
		t.Fatal(err)
	}
	content := []byte(strings.Repeat("actual shared blob content\n", 19) + "end\n")
	oid, err := gitOutputContextEnvInput(ctx, m.LocalPath, nil, content, "hash-object", "-w", "--stdin")
	if err != nil {
		t.Fatal(err)
	}
	var index bytes.Buffer
	for i := 0; i < manifest.TrackedFiles; i++ {
		name := fmt.Sprintf("packages/pkg%03d/src/file%05d.txt", i/100, i)
		full := filepath.Join(m.LocalPath, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, content, 0600); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&index, "100644 %s\t%s%c", oid, name, 0)
	}
	if _, err := gitOutputContextEnvInput(ctx, m.LocalPath, nil, index.Bytes(), "update-index", "-z", "--index-info"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.LocalPath, ".gitignore"), []byte("node_modules/\nprivate-generated/\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4096; i++ {
		name := filepath.Join(m.LocalPath, "node_modules", fmt.Sprintf("ignored-%05d.txt", i))
		if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, []byte("ignored dependency canary\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	canary := filepath.Join(m.LocalPath, "wan-save.txt")
	if err := os.WriteFile(canary, []byte("save:0 "+manifest.RunID+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := gitOutputContext(ctx, m.LocalPath, "add", ".gitignore", "wan-save.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := gitOutputContext(ctx, m.LocalPath, "commit", "-m", "task-owned actual WAN scale seed"); err != nil {
		t.Fatal(err)
	}
	evidence["localSeedMs"] = time.Since(seedStarted).Milliseconds()
	coldStarted := time.Now()
	if result := syncProjectWithEmptyConfirmationContext(ctx, m.ServerPath, ""); result["ok"] != true {
		t.Fatal("actual cold scale migration", result["error"])
	}
	evidence["coldImportMs"] = time.Since(coldStarted).Milliseconds()
	m = store.findMappingByServer(m.ServerPath)
	f.mapping = m
	assertScaleSession(t, ctx, m)
	proof, _ := json.Marshal(map[string]any{"root": m.ServerPath, "count": manifest.TrackedFiles, "content": string(content)})
	inventory := `import hashlib,json,pathlib,sys
q=json.loads(sys.argv[1]);p=pathlib.Path(q['root']);files=list((p/'packages').rglob('file*.txt'));assert len(files)==q['count']
expected=hashlib.sha256(q['content'].encode()).digest()
assert all(hashlib.sha256(x.read_bytes()).digest()==expected for x in files)
assert not (p/'node_modules').exists()
print('actual-beta-inventory-and-bytes-verified')`
	if output := f.remoteTimeout(t, 90*time.Second, "python3 -B -c "+shellQuote(inventory)+" "+shellQuote(string(proof))); output != "actual-beta-inventory-and-bytes-verified" {
		t.Fatal("actual scale replica proof missing")
	}
	evidence["betaInventoryAndBytesVerified"] = true
	// This observer is a test-only single-file poller. Its SSH session is ready
	// before t0; each latency includes transfer and return ACK, not SSH setup.
	observer := `import hashlib,pathlib,sys,time
p=pathlib.Path(sys.argv[1]);run=sys.argv[2];count=int(sys.argv[3]);print('ready',flush=True)
for seq in range(1,count+1):
 expected=('save:'+str(seq)+' '+run+'\n').encode();deadline=time.monotonic()+90
 while True:
  try:value=p.read_bytes()
  except FileNotFoundError:value=b''
  if value==expected:break
  if time.monotonic()>=deadline:raise RuntimeError('WAN canary deadline expired')
  time.sleep(.02)
 print(str(seq)+' '+hashlib.sha256(value).hexdigest(),flush=True)`
	command := hideCommandWindow(exec.CommandContext(ctx, sshExe(), append(f.transport.baseArgs(), "python3 -B -u -c "+shellQuote(observer)+" "+shellQuote(m.ServerPath+"/wan-save.txt")+" "+shellQuote(manifest.RunID)+" "+fmt.Sprint(manifest.SaveSamples))...))
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if command.Process != nil {
			_ = command.Process.Kill()
		}
	}()
	reader := bufio.NewReader(stdout)
	if line, _ := reader.ReadString('\n'); strings.TrimSpace(line) != "ready" {
		t.Fatal("task-only canary observer failed")
	}
	var latencies []float64
	for seq := 1; seq <= manifest.SaveSamples; seq++ {
		body := []byte(fmt.Sprintf("save:%d %s\n", seq, manifest.RunID))
		started := time.Now()
		if err := os.WriteFile(canary, body, 0600); err != nil {
			t.Fatal(err)
		}
		line := make(chan string, 1)
		go func() { value, _ := reader.ReadString('\n'); line <- value }()
		select {
		case response := <-line:
			digest := sha256.Sum256(body)
			if strings.TrimSpace(response) != fmt.Sprintf("%d %s", seq, hex.EncodeToString(digest[:])) {
				t.Fatal("WAN canary response mismatch")
			}
		case <-time.After(90 * time.Second):
			t.Fatal("WAN automatic save did not converge")
		}
		latencies = append(latencies, float64(time.Since(started).Microseconds())/1000)
	}
	if err := command.Wait(); err != nil {
		t.Fatal("WAN observer exit", err)
	}
	sorted := append([]float64(nil), latencies...)
	sort.Float64s(sorted)
	evidence["saveLatenciesMs"] = latencies
	evidence["saveP50Ms"] = sorted[len(sorted)/2]
	evidence["saveP95Ms"] = sorted[(len(sorted)*95+99)/100-1]
	evidence["latencyIncludesAckRtt"] = true
	evidence["testObserverPollIntervalMs"] = 20
	// No observer poller runs during the idle measurement. Exact task-owned agent
	// exe and cwd, process birth token, and private Windows executable identify
	// measured processes; the account's other agents/daemons are excluded.
	assertScaleSession(t, ctx, m)
	remoteBefore := scaleRemoteAgentStats(t, f)
	windowsBefore := scaleWindowsStats(t, filepath.Join(f.private, "resources", "mutagen.exe"))
	idleStarted := time.Now()
	idleDeadline := time.Now().Add(time.Duration(manifest.IdleSeconds) * time.Second)
	for time.Now().Before(idleDeadline) {
		remaining := time.Until(idleDeadline)
		if remaining > 30*time.Second {
			remaining = 30 * time.Second
		}
		timer := time.NewTimer(remaining)
		select {
		case <-ctx.Done():
			timer.Stop()
			t.Fatal(ctx.Err())
		case <-timer.C:
			t.Logf("scale idle evidence window elapsed=%s", time.Since(idleStarted))
		}
	}
	remoteAfter := scaleRemoteAgentStats(t, f)
	windowsAfter := scaleWindowsStats(t, filepath.Join(f.private, "resources", "mutagen.exe"))
	idleElapsed := time.Since(idleStarted).Seconds()
	evidence["idleElapsedSeconds"] = idleElapsed
	evidence["remoteAgentBefore"] = remoteBefore
	evidence["remoteAgentAfter"] = remoteAfter
	evidence["windowsProcessesBefore"] = windowsBefore
	evidence["windowsProcessesAfter"] = windowsAfter
	for _, before := range remoteBefore {
		for _, after := range remoteAfter {
			if before["pid"] == after["pid"] && before["startTime"] == after["startTime"] {
				ticks := after["ticks"].(float64) - before["ticks"].(float64)
				evidence["remoteAgentCpuPercentOneCore"] = 100 * ticks / after["clockTicksPerSecond"].(float64) / idleElapsed
			}
		}
	}
	var windowsCPU []map[string]any
	for _, before := range windowsBefore {
		for _, after := range windowsAfter {
			if fmt.Sprint(before["ProcessId"]) == fmt.Sprint(after["ProcessId"]) && fmt.Sprint(before["CreationDate"]) == fmt.Sprint(after["CreationDate"]) {
				var oldKernel, oldUser, newKernel, newUser float64
				_, _ = fmt.Sscan(fmt.Sprint(before["KernelModeTime"]), &oldKernel)
				_, _ = fmt.Sscan(fmt.Sprint(before["UserModeTime"]), &oldUser)
				_, _ = fmt.Sscan(fmt.Sprint(after["KernelModeTime"]), &newKernel)
				_, _ = fmt.Sscan(fmt.Sprint(after["UserModeTime"]), &newUser)
				windowsCPU = append(windowsCPU, map[string]any{"pid": after["ProcessId"], "exe": after["ExecutablePath"], "cpuPercentOneCore": 100 * ((newKernel + newUser) - (oldKernel + oldUser)) / 1e7 / idleElapsed, "workingSetBytes": after["WorkingSetSize"]})
			}
		}
	}
	evidence["windowsIdleCpuPerProcess"] = windowsCPU
	if evidence["remoteAgentCpuPercentOneCore"] == nil {
		t.Fatal("exact remote agent restarted or process ownership evidence is missing")
	}
	idleObserver := `import hashlib,pathlib,sys,time
p=pathlib.Path(sys.argv[1]);expected=('post-idle '+sys.argv[2]+'\n').encode();print('ready',flush=True);deadline=time.monotonic()+90
while True:
 try:value=p.read_bytes()
 except FileNotFoundError:value=b''
 if value==expected:break
 if time.monotonic()>=deadline:raise RuntimeError('Post-idle save deadline expired')
 time.sleep(.02)
print(hashlib.sha256(value).hexdigest(),flush=True)`
	idleCommand := hideCommandWindow(exec.CommandContext(ctx, sshExe(), append(f.transport.baseArgs(), "python3 -B -u -c "+shellQuote(idleObserver)+" "+shellQuote(m.ServerPath+"/wan-save.txt")+" "+shellQuote(manifest.RunID))...))
	idleOutput, err := idleCommand.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := idleCommand.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if idleCommand.Process != nil {
			_ = idleCommand.Process.Kill()
		}
	}()
	idleReader := bufio.NewReader(idleOutput)
	if line, _ := idleReader.ReadString('\n'); strings.TrimSpace(line) != "ready" {
		t.Fatal("post-idle observer was not ready")
	}
	idleBody := []byte("post-idle " + manifest.RunID + "\n")
	idleSaveStarted := time.Now()
	if err := os.WriteFile(canary, idleBody, 0600); err != nil {
		t.Fatal(err)
	}
	idleAck := make(chan string, 1)
	go func() { line, _ := idleReader.ReadString('\n'); idleAck <- line }()
	select {
	case line := <-idleAck:
		sum := sha256.Sum256(idleBody)
		if strings.TrimSpace(line) != hex.EncodeToString(sum[:]) {
			t.Fatal("post-idle save bytes differ")
		}
	case <-time.After(90 * time.Second):
		t.Fatal("post-idle automatic save did not converge")
	}
	evidence["afterIdleSaveMs"] = float64(time.Since(idleSaveStarted).Microseconds()) / 1000
	if err := idleCommand.Wait(); err != nil {
		t.Fatal("post-idle observer exit", err)
	}
	if result := syncProjectWithEmptyConfirmationContext(ctx, m.ServerPath, ""); result["ok"] != true {
		t.Fatal("post-idle real product sync", result["error"])
	}
	// Real index/rules changes, renames and deletions retain the ordinary product
	// path; this safety phase is measured separately from automatic save latency.
	safetyStarted := time.Now()
	forced := filepath.Join(m.LocalPath, "private-generated", "force.txt")
	if err := os.MkdirAll(filepath.Dir(forced), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(forced, []byte("force tracked canary\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := gitOutputContext(ctx, m.LocalPath, "add", "-f", "private-generated/force.txt"); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(m.LocalPath, "packages", "pkg000", "src", "file00000.txt")
	renamed := old + ".renamed"
	if err := os.Rename(old, renamed); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(m.LocalPath, "packages", "pkg000", "src", "file00001.txt")); err != nil {
		t.Fatal(err)
	}
	if result := syncProjectWithEmptyConfirmationContext(ctx, m.ServerPath, ""); result["ok"] != true {
		t.Fatal("scale safety native sync", result["error"])
	}
	safety := `import pathlib,sys
p=pathlib.Path(sys.argv[1]);assert (p/'private-generated/force.txt').read_text()=='force tracked canary\n'
assert (p/'packages/pkg000/src/file00000.txt.renamed').is_file() and not (p/'packages/pkg000/src/file00000.txt').exists() and not (p/'packages/pkg000/src/file00001.txt').exists()
assert not (p/'node_modules').exists();print('force-track-rename-delete-security-pass')`
	if output := f.remote(t, "python3 -B -c "+shellQuote(safety)+" "+shellQuote(m.ServerPath)); output != "force-track-rename-delete-security-pass" {
		t.Fatal("scale safety proof missing")
	}
	evidence["safetyPhaseMs"] = time.Since(safetyStarted).Milliseconds()
	evidence["forceTrackRenameDeleteIgnoredPass"] = true
	sessions := assertScaleSession(t, ctx, m)
	evidence["finalSyncStatus"] = sessions[0].Status
	evidence["successfulCycles"] = sessions[0].SuccessfulCycles
	evidence["passed"] = true
	t.Logf("PASS actual WAN scale files=%d cold=%vms save_p50=%vms save_p95=%vms idle_cpu=%v%% evidence=%s", manifest.TrackedFiles, evidence["coldImportMs"], evidence["saveP50Ms"], evidence["saveP95Ms"], evidence["remoteAgentCpuPercentOneCore"], manifest.EvidencePath)
}

func assertScaleSession(t *testing.T, ctx context.Context, m *Mapping) []syncSession {
	t.Helper()
	sessions, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil || len(sessions) != 1 || !sessions[0].Alpha.Connected || !sessions[0].Beta.Connected || sessions[0].LastError != "" || len(sessions[0].Conflicts) > 0 || !syncSessionHasDynamicGitPolicy(sessions[0]) {
		t.Fatal("actual scale session is not healthy", err)
	}
	return sessions
}

func scaleRemoteAgentStats(t *testing.T, f *productVPSFixture) []map[string]any {
	t.Helper()
	home := f.manifest.AllowRoot + "/tools/home"
	agent := home + "/.mutagen/agents/" + workspaceSyncEngineVersion + "/mutagen-agent"
	worker := `import json,os,pathlib,sys
agent,home=sys.argv[1:];rows=[]
for item in pathlib.Path('/proc').iterdir():
 if not item.name.isdigit():continue
 try:
  if os.readlink(item/'exe')!=agent or os.readlink(item/'cwd')!=home:continue
  fields=(item/'stat').read_text().rsplit(')',1)[1].split();rows.append({'pid':int(item.name),'startTime':fields[19],'ticks':int(fields[11])+int(fields[12]),'rssBytes':int(fields[21])*os.sysconf('SC_PAGE_SIZE'),'clockTicksPerSecond':os.sysconf('SC_CLK_TCK'),'exe':agent,'cwd':home,'uid':item.stat().st_uid})
 except (FileNotFoundError,PermissionError,ProcessLookupError):continue
print(json.dumps(rows))`
	output := f.remote(t, "python3 -B -c "+shellQuote(worker)+" "+shellQuote(agent)+" "+shellQuote(home))
	var result []map[string]any
	if json.Unmarshal([]byte(output), &result) != nil || len(result) != 1 {
		t.Fatal("exact owned remote agent evidence missing")
	}
	return result
}

func scaleWindowsStats(t *testing.T, engine string) []map[string]any {
	t.Helper()
	script := fmt.Sprintf("$target='%s'; $selfPid=%d; @(Get-CimInstance Win32_Process -Filter \"Name='mutagen.exe' OR ProcessId=$selfPid\" | Where-Object { $_.ProcessId -eq $selfPid -or $_.ExecutablePath -eq $target } | Select-Object ProcessId,CreationDate,ExecutablePath,KernelModeTime,UserModeTime,WorkingSetSize) | ConvertTo-Json -Compress", strings.ReplaceAll(engine, "'", "''"), os.Getpid())
	out, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil {
		t.Fatal("private Windows process evidence", err)
	}
	var rows []map[string]any
	if json.Unmarshal(bytes.TrimSpace(out), &rows) != nil || len(rows) < 2 {
		t.Fatal("private native/daemon process evidence incomplete")
	}
	return rows
}
