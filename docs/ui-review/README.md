# UI 更新与验证

日期：2026-11-01。

参考 Apple 当前 [Materials](https://developer.apple.com/design/human-interface-guidelines/materials)、[Typography](https://developer.apple.com/design/human-interface-guidelines/typography) 与 [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) 指南，适配现有 React / Tauri 的 Windows 与 Android 界面。这是 WebView 内的设计实现，不是原生 Apple Liquid Glass，也不代表通过了苹果的完整合规认证。

## 已实现

- 导航与输入工具栏使用半透明材质；内容使用实色表面，避免文字叠在复杂背景上。
- 桌面顶部胶囊导航、宽屏双列内容；600px 以下改为底部悬浮导航并预留安全区。
- 统一系统字体、标题层级、间距、圆角、语义颜色、任务状态和目标进度。
- 任务页先展示待验收，再展示进行中和待办。
- 统一任务/目标表单、会话气泡、授权提示、登录与设置样式。
- 按钮最小高度 44 CSS px，提供键盘焦点、可访问标签和原生表单语义；会话入口和摘要展开改为可键盘操作的按钮。
- 适配浅色/深色、减少动态效果、减少透明度、高对比度及强制颜色模式。媒体查询是否生效取决于 WebView 对系统偏好的支持。

## 验证

- `npm run build`：通过，TypeScript 检查与 Vite 打包成功。
- `npm test`：6/6 通过。
- `git -c core.safecrlf=false diff --check`：通过。
- 浏览器视觉检查：1400×800 桌面深色、400×800 手机浅色与深色，任务列表、任务详情和目标列表无横向溢出。
- 隔离的内存数据验证：任务详情编辑/保存出现“已保存”；返回任务列表保留修改；Tab 导航显示清晰焦点；目标进度正确显示。
- 截图使用模拟数据，不连接生产服务，不读取或改写已安装应用的配置。

未重新打包 Windows 安装包或 APK；此前的 0.5.0 安装产物不包含本次 UI 更新。未进行手机软键盘、原生 WebView 与屏幕阅读器的完整验收。

## 截图

![桌面深色任务页](desktop-dark.png)

![手机浅色任务页](mobile-light.png)
