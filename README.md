# 用量与成本 · Usage & Cost

基于 DSH 本机真实会话日志的统计插件：总 token 消耗、所选时间范围内每个「提供商 × 模型」的用量与占比、会话数量、按 token 用量估算的成本与预算、token 消耗时间线、各会话用量与成本。

插件由两半组成：

- **Host**（`index.js`）：只读扫描 `$DSH_HOME` 下的会话投影缓存与 `session.v4.jsonl.zstd` 会话日志，计算 token/成本，并通过带鉴权的 HTTP 前缀路由 `/usage-stats` 提供给前端。
- **Client**（`client.js`）：纯 React（无构建、无外部依赖）的浏览器插件。在输入框上方注册一个实时指标条（pill），点击打开完整看板：KPI、模型占比饼图、时间线、会话明细与预算。

## 界面

- **输入框指标条**：总 token、估算成本、预算进度；加载/错误状态不会破坏输入框。
- **看板（覆盖层）**
  - KPI：总 Token（输入/缓存/输出拆分）、会话数（主会话/子代理）、估算成本（总/今日/本月）、预算（已用/剩余/月末预测；预算可点击修改并按浏览器保存）。
- 模型占比：与页头右上角时间范围**联动**（近 3/7/14/30 天）的环形饼图 + 明细列表，按**提供商 × 模型**分组（同一模型走不同 provider 分开算，避免同名混淆）。扇区悬停显示该组的提供商、token、成本、请求数与占比，中间显示所选范围的合计；右侧两列明细按 token（或成本）从大到小、先填满第一列再填第二列，每行给出完整模型名、提供商标签、占比、token 与成本。默认按 Token 计算占比，可切到成本；取前 9 组，其余合并为「其他 N 个模型」，模型名不在价目表里时行首标 `≈`。
- 配色：**同一模型在所有卡片里同色**（饼图、价格条模型 chip、会话明细里的模型分布条）。颜色按全时段 token 排名分配给模型家族，前几名固定不变，切时间范围不会换色；同一模型出现在多个 provider 时，第二个起用同色系变体（同色相、压暗一档），既能认出是同一个模型，又能分清是哪条线路。
  - 价格条：当前处于高峰/空闲时段、对应每百万 token 单价、模型构成、估算口径说明。
- 时间线：按天堆叠柱状图（输入/输出/缓存读取），可在 Token 与成本之间切换，悬停查看当日明细，范围选项为近 3 / 7 / 14 / 30 天。
  - 会话面板：搜索、主/子会话筛选、按时间/Token/成本排序；点击行懒加载该会话的逐轮 token/成本明细与模型拆分。
  - 页脚：数据来源、计价说明、统计时间、告警（如有）。
- 明/暗主题均使用宿主主题 token；看板字号整体按 1.12 倍放大（CSS 内绝对 px，最小 10.1px）；390px 宽移动端可用；支持 `prefers-reduced-motion`；Esc/背景点击关闭。

## 安装（本机已安装）

插件以本地 bundle 形式安装在 `desktop` profile 中：

```powershell
$dsh = "C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add "C:\Users\<user>\Documents\deepseek-harness\default-workspace\plugins\usage-stats"
```

该命令会通过 pnpm 链接本目录、加入 profile 的 bundle 列表，并由运行中的 Harness 通过 HMR 热加载，无需重启。卸载：

```powershell
& $dsh plugin --profile desktop remove @todrink/dsh-usage
```

> 插件是 `link:` 到本目录的；修改这里的文件后，看板客户端代码需要一次页面刷新（开发时可打开下方 `devReload`）。

## 配置

配置位于 profile 的 `cordis.patch.yml`，或本包 `cordis.patch.yml`（作为 bundle 安装时）：

```yaml
- insert:
    - id: usage-stats
      name: '@todrink/dsh-usage'
      config:
        budgetCny: 100        # 预算金额（人民币）
        budgetPeriod: month   # month | all
        includeSubagents: true
        timelineDays: 30
        refreshSeconds: 30    # 统计数据缓存时间；CPU 始终实时
        debugFile: ''         # 开发用：写快照/请求日志的绝对路径前缀（交付默认空）
        devReload: false      # 开发用：监听本包文件并触发 HMR 重载（交付默认关）
        prices:               # 可选：覆盖或新增模型单价（CNY / 百万 token）
          deepseek-flash:
            peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
            offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
```

## 数据来源与口径

- 会话列表与 token 总量：`$DSH_HOME/storages/session_projcache/sessions/*.json` 中的 `tokenUsage.totals`。
- 时间线/逐轮明细：`$DSH_HOME/sessions/<workspace>/<id>/session.v4.jsonl.zstd` 中提交的 `assistant/message` 事件（`usage` 字段与事件时间）。这些日志是**多个 zstd frame 顺序拼接**的文件，Node 内置解码只解第一帧，插件按 zstd magic 切分逐帧解压。
- 日志与投影缓存按字段取较大值并统一缩放成本，兼顾“投影在 turn 结束时才落盘”的实时会话与“日志里没有 assistant/message”的计费请求；稳定会话两者 100% 一致。
- 子代理会话（`subagent.identity` 或会话头 `delegationDepth > 0`）默认计入总量，并单独标注。
- 模型占比按**事件时间**分天归入北京自然日（每天 00:00 切分），再按页头所选范围（近 3/7/14/30 天，含今天）累加；占比分母是该范围内所有 token 之和（切到成本时为该范围成本之和）。Host 侧下发的是逐日 `modelDaily`，切换范围在前端即时聚合，不触发重新扫描。
- 提供商取自每个 `assistant/message` 的 `data.message.source.provider`；旧日志缺该字段时回退到该会话投影缓存里 `modelSelection.lastUsed.provider`（只有最后用过的提供商可用，属近似）。同一 `model` 在不同 provider 下**分开统计**，行内以提供商标签区分。
- 全部处理为只读；唯一的写入是开发配置 `debugFile` 指定的快照/日志文件，默认关闭。

## 成本估算

按 DeepSeek 官方价目表（CNY / 百万 token，2026-11 查询自 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>）：

| 模型 | 输入·缓存命中（空闲/高峰） | 输入·缓存未命中（空闲/高峰） | 输出（空闲/高峰） |
|---|---|---|---|
| deepseek-flash | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| deepseek-v4-pro | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

- 高峰时段：北京时间周一至周五 09:00–12:00、14:00–18:00；其余为空闲（价格为高峰的一半）。法定节假日调整未单独处理，属估算误差。
- 单次调用的成本按该事件时间所在时段计价，缓存写入按缓存未命中输入计价。
- 未在价目表中的模型（例如自定义 provider 模型）按 `deepseek-flash` 单价估算，并在看板与告警中明确标注；可通过 `config.prices` 补充真实价格。

## 接口

Host 在 `ctx.webServer` 上注册带鉴权的前缀路由 `/usage-stats`（复用 Connection 的 `admit()`，浏览器 cookie/同源校验），接受 Connection RPC 信封：

- `POST /usage-stats/overview` → 汇总、时间线、会话列表（含 `modelDaily`：逐日逐 `provider/model` 的 token/成本/请求数，前端按范围聚合）
- `POST /usage-stats/session` `{id}` → 单会话逐轮明细

## 验证

- 模型占比：`_verify/model-share.test.mjs`（`node _verify/model-share.test.mjs`）在 vm 里加载真实 `client.js`，用最小 React 替身渲染 `ModelShareCard`，覆盖 zh/en 词条键一致与范围归一化、3 天窗口剔除 10 天前的模型、放宽到 30 天又出现、提供商标签与完整模型名、9+1 合并、占比合计 100%、饼图扇区覆盖整圈、悬停提示含提供商/token/成本、Token/成本切换、空范围、旧宿主回退、跨卡片同一模型同色、Dashboard 早退后不得再调 hook 共 12 组断言，全部 PASS。
- 模型占比的 Host 侧口径：`_verify/host-models.mjs` 用真实 `index.js` 起一个最小 Cordis 宿主，走自己的 `/usage-stats/overview` 路由读本机会话日志，校验每个桶都有 `provider`、逐日桶合计等于时间线同日 token/事件数、逐日成本与时间线一致、3/7/14/30 天窗口都非空。2026-11-23 实测 23 天有数据：近 3 天 1,038,215,358 token / ¥84.27、近 7 天 1,560,253,134 / ¥132.09、近 14 天 3,004,660,977 / ¥253.16、全部 3,813,029,670 / ¥314.65，PASS。
- 独立 oracle 实现（另行解压日志并重算）逐会话/逐日比对为 **PASS**：稳定会话 token 与成本完全一致，实时增长中的会话差值由快照时间差解释。见 `_verify/compare-report.txt`。
- 真实运行页面截图（明/暗/390px 移动端）、14 项交互回归（范围切换、排序、搜索、会话明细、预算编辑、Esc 关闭等）均通过，控制台无错误、无横向溢出。见 `_verify/shots/`。
- 交付配置已关闭 `debugFile`/`devReload`，运行时不会向工作区写任何统计快照。
