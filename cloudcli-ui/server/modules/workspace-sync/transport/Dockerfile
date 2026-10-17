FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends openssh-server ca-certificates bash git python3 util-linux tar \
    && rm -rf /var/lib/apt/lists/* \
    && passwd -d root

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/chisa-sync-entrypoint
RUN chmod 0755 /usr/local/bin/chisa-sync-entrypoint

EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/chisa-sync-entrypoint"]
