# Codex 抖音好友桥

这是一个公开源码、仅限非商用的实验性桥接项目：本机控制面、状态与临时媒体保持在本地，
回复生成则通过本机启动的 Codex App Server 使用登录账号对应的 Codex 服务。它只面向一个
受信任好友、一个专用抖音账号和一个专用 Edge 配置，同时由独立目录中的 `AGENTS.md` 提供
人格指令。本项目并非抖音或 OpenAI 的官方产品，网页自动化可能随页面更新而需要适配。

## 快速开始

需要 Windows、Node.js 22 或更新版本、已登录的 Codex 桌面应用、Microsoft Edge，以及一个
专门用于桥接的抖音账号。仓库不需要 npm 第三方依赖。

```powershell
git clone https://github.com/axinjjj/codex-douyin-friend.git
cd codex-douyin-friend
npm test
npm run setup:sensevoice
npm run launch:douyin
```

在新开的专用 Edge 中登录抖音，打开要服务的一个聊天，先运行
`npm run probe:douyin` 确认调试连接，再运行 `npm run autostart:install`。首次安装默认只读；
打开 `http://127.0.0.1:43127`，确认页面锁定的是预期聊天后再开启“自动发送回复”。

## 当前阶段

- 已确认抖音 Windows 8.3.0 客户端是 Electron 应用，但它拒绝外部
  `NODE_OPTIONS` bootstrap，也没有开放 CDP 端口。
- Windows UI Automation 只能看到外层 Pane，不能稳定读取聊天内容。
- 当前路线是使用独立 Edge 配置访问 `douyin.com/chat`，再通过仅绑定本机的 CDP 连接。
- Codex 侧使用官方 `codex app-server`，不需要 OpenAI API Key。
- 独立 Edge 配置已经登录；聊天输入区、消息列表和文本气泡的结构已完成只读映射。
- 一次性监听器已经能以方向和哈希指纹比较新消息，仍不会输出聊天正文。
- 一条真实入站文本已经完成 `抖音 → Codex App Server → 抖音` 往返验证。
- 常驻桥用对端账号的不透明标识生成 SHA-256 会话键，锁定启动时的当前聊天；昵称相同或改名
  不会复用错误的 Codex thread。身份优先读取右侧标题资料；标题区未暴露资料时，只从当前选中
  会话行的头像组件读取 `secUid`。两条路径都只返回哈希，拿不到稳定标识时则拒绝启动。
- 抖音消息 DOM 的倒序排列已改为按视觉纵坐标排序，确保读取最底部的最新消息。
- 入站/出站方向使用消息节点稳定的 `isFromMe` 结构标记，不依赖窗口宽度或左右坐标；专用 Edge
  在后台、最小化或窄窗口下不会再把所有消息误判为居中系统消息。
- 抖音把固定大小的消息 DOM 窗口向前滑动时，桥会用至少两条连续消息的哈希边界重新对齐，
  只处理新露出的尾部消息；找不到可靠重叠边界时仍会安全停机。
- 桥在启动、轮询、静默合并和发送校验前都会通过页面 DOM 有界滚到消息尾部，不依赖人工点开
  Edge 或点击最新消息；它不会因此恢复一个被用户主动最小化的窗口。
- 分享作品的媒体指纹优先在页面内读取 React `itemId`/`item_id` 或 schema，再只把不可逆哈希写入
  断点；动态卡片文案、时间标签和点赞面板都不参与指纹，避免同一作品渲染变化后破坏恢复边界。
- 检测到新入站后会等待一个最长 2.25 秒、以 750 毫秒静默为结束条件的短合并窗口。之后按
  消息时间顺序建立最多 12 条的持久队列：第一条媒体前的连续文字，以及每条媒体后紧跟的连续
  文字，都会和对应媒体进入同一个 Codex turn；相邻媒体仍逐条处理，纯文字批次仍合成一个 turn。每条回复发送并校验成功后才
  推进该项断点；异常或重启会保留尚未完成的哈希队列，不会重发已经确认成功的前项回复。
- 每个会话键对应一个持久 Codex thread。进程重启后优先通过 `thread/resume` 恢复；成功恢复时
  不重复注入历史，新建或安全回退 thread 时才注入一次当前可见聊天记录。新 thread 在人设校验、
  历史注入或首次状态提交前失败会被可恢复归档；显式换新 thread 也只在新断点提交成功后归档旧
  thread，避免失败测试不断堆出侧边栏窗口。
- 默认固定使用 `gpt-5.6-sol`、`xhigh`，启动和恢复都会校验实际模型、人设来源与持久属性。
- 常驻桥按 App Server 的 `thread/tokenUsage/updated` 实际用量自动调用官方
  `thread/compact/start`：默认在当前上下文达到模型窗口 75% 时压缩，降到 50% 后重新武装，
  两次阈值触发的尝试至少间隔 5 分钟。
- 压缩只会在没有 Codex turn、媒体处理或发送操作的空闲点启动，并等待官方
  `contextCompaction` item 和对应 turn 都完成；`contextWindowExceeded` 最多执行一次压缩和
  一次原输入重试，不会形成循环或重复发送。
- 旧版 `.MessageItemShareAwemecontainer` 与新版 `.BulletBulletVideocontainer` 分享卡由同一份
  可扩展变体注册表识别；React 数据中的 camelCase/snake_case 字段都受支持。视频卡片已经完成
  真实往返：桥从当前登录态读取有界的兼容播放候选，
  优先通过抖音官方播放入口取得新鲜 CDN 地址；下载先用 1 字节探测总大小，再按 1 MiB Range
  最多三路并发接收，逐段校验位置和总长度后按原顺序写入。单段失败最多重试 3 次，只有完整分段才写入文件；重试会
  回到官方入口刷新 CDN 地址。下载成功后还必须由临时 Edge 媒体页实际解码；只有明确的解码
  不兼容才清理该候选的文件并尝试下一可信候选，下载与解码共用六分钟总预算，场景处理等其他
  错误不会被换源掩盖。之后按时长自适应抽取关键帧，以 `localImage` 输入同一个 Codex
  thread。作品详情读取的页面内请求与外层 15 秒 CDP 预算相互兼容；跳转目标仍必须属于受信任
  媒体域名。若详情和 React 数据确实只给封面，桥还会精确重认该消息，在 4 秒有界预算内点击
  已登记卡片的真实 React 播放目标、读取可见播放器的受信任 HTTPS 源并关闭查看器；只有这条
  路径也拿不到完整视频时才诚实保留 `shared_cover`。
- 30 秒内短视频预算为 5 帧，随后按时长升到 8/12/16 帧，长视频硬上限为 18 帧；
  场景扫描最多取 72 个低分辨率 RGB 签名，保留首尾、时间覆盖、场景变化和可信音频锚点，
  去除相似的中间帧。
- 低分辨率扫描只在临时 localhost Edge 媒体页内顺序执行并保存在内存；磁盘只写最终
  入选的 PNG，不批量落盘缩略图。
- 音轨通过同一个一次性 `127.0.0.1` 媒体页由专用 Edge 解码成 16 kHz 单声道 WAV，
  再由本机 SenseVoiceSmall Q8 识别台词、语言、情绪和声音事件；不依赖 FFmpeg 或 Python。
  SenseVoice 是可选能力：运行包缺失或校验失败时，桥仍可启动并明确按纯视觉处理视频，控制台
  显示安装命令，不会把启动失败伪装成已经听过音轨。
- 固定 SenseVoice 运行包已验证支持 FSMN-VAD SRT；严格解析成功时，语音段、情绪和声音
  事件变化附近的画面会进入统一候选预算。自定义旧运行时不支持 SRT 时仍保留普通转写但
  不产生时间锚点；声明支持却输出非法 SRT 时丢弃该次音频理解，按纯视觉选帧，绝不根据
  文字长度猜时间。
- 关键帧、音频转写和当前聊天上下文会进入同一个 Codex turn；临时媒体页处理后自动关闭。
- 本地 supervisor 负责专用 Edge、桥进程、退避重启和安全停机；仅在空闲监听阶段的普通异常
  自动恢复，理解、压缩、回复待发或发送阶段的异常会停在人工处理状态。
- 专用 Edge 外框已经恢复但渲染视口仍卡在最小化尺寸时，桥会用一次有界的 1 像素窗口变化
  刷新渲染面；真正处于最小化状态时不会擅自把窗口弹出来。
- `http://127.0.0.1:43127` 控制台可查看组件状态、当前模型/思考强度、上下文窗口占比和最近
  耗时，并可暂停、重连、手动压缩、切换模型或换一个新的持久 Codex thread。页面不展示
  thread ID、聊天正文或人设内容。
- 控制台另有独立的“允许模型给媒体点赞”开关，公开默认值为关闭。启用后，Codex 在生成该条
  媒体回复的同一个 turn 内独立决定是否点赞，不增加第二次模型调用；桥只会在回复发送并校验
  成功后，锁定原入站媒体并点击其原生“点赞”菜单项。已点赞、菜单变化、聊天变化或目标不再
  唯一时都会安全跳过，不会为了点赞影响已发送的回复。
- 直接聊天图片优先解码当前可见、经过格式/签名/大小校验的 PNG/JPEG，或从受信任媒体地址下载；
  抖音聊天内嵌的 WebP 不直接交给 Codex，而是做有界 PNG 截图。分享作品会综合作品详情、
  `aweme_info` 与有界解析的动态卡片数据：视频走兼容播放源；单张图文保留 `image_post` 身份；
  多张图文按原顺序读取，超过 12 张时等距取 12 张。作品详情请求每次最多等待 2 秒，按
  250/500 毫秒退避重试三次；只有无法确认完整来源时才降级为 `shared_cover`，并明确禁止假装
  看过完整作品。每张最多尝试 4 个可信地址，单次图文最多三路并发并共享 150 秒总预算；个别
  图片确实失败时只提交成功部分，并向模型明确缺图边界，全部失败才停止。分享前的说明和媒体
  后紧跟的附言都会与媒体进入同一个 Codex turn。
- 未登记的媒体结构会记录一个仅含 SHA-256 结构签名、数量、通用类名提示和属性名的有界诊断，
  随后安全停机；诊断不含聊天正文、属性值、URL、账号或作品号，运行时也不会自动改代码。
- 分享评论卡会单独读取评论作者、评论正文和关联作品标题，并把它们标成不可信媒体内容，
  不会误当作发送者的指令，也不会把评论作者当成聊天对方。关联作品继续复用视频音轨/关键帧、
  图文或仅封面的同一条有界处理链路；另行附带的聊天文字仍作为发送者自己的话传入。
- 这些图片路径已通过本地契约测试；2026-09-02 的真实样本暴露了旧版复合消息丢媒体、后台截图
  超时、窗口收窄后方向误判和作品详情为空四个问题。修复后已用现有真实聊天图片与分享卡片
  验证本地读取和立即清理成功，并用“附带文字 + 分享卡片封面”完成新 Codex thread 的生成、
  抖音发送与发送结果校验。2026-09-03 又用当前页面做了脱敏只读复核，三张可见作品卡均拿到
  完整 H.264 视频源；若有限重试后仍只能得到封面，它只代表封面证据，不代表模型看过完整作品。
- 2026-09-03 的真实分享评论样本已完成评论字段读取、关联视频画面与本地音轨理解、Codex 回复、
  抖音发送校验和临时媒体清理。
- 2026-09-03 的真实纯图片样本确认：抖音把内嵌 WebP 伪装成 PNG 时会导致 Codex 误判黑图；
  现在桥校验声明格式与真实字节签名，不一致就回退到有界 PNG 截图。该 PNG 已通过真实
  `localImage` 视觉问答验收。当天新增的 `.BulletBulletVideocontainer` 单图作品与其后置文字
  从精确 `processing` 断点恢复为一个 Codex turn，只生成并校验了一条抖音回复，未重复旧回复；
  媒体临时目录随即清空，supervisor 回到 `listening`。聊天媒体原生点赞及已点赞后的幂等跳过
  也已在当前页面验证。聊天内 `@` 提及触发不在当前实现范围内。
- 2026-09-03 的两个相邻真实视频已逐条完成回复、发送校验和点赞；第二项处理期间发生故障时，
  第一项已确认断点没有回退或重复。恢复后的第二项完整读取约 59 秒音轨和 8 张关键帧后成功
  回复，临时视频、WAV 和关键帧随即清理。该样本也验证了三路分段下载能在六分钟总预算内完成。
- 同日一张新版视频卡在详情接口返回空作品后，先被严格识别为封面，再经上述可见播放器兜底
  恢复为 7.8 秒视频；真实本地处理完成 12 个场景采样并生成 2 张关键帧，验证后立即清理且没有
  额外生成或发送回复。已发回复的精确 `sending` 断点按出站指纹恢复为 `ready`，没有重复发送；
  4 个可明确识别的旧桥接 task 已做可恢复归档，当前聊天继续只绑定 1 个持久 task。

## 隐私边界

- 不读取、复制或提交手机号、验证码、Cookie、Token。
- `private/` 永远不进入 Git；实时桥不会把私人全局人设复制到仓库。
- 调试输出默认不打印聊天标题、消息正文或页面 URL。
- 在本项目自身的存储边界内，消息正文、音轨转写和模型回复只在进程内存中传递，不写入项目
  日志或桥状态文件；这不等于它们只在本机处理。
- 分享评论的作者名、正文和关联作品标题同样只在当前进程内存与 Codex turn 中传递，不写日志或断点。
- 媒体点赞决策使用每个 turn 随机生成的短期 nonce 控制标记；标记会在发送前剥离，不写日志，
  页面动作日志只记录已应用、已跳过或校验失败。
- 会话映射与消息断点只写入被 Git 忽略的 `.runtime/douyin-bridge-state/v1/`；每个会话保留
  主快照和恢复快照，内容仅含版本、会话键、Codex thread ID、模型配置、阶段和消息指纹。
  两份快照都损坏或断点含义不明确时会停止，绝不靠猜测推进。
- 当前实现固定使用持久 Codex task/thread：聊天正文、媒体转写、模型回复及人设会作为模型输入
  进入 Codex 服务，并保留在登录账号的任务历史中，受该账号的产品数据与保留设置约束。桥接
  项目不会再把正文复制到 `.runtime`，但目前也没有“处理完即删除”的临时 thread 模式。
- 上下文压缩日志只包含事件、触发原因、状态、数值用量和安全协议错误码；不包含聊天正文、
  人设内容、Cookie 或 Token。压缩失败、超时或服务端不支持时，桥保留当前 thread 并继续监听。
- 视频播放地址不写日志；下载视频、WAV 音轨与关键帧只进入被 Git 忽略的
  `.runtime/video-analysis/`，Codex turn 完成后删除。
- 聊天图片内嵌解码/下载/截图、分享封面和图文作品图片只进入 `.runtime/image-analysis/`，同样在 Codex turn 后删除；
  只允许受信任的抖音/字节媒体域名，单图最多 8 MiB、单次合计最多 64 MiB。
- 正常完成或报错都会立即清理当次媒体任务；进程被强杀后遗留的 UUID 任务目录会在下次
  启动时清掉（只处理超过 2 小时的目录，避免碰到仍在运行的任务）。
- SenseVoice 程序与模型只保存在被 Git 忽略的 `.runtime/tools/sensevoice/`；安装脚本固定
  官方版本与 SHA-256，语音不会发往在线转写服务。
- 实时桥只服务启动时的当前聊天；检测到聊天对象变化时立即停止。
- supervisor 日志只写脱敏状态，单文件达到 1 MiB 后轮换，最多保留当前与上一份日志。
- 未知媒体日志只允许结构签名、元素计数、通用类名提示和属性名；正文、URL、账号、作品号及
  DOM 属性值不会进入日志。
- 发送必须显式设置 `DOUYIN_SEND_ENABLED=true`。默认只读模式只报告新活动，不生成回复，
  也不推进持久消息断点，因此之后以发送模式重启仍能处理断点后的消息。

## 尚未解决的发布边界

- 自动发送仍是默认关闭的实验能力，只适合一个受信任好友与专用账号。Codex App Server 以当前
  Windows 用户和项目工作目录运行；项目尚未提供操作系统级沙箱或可验证的能力声明，不能证明
  运行中的编码代理绝对无法访问同一用户可读的其他文件。
- 抖音网页没有给桥暴露经验证的稳定消息 ID。当前去重与恢复依赖最多 12 条可见 DOM 消息的
  内容指纹、方向和连续重叠边界，不是独立的持久收件箱；长时间离线、页面结构变化或边界消失
  都会安全停机，不能承诺绝不漏收。
- 当前每个聊天键使用一个持久 Codex task/thread，并不提供真正的临时会话生命周期。桥内显式
  “换新窗口”会在新断点可靠提交后把旧 thread 归档，失败的新建 thread 也会归档；归档不是永久
  删除，需要彻底删除已保留上下文时仍必须在 Codex 产品侧管理相应任务。

## 本地验证

```powershell
npm test
npm run smoke:codex
npm run setup:sensevoice
npm run probe:sensevoice
npm run launch:douyin
npm run probe:douyin
npm run inspect:douyin
npm run discover:douyin-chat
npm run snapshot:douyin-chat
npm run watch:douyin-chat
npm run watch:douyin-media
npm run probe:douyin-video-media
npm run probe:adaptive-video
npm run test:douyin-editor
npm run reply-latest:douyin-chat
npm run reply-latest:douyin-video
npm run bridge:douyin-chat
npm run supervisor:douyin
npm run autostart:install
npm run autostart:remove
```

`smoke:codex` 会创建临时持久 Codex thread、关闭首个 App Server 客户端再恢复它，并确认
测试目录里的 `AGENTS.md` 同时满足：

1. 出现在 App Server 返回的 `instructionSources` 中；
2. 实际改变模型回复；
3. 恢复后的同一 thread 仍加载该指令并能继续对话。

冒烟结束会删除该测试 thread。

首次启用视频音轨前运行 `npm run setup:sensevoice`。它会把官方 SenseVoice llama.cpp
Windows CPU 运行包、SenseVoiceSmall Q8 和 FSMN-VAD 下载到 `.runtime` 并逐一校验
SHA-256；约占 262 MB 模型与压缩包空间。`npm run probe:sensevoice` 使用官方公开中文
样本做本地转写，只输出字数和标签，不打印识别正文。

`probe:douyin` 只检查 `127.0.0.1:9229` 是否存在浏览器调试目标，不读取页面内容。

`probe:adaptive-video` 不读取抖音聊天，也不发送消息。先设置
`CODEX_DOUYIN_VIDEO_FIXTURE` 为不超过 100 MB 的非敏感本地 H.264 MP4，再运行该命令；
它只输出时长、预算、扫描/入选数量、总图片大小、耗时和清理结果，并在结束时删除整个
UUID 媒体任务目录。按项目门禁，任何 CDP 媒体检查前都先运行 `npm run probe:douyin`。

`launch:douyin` 使用 `.runtime/edge-profile` 创建专用浏览器配置，并把调试端口绑定到
`127.0.0.1`。第一次打开时用抖音客户端扫码登录专用小号；Cookie 只保存在被 Git
忽略的本地配置目录。`inspect:douyin` 只返回控件数量和页面就绪状态，不会输出标题、
URL、昵称或消息正文。

`discover:douyin-chat` 只返回控件层级与 CSS 结构提示；`snapshot:douyin-chat`
只返回消息方向、类型、长度和不可逆哈希指纹；`watch:douyin-chat` 在当前聊天上等待一条
新的左侧入站消息。三者都不会把消息正文写入终端或文件。

Chat 页的 Slate 输入框选择器参考并在当前页面实测了 MIT 许可项目
[ScriptCat-Douyin-Fire-Helper](https://github.com/dr-190/ScriptCat-Douyin-Fire-Helper)。

## 启动实时桥

先保持专用 Edge 窗口停留在要服务的聊天，然后执行：

```powershell
$env:DOUYIN_SEND_ENABLED = "true"
$env:DOUYIN_BRIDGE_TIMEOUT_MS = "3600000"
$env:CODEX_DOUYIN_MODEL = "gpt-5.6-sol"
$env:CODEX_DOUYIN_EFFORT = "xhigh"
npm run bridge:douyin-chat
```

上下文压缩默认参数可按需覆盖：

```powershell
$env:CODEX_DOUYIN_COMPACTION_HIGH_WATERMARK = "0.75"
$env:CODEX_DOUYIN_COMPACTION_LOW_WATERMARK = "0.50"
$env:CODEX_DOUYIN_COMPACTION_COOLDOWN_MS = "300000"
$env:CODEX_DOUYIN_COMPACTION_TIMEOUT_MS = "120000"
```

高低水位必须满足 `0 <= low < high <= 1`。策略使用
`tokenUsage.last.totalTokens / modelContextWindow` 作为当前上下文占比；
`tokenUsage.total.totalTokens` 是累计用量，不参与阈值判断。

首次启动时，既有可见文本会作为新 Codex thread 的上下文但不会补回；以后启动会恢复该
聊天对应的 thread，并从持久消息断点继续。停机期间新收到的左侧文本、图片、视频或图文卡片
会在恢复后按时间顺序进入同一条持久队列；多条连续文本会合并为一个 turn，多个媒体则逐条
生成和校验回复。处理视频时，专用 Edge 会短暂切到
本机临时媒体页，依次完成音轨
解码/本地转写、低分辨率场景扫描和最终帧抽取后自动关闭并返回聊天。图片和转写仍进入
同一个 Codex turn。无音轨或转写失败时会明确降级为只看画面，不会假装听见声音；超过
15 分钟的视频为避免整轨解码造成无界内存，不处理音轨，只做有界画面分析。每次启动只锁定
一个聊天；对方切换、输入不完整、出现未确认的右侧消息、发送结果无法验证或新增消息无法在
12 条可见断点窗口中找到可靠边界时都会停止，不会盲目重发。桥接进程用 Windows 命名管道保证同一会话
只有一个实例；进程被强制终止后，操作系统会自动释放该锁。

日常使用不需要直接启动桥，运行 supervisor 即可：

```powershell
npm run supervisor:douyin
```

然后打开 `http://127.0.0.1:43127`。supervisor 首次启动沿用默认
`gpt-5.6-sol / xhigh`，自动发送和媒体点赞默认关闭；修改后的模型、思考强度、自动发送及
媒体点赞开关只保存到被 Git
忽略的 `.runtime/supervisor/config.json`。点击“换新窗口”会新建持久 Codex thread，给它补入
当前可见文本历史，并在新状态提交成功后归档旧 thread；若上次在人设校验、历史注入或首次状态
提交前失败，新建但未使用的 thread 也会归档。若上次在理解或回复待发阶段中断，只有这个显式动作会在消息边界完全吻合时
回退断点并重做一次。多媒体队列中，待处理媒体后面已有前一项的已确认回复时，会在完整快照
一致的前提下按指纹重新绑定原媒体位置；发送中或聊天已变化时仍拒绝恢复。

安装当前 Windows 用户登录后的自启动：

```powershell
npm run autostart:install
```

任务名固定为 `CodexDouyinFriendSupervisor`，使用交互式当前用户、最低权限，并由任务计划程序
直接托管隐藏的 Node supervisor 主进程；
supervisor 自身异常由任务计划程序最多重启 3 次，桥的普通空闲异常另有 10 分钟内最多 6 次的
退避上限。卸载自启动使用 `npm run autostart:remove`；它只删除这一个任务，不删除浏览器登录态、
模型或对话断点。Codex 桌面版更新后若其内置 `codex.exe` 路径发生变化，重新运行同一个安装命令
即可刷新任务中的精确路径，不需要先卸载，也不会清除桥状态。

当前运行路线是抖音网页版，因此不能真正“锁死”抖音服务端页面版本，也不应通过关闭 Edge
安全更新来换取稳定。专用 Edge 配置减少了扩展和账号环境变化；页面结构发生变化时，哈希断点、
聊天锁和发送校验会让桥安全停机，等适配后再由控制台明确重连。

媒体边界固定为：视频最多 100 MB；音频最多 15 分钟、WAV 最多 40 MiB；场景扫描最多
72 个 16×10 RGB 签名并限时 45 秒；最终最多 18 张图片、每边不超过 768 像素、单张最多
4 MiB、合计最多 64 MiB，并另设 45 秒抽取时限。视频候选共用 6 分钟下载上限，单个请求
连续 30 秒无数据才判为静默失败；浏览器处理和本地转写也各自有超时。音频页若超时会被
关闭并以全新的临时页继续纯视觉处理。

主状态快照损坏但恢复快照有效时，会保留旧消息断点、改建新 thread，并只补注入非待处理
历史；服务端 thread 缺失或与当前模型配置不兼容时同样安全回退。若中断发生在 Codex turn、
回复已生成或无法确认的发送阶段，下一次启动会保持失败关闭，等待人工判断，避免重复发送。

SenseVoice 使用 [QwenAudio/SenseVoice](https://github.com/QwenAudio/SenseVoice) 官方发布的
本地 llama.cpp / GGUF 运行时；Codex App Server 当前只接收文本和图片，因此音频先在本机
转成文字与标签，再连同关键帧送入 Codex。

## 人设目录

仓库里的 `fixtures/persona/AGENTS.md` 只是无敏感内容的加载测试。正式运行时直接使用
Codex 已有的私人全局人设：

```text
%USERPROFILE%\.codex\AGENTS.md
```

桥在每次启动时检查该文件是否出现在 App Server 的 `instructionSources` 中；未加载就拒绝
回复。人设内容不会复制进此仓库。

## 许可证与反馈

本项目原创代码和文档采用
[Polyform Noncommercial License 1.0.0](LICENSE)，允许非商用使用、修改和分发，禁止商用。
这属于公开源码而非 OSI 开源。具体范围见 [LICENSING.md](LICENSING.md)，第三方项目、运行时和
模型见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

发现 Bug 或兼容性变化，欢迎通过
[GitHub Issues](https://github.com/axinjjj/codex-douyin-friend/issues) 提交脱敏后的复现步骤。
请勿上传账号信息、聊天记录、Cookie、Token、媒体地址、私人 `AGENTS.md` 或带本机用户名的路径。
