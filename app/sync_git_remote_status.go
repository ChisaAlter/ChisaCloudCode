package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// The replica synchronizes HEAD and index, not refs/remotes. Git reads use the
// owning local repository's upstream observation, bound to that exact HEAD.
type localGitRemoteStatus struct {
	Head         string  `json:"head"`
	Branch       string  `json:"branch"`
	HasRemote    bool    `json:"hasRemote"`
	HasUpstream  bool    `json:"hasUpstream"`
	RemoteName   *string `json:"remoteName"`
	RemoteBranch string  `json:"remoteBranch,omitempty"`
	Ahead        int     `json:"ahead"`
	Behind       int     `json:"behind"`
	IsUpToDate   bool    `json:"isUpToDate"`
	Message      string  `json:"message,omitempty"`
}

func readLocalGitRemoteStatus(ctx context.Context, m *Mapping) (*localGitRemoteStatus, error) {
	repository, err := localGitRepository(ctx, m.LocalPath)
	if err != nil || !repository {
		return nil, err
	}
	git := func(args ...string) (string, error) {
		return gitOutputContext(ctx, m.LocalPath, append([]string{"--no-optional-locks"}, args...)...)
	}
	branch, err := git("symbolic-ref", "--quiet", "HEAD")
	if err != nil && gitExitCode(err) != 1 {
		return nil, err
	}
	status := &localGitRemoteStatus{Branch: strings.TrimPrefix(branch, "refs/heads/")}
	if branch == "" {
		status.Branch = "HEAD"
	}
	remotes, err := git("remote")
	if err != nil {
		return nil, err
	}
	for _, remote := range strings.Fields(remotes) {
		status.HasRemote = true
		if status.RemoteName == nil || remote == "origin" {
			name := remote
			status.RemoteName = &name
		}
	}
	status.Head, err = git("rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		if branch != "" {
			if _, missing := git("show-ref", "--verify", "--quiet", branch); gitExitCode(missing) == 1 {
				status.Message = "Repository has no commits yet"
				return status, nil
			}
		}
		return nil, err
	}
	status.Message = "No remote tracking branch configured"
	if branch == "" {
		return status, nil
	}
	fields, err := git("for-each-ref", "--format=%(objectname)%00%(refname:lstrip=2)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:track,nobracket)", branch)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(fields, "\x00")
	if len(parts) != 5 || parts[0] != status.Head || parts[1] != status.Branch {
		return nil, fmt.Errorf("读取上游状态期间本地 Git 分支或提交已改变，请刷新源码管理")
	}
	if parts[2] == "" || parts[4] == "gone" {
		return status, nil
	}
	status.HasUpstream, status.RemoteBranch, status.Message = true, parts[2], ""
	remote := parts[3]
	status.RemoteName = &remote
	if parts[4] != "" {
		for _, count := range strings.Split(parts[4], ", ") {
			direction, text, found := strings.Cut(count, " ")
			value, parseError := strconv.Atoi(text)
			if !found || parseError != nil || value < 0 || (direction != "ahead" && direction != "behind") {
				return nil, fmt.Errorf("无法读取 Git 上游差异: %q", parts[4])
			}
			if direction == "ahead" {
				status.Ahead = value
			} else {
				status.Behind = value
			}
		}
	}
	status.IsUpToDate = status.Ahead == 0 && status.Behind == 0
	return status, nil
}
