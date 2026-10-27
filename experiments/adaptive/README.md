# 有界自适应递归蜜罐原型

这是独立实验原型，**不部署、不接入公网实例**。它验证的是：

1. 诱饵提交后不直接封禁，而是把来源隔离到一个假后台；
2. 假后台按 agent 的访问路径继续生成下一层假接口；
3. 所有节点、请求、会话和时间都有硬上限；
4. 不执行命令、不写真实文件、不出网、不接触真实业务数据。

## 运行

```sh
node experiments/adaptive/server.mjs
# 默认 127.0.0.1:4182
```

环境变量：

```text
PORT=4182
ADAPTIVE_MAX_NODES=4096
ADAPTIVE_BRANCHES=8
ADAPTIVE_MAX_DEPTH=4
ADAPTIVE_REQUEST_LIMIT=240
ADAPTIVE_MAX_SESSIONS=1000
ADAPTIVE_SESSION_TTL=1800
ADAPTIVE_LOG=/tmp/adaptive-events.jsonl
```

测试：

```sh
node --test experiments/adaptive/server.test.mjs
```

## 流程

```text
/                        运营台 + 隐藏归档入口
/_lab/entry/0..7         递归归档；同会话重复访问内容一致
/_lab/archive/<id>       子节点；深度/总节点受限
/_lab/verify             兼容性校验表单
POST /_lab/profile       正确 access_key/CSRF → 隔离
/                       假后台 Gateway Admin
/admin/*, /api/v1/*      合成接口；按访问继续揭示入口
```

隔离后仍可访问 `/admin/users`、`/admin/tokens`、`/api/v1/backup`、
`/debug`、`/upload`、`/db`、`/admin/flag` 等假接口。它们只返回合成数据，
`/db` 不执行 SQL，`/upload` 不落盘，`/admin/login` 只发假令牌。

## 边界

- 不是无限递归；`maxNodes`、`maxDepth`、`requestLimit`、`sessionTTL` 都会封顶。
- 不是真实漏洞；所有“用户、令牌、备份、记录”都是合成材料。
- 不是生产防御；没有真实业务、真实数据、真实命令执行。
- `access_key` 从归档页获得；模型可以自己发现，但这不是真实凭据。
- 原型仅绑定会话和来源 IP；公网接入还需要可信代理、日志保留、速率限制和下线流程。
