# AI 跨切片集成复核

本提交在 `e5f3ac7` 上整合 director、search、safe sighting、Warden forms 和 L1/L2 difficulty；另包含 campaign review 的 `118927c`（主集成树已合为 `862f4d8`，摘取时保留主树更新）。历史分工交接中的全绿结果属于各自原分支，不代表本 aggregate 的全量结果。

## 已修正

- 一个权威开门实现负责门板、dirty delta、真实门声；warden的门声来源为 0，不产生玩家证据。
- 人数听力倍率仅在 Room 乘一次，形态倍率仅在 WardenAI 乘一次；夜巡仅普通巡逻为 1.05 m/s，调查、追逐、捕获计时和退避保持原值。
- sighting 与自然跳闸共用导演 45 秒冷却；保留未知摄像机、离线、spawn-ready、开局和复活保护。L8 不套普通导演节奏。
- 搜索图保留节点 id，缓存完整胶囊可通行的补全边，动态处理关闭/锁门和关卡屏障；出生优先使用关闭门时含安全远点的玩家分量。修复warden困在东侧两个节点、导致首见/噪声搜寻/导演接近均不能完成的问题。
- 同种子重开统一使用服务端 incarnation，客户端相同 incarnation 的 roster 不抢先清过场，新 incarnation 正常重载。
- L1 双钥匙主线、人数补给、进度触发值周生保持；L3–L8 保留专属高台/召唤逻辑。值周生同 tick 只罚站一人，附近队友有 3.5 秒救援窗口。
- reconnect 的 fullSnapshot 强制补发warden、值周生、finale 的形态/动画/目标元数据，并新增真实 disconnect/resume 回归。

## 本次实际验证

- `game/test-results/ai-integrated-typecheck.log`：`npm run typecheck` 退出 0。
- `game/test-results/ai-integrated-build-server.log`：服务端构建退出 0，113 modules。
- `ai-focused-2.json`：43/44；唯一失败是测试复制 Conn 导致隔离值周生的 debug 命令被真实连接身份边界拒收。改回真实 Conn 后 `ai-guide-diagnostic.log` 的 room_tension 8 项全部通过。
- 26 文件定向回归 `ai-integrated-final.json`：317 测，310 过/7 失败。6 项为主集成智能体已接手的旧 `spawn_ready` 测试桩兼容；剩余 L5 密图超时由下述 tail 修复。forms 的真实 reconnect 回归、全部新 search/sighting/director/difficulty、L4 导航/AI、复活与开局保护、L6–L8 在该轮通过。
- 密图 tail：`investigationGraph` 对超过 256 节点的图仅补 2m 近边，所有原始边仍校验并保留；稀疏校园链保留 40m 补边。避免体育馆约千节点图进行昂贵的远点两两胶囊探测。`ai-dense-nav.json` 五文件 95/95 通过（L5 全 13 项在 0.239 秒内完成，另含 director/room/search/sighting），`ai-dense-nav-typecheck.log` 退出 0。
- 本轮未重跑真实 WS、浏览器、视频或全量 check。两套 WS 脚本已适配当前 incarnation/ready 协议，仍需最终集成树验证。

## 保留的验收尾项

`guide_campus` 在 seed 4、连续 drawer_key → stair_key → exit 的第三段记录一次 A→B→A，路径仍能走完。尚未通过的稳定化尝试已从提交移除；原测试保留，不放宽断言。父智能体负责全量客户端 harness 和 todo 统一勾选，本提交不宣称 APK/EXE/DMG 或最终交付完成。
