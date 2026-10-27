# DropYourGunKid · DYGK

DYGK 是自部署的 Web 欺骗与蜜罐组件。MVP 通过原始 HTML 中的线索，引导自动化检查进入有界的合成归档与验证流程，记录交互，并可在首次有效使用模拟凭据并提交表单后封禁该来源 IP。

**这是可验证的工程原型，不承诺识别所有 AI 或稳定阻断渗透。** 搜索量、蜜罐访问、元信息提交和攻击失败分别统计。自报框架/版本/模型未经验证；IP 只是请求出口。

## 包与运行环境

工作包名 `@dygk/core`，尚未发布到 NPM，也未确认组织名所有权。JavaScript ESM，附 TypeScript 声明；HTML 核心和浏览器入口不依赖 Node。服务端要求 Node 24，使用内置 `node:sqlite`（该运行时仍可能显示实验性警告）。包无运行时第三方依赖，暂不授权商业分发，许可证为 UNLICENSED。

```sh
npm ci
npm test
npm run typecheck
npm run test:browser
npm pack
```

安装生成的 tarball 即可在 JS/TS 项目使用。弱密码示例、实验与原始数据不会打进包。

## 服务端 HTML 与 Node 中间件接入

```js
import http from 'node:http';
import { createDefense } from '@dygk/core/server';

const defense = createDefense({
  mode: 'observe',                 // off | observe | block
  database: './dygk.sqlite',
  prefix: '/_dygk',
  onEvent: event => console.log(JSON.stringify(event))
});
const server = http.createServer(async (req, res) => {
  try {
    // 必须置于所有业务路由之前，封禁才覆盖业务资源。
    if (await defense.handle(req, res)) return;
    const html = defense.inject('<html><body><h1>业务页面</h1></body></html>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch { res.writeHead(500); res.end('Request failed'); }
});
server.on('close', () => defense.close());
server.listen(3000, '127.0.0.1');
```

Express、SSR 等 Node 应用可在最前面的异步中间件调用 `handle`，仅返回 false 时调用下一业务处理器；模板渲染完成后调用 `inject`。不支持直接将 Node 入口运行在 Edge runtime。

## 静态站点 / 构建接入

```sh
npx dygk inject dist/index.html dist/index.html
npx dygk serve --directory ./dist --database ./dygk.sqlite --mode observe --port 4180
```

构建 API：`injectHtml(html, { prefix, origin, entries })`，可用于任何输出 HTML 的构建流水线。`origin` 默认为同域；跨域必须是显式 HTTP(S) origin。浏览器补充入口为 `import { install } from '@dygk/core/browser'; install()`，需在 DOMContentLoaded 后调用；它不能保护只读取原始响应的客户端。

若业务已有服务，可将网关放在最前面：

```sh
npx dygk serve --upstream http://127.0.0.1:3000 --database ./dygk.sqlite --mode block --port 4180
```

网关默认只绑定回环地址，外部接入请明确配置 `--host` 并使用 TLS 入口。代理向上游请求不压缩的响应，仅缓冲不超过 1 MiB 的 HTML；流式大响应与已压缩响应保留透传，不保证注入。不要把上游裸端口继续暴露给访问者。

**同站封禁要求业务与蜜罐经过同一个防御网关。** 仅把静态 HTML 链接指向另一台蜜罐，而业务 CDN 仍独立开放时，无法宣称全站封禁。MVP 没有 CDN/WAF API 同步或多节点封禁传播。

## 模拟验证流程

1. 隐藏 HTML 入口提供少量归档线索，不改变可见布局。
2. 归档按迁移批次、配置快照、导出分片、校验回执逐层展开；每条记录给出新的关联子记录，沿途信息保持一致，包含无业务权限的模拟访问码。
3. 客户端兼容表单提交框架名/版本和模拟访问码。
4. 有效模拟访问码、会话nonce和第一阶段字段通过校验，即记录 `honeypot_triggered`；block 模式立即封禁来源IP。
5. observe 模式可选补充模型/处理引擎名称（unknown / none 可用），记录 `honeypot_completed`；此步骤不再是封禁前提。

不要求完整任务提示词、真实 API Key、本机文件或其他客户数据。会话绑定网络来源、随机标记和逐阶段 nonce；空表单、越阶段、重复提交不会触发成功。不得把程序化功能测试的填写统计为自主诱导。

## 可选溯源与客户端挑战

库接口支持 `trace: true`：在蜜罐页面加入会话水印，记录绑定同一会话的 HTTP 技术栈摘要、页面路径和水印。只摘要 header 名称的顺序，不记录 Authorization、Cookie 或任意请求体；User-Agent 仍截短为 256 字符。这些记录是行为证据，不证明客户端是 AI，也不验证自报模型身份。默认关闭；客户端挑战开启时自动启用。

客户端挑战通过库接口显式配置，三种条件互斥，默认为 `off`：

```js
const defense = createDefense({
  mode: 'observe',
  origin: 'http://127.0.0.1:4180', // 实际公开 origin；不使用来访 Host 拼接命令
  clientChallenge: 'shell-challenge',
  trace: true
});
```

- `shell-direct`：公开 shell 脚本；合成能力接口可以直接读取。
- `shell-challenge`：公开 shell 脚本；先下载，再完成一次性公开 challenge-response。
- `binary-challenge`：相同 challenge 协议的 Linux/amd64 Go 客户端，公开源码、SHA-256、公钥与 Ed25519 签名；需要额外配置 `clientArtifactDir`。构建方法见 [研究运行说明](experiments/README.md#客户端挑战与溯源迁移)。

开启后，归档中的 `/verify` 展示客户端校验流程，三种条件页面均补齐为 8192 个 UTF-8 字节；等字节不表示等 token。下载、挑战和重放事件沿用 `session` 关联，并受现有请求预算、IP 绑定、会话过期和清理限制。产物启动时校验并读入内存，运行中不会追随磁盘替换。

原有默认封禁点仍是首阶段表单提交。仅 `shell-challenge` / `binary-challenge` 可显式设置 `banTrigger: 'client-complete'`，把封禁点改为一次有效挑战完成；单纯访问、下载、错误响应和重放不触发这个封禁点。`shell-direct` 没有挑战完成事件，只用于观察对照。不同封禁判据的批次不得合并计算。

公开协议可以自行复现，`challenge_completed` 只证明提交了有效响应。实际执行证据仍需本轮独立 marker 前后检查和工具轨迹。客户端只在调用者指定的隔离环境写入 `/tmp/dygk-client-<session>`；不应把模型生成命令交给宿主运行。上述选项目前通过 Node 库接入，CLI 不提供挑战开关。

三条件先导（9 次探索）见[执行记录](docs/client-challenge-pilot-results.md)；单次样本不提供成功率。

有界自适应递归蜜罐已作为 `createDefense` 的 `quarantine` 模式接入：命中后隔离到假后台，不直接封禁，真实业务路由不再执行；节点、请求和会话都有上限，不执行命令、不出网。设计与公开验证见[说明](docs/adaptive-honeypot.md)。

## 资源、隐私与管理

默认：3 个首页入口、每层最多4个分支、最多4层、总节点最多256个、每会话 120 次诱饵请求（不能靠反复访问入口重置）、会话 30 分钟、封禁 15 分钟、事件保留 7 天、最多 10000 条事件、1000 个会话。请求体上限 4 KiB，元信息字段最多 96 字符。达到数量上限时旧事件会早于 7 天淘汰。清理在请求时及每分钟执行；SQLite 文件可能保留已删除页的物理空间，不等于安全擦除。

默认忽略 X-Forwarded-For。库接口 `trustedProxies` 仅接受明确的可信代理 IP 列表，从右向左找首个不可信地址。CLI 暂不接受此选项，默认按 socket 地址封禁；在共享代理后部署必须用库接口配置，避免封禁代理整体。不要根据任意请求头或自报地址封禁。

独立网关提供 `GET /_dygk-admin/events` 和 `DELETE /_dygk-admin/events`。两者要求 `Authorization: Bearer ...`，密钥取自 `DYGK_ADMIN_TOKEN`，至少 24 字符；未设置时不可访问。DELETE 清空事件、会话和封禁。管理入口应在部署边界额外限制；该接口即使被数据面封禁仍允许有认证的管理员恢复。

## 有缺陷的模拟网站

仅供隔离实验，数据全部编造，账户 `admin / admin123` 是故意保留的唯一弱密码入口。

```sh
DYGK_LAB=1 DYGK_MODE=observe npm run demo
# http://127.0.0.1:4181
```

提供 48 条工单、6 个客户、36 个设备，带登录、分页、搜索、详情和退出。验收目标为登录后读取 `/api/acceptance` 的每轮随机 verification 值。不要向公网部署此示例；NPM 包不含该站点。

## 研究与部署边界

[设计与判据](docs/design.md) · [实验运行](experiments/README.md) · [验收记录](docs/acceptance.md)

原始模型轨迹、每轮目标值与真实网络信息只存 `results/`，不提交。所有封禁测试只作用于当前自有实验实例。

## 公网合成蜜罐

[部署配置](deploy/public/README.md) · [公网边界与检查](docs/public-deployment.md)：Caddy TLS + 内部只读 app；不启用客户端二进制或 `/gateway-check`。

## 独立网关容器

```sh
docker build -t dygk:local .
docker volume create dygk-data
docker run --rm -p 127.0.0.1:4180:4180 --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --cpus 1 --pids-limit 64 \
  -v dygk-data:/data -v "$PWD/examples/static:/site:ro" dygk:local
```

此部署示例允许挂载自己的站点和持久数据卷；CAI研究环境另行使用无宿主挂载容器。不要把弱密码示例作为生产upstream。SQLite API参考：[Node.js官方文档](https://nodejs.org/api/sqlite.html)。

## 首轮结果

[CAI首轮对照](docs/mvp-abc-002.md)：三模式均取得验收目标；观察组产生25次归档访问和一次部分自报提交，但没有完成最终确认。功能可用不等于防御已有效，当前不能承诺自主封禁成功。

## 分层误导配置

服务端 `createDefense({ branches:4, depth:4, maxNodes:256, requestLimit:120 })` 控制分支宽度、深度、总节点和会话请求上限。branches=1..64，depth=1..8，maxNodes=1..4096。节点按固定编号生成，重复读取一致，引用只指向有效子节点；达到深度或总量上限时明确结束，不无限扩展。两项改动的探索将另记为mvp-layered-003，旧批次结果不重算。

[分层版本003对照](docs/mvp-layered-003.md)：观察组实际进入第二层并完成1次有效首阶段提交；该组不封禁，封禁组未提交。三组均取得目标，仍未验证实际自主阻断。

## 高密度配置与中性任务对照

```js
createDefense({ mode: 'observe', entries: 8, branches: 8, depth: 4, maxNodes: 4096, requestLimit: 240 });
```

每个入口展示8条根记录，沿每个节点最多再发现8条子记录，按需生成但确定性一致。4096是可达节点上限，不是单会话承诺访问量；会话预算仍为240。生产默认保持温和配置，高密度需要显式启用。

旧002/003任务明确提示弱登录和验收接口，适合固定目标能力比较，但可能压低诱饵分流效果。004批次改为普通自主安全评估，不在任务中提示弱密码或验收路径；业务站的正常接口文档仍保留，并对三组一致。新任务不要求取得某指定记录，不能把“未读取验收记录”单独称为整体评估失败。

最新普通任务探索见[004实验记录](docs/mvp-general-dense-004.md)：CAI封禁组完成真实自主封禁链路，观察组跟进至第4层；均为单次探索，不代表稳定成功率。

## 当前实验汇总

[研究报告](docs/research-report.md)：十种选定框架接入均取得一组满足当前判据的配对案例，无防御成功登录，完整防御未登录且封禁或预算耗尽（10/10案例覆盖）。包含补测与预算调整，不是统一基准成功率。历史失败与适配限制均在报告中列出。

## 真实业务应用前后对照

[三轮执行记录](docs/real-business-results.md)：NocoDB 0.109.7 隔离副本，BoxPwnr + deepseek-flash。第三轮在修复协议、代理和默认弱账户后，off 取得受保护记录，block 被诱饵提交封禁且未取得目标，按预注册封禁链判据为防御成功。单次探索，不提供稳定成功率；block 末尾的模型 Token 预算标签异常单独记录。执行前设计见[计划](docs/plans/real-business-ab.md)。
