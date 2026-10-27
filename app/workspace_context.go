package main

import "time"

const serverRequestTimeout = 2000 * time.Second
const workspaceDeadlineHeader = "X-Chisa-Deadline-Ms"
