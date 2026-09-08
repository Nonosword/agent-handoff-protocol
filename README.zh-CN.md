# Agent Handoff Protocol（AHP）

[English](./README.md) · **简体中文**

[![ci](https://github.com/Nonosword/agent-handoff-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/Nonosword/agent-handoff-protocol/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> 一份只追加的 worklog，让轮换工作的编码 agent 在某一个用量耗尽、下一个接手时不丢上下文。
> worklog 存在项目**之外**的一个 store 里——你的仓库不会被碰。

## 要解决的问题

你用多个编码 agent 在同一个仓库上干活——Codex、Claude、本地模型——每个用量到顶就换下一个。
agent 常常在**改到一半**时被切断，来不及交代。接手的 agent 面对的是：一堆没有上下文的未提交改动；
提交只显示"改了什么"，不显示"什么被跳过了"、"下一步做什么"；如果它相信一份手写总结，这份总结有相当概率是错的。

## 核心思路

按两种媒介各自擅长的事，把记录拆成两半：

| 问题 | 由谁回答 |
| --- | --- |
| 改了哪些文件、在哪几个提交里？ | **Git 历史** |
| 每次改动是**为了什么**？ | worklog —— `intent.*` |
| **此刻**什么没做完、什么没提交？ | worklog —— 有 `intent.open` 但没有 `intent.promote` |
| 坑和临时妥协在哪里？ | worklog —— `landmines` |
| 下一个 agent 该做什么？ | worklog —— `next` / `plan` |

```
handoff.start   ── agent 接棒：自己核实过的 base 提交 + gate 结果 + 计划
  intent.open      ── 一个小提交之前：我打算做什么
  intent.promote   ── 提交绿灯落地之后：实际做了什么 · 坑 · 下一步
  intent.open
  intent.promote
handoff.end     ── 停止时尽力而为：结束提交 + gate + findings + 未完成的 intent

handoff.start   ── 下一个 agent：核对上一个 base 以来的提交，
                   接管任何未完成的 intent，自己重新核实，继续
```

有 `intent.open` 却没有对应 `intent.promote`，就是下一个 agent 顺着找到 dirty tree 里那半截
未完成工作的指针——**即使上一个 agent 没写 `handoff.end` 就消失了**。

**Project** 负责识别 Git 仓库；**Lane** 负责区分同一项目中的一条完整工作流。每个 Lane
拥有独立的只追加 JSON-Lines worklog 和 baton，按整数 `seq` 排序，存在用户级 store
`$XDG_DATA_HOME/agent-handoff/` 下。已有的项目级 worklog 会作为合成的 `main` Lane
继续可读。项目仓库不会被写入，详见 [SPEC §4](./SPEC.md)。

## 安装

```sh
git clone https://github.com/Nonosword/agent-handoff-protocol ~/Repositories/agent-handoff-protocol
cd ~/Repositories/agent-handoff-protocol
./install.sh
```

安装脚本会分步骤逐条报告——把 `ahp` / `ahp-mcp` 软链到 PATH 并验证能跑、创建并探测 store、
部署**工作流**（Claude Code skill + Codex `AGENTS.md` 片段），然后（方向键选择）问你 agent
要不要额外获得原生 `ahp_*` 工具：

- **cli** —— agent 跑 `ahp` CLI；skill / 片段负责教流程。
- **mcp**（推荐）—— 以上全部，外加把 `ahp-mcp` 注册给每个检测到的 host：Claude Code /
  Codex 用各自的 `mcp add` CLI，Cursor / VS Code / Windsurf 合并进它们的 MCP 配置文件
  （绝不动文件里其他内容），普通 Qoder 用 `mcp add` CLI，Qoder CN 则只用独立的
`qoder-cn --add-mcp <JSON>` CLI。agent 直接调 `ahp_pickup`、
  `ahp_start` ……。结构化参数，自由文本字段不用过 shell 转义。

两者都装时，agent 优先用 MCP 工具，没有则回退到 CLI。`./install.sh --mode cli|mcp`
跳过询问 · `--dry-run` · `--no-color` · `--uninstall`。

需要 Node ≥ 20 和 Git。

## 使用

在任意 Git 仓库里：

```sh
ahp status          # 项目、谁持棒、未完成 intent、tree/gate 状态
ahp pickup          # 默认精简接棒；确实需要全部细节时再加 --full
ahp start   --plan "加限流" --gate pass --evidence "188 tests pass"
ahp intent open   --id i-0828-a --title "token bucket" --intended "按 IP、耗尽返回 429"
ahp intent promote --id i-0828-a --commit 9f2e1df --gate pass \
  --actual "中间件 + 6 个测试" --landmine "只在进程内" --next "改成共享缓存"
ahp end     --reason limit --summary "3 个提交里落地了 1 个" --gate pass --evidence "194 pass"
```

`status`、`pickup` 等读命令不会为了识别项目而写入；第一条写命令才会自动注册。
`ahp` 从 Git 自动填 `seq`、时间戳、base 提交、工作区状态——你只提供含义。

### Project 与 Lane 怎么选

Project 仍自动识别；进入 Project 后按以下顺序选择 Lane：

1. 没有 Lane：第一次 `ahp start` 根据 plan 自动创建。
2. 只有一个可选 Lane，或只有一个 Lane 正由当前 worker 持棒：自动选择。
3. 任务能明确匹配 Lane 的 id、标题、描述、scope 或 alias：agent 传
   `--lane <id>`（MCP 使用 `lane` 字段）。
4. 多个 Lane 仍都有可能：AHP 列出候选和“新建 Lane”；只有 agent 无法可靠判断时，
   才请用户选择。

显式选定后，`pickup`、`start` 和后续写命令应持续携带同一个 Lane；等它成为当前 worker
唯一持棒的 Lane 后，才可安全依赖自动选择。
可用 `ahp lane list/create/edit` 查看、创建和调整 Lane；agent 写简洁规范，用户可修改。
同一 commit 被不同 Lane 的 intent 引用是合法的：AHP 记录关联关系，不拥有 commit，
也不做语义去重。是否单开 branch/worktree，还是跟随当前分支，由 agent 根据代码隔离需求
判断；AHP 不替 Git 工作流作决定。

只有当前 Lane baton 的持有者可以写入 `intent.open`、`intent.promote` 和
`handoff.end`。其他 worker 不得替对方结束 session；应先 `pickup`，完成核对后用
`start` 明确接棒。新持棒者可以完成上一个 session 遗留的 open intent；`start` 仍是
hard cutoff 后合法的恢复路径。

必需的 AHP 操作一旦报错，就视为没有完成。先保持项目不变，按错误中的目标路径、现场证据和
下一步排查文件权限、只读挂载或沙箱授权，再重试到 CLI 退出码为 0（或 MCP 结果不是 error）。
不得静默改用仓库内 worklog。

在**任意目录**——一览所有项目：

```sh
ahp dashboard       # 每个 Project/Lane：baton、计划、未完成 intent、verify，
                    # 外加 branch 和短 HEAD（不扫描工作区或 git log）
ahp dashboard -w    # 只有状态变化才重绘；ctrl-c 退出
ahp dashboard --json
```


Dashboard 对辅助文字使用中性 ANSI-256 灰阶 `38;5;248`，不再依赖 Tabby 过暗的 ANSI bright-black 映射。分隔线仍使用独立的 ANSI `90`，保留更低的视觉权重。

## 记录类型

四种。完整字段表见 [`SPEC.md`](./SPEC.md) §5；机器契约见
[`schema/worklog.schema.json`](./schema/worklog.schema.json)。

| type | 什么时候写 | 携带什么 |
| --- | --- | --- |
| `handoff.start` | 接棒时 | `base`（核实过的提交 + gate + tree）、`plan`、`continuesFrom` |
| `intent.open` | 一个提交之前 | `intentId`、`title`、`intended` |
| `intent.promote` | 提交绿灯落地之后 | `commits`、`gate`、`actual`、`landmines`、`next` |
| `handoff.end` | 停止时（尽力而为） | `reason`、`end`（提交 + gate）、`summary`、`findings` |

带中途切断的完整轮换示例见 [`examples/relay.jsonl`](./examples/relay.jsonl)。

## 仓库内容

| 路径 | |
| --- | --- |
| [`SPEC.md`](./SPEC.md) | 规范性协议 |
| [`bin/ahp`](./bin/ahp)、[`src/`](./src/) | 参考 CLI |
| [`bin/ahp-mcp`](./bin/ahp-mcp) | MCP server |
| [`schema/worklog.schema.json`](./schema/worklog.schema.json) | 单条记录的 JSON Schema |
| [`skills/claude-code/`](./skills/claude-code/) | Claude Code skill |
| [`integrations/`](./integrations/) | Codex 片段、MCP 配置、通用 prompt、git 钩子 |
| [`tools/verify-worklog.mjs`](./tools/verify-worklog.mjs) | 独立文件校验器 |
| [`examples/`](./examples/) | 带切断的轮换、单 agent、硬切断 |
| [`docs/`](./docs/) | [设计取舍 & FAQ](./docs/rationale.md)、[接入](./docs/adoption.md) |

## 为什么不直接……

- **……看提交信息？** 它覆盖不了未提交的工作、特意不做的选择，也拦不住一份被夸大的"已完成"。
- **……维护一个可编辑的 `HANDOFF.md`？** 没有历史、没有 blame，两个 agent 跨轮换会互相覆盖。
- **……用时间戳排序？** 两台机器上三个 runtime 的时钟对不齐。`seq` 是单调整数。

## 状态

`1.0` 之前 —— 记录字段仍可能变动。变更尽量保持加性，记入
[`CHANGELOG.md`](./CHANGELOG.md)；破坏记录或流程的变更才是 major。

## 由来

从一个真实项目里抽取出来——那个项目在用量限制下轮换多个编码 agent。
项目本身的细节不在这里，留下的是能通用的那部分。

## 许可证

[MIT](./LICENSE) © Nonosword
