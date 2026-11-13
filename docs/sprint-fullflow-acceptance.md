# 八关验收与发布接线交接

产品基线仍为 `57a05ea537a25f9ac470c98dc863aa58601e3b40`（v040、L1–L4）；恢复工具从 `1775298d8a269eac8f8b987dc3137c490d86999b` 更新至最后实跑的 `26d1e7a`，当前验收工具仍未完成L1–L4全流程。本任务仅增加测试工具与报告，未修改产品、todo、loop、共享依赖或其他工作树。已完整阅读 design.md 94 行、todo.md 596 行及 **41 路** manifest；本树及父目录未发现适用 AGENTS.md。release-audit 记录运行时清单、实际 HEAD 与 hash，主树及 L5–L8 开发树均只读。旧桌面通过日志属于历史，本轮最新结果见文末独立 run，不能混用截图或覆盖失败。

用户新要求优先于历史 design/todo：约35岁、更高大、慢而清楚的怪异动作；只准低沉动森嘟囔；手机直接点物体；镜中看到值日生背后空档才能拿钥匙；新增被抓/罚站过场；可见更新通知；最终由集成代理部署。本报告不声称内容已经上线。

## 可执行入口与覆盖边界

在本树 game/ 中运行：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run typecheck
python3 tests/run-sprint-fullflow.py --chapters 4 --mode desktop
python3 tests/run-sprint-fullflow.py --chapters 4 --mode mobile
python3 tests/run-sprint-fullflow.py --chapters 4 --mode both --list
node tests/fullflow/release-audit.ts
node tests/fullflow/release-audit.ts --require-eight
# L5–L8正式合入后；缺关会在分配浏览器前明确失败
python3 tests/run-sprint-fullflow.py --chapters 8 --mode both
```

runner 自带 `gate browser`，固定4436，独立 config 同时覆盖 webServer/baseURL/outputDir，reuseExistingServer=false。只有一个 Chromium 进程，desktop/mobile context 串行；Metal renderer 有实际断言，headless 参数含 `--mute-audio`，Playwright 仅管理自己启动的服务器。每次实跑先分配 `game/test-results/sprint-fullflow/runs/<UTC时间+pid>/`；可用 `--run-id <唯一名字>`，已有目录直接拒绝。run.json 在开始/结束复核 HEAD、dirty、选定源码/工具文件及 dist/dist-server 全部普通非 symlink 文件 hash，保存命令、时间和 exit；`headChanged` 或 `changedInputs` 会使原成功结果变为非0，同时保留原 `commandExitCode`。源码及产物稳定仍不证明构建同源，`buildProvenance` 保持 `unverified`。异常/中断也保存终态，runner 仅向自己创建的子进程组发送清理信号；Playwright detached 后代可能留存，仍须核实本 run 自有的4436 PID。run.log、results、artifacts 和 authority-journal 都在该 run 下；八关预检也先分配目录再执行，不覆盖旧结果。默认不录视频，未作 Gemini 外部评分，不提交生成产物。

每条 campaign 必须全程保留唯一一条普通 `/ws`，结束断言前不得关闭；每关同时核对房间 code、seed 与 player id 连续，不能换页面或另建房间续测。连接创建/关闭计数写入 authority-journal；独立重连专项仍需另测。截图会解码原始 WebGL 图和保存后的 PNG，自动检查可见像素与亮度，拒绝黑图/空白图后才记录证据；人工仍须实际查看截图。

工具已兼容 L1 难度切片的真实 `drawer_key` 前置拾取，并排除 decoy；若产品仍为 v040 则走原钥匙链。ready 等待 spawnSynced、presentationReady 和 intro 结束，记录 cinematic 的 intro/clear 事件，避免把过场冻结误当移动失败。两项均是适配器就绪；本树产品没有 drawer/cinematic，尚不能称这些新增分支实跑成功。

默认是**谜题与接线验收**：L1–L7显式记下 debug safe(mob1/mob2) 的隔离范围，L8不发送safe，避免无关随机抓捕掩盖路线 bug；L2 使用 debug monitor 定向布置怪物，但 freeze→run→freeze 都由真实服务器 AI 判定。不是自然难度、首次目击频率或导演节奏达标证据。`--natural-threats` 关闭 safe，可作另一次难度试跑。自动导航仅操纵现有 autopilot/输入方向，正常胶囊碰撞和20Hz真实 WebSocket仍生效；每段要求 correction 不增加并比较服务端位置。测试明确禁止 debug tp/key/level 替代通关；也不写客户端背包/门锁/谜题成功状态。它会读关卡坐标和权威 nav，不能替代“只看 HUD 新手引导”验收。

手机测试创建 hasTouch/isMobile 的844×390 context，投影真实 item mesh、配电箱 Group、贴纸与键盘屏幕后 tap 到 canvas，并检查投影在镜头内且未被 UI 控件遮挡；**不会退回互动按钮冒充直接点击物体**。本基线没有 worldTouch 接线，因此这里应保留失败，等待独立手机交互提交集成。另已只读确认 escape-mobile-interaction 和 escape-sprint-l7_campaign 的 `touchTarget()` 都未包含 hides，`onWorldTouch` 在 `!hit` 时直接返回；即使合入物品点击接线，L4 直接点柜子仍缺产品实现。工具要求真实柜子 tap 发送 hide，保留此失败；退出藏身状态可以使用已有互动按钮。

## 八关检查点

|关卡|必须完成的真实动作|权威证据|状态/覆盖边界|
|---|---|---|---|
|L1|远距伪拾取被拒→步行取门钥匙→实际开对应锁门→若有真实drawer_key先拾取→取楼梯钥匙→出口|items/snap.gone、keys、bag、snap.doors open且unlocked、fade→L2|排除decoy；目标门接近路径保留门板碰撞，靠近后普通移动保持closed/locked，再真实E或tap；v040无drawer分支|
|L2|值日生被看冻结/离视冲刺/重看冻结→走进教室取3保险丝→逐根插箱→出口|mob2.anim及位置、gone、bag.fuse 3→0、power 0→3、fade→L3|定向机制，不证明自然遭遇频率；没有debug发保险丝|
|L3|真走错门重置→步行穿循环接缝→按303/301/304/302穿门→出口|loop个人step/mistakes、warp/epoch、不增加非forced correct、fade→L4|单人全流程；已有 x-l3-loop/x-l3-four 专门覆盖多人个人进度，不能以单人替代|
|L4|自然60–90s点名→进屏蔽柜→退出→步行跨真实楼梯读四贴纸→错码拒绝→实际数字键停播→走下楼集合|broadcast.call.shielded且无p、clues、error、off=true、fade|四关模式接受当前内容complete或同房L5 ready；分别报告结果，不能冒充八关结算|
|L5|真实篮球绊倒→实际面板高度处操作4开关→锁门开放→出口|gym-sound trip/本人trips持续1.3–1.5s、until−now为18–20s、complete、两个monitor、fade→L6|按真实panel y+1.25接近/点按，非开关地面坐标；多人5s窗口仍需L5多客户端专项；未在本树运行|
|L6|步行读4F/5F公告→真实纸面投影打开UI→选5题→错交卷10s停电→改答交卷→出口|逐题answer带当前revision且权威+1；submit revision、blackout.floor/seconds、cooldown、tick跨度≥10s−1tick、passed|先读可见线索再按题意选择，不读question.correct；手机点击真实公告/试卷投影；未在本树运行|
|L7|镜看不冻结/直看冻结→等待背包钥匙真实可见窗口→取钥匙→推两镜门→楼梯/出口|key.open/taken、guard.watched/yaw、keyHitTarget、mirror-key/push、mirrors phase、openDoors、fade→L8|手机须命中反射钥匙mesh，且东转暴露背包（−sin(yaw)>.78）；仅open或点整面镜子不能通过；未在本树运行|
|L8|取点名册→划全队名→OFF出楼/室外/校门持续追击→结算|finale阶段、gate前所有采样target=本人、怪物移动>100m、无非forced correct、completed统计与HUD|累计用时/倒地保留入L8前基数，成员本人escaped；结算后再等25tick确认统计冻结；未在本树运行|

`--chapters 8` 是发布目标。四个新关适配器已写入，缺关/协议缺失会明确失败，不skip、不伪造统计。当前树仍是v040，仅能运行L1–L4产品。L5–L8适配器来自开发树契约的只读核对，必须由集成树重跑并按最终commit复核，不能把类型检查通过当八关通关。

## L5–L8只读检查与合并顺序

恢复后多次只读复查（各树仍在开发；必须按最终提交重审）：

|迁移树|观察到的状态|证据与集成注意|
|---|---|---|
|escape-sprint-l5|HEAD `c565808`，本轮复核无tracked diff|只注册L1–L5；保留gym-switch/gym/gym-sound、真实panel位置与trip deadline，拿完整最终增量|
|escape-sprint-l6|HEAD `da6b9a5`，本轮复核无tracked diff|仍是独立exam preview：LEVELS仅L1–L4，L6_INDEX=5特判不是L5→L6接线；合并时连续注册并保留gym出口条件|
|escape-sprint-l7|HEAD `f74c1ac`，本轮复核无tracked diff|仍是独立/l7.html、/ws/l7、L7Room和另一套协议，不能替代普通房间L6→L7→L8|
|escape-sprint-l7_campaign|HEAD `01bde2f`，room.ts/l7.ts/测试/handoff仍有WIP|普通/ws、主Room/Game、t:l7、mirror-key/push与live镜门碰撞/导航；须按最终提交重审WIP，手机柜子hide仍缺|
|escape-sprint-l8|HEAD `a8a7259`，本轮复核无tracked diff|保留regions联合区域、finale.rollcall/route、completed统计；依赖主线L7正常出口，不能靠缺位clamp注册八关|

独立L7的 `debug tp {p}`、take-key/push 与主流程 `debug tp {x,z,floor,c}`、act、snap.mobs/doors/gone、forced correct/epoch不兼容。切独立页面/新房会丢失队伍、seed、倒地统计和重连会话；本工具只采用L7_campaign的普通/ws契约，不拿独立预览成功冒充主线连续通关。

建议增量顺序：L5→L6→L7主房间接线→L8，再叠加公共大厅/重连/过场/捕获/导演的最小接线。每次保留已存在分支并确认 parseClientMsg、Room.handle、Game.receive、target/use、exitOpen/loadLevel 都同时识别前面已合的关卡。不得整分支重放旧树。

## 跨路 shared 与生命周期冲突

- shared/level.ts 的 LEVELS 必须连续恰为L1…L8。现generateLevel用Math.min越界clamp；缺位时可能以错误index装出L4，不可凭HUD“第8关”认定注册成功。L6独立index例外必须清除/合并，L8 regions/inBounds与L5 gymStandBoxes、L7镜门collider都要保留。
- shared/protocol.ts / levels/def.ts / interact.ts 是L5/L6/L8和public_lobby/reconnect/cinematic共改点。保留BroadcastClientMsg/parseBroadcast、loop/warp/correct.c/ack/forced；L5 gym-switch、L6带revision的exam消息、L8 rollcall/restart/completed不得互相覆盖。
- server/index.ts 由reconnect、public_lobby、L6、L7共同修改。L7 noServer upgrade分流必须保留普通/ws以及opaque重连身份绑定/限频，预览启动标志在production必须无效。不能让新的create路径绕开公开私密语义或令旧room泄漏。
- room.ts 的advanceAt/loadLevel/step/prey/exit与cinematic/capture/director都交叉。intro冻结期间不能消耗考试冷却/篮球窗口、不能误判全灭；clear仍3s；单次caught不能被每个snap重播。L7与L8的存活者全员集合应排除观察者但在下关复活他们。
- Game的loadLevel必须清理broadcast/exam/gym/mirror/finale弹窗、输入禁用和触屏指针，避免关卡切换后无法移动；保留现有audio/transitions/updateNotice接线。settings弹窗不能截走手机worldTouch事件。
- 新增blackout_lifecycle专项处理同seed wipe的声音恢复：普通名单room刷新不应重置，而真正新episode不能因loadLevel早退保留静音或transitioning。team_feedback/teaching_clarity又增加protocol/room/main接线；须保留捕获本人单份提示、队友真实活动来源及昵称textContent路径。
- clock_monotonic专项针对积压snap的SnapClock倒退真反例；不可由旧interp或动画提交覆盖其单调时钟修复。safe_sighting需要全队视锥与LOS安全，且不得抢L4广播或L8终章控制；本工具的NPC隔离模式不能证明这两项自然体验。
- mobs.ts有monitor_animation、L8 perfect、Warden模型专项重叠；不能由终章旧模型或旧clip覆盖新35岁/高大/慢清楚动作要求。
- 语音只准WebAudio嘟囔；测试静音仅防本机播放，不是听感合格证据。任何合并后出现speechSynthesis/SpeechSynthesisUtterance都应回查其是否运行路径，而非只看文字注释。

## 发布manifest与通知风险

- 当前 `client/public/version.json` 是0.4.0，只宣称L4。Vite define把它嵌进JS并原样拷到dist/version.json；必须在最终八关真实集成后再更新可见entries和id，不能先宣称八关上线。source/dist/远端version.json都要一致，且旧客户端60s轮询应看到**不同id**才触发“新版本已上线”。只改entries而不变id不会触发旧局提示。
- `1775298` 的release-audit改用AST核对真实定义/协议/接线和版本schema，检查客户端引用资产与服务端bundle非空，并记录hash；`buildProvenance`仍明确为`unverified`。hash和version相等不能证明构建同源；AST只识别本仓约定，不证明行为。最终树须重新build并保存源码commit/dirty及日志；若等价模块抽取导致检查拒绝，应更新适配器并保留验收条件，不能删断言放行。详见 `docs/sprint-fullflow-release-review.md`。
- `stage-green.ts:33` 当前仅依据CLAUDECODE阻止中途check写.green；独立Codex环境通常不带该标志。不要让各lane运行完整npm run check；已遵守用户要求只由集成代理串行。发布应保存最终commit、clean状态、client/server资产hash、registry、逐套测试日志，不把“worker finished”当上线。
- `verify-deploy.ts`只比对index.html引用的JS/CSS，无法证明server内存是同一commit、L7可通或version说明正确。部署后还需远端/healthz、首页资产、/version.json、真实create/start和最终关路径冒烟；生产环境debug必须拒绝，不能拿开发tp探针测公网。
- manifest41路里面没有主Warden、独立mobile interaction、l7-mirror-key等外部专项的最终集成状态。release-audit仅列出本树就绪缺口，不能穷举这些外部commit已被挑入；集成表必须显式列出这些提交，保留既有L1–L4、voice/audio/visual/update所有基线。新增video_acceptance负责正常帧率视频证据，本lane的nodraw谜题运行不能替代它。
- 本lane不部署，不读认证配置；部署由集成代理执行，并记录公网证据。

## 本轮恢复验证与历史证据

- 工具 `1775298` 已经heavy gate运行typecheck，session92723实际exit0，日志 `game/test-results/sprint-fullflow/recovery-1775298-typecheck.log`；最终工具 `26d1e7a` 的heavy-gated typecheck也实际exit0，日志 `recovery-26d1e7a-typecheck.log`。`runner --chapters 4 --mode both --list` 在1775298经browser gate实际exit0，识别desktop/mobile两个campaign，日志 `recovery-1775298-list.log`。本轮未重新build、未运行完整npm run check、未写.green。
- 11:43:27 UTC的AST八关预检实际exit1，独立报告在 `runs/release-review-parser-final/release-audit.json`：**11项issues**为注册仅L1–L4、缺gym/exam/l7/finale/completed快照、L7 parser/Room/Game三段接线、手机direct touch链与hide候选；source/built版本均0.4.0。真实开发树五类协议正向AST解析exit0，只证明适配器能识别当前契约，L5–L8与八关最终统计仍未在本树执行。
- **历史通过**：`desktop-final-run.log`保存工具`8f39ae5`、seed1855769412、session25256的`1 passed (5.2m)`记录，含同一/ws的L1–L4谜题链。它不能代表本轮HEAD或任意seed均通过；原先“7张截图齐全”已失效，现存只有5张旧通过检查点图，不能把旧日志和现存图拼为当前完整成功证据。
- **恢复前最新失败**：11:18:59 UTC开始、seed1280246796的桌面复验在L4自然点名/屏蔽后移动收到非forced correct，`ack=4431,c=8,p=[-33.24913873597018,7.2,129.74298367984667]`，`walk-authorized: rejected movement`实际失败。results、journal、失败图及5张旧检查点图已整体归档到 `attempt-20261105-111859-overwritten-failure/`；不能用上述历史pass覆盖这次失败。更早路径/站位工具失败保留在 `attempt-desktop-barrier/`、`attempt-both-standpoint/`。
- 手机最新真实运行仍失败：Metal、hasTouch、844×390下真实mesh投影tap后没有对应act pick，v040缺direct touch产品接线；未用互动按钮冒充通过，也未无故重跑为绿。L4柜子直点在参考主线树也缺hide候选，须随最终手机产品集成重验。
- **本轮桌面实际失败**：独立run `recovery-1775298-desktop`记录HEAD1775298、启动时tracked dirty为空、seed1605754449，11:47:41 UTC结束且exit1。完成L1两钥匙/真实E开锁/正常出口→L2、值日生freeze→run→freeze及前两根保险丝；第三根保险丝`[34.35,4.75,78.44]`被工具报`No reachable standing point within 2m`（交互目标y5.35）。全程0非forced correct/0页面错误，尚未到L4，不能称L4已修或当前四关通过。本次结果保留，run.json/run.log/results/artifacts都在该独立目录，4436已自动关闭。
- **L2工具根因已精确确认**：`recovery-1775298-exact-standpoint.log`重建seed1605754449、26个nav节点及已打开的门109–111；按物件中心半径≤2m搜索的原68个候选均被原`pathTo`拒绝。站位`(35.9056349186104,3.6,79.9956349186104)`距中心2.2m，但共享`boxAt(KEY_R=.35)`表面`inReach`仍≤2、客户端`rayTarget`命中`pick3`，且原`pathTo`成功，证实harness遗漏合法站位。最小修复给`approach`增加默认0的可选`itemBoxRadius`，仅L1/L2的pick调用传`KEY_R`，搜索`ACT_REACH+KEY_R`内的合法站位；未来generic props不扩圈，真实reach与0非forced correct要求保持。单独扩圈在下一run暴露实际到点精度问题，最后结合普通输入收尾验证了两处旧失败坐标；仍未证明四关通过，旧L4 correct问题仍未解决。
- **4603957桌面失败保留**：`runs/recovery-4603957-desktop/`在12:06:05–12:07:10 UTC运行，HEAD4603957、seed1975014007，exit1；L1首门钥匙`pick:2`的真实`rayTarget=null`，0非forced correct/0页面错误，未到L2或L4、无检查点截图。实际位置`[-20.0834,0,93.5924]`到钥匙`[-19.15,1.15,96.06]`盒表面距为2.196485m>2：autopilot的0.45m终点容差提前停下，证明扩圈内合法规划点不足以保证实际位置合法。后续26d1e7a仅用普通输入最后贴近站位，不写body、不放宽距离。该run的`headChanged=false`、`changedInputs=[]`，失败图仅为已亲看的nodraw黑底HUD定位证据。
- **最终桌面仍实际失败**：`runs/recovery-26d1e7a-desktop/`在12:12:55.507–12:15:25.512 UTC运行，HEAD26d1e7a、seed179126273、启动tracked dirty为空，`commandExitCode=exitCode=1`、`headChanged=false`、`changedInputs=[]`。L1全通过；楼梯钥匙恰在旧失败坐标`[-19.15,1.15,96.06]`，autopilot停下时target为空，普通输入收尾后真实pick/E成功并正常进入L2。L2值日生freeze→真实run移动→freeze通过，第一根保险丝恰在旧失败坐标`[34.35,4.75,78.44]`，普通输入收尾后真实pick/E成功。走向第二根时`walk`55s超时，路线`[[39.75,79.65],[42.75,79.75],[43.05,82.15],[43.05,83.25],[52.416644650470595,79.68720441845382]]`；卡在body`[43.8724,3.8,79.6872044235]`、routeAt5，server tick2924位置`[43.87,3.8,79.69]`，两者3D差0.003684m，门109–111已开未锁、107–108闭合未锁。全程0非forced correct/0页面错误，单一/ws未提前关闭，仅换入L2有forced correct；4436无listener，所属PID97989自退。尚未到L3/L4，当前验收工具未L1–L4全绿；此路径超时风险保留，停止追加追绿，不能称旧L4失败已解决。
- **最终八关runner预检实际失败**：`runs/recovery-26d1e7a-eight-preflight/`于12:16:26.290–12:16:26.614 UTC在申请浏览器前exit1，HEAD26d1e7a、启动tracked dirty为空、`commandExitCode=exitCode=1`、`headChanged=false`、`changedInputs=[]`，仍有11项结构/接线issues；较早4603957预检也独立保留。输入稳定不改变v040缺L5–L8及手机direct touch的结论，也不证明构建同源。
- 根代理与baseline_verify已亲自查看最终26d1e7a run的`l1-key-and-unlock`、`l2-monitor-freeze`与`test-failed-1`三图：前两张为实际渲染且HUD可读；失败图为nodraw黑底HUD，仅用于定位，不能当场景视觉质量证据。图片及journal/results/run终态均保留在该独立run；未录视频、未作Gemini外部评分。

本lane不录视频、不作Gemini外部评分、不部署。集成代理负责最终产品树八关桌面/手机复跑、正式全量闸门、更新用户可见version id/entries及公网验证/部署；本报告和脚本就绪均不是已部署证据。
