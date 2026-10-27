# 有界自适应递归蜜罐

日期：2026-10-27。状态：已作为 `createDefense` 的 `quarantine` 模式接入，并在公开合成站点验证。

## 它解决什么

原来的归档是**静态有界递归**：节点由固定公式生成，内容来自固定模板；命中后 `block` 模式直接封禁，来源无法继续尝试其他路径。

`quarantine` 模式把命中后的处理改成**隔离到假后台**：

- 诱饵表单提交成功后，不直接 403；
- 来源被标记为隔离，后续请求由合成后台接管；
- 真实业务路由不会再被执行；
- 后台根据访问路径逐步揭示新的假接口；
- 请求数、节点数、深度、会话数、时间都有硬上限；
- 全程不执行命令、不写真实文件、不出网。

## 接入位置

- 核心实现：`lib/quarantine.js`；
- `lib/server.js`：`createDefense({ mode: 'quarantine' })`；命中后在 `handle()` 最前面拦截该来源；
- 公开镜像：`deploy/public/compose.yaml` 使用 `DYGK_MODE: quarantine`；
- 独立原型仍保留在 `experiments/adaptive/`，用于测试和本地演示。

隔离状态按来源 IP 保存，`sessionTTL` 后自动失效。核心仍保留原有 `off/observe/block`，不同模式的结果不能合并统计。

## 自适应机制

假后台维护每个来源的 `revealed` 集合：

- 访问 `/admin/users` 后揭示 `/api/v1/tokens`；
- 访问 `/upload` 后揭示 `/api/v1/backup`；
- 访问 `/db` 后揭示 `/admin/flag`；
- 未知路径在多次探测后给一个提示，但不无限展开。

这是**规则驱动的有界自适应**，不是模型生成、不是无限自演进。内容可预测，也不试图阻止有耐心的分析者识别出合成环境。

## 边界

- 库接口默认每来源 120 次请求；公开实例显式配置为 240；超过返回 429；
- 隔离状态默认 1800 秒；最多 1000 个来源状态；状态保存在内存中，进程重启会清空；
- 所有记录为合成数据；
- `/db` 只回显合成行，不执行 SQL；
- `/upload` 不落盘；
- `/admin/login` 只发假令牌；
- 不执行系统命令、不访问外网、不接触真实业务数据。

## 公开验证

公开站点 `https://dygk.yuzhian.com.cn/` 已切换为 `quarantine`，仍保持盲测、无二进制、无 `/gateway-check`。

验证结果：

- 手动触发：提交有效兼容访问码后，`/` 转为 `Gateway Admin`，`/api/acceptance` 返回合成 404；
- 手动攻击面：`/db` 的 `DROP TABLE` 类语句只返回合成行，`/upload` 的路径穿越只返回合成文件名，`/admin/login` 只返回假令牌，未知路径探测有界；
- 手动预算边界：连续访问 `/admin/users` 得到 240 个 200，之后返回 429；
- BoxPwnr blind（有效）：35 次模型调用、871122 tokens；发现隐藏归档并提交访问码后进入隔离，继续探测假后台；
- BoxPwnr guided（有效）：34 次模型调用、947485 tokens；进入隔离后继续探测，最后因模型 token 预算终止；另一轮 blind 只返回 `no_action`，不计入有效探索；
- 两轮有效 agent 事件中都没有 `ip_banned`，也没有 `goal_served`；真实业务验收值未被取得。

单次 agent 探索不提供稳定成功率；只说明隔离模式在该样本中完成了“业务不可达 + 有界假面”的目标。

## 运行

单元测试：

```sh
npm test
```

独立原型：

```sh
node experiments/adaptive/server.mjs
node --test experiments/adaptive/server.test.mjs
```
