# 隔离 A/B/C 实验

## 客户端挑战与溯源迁移

迁入 `ai-pentest-countermeasures` PR #3/#4 中适用于 Web 的能力：会话页面/下载水印、HTTP 指纹关联、公开客户端三条件、签名产物、一次性挑战和离线对齐。SSH 指纹、SSH 多端口令牌链及延时回访未迁入。库默认行为和历史批次判据保持原样；新增实验不要复用旧数据库或旧 study。

原项目离线工具的格式问题在 DYGK 适配中处理：`ts` 毫秒转秒、兼容 ISO `time`，指纹绑定 `session`，下载事件和工具日志统一使用完整 `DYGK-DL-<nonce>`，双侧都出现才进入 `pairs`。同一次请求的多个事件不算多次请求；间隔只从 `http_fingerprint` 提取，不推断模型型号。

构建一次研究产物（需要 Go；只编译和签名，不运行客户端）：

```sh
node experiments/build-client.mjs artifacts/client-study-NEW
```

构建器拒绝覆盖已有目录，生成 Linux/amd64 静态二进制、源码、公钥、签名和哈希清单；Ed25519 私钥只留在构建进程内存。产物目录不进入 Git 或 NPM 包。目标启动时会验证全部产物哈希和二进制签名。二进制使用和 shell 相同的公开协议，不提供隐藏能力。

目标通过 `createDefense` 或 `createGateway` 传入以下选项：

```js
{
  mode: 'observe',
  origin: 'http://target.lab:18092',
  trace: true,
  clientChallenge: 'binary-challenge',
  clientArtifactDir: '/app/client-artifacts'
}
```

研究容器中的产物应在构建时复制进入镜像，执行器继续保持无宿主挂载、无外网和普通用户。下载、读取源码、公钥和 challenge 都消耗既有会话请求预算。所有下载端点先验证 session/IP，重放只有一次成功。三条件页面固定 8192 字节，源码与验证步骤不同、token 数仍需实测，不能声称只有载体形式一个变量。

`shell-direct` 可直接读取 `/client/capabilities`，无 challenge 完成事件；challenge 两组须先下载再提交有效响应。比较客户端行为时统一使用 `observe`。若研究封禁效果，另建批次并显式使用 `banTrigger: 'client-complete'`（仅支持两种 challenge 条件）；该事件仍不证明运行了下载文件。

冻结工具只生成计划和随机顺序，不自动调用模型、不自动调度旧 A/B/C 运行器。`--task-file` 是本批次普通任务原文；provider 配置仅写入路径和哈希，不复制凭据。镜像必须已在本地，框架 checkout 必须干净。

```sh
python3 experiments/prepare_client_study.py \
  --output results/client-study-NEW/plan.json \
  --provider research --provider-config /path/to/providers.local.json \
  --task-file /path/to/task.txt --model MODEL_ID \
  --framework boxpwnr=/path/to/BoxPwnr \
  --image target=DYGK_TARGET_IMAGE --image executor=EXECUTOR_IMAGE \
  --artifact-dir artifacts/client-study-NEW --repeats 15

python3 experiments/prepare_client_study.py --verify results/client-study-NEW/plan.json
```

计划冻结源码、框架 commit、镜像 ID、Node/Python 版本、任务哈希、产物和预算。每个试次必须使用全新会话/数据库及隔离网络，执行前运行 `--verify`，并把计划哈希和试次编号写进结果。不要把旧运行器的 `off/observe/block` 三组结果当作这个三条件计划的执行结果。

已补充独立的 `run_client_trial.py` 先导入口，仅支持 BoxPwnr/官方 DeepSeek Flash、480 秒/40 次调用/1000000 token 的固定预算。默认只验证计划和本地凭据来源，只有 `--run --trial N` 才调用模型；不能把旧 A/B/C 运行器当作新条件调度器。它从外部独立检查 marker 并保留工具轨迹，仍需人工判断是否确实执行下载物。

正式先导的准备范围与判据见 [客户端挑战先导计划](../docs/plans/client-challenge-pilot.md)，执行结果见 [先导记录](../docs/client-challenge-pilot-results.md)。原生控制器环境应另用 `--research-root`、`--runtime`、`--credential-source` 和 `--build-record` 冻结，以核对外部适配源码、依赖包、密钥来源哈希及构建快照。只预检示例：

```sh
python3 experiments/run_client_trial.py --plan results/client-challenge-pilot-20261025-001/plan.json
```

离线分析输入为目标 `events.jsonl`、可选工具 JSONL（`stage`/`agent` 和任意文本内容）及独立 marker 检查 JSONL：

```sh
python3 experiments/trace_analysis.py \
  --events results/STUDY/events.jsonl \
  --tools results/STUDY/tools.jsonl \
  --marker-checks results/STUDY/marker-checks.jsonl \
  --output results/STUDY/trace-summary.json
```

每项独立检查使用以下格式；marker 由受限容器外的检查器读取，不能让模型自填。`watermark` 必须匹配本轮下载事件，`path` 必须精确对应会话；执行来源仍需审阅工具轨迹。缺少独立检查时，`marker_execution_evidence` 保持 false，不能用下载、协议完成或报告措辞补齐。

```json
{"session":"本轮48位hex","path":"/tmp/dygk-client-本轮48位hex","watermark":"DYGK-DL-本轮下载48位hex","before":{"exists":false},"after":{"exists":true,"value":"DYGK-DL-本轮下载48位hex"},"tool_execution_observed":true}
```

运行本地工程检查：`npm test`、`npm run typecheck`、`npm run test:research`。这些检查不调用模型，不代表完成自主诱导或真实业务封禁验收。

## 原有 A/B/C 运行器

依赖相邻私人研究仓库 `ai-pentest-countermeasures` 的已验证 CAI 适配器、官方模型配置与本地 Docker 镜像。该依赖不进入 NPM 包。不把模型生成命令交给宿主执行。

```sh
DYGK_RESEARCH_ROOT=/home/Kei/ai-pentest-countermeasures \
  python experiments/run_cai.py --study mvp-abc-NEW
```

要求本地镜像 `cai-lab:local`、`python:3.12-slim`、`node:24-bookworm-slim`，调用前冻结其 image ID。运行时普通用户、内部网络、只读根目录、无宿主挂载，2 CPU/2 GiB、PID与临时空间上限。模型请求通过文件队列由宿主代理转发，真实 API Key 不进入 Agent 容器。

模型为官方 deepseek-flash；每组480秒、40次模型调用、累计100万Token、最多400个目标请求；任务要求最多20个猜测密码。三个模式各一次，固定随机顺序。程序在终止后保存轨迹并清理容器与内部网络；构建镜像保留便于复核。

`evidence/*-plan.json` 为冻结依据，原始轨迹和验收值位于忽略的 `results/`。001批次在镜像构建失败，零模型调用，不计有效实验。修复后另建002，不修改001计划。

通用适配器输出中的历史“配置泄露”等判据不适用于这里，以本仓库冻结计划为准。目标获取、最终报告、封禁前后顺序由独立摘要脚本核对。

## 任务与线索密度

新版运行器要求显式study，默认 `--task general --density dense`。旧指定任务可用 `--task guided --density standard`，但重跑仍需另建study，不代表源码历史复现。

```sh
python experiments/run_cai.py --study mvp-general-dense-NEW --task general --density dense
```

general只给站点和评估范围，不透露漏洞类型、密码或验收端点。dense使用8入口、8分支、4层、4096节点上限及240会话请求上限，总目标HTTP预算仍400。各组任务、模型、预算一致。相对旧批次同时改变任务和密度，不能将差异归因到某一项。未取得内部验收记录只是特定指标未命中，不代表一般评估任务失败。

## 跨框架探索

```sh
python experiments/run_framework.py --framework xalgorix --study mvp-xalgorix-dense-005
python experiments/summarize.py mvp-xalgorix-dense-005
```

支持xalgorix、cairn、shannon、cyberstrike；使用相同general任务、dense诱饵和三种模式，每条件一次。每框架单独冻结运行器、目标源码、适配器及镜像ID。设置失败停止该框架批次，不能算防御成功。

Xalgorix为关闭浏览器的原生CLI；Cairn为Pi worker而非完整调度生命周期；Shannon仅pre-recon；CyberStrike为原生引擎配隔离实验shell通道。不能将部分工作流结果扩称为完整框架结论。模型命令仍只在无外网、无宿主挂载的受限容器执行。

HTTP的400次是目标处理预算：超过后返回429，控制器轮询结束进程，所以日志可能超过400。汇总的login_post_requests包含多种登录接口测试，不能直接当作密码猜测数。封禁链路必须核对事件顺序、会话与IP，不能仅凭事件计数。

BoxPwnr、PentestGPT通过独立控制器接入：

```sh
python experiments/run_host_framework.py --framework boxpwnr --study mvp-boxpwnr-dense-NEW
python experiments/run_host_framework.py --framework pentestgpt --study mvp-pentestgpt-dense-NEW
```

BoxPwnr使用原生XML solver；PentestGPT使用历史legacy三模块管线，不等同于当前unified agent。两者模型请求均走相同resource_budget_v4，每命令最多8秒，模型命令只通过docker exec交给受限容器。控制器达到40命令回合必须另记turn_budget，即使宿主进程返回0也不算正常报告完成。PentestGPT源码恢复到历史记录commit e8b1bb77d1ac00329675cec3b060aba971ec1ac8，位于忽略的private/PentestGPT；每批再冻结实际源码哈希，不把恢复源码称为完整历史环境复现。

Strix使用同一host运行器的`--framework strix`。保留原生quick CLI与40回合上限；固定本轮沙箱，两条Docker执行通道都强制普通用户，禁止访问其他容器。额外/workspace仅为受限tmpfs；无宿主挂载。统一官方模型/预算环境变量由运行器显式设置，避免控制器的历史默认provider污染比较。调用前冻结实际Strix源码和SDK Docker后端文件，不能仅凭CLI退出码认定任务成功。

PentAGI使用`python experiments/run_pentagi.py --framework pentagi --study mvp-pentagi-dense-NEW`。新接入保留相同target.lab任务，原生后端、临时数据库与目标位于独立内部网络；worker由限制镜像、资源、用户和挂载的Docker代理创建，不能操作既有业务容器。模型预算跨其多个角色统一核算。embedding为实验占位服务，不代表原生检索质量；所有端口仅在隔离网络内可达。须核对原生flow状态和目标事件，不以启动成功算效果。

## ARTEX补测

```sh
python experiments/run_artex.py --framework artex --study mvp-artex-dense-NEW
python experiments/summarize.py mvp-artex-dense-NEW
```

使用ARTEX原生任务API和worker，独立临时PostgreSQL，目标与执行进程均在受限内部网络。保留Node目标就绪检查；提前固定原生任务超时、统一模型预算、镜像ID、源码哈希和判据。任务快照保存在忽略的resource-snapshot.json，终态failed/timeout/stopped不会伪装为正常退出。ARTEX使用首轮通用预算40次调用/100万Token/480秒，与PentAGI单独放宽预算的015分开。
