# 鹏经理 BOT 运行与恢复

## 本机演练

使用能加载项目原生依赖的独立 Node 24。安装依赖后，从项目根目录运行。〔B〕 [Node 24 的 SQLite 接口](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)

```sh
pnpm install --frozen-lockfile
node scripts/bot-admin.mjs demo --port 4320
```

打开 `http://127.0.0.1:4320/bot/`。终端会显示演练数据目录与本机登录文件的位置。该文件只含这个隔离实例的随机密码，由本机用户读取。演练写入 SQLite 委托及本机合成材料，回放生产、独立检查、单次许可、模拟回执和 T+1/3/7 排期。工作台将其标作演练，真实公开计数为零。测试与 CI 可用 `node scripts/bot-admin.mjs demo --port 4320 --once`。它启动同一宿主，检查环回 HTTP 后结束。默认另开私有临时目录，指定 `--data-dir` 可重开演练账本。

如果 macOS 的应用内 Node 无法加载 Team ID 不同的原生依赖，改用独立 Node。项目审核、图像和 tokenizer 继续走原生依赖。〔B〕 [Apple 的库验证说明](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation)

## 正式部署

目标 Linux 主机安装 Node 24，解包至 `/opt/pengmanager-bot`，按发行件 lockfile 安装。服务使用专用 `pengmanager-bot` 用户及组。主数据在 `/var/lib/pengmanager-bot`，独立持久存储挂到 `/srv/pengmanager-bot-journal`。两处应为物理路径、服务用户可写、模式 0700。宿主校验两处不同文件系统及日志卷标记。独立故障域由实际存储部署验证。

将普通配置保存至 `/etc/pengmanager/bot.json`，供服务用户读取。使用拥有且已接入的 HTTPS 域名替换示例。

```json
{
  "mode": "real",
  "origin": "https://site.example.org",
  "workspaceId": "personal",
  "projectId": "editorial",
  "ownerId": "owner",
  "modelEndpoint": "https://api.deepseek.com",
  "pricing": {
    "currency": "CNY",
    "reference": "deepseek-flash-cn-peak-ceiling-2026-11-27",
    "inputPerMillion": 200,
    "cacheHitPerMillion": 4,
    "outputPerMillion": 800,
    "searchPerRequest": 1
  },
  "sources": [],
  "browserWorkers": []
}
```

示例取当日核查的 Flash 人民币高峰上限，费率单位为分。独立 Search API 的公开刊例为每千次成功查询 5 元，示例将单次预留向上取整至 1 分。宿主按配置预留费用，保存原始供应商编号与实际 token 用量。金额按配置费率换算，核销以原账单为准。其他合同按实际价表填值，保持委托币种一致。〔B〕 [DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

管理员密码和模型凭据分别进入宿主凭据库。样例以 systemd 受控凭据为例。

```bash
read -r -s -p '管理员密码：' PM_SETUP_PASSWORD
printf '%s' "$PM_SETUP_PASSWORD" | node scripts/bot-admin.mjs hash-password |
  sudo systemd-creds encrypt --name=BOT_OWNER_PASSWORD_HASH - /etc/credstore.encrypted/BOT_OWNER_PASSWORD_HASH
unset PM_SETUP_PASSWORD

read -r -s -p '获准模型凭据：' PM_SETUP_MODEL_KEY
printf '%s' "$PM_SETUP_MODEL_KEY" |
  sudo systemd-creds encrypt --name=BOT_MODEL_KEY - /etc/credstore.encrypted/BOT_MODEL_KEY
unset PM_SETUP_MODEL_KEY
```

使用 `systemd-analyze verify` 校验服务模板，安装后可用 `systemctl start pengmanager-bot` 启动。模板监听环回 4320。TLS 代理保留真实 Host 和同源 Origin，关闭事件流缓冲，屏蔽公网的浏览器内部授权路由。原生管理端点由隔离管理员进程操作。选配 DEV、浏览器、通知凭据通过对应的 `LoadCredentialEncrypted` 属性注入。〔B〕 [部署单元](../deploy/bot.service) · [systemd 服务执行](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) · [systemd 凭据](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html) · [浏览器网关部署](../deploy/bot-browser/README.md)

## 独立健康探针

探针由独立的 systemd 定时器每分钟唤醒一次。它通过 TLS 入口请求 `GET /healthz`，核对响应中的服务标识与真实调度器就绪状态。每次检查有 5 秒上限。连续两次失败产生一条失联通知，下一次就绪产生同一事件的恢复通知。要覆盖 BOT 主机断电、主盘故障和入口中断，在另一台 Linux 主机运行探针，并使用独立的通知接收端。探针仅需发行件源码和 Node 24，可以在主 BOT 停止时运行。〔A〕 [探针](../src/bot/health-probe.mjs) · [探针服务](../deploy/bot-health.service) · [定时器](../deploy/bot-health.timer) · [systemd 计时器](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)

在探针主机将源码放到 `/opt/pengmanager-bot`，建立同名专用用户及组 `pengmanager-bot-health`。在 `/etc/pengmanager/bot-health.env` 写入实际被监测的 HTTPS origin 和一个便于辨认的稳定标识。

```ini
BOT_HEALTH_ORIGIN=https://site.example.org
BOT_HEALTH_MONITOR_ID=editorial-production
```

将 HTTPS 接收地址和 Bearer 凭据加入该服务的 systemd 加密凭据库。接收端须能通过此凭据鉴权并按 `Idempotency-Key` 去重，在取得实际送达回执后返回 HTTP 2xx 和 JSON `{"id":"原通知 ID","receiptId":"接收端回执号"}`。探针发送通知 ID、共用的 `incidentId`、`bot_health_lost` 或 `bot_health_restored` 事件类型、监测标识和 Unix 毫秒时间戳。失败通知另外附受控原因代码。接收地址和凭据仅经 systemd 凭据文件进入探针。〔A〕 [独立探针入口](../scripts/bot-health.mjs) · [systemd 加密凭据](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)

```bash
read -r -s -p '探针接收地址：' PM_PROBE_RECEIVER
printf '%s' "$PM_PROBE_RECEIVER" |
  sudo systemd-creds encrypt --name=BOT_HEALTH_WEBHOOK_URL - /etc/credstore.encrypted/BOT_HEALTH_WEBHOOK_URL
unset PM_PROBE_RECEIVER

read -r -s -p '探针接收端凭据：' PM_PROBE_TOKEN
printf '%s' "$PM_PROBE_TOKEN" |
  sudo systemd-creds encrypt --name=BOT_HEALTH_WEBHOOK_TOKEN - /etc/credstore.encrypted/BOT_HEALTH_WEBHOOK_TOKEN
unset PM_PROBE_TOKEN

sudo install -m 0644 deploy/bot-health.service /etc/systemd/system/pengmanager-bot-health.service
sudo install -m 0644 deploy/bot-health.timer /etc/systemd/system/pengmanager-bot-health.timer
sudo systemd-analyze verify /etc/systemd/system/pengmanager-bot-health.service /etc/systemd/system/pengmanager-bot-health.timer
sudo systemctl daemon-reload
sudo systemctl enable --now pengmanager-bot-health.timer
sudo systemctl start pengmanager-bot-health.service
sudo journalctl -u pengmanager-bot-health.service -n 10
```

服务将失联状态、排队通知和接收端回执保存在 `/var/lib/pengmanager-bot-health/health-probe.sqlite`。丢失接收端回执后，它从 30 秒起指数退避，最高 1 小时，按定时器的下一次到期检查继续发送同一 ID。恢复通知排在对应失联通知之后。同一 BOT 实例用一个监测标识和一份探针状态库。迁移时先停止旧定时器及其探针服务，再迁移整个状态目录，保留未送达通知和原接收端回执。〔A〕 [探针状态与重试](../src/bot/health-probe.mjs)

在隔离验收实例停止 BOT，等待两次检查，核对收到一条失联消息。保持实例停止再检查一次，确认同一事件只有一条送达记录。重启后核对与失联共用 `incidentId` 的恢复消息。需要验证接收端短时不可用时，在测试接收端暂时拒收，并在恢复后检查同一个 ID 和两个通知的交付顺序。本机回归使用 OpenSSL CLI 生成临时测试证书，并实际停止、重启隔离 BOT 进程。〔A〕 [探针回归](../tests/bot-health.test.mjs) · [OpenSSL 请求命令](https://docs.openssl.org/3.5/man1/openssl-req/)

## 第一次正式出品

### 从经营目标建立委托

登录后打开 **经营委托**，在目标栏填写一句话，再点 **从目标生成草案**。例如写“每天追踪已登记的公告，接单后三天内交付，仅研究，先试两周”。草案会填入能够确定的启动频次、交付时限、到期日和工作范围。遇到多个频次、不同期限或含糊的工作范围，在表单内手动选择后再预览。

页面下方按照当前登记记录展示信源、账号、可选的准确代办目标、已核事实、主题、官网版本以及制作服务的配置状态。本人可勾选信源，并选取没有来料事实时允许使用的已核事实。每次工作仍会重新验证事实的使用状态和有效期。填写真实预算，核对后签发。自由文本中的预算、发布目的地或代办要求只保留在目标文字中。研究范围交付已核事实清单或证据缺口。私有草稿走原生制作和审核，正文只在登录后查看，不创建外站提交或本人代交包。

### 快速停发

在 **经营委托 → 快速停发** 明确选中一条有效委托，输入 `停发`，再点 **撤销所选委托**。正式撤权按页面显示的当前委托版本办理。空选择、含多个范围或附加条件的指令不会提交。版本变化时刷新后重新选择。已在途的提交继续按原操作号核对，既有发布如需撤回则单独依原站规则办理。

### 自有站点与账号资格

在 `/login` 登录后建立一条专用于账户和目的地核实的委托。可以提交如下请求体。本人填写真实费率、额度、内容范围及期限。

```json
{
  "objective": "核实自有网站及待接入账号的权利、规则与准确目的地",
  "trustScope": { "adminReviews": true },
  "requiredOutcomes": [],
  "budget": { "currency": "CNY", "limitMinor": 1500 },
  "idempotencyKey": "site-setup-authority-001"
}
```

```bash
read -r -s -p '管理员密码：' PM_OWNER_LOGIN
printf '%s' "$PM_OWNER_LOGIN" | node scripts/bot-admin.mjs api \
  --origin "$PM_BOT_ORIGIN" --path /mandates --method POST --input "$PM_SETUP_MANDATE"
unset PM_OWNER_LOGIN
```

`api` 连接运行中的 BOT，标准输入只接收管理员密码，完成后会注销临时会话。以下原生本地管理命令需暂停这个数据目录上的主服务，独占现有原生状态写入锁。CLI 用相同的 `BOT_CONFIG`、`BOT_DATA_DIR`、`BOT_JOURNAL_DIR` 及由受控进程注入的宿主凭据。生产可通过带相同 `LoadCredentialEncrypted` 属性的临时 systemd 服务执行。

运行 `node scripts/bot-admin.mjs inspect` 读取原生目的地、账号、版本和有资格的 Claim。已有核实通过的准确官网目的地可复用。若缺失，先以 `native-destination --input FILE` 提交原生草案。外部阵地先以 `native-account --input FILE` 登记实际公开主页，再建立从属目的地。

```json
{
  "idempotencyKey": "site-destination-001",
  "body": {
    "platformId": "official-site",
    "kind": "owned_origin",
    "name": "自有官网文章栏目",
    "locator": { "origin": "https://site.example.org" },
    "visibility": "public"
  }
}
```

随后用另一份 JSON 更新创建回执的 `id`，填该回执的 `ifMatch`、新的幂等键及 `body`。`body` 包含 `status="active"`、`identityConfirmed=true`、`policyStatus="reviewed"`、实际的 `policyCheckedAt`、可核对的 `reviewNote` 和 `sourceExcerpt`。引用支持真实所有权和公开范围的资料。使用 `native-destination --input FILE --review-mandate ID` 启动已获准的收费独立审核，也可提供已合法取得的原生 `reviewProof`。账号实行同样的核验。遇到结果或用量未知，从原任务继续对账。〔A〕 [原生编辑发布合同](CONTENT-PUBLISHING.md)

用 `capability --input FILE` 或已登录的 `POST /api/bot/v1/capabilities` 登记准确资格。自有官网输入包含 `channelId="official-site"`、原生 `destination`、`form="article"`、`action="publish"`、`visibility="public"`、真实 `expiresAt`、`policyRef`、`evidenceRef` 和幂等键。账号标签由宿主派生为 `owned:<ownerId>`。外部正式写还需要官方连接、已核准的该账号、原对象查询和可靠去重证据。DEV 配置需同时绑定 `dev.accountId`、`dev.userId`、`dev.username` 与受控 `BOT_DEV_API_KEY`。需要平台本人确认时登记 `mode="platform_confirmation"`，纸面提交或无自动能力时登记 `mode="manual"`。资格更新要提供当前 `expectedRevision`。

### 信源、事实和签章配图

正式公开任务使用在有效期内、有真实公开来源、低敏感并已核准的 Claim。`inspect` 返回可复用的事实 ID。已有原生私有事实的公开批准可走 `native-claim-approve --input FILE --review-mandate ID`，其中 `body` 提供真实 `sourceExcerpt` 与 `publicLevel="approved_public"`。另一条路径是在配置 `sources` 中登记已获准的 `json-feed` 或 `github-releases`，填写 `id`、公开 HTTPS `url`、`intervalMs`、语言、内容形式及既有 `claimIds`。获准从该来源审出新事实时再启用 `allowPublicFacts=true`，并把来源列入委托。实际来源、摘录及独立判断分别留痕。

JSON Feed 的同源条目可参与事实审核。需要接受单独的官方文档站时，在该 Feed 的 `itemOrigins` 列出准确的 HTTPS origin。GitHub Release 条目绑定已登记仓库。原址更正还需要该官网账号和目的地的 `replace` 能力与低风险授权，并在委托的 `trustScope.autonomousCorrections.sources` 列出允许自动匹配的来源 ID。自动匹配要求同一准确公开来源只对应一个当前公开修订，新事实在独立审核后与原事实不同。可以通过 `trustScope.websiteCorrection` 明确绑定更正的 `claimId`、`releaseId`、`contentId` 和 `slug`。

签发一条窄范围、短期限的正式官网委托。通过 `POST /api/bot/v1/tasks` 提交 `mandateId`、`title`、`claimIds`，也可以从 `/events` 登记实际线索、已审核 Claim 与稳定 `externalId`。任务回读展示原生 Job、28 行处置、审核和回执。

如果交付目标含正式 GEO 观测，将对应公开阵地的 `outcome="observation"` 列为必须成果，并在 `trustScope.geo` 写清楚 `provider`、固定 `queryIds`、题集版本 `questionRevision` 和按分计的 `reserveMinorPerRound`。在本文示例费率下，按一个问题、一次独立搜索和一个原生回答的完整上下文及输出上界，同一阵地单轮最低预留 526 分。多题按逐题上界相加。应用以配置和当前原生路由报价重新核验，要求委托到期时间晚于实际公开后的第 7 天。

发布最终放行前，T+1、T+3、T+7 分别在各自时间窗占用已签预算。无足够预算、题集失效、计量服务未就绪或授权期限不足时，正式必须观测目标停止发布并显示原判因。出品模型及其他不相关任务不能花这笔预留。真实发布后按原始公开时间校准，并以观测工作单从相应预留中承担费用。观测的未使用额度按回执或取消释放，已派发但费用未知的请求继续挂账。条件不满足时，账本保留已获得的公开结果、已核样本及实际观测缺口。

将受授权配图生产方的公开签章密钥以 `native-producer-key --input FILE` 登记。输入含幂等键以及 `body.label` 和 `body.publicKey`。私钥留在原生工位。用管理员会话读取 `GET /api/bot/v1/tasks/<id>/illustrations` 获取本次工单。工位提供真实 PNG 和同名 JSON，存到 `<BOT_DATA_DIR>/illustrations/<planId>/<slotId>.png` 与 `.json`。目录和文件由服务用户拥有，使用私有常规文件。先原子放入 PNG，再放 JSON。

```json
{
  "planId": "实际工单的计划编号",
  "slotId": "实际工单的图位编号",
  "sourceHash": "当前工单的完整摘要",
  "sha256": "实际 PNG 的完整摘要",
  "rightsNote": "实际使用权、素材来源和用途",
  "designerCompositor": { "statement": {}, "signature": "原生工位真实签章", "producerKeyId": "已登记签章工位编号" }
}
```

示例展示字段形状。图位需要 `imageGen` 时还需对应原生签章。宿主实际核对公钥、签章、图位、原字节和使用权。资料补齐后沿同一原生工作单接续。正式试点需逐项回读活跃 Release、匿名访问、正文及媒体摘要，确认 T+1/3/7 从公开时点排程。〔A〕 [原生配图证据实现](../src/domain/article-illustrations.mjs)

### 需要本人操作的阵地

配置一台专属云浏览器网关工位，在 `browserWorkers` 登记同一工位 ID 与可读标签。准确任务进入平台本人确认后，以当前配置执行 `assign-browser --input FILE`，提交 `targetId`、`taskId`、`channelId`、`accountId` 和幂等键。宿主重启加载新分配，接管期间继续读取当前任务、账号和委托。负责人在工作台申请短时接管，完成平台要求的本人动作后交还。登出、撤权、任务到期及账号范围变化会结束适用租约。必选交接在任务到期前保留待本人状态，到期未处理计入未达。采集本人提交声明时，用 `POST /api/bot/v1/tasks/<id>/owner-receipts` 记录原包、当前版本与原平台回执。工作台据此投影本人已报告，独立回读仍承担公开核验。

## 周报与 GEO 原始依据

周报的分母由接单时冻结的成果与各自截止日期决定。已接管云浏览器、本人确认、母稿外人工提交以及任务控制都保留当时的业务事件。登记平台回执时可以填写本次实际用时；周报显示有工时回执的条数与分钟数。未登记时长就留空。获准的替代成果有自己的材料或公开回执，原约定成果仍单独核对。

可用 `allowedSubstitutions` 为每个必选成果预签一个不同渠道的替代方案。每条写入 `forOutcomeId`、`outcome`、`channelId`、`accountId`、`destination`、`form`、`action`、`visibility`，账号与操作必须同时登记在该委托的 `allowedActions` 中。原路径在分流时不具备无人值守资格才会考虑启用替代；准备类只交审核后的包。原路径已经提交但结果不明时仍按原操作号对账。

每项委托的 outcomes 中，`geo.panels` 按观测面、提供方、题集版本与实际环境分组；同一运行和问题重复出现只计一次。原生运行号与样本号可回查原始记录。可选的运营配置 `geoProfile` 含 `language`、`region`、`access`、`evidenceRef`，用于登记部署者已核实的实际模型访问条件。委托的 `trustScope.geo.profile` 如指定了这些条件，必须与部署配置一致。变更配置会中断与原环境的样本配对。

可在 `trustScope.geo.subjectNames` 登记需消歧的名称。在 `verifiedReprints` 逐项登记经核对的原文地址 `originalUrl`、转载地址 `url` 和出处核验凭据 `evidenceRef`。系统依据实际回答里的引用及其对应原对象区分原文、已登记转载、仅出现名称、无引用及采样失败。只在搜索候选中出现的链接不能计为引用。旧轮次没有分类凭据时记入未分类。

## 有条件巡检

将试验来源配置为 `allowCadenceTrial=true`，再给一份没有必选交付的独立委托配置 `trustScope.learning`。设置 `sourceId`、`controlSourceId` 和 `minPairs`，两条来源都要列入委托。只有登记的一个试验来源可改变轮询频率。试验开始后等一周以获得实际受试发布的 T+7 样本。接下来两周分别与不变来源比较，两个窗口均需改善且单位支出未升高，才可延用新的频率一周。源头撤权、适用条件变化或有效样本不足时恢复原频率。

## 对账、续办和恢复

- 周报由云端账本的周期水位触发。主人连续离线时，服务按原周期继续冻结报告；服务停机跨过多个边界时，重启后逐期补齐。委托在周中到期时，最后一份报告截止到原到期时间，逾期未确认的必选成果保留在分母中。异机意图暂时不可用时，新一轮受理停在授权闸，系统继续保存和发送到期报告。通知包含 `reportId`、`mandateId` 和周期边界，同一份报告可在具备所有者权限的 `/api/bot/v1/mandates/<id>/outcomes` 读回。
- 日常停发在工作台撤销委托。先行撤权拒绝新放行，已进入在途的动作继续按原键核对。费用账本保留预留、未知和已核计量结果。网络中断后先查原对象或供应商回执。
- 一致备份要包含 `runtime-data-mode.json`、`bot.sqlite`、原生 JSON、GEO SQLite、签章目录、实际媒体、工作档案、费用凭据、浏览器授权与分配。保留故障域之外的独立意图日志。恢复到隔离副本，核定旧主机、生产工位及连接器确已停止。
- 进入恢复模式时执行 `node scripts/bot-admin.mjs recover --writer-fenced`。重放独立日志、租约、授权水位后在本机保留持久只读闸，直到所有已知在途效果及费用都对账。已验旧写者确实隔离，才能提交该标记。
- 已有原对象或明确未执行证据时，用 `reconcile-effect --writer-fenced --input FILE` 按同一 `operationKey` 登记。未核查的可见性继续待回读。用 `apply-cost --writer-fenced --input FILE` 调整同一费用记录。`{ "costId": "原费用ID", "fromSavedProviderReceipt": true }` 会比对收件箱中的供应商响应及哈希，采用该条原始用量证据。人工汇入原账单时提交 `providerRef`、`evidenceRef`、`actualMinor` 和相应状态。
- 执行 `node scripts/bot-admin.mjs complete-recovery --writer-fenced` 后读回 `readOnly=false`。去掉临时 `BOT_RECOVERY` 再启动。核对原任务 ID、原站公开回执、预算、新租约及后续复测。确需撤回已公开内容时，走原站针对该对象的撤回授权。

本地演练和自动测试使用隔离数据。云端验收另行使用获准账号、真实素材、实际费用证据与公开回执。
