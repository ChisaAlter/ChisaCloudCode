#!/bin/sh
# Only the four Chisa HTTP backend ports on the specified public interface.
# Keep HTTPS gateways, SSH, Docker networks and other applications unchanged.
set -eu
action=${1:-}
interface=${2:-}
case "$action" in apply|rollback) ;; *) echo 'Usage: restrict-backends.sh apply|rollback PUBLIC_INTERFACE' >&2; exit 2;; esac
case "$interface" in ''|*[!a-zA-Z0-9_.:-]*) echo 'Invalid public interface' >&2; exit 2;; esac
[ -d "/sys/class/net/$interface" ] || { echo 'Interface does not exist' >&2; exit 2; }
for command in iptables ip6tables; do
    command -v "$command" >/dev/null 2>&1 || continue
    if "$command" -C INPUT -i "$interface" -p tcp -m multiport --dports 8791,8792,18091,18092 -m comment --comment chisa-private-backends -j REJECT 2>/dev/null; then
        if [ "$action" = rollback ]; then
            "$command" -D INPUT -i "$interface" -p tcp -m multiport --dports 8791,8792,18091,18092 -m comment --comment chisa-private-backends -j REJECT
        fi
    elif [ "$action" = apply ]; then
        "$command" -I INPUT 1 -i "$interface" -p tcp -m multiport --dports 8791,8792,18091,18092 -m comment --comment chisa-private-backends -j REJECT
    fi
done
