# 有界自适应递归蜜罐原型

日期：2026-10-27。状态：独立原型，已通过本地测试；未部署，不接入当前公网实例。

## 它解决什么

当前 DYGK 的归档是**静态有界递归**：节点由固定公式生成，内容来自固定模板；命中后 `block` 模式直接封禁，agent 无法继续尝试其他漏洞。

本原型把命中后的处理改成**隔离到假后台**：

- 诱饵提交成功后，不直接 403；
- 来源被标记为隔离，后续请求进入合成后台；
- 后台根据访问路径逐步揭示新的假接口；
- 请求数、节点数、深度、会话数、时间都有硬上限；
- 全程不执行命令、不写真实文件、不出网。

## 自适应机制

假后台维护每个会话的 `revealed` 集合：

- 访问 `/admin/users` 后揭示 `/api/v1/tokens`；
- 访问 `/upload` 后揭示 `/api/v1/backup`；
- 访问 `/db` 后揭示 `/admin/flag`；
- 未知路径在多次探测后给一个提示，但不无限展开。

这是**规则驱动的有界自适应**，不是模型生成或无限自演进。

## 边界与判据

- 递归树最多 `maxNodes` 个节点、`maxDepth` 层；
- 每来源最多 `requestLimit` 次请求，超过返回 429；
- 隔离状态按来源 IP 和会话绑定，`sessionTTL` 后清理；
- 所有记录为合成数据；`/db` 只回显合成行，`/upload` 不落盘，`/admin/login` 只发假令牌；
- 不能用“假后台里请求很多”推断真实防御成功；需要和真实业务隔离验证分开记录。

## 与现有 DYGK 的关系

现有 `createDefense` 仍然是静态归档 + `off/observe/block`。本原型是独立实验，不改动线上 `dygk.yuzhian.com.cn`。若要把隔离模式并入 DYGK，需要新增 `quarantine` 模式、可信代理配置和来源路由，并重新做预检与冻结计划。

## 运行

见 [experiments/adaptive/README.md](../experiments/adaptive/README.md)。

```sh
node experiments/adaptive/server.mjs
node --test experiments/adaptive/server.test.mjs
```
