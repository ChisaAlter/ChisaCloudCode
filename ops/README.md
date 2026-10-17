# 运维工具

这里提供自部署时使用的备份、端口限制和 systemd 配置示例。先按自己的部署修改路径、网卡、端口与资源限制，再安装；服务端容器部署见 [部署说明](../deploy/server/README.md)。

## 备份与恢复

`backup.py` 需要 Python 3.12 或更新版本。复制 `backup.example.json`，将 `sources` 和 `sqliteDatabases` 改为实际目录；每个数据库必须属于一个备份源。配置文件设为 `0600`，备份目录设为 `0700`，并放在所有备份源之外。

```sh
python3 backup.py backup --config /etc/chisacloudcode-backup.json
python3 backup.py verify --snapshot /var/backups/chisacloudcode/data/<snapshot>
python3 backup.py restore --snapshot /var/backups/chisacloudcode/data/<snapshot> --to /srv/restore-check
```

恢复目标必须不存在。根据恢复目录中的 `source-map.json` 核对来源，验证数据库与工程文件后再安排切换，不要覆盖正在使用的数据。备份包含账号资料、会话和工程内容，应保持私有。

SQLite 使用在线备份；普通文件在复制前后检查变化。这不是跨文件的原子快照，需要一致状态时先暂停写入。外部符号链接与特殊文件会单独记录，不在恢复时自动激活。失败的 `.partial` 不算成功备份；默认保留同一组源目录的最近 3 份成功快照。

定时备份可参考 `chisa-data-backup.service` 和 `.timer`。安装前核对脚本、配置及备份路径，并先完成一次独立恢复检查；用 `systemctl status chisa-data-backup.service` 查看结果。

## 限制后台端口

`restrict-backends.sh` 只拒绝指定公网网卡进入的 TCP 8791、8792、18091、18092，保留其他端口及内网流量。若部署端口不同，先修改脚本。确认 HTTPS 网关、SSH 与工作区同步入口不依赖这些公网端口后再应用。

```sh
sudo sh restrict-backends.sh apply <public-interface>
sudo sh restrict-backends.sh rollback <public-interface>
```

持久化可参考 `chisa-private-backends.service`，将 `PUBLIC_INTERFACE` 改为实际公网网卡。应用后从外部检查受限端口不可达，并确认 HTTPS 登录、WebSocket 与同步仍正常；保留现有 SSH 连接作为回退入口。

## 资源与权限

`cloudcli-resource-limits.conf` 和 `cloudcli-sandbox.conf` 是 API 服务的 systemd drop-in 示例。先核对模型任务峰值、HOME、数据目录及 Docker 访问需求，确认无活动任务后再重启服务。回退只移除本次安装的 drop-in，执行 `systemctl daemon-reload` 后按需重启。

这些限制不能把 rootful Docker 管理权限变成宿主隔离。Docker 容器应单独设置资源与权限边界；不要直接套用与当前部署不符的服务配置。
