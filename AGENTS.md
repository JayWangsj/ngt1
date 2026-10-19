## 开发、测试与提交规范

### 1. Git 提交

- 每完成一项独立改动，都必须创建对应的 Git commit，以便后续追踪和回滚。
- Commit 只包含本次任务相关改动，不要混入无关修改。
- 创建 commit 前，必须完成本次改动所需的测试和验证，并确认通过。
- Commit message 应简洁、明确地描述本次改动。

### 2. 测试要求

- 每次修改代码后，都必须根据改动内容编写、补充或更新相关测试。
- 默认采用针对性验证（targeted validation），只验证本次改动及其直接影响范围。
- 不要为了“保险”而默认运行所有测试。
- 向用户交付前，本次改动所需的针对性测试和必要验证必须全部通过。

### 3. 测试策略

完成代码修改后：

1. 优先运行与本次修改的文件、模块、功能直接相关的测试。
2. 单元测试和集成测试只运行与本次改动相关的部分，不默认运行完整测试套件。
3. 对于 UI 修改，只运行覆盖受影响功能和用户流程的 E2E 测试。
4. 默认不要运行：
   - 完整单元测试套件；
   - 完整集成测试套件；
   - 完整 E2E 测试套件；
   - Production Build；
   - 与本次修改无关的检查或验证。
5. 只有满足以下任一条件时，才扩大测试范围或执行全量验证：
   - 修改影响共享模块、核心基础设施或全局行为；
   - 修改范围较大，无法通过局部测试充分验证；
   - 针对性测试发现可能存在回归问题；
   - 用户明确要求执行完整验证。
6. 如果针对性测试失败，应优先定位并修复相关问题，然后重新运行失败测试及其直接相关测试。
7. 不要因为单个针对性测试失败就直接运行整个测试套件。
8. 只有确有必要时，才逐步扩大测试范围。

### 发布关键模块

以下改动必须扩大验证范围：Windows 安装器和相关 PowerShell 脚本；在线更新、任务状态、锁和恢复；Prisma Schema、迁移、备份恢复；GitHub Actions 发布工作流；发布验收脚本和版本打包逻辑。

- 开发改动时同步新增或更新对应回归测试，运行相关单元测试、Windows 集成测试和发布候选验收。单元测试、Lint、TypeScript 检查通过不足以宣称可发布。
- 修改验收测试自身时，实际验证其场景、Prisma 唯一键约束、重复运行的数据行为和退出结果；不能只检查语法。确定性失败不得通过跳过测试、吞掉异常或无条件重试掩盖。
- 正式创建版本标签前，在精确候选 SHA 上通过 Verify MVP 和独立的 Release Ready。Release Ready 必须在隔离的 GitHub 托管 Windows Runner 上使用真实安装器和测试数据库；未执行或失败均不得视为通过。
- 正式发布仍须通过原有的 Draft 资产校验和全部隔离安装验收。发布资格必须核对标签对应的精确 SHA，不得使用同一分支上其他提交的成功结果。已发布标签不得移动。

### 4. Token 与执行效率

- 测试和验证应遵循“满足验证需求的最小范围”原则。
- 避免读取、运行或分析与本次修改无关的大量测试、日志和代码。
- 测试成功时保持输出简洁，不要重复分析完整测试日志。
- 优先使用具体测试文件、测试名称、模块或 E2E spec 进行验证，而不是运行整个目录或全部测试。
- 不要为了生成更完整的交付报告而额外运行无必要的测试或命令。

### 5. 交付要求

完成任务并创建 Git commit 前：

- 确保本次改动相关测试已根据需要新增、补充或更新；
- 确保针对性测试和必要验证全部通过；
- 简要报告实际执行的测试及结果；
- 除非存在异常或风险，否则无需运行或详细说明未执行的全量测试；
- 如果因环境问题导致必要验证无法执行，必须明确说明原因，不得将其描述为已通过；
- 完成验证后创建对应的 Git commit。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
