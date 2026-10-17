#!/bin/sh
set -eu

mkdir -p /run/sshd
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
