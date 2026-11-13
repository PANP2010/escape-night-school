# QA02 实机视频与 #570 支撑相滑步取证

记录日期：2026-11-05。此文档只记录验收材料与证据边界；不修改产品、`todo.md`、旧 `loop` 评审脚本，也不表示部署或完整质量验收已经完成。

## 本次范围与取证口径

本次覆盖真实时间的桌面走/跑/追逐、手机横屏、双人互看移动与转弯/蹲起/停步，以及手电、L2 暗适应和开场指导，允许拆成独立片段。录像采用真实 WebSocket 房间、持续绘制的场景和生产输入逻辑；桌面由脚本调用 `Input.press/release/look`，手机由 CDP 触屏事件及触屏按钮点击操作。受控摆位、禁追和调试召唤见逐段说明。虚拟时钟逐帧合成与数值骨骼回放另行标记，不代替连续实机录像。

当前 macOS Apple M4 的 ANGLE Metal 路径已可进行 ≥30 fps 的实际取证；旧 Linux SwiftShader 约 0–3 fps、合成停帧和 OOM 的记录只解释历史材料局限。本次每段仍必须报告自己的实际 rAF 帧率，后端可用本身不构成每段达标证据。

- rAF FPS = 采样区间内实际浏览器动画帧间隔数 ÷ 墙钟秒数；同时记录帧间隔分位数、最大值和长帧数。视频容器或编码的 24/30/60 fps 不代替它。
- 采集丢帧与渲染长帧是两项指标。若浏览器/录制器没有暴露采集丢帧计数，写“未测得”，不填零；按目标刷新周期推算的漏帧只能标为估算。
- 报告分辨率、DPR、渲染后端、可见页面数、网络地址/人工延迟与错误；本机回环不证明公网或 150 ms 网络表现。
- 关键帧人工检查可以判断画面可读性、相邻姿态和明显穿模；完整连续视频才支持动作与同步判断。本会话没有可调用的 Gemini 视频工具，外评 ≥6/7/8 均未取得，不填写替代分数。
- 浏览器全程静音；手机片段使用 Chromium 横屏触屏模拟，不能代表实体 iPhone/Safari 或扬声器听感。截图取证本身产生的长帧保留在统计中，应与未加取证负载的性能测试分开解释。
- 本轮人工检查了首批 15 张原始 PNG、手机与开场补录的原 PNG/首 JPEG 及录像解码关键帧。连续视频工件可供复核，但本记录的人工画质判断限于这些抽帧，没有取得完整视频的外部自然度评审。

## 源码与构建身份

本任务工作树基线为 `f5986aa98219c0ba95fc4d3370954d6fd352ad4c`。录像源码在 2026-11-05 10:30:15 UTC 由独立体验集成树 `/private/tmp/escape-experience-integration` 的 `f53d5b69fe7c085867c1f0463ab6a9f23bbc7d82` 归档，当时 tracked 工作区干净。该源包括 `d63c0df` 抓捕 fixture / 3.8 m/s 追击计时校正和 `f53d5b6` 语音偏好与页面生命周期。续接审计时体验树 HEAD 已到 `fa1fad8`，并有未提交/合并中改动；下表只归属于冻结的 `f53d5b6`，不表示这些后续改动已经录像复验。

检查时体验树 `dist` 的时间早于上述源码。采集代理使用本树 `game/test-results/video-acceptance/f53d5b6/` 内的不可变 Git archive 快照：前端走 Vite 源模式，后端由同一归档只在证据目录内打 SSR bundle；未读取旧 `dist`。HTTP、`/healthz`、源 `main.ts` 和真实 WebSocket 建房预检通过。此路径验证开发源码下的真实可玩画面，不证明生产 `dist`、压缩静态资产、正式部署或线上版本身份。

`source.json` 保留完整 SHA-256：archive `1d730a06744fe11da57715c050e0997992efd64c1609b0eed2c165302e194eb7`；实际后端 `backend/index.mjs` 为 `11f4cec2bfedc872f99a880e855899b322c19209b2023d58b29a55a80977785a`。同源 `--build-nav` 校验缓存 key 为 `5bc4316008a15e9f21cbf1a35a214183440bf384`，4069 节点、0 失败，无重建；消费的缓存 SHA-256 为 `f4fbe6157ab314cecab57511b84e4a3b07826529c883d3e494800464ded963f1`。

| 功能 | 原始提交 | 体验树合入 | 本次需保留的身份 |
| --- | --- | --- | --- |
| 角色074成年比例、慢动作与包手间隙 | `820df03` | `4a65b01` | mesh 1.14；站姿约 2.016 m；巡逻/调查/追击 1.4/1.9/3.8 m/s；catch 独立 0.72 速率 |
| 真实抓捕接触、私有事件与救援期限 | `f96f204`、`cc2f76b`、`1481a3a` | `897452a`、`b4ef497`、`bb2ba39` | 1500 ms 接触段；先 caught 后 forced correct；30 s 服务端救援期限；小屏指导避让 |
| 抓捕者名称与平滑颜色恢复 | `fed26ee` | `b4cbdeb` | 按真实捕获来源显示标题，不能沿用上一次怪物名 |
| 值日生专属僵直冲刺/冻结/停止 | `7b3b922`、`47c6138` | `577692f`、`bc753af` | 独立 MonitorAnimator；freeze/idle/blink/warp 按权威坐标落位；`Mob.at=[x,y,z]` |

## 既有支持材料

这些材料可帮助检查新版身份与已覆盖行为，不充当本次片段的真实帧率、网络或完整覆盖证明。

| 材料 | 实际内容与局限 |
| --- | --- |
| `/private/tmp/escape-warden-presence-evidence/` | `browser-presence.json`、`foot-metrics.json`、新版正/侧/背/近脸/远景、桌面/手机追击 WebM 和 catch 七张半秒关键帧。对应 `820df03`，真实房间与新版 1.14 比例。容器检查：桌面 8.40 s / 960×640 / 899357 bytes，手机 6.56 s / 844×390 / 589530 bytes，均 VP8 编码 25 fps、无音轨；两段都不足 20 s，原报告也没有逐段 rAF FPS。原 gait 报告仍保留首尾 10% 支撑相峰值滑速约 0.28–0.35 倍地速的限制。 |
| `/private/tmp/escape-sprint-capture/game/test-results/` | `capture-evidence.json`、`capture-browser-final.log` 和 threat/shoulder/lowered/revived/wipe/reduced-motion PNG；JSON 的 renderer 为 Apple M4 Metal、`errors=[]`。用于抓捕顺序与 UI 状态支持，不能替代双人连续移动录像。 |
| `/private/tmp/escape-sprint-monitor_animation/game/test-results/monitor-animation/` | `report.json`、`session.webm`、`replay.webm`、15 张 PNG；18 个真实 L2 run 帧和 645 个受控回放帧，Metal、`errors=[]`。`session.webm` 容器为 23.24 s / 960×540 / 1604606 bytes，VP8 编码 25 fps、无音轨。受控回放明确不是服务器 AI 流程；录像早于最终 idle 停止/语音索引修复，最终差异只有相关回归验证。 |
| `/private/tmp/escape-experience-integration/game/test-results/experience-integration/capture-ws.json` | 真实双 WebSocket：新版 Warden 在 0.74 m 抓到、仅被抓者先收事件、30 s deadline、队友约 3060 ms 救起。它是协议行为证据，没有画面与 FPS。 |

## 本次实录结果

`game/test-results/video-acceptance/f53d5b6/report.json` 的采集时间为 2026-11-05 11:01:10–11:03:21 UTC（北京时间 19:01–19:03），含七个约 20 s 的实时时段；`runner/.last-run.json` 为 `passed`。六个原始 WebM、15 张原始 PNG 均存在。`recordings.json` 保存容器核验和 early/middle/late 解码帧位置；生成物保留在本机忽略目录，没有加入 Git。

环境均为同一 macOS Apple M4、headless Chromium、`ANGLE Metal Renderer: Apple M4`，DPR=1；桌面为 1280×720，手机为 844×390。单人片段同时一个绘制页面；双人片段为一个浏览器的两个独立 context/页面，并非两台设备或两个独立浏览器进程。页面始终开启绘制，所有时段 `renderFrameDelta=frames−1`、重复渲染帧计数 0、`drawEnabledSamples=frames`，未使用 `nodraw`、虚拟时间或动作变速。

网络为 `http://127.0.0.1:4466`，WebSocket 经同源代理到本机临时后端；无人工延迟、限速、丢包注入，未测公网 RTT。七段浏览器 `pageerror`/console error 均为 0；这不代表已测网络抖动或断线。以下 rAF FPS 均为 `(frames−1)/span`；长帧依次为 **>33.33 / >50 / >100 ms** 的间隔数，P95 和最大间隔单位为 ms，P50 各段均为 16.7 ms。

| 时段 | 墙钟时长 / rAF 帧数 / FPS | P95 / 最大间隔 | 长帧数 | 原视频与内容 |
| --- | --- | --- | --- | --- |
| 桌面走/跑/追逐 | 20.002 s / 1191 / **59.55** | 16.7 / 133.3 | 1 / 1 / 1 | [desktop.webm](../game/test-results/video-acceptance/f53d5b6/desktop.webm)，22.32 s；行走、跑、蹲走、停步转向，召唤后的服务端追逐与抓捕；累计移动 30.12 m |
| 手机横屏（首轮，编码画面不合格） | 20.001 s / 1193 / **59.65** | 16.7 / 100.1 | 2 / 1 / 1 | [mobile.webm](../game/test-results/video-acceptance/f53d5b6/mobile.webm)，22.08 s；遥测覆盖触屏走/跑、蹲起、转头、手电与地图，移动 22.45 m；编码后右/下裁切，不能作为完整横屏录像交付 |
| 手机横屏（v3 补录，采用） | 20.002 s / 1193 / **59.65** | 16.7 / 100.0 | 2 / 1 / 0 | [mobile-recovery-v3/mobile.webm](../game/test-results/video-acceptance/f53d5b6/mobile-recovery-v3/mobile.webm)，21.16 s；844×390 满幅，CDP 触屏走/跑、蹲起、拖动转头、手电与地图，移动 22.41 m |
| 双人：甲视角 | 20.001 s / 1189 / **59.45** | 16.7 / 150.1 | 2 / 2 / 1 | [peer-A.webm](../game/test-results/video-acceptance/f53d5b6/peer-A.webm)，22.60 s；看乙移动、起停、转身及蹲起；甲移动 3.40 m |
| 双人：乙视角 | 20.001 s / 1197 / **59.85** | 16.8 / 50.0 | 2 / 0 / 0 | [peer-B.webm](../game/test-results/video-acceptance/f53d5b6/peer-B.webm)，22.68 s；看甲接近、停步、转头及蹲起；乙移动 11.22 m |
| 手电扫墙/开关 | 20.002 s / 1197 / **59.85** | 16.8 / 50.0 | 1 / 0 / 0 | [light-and-L2.webm](../game/test-results/video-acceptance/f53d5b6/light-and-L2.webm)，45.76 s 的前半；开关与左右扫墙 |
| L2 跳闸/暗适应 | 20.003 s / 1197 / **59.80** | 16.7 / 83.3 | 1 / 1 / 0 | 同一 `light-and-L2.webm` 约 24.686 s 起；固定视点，普通停电→6 s 受控跳闸→暗适应→恢复普通停电 |
| 开场指导（首轮，步骤展示不全） | 20.002 s / 1198 / **59.85** | 16.7 / 66.7 | 1 / 1 / 0 | [opening.webm](../game/test-results/video-acceptance/f53d5b6/opening.webm)，22.08 s；开场横幅、目标、操作 1/3/4 与地图；提前按 F 导致 2/4 被合法跳过，不能称四步均可见 |
| 开场指导（v2 补录，采用） | 20.002 s / 1193 / **59.65** | 16.8 / 133.3 | 1 / 1 / 1 | [opening-recovery-v2/opening.webm](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/opening.webm)，22.32 s；横幅→目标→操作 1/2/3/4→开门→地图，全序列可见 |

六段原片均为 VP8、**编码 25 fps**、无音轨；实测游戏约 60 fps 与视频编码 25 fps 是不同指标。本次证明这些实时时段游戏绘制超过 30 fps，原片不能声称保留了 ≥30 个不同画面/秒。录制器未暴露采集丢帧计数，故全部为“未测得”；相对 60 Hz 推算的漏刷新分别为桌面 9、手机 7、甲 11、乙 3、手电 3、L2 4、开场 3，只是渲染间隔估算，不是采集掉帧数。原视频长度还包含进入房间、摆位及收尾，不把全容器时长当成全部内容的有效覆盖时长。

原片均可完整解码。按原片全长依次统计，桌面/手机/甲/乙/光照与 L2/开场的解码帧数为 558/552/565/567/1144/552，相邻完全相同帧对数为 9/39/14/22/12/2。`freezedetect n=0.001 d=0.25` 也报告了若干低变化区间（约 0.28–3.36 s）；固定视点、停步和暗场都可能命中该阈值，不能直接当成采集丢帧或全部判为渲染卡住。完整诊断、帧哈希和源视频 SHA-256 在 `review.json` 与 `review/*.framemd5`，保留异常以便连续审看。

为方便后续评审，`review/` 另外保存了 H.264、960×540、无音轨的 20 s MP4：桌面、双人两个视角、手电、L2、开场各一段，文件名对应上表时段。它们从 `approximateVideoOffsetSeconds` 裁切，墙钟到编码起点存在小误差；以事件和渲染内容共同对齐。转码保留原 25 fps 节奏，不插帧、不补出 30/60 fps，且有缩放和有损压缩；原 WebM、原 PNG 继续作为原始材料。旧手机的 MP4 也保留原裁切缺陷，不列为合格交付。

最终选用七段的 [review-index.json](../game/test-results/video-acceptance/f53d5b6/review-index.json) 汇总各自源身份、报告、视频、SHA-256、FPS、可见页面数、网络和掉帧边界。20 s 评审 MP4 入口：[桌面走/跑/追逐](../game/test-results/video-acceptance/f53d5b6/review/desktop-walk-run-chase-desktop.mp4)、[互看甲](../game/test-results/video-acceptance/f53d5b6/review/two-peer-motion-peer-A.mp4)、[互看乙](../game/test-results/video-acceptance/f53d5b6/review/two-peer-motion-peer-B.mp4)、[手电扫墙](../game/test-results/video-acceptance/f53d5b6/review/flashlight-sweep-light.mp4)、[L2 暗适应](../game/test-results/video-acceptance/f53d5b6/review/L2-dark-adaptation-light.mp4)、[手机横屏 v3](../game/test-results/video-acceptance/f53d5b6/mobile-recovery-v3/review/mobile-landscape-mobile.mp4)、[开场指导 v2](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/review/opening-guidance-opening.mp4)。首轮手机和首轮开场继续保留，分别标为编码失败与步骤覆盖不全，不替换或冒充补录。

该索引的 `finalToolingCommit`/`finalToolSha256` 是交接时工具版本，不能回填为所有片段采集时的工具身份：旧五段未记录采集工具 commit/hash 和完整工具工作区状态；手机 v3、开场 v2 分别使用后来提交为 `4bb761e`、`d58c340` 的工具改动，采集时尚未提交。产品源快照则均有独立的 `f53d5b6` 归档/文件哈希证据，两种身份分别保留。

### 手机编码补录与失败保留

首轮录像及 `mobile-recovery` v1 的编码画面均有裁切；v1 即使 Playwright 报 `passed` 也不采用。`mobile-recovery-v2` 在首 JPEG 只有 520×390 时被尺寸断言拒绝，同样保留为失败材料。没有用转码缩放或正常截图掩盖这些缺陷。

最终采用 [mobile-recovery-v3/report.json](../game/test-results/video-acceptance/f53d5b6/mobile-recovery-v3/report.json)，采于 11:49:01–11:49:23 UTC。该目录的 `source.json` 与旧批元数据逐字节一致，继续消费冻结的 `f53d5b6` 快照；它是补录手机，不能把其指标套给其他旧段。录制工具用 `--window-size=844,390` 初始化物理窗口，在视口/关卡准备好后通过公开 `page.screencast` 开始；`hasTouch=true`、`isMobile=false`。实测 viewport/canvas 均 844×390、DPR=1、coarse pointer=true、touchPoints=1、visibility=visible，真实 CDP 触屏操作，依然不代表实体手机/Safari。

补录游戏 rAF 1193 帧、跨度 19982.6 ms、绘制增量 1192、重复渲染采样 0、`errors=[]`；收到 1195 次原生 JPEG 回调，回调记录含墙钟时间及视口大小。**采集丢帧计数仍未暴露、仍为未测得**，回调数和视频帧数都不能替它填零；60 Hz 漏刷新估算为 7。原 WebM 为 844×390/25 fps/529 帧/21.16 s，可全帧解码，相邻完全相同帧对 10；这些静止帧不直接等于丢帧。

[补录手机 20 s MP4](../game/test-results/video-acceptance/f53d5b6/mobile-recovery-v3/review/mobile-landscape-mobile.mp4) 为 H.264、844×390、25 fps、500 解码帧、377226 bytes、无音轨，SHA-256 为 `18728a54f86d941fbc34b29749caad5145895dd7a19418f4b498e54d00590b96`；相邻完全相同帧对为 0，仍不能推出采集掉帧为 0。亲看 [编码 10 s 帧](../game/test-results/video-acceptance/f53d5b6/mobile-recovery-v3/review/frames/mobile-landscape-mobile-10.00.png) 与 [0–18 s 序列](../game/test-results/video-acceptance/f53d5b6/mobile-recovery-v3/review/mobile-landscape-mobile-contact.png)，场景、左摇杆、右侧六按钮、目标及地图均满幅保留，无旧灰边/黑块。[原移动图](../game/test-results/video-acceptance/f53d5b6/mobile-recovery-v3/mobile-motion.png) 中目标箭头和约 20 m 距离靠近“跑”按钮并有重叠，作为 HUD 可读性风险保留。

### 开场四步补录与失败保留

最终采用 [opening-recovery-v2/report.json](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/report.json)，采于 12:03:01–12:03:23 UTC，`source.json` 同样与旧批逐字节一致。补录不传送、不强改教学进度，保留 `safe` 和受控镜头 yaw，等待每一步的编号与可见 DOM 断言成立后再操作；走动 1.2 s、累计 4.08 m。首个 `opening-recovery` 因走过门中心而在操作 4 等待超时，保留失败，不采用。

亲看的四步原图分别为 [1/4，+3.683 s](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/opening-step-1.png)、[2/4，+7.288 s](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/opening-step-2.png)、[3/4，+10.311 s](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/opening-step-3.png)、[4/4，+13.786 s](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/opening-step-4.png)，+16.002 s [打开地图](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/opening-map.png)。门提示确实从“E 打开”变为“E 关上”，原图与编码关键帧均可见门扇已打开。地图仍遮住 4/4 教学条，保留该布局风险。

[补录开场 20 s MP4](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/review/opening-guidance-opening.mp4) 为 H.264、960×540、25 fps、500 解码帧、281293 bytes、无音轨，SHA-256 为 `022401cb03f756569bb91e7a65deb440ca3342e2497cacb4d294183d769cc5bb`。亲看 [编码 7.37 s](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/review/frames/opening-guidance-opening-7.37.png)、[13.87 s](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/review/frames/opening-guidance-opening-13.87.png) 及 [全序列](../game/test-results/video-acceptance/f53d5b6/opening-recovery-v2/review/opening-guidance-opening-contact.png) 后采用；全帧解码通过，MP4 相邻完全相同帧对 0。原 WebM 为 558 解码帧、相邻完全相同帧对 1；采集掉帧仍未测得，60 Hz 漏刷新估算 7。`report.json` 顶层通用 `touchEmulation` 说明不适用于这段桌面画面，应以本段实测 `display` 的 1280×720、DPR=1、coarse=false、touchPoints=0、visible 为准。

### 受控条件与画面观察

所有片段在开始前通过 `safe 600` 禁止随机追击；桌面、手机、双人和光照片段使用调试摆位，开场使用自然出生位置及受控镜头朝向。桌面在时段 +8 s 用 `warden 8` 召唤，之后运动、接触和抓捕由真实服务器推进。L2 以调试钥匙/传送完成进关，再禁追、关手电，+4 s 用 `power 6` 触发跳闸。它们覆盖受控真实房间中的行为，未走完自然找钥匙/保险丝流程，也未证明随机遭遇频率。

还需按脚本标记解读瞬时视线变化：桌面 +6.7 s 直接减 yaw 0.7 rad、+8 s 重置到 −π/2；乙视角 +2.4 s 与 +9.5 s 各直接改 π；首轮开场 +7.2 s 直接设 yaw=0，补录开场也受控设朝向对门。这些注入的瞬转不能用来判定产品鼠标平滑或掉头回归。连续生产 `look` 转向只包括甲 +8.8/+9.7 s、手电 +6/+8 s 的扫墙，以及手机 CDP 拖动；脚本没有把所有转头都录成连续鼠标拖动。

- **桌面：** [desktop-chase.png](../game/test-results/video-acceptance/f53d5b6/desktop-chase.png) 主要是昏暗走廊，不能据此评价角色074近景姿态。[desktop-penalty.png](../game/test-results/video-acceptance/f53d5b6/desktop-penalty.png) 虽然命名为 penalty，截于时段 +14.3 s，画面仍是追逐中的远处剪影；`caught` 事件实际在 +16.434 s，`forced correct` 随后到达，不能把该原 PNG 当成罚站/抓捕接触证据。后补的录像解码 [16.80 s 近身帧](../game/test-results/video-acceptance/f53d5b6/review/frames/desktop-walk-run-chase-desktop-16.80.png) 可见黑外套、衣领扣和包带，头顶出画，手部抓持点不清楚；[18.00 s 倒地帧](../game/test-results/video-acceptance/f53d5b6/review/frames/desktop-walk-run-chase-desktop-18.00.png) 显示“你被角色074抓住了”和 29 s 救援倒计时、红暗角。它们补时序支持，未完成抓持动作自然度评分。
- **手机：** [mobile-motion.png](../game/test-results/video-acceptance/f53d5b6/mobile-motion.png) 中移动杆、蹲/跑/手电/互动按钮、教学和目标可读；[mobile-map.png](../game/test-results/video-acceptance/f53d5b6/mobile-map.png) 中横屏地图可读。但 [原录像中段解码帧](../game/test-results/video-acceptance/f53d5b6/decoded-frames/mobile-middle.png) 的 844×390 容器只有左上约 520×254 的场景，右侧约 324 px 灰色、下方黑色且右侧按钮被裁。首轮手机录像判为取证不合格，正常 PNG 不替代编码后验收；这是录制视口问题，不能据此判定产品横屏 UI 裁切。没有实体手机、Safari 和音频验收。
- **双人：** [peers-A.png](../game/test-results/video-acceptance/f53d5b6/peers-A.png) 与 [peers-B.png](../game/test-results/video-acceptance/f53d5b6/peers-B.png) 都看见对方及名称，人物较暗、接近剪影，服装和肢体细节不够清楚。录像解码的 [甲视角序列](../game/test-results/video-acceptance/f53d5b6/review/two-peer-motion-peer-A-contact.png) 和 [乙视角序列](../game/test-results/video-acceptance/f53d5b6/review/two-peer-motion-peer-B-contact.png) 可见接近、姿态与朝向改变，后段开手电后衣服更可辨。两边采样均收到对方移动、yaw 改变和蹲伏 flag，`maxPeers=1`。乙的两次转身直接设置 π yaw，甲的 ±0.8 rad 转头通过生产 `look` 渐变；不能把乙的瞬时转身当成自然连续转弯质量证明。
- **手电：** [torch-off.png](../game/test-results/video-acceptance/f53d5b6/torch-off.png) 与 [torch-on.png](../game/test-results/video-acceptance/f53d5b6/torch-on.png) 的墙面、门板光斑差异明显；原图同口径地面亮度为 10.27→45.17、墙面 45.41→113.71（0–255 灰度加权均值）。关灯图仍有开场横幅，整幅均值受 UI 影响，不能用它推导物理照度。
- **开场：** [opening-objective.png](../game/test-results/video-acceptance/f53d5b6/opening-objective.png) 可见开场横幅，[opening-tutorial.png](../game/test-results/video-acceptance/f53d5b6/opening-tutorial.png) 可见目标面板与“操作 3/4”提示、门已打开；[opening-map.png](../game/test-results/video-acceptance/f53d5b6/opening-map.png) 地图可读，但把“操作 4/4”教学条压在地图后面，仍有弱透出的重叠。旧片的 F 输入早于操作 1 勾选停留结束，产品按已完成条件合法跳到 3，故操作 2/4 没有实际显示；不能以步骤标记或目标值推写为四步全展示。此覆盖缺口与布局风险分别保留，未在本任务改产品布局。

### L2 最终 eye=0.4 的同源亮度复测

冻结源码 `campus/scene.ts` 中 `EYE_ADAPT={blackout:0.4,s:0.6}`，同源 `EYE_LIGHT.level=0.3`。本次 L2 全段 `blackout=true`；普通停电目标为 0.4，跳闸 `out=1` 时目标为 1，恢复后回到 0.4；0.6 s 是指数时间常数，不是“0.6 s 内完全适应”。+4 s 请求跳闸后先有约 1.6 s 预兆，真实 `out=1` 约在 +5.63 s 开始，此时 eye 从约 0.4 向 1 变化，没有出现 eye=0 的完全先黑状态。下表取各截图开始标记最近的真实 rAF 值；亮度来自原 PNG 的固定地面区域（横向中间 1/3、纵向底部 1/3），没有修改曝光或对图像提亮。

| 原始截图 | 相对 L2 时段 | eye / out | 地面亮度 / 墙面亮度 | 观察与边界 |
| --- | --- | --- | --- | --- |
| [l2-ordinary.png](../game/test-results/video-acceptance/f53d5b6/l2-ordinary.png) | +1.5 s | 0.38449 / 0 | 31.26 / 13.70 | 普通停电下近地面与墙线可辨；入关暗适应尚未完全到 0.4，仍有横幅 |
| [l2-first-dark.png](../game/test-results/video-acceptance/f53d5b6/l2-first-dark.png) | +5.7 s；触发跳闸后 +1.7 s | 0.47785 / 1 | 22.43 / 8.44 | 比普通停电暗，已开始恢复；该标签不等于实际最暗瞬间 |
| [l2-adapted.png](../game/test-results/video-acceptance/f53d5b6/l2-adapted.png) | +7.2 s；触发后 +3.2 s | 0.95713 / 1 | 31.01 / 12.23 | 地面亮度已恢复到接近普通停电，走廊远处仍暗 |
| [l2-restored.png](../game/test-results/video-acceptance/f53d5b6/l2-restored.png) | +14.0 s | 0.41130 / 0 | 31.66 / 13.88 | 回到普通停电水平，尚有指数衰减余量；不是已装齐保险丝后的全楼复电 |

另按相同区域口径读取有损 H.264、960×540 解码帧，`encoded-l2-luma.json` 保存了 +5.64 s 全图/地面 **16.93/20.88**、+6.20 s **20.95/26.64**、+7.20 s **23.35/29.59**，比 +5.7 s 原截图更早的跳闸瞬间更暗。这里的缩放、压缩和取样时点均与原 PNG 不同，不能直接混用；也不能把后续原截图的地面 ≥22 推成全时段保证，或仅凭短暂编码值宣布产品亮度回归。

补充亲看的解码帧 [5.52 s](../game/test-results/video-acceptance/f53d5b6/review/frames/L2-dark-adaptation-light-5.52.png)→[5.64 s](../game/test-results/video-acceptance/f53d5b6/review/frames/L2-dark-adaptation-light-5.64.png) 显示跳闸变暗，[6.20 s](../game/test-results/video-acceptance/f53d5b6/review/frames/L2-dark-adaptation-light-6.20.png)→[7.20 s](../game/test-results/video-acceptance/f53d5b6/review/frames/L2-dark-adaptation-light-7.20.png) 显示地面逐渐恢复；对应 eye 约 0.7731→0.9571。变化幅度较小，抽帧不能独立判定主观上是否“像眼睛适应而不是灯重新亮”。这组数据支持最终 0.4 常数下固定视点的亮度和时序复测，尚未取得 #595 的主观过渡外评，也未覆盖 L2 不同楼层、设备或所有视角的可读性。

## #570 相位统计

第 570 行原方法取“较低的脚”，会把 chase duty 小于 0.5 时的腾空帧算入支撑，混淆鞋底相对地面滑速。此次数值代理只在本树 `game/tests` 复制并修正统计工具，读取实际 GAIT、duty 与模型 scale，以每只脚的真实相位判定支撑，排除腾空；不修改旧 `loop/shots/review-188-warden.mjs`。

有效报告：`game/test-results/warden-gait-f53d5b6-60fps.json`；脚本 `game/tests/probe-warden-gait.mjs` / `game/tests/warden-gait-sampler.mjs`。读取源码 `f53d5b69fe7c085867c1f0463ab6a9f23bbc7d82`，源树 `dirty=[]`，真实模型 scale 为 `[1.14,1.14,1.14]`。它以固定 `dt=1/60 s` 做 FK，使用简化材质，不启动渲染器、网络或视频；这里的 60 Hz 是数值采样率。

每只脚在差分中心及端点都必须满足真实 `planted(i)`，运动帧还要落在实际混合 GAIT duty 内。相同鞋底椭圆材料点跨端点做世界坐标差分，包含 root/mesh 缩放；两侧均支撑时用中央差分，支撑或片段边界向支撑内部做单侧差分，孤立支撑样本排除。完整支撑段细分为 `u∈[0.1,0.9]` 中央和两侧首尾 10%，不会因为 duty<0.5 而把腾空计入支撑。

以下均为鞋底世界水平滑速，单位 m/s，按“中位 / 峰值”列出。稳态先预热 3 s，再采样约 5 s；每项有 299 个被统计帧。

| 稳态 | 地速 / duty | 腾空帧 | 全支撑：样本；滑速 | 中央：样本；滑速 | 边缘：样本；滑速 | 单侧差分样本 |
| --- | --- | --- | --- | --- | --- | --- |
| walk / patrol | 1.4 / 0.5 | 0 | 299；0.00877 / 0.07458 | 241；0.00824 / 0.04045 | 58；0.04196 / 0.07458 | 20 |
| investigate | 1.9 / 0.5 | 0 | 299；0.01174 / 0.09443 | 239；0.01062 / 0.05119 | 60；0.05367 / 0.09443 | 28 |
| chase | 3.8 / 0.45 | 31 | 268；0.00058 / 0.03204 | 217；0.00006 / 0.02042 | 51；0.00913 / 0.03204 | 42 |
| sprint / run | 6.0 / 0.33 | 103 | 196；0.00361 / 0.54234 | 157；0.00074 / 0.28922 | 39；0.02175 / 0.54234 | 40 |

过渡序列仍暴露峰值：8–10 s 以 1.4 m/s 行走并用 smoothstep 转身 π，支撑滑速中位 0.04465、峰值 0.70782 m/s（约 0.506 倍地速）；10–14.5 s 淡入 3.8 m/s chase，峰值 1.28935 m/s（约 0.339 倍地速）。这些值完整保留。`maxFootStepM` 包含正常摆腿，不能直接当成角色瞬移证据。

工具提交 `e671830`。此前共享 heavy gate 的定向 Vitest 26/26 和 `tsc --noEmit` 记录为通过；相同源码的两次完整 JSON 字节一致，SHA-256 为 `3e724da54f597f4dac45af2fe53d097a8503c742b942c832348c6be3a6236fd4`。指定过时的 `70aa1bd` expected commit 已实际被工具拒绝。本次续接只读复核了报告、哈希、真实 duty/相位/scale、差分端点和所有表值，没有再次运行这些重检查。

在本任务 `game/` 目录复跑时仍须经过共享 gate；若源 HEAD 已移动，下面命令应拒绝执行，应先审查新的源身份再选择新输出标签：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- node tests/probe-warden-gait.mjs --source-root /private/tmp/escape-experience-integration --expected-commit f53d5b69fe7c085867c1f0463ab6a9f23bbc7d82 --fps 60 --out /private/tmp/escape-sprint-video_acceptance/game/test-results/warden-gait-f53d5b6-rerun-60fps.json
```

该工具修正测量方法，没有改变产品步态。有限 60 Hz 样本不推断子帧极值；方法、源和差分端点不同，不能把旧峰值与本表直接相减当成修复幅度。实录 `report.json` 中另有 `gait` 数据，包含网络插值和调试摆位，不能与本节固定 dt 的离线 FK 峰值混用。它不能自动完成 #569 产品尾部修复、连续动作质量验收或 #571 外部自然度评分。

## 验收欠账对应关系

原覆盖审计 `/private/tmp/escape-sprint-todo_coverage/docs/todo-sprint-coverage.md` 把 QA02 对应到待办行 480/494/516/571/573/591/595；#570 是按相位统计方法欠账。此次交付应逐项保留证据强度：正常时间实录补视频工件，逐段 rAF 补真实性能，#570 数值报告补支撑相筛选，L2 eye=0.4 亮度补最终常数复测。Gemini 分数、正式部署、全量闸门、公网/150 ms 验收及未经实测的设备听感仍需各自证据，本文不代为完成。

| 原欠账 | 本次取得的证据 | 仍缺的验收条件 |
| --- | --- | --- |
| #480 移速/手感 | 20 s 混合走/跑/追逐实录与真实约 60 fps | 本段持续跑仅约 1.9 s，不等于原要求的 15 s 跑动；没有“移动手感/速度感”≥7 外评，也不能断言全程无滑步 |
| #494 评审方法 | 正常时间视频、事件解码帧、真实帧间隔和 #570 支撑相数值统计 | 未做 0.5× 慢放或骨骼角曲线评审；抽帧判断不替代连续动作自然度评审 |
| #516 移动回弹 | 本机回环双向互看、运动/转向/蹲伏遥测；两个视角 correction 计数均 0 | 未测 150 ms、公网、楼梯/门/贴墙/耗尽耐力全动作矩阵；未取得回弹/瞬移/抖动 ≥8 外评 |
| #570 支撑相方法 | 按每足真实相位/duty 排除腾空，含完整/中央/边缘支撑、稳态和过渡表；定源/重复报告一致 | 产品步态未修改，过渡与 sprint 峰值仍在；不自动关闭 #569/#571 |
| #571 角色074自然度 | 正常时间追逐/近身/倒地片段，加已有外观材料 | 无 Gemini ≥6；近身头顶出框、手部接触不清，不能给自然度合格结论 |
| #573 跳闸视频 | Metal 下真实时间 L2 跳闸/暗适应 20 s，原片、评审 MP4 与真实 eye/out 轨迹 | 未取得主观过渡外评；没有修改旧固定步长脚本 |
| #591 开场 | v2 补录的横幅→目标→操作 1/2/3/4→开门→地图 20 s 视频，逐步可见断言和原图/编码帧支持 | 没有“一眼知道做什么”≥8 外评；地图遮教学条风险尚在 |
| #595 暗适应 | 最终 0.4 常数的普通停电地面/全图原值 31.26/26.82；跳闸/恢复时序 | 尚缺“像眼睛适应而非灯又亮”的外评；未覆盖所有视角与实体手机 |

此外，双人本次为两个 context、受控脚本和回环网络；未覆盖全部横移/后退组合，也没有用量化骨骼曲线核验站立呼吸/微动。人物偏暗影响细节判断，这些工件不足以直接关闭远端动画原任务。

## 重跑与集成交接

本轮新增的离线后处理工具为 `e6adeea`，读取已结束于 11:03:21 UTC 的旧采集，不重新解释为新版本录像。`inspect-recordings.mjs` 读取原容器并解码代表帧；`encode-review.mjs` 对原片和 MP4 全帧解码、导出 `framemd5`、执行 `freezedetect`、保存 SHA-256 与原生节奏 MP4。两步已产生本节引用的 `recordings.json`、`review.json` 和帧工件；原手机编码缺陷由这一检查发现，保留失败材料。

手机工具修正为 `4bb761e`，开场四步展示与事件帧映射修正为 `d58c340`。本轮实际检查包括：

| 检查 / 命令 | 状态与证据边界 |
| --- | --- |
| 只读核对旧 `report.json`、`runner/.last-run.json` 和文件库存 | 旧采集已于 11:03:21 UTC 完成、状态 passed；不是本轮重录全部片段 |
| `node --check tests/video/acceptance.spec.mjs`、`node --check tests/video/encode-review.mjs` | 采集代理执行通过；只验证脚本语法 |
| `ESC_VIDEO_ONLY=mobile ESC_VIDEO_OUTPUT=test-results/video-acceptance/f53d5b6/mobile-recovery-v3 python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node node_modules/@playwright/test/cli.js test -c tests/video/playwright.config.ts` | **1 passed，22.3 s**；只补录手机；独立 `report.json` 与原批源元数据一致 |
| `ESC_VIDEO_OUTPUT=test-results/video-acceptance/f53d5b6/mobile-recovery-v3 python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- node tests/video/encode-review.mjs '/Users/local-user/Library/Application Support/bilibili/ffmpeg/ffmpeg'` | exit 0；原片/MP4 全帧解码，20 s/25 fps/844×390、哈希和帧工件已复核 |
| `ESC_VIDEO_ONLY=opening ESC_VIDEO_OUTPUT=test-results/video-acceptance/f53d5b6/opening-recovery-v2 python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node node_modules/@playwright/test/cli.js test -c tests/video/playwright.config.ts` | **1 passed，22.3 s**；只补录开场，四步可见与真实开门断言通过 |
| `ESC_VIDEO_OUTPUT=test-results/video-acceptance/f53d5b6/opening-recovery-v2 python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- node tests/video/encode-review.mjs '/Users/local-user/Library/Application Support/bilibili/ffmpeg/ffmpeg'` | exit 0；原片/MP4 全帧解码及事件截图时间映射，20 s/25 fps/500 帧、哈希已复核 |
| 同 `--window-size=844,390` 的 2 s 桌面静态色板探针，经 browser gate | [desktop-decoded.png](../game/test-results/video-acceptance/f53d5b6/desktop-window-check/desktop-decoded.png) 亲看 1280×720 满幅、右下标记保留；它只验证录制工具视口，不充当游戏片段 |
| #570 报告与源身份只读复核 | 归档 320 个普通文件与 `f53d5b6` 逐字节一致；manifest/backend/nav 哈希一致；此前 26 例 Vitest/tsc 未重复运行 |

手机补录的 `approximateVideoOffsetSeconds=0.105` 相对显式 screencast 开始时刻；该份旧元数据注释仍写 page creation，应按工具实际起录点理解，而不是建页后 0.105 s 已进入关卡。

最后的工具语法与 `git diff --check` 通过；采集代理已关闭自动源服务器，交接时 4466 无监听。本次没有重跑完整七段或全量 E2E 闸门。

复跑须用新输出目录，不能覆盖已验的证据。下面命令从本任务 `game/` 目录执行；只归档明确的 Git commit，不使用体验树当前未提交内容。准备工具会拒绝复用已有 `source-snapshot`，后端构建会校验导航缓存身份。改变源版本时须重审 `source.json`，不能只沿用旧文件夹名。

```sh
export ESC_VIDEO_OUTPUT=test-results/video-acceptance/f53d5b6-rerun-YYYYMMDD-HHMM
unset ESC_VIDEO_ONLY
node tests/video/prepare-source.mjs --source-root /private/tmp/escape-experience-integration --source-ref f53d5b69fe7c085867c1f0463ab6a9f23bbc7d82 --output "$ESC_VIDEO_OUTPUT"
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- node tests/video/build-backend.mjs
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test --config tests/video/playwright.config.ts
export ESC_VIDEO_FFMPEG='/Users/local-user/Library/Application Support/bilibili/ffmpeg/ffmpeg'
node tests/video/inspect-recordings.mjs "$ESC_VIDEO_FFMPEG"
node tests/video/encode-review.mjs "$ESC_VIDEO_FFMPEG"
```

最后仍需亲看编码后的帧，尤其确认手机按钮、视口、地图没有被录制器裁切；容器尺寸和成功退出不能替代画面检查。全量闸门、生产 build 和部署由集成代理负责；本任务没有取得线上版本身份，未宣称已经部署。

可供集成的测试提交按顺序为 `5148b46`、`9df6b04`、`e671830`、`668286c`、`7288812`、`f20afa1`、`8633aba`、`aa1eeb5`、`e6adeea`、`4bb761e`、`d58c340`，另加本文的最终提交（SHA 由最终交接列出）。审查范围仅 `game/tests/**` 与本文；应按这些提交/文件选择集成，不重放整个工作分支，不带入 `game/test-results/`、`node_modules`、产品代码、`todo.md` 或旧 `loop`。
