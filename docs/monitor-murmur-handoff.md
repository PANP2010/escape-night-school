# 值周生姓名与默念增量

本切片延续 `55c9182` 的权威姓名，服务器快照、直接写在脸上的姓名、头顶近距姓名与“你被〈人名〉卷死了”共用实际身份。姓名池按后续用户要求变为 42 人：新增“角色094”，原“角色003”替换为“角色020”；黑板同池、无重复。

后续黑衣追加对应同一匿名身份“角色078”，合并旧拼字后仍为 42 个不同身份；显示和击倒消息统一使用该代号。仅其可见衣服、兜帽、口罩为黑色，后两者跟随 head bone，姓名保留在口罩上方，其余角色材质/几何不改。其专属随机池为“这波看我操作。”“拿捏了。”“问题不大。”“我想角色070了…………孤独……”。四套相关单元测试 17 项与 typecheck 通过；共享 gate 的静音 Metal 真实全身/脸部渲染已亲看，截图 `monitor-warden-han-face.png`、`monitor-warden-han-body.png` 位于同一证据目录。

普通句第一行“角色081…………”，换行后从用户指定的三句中随机选。专属句逐字保留：角色039“我卷在哪了…………”；角色021、角色026“可以可以，不赖不赖”；角色020“嗯～你看看，你和我谁更糖一点？”；角色094从“区完了…………”“别…………见证”“行。”“对。”中选。专属句覆盖普通句，不附加前缀。

每只值周生只持有自己的 face material/texture，其他材质与模型几何不修改。角色094脸上只画一对眯眼，不写姓名，其实际网络姓名仍是角色094。角色020只改变自身可见 SkinnedMesh 和自身 head bone 的比例，保持圆头、矮胖身体；权威 root 坐标、移动和碰撞胶囊不改。身份变更会还原旧比例；移除释放独占脸部资源。

`MonitorMurmurs` 每帧选择最近一名未被看着的值周生，最多一条字幕和一个默念声源总线。字幕逐字约 0.32 秒，省略号约 0.25 秒，换行稍停；计时独立于快照，新快照不重置；中断不追赶积压字符。文字轻微颤抖，尊重 reduced motion。服务器 `anim=freeze` 或本机 55 度视锥/身体 LOS 立即停止；字幕/音频只在 10 米内、同楼层、无遮挡时出现。看不见的全图怪物不会产生字幕或声音。角色074正常对白出现时默念暂停。

使用既有 `Voice` 的手势激活、静音、音量、后台、异步恢复取消与销毁生命周期；只增加可选 pitch/syllableLimit profile，默认角色074行为保持原样。默念为随机 190–255 Hz、每字符短双音节的无语义 Web Audio 嘟囔，不调用系统朗读。距离增益低于普通对白。

## 最终树接线

本树基于 `55c9182`，尚无最终树已有的 `pausedForNetwork`。合入时必须将以下两处并入其现有生命周期（由维护最终树的主代理完成，切片未修改其他 worktree）：

1. 在 `Game.setNetworkPaused(true)` 的现有停音逻辑中调用 `this.monitorMurmurs.pause()`。建议该方法的暂停/恢复边界都调用，以清掉旧场景字幕和 pending audio。
2. 帧内 `this.monitorMurmurs.update(...)` 的最后一个 eligibility 条件加 `!this.pausedForNetwork`；最终树若因暂停提前 return，第一处立即停音仍然必要。

切片已在 `cancelVoice`（换关/黑屏/完成）、`disposeFeedback`、音量设置中接线。`MonitorMurmurs.pause()` 保留已逐字显示的进度但立刻隐藏字幕/取消音频，`reset()` 清空各怪台词时钟。

## 验证

类型检查、8 套 96 项单元测试、Vite production client build 通过；覆盖实际身份/多人同步、face 独占释放、角色094脸部特例、角色020实例比例还原、全部专属原句、持续逐字时钟、本机直视/服务器 freeze、距离/遮挡/楼层、单声源预算、静音/后台/失效帧/销毁及默认角色074语音回归。

最终共享 browser gate 下的单个 Chromium/Metal/headless/mute-audio 会话已通过真实 WebGL/SkinnedMesh 验证：普通名字直接落脸，角色094只有眯眼，角色020圆头矮胖；角色039逐字完成专属句，实际 Web Audio source 在打字时出现，本机转头直视及服务器 freeze 后字幕隐藏、source 清零，静音和销毁也清空音频与字幕。截图均亲看，控制台无 pageerror。使用无声的浏览器验证合成器行为，没有让电脑播放声音。

证据位于本工作树 `game/test-results/cover-review/`：`monitor-lineup.png`、`monitor-face-角色039.png`、`monitor-face-角色094.png`、`monitor-face-角色020.png`、`monitor-role-039-murmur.png`，以及 `report.json`。该 renderer fixture 使用真实 Mobs/MonitorMurmurs/Voice 和真实 skinned geometry，没有替代 face shader、文字绘制或音频实现；遮挡/多楼层/距离和网络 eligibility 另由单元测试覆盖。最终树的网络暂停两处接线仍须主代理完成并集成验证。
