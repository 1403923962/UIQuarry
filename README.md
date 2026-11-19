# UIQuarry · 构石（开源浏览器本地采集器）

UIQuarry public 是一个 GPL-3.0 开源的浏览器本地工具：选取网页元素，净化并提取 HTML/CSS，保存在浏览器本地，导出为普通 Git 可管理的组件包。它不包含网页工作台、云端存储、自动回传、团队权限、计费或商业 AI 检索服务。

付费网页产品和云服务在独立的私有仓库中维护：[UIQuarry-Private](https://github.com/1403923962/UIQuarry-Private)。公开仓库只提供本地采集和离线导出能力。

## 产品边界

- **浏览器本地采集**：扩展选中页面元素，记录经净化的 HTML、元素样式、尺寸和来源，全部保存在浏览器本机。它是参考快照，不假设能从任意网页完整还原 JSX、私有脚本或原始设计稿。
- **背景 Canvas**：在“精确定位”输入唯一的 CSS 选择器（如 `#bg-canvas`），或者左键定点后按 `C` 选中该处的画布。按 Enter 确认后，“详情”可预览并导出该画布的一帧 PNG。需要保留前后图层的合成效果时，可另外勾选可视区域截图。
- **WebGL / 动效观察**：可按站点开启 WebGL 保帧，可选录制所选 Canvas 的短 WebM，或裁切浏览器合成后的目标区域。它们是像素/视频观察，不是源码或 shader 自动还原。
- **DOM 动画观察**：可选读取选中子树当前可见的 WAAPI/CSS 关键帧、时序及播放状态，便于重建 CSS 动效；不会读取或执行脚本，也不能还原动画触发逻辑。

WebGL 保帧默认关闭，需要按站点授权并刷新后才能影响新建上下文。画布录制最多 6 秒且不录音频。合成裁切保存浏览器绘制后的目标区域，像素可受遮挡影响。这些选项帮助观察和复刻视觉状态，但不会提取页面的 JS 或 shader 源码。
CSS/WAAPI 动画观察同样是选中时的只读采样；它保存当时存在的关键帧与时间参数，不会操作动画时间线，也不代表触发它的用户交互逻辑。
- **离线组件包**：CLI 创建带 `quarry.json` 清单的普通 Git 文件包。开发者可以自行提交、克隆、fork、分支、合并和分享。
- **公开格式**：`spec/` 定义捕获、组件包和受约束设计模型的公开格式，供私有产品或第三方工具消费。
- **付费网页产品**：网页工作台、云端存储/检索、团队权限、计费、AI 上下文和设计编辑器均在私有仓库中维护，必须由用户主动导入资料。

## 分阶段路线

1. 浏览器本地选取与捕获 → 浏览器本地存储 → 离线导出 Git 组件包。
2. 私有网页产品：包审阅、主动导入、团队权限、计费和 AI 检索。
3. 私有网页工作台：受约束的设计模型编辑与 React/CSS 单向导出。
4. 为带稳定 UIQuarry 节点 ID 的自有代码增加受限的代码到设计映射。

公开采集器不会自动发起网络请求，不包含网页管理后台或云端接收接口。每份主动分享的资产都应记录原始来源、作者声明的许可，并在发布前检查个人信息和敏感内容。脚本捕获必须显式选择且单独审阅；不会默认收集整个网页脚本。

## 仓库结构

- `browser-extension/`：Chrome/Chromium Manifest V3 本地采集工具。
- `cli/`：离线 Rust 组件包创建和校验工具。
- `spec/`：捕获格式、Git 组件包和设计模型规范。
- `packages/`：示例或可复用的组件包。

## 本地试用

1. 在 Chrome 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，指向仓库中的 `browser-extension/`。
2. 打开普通网页，点击工具栏 UIQuarry 图标，开始选择。滚动页面找到目标，左键定点，再用滚轮或 ↑↓ 切换该位置的图层。再次点击或按 Enter 保存，按 Esc 可重新选点。
3. 捕获始终只保存到浏览器本机，不会自动发起网络请求。扩展详情页可以查看最近捕获。
4. 需要导出时，用 CLI 创建普通 Git 包：`cargo run --manifest-path cli/Cargo.toml -- package create capture.json out/demo-card demo/card`。

CLI 使用说明见 [cli/README.md](cli/README.md)，捕获、Git 包和设计稿数据格式见 [spec/README.md](spec/README.md)，架构决策见 [docs/architecture.md](docs/architecture.md)。

## 验证

```powershell
cargo test --manifest-path cli/Cargo.toml
cargo clippy --manifest-path cli/Cargo.toml --all-targets -- -D warnings
node --test --test-concurrency=1 tests/*.mjs
```

扩展测试包括隔离配置的 Chromium/Edge WebGL 与 Canvas 回归。付费网页和云端功能不在这个公开仓库中。
