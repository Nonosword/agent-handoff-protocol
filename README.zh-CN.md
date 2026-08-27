# Agent Handoff Protocol（AHP）

[English](./README.md) · **简体中文**

[![ci](https://github.com/Nonosword/agent-handoff-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/Nonosword/agent-handoff-protocol/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![spec: 0.1.0](https://img.shields.io/badge/spec-0.1.0%20draft-orange.svg)](./SPEC.md)

> 一份极简的 append-only 日志，让轮换工作的编码 agent 在某一个用量耗尽、下一个接手时，不丢失上下文。

## 要解决的问题

你用多个编码 agent 在同一个仓库上干活——Codex、Claude、本地模型——每个用量到顶就换下一个。
agent 常常在**改到一半**时被切断，来不及交代任何事情。接手的 agent 面对的是：

- 一堆没有上下文的未提交改动；
- 提交只显示"改了什么"，不显示"什么被特意跳过了"、"下一步要做什么"；
- 如果它去相信一份手写的"我做了这些"总结，这份总结有相当概率是错的（把带着失败测试的活标成了完成）。

## 核心思路

按两种媒介各自擅长的事，把记录拆成两半：

| 问题 | 由谁回答 |
| --- | --- |
| 改了哪些文件、在哪几个提交里？ | **Git 历史** |
| 每次改动是**为了什么**？ | worklog —— `intent.*` |
| **此刻**什么没做完、什么没提交？ | worklog —— 有 `intent.open` 但没有 `intent.promote` |
| 坑和临时妥协在哪里？ | worklog —— `landmines` |
| 下一个 agent 该做什么？ | worklog —— `next` / `plan` |

worklog 就是 `.coworker/worklog.jsonl`：仓库根目录、**不被 git 追踪**、**只追加**、
一行一个 JSON 对象、按整数 `seq` 排序。

```
.coworker/worklog.jsonl

  handoff.start   ── agent 接棒：自己核实过的 base 提交 + gate 结果 + 计划
    intent.open      ── 一个小提交之前：我打算做什么
    intent.promote   ── 提交绿灯落地之后：实际做了什么 · 坑 · 下一步
    intent.open
    intent.promote
  handoff.end     ── 停止时尽力而为：结束提交 + gate + findings + 未完成的 intent

  handoff.start   ── 下一个 agent：核对上一个 base 以来的提交，
                     接管任何未完成的 intent，自己重新核实，继续
```

有 `intent.open` 却没有对应 `intent.promote`，就是下一个 agent 直接顺着找到 dirty tree
里那半截未完成工作的指针——**即使上一个 agent 没来得及写 `handoff.end` 就消失了**。

## 快速开始

**1.** 忽略 worklog —— 在你项目的 `.gitignore` 里加：

```
.coworker/
```

**2.** 让你的 agent 遵循协议。从 [`integrations/`](./integrations/) 里把对应你环境的片段
（[Claude Code](./integrations/claude-code.md)、[Codex](./integrations/codex.md)、
[通用](./integrations/generic-agent.md)）复制进 `CLAUDE.md` / `AGENTS.md` / 你的 system prompt。

**3.** 把校验器（零依赖）放进项目，在接棒时和停止前各跑一次：

```sh
node tools/verify-worklog.mjs
```

第一个 agent 用一条 `handoff.start`（`continuesFrom: null`）创建这个文件。就这样。

## 记录类型

四种。完整字段表见 [`SPEC.md`](./SPEC.md) §5；机器契约见
[`schema/worklog.schema.json`](./schema/worklog.schema.json)。

| type | 什么时候写 | 携带什么 |
| --- | --- | --- |
| `handoff.start` | 接棒时 | `base`（核实过的提交 + gate + 工作区状态）、`plan`、`continuesFrom` |
| `intent.open` | 一个提交之前 | `intentId`、`title`、`intended` |
| `intent.promote` | 提交绿灯落地之后 | `commits`、`gate`、`actual`、`landmines`、`next` |
| `handoff.end` | 停止时（尽力而为） | `reason`、`end`（提交 + gate）、`summary`、`findings` |

所有记录共有：`type`、`seq`（严格递增整数）、`at`（UTC RFC 3339）、`worker`。

一个带中途切断的完整轮换示例见 [`examples/relay.jsonl`](./examples/relay.jsonl)。

## 仓库内容

| 路径 | |
| --- | --- |
| [`SPEC.md`](./SPEC.md) | 规范性协议 |
| [`schema/worklog.schema.json`](./schema/worklog.schema.json) | 单条记录的 JSON Schema（draft 2020-12） |
| [`tools/verify-worklog.mjs`](./tools/verify-worklog.mjs) | 零依赖参考校验器 |
| [`tools/schema-check.mjs`](./tools/schema-check.mjs) | schema 校验（需要 ajv）—— 供 CI / 其他工具用 |
| [`examples/`](./examples/) | 带切断的轮换、单 agent 会话、硬切断 |
| [`integrations/`](./integrations/) | Claude Code / Codex / 通用片段，一个 `prepare-commit-msg` 钩子 |
| [`docs/rationale.md`](./docs/rationale.md) | 设计取舍 & FAQ |
| [`docs/adoption.md`](./docs/adoption.md) | 把 AHP 接入现有项目 |

## 为什么不直接……

- **……看提交信息？** 它覆盖不了未提交的工作、特意不做的选择，也拦不住一份被夸大的"已完成"。
  见 [rationale](./docs/rationale.md)。
- **……维护一个可编辑的 `HANDOFF.md`？** 没有历史、没有 blame，两个 agent 跨轮换会互相覆盖。
  只追加 + `seq` 解决这个问题。
- **……用时间戳排序？** 两台机器上三个 runtime 的时钟对不齐。`seq` 是单调整数。

## 状态

草案，`0.1.0`。`1.0` 之前记录字段仍可能变动。遵循 [SemVer](https://semver.org/)；
破坏性变更为 major，记入 [`CHANGELOG.md`](./CHANGELOG.md)。

## 由来

从一个真实项目里抽取出来——那个项目在用量限制下轮换多个编码 agent。
项目本身的细节不在这里，留下的是能通用的那部分。

## 许可证

[MIT](./LICENSE) © Nonosword
