# Git Conflict Resolver v0.2.0

[English](README.md) | 简体中文

**Skill + 跨平台 Node.js 脚本：先解决简单冲突块，再让 Agent 结合两边提交意图处理剩余冲突。**

v0.2.0 不再只是重跑 `git merge-file`。它新增了 IDEA 式的**词级细化**：同一行修改不同字段时可以合并；同一个文件只解决了一部分时，保留其余冲突和原始索引阶段。它不是 IDEA 的完整算法移植，也不是 AST/语义合并器。

## 依赖与安装

Node.js **22+**、Git **2.38+**。不需要 npm install、Bash、Python、IDE、云端 AI API 或原生编译。MIT 的 `node-diff3` 差异核心已随 Skill 打包，安装后离线可用。

在 macOS、Linux、Windows 的终端中均使用同样的命令：

```text
git clone https://github.com/Ga-hou/git-conflict-resolver.git
cd git-conflict-resolver
node scripts/install.mjs --to "<你的 Agent skills 目录>"
```

安装器会复制整个 `git-conflict-resolver` Skill，包括脚本、vendor 和说明；存在旧版本时不会静默覆盖。先明确迁移或移走旧安装，再安装新版。开发时也可直接调用项目中的脚本。

## 一键入口

目标仓库需已经处于 merge/rebase/cherry-pick 冲突状态：

```text
node skills/git-conflict-resolver/scripts/resolve.mjs run --repo "<目标仓库>"
```

先看候选、不改工作文件或索引：

```text
node skills/git-conflict-resolver/scripts/resolve.mjs run --repo "<目标仓库>" --dry-run
```

`--dry-run` 仍在该 worktree 的实际 Git 目录中保存上下文、备份和候选。它不是“磁盘零写入”。

比较旧版式的原生整文件合并，不启用词级处理：

```text
node skills/git-conflict-resolver/scripts/resolve.mjs run --repo "<目标仓库>" --native-only
```

命令返回 JSON。`remaining` 是仍需处理的文件；退出码 0 只表示命令成功，不表示所有冲突都已解决。**不会自动 commit、continue 或 push 父仓库。**

## 新版流程

```text
现有 Git 冲突
  → 保存 stage 1/2/3、原始工作文件、双方提交说明和 patch
  → 检查 AUTO_MERGE、文件哈希、索引和属性，保护已有手工处理
  → 原生 Git 三方行级合并
  → 若仍冲突，对每个原生 diff3 冲突块做无损词级比较
      ├─ 相同修改／只有一侧真正变化：采用确定结果
      ├─ 两边在 BASE 上的 token 编辑互不重叠：组合
      └─ 重叠、相邻边界不明、重复 token 对齐不明：保留整个冲突块
  → 文件全部解决：精确暂存该文件
  → 文件部分解决：只写工作区，原始 stage 1/2/3 全部保留
  → Agent 阅读双方意图，完成剩余冲突、相关测试和审查
  → 子模块由内向外处理，最终才 pin 同时包含两侧历史的提交
  → verify 检查 Git 状态和明显整侧覆盖
```

已处理的简单块写入 `refinement.json`，包含规则、原生候选中的行号、双方 token 编辑对应的 BASE 字符偏移。`candidate.native.diff3` 是原生结果，`candidate.diff3` 是细化结果，`worktree.before` 是原始备份。路径使用摘要目录，真实路径在 `manifest.json`。

## 一个真正区别于 v0.1 的例子

```javascript
// BASE
const options = { retries: 2, timeout: 1000 };
// OURS
const options = { retries: 3, timeout: 1000 };
// THEIRS
const options = { retries: 2, timeout: 2000 };
// v0.2.0
const options = { retries: 3, timeout: 2000 };
```

测试先创建真实 Git 分支并确认 `git merge` 确实产生冲突，再执行脚本验证该结果；不是只手工构造一个“本来可以合并”的索引。

如果同文件另一个冲突是双方把 `mode = "base"` 分别改成 `"ours"`、`"theirs"`，新版会解决上面的字段冲突，保留 mode 冲突，并维持该文件的未合并索引。整个原生冲突块有任一无法合并的 token 编辑时，这一块原样保留，不强行拆出行内冲突标记。

## 不是字符拼接，也不默认选边

数字、标识符、引号字符串、模板文本和识别到的注释整体作为 token：`100 → 120` 与 `100 → 103` 不会合成 `123`；`foo → food` 与 `foo → fool` 不会合成 `foold`。空白和缩进完整保留，不启用 ignore-whitespace、union 或 IDEA 的 greedy 风格删除合并。

词法器是语言无关的保守近似，不覆盖每种语言的完整词法（例如复杂正则字面量、嵌套模板语法）。它不能证明代码可解析或行为正确。双向 LCS 对齐一致只是减少歧义的启发式检查，不是对齐唯一性的数学证明。

大块、过多 token、高重复度、异常标记、混合或缺少换行的多行 EOF 会停止词级处理；无结尾换行的单行文件有专门处理。常见 lockfile、minified 文件和 source map 不进行词级处理；其他生成文件仍需 Agent 识别并按项目生成流程处理。二进制、LFS、symlink、自定义 merge/filter/encoding 延用专用处理边界。

## 防止“accept 一边就算完成”

Skill 要求每个文件都考虑双方提交意图。脚本额外检查：**双方相对 BASE 都改过，而最终暂存文件却逐字节等于其中一侧**时，`verify` 拒绝直接通过。

确实应整侧采用时，提交本地 JSON 审查说明（不会执行其中任何命令）：

```json
{
  "oursIntent": "我方具体想保留的行为",
  "theirsIntent": "对方具体想保留的行为",
  "resolution": "最终实现如何满足这些要求",
  "supersedes": "为什么完整采用这一侧仍保留、或有依据地替代另一侧需求",
  "checks": ["实际执行的检查及结果；没跑的检查须写明原因"]
}
```

```text
node skills/git-conflict-resolver/scripts/resolve.mjs review --repo "<仓库>" --path "src/file.ts" --note "<审查.json>"
node skills/git-conflict-resolver/scripts/resolve.mjs verify --repo "<仓库>"
```

记录绑定最终暂存 blob 的哈希和文件模式。更换暂存结果后旧记录不再适用。此检查只捕捉**整文件恰好等于一侧**的显著情况；无法检测所有冲突块级选边，也不能阻止 Agent 编造理由或用格式变化绕过。因此仍然必须审查和运行项目测试，不能宣称“语义有保证”。普通合并结果无需这个额外的结构化记录，但仍需 Skill 要求的意图审查。

## 子模块

```text
node skills/git-conflict-resolver/scripts/resolve.mjs submodule-prepare --repo "<父仓库>" --path "<子模块>"
```

本地已提交 HEAD 包含 OURS 时优先保留；否则建备份引用再准备处理分支。脏工作区、缺失对象、浅历史不被当作可自动覆盖/分叉处理。需要下载时显式加 `--fetch --remote origin`；未初始化时用已核实的 `--init --url <trusted-url>`。脚本不擅自推测远端。

在子模块中递归运行本 Skill，完成审查、测试和授权的本地提交，然后：

```text
node skills/git-conflict-resolver/scripts/resolve.mjs submodule-pin --repo "<父仓库>" --path "<子模块>" --reviewed
```

最终提交必须同时包含父仓库原始 stage-2/stage-3 指向的两个提交。**不是按时间选择“最新 SHA”**，也不在中途暂存一个占位 ours 指针。发布需单独授权，先确保子模块提交远端可取，再发布父仓库。

## 来自哪些开源方案

详细调研、永久链接、源码版本及采用范围见 [RESEARCH.md](RESEARCH.md)。

- **JetBrains/intellij-community**：参考 `MergeResolveUtil` 的词级冲突处理思路和“插入顺序不明不能猜”的约束；没有复制 Kotlin/Java 实现，没有声称结果与 IDEA 完全相同。
- **bhousel/node-diff3**：直接复用 `LCS` 和 `diffIndices` 两个函数的原始函数体，固定到已核实的提交和 blob。只调整导出并增加来源说明。MIT 授权全文随 Skill 分发。
- **Peaker/git-mediate**：参考保留 BASE、展示双方差异、仅在冲突退化为明确情况时机械解决的工作方式；未复制其代码。
- **Mergiraf**：评估了 syntax-aware merge 和事后 `solve` 工作流；本版本未集成、未打包它的程序或代码。复杂移动、AST 结构合并仍交给 Agent。其官方代码托管在 Codeberg，GitHub 搜索中的镜像不是官方主仓库。

## 验证与边界

```text
npm test
npm run check
node scripts/demo.mjs
```

`demo.mjs` 在临时仓库构造两个真实冲突，演示“解决一个、保留一个”，不访问网络或修改用户仓库。测试结果和实际运行平台见 [VERIFICATION.md](VERIFICATION.md)。CI 配置覆盖 macOS/Linux/Windows × Node 22/24；没有执行过的平台不当作已通过。

本工具不是执行沙箱，也不保证面对其他 Git 客户端的事务隔离。不与其他 Agent/编辑器同时写同一个 worktree。停止或中断时先检查本地会话备份和 journal，不能强制重置。

## 许可证

本项目采用 [MIT License](LICENSE)。第三方代码的来源和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
