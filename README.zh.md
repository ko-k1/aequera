# Aequera

> 基于 Firefox/Gecko、围绕以人为本的用户体验、响应性、简洁性、深度定制、隐私以及完整的默认体验设计的浏览器。

Aequera 是一个基于 Firefox/Gecko 的浏览器项目。该项目将浏览器外壳——界面、工作流、导航模型、定制系统、动效、材质、交互架构——视为第一类产品，而非围绕 Web 平台的薄层。

Aequera 意在结合多个浏览器类别的优点，又不成为其中任何一个的复制品：

- **Firefox/Gecko** —— 成熟的 Web 平台与扩展基础。
- **Arc/Zen 类思路** —— 用于重新思考浏览器工作流、工作区、导航和浏览器外壳 UX 的灵感。
- **Helium 类轻量** —— 用于克制、低开销的浏览器外壳以及对响应性的强烈关注的灵感。
- **LibreWolf 类隐私纪律** —— 用于隐私优先默认、可审计配置以及移除不想要的遥测/广告行为的灵感。

这些是参考点，而非实现模板。Aequera 应从人体工程学、可衡量的 UX 目标和一致的架构出发，发展自身的交互模型。

## 核心理念

Aequera 旨在让广泛的能力表面保持简单：

```text
大规模的能力表面
          ↓
一致的信息架构
          ↓
少量的心智概念
          ↓
快速反馈 + 可预测的状态
          ↓
个人化浏览器
```

项目明确寻求以下平衡：

- 简洁与能力；
- 性能与视觉丰富性；
- 自动化与用户控制；
- 一致性与个性化；
- 探索与专注；
- 强大的默认体验与深度定制。

## “默认完整”的含义

Aequera 应从首次启动起就感觉完整。新用户不应在安装大量扩展栈或学习复杂配置系统之前，浏览器才变得有用。

同时，高级用户应能在不维护私有源码分支的前提下，大幅重塑表现和工作流。

“一体化”意味着“集成”，而非“包含所有可能的功能”。标签页、工作区、搜索、历史记录、书签、下载、权限、会话、命令、设置和扩展应作为共享浏览器模型的组成部分协同工作。

## UX 原则

Aequera 是以人为本，而非以功能为中心。

核心交互循环是：

```text
意图 → 即时反馈 → 可预测的状态 → 最小化的修正
```

浏览器应减少：

- 视觉搜索时间；
- 指针移动和重复的运动努力；
- 不必要的点击；
- 模式混淆；
- 重复的导航概念；
- 等待浏览器外壳反馈；
- 重复的配置工作。

响应性被视为 UX 属性。因此性能工作的评估指标包括输入延迟、视觉反馈、帧一致性、启动、内存行为、空闲 CPU，以及在重 Web 内容负载下浏览器外壳的韧性——而不仅是页面基准测试。

## 视觉与交互系统

Aequera 刻意允许在具有语义价值时使用丰富 UI。模糊、半透明、渐变、深度、提升、排版、动效和密度是用于层级、状态、上下文和连续性的工具，而非为了装饰而装饰。

设计系统包括：

- 语义设计令牌；
- 排版与密度；
- 表面与材质；
- 动效角色与缓动；
- 焦点/悬停/激活/禁用状态；
- 无障碍与减少动效；
- 人体工程学目标与可达性规则。

动画被视为交互系统。过渡应短暂、可中断、尽可能合成器友好，并立即被更新的用户意图覆盖。

## 深度定制

定制采用分层方式，普通用户可保持简洁，高级用户可获得精度：

```text
原生设置
      ↓
配置文件 / 值
      ↓
主题 / CSS
      ↓
Firefox WebExtensions
      ↓
Aequera 浏览器外壳 API
```

配置模型应使用类型化、有文档、可版本化的值，并具有确定性优先级、验证、迁移和恢复。定制不得成为隐藏的安全边界逃逸。

概念上：

```toml
ui.sidebar.position = "left"
ui.sidebar.width = 280px
ui.tabs.presentation = "icon-title"
ui.tabs.density = "compact"
workspace.presentation = "expanded"
material.sidebar.type = "frosted"
motion.global.profile = "balanced"
```

确切语法是实现决策；可预测的语义则不是。

## Firefox 兼容性

Firefox WebExtensions 仍是主要兼容目标。在 Aequera 外壳架构允许的范围内，现有 Firefox 插件应可正常工作；项目特定 API 应为增量式且能力受限，而非不必要的私有。

在不损害性能、UX 一致性或安全性的前提下，应优先考虑将功能实现为内置 WebExtension，再引入更深层的特权源码变更。

## 隐私与用户控制

隐私是产品需求。Aequera 不应引入：

- 未经明确同意的遥测；
- 广告或赞助 UI；
- 普通浏览的强制账户；
- 不必要的供应商服务；
- 静默的远程配置；
- 不必要的后台活动或数据收集。

网络活动必须具有用户可见或平台要求的理由，安全敏感行为必须免受普通定制的削弱。

## 上游架构

Aequera 不应成为永久手动编辑的 Firefox 分支。

优先的事实来源模型为：

```text
Mozilla Firefox / Gecko
        ↓
 pinned upstream revision
        ↓
 clean upstream source
        ↓
 reproducible Aequera patchset
        ↓
 Aequera-owned source + configuration
        ↓
 build / test / benchmark
        ↓
 Aequera artifact
```

关键边界为：

> **Aequera-owned code is source; Firefox modifications are an explicit, reviewable patchset.**

上游 Firefox 被视为输入/产物，而非 Aequera 产品身份所在之处。

## 文档地图

### 产品与愿景

- `docs/VISION.md` — 项目哲学、原则与成功条件。
- `docs/PRODUCT.md` — 默认浏览器体验与核心概念。
- `docs/FEATURES.md` — 功能/能力地图与职责分类。
- `docs/RESTRICTIONS.md` — 硬约束与非目标。

### 架构与设计

- `docs/ARCHITECTURE.md` — 系统层与依赖方向。
- `docs/SOURCE_LAYOUT.md` — Aequera 源码所有权与仓库边界。
- `docs/WORKFLOW.md` — 开发、补丁、上游、测试与发布流程。
- `docs/design/UX_PRINCIPLES.md` — HCI 与人体工程学原则。
- `docs/design/MOTION.md` — 动效与过渡系统。
- `docs/design/MATERIAL.md` — 表面/材质系统。
- `docs/design/CUSTOMIZATION.md` — 值、配置文件、设置、CSS、主题与插件。
- `docs/design/WORKSPACE.md` — 工作区与标签页交互模型。

### 工程

- `docs/engineering/DEVELOPMENT.md` — 日常开发循环。
- `docs/engineering/CLI.md` — 意图导向的 Aequera CLI。
- `docs/engineering/UPSTREAM1.md` — Firefox 源码锁定与同步。
- `docs/engineering/UPSTREAM2.md` — 本阶段上游跟踪政策。
- `docs/engineering/PATCHING.md` — 补丁栈结构、生命周期、元数据与冲突处理。
- `docs/engineering/PERFORMANCE.md` — 性能模型与预算。
- `docs/engineering/SECURITY.md` — 安全/隐私要求与威胁领域。
- `docs/engineering/COMPATIBILITY.md` — Firefox/WebExtension/平台兼容性政策。
- `docs/engineering/TESTING.md` — 测试层级与验收门禁。
- `docs/engineering/RELEASE.md` — 发布、版本化、可重现性与回滚。
- `docs/engineering/RELEASE_EVIDENCE_AND_TRUST.md` — 拟议的发布证据与信任政策。

### 交付

- `docs/ROADMAP.md` — 分阶段实施路线图。
- `docs/QUALITY_GATES.md` — 阶段退出质量门禁。
- `docs/adr/0001-project-direction.md` — 初始架构/产品方向。
- `docs/adr/0002-upstream-and-patch-model.md` — 上游与补丁架构决策。

### 代理支持

- `agent/PROJECT_CONTEXT.md` — 面向编码代理的简明上下文。
- `agent/IMPLEMENTATION_RULES.md` — 实现不变量与任务规则。
- `agent/TASK_WORKFLOW.md` — 代理特定的任务分解与验证循环。

## 项目状态

当前阶段：**架构与基础**。

眼前工作包括建立可重现的 Firefox 基线、形式化源码/补丁/配置边界、建立可衡量的性能仪表，并在不让项目变成庞大未分化分支的前提下，构建首个浏览器外壳基础。

## 名称

**Aequera** 是受拉丁语 *aequus*（平衡、和谐、均匀）与 *era*（时代）概念启发的造词。

项目使用此名称来表达一个平衡的、以人为本的、可适应的计算和浏览新时代。
