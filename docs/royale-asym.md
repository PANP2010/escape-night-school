# 非对称大逃杀 v1 · A0 定稿（iter #63）

这是后续 A1–A7 的实现合同，尚未实现或实测平衡；源码路径均相对 game/（任务清单相对仓库根目录），数值标「沿用」或「设计值」说明依据。战役规则不变。

## 阵营与人数表

H 是开局在线人类数，监管槽含 AI；AI 不占 MAX_PLAYERS_ROYALE=8 的连接名额（shared/constants.ts:13）。正式局 H=5–8；H=2–4 为同规则练习局，不计成绩；H=1 不可开始，方便至少双端真实验收。
| H | 角色074槽 | 值周生槽 | 人类监管满额时学生数 | 全员选学生时学生数 |
|---|---|---|---|---|
| 2–4（练习） | 1 | 0 | H−1 | H |
| 5 | 1 | 0 | 4 | 5 |
| 6 | 1 | 0 | 5 | 6 |
| 7 | 1 | 1 | 5 | 7 |
| 8 | 1 | 1 | 6 | 8 |
5–8、7 人增加副监管沿用框架；练习人数是设计值，用于小队试玩及双端验收。学生无 AI，AI 补监管最多 2 个，故最多 10 个活动角色。
选角意愿为 student / warden / monitor / any，默认 student。先按人类 id 排序，以 seed 的独立 roles 随机流洗牌；依warden、值周顺序，先抽对应意愿，再抽 any，余下全是学生。无候选就 AI 补位，不强迫学生；无值周槽时选 monitor 者回学生。相同 seed、名单、意愿必须复现。
开局冻结学生名单 S，N=|S|，中途加入只观察，不改阵营、N 或箱数；沿用 allowLateJoin 和连接上限。监管槽用稳定 actorId，controllerId 为人类 id 或 null；一个槽永远只出一个身体，不能同时生成原 AI。
断线沿用 server/reconnect.ts:7 的 15 s 保留：学生留原地且可被抓，期限及罚站继续，到期记 left 出局；监管立即同位置切 AI，15 s 内恢复原控制，之后由 AI 打完。不能借续接刷新冷却、保护或复活。

## 胜负条件

只按开局学生 N 和最终逃脱 E 计算：2E>N 学生胜，2E=N 平局，2E<N 监管胜；无个人名次，不因监管断线或只剩一个学生提前判胜。
| N | 学生胜所需 E | 平局 E |
|---|---|---|
| 1 / 2 / 3 / 4 | 1 / 2 / 2 / 3 | 无 / 1 / 无 / 2 |
| 5 / 6 / 7 / 8 | 3 / 4 / 4 / 5 | 无 / 3 / 无 / 4 |
学生状态单向流转：playing → down → playing，或 playing/down → out，playing → escaped；left 算未逃脱。escaped/out/left 是终态，逃脱后不再回来救人。
全体学生终态才结算；即使已经过半逃脱也继续救剩余队友。无可救人的站立学生时，剩余 down 立即 out；保留期内离线 playing 仍算潜在救援者，最多等其剩余 15 s（沿用战役全倒原则，绝不重开本局）。
未通电到 480 s 判未逃脱者 out；通电时刻 T 的撤离截止 D=min(T+120 s,600 s)，截止时其余学生全 out。设计上限 8 分钟修复＋2 分钟撤离，满足框架 8–12 分钟节奏目标；允许成功或团灭提前结束，不强迫等满 8 分钟。
每 tick 先判断整局修复/撤离截止（tick≥截止即结束），否则依次救援/修复完成、过门逃脱、抓获、罚站/圈外超时、全倒及结算；同 tick 到门优先于被抓，沿用 room.ts:2649 的终章原则。结算只发一次，冻结输入；名单含阵营、escaped/out/left、倒地次数和总用时，沿用当前返回大厅/清续接入口。

## 三个角色各自的能力 / 速度 / 视野表

| 角色 | 速度与能力 | 视野与发现规则 | 依据 |
|---|---|---|---|
| 学生 | 蹲 1.8、走 3.4、跑 6.0 m/s；满耐力跑 5 s，非跑 4 s 回满，耗尽恢复至 0.15 才再跑；修箱、开门、躲藏、救学生 | 第一人称垂直 FOV 75°，眼高站 1.6/蹲 1.0 m；冻结值周按下述 40 m 规则 | 沿用 constants.ts:7–18/32、stamina.ts:4、client/src/game.ts:185 |
| 角色074 | 人类恒速 3.8 m/s、无冲刺/耐力；AI 巡逻 1.4/调查 1.9/追击 3.8；主动 E/手机「抓」，成功后原地停 3 s；不受罚站或圈外淘汰 | 第一人称 FOV 75°、眼高 1.88 m；人类正常看场景，不把 AI 视锥当相机遮罩。AI 视距 14 m/全角 150°，近 2.5 m 全向，垂差≤2.5 m且 LOS | 速度/眼高/感知/停顿沿用 ai/warden.ts:9–34/262；镜头沿用现有相机 |
| 值周生 | 未被看 7.8 m/s，被看 0；无冲刺/耐力；接触自动抓一人，成功后停 4 s；不受圈外淘汰 | 第一人称 FOV 75°、眼高 1.6 m；在线 playing、未躲藏学生在 40 m 内，全角 110°视锥含头/胸/膝任点且 LOS 就冻结；倒地、逃脱、监管、观察者不算观看者 | 移速/停顿/视距沿用 ai/monitor.ts:7–24/46；人类镜头沿用学生规格 |
监管难度倍率固定 1，关闭战役形态调速/导演干预；不是战役“初见”的 0.8（difficultyModes.ts:14）。3.4<3.8<6 符合框架；学生跑 5 s＋走 4 s 平均约 4.84 m/s，warden不能保证直线耗尽耐力追上，修箱停留与绕路才创造抓获机会。
共同抓取：水平距离≤0.8 m、脚底垂差<1.5 m、墙/关门 LOS 通；仅目标 playing 且无保护可抓。warden还需面向目标全角 90°（设计值，防背身抓），失败不消耗 3 s 成功停顿，但请求限 5 Hz（设计值，足够单次按键，防连续请求堆积）。
值周冻结时禁抓且可转头；取消 royale 自动眨眼（战役原为每 20 s 黑 0.2 s），以明确的「被注视」状态反馈取代黑屏偷袭。多人接触每 tick 只抓一人，按距离再 id 排序；其余距受害者≤3 m且同层学生保护 3.5 s，沿用 room.ts:154/2615 的完整救援窗口。
罚站原地不能移动/互动/冻结值周，30 s 未救出局；仅站立学生可救学生，身体包围盒外≤2 m、垂差<1.5 m且 LOS，长按 3 s。松开、离距、遮挡、断线或续期超 12 tick=0.6 s 清零；获救保护 5 s，不能抓但仍可注视。以上沿用 room.ts:150–169/945/1189 与 interact.ts:5，并补阵营/LOS。
warden的噪声提示沿用 noise.ts:5：蹲 0/走 4/跑 12/门 8/物品 15 m，隔墙半径×0.5；手电暴露用 warden.ts:32 的 14 m/全角 44°＋LOS。人类warden只收可感知的事件发生点、保留 2 s（设计值，短记忆而非实时透视），AI 沿用调查；不加 L4 全图点名。
双方只获得 40 m 内且 LOS 的敌方位置（设计值，与值周观察上限一致），不按相机朝向裁掉侧后方；躲藏学生不发敌方位置。自己及同阵营位置保留；终态学生及中途 observer 均锁学生观看权限，只收在线存活学生视野的敌方并集，无存活学生则不发敌方位置，不能自由飞行探敌。状态名单公开但不含敌方坐标；离开可见集立即清模型/插值，重新出现给完整关键帧。
AI 值周也只从 40 m/LOS 的未躲藏学生选目标，丢失就巡逻，不沿用原 AI 全图最近玩家透视。warden追丢沿用 ai/warden.ts 的 6 s 最后位置调查；躲藏沿用 L1/L2 已有柜/桌点去重，仅安全柜可进，禁用战役占柜即罚站事件。

## 一局时间线

| 时刻（设计值，服务器 20 TPS） | 行为 | 数值依据 |
|---|---|---|
| 开始至 15 s | 全体禁抓；学生出生相隔≥25 m，监管距每名学生≥20 m；各端首次 ready/有效 input 后个人保护 10 s（边界另留 1 tick）；与全局禁抓取较晚、不相加，不推迟全局截止 | 沿用 royaleDistribute、OPEN_GRACE_S/SPAWN_CLEAR_M 与 server/spawn-ready.ts:4/21 |
| 15 s 至 T，最迟 480 s | 5 箱中修好任意 3 箱，每箱一人累计长按 60 s；进度保留，换人不清零，多人不加速 | 5 留 2 个替代点防守箱封死；总 180 人秒，60 s 是原 3 s 救援的 20 倍，产生可打断接触机会 |
| T 至 T+30 s | 立即通电开校门，可逃脱；仍用全校园圈并预告下一圈，D 同时确定 | 30 s 预告沿用罚站窗口长度，避免通电瞬间收圈杀人 |
| T+30 至 T+60 s | 圈心 (−2,45)，半径 160 m | 为图书馆等远点保留撤离距离，向南门收，不再随机选地标 |
| T+60 至 T+90 s | 圈心 (−2,0)，半径 85 m | 60 s 持续步行可走 204 m；逐步收向南轴，仍含出口 |
| T+90 至 D | 圈心 (−2,−8.5)，半径 35 m；D 时结算 | 末段留 30 s，近门绕行/救人；120 s 按步行可走 408 m，仍受障碍与追逐影响 |
修复前及首段圈心 (0,100)、半径 220 m（设计值，覆盖 ROYALE_AREA 所有角，最远约 189 m）；未通电不收圈，防必需箱被圈永久封死。圈外连续 20 s 直接 out，入圈归零，down 也计时；监管/终态不计。由现有 8 s 延长，给步行 68 m 或完整救援 3 s 留空间；圈不代替门锁，未通电过门不算逃脱。
五个箱锚点沿用 royale.ts 地标：A(−40,80)、B(40,80)、OFF(−20,130)、LIB(60,140)、GYM(−100,60)。各取距锚点≤20 m、|y|≤0.5 m、与校门内侧同可达分量的导航节点，按节点 id 排序后用独立 boxes 随机流抽一个；20 m 限域使地标可信，0.5 m 限定地面避免跨层误触。柜体侧置于该节点可交互范围，箱间≥25 m（复用出生间距），不挡路；候选不足就拒绝开局并报错，不静默生成死点。
箱沿用 L2 箱体、射线与 2 m/<1.5 m 判距/LOS，不需要拾保险丝；hold 超 0.6 s 未续期即停止累积，已有进度保留；每箱仅一人，冲突先到先得、同 tick 按 id。停止后任何学生能接续；完成不可破坏，通电后剩余箱停工。箱与状态全量由服务器下发，不让客户端从 seed 猜导航落点。
逃脱区沿用 L8.exit：(−2,0,−11)，半径 1.7 m、脚底垂差<1.5 m且 LOS；L8.finale.gate (−2,0,−8.5) 仅作引导点，不加载 L8 围栏/点名册。需扩展校园 nav 到门外出口并打开实际校门碰撞；监管不碰撞堵门，进入通电逃脱区先逃脱后判抓。

## 协议改动清单

没有服务端 `start` 消息：现有 `{t:'start'}` 是客户端命令，开局由 `room.started`＋`correct`＋`snap` 通知（protocol.ts:32/117）。所有新增联合、解析和接收校验一起改，战役不填 royale 字段。
| 方向 / 消息 | 精确增改内容 | 用途 |
|---|---|---|
| C→S 新 `royale-role` | `{preference:'student'\|'warden'\|'monitor'\|'any'}`；仅等待中本人可改 | 不让客户端指定实际角色 |
| S→C `room` / `players:PlayerInfo[]` | `royaleVersion?:1`；每人 `preference?`、`role?:'student'\|'warden'\|'monitor'`；`royaleActors?:{actorId,role,controllerId:number\|null}[]` | 大厅意愿、开局权威阵营、AI 槽归属；始终先 room 再 correct，保留 incarnation/c |
| C→S `input` / `act` | input 形状不变，按角色/冻结/停顿验权；act/door 增可选 incarnation/c，v1必须填且校验（释放取消允许陈旧纪元，仅清本人hold）；act 新 `catch`、`royale-repair`、`royale-repair-cancel`，id 为目标人/箱；复用 revive/revive_cancel、door、hide/unhide | 监管不得拾取、修复、救援；学生不得 catch；所有交互使用当前 incarnation/c 和本人身份门闸 |
| S→C 新 `royale-state` | `{revision,phase:'repair'\|'escape'\|'complete',elapsedMs,remainingMs,escapeDeadlineTick:number\|null,need:3,boxes:{id,p,progressMs,workerId:number\|null}[],members:{id,role?,status,downs}[]}`，status 为 playing/down/escaped/out/left/observer | 开局/加入/恢复/变化发全表；进度每 5 Hz（设计值，200 ms反馈足够且少于20 TPS），deadline 绝对 tick 防漂移 |
| S→C `snap` / `PlayerSnap` / `MobSnap` | 沿用 st/downUntil/escaped/sta；v1 zone 加 `shrinkCount:3`、`next:{center,radius}\|null`、`outRemainingMs?`（三次南移，next由服务器下发，不再用旧seed推圈），alive 只计未终态学生（含 down）；`hiddenPlayers:number[]`/`hiddenMobs:number[]` 清可见集；监管 MobSnap 加 `controllerId`、`frozen`、`lockUntilTick` | 玩家监管只画对应监管骨骼，不画学生；AI/人类共用 actor。snap/恢复全表按接收者过滤，进入可见集强制关键帧，不共用全房 delta 缓存 |
| S→C 新 `royale-sense` | `{kind:'noise'\|'light',p:Vec3,untilTick}`，仅发有资格感知的角色074操控者 | 发事发点而非目标当前坐标；2 s=40 tick 到期删除 |
| S→C `caught` / `team-caught` / `activity` | caught 复用 by/at/source/hold=30；team-caught 和活动仅学生同阵营；resume 恢复 downLeft，不重演抓获 | 统一warden/值周/玩家/AI 的罚站呈现与救援 |
| S→C `royale-eliminated` / `royale-settle` | v1 删除 rank/ranking；淘汰为 `{id,reason:'caught-timeout'\|'unrescuable'\|'zone'\|'left'\|'deadline',remainingStudents}`；结算为 `{winner:'students'\|'supervisors'\|'draw',escaped,totalStudents,elapsedMs,members:{id,name,role,status,downs}[]}` | 固定分母、名单和阵营结果；重复结算幂等；旧名次协议只留给未切换的旧局 |
观战者不是参赛角色，仅 observer 允许 role 缺省且 members.status=observer，不得补进学生分母。restart 当前仅战役终章可用，v1 继续沿用「返回大厅→新建房间」，按钮写「返回大厅再来一局」，不伪造可原房重开。

## 与现有代码冲突及替代方案

| 框架/直觉 | 现状证据 | v1 替代 |
|---|---|---|
| 全校园追逃、尽量复用 AI | room.ts:713 仍裁成 L1 的 65 节点（当前全图 4069）；spawnMonitor 也按关卡数量生成 | royale 用完整可达图及校园门状态，按监管槽生成；门外出口补导航，战役裁图不变 |
| 学生有救援机会 | warden在 room.ts:2641 直接 royaleEliminate，值周在 :2624 却 punish；:1122 按最后生还判名次 | 全部抓获统一阵营罚站；学生集合与监管槽分开，不调用旧排名和战役 beginFade(true) |
| 监管可由玩家扮演 | :1992 统一按学生跑速预算，prey/canCatch 无阵营，:2683/:2721 同包广播全房坐标 | 角色移动预算、阵营门闸、可见集/提示私发必须落到服务器，不能只换模型和 HUD |
| 原样复用救援/冻结 | revive 没有 LOS；monitor.ts:112 冻住仍能触碰抓，且接触未查墙 | 增加 LOS；冻结禁抓、仅站立学生可冻；取消 royale 眨眼，战役原语义不改 |
| 收圈向校门并保留修箱 | royale.ts:6 为60 s宽限/每段60 s，4分钟终圈，中心随机，圈外8 s出局；校门本身在校园 nav 外 | 修复期全图安全，通电后固定南移圈和2分钟撤离，圈外20 s；接通门外导航/物理，不移用L8整关 |
| 复用 L2/L4/L8 | L2 是3枚保险丝即时装入单箱；L4有全图位置暴露；L8含专属围栏、点名和追逐结算 | 只借箱体/交互、柜桌、校门外形和逃脱区；新写小型royale状态机，不移用剧情锁、全图点名或结算逻辑 |
开发切片 A2–A6 先只在绑定的 developerMode royale 房启用 royaleVersion=1；普通房沿用现有玩法，避免半套规则上线。A6 收尾完成角色、目标、救援、结算和私有快照验收后，新建 royale 默认 v1；已开始的旧局不迁移。A7 只做观感，不能成为功能可读性和手机可操作性的前置。

## 后续切片与验收边界

A1 全校园 AI 导航；A2 分配/大厅/可见集分轮；A3 先罚站救援公共闭环，再warden移动/抓取/模型分轮；A4 箱生成、修复、校门、缩圈分轮；A5 阵营结算与结果页分轮；A6 值周控制、AI接管与默认启用分轮；A7 纯 HUD 观感。具体可执行验收在 loop-codex/todo.md。
本轮仅文档，以源码逐项核对和 npm run check 验证既有树；没有新逻辑/界面，因此不新增 Vitest、截图或录像，不以设计数值宣称真实对局已验证。后续每个切片必须先真实 build/浏览器复现，联机至少两独立 context，动作录像 10–20 s 交 Gemini，画面截图亲看。
