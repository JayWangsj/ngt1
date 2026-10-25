# NGT 前端 UI 开发规范

本文约束新增和修改的前端 UI，目标是让公共外观由组件管理、业务页面只负责组合，并通过真实用户流程防止回归。

## 按钮

- 优先使用 `src/components/ui/button.tsx` 的 `Button`。当前变体为 `default`、`outline`、`cancel`、`secondary`、`tertiary`、`ghost` 和 `danger`。
- `default` 用于主要提交操作；`outline` 用于确实需要描边的次要操作；`cancel` 仅用于放弃或关闭当前编辑；`danger` 用于删除等危险操作。不要仅凭按钮文案判断语义。
- `cancel` 默认使用 `type="button"`。表单提交按钮显式使用 `type="submit"`；其他原生按钮显式使用 `type="button"`，避免意外提交。
- 不要在业务 CSS 中重新设置公共按钮的基础颜色、边框、焦点或悬停效果。特殊尺寸通过局部 CSS Module 类表达，并保留清晰的键盘焦点。
- 原生 `<button>` 仅用于需要原生行为或无法由 `Button` 表达的结构，例如复合控件中的选项、图标触发器；仍应提供可访问名称和正确的 `type`。

```tsx
<Button type="button" variant="cancel" onClick={onClose}>
  取消
</Button>
<Button type="submit">保存</Button>
```

## 弹窗

- 标准弹窗使用 `FormDialog` 管理标题、关闭、ESC 和焦点恢复；内容用 `DialogBody`，表单用 `DialogForm`，底部操作用 `DialogFooter`。
- `DialogFooter` 自己提供分隔线和基础间距。不要再套一层只为绘制横线或增加 Footer 留白的容器，也不要在业务页面覆盖 `.dialog-actions`。
- 内容很多时让 `DialogBody` 滚动；不要让 Footer 盖住内容。只有确实需要不同尺寸时才使用 `FormDialog` 的 `size`：`wide`、`extraWide`、`large`、`medium`、`narrow`、`compact`、`retail`。
- 子弹窗、忙碌状态、日期选择器等内部浮层需保留已有关闭保护、ESC 行为和焦点恢复。不要绕过 `FormDialog` 的关闭处理。

```tsx
<FormDialog title={title} onClose={onClose} size="medium">
  <DialogForm onSubmit={save}>
    <DialogBody>{/* 表单内容 */}</DialogBody>
    <DialogFooter>
      <Button type="button" variant="cancel" onClick={onClose}>
        取消
      </Button>
      <Button type="submit">保存</Button>
    </DialogFooter>
  </DialogForm>
</FormDialog>
```

## 样式所有权

- 新增组件样式放在组件自己的 `*.module.css`。复用样式放在实际共享组件的模块中；页面独有的布局放在对应页面或业务模块。
- `globals.css` 用于 Design Tokens、Reset、字体和确实需要跨组件生效的基础行为。迁移期间仍存在的旧规则可逐步清理；新增 UI 不要再依赖全局选择器或更深的页面选择器覆盖公共组件。
- 优先复用 `globals.css` 已有变量，例如 `--text-primary`、`--border-subtle`、`--action-primary`、`--space-control-gap`、`--radius-control` 和 `--dialog-*`。不要为相同语义另造一套变量。
- CSS Module 确需设置已有公共元素时，将 `:global(...)` 限定在本地模块类下面。保留仍被测试、调用方或动画依赖的语义类；删除旧规则前先确认没有真实消费者。
- 特殊视觉差异应使用组件变体或有名称的局部类，并在代码中能看出适用范围。不要追加只为抵消另一条规则的覆盖。

## 回归验证

- 每项 UI 改动都补充或更新覆盖真实消费组件的测试；检查计算样式和可见布局，不只检查类名或静态源码。
- 对响应式布局至少检查桌面、平板和手机宽度；改动动效时覆盖悬停、键盘焦点和 `prefers-reduced-motion`。
- 需要双语的页面分别检查中文与意大利语文本长度变化，尤其是按钮、弹窗标题、Footer 和批量操作栏。
- Playwright 必须使用隔离的 `*_test` 数据库，只运行受影响页面和用户流程的针对性测试。不得把正式业务数据作为 UI 测试数据。
- 提交前运行与改动直接相关的 Prettier、ESLint、TypeScript 和 E2E 检查；验证通过后按仓库规范创建独立 Git commit。
