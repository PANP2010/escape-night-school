# 发布预检增量审查

release-audit增量修改 `game/tests/fullflow/release-audit.ts`、新增纯语法检查 helper `release-source.ts`，提交为 `1775298`；runner及站位工具随后更新至最后实跑的 `26d1e7a`，当前验收工具仍未完成L1–L4全流程。文档收尾同步维护主验收报告和本报告。未修改产品、构建脚本、todo、loop、其他工作树、凭据或依赖。本次完整读过 design.md 94 行、todo.md 596 行、运行时 manifest 334 行/41 路与恢复前主验收报告；本树及父目录、game/docs 下未发现适用 AGENTS.md。

原预检会把注释中的协议字样、单个 worldTouch 引用、名义上八个变量和相等的 version.json 当成就绪条件。现改用现有 TypeScript parser 读取 AST；只解析源码文本，不执行产品模块、生成器、服务或类型检查。检查连续注册及各关真实独立定义、实际 ServerMsg 联合分支与字段、L7 parser/Room/Game 接线、手机触屏事件到 hit-test/act 的链路，并单独拒绝缺少 hide 候选的柜子直点。版本记录校验实际 id/date/entries schema；八关版本必须换掉本基线 0.4.0 id，并明确说明第八关或最终通关内容，避免只改 entries 不触发旧客户端提示。

资产检查会确认首页引用的 JS/CSS 和服务端 bundle 存在且非空，并记录本次读取的 19 个源码文件 hash 与当前 15 个产物 hash/大小。**这些 hash、version 相等、文件时间都不能证明 dist/dist-server 来自当前源码或同一 commit。** 报告始终写 `buildProvenance: "unverified"` 和明确 warning；本切片未添加构建 receipt、发布批准或部署步骤。集成代理仍须在最终产品树重新 build，保存准确源码 commit、dirty 状态和构建日志，再验证真实运行中的服务端与客户端。

`--require-eight` 只对结构/资产 issues 返回非零；不带该参数仍是诊断报告模式。即使 issues 清零，也仅表示识别到当前仓库约定的静态接线形状，不证明八关可玩、移动端成功、构建同源、生产运行状态或已经部署。集成若抽取了等价模块而改变方法名或协议表示，应审查并更新检查适配器，保留原验收条件；不能为放行直接删除断言。

## 最新开发树与合并冲突

下表 HEAD 于 2026-11-05 11:40 UTC 只读复核；开发树仍可能继续变化，不能据此宣称已合入本树或已上线。

| 路线 | 已读取 HEAD | 必须保留/处理 |
|---|---|---|
| L5 | `c565808` | 当前本路仅注册 L1–L5；保留 gym-switch、GymSnap/GymSound、篮球 deadline 与出口权威。 |
| L6 | `da6b9a5` | 仍是独立 exam preview：LEVELS 仅 L1–L4，`L6_INDEX=5` 特判不能替代 L5→L6 连续主线；保留 answers/passed/revision 和错答 blackout。 |
| L7 独立预览 | `f74c1ac` | `/l7.html`、`/ws/l7`、L7Room 不能证明普通房间的跨关连续性。 |
| L7 主线 | `01bde2f` | 使用普通 `/ws`、主 Room/Game、`CampaignMirrorSnap t:'l7'`、`act mirror-key:0 / mirror-push:id`；room.ts/l7.ts/测试/handoff仍有WIP，最终提交须重审。`touchTarget()` 仍未提供 hide 候选，不能只凭 worldTouch 已接线宣称 L4 柜子直点成功。 |
| L8 | `a8a7259` | 保留联合 regions/inBounds、点名册 rollcall→chase→complete、finale/completed 的 elapsedMs/downs/members；依赖正常 L7 出口后同房间进入。 |

最短合并顺序是 L5 → L6 → L7 主线 → L8，再合公共大厅/重连及其他生命周期切片。`shared/level.ts` 最终必须恰好连续 L1…L8，不能用占位定义、越界 clamp 或独立 index 特判制造“第八关”。`shared/protocol.ts`/`levels/def.ts`/`interact.ts` 保留已有广播、loop/warp、correct 的 c/ack/forced，同时加入 gym/exam/mirror/finale；`server/index.ts` 保留普通 `/ws`、公开/私密房语义和重连身份绑定；`room.ts` 的 loadLevel/exit/step 保留各关权威条件、观察者下关复活和最终统计；`game.ts` 保留更新通知/声音/过场，并清理上一关弹窗和触屏指针。详细跨路风险沿用主验收报告，本报告不重复长历史。

## 本次实际执行

- 独立 `node tests/fullflow/release-audit.ts --require-eight` 于 **2026-11-05 11:43:27 UTC** 实际 exit 1；读取工具 HEAD `1775298d8a269eac8f8b987dc3137c490d86999b`，发现 **11 项**当前缺口：L1–L4 注册、五类后续快照、L7 parser/Room/Game 三段接线、手机 direct touch 事件链及柜子 hide 候选。source/built version 均为 0.4.0，本次无八关发布宣称。
- 输出独立保存在 `game/test-results/sprint-fullflow/runs/release-review-parser-final/release-audit.json`，日志为 `release-review-parser-final.log`；未覆盖旧 release-audit、截图或运行结果。`ESC_FULLFLOW_RUN_DIR` 可设置该目录，必须位于本树 `game/test-results/sprint-fullflow` 内；拒绝越界路径和其下的 symlink 转向。实际将路径指到相邻 `sprint-fullflow-outside` 时 exit 1，确认该目录未创建。
- 对上述真实开发树的协议文件仅作字符串读取和 AST 解析：L5 的 gym 字段 complete/balls、L6 的 exam 字段 answers/passed/revision、L7 主线 l7 的 mirrors/key/openDoors、L8 的 finale phase/members 与 completed elapsedMs/downs/members，均实际解析成功；检查进程 exit 0。L5/GymSnap 与 L7/CampaignMirrorSnap 的相对 type import 也被实际解析，没有把 imported type 名称当协议实现。
- release-audit子任务未运行浏览器、build、test 或 typecheck；baseline_verify对HEAD1775298执行的heavy-gated typecheck实际exit0/session92723，最终HEAD26d1e7a的heavy-gated typecheck也实际exit0，日志`recovery-26d1e7a-typecheck.log`。1775298的browser-gated `--chapters 4 --mode both --list`实际exit0识别两个campaign。L1 drawer/cinematic和L5–L8增强断言仅已适配，产品仍v040，不能据此说新增分支实跑成功。
- `recovery-1775298-desktop`，seed1605754449，11:47:41 UTC实际exit1：L1正常完成并进入L2，值日生freeze→run→freeze及两根保险丝完成，第三根`[34.35,4.75,78.44]`触发站位工具`No reachable standing point within 2m`；0非forced correct/0页面错误，尚未到L4。根代理亲看该run两张正常检查点图和一张nodraw失败图，后者仅供定位；4436已自动关闭，未录视频/未Gemini外评。
- L2已确认是工具漏选合法pick-box表面站位：`recovery-1775298-exact-standpoint.log`精确重建seed1605754449、26个nav节点及已开门109–111，中心半径≤2m的原68候选均被原`pathTo`拒绝；站位`(35.9056349186104,3.6,79.9956349186104)`距中心2.2m，共享`boxAt(KEY_R=.35)`表面`inReach`仍≤2且客户端`rayTarget`命中`pick3`，原`pathTo`成功。修复为`approach`可选`itemBoxRadius=0`，仅L1/L2 pick调用传`KEY_R`并搜索`ACT_REACH+KEY_R`内合法站位；generic未来props、真实reach和0非forced correct要求不变。下一run暴露实际到点精度问题，26d1e7a结合普通输入收尾才验证两处旧失败坐标，仍未证明四关通过或旧L4 correct已解决。
- **4603957桌面失败保留**：`runs/recovery-4603957-desktop/`于12:06:05–12:07:10 UTC运行，HEAD4603957、seed1975014007，exit1；L1首门钥匙`pick:2`的真实`rayTarget=null`，0非forced correct/0页面错误，未到L2/L4、无检查点截图。实际位置`[-20.0834,0,93.5924]`到key`[-19.15,1.15,96.06]`盒表面2.196485m>2，原因是autopilot的0.45m终点容差提前停；合法规划点不足以保证实际位置合法。后续26d1e7a仅以普通输入收尾，不写body、不放宽距离。该run的`headChanged=false`、`changedInputs=[]`；已亲看的nodraw黑HUD失败图仅供定位。
- **最终桌面实际失败**：`runs/recovery-26d1e7a-desktop/`于12:12:55.507–12:15:25.512 UTC运行，HEAD26d1e7a、seed179126273、tracked dirty为空，`commandExitCode=exitCode=1`、`headChanged=false`、`changedInputs=[]`。L1全通过；楼梯钥匙恰在旧失败`[-19.15,1.15,96.06]`，target最初为空，普通输入收尾后真实pick/E成功并正常入L2。L2 freeze→run真实移动→freeze及旧失败坐标`[34.35,4.75,78.44]`第一根fuse的收尾pick/E成功。往第二根时`walk`55s超时，路线`[[39.75,79.65],[42.75,79.75],[43.05,82.15],[43.05,83.25],[52.416644650470595,79.68720441845382]]`；body卡在`[43.8724,3.8,79.6872044235]`、routeAt5，server tick2924为`[43.87,3.8,79.69]`、3D差0.003684m；门109–111开未锁，107–108闭未锁。0非forced correct/0页面错误，唯一/ws未提前关闭，仅换入L2有forced correct；4436无listener，所属PID97989自退。尚未到L3/L4，保留该可复现路线超时风险并停止追绿，当前验收工具仍未L1–L4全绿，旧L4失败未解决。
- 根代理与baseline_verify亲看最终26d1e7a的`l1-key-and-unlock`、`l2-monitor-freeze`和`test-failed-1`三图：前两张实际渲染且HUD可读，nodraw黑HUD失败图仅定位；图片及journal/results/run终态保留在该run，未录视频或Gemini外评。
- **最终八关runner预检**：`runs/recovery-26d1e7a-eight-preflight/`于12:16:26.290–12:16:26.614 UTC在申请浏览器前exit1，HEAD26d1e7a、启动tracked dirty为空、`commandExitCode=exitCode=1`、`headChanged=false`、`changedInputs=[]`，仍为11项issues；旧4603957预检独立保留。输入稳定不能证明八关就绪或构建同源。
- 历史seed1855769412的通过日志与11:18 seed1280246796的L4失败必须区分；后者非forced correct为ack4431/c8，已归档至`attempt-20261105-111859-overwritten-failure/`。原7张通过图现仅存5张，不能把旧日志和现存图拼成当前完整成功证据。手机 direct touch 真实失败和八关预检失败保留，所有新结果引用独立run的run.json/run.log/results/artifacts。

## 集成代理的最短复验命令

以下仅是交接命令，本 lane 未执行构建、浏览器或部署。先在最终集成产品树的 `game/` 中保存最终 commit/dirty 状态，再执行：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
python3 tests/run-sprint-fullflow.py --chapters 8 --mode both
```

runner 会先分配唯一的 `test-results/sprint-fullflow/runs/<UTC时间+pid>`，设置 `ESC_FULLFLOW_RUN_DIR`，执行八关预检后才申请浏览器资源。run.json 在开始/结束复核 HEAD、dirty、选定源码/工具文件及 dist/dist-server 全部普通非 symlink 文件 hash；`headChanged` 或 `changedInputs` 会使原成功结果变为非0，原 `commandExitCode` 仍保留。输入稳定不能证明构建同源，`buildProvenance` 仍为 `unverified`。异常/中断会保留终态，清理只针对 runner 自建子进程组；Playwright detached 后代仍需核实本 run 自有的4436 PID。现有 `--run-id` 可显式命名且拒绝复用目录。独立诊断可运行 `ESC_FULLFLOW_RUN_DIR=test-results/sprint-fullflow/runs/<新名字> node tests/fullflow/release-audit.ts --require-eight`。最终正式全量闸门、用户可见 version id/entries、远端版本/资产/healthz/普通 create-start 与最终关路径验证及部署都由集成代理负责。
