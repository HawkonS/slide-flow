# WPS Renderer（protocol v2，兼容 v1）

独立的 Windows WPSCLI 转图标准件。生产环境由 Windows Pull Worker 主动领取主程序创建的持久化任务。协议 v2 会下载一次完整多页 PPTX，按配置分批调用一次 WPSCLI `--range` 输出多张高清 PNG；协议 v1 继续接收拆分后的单页 PPTX，作为旧版部署、超大文件和能力不匹配时的自动回退。服务不修改 PPT 几何、连接线、颜色或文字，不使用 LibreOffice 降级渲染。

## 安装、升级与回滚

要求 Windows、Python 3.10+ 和已通过实际转换验证的 WPSCLI。WPS 本身不包含在本项目中；使用者应自行确认其许可、账号、会员、配额及自动化/商业使用条款。不要把 WPS 二进制、付费字体、账号或密钥提交到开源仓库。

### 最简单的使用方式

Windows 端不需要记住一长串命令。首次使用时，在本目录复制
`windows-renderer.config.example.json` 为 `windows-renderer.config.json`，只填写 Python、WPSCLI 和主程序地址：

```powershell
Copy-Item windows-renderer.config.example.json windows-renderer.config.json
notepad windows-renderer.config.json
.\Setup.ps1
```

`Setup.ps1` 会安装本机 Renderer、生成受 ACL 保护的 Token、注册字体同步和 PPT 转图两个计划任务，并启动它们。Token 不写进配置文件；安装后把 `C:\ProgramData\SlideFlow\WpsRenderer\shared\token.txt` 的内容安全地配置到主程序的 `render.token_file`。

以后更新只需在仓库目录执行：

```powershell
.\Update.ps1
```

它会先用 Windows 上的 Git 快进拉取代码，再调用带排空、健康检查和自动回滚的 Renderer 升级流程。Windows 机器必须安装 Git for Windows；如果 Git 不在 PATH，可在 `windows-renderer.config.json` 增加例如 `"git": "D:\\Tools\\Git\\cmd\\git.exe"`。也可以在 Mac 推送后，在 Windows 项目目录执行 `git pull --ff-only`，再运行 `Update.ps1`。不要手工覆盖 `C:\ProgramData\SlideFlow\WpsRenderer\current`，也不要重复运行 `Install.ps1`。

下面是底层手工方式，通常不需要使用。必须使用管理员 PowerShell、Python 3.10+ 和已经在当前 Windows 账号下验证过的 WPSCLI；不要使用 Microsoft Store 的 Python 空别名：

```powershell
Set-Location .\services\wps-renderer
.\scripts\Install.ps1 `
  -Python C:\Python313\python.exe `
  -WpsCli "C:\Users\Administrator\AppData\Local\Kingsoft\WPS Office\12.1.0.28505\clitool\wpscli.exe"
```

本机 Renderer 固定只监听 `127.0.0.1:8765`，仅供同机 Pull Worker 调用。不要在阿里云安全组或 Windows 防火墙开放该端口。Bearer token 只保存在主程序和 Windows 受 ACL 保护的密钥文件中，不能放到浏览器。

安装脚本会创建并启动计划任务，首次安装后也可以用下面的五个脚本独立管理服务。所有管理脚本都需要管理员 PowerShell；它们只操作带有 `SlideFlow WPS Renderer protocol v1` 描述的计划任务，不会接管同名的其他任务。状态与代码分离：

```text
C:\ProgramData\SlideFlow\WpsRenderer\
  current\                 # 当前代码和独立 .venv
  releases\previous\      # 只保留上一版，供自动回滚
  shared\config.json       # 生产配置，不在 Git 中
  shared\token.txt        # Bearer token，严格 ACL
  shared\data\            # PPT、字体和 PNG 临时数据
  shared\logs\            # 服务日志
  shared\cache\           # 后续字体缓存
```

从一个经过审查的源码目录升级（不要直接指向正在编辑的目录）：

```powershell
.\scripts\Upgrade.ps1 -Source C:\Deploy\slide-flow\services\wps-renderer -Version 2026.09.22-01
```

升级先在独立 release 目录复制源码、创建虚拟环境并安装、检查依赖，成功后才暂停受管的字体/转图 Pull Worker 并排空 Renderer。可用 `-ConstraintsFile` 和 `-Wheelhouse` 指定审计过的固定依赖版本与离线 wheel；准备失败不会停止现有服务。排空超时会恢复旧服务和任务状态，不会强停正在进行的转换。切换 `current` 后只更新已有任务的代码入口，保留 shared 配置、Token、任务账户、触发器和其他设置。健康检查失败时，必须确认所有相关进程退出，才允许恢复 `releases\previous`；无法确认退出时保留目录并明确报错。升级成功后保留当前版和上一版。`previous`、`retiring-*` 等保留版本名和已存在的 release 会在维护前被拒绝。主程序 Ubuntu/macOS 与此 Windows 组件分别升级，不需要更换 SSH 转发端口或 Token。

日常启停和配置：

```powershell
.\current\scripts\Register.ps1 `
  -InstallRoot C:\ProgramData\SlideFlow\WpsRenderer `
  -WpsCli "C:\Users\Administrator\AppData\Local\Kingsoft\WPS Office\12.1.0.28505\clitool\wpscli.exe" `
  -Port 8765 `
  -TokenFile C:\ProgramData\SlideFlow\WpsRenderer\shared\token.txt

.\current\scripts\Start.ps1
.\current\scripts\Stop.ps1
.\current\scripts\Restart.ps1
.\current\scripts\Unregister.ps1
```

`Register.ps1` 的 `-Token` 可以直接指定已有 Token，但命令行可能被本机进程审计记录；生产环境建议使用 `-TokenFile`，或先把 Token 写入默认的 `shared\token.txt`。不传 Token 时会复用已有 Token，不存在则生成随机 Token。端口配置会写入 `shared\config.json`，服务启动时读取 `port` 和 `token_file`。

字体和 PPT 转 PNG 都由 Windows 主动领取。字体不随 PPT 转换包上传；所有字体任务完成前，主服务不会发放 PNG 转换任务。首次配置两个拉取任务：

```powershell
.\current\scripts\Register-FontSync.ps1 `
  -InstallRoot C:\ProgramData\SlideFlow\WpsRenderer `
  -Url https://slide-flow.example.com `
  -TokenFile C:\ProgramData\SlideFlow\WpsRenderer\shared\token.txt

.\current\scripts\Register-RenderPull.ps1 `
  -InstallRoot C:\ProgramData\SlideFlow\WpsRenderer `
  -Url https://slide-flow.example.com `
  -RendererUrl http://127.0.0.1:8765 `
  -TokenFile C:\ProgramData\SlideFlow\WpsRenderer\shared\token.txt
```

同一台 Windows 同时服务多个主程序时，Render Pull 可以为主程序和本机
Renderer 使用不同的 token。`-TokenFile` 是主程序 token，
`-RendererTokenFile` 是本机 Renderer token；省略后者时保持原有行为，复用
`-TokenFile`。例如开发环境可使用独立的 `dev-token.txt`，而继续使用本机
Renderer 的 `token.txt`。为避免覆盖另一套任务，给开发任务传入独立的
`-ConfigFile`；Render Pull 还应使用独立的 `-PullTokenFile`、`-WorkDir` 和
`-WorkingDirectory`。Font Sync 同样支持 `-ConfigFile` 和 `-SyncTokenFile`。

也可以在注册本机 Renderer 时一起配置 `-FontTaskUrl` 和 `-RenderTaskUrl`。计划任务名分别为 `SlideFlow-WPS-Font-Sync` 与 `SlideFlow-WPS-Render-Pull`，由 `Start.ps1`、`Stop.ps1`、`Unregister.ps1` 一并管理。

远程主程序地址必须使用 HTTPS；HTTP 只允许 `127.0.0.1`/`localhost`/`::1`，用于 SSH 反向隧道端点。

开发 Mac 没有公网入站能力、Windows 有公网 SSH 时，使用项目根目录的 `tools/windows_renderer_bridge.sh` 建立单向反向 SSH 桥。Windows 开发环境的字体同步和转图领取地址都配置为 `http://127.0.0.1:18089`，然后运行：

```powershell
.\scripts\Test-SlideFlowBridge.ps1
```

脚本也支持故障诊断用的前台运行：

```powershell
.\current\scripts\Start.ps1 -Foreground -Config C:\ProgramData\SlideFlow\WpsRenderer\shared\config.json
```

配置由 `config.example.json` 起步。密钥来自 `WPS_RENDER_TOKEN` 环境变量或配置中的 `token_file`，至少 32 字符；安装脚本创建随机密钥并限制 NTFS ACL，不输出密钥。不要把 `shared\config.json`、`token.txt`、`.venv`、`data`、日志、用户 PPT、私有字体或 WPS 二进制提交到 Git。数据目录必须是专用目录，或本组件已创建所有权标记的目录。令牌和 data 目录应只对运行账号及 SYSTEM 可读写。不要共享同一个目录给不可信本地用户。

Renderer 固定监听 `127.0.0.1`，仅由同机 Pull Worker 访问；主程序只提供任务领取接口。

以能运行 WPSCLI 的同一 Windows 用户账号运行；不要假设 LocalSystem/Windows Service Session 0 具有该用户的 WPS 登录状态和字体可见性。先通过 SSH/目标启动方式验证真实转换，再由 Windows 任务计划或专用服务管理器托管。此组件不修改机器防火墙、WPS 登录或系统服务，不自动升级 WPS。

### 连接与进程生命周期

- Windows 上的 `wps_renderer` 是长驻的单实例服务；它不会为每个 HTTP 请求重新启动 Python 服务。
- Pull Worker 对主程序使用最长 25 秒长轮询；空队列不会每几秒高频请求。任务领取后每 30 秒续租，反向隧道长时间不可用时会在租约过期前停止当前处理。
- Pull Worker 对每个本机 Renderer 批次设置 2100 秒总时限（`Register-RenderPull.ps1 -LocalJobTimeoutSeconds` 可在 60–7200 秒间调整）。旧版 Renderer 的遗留 `waiting_fonts` 状态会取消本机作业、重新排队主任务并释放 Worker，不会无限续租堵住后续任务。
- Pull Worker 的独立滚动日志位于 `shared\logs\<config-name>.log`。主程序连续 300 秒不可达时，Worker 主动退出；计划任务每 5 分钟检查并重新拉起，避免状态仍显示 Running 但已不再轮询。开发反向隧道每次成功启动后，还会只重启 URL 指向该回环端口的开发 Pull Worker。
- `Update.ps1`/`Upgrade.ps1` 会发现并暂停所有受管的生产与开发 Pull Worker，升级或回滚后恢复各自原有的启用和运行状态；不会重新注册或覆盖任一环境的 URL、token、配置路径和队列目录。所有 Worker 的 Python 代码入口统一指向原子切换后的 `current` release，避免开发任务继续导入旧的 `dev-code`。
- 字体安装和卸载任务也使用 10 分钟租约与最多 5 次领取；旧 Worker 的过期回报不能覆盖新租约。字体文件按 SHA-256 命名，避免相同原文件名互相覆盖；主程序删除标准字体后会排队清理对应内容寻址副本。
- 主程序在创建 PPT 渲染任务时固定本次所需字体名称与 SHA-256 清单。Pull Worker 把该清单转交本机 Renderer，由 Renderer 在 WPSCLI 子进程所在会话注册这些字体；仅把字体文件放进用户字体目录并不等于后台会话已可见。
- 协议 v2 为完整源文件申请一次短时 OSS 下载 URL，输出仍在上传每页 PNG 前刷新签名 URL；协议 v1 保持逐页申请下载 URL。Worker 不保存 OSS AccessKey。
- WPSCLI 本身不是长驻共享进程。Windows Worker 为每个批次启动一个受 Job Object 管理的 CLI 子进程，完成、取消或超时后确认整个进程树退出并释放临时字体，再处理下一批；逐页回退等价于批次大小为 1，绝不按进程名终止其他用户的 WPS。
- 多个 Windows Worker 可以竞争领取，但 SQLite 原子事务保证一个租约只发给一个 Worker；每台 Windows 本机 Renderer 仍固定一个 WPS 转换 worker。

## HTTP 协议

所有端点（包括 health）均需 `Authorization: Bearer TOKEN`。错误：`{"error":{"code":"...","message":"..."}}`。接口不会返回服务器绝对路径。无 CORS，未开放 API 文档。

### 字体预检

`POST /v1/fonts/check`，JSON：

```json
{
  "names": ["Example Sans", "Example Sans Bold"],
  "fonts": [{"sha256": "64位小写十六进制", "names": ["Example Sans", "Example Sans Bold"], "faces": ["Example Sans Bold", "ExampleSans-Bold"]}]
}
```

响应：

```json
{
  "installed": ["Example Sans"],
  "missing": ["Example Sans Bold"],
  "fonts": [{"sha256": "64位小写十六进制", "installed": false, "conflict": false}]
}
```

`names` 来自字体内部 name 表的 family/full/PostScript/typographic-family 名称；可选 `faces` 仅来自 full/PostScript 名称。仅 `installed: true` 表示同 SHA-256 的字体文件已存在，可不传此文件。仅仅同 family 名不意味着版本相同。`conflict` 是根据可选 face 提前发现的冲突提示；服务器仍会解析上传的真实字节做最终检查，不能通过伪造名称绕过检查。字体不存在时必须传实际字体文件，不能只传字体名让服务器自行联网下载。

### 提交有界小批次

`POST /v1/jobs`，原始 `Content-Type: application/zip`，`Idempotency-Key` 为 16–128 位 URL-safe 字符。建议同时发送 `X-Content-SHA256`（整个 ZIP 的 SHA-256）。首次返回 HTTP 202；重复已接受的 key 返回已有任务（HTTP 200）；相同 key 正在上传返回 409，调用者稍后重试。已有 key 携带不同 SHA-256 返回 409。重试应复用完全相同的 ZIP 和 key，不要每次重新打包生成不同 ZIP。

ZIP 只允许 `manifest.json` 和 manifest 声明的文件，不接受额外目录项：

```json
{
  "version": 1,
  "dpi": 150,
  "pages": [{"index": 0, "file": "pages/0000.pptx", "sha256": "64位小写十六进制"}],
  "fonts": [{"name": "Example Sans", "file": "fonts/hash.ttf", "sha256": "64位小写十六进制"}],
  "required_fonts": ["Example Sans"],
  "font_hashes": ["64位小写十六进制"]
}
```

协议 v1 中，`index` 是主应用的全局页索引（0–100000），不必从批次内 0 开始。默认最多 4 个单页 PPTX，每页含且仅含一张幻灯片。

协议 v2 的 ZIP 只包含一个多页源文件和页面映射；默认主程序配置 `render.wps_batch_size=20`，Renderer 上限由 `max_batch_pages` 控制：

```json
{
  "version": 2,
  "dpi": 288,
  "source": {"file": "source/deck.pptx", "sha256": "64位小写十六进制", "slide_count": 50},
  "pages": [
    {"index": 0, "slide": 1},
    {"index": 1, "slide": 2}
  ],
  "fonts": [],
  "required_fonts": ["Example Sans"],
  "font_hashes": ["64位小写十六进制"]
}
```

`slide` 是完整源 PPTX 中从 1 开始的页码，必须递增且不能重复；`index` 仍是主应用的全局零基页索引。Pull Worker 先查询 `/v1/health`，只有 Renderer 协议版本、批量页数、源文件页数及上传/输入体积上限均满足时才使用 v2，否则自动使用 v1。批次出现 `render_timeout`、`conversion_failed`、`output_too_large`、`invalid_output` 或 `internal_error` 时会二分重试，最小降到单页。将主程序的 `render.wps_batch_size` 设为 `1` 可立即关闭批量模式，无需降级 Windows 程序。

两种协议都支持 .ttf/.otf/.ttc/.otc。外部资源引用、宏、ActiveX、嵌入 Office/OLE 对象不接受；普通超链接元数据允许。DTD/实体、目录穿越、重复路径、符号链接、加密 ZIP、压缩炸弹拒绝。

`font_hashes` 包含本次依赖的全部标准字体文件摘要（包括预检已安装而未上传的文件）。转换前重新核验，避免排队期间字体清单发生变化后静默替换字体。

Pull Worker 发布一批 PNG 时会并行申请签名地址并并行上传，默认并发数为 4；可在 `render-pull.json` 中通过 `publish_concurrency` 调整为 1–8。主程序收到批次后也会并行下载、校验和规范化图片，再用一次短事务发布结果，首批预览不会被同批次其他页面的串行网络等待拖慢。

### 渐进获取、确认、取消

- `GET /v1/jobs/{id}` → `{id,status,created_at,updated_at,pages,error}`。状态为 `queued/running/completed/failed/cancelled`。`pages` **在 running 时即可新增**，前端不必等整个批次完成。建议 0.5–1 秒间隔轮询，可按远端状态退避。
- `GET /v1/jobs/by-key/{idempotency-key}` → 上传响应丢失时按原 key 恢复任务；可携带相同 `X-Content-SHA256`，摘要不一致返回 409。`DELETE /v1/jobs/by-key/{idempotency-key}` → 按 key 取消并清理；未知 key 会保留一个短期取消墓碑，阻止迟到的 POST 重新接受同一提交，避免断连重试产生孤儿任务。
- `pages` 每项为 `{index,sha256,size,width,height,acknowledged}`。
- `GET /v1/jobs/{id}/pages/{index}` → 流式 PNG，响应包括 `Content-Length`、SHA-256 `ETag` 和 `X-Content-SHA256`。Pull Worker 校验后使用主程序签发的固定对象 Key 直接上传 OSS，主程序再次下载校验并原子发布。
- `DELETE /v1/jobs/{id}/pages/{index}` → 204。下载验证成功后 ACK，可加 `If-Match: "SHA256"`。幂等；ACK 后该 PNG 被删，但任务短期保留元数据，后续 GET 此图片返回 404。**ACK 不代表用户最终保存**；Windows 仅负责中转，不持有业务数据。
- `DELETE /v1/jobs/{id}` → 请求取消并回收数据。运行中的任务先终止所拥有的进程树和临时字体，再删文件；不会在 WPS 正在读取时提前清理。下载尚未结束时等最后一个读取者释放。
- `GET /v1/health` → 协议版本、排队/运行数量及批量/上传/DPI 上限。

完整性和提交事务由主应用控制：某页失败不能写入部分业务记录，只有全部 PNG 经页码、体积、格式、像素和 SHA-256 校验后才进入确认保存。主程序通过任务租约、续租、超时重领和最大尝试次数处理 Worker 崩溃；许可证、账号、配额或输入验证错误不会盲目重试。

## 资源、安全和恢复策略

- 固定 **1 个转换 worker**；进程间单实例锁禁止多个 Python worker 共用 data（不要用 `uvicorn --workers N`）。字体启用/转图/移除串行执行。
- 默认排队 4 个，最多 128 条活跃+保留任务记录。上传前先预约最坏空间（压缩体 + 解压 + 输出），无 Content-Length 也逐块限制 128 MiB；解压上限 256 MiB，输出上限 64 MiB，总受管空间 768 MiB。预约可能使实际可排队数小于 4，这是低磁盘时的主动背压。
- 默认保留至少 512 MiB 且至少磁盘 5% 空闲；不足返回 507。队列/历史已满返回 429。客户端尊重 `Retry-After` 并使用有限的总截止时间。
- 单页转换默认最多 120 秒；批量转换按页数扩展超时且受 `max_batch_timeout_seconds`（默认 1800 秒）约束。CLI 输出日志仅内存保留 16 KiB，不保留海量 stdout。下载即 ACK 自动删图；任务输入转换完即删；失败/取消清理；遗留终态任务默认 10 分钟清理；每 15 秒巡检一次，避开正在转换/下载的任务。
- 重启恢复仅扫描本组件受管的 UUID 任务目录。中断任务变成 `worker_restarted`，旧内容删除，要求新 key 重试；不冒充已完成、也不自动重复计费转换。
- WPS 进程使用 Windows Job Object：先 suspended 创建、加入 kill-on-close 容器再恢复，超时/取消/父进程退出回收自己的进程树。绝不 `taskkill /IM wps.exe`。WPS 自身已运行的共享 broker 不一定属于子进程树，无法承诺清理它；应使用专用 Windows 账号/节点隔离渲染服务并监控 WPS 后台进程。
- 字体采用 `AddFontResourceExW(..., flags=0)` 临时会话可见加载，完成后 `RemoveFontResourceExW`；不写系统字体目录或注册表。Windows 已存在同 SHA 的文件时跳过上传，但**仍需在任务所在的后台会话注册**，仅存在于用户字体目录不代表 WPS 后台进程已加载。实际后台实测已验证这一区别；同 full/PostScript face 不同文件 SHA 明确拒绝，不覆盖系统字体。Regular/Bold 等不同 face 可以同 family 共存。
- WPS 子进程树以低于普通应用的优先级运行，默认限制合计提交内存 1.5 GiB（`process_memory_limit_bytes`，提交内存不等于常驻物理内存）。限制过低可能导致 WPS 启动/字体初始化卡住。日志最多 1 MiB × 3 份，保存在服务目录 `logs/`。复杂文件超过资源限制会明确失败，不静默降低清晰度。
- ZIP 检查不是对 Office 漏洞的完整沙箱。为减少攻击面，Windows 账号应最小权限，WPS 保持安全更新；用防火墙限制转换节点出站到确有必要的服务，切勿提交不可信文件到管理员桌面会话。WPSCLI 是否需联网或账号取决于其版本和许可，不能保证它完全离线；涉密部署必须自行审计网络行为。
- 磁盘上限由流式上传限制/空间预约/运行中输出监测实现，不是操作系统级硬配额；对于恶意/异常第三方 WPS 进程，建议另外使用 NTFS 配额或专用小磁盘。WPS 自己写在用户配置目录的缓存不由本组件递归清空，避免删掉账号、其他文档或用户文件。

## 测试

```sh
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

测试使用模拟转换器，不要求 WPS/Windows，覆盖认证、v1/v2 容器验证、批量页面映射、逐页获取/ACK、能力协商、批次二分、取消、幂等、配额和单实例。发布前还需在实际 Windows 上做 WPS 转换、临时字体、进程超时回收、重启及磁盘压力联调；模拟测试不应被表述为已经验证全部真实 Office 兼容性。
