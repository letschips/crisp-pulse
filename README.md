# Crisp Pulse

> **Your knowledge work, visualized.**  
> 本地优先的 Obsidian 知识工作统计与贡献度热力图看板插件。

[![Obsidian](https://img.shields.io/badge/Obsidian-v1.6.0%2B-blue.svg)](https://obsidian.md)
[![License](https://img.shields.io/badge/license-Proprietary-red.svg)](LICENSE)
[![Crisp Suite](https://img.shields.io/badge/Crisp-Suite-orange.svg)](https://github.com/letschips)

---

## 🌟 特色功能 (Highlights)

### 1. GitHub 风格年度知识脉冲热力图
- **近 53 周活跃全景**：以经典的 GitHub 风格热力网格呈现全年的每一次输入与思考。
- **六维指标自由切换**：支持按综合贡献得分（Contribution）、活跃时长（Active Time）、新增词数（Words Added）、笔记产出（Notes Created）、任务完成（Tasks Completed）以及专注时长（Focus Time）查看热力图。
- **多时间跨度灵活分析**：近 53 周（全年）、最近 90 天、最近 30 天、本周（7天）以及本年度（YTD）。

### 2. 真实可信的有效编辑判定 (Credible Analytics)
- **拒绝虚假刷分**：引入分行差异指纹分析，即使是大范围修改与逻辑润色而总词数净增接近 0 时，也能准确识别“有效改写”并计入贡献。
- **任务生命周期校验**：仅对真正新增勾选的待办事项计分，取消勾选自动扣回，杜绝通过反复勾选复选框膨胀数据。
- **数据自愈与隔离**：启动时执行严格的数据契约校验，自动修复缺失节点，客观隔离未经验证的历史异常数据。

### 3. 透明清晰的贡献得分拆解
- **公式公开透明**：综合贡献得分由「新建笔记」、「有效编辑会话」、「任务达成」、「知识双链」、「深度润色」与「专注时长」按科学权重加权求和，分项之和严格等于总分。
- **直观卡片展示**：点击热力图任意一天，即时展开当日指标构成与清晰的分项拆解清单。

### 4. 工作周复盘看板与知识沉淀 (Work Review)
- **多维综合周报**：一键切换至工作周复盘视图，直观展示本周累计贡献总分、新增与润色词量、目录精力分布比例图条（如 `Core` vs `Topics`）。
- **Top 5 深度推进笔记**：精准列出当周投入精力最多的核心笔记与文档。
- **双向导出通道**：
  - 📋 **复制 Markdown 周报**：格式化排版，随时粘贴至周报群或个人日志；
  - 📁 **一键归档至知识库**：生成符合 ANKS 规范的结构化笔记（带标准 YAML Frontmatter、ISO 周号与知识沉淀流向建议），并自动在工作区打开。

### 5. 原生 SVG 数据分析图表 (Analytics)
- **三大关键趋势**：内置原生轻量 SVG 绘制的每日贡献柱状图、写作变化折线图（新增/删除/改写）与时间投入折线图（交互活跃/专注时长）。
- **多周期与自适应**：支持 7 天、30 天与 90 天分析周期，自适应宽窄面板，支持键盘方向键与无障碍浏览。

### 6. Crisp Focus 专注计时深度联动
- **零侵入自动发现**：自动感知正在运行的 Crisp Focus 插件，无须复杂配置。
- **番茄钟专注累计**：完成专注会话后，专注时长自动纳入当日指标并折算贡献得分。
- **微动效联动**：当 Focus 处于专注计时状态时，Pulse 状态栏指示器呈现微呼吸脉冲动效。

### 7. 数据安全与隐私保障 (Local-First)
- **100% 本地运行**：所有统计计算均在本地完成，您的笔记内容、文件名和工作痕迹绝不离开您的设备。
- **防丢自愈备份**：在执行重置等破坏性操作前，系统自动在本地 `backups/` 目录生成时间戳快照。
- **安全防注入导出**：全量 CSV 导出经过公式注入清洗（Formula Injection Sanitization），安全无虞。

---

## 🚀 安装方式 (Installation)

### 方式一：通过 BRAT 安装（推荐）
1. 在 Obsidian 中安装并启用 **BRAT** 插件；
2. 打开 BRAT 设置，点击 **Add Beta plugin**；
3. 输入仓库地址：`letschips/crisp-pulse`；
4. 点击添加后，在“第三方插件”列表中启用 **Crisp Pulse** 即可。

### 方式二：手动安装
1. 从 [Releases](https://github.com/letschips/crisp-pulse/releases) 页面下载最新的发布包（包含 `main.js`, `manifest.json`, `styles.css`）；
2. 打开您的 Obsidian 库目录，进入 `.obsidian/plugins/`；
3. 新建文件夹 `crisp-pulse` 并将下载的文件放入其中；
4. 在 Obsidian 设置的“第三方插件”列表中重新载入并启用。

---

## 🔑 激活机制 (License & Activation)

- Crisp Pulse 是 **Crisp 插件套件** 的核心成员之一。
- 本插件基于 Ed25519 非对称公钥密码学实现本地验证与轻量在线设备防刷校验。
- **一次激活，全套受惠**：若您已在同一设备的其它 Crisp 插件（如 Crisp Focus、Crisp File Explorer）中完成正版激活，Crisp Pulse 将自动识别并继承授权状态，无需重复输入。

---

## 🛠️ 开发者与回归测试

本项目内置完整的本地自动化测试套件：

```sh
npm test
```

涵盖 69 项单元与回归测试（包括 Ed25519 签名验证、设备激活管理、有效行差异算法、任务状态机、多时间跨度过滤、周复盘生成、ANKS 归档与并发读写安全）。

---

## 👨‍💻 作者与社区

- **作者**：小红书 [@letschips](https://xhslink.cn/m/3MwtKu4822b)
- **公众号**：来吃薯条儿
- **品牌**：Crisp Suite
- 如果本插件对您的思考与沉淀有所助益，欢迎在小红书关注作者交流心得！

---

## 📄 授权协议 (License)

Copyright (c) 2026 letschips. All rights reserved.  
本软件受专有商业软件许可协议保护，详见 [LICENSE](LICENSE)。
