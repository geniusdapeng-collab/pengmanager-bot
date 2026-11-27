# 决策盲评

在同一组冻结的账号、权限、能力、预算和素材下运行两套决策，再由独立验收人检查动作和出处。评估过程只生成一次研究判断及渠道矩阵。它没有发布凭证，也不生成公开号结果。

## 本地回归

```sh
node scripts/bot-evaluate.mjs --out var/evaluation/fixture --seed isolated-regression
```

隔离题集有六组，每组四对，共 48 个输入。每组两对保留在留出集。回归覆盖实质勘误与重复转载、旧文缺口、读者适配、原始媒体、可支配预算以及主人材料是必选还是可选。每个输入经同一个 28 渠道路由器生成两份计划。保留输出目录为新目录，每个回执以独占方式写入。

- `blinded.json` 是交给验收人的 A/B 卷。每题顺序独立打乱，含材料出处、计划、所用权限摘要和下一判断时间。
- `key.json` 带回放种子、逐题 A/B 身份和题集摘要。独立验收完成前由主持人保管。
- `report.json` 保存逐题输入、封存标准、两臂原始判断、争议项和汇总。真实调研对应此文件中的计划快照与费用回执。
  
本地证据判断由合成材料规则驱动。它检验决策记录与渠道约束，并不代表实际模型通过盲评。

## 用授权题集执行真实模型判断

在有独立运行预算和组织许可时准备一个专用 JSON 题集。文件必须用 `pengmanager.bot.authorized-evaluation-input/v1` 结构、`dataMode: "real"` 和 48 条 `cases`。每条形如 `{input,expected}`，使用隔离输出中相同的案例字段。每对的授权动作、账号能力和总预算保持一致，每对同属校准集或留出集，各 12 对。允许 `expected.action` 为多个合理选项。

- `authority` 保存 `reference`、有效时间 `expiresAt`、明确提供者披露许可 `allowProviderDisclosure: true` 以及额度 `{currency,limitMinor}`。
- `pricing` 与批准的计价单一致，包含 `currency`、`reference` 及每百万词元的 `inputPerMillion`、`cacheHitPerMillion`、`outputPerMillion`，单位是最小货币单位。
- 每条 `input.sources` 引用已获准提供给模型的去标识材料，字段为 `{claimId,kind:"approved-deidentified",uri,text}`。`claimId` 在同题的 `input.opportunity.facts` 中处于 `approved`。允许补充此前确实公开的短摘录和绑定的更正候选，分别放入 `input.material.published` 与 `input.material.correction`。
- 提前冻结 `input.mandate.objective`、`input.now`、两个条件下可用的来源、动作边界和必要证据。真题及答案保存在权限受控的文件中。

先打印完整封存摘要给负责人核准。

```sh
node scripts/bot-evaluate.mjs --digest /private/sealed-cases.json
```

在专用进程提供 `BOT_EVAL_APPROVAL_DIGEST`、`BOT_MODEL_KEY` 和已挂载的独立持久卷 `BOT_EVAL_JOURNAL_DIR`，然后运行。

```sh
node scripts/bot-evaluate.mjs --real /private/sealed-cases.json --out /private/evaluation/run-001
```

运行器使用正式策略提示和返回值校验。每次实际模型请求先在专用账本持有上限，再以原响应号和 usage 结算。已读取的结果保存于输出下面的私有目录。遇到未清算账目或原任务不匹配，进程停止继续派发。只转交 `blinded.json` 给验收人。预封存规则的机器评分仍需人工盲审复核。

## 复核口径

逐题检查动作是否合理、证据是否有对应来源、应做未做、应停硬做、介入是否必要、渠道是否越权。盲测的 12 对中，如采用试点方案中的门槛，至少 10 对需两侧均给出可接受的动作及必要证据，再与冻结规则比较。来源捏造、范围越权和错误目的地单独记为阻断。任何生产模型质量结论必须回到实际授权题集、使用回执和独立验收记录。
