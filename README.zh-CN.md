# dsh-rules

[English](README.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 OMP 规则。

从 OMP 支持的每一种约定中发现规则文件，把 always-apply 与 rulebook 层注入系统提示词，让模型按需加载规则正文，并强制执行**时间旅行流式规则（TTSR）**——在当前轮次中途打断违规的模型输出。

## 安装

```bash
dsh plugin --profile <name> add @ndsanes/dsh-rules
```

然后把这一行加入该 profile 的 `cordis.patch.yml`（如果包自带的 bundle patch 尚未应用的话），并重新加载该 profile。

如果该 profile 已经用另一个包名装着这个插件——一条陈旧的 `link:` 依赖，或一个 `dsh.profile.bundles` 条目——那么在重新添加之前，必须把它从 `dependencies` 和 `dsh.profile.bundles` **两处**都移除。加载器按**当前**包名去解析 bundle 行，陈旧条目指向的模块在 profile 里已经不存在，启动时只会报一句 `import failed`。插件这边对此无能为力。

## 规则文件

规则是一个带 YAML frontmatter 的 Markdown 文件：

```markdown
---
description: Read before writing a database migration.
globs: "Database/**/*.surql"
condition: "DEFINE (FIELD|TABLE|INDEX)"
scope: "tool:edit(*.surql), tool:write(*.surql)"
interruptMode: always
---

The migration body.
```

| 字段 | 含义 |
|---|---|
| `description` | rulebook 列表中必须有此项。 |
| `alwaysApply` | 把整个正文注入系统提示词。 |
| `globs` | 路径闸门；TTSR 规则至少需要一条匹配的候选路径。 |
| `condition` | 正则触发条件（也接受旧式 `ttsr_trigger`）。 |
| `astCondition` | ast-grep 结构化触发条件，在工具参数上检查。 |
| `question` | 由裁判模型回答的自然语言问题。 |
| `scope` | `text`、`thinking`、`tool`、`tool:<name>(<glob)`。 |
| `agents` | 代理名 glob；`main` 与 `sub` 为保留值。 |
| `interruptMode` | `never` \| `prose-only` \| `tool-only` \| `always`。 |

在规则编辑器里，取值固定在某个词表内的字段（目前只有 `interruptMode`）是下拉框，值不可能被拼错。这一点比「少一个下拉菜单」要紧得多：一个无法识别的 `interruptMode` 不会被拒绝，而是落回 profile 的默认值，而这个默认值是 `always`——于是一条本想保持安静的规则，反而变成了打断一切的那条。下拉框的第一项表示「沿用 profile 默认值」，选中它会把这一行**从文件里删掉**；写成 `interruptMode: ''` 则会被判为无法识别，落到同一个默认值。

写正则时使用单引号 YAML 标量。双引号标量会把 `\s`、`(` 以及 `(` 系列的序列当作 YAML 转义处理，导致 js-yaml 拒绝整份文档。此时插件会退回到逐行读取该块并仍然恢复出该值，所以规则依旧能加载、依旧能匹配——但这种恢复无法还原 YAML 已经拒绝掉的转义序列，因此应当采用的写法是单引号形式。

## 发现

| 提供方 | 优先级 | 来源，按从具体到宽泛排序 |
|---|---|---|
| `native` | 100 | `<cwd>/.omp/rules/*.md(c)`、`<userRulesDir>/rules/*.md(c)`、粘性 `RULES.md` |
| `omp-plugins` | 90 | 每个已配置 `pluginRoots` 条目下的 `rules/` |
| `agents` | 70 | `.agent/rules`、`.agents/rules`，先项目后用户 |
| `cursor` | 50 | `<cwd>/.cursor/rules`、`~/.cursor/rules` |
| `windsurf` | 50 | `<cwd>/.windsurf/rules`、`~/.codeium/windsurf/memories/global_rules.md` |
| `cline` | 40 | 最近的 `.clinerules`，文件或目录均可 |
| `github` | 30 | `.github/instructions/*.instructions.md`，`applyTo` 会被归一化 |
| `builtin-defaults` | 1 | OMP 自带的规则，随包发布于 `src/builtin-rules/` |

行内顺序是有实际意义的：规则的标识只取决于规则名，合并时保留第一个认领该名字的规则，因此用户的 `~/.cursor/rules/style.md` 会输给工作区中同名的 `<cwd>/.cursor/rules/style.md`。

### 自带规则

`src/builtin-rules/` 以原样、MIT 许可、同名的方式收录了 OMP 的 27 条默认规则——TypeScript、Go 与 Rust——因此在任一 harness 中的规则文件都能覆盖另一份。它们是事实来源；`pnpm run embed:rules` 会把它们内联进 `src/generated/builtin-rules.ts`，因为打包器无法把 Markdown 当作文本导入。其中每一条都是限定到某文件类型的 TTSR 规则，且都不会阻止写入。Go 与 Rust 规则基于重建出的源码做正则触发；那三条依赖 `astCondition` 的规则则受 [与 OMP 的差异](#differences-from-omp)中说明的文法限制约束。

## Plugins 页面

`dsh-rules` 自带一个浏览器端实现。同样这两个区域会出现两次：在 Plugins 页面上本插件自身的条目下，以及 **Settings → Plugins** 的一个标签页里——去配置插件时人们去的是设置页。两者渲染的是同一个组件；Settings 标签页不携带插件 subject，因此这一侧不做 subject 检查。

本插件自身的配置项——`enabled`、`userRulesDir`、`pluginRoots`、`copilotInstructionDirs` 以及 `ttsr` 块——根本不由这个插件绘制。宿主会从 `Config` schema 推导出一张表单，按 profile 行 id 渲染它。这也解释了为什么开关在设置页里，哪怕部署方从未打开过上面这个面板。

**规则审计**——先给数字，再给明细：

| | |
|---|---|
| 统计行 | 发现的规则、生效中的、已关闭的、在此交付的、在别处交付的、从未触发的 |
| 占比 | 规则来自何处，按来源约定拆分 |
| 占比 | 哪些处于生效状态 |
| 占比 | 它们因何触发——`condition`、`ast-grep`、`question` |
| 排名 | 最常交付给模型的规则 |

前三个是构成图，不是排名图：一条整宽的条形按占比切分，旁边配图例。为每个类别单独画一条条形严格劣于直接读数字——占主导的类别会占满整个轨道，次要类别只剩一个小残段，于是长度传达不出标签之外的任何信息。只有交付规则那张图是排名图，所以只有它用条形。dsh 的 web 客户端不带任何图表库，而 `dsh-usage-chart`——唯一会画图的社区插件——也记录了同样的结论：一个与平台自身渲染相匹配的自绘 SVG，比引入一个外部库更小也更稳。

交付计数持久化在 `$DSH_HOME/dsh-rules/triggers.json`，因为只存在于内存里的计数在每个未曾亲自交付过规则的进程中都会读作零——而会话在 web 应用、CLI 与一次性运行中都一样。一条交付指一条规则确实到达了模型：一次中断、一条折进工具结果里的提醒、一次被拒绝的调用，或一条经裁判的警告。

账本是按 profile 组织的，而规则集是按工作区组织的，因此某个计数可能指向这条工作区从未发现过的规则。页面把两者分开——`deliveries here` 只统计屏幕上的规则，其余一律显示为 `delivered elsewhere`，不会被折进工作区的数字里。

图表之下是明细列表：

| 控件 | 作用 |
|---|---|
| 按来源筛选 | 每种约定一个条目，附带计数：`Bundled with the plugin 27`、`.omp/rules 2`，以及该 profile 贡献的其他提供方 |
| 按文本筛选 | 匹配规则名、描述与来源路径 |
| 每行 | 名称、是否生效、描述，以及 `source · path` |
| 未生效的行 | 说明原因，如 `off · listed in ttsr.disabledRules` |

Host 下发稳定的原因代码（`disabled`、`builtins-off`、`agent-filter`、`no-trigger`、`shadowed`），由页面做本地化；页面无法识别的代码会原样显示，不会被压成"未知"。`rule` 工具则把同样的代码用英文拼写出来，因为它的读者是模型。

**自带规则**——已发布的 27 条规则，按族分组（`ts` 13、`go` 8、`rs` 6），带文本筛选器，位于审计下方的同一页面。每行都有自己的开关，这直接生效；旁边的复选框只负责选中，下方的条则一次性作用于整个选区——`Select all`、`Invert selection`、`Disable N selected`、`Enable N selected`。

插件不去动带键的 `plugins.row.config` 槽位：那是平台为该条目提供的配置表单，动了它就会让所有非开关式的设置无路可去。读取来自审计；写入走配置表单，它持有 profile patch。`ttsr` 块是易失的，所以改动在下一步就会生效，而无需等到下次重启；审计发现配置发生变化时会自行重建。

页面从 `--dsw-*` 令牌取样式，而不是引入 dsh 的客户端包：那些包在客户端线上是分版本的，把其中一个拉进宿主包的依赖树，会把会话投影的第二份副本也一起拖进来。

## 管理规则

`rule` 工具就是管理界面。

| 调用 | 效果 |
|---|---|
| `{"name": "x"}` | 加载一条规则的正文。 |
| `{"action": "list"}` | 全部规则、其状态，以及未生效规则为何关闭。 |
| `{"action": "disable", "name": "x"}` | 关闭一条自带规则。 |
| `{"action": "enable", "name": "x"}` | 重新开启一条自带规则。 |

开关通过设置服务写入 profile patch，因此能跨重启持久化；又因为 `ttsr` 配置块是易失的，它们在**下一步**就会生效，而不是等到下次重启。当部署没有设置服务时，工具会如实说明，并打印需要添加的确切 YAML。它不会声称做了并未做的改动。

只有自带规则可以开关。用户规则或项目规则由它们各自的文件管辖，工具会指向那个文件，而不是替你编辑它。

基于文件的等价物是 `ttsr.disabledRules`（一个名称列表）和 `ttsr.builtinRules: false`（全部）。

规则的标识只取决于名称，因此被更高优先级提供方认领的名字获胜，落败者被丢弃。粘性 `RULES.md` 永远共用名字 `RULES` 且总是生效；因此用户粘性文件遮蔽项目的那份，而 `rules/RULES.md` 又遮蔽前两者。

## 三层结构

1. **rulebook**——`<domain-rules>` 中的 `- <name> (<globs>): <description>`。正文不占用常驻上下文；模型按名称加载它。
2. **always-apply**——`<generic-rules>` 中的整个正文。
3. **TTSR**——带有任意触发字段的规则。它会被注册，离开另外两个桶，并在模型仍在书写时强制执行。

## 引用一条规则

dsh 没有内部 URL 协议注册表，因此 `rule://<name>` 地址由一个面向模型的工具提供。提示词中会公布 `rule://<name>`；模型用该名称调用 `rule`，收到 Markdown 正文。名称未知时，会回答可寻址规则的列表。

快照覆盖全部三个桶，因此被触发的 TTSR 规则在触发之后仍可再次读取。

## 写入一条规则

这个工具也能写。当用户说出一条下周依然成立的约束时，系统提示会告诉模型把它写下来，而不是只服从这一次：用 `action: "create"`、一个名字、一段 `frontmatter` 和一个 `body` 调用 `rule`，文件会落到该作用域解析出的目录里（见下）。它会像任何其他项目规则一样进入审计，因此可以在面板里编辑或删除。

有五样东西会被拒绝：

- **名字其实是一条路径。** 名字会变成文件名，所以 `../`、路径分隔符、前导点，以及文件系统保留的字符，都会在任何内容被拼接到路径之前挡住它。
- **名字已被某条规则占用。** 两个文件抢同一个名字，意味着最终只有一个会生效。
- **正文为空。** 那样就没有任何东西可供模型阅读。
- **frontmatter 完全没有设置。** 这个文件加载时既没有触发条件也没有描述，进不了任何桶，永远到不了模型。这里刻意把门槛设得很低：被 js-yaml 拒绝的块，frontmatter 读取器会逐行恢复，所以引号写坏仍然能得到一条能生效的规则，不会被拒绝。
- **文件已经存在。** 创建是独占式的，并且检查的是磁盘而不是已发现的规则集合——一条解析失败的规则不在那个集合里，否则它会被悄无声息地覆盖掉。

返回结果会要求模型报告它写到了哪里，因为文件归用户审阅。

### 规则落在哪个目录

同时存在两套约定。OMP 把项目规则放在 `<cwd>/.omp/rules`，用户规则放在 `~/.omp/agent/rules`。dsh 自己没有规则目录——它读的是 `<cwd>/.dsh/AGENTS.md`、`<cwd>/.dsh/skills` 以及 `$DSH_HOME` 下的同名路径，没有任何规则形状的东西——所以本插件定义了 `<cwd>/.dsh/rules` 与 `$DSH_HOME/rules`，沿用那套布局。

选择是**按作用域分别判定的，OMP 优先**：

| 作用域 | OMP 目录 | dsh 目录 |
|---|---|---|
| 项目 | `<cwd>/.omp/rules` | `<cwd>/.dsh/rules` |
| 全局 | `<userRulesDir>/rules` | `$DSH_HOME/rules` |

某个作用域下只要已经有至少一条规则在 OMP 目录里，就继续往 OMP 写；一条都没有，就用 dsh 路径。存在但**空的** `.omp` 目录不算数——它可能属于别的工具。两个作用域各自独立判定，所以一个 OMP 项目不会把你的全局规则也变成 OMP 的。

两个目录都会被 discovery 读取，所以规则放在哪都是一样的生效方式。

### 在两套约定之间迁移

`rule` 的 `action: "migrate"` 会把一个目录里的全部规则搬到另一个目录。这是两条互相独立的轴，所以四种移动都表达得出来：

| 移动 | 参数 |
|---|---|
| `.omp` → dsh，同作用域 | `toConvention: "dsh"` |
| dsh → `.omp`，同作用域 | `fromConvention: "dsh"`, `toConvention: "omp"` |
| 项目 → 全局 | `toScope: "global"` |
| 全局 → 项目 | `scope: "global"`, `toScope: "project"` |

两个目标参数都是可选的，**省略即表示这一轴不变**：省略 `toScope` 表示作用域不变，省略 `toConvention` 表示约定不变。只动一个轴的移动只需要一个参数；两个轴也可以同时改变。

迁移只改变位置：两端都会被 discovery 读取，所以规则的名字、正文和作用都不变。有三样东西会被拒绝：

- **目标已有同名规则。** 两个文件抢一个名字，只有一个会生效，而输的那个在审计里根本看不见，因此已有规则胜出，另一份留在原地。
- **`RULES.md`。** 粘性规则是按它所在目录解析的，搬动文件会悄悄改变它管的是哪个工作区。
- **同目录互搬。** 否则会把文件报成「已移动到它自己」。

两端在同一文件系统上时用 rename 搬运，否则退回到「先复制、确认落盘后再删源文件」——项目在外置硬盘上而 home 在内置盘时，rename 会抛 `EXDEV`。只有复制成功之后才会移除源文件，因此一次中断的迁移不会弄丢规则。事后会逐条汇报：哪些搬走了，哪些留在了原地。

## 强制执行

在 `agent/assistant-stream` 上，每一段文本、推理与工具参数增量都会与符合条件的规则做匹配。

- 匹配命中且其 `interruptMode` 允许时，立即调用 `agent.cancel({ kind: 'hook', reason }, { keepInbox: true })`，随后立即把规则正文重新引导回上下文，这样下一轮循环运行时，开头就带着这条规则。
- 散文命中但不打断时，在助手消息完成后作为提醒交付。
- 工具命中但不打断时，通过 `tools/post-execute` 把 `<system-reminder>` 折进该次调用自身的结果中，置于工具内容之前并原样保留工具内容。
- `tools/pre-execute` 会拒绝那些重建出的源码违反了规则、且其中断模式覆盖该工具面的调用，因此违规永远不会触及文件系统。一次拒绝不会在重复账本上花费任何额度：拒绝一次写入不算交付，因此 `repeatMode: once` 的规则会持续拒绝，不会在第二次尝试时放行。

工具给出的路径会以规则可能写出的每一种形式做匹配：字面参数、相对工作区的形式，以及其 basename。否则，一条限定 `Docs` 前缀的规则在工具以绝对路径指名的文件上就会悄悄什么都匹配不到。
- `question` 规则在某段输出完成后才被提问，且只能给出警告。

默认值与 OMP 一致：`interruptMode: always`、`repeatMode: once`、`repeatGap: 10`、`builtinRules: true`、`contextMode: keep`。

`repeatMode` 管的是交付——中断、提醒与裁判警告。pre-execute 的拒绝不算交付，也永远不会被它抑制。

## 配置

```yaml
- id: dsh-rules
  name: '@ndsanes/dsh-rules'
  config:
    enabled: true
    userRulesDir: ~/.omp/agent
    pluginRoots: []
    copilotInstructionDirs: []
    ttsr:
      enabled: true
      interruptMode: always
      contextMode: keep
      repeatMode: once
      repeatGap: 10
      builtinRules: true
      disabledRules: []
      judge: auto
      judgeProvider: ''
      judgeModel: ''
```

这三个路径设置项接受开头的 `~`，并在发现流程读取之前将其展开为用户主目录；其余内容一律按字面取值。

<a id="differences-from-omp"></a>

## 与 OMP 的差异

- **`rule://` 是工具，不是 URL 协议。** dsh 没有内部 URL 注册表，因此这一寻址形式写在 `rule` 工具的契约里。
- **中断与提醒的交付是 user 角色的消息。** dsh 通过 section registry 组装每一步的系统提示词，因此在轮次中途注入的消息对模型可见，但不具备系统权威。一个被要求重复某个禁用词、随后又通过提醒被告知规则的模型，曾被观察到权衡两者之后仍然输出了那个禁用词——这是 `interruptMode: never` 路径按规范行事。请把提醒视为强力的引导，而不是保证。
- **`contextMode: discard` 未实现。** dsh 在中止时会把助手的不完整输出持久提交，且不提供移除方式，因此默认是 `keep`，被打断的不完整消息会留在历史里。
- **裁判是一条配置好的路由，而不是一个角色。** OMP 会把 `judge` 解析到一个原生 System One 模型并读取一个概率值。这里必须同时设置 `judgeProvider` 与 `judgeModel`；裁判对每个问题回答 YES/NO，无法解析的回答计为"未违规"。
- **`matcherPaths` / `matcherDigest` 并不存在。** 候选路径来自工具参数，源码快照则来自 write、edit 或 multi-edit 将要产生的参数。
- **AST 文法就是自带的那些，Go/Rust 不在其中。** `@ast-grep/napi@0.45` 只提供 TypeScript、Tsx、JavaScript、HTML 和 CSS——`parse('Go', src)` 会抛出 `Go is not supported in napi`，而插件并不注册动态语言，因此那三条自带、带有 `astCondition` 的 Go 规则（`go-range-int`、`go-bench-loop`、`go-new-expr`）在这里无法触发。它们的模式仍保留在规则上，并且每条都会记录一条警告，于是它们注册为流式规则并主动说明自身的限制；文法未知的路径会被跳过，不会被错误解析。原生插件在首次 AST 匹配时于一个 guard 内加载，因此没有预编译产物的平台只会影响那一个界面，插件本身照常加载。
- **开关写进 profile patch。** `rule` 工具通过设置服务写入，因此没有挂载设置服务的部署会退回到打印 YAML。`settingsNamespace` 指定 profile 行，默认是 `dsh-rules`，与随包的 `cordis.patch.yml` 一致。
- **注入状态按会话计。** 已注入的规则名不会持久化到会话日志中，因此重载会让 `repeatMode: once` 的规则重新变得可触发。

## 晚期挂载

插件可以挂载进代理已经存在的 harness——一个本来就在运行的 web 应用，或一个比重载活得更久的会话。`agent/created` 是热路径，但不是唯一路径：任何能指名某个代理的界面都会在首次使用时构建该代理的会话，因此预先存在的代理从它的下一步起就受规则管辖。它不会在无规则状态下运行。

有两条值得知道的后果：

- 提示词组装与流式帧无法等待发现流程，因此晚期挂载之后的第一次组装会在构建运行期间渲染为不含规则层的版本。下一次组装就会包含它们。
- `tools/pre-execute` 是异步瀑布，因此第一次工具调用会等待发现完成，然后按规则求值。那次调用中的违规仍然会被阻止。

`rule` 工具会区分"仍在发现中"与"不存在任何规则"，因此早于挂载的会话会明说这一点，不会看起来像一个坏掉的规则目录。

## 开发

```bash
pnpm install
pnpm test           # vitest
pnpm typecheck
pnpm build          # embed rules, tsc, host bundle, client bundle + loader envelope
pnpm run embed:rules   # after editing anything in src/builtin-rules/
```

`scripts/audit-rules.ts <project>` 会打印插件从一份真实规则集中解析出的内容，这也是检查对既有 `.omp` 目录的向后兼容性的方式：

```bash
npx tsx scripts/audit-rules.ts /path/to/project
```

`scripts/render-prompt.ts <project>` 会把插件挂载到真实的 dsh 系统提示词服务上，并打印模型将会收到的提示词。它不需要模型调用，因此在提供方不可达的机器上也能验证提示词注入：

```bash
npx tsx scripts/render-prompt.ts /path/to/project
```

`scripts/verify-interrupt.sh [dsh-home] [fixture]` 会针对一个存活的 dsh 把同一个提示词跑两遍——一遍用会中断的规则，一遍用只警告的同样规则——并打印两份记录，让差异本身成为证据。fixture 是一个包含 `.omp/rules/no-banana.md` 与 `.omp/rules/no-banana-quiet.md` 的目录；两者在每一条退出路径上都会被停放并恢复，因此一次被打断的运行不会让它落到两条规则都没有的状态：

```bash
scripts/verify-interrupt.sh /path/to/isolated/dsh-home /path/to/fixture
```

`tests/interrupt-loop.spec.ts` 离线运行同一场景：它通过 dsh 测试套件挂载真实的 `AgentLoop`、`SessionStore`、`LlmRuntime` 与工具注册表，把它们指向一个脚本化适配器——该适配器在首次回复时就违反规则——并断言中止、`<system-interrupt>` 重试、`interruptMode: never` 时的 `<system-reminder>` 路径，以及 `repeatMode: once` 会花掉这条规则。

## License

MIT