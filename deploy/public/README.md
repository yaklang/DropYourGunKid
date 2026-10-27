# 公网蜜罐部署（不启用二进制）

这是对公网开放的合成 DYGK 蜜罐配置。它不包含客户端二进制、不提供 `/gateway-check`、不启用 `clientChallenge`，也不挂载宿主目录或 Docker socket。

## 风险先读

- 这是**故意脆弱**的合成服务，账户和业务数据全部编造，不能替换成真实数据。
- 公网开放会记录来源 IP、请求路径、蜜罐交互和封禁；开放前按所在地法律做隐私与安全评估，准备好滥用联系方式、日志保留和下线流程。
- 默认 `quarantine` 模式会在首阶段有效蜜罐提交后把来源隔离到合成后台，不直接封禁；请求数、时间和来源数量都有上限。需要旧行为时显式设置 `DYGK_MODE=block`，但共享 NAT/代理可能影响无关用户。
- 不要把 `app` 端口发布到公网；只暴露 Caddy 的 80/443。
- 不提供任何真实凭据、真实 API Key、第三方目标或外联能力。

## 结构

```text
Internet -> Caddy (TLS, 80/443) -> app:4181 (internal network, read-only)
```

- `app` 只连接 `appnet`（internal），无外网；数据在 `dygk-data` 卷。
- Caddy 同时连接 `appnet` 和 `edge`；`app` 的 `TRUSTED_PROXIES` 固定为 Caddy 的 `172.30.0.10`，否则所有请求会被当成代理 IP。
- `trace:false`；没有客户端二进制、没有 challenge、没有 `/gateway-check`。
- 默认 `quarantine`，隔离 1800 秒、每来源最多 240 次假后台请求；事件保留 7 天，最多 5 万条。

## 启动

```sh
cd deploy/public
cp env.example .env
# 编辑 .env：PUBLIC_HOST 指向已解析到本机的域名；ACME_EMAIL 为证书通知邮箱
docker compose up -d --build
docker compose logs -f caddy app
```

放行 80/443/TCP 和 UDP 443；不要发布 4181。首次访问应通过域名完成 TLS 签发。

## 运维

- 事件和 SQLite 在 `dygk-data` 卷：`docker compose exec app ls -l /data`；不要提交原始事件。
- 重置实验：`docker compose down && docker volume rm dygk-public_dygk-data` 后重新启动。
- 下线：停止 compose、撤销 DNS、按隐私策略删除卷和 Caddy 日志。
- 监控：`docker compose logs`；对 429、封禁量、磁盘和异常请求做告警。
- 速率限制/DDoS：Caddy 默认不做细粒度限流；建议在 Cloudflare 或前置 Nginx 做 per-IP 限制。若加 CDN，必须同时配置 Caddy 的可信代理与 app 的 `TRUSTED_PROXIES`，否则封禁会落到 CDN 地址。
- `admin/admin123` 是合成站点的故意弱口令，不是可复用的真实凭据。

## 不包含

客户端二进制、`experiments/`、`artifacts/`、SSH 诱饵、真实业务数据、宿主挂载、Docker socket、外联代理。研究用的二进制挑战代码仍在仓库历史中，但不在本镜像、不由本配置启用。
