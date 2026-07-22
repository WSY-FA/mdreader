# mdreader

mdreader 是一款专注于本地阅读体验的桌面 Markdown 阅读器，基于 Tauri 2、React 和 TypeScript 构建，支持 Windows 和 macOS。

## 功能特性

- 打开单个或多个 `.md`、`.markdown` 文件
- 以目录树浏览工作区中的 Markdown 文档
- 多标签阅读，并自动避免重复打开同一文件
- 拖动调整侧边栏宽度，或一键收起侧边栏
- 监听本地文件变化，外部编辑器保存后自动刷新内容和目录树
- 自动恢复上次打开的目录、标签、活动文档、侧边栏和窗口状态
- 支持 Markdown 表格、任务列表、代码块、Mermaid 图表和相对路径图片
- 支持代码语法高亮、文档目录导航和阅读字体切换
- 支持通过正文右键菜单打印或导出带目录的 PDF
- 支持系统文件关联、命令行打开文件和单实例唤醒
- 使用 DOMPurify 清理渲染后的 HTML

## 界面操作

启动应用后，可以通过顶部工具栏打开 Markdown 文件或包含 Markdown 文档的目录。打开目录后，mdreader 会递归扫描其中的 `.md` 和 `.markdown` 文件，并自动忽略隐藏目录、`node_modules` 和 `target`。

| 操作 | Windows | macOS |
| --- | --- | --- |
| 打开文件 | `Ctrl+O` | `Command+O` |
| 打开目录 | `Ctrl+Shift+O` | `Command+Shift+O` |
| 关闭当前标签 | `Ctrl+W` | `Command+W` |
| 切换到下一个标签 | `Ctrl+Tab` | `Control+Tab` |
| 切换到上一个标签 | `Ctrl+Shift+Tab` | `Control+Shift+Tab` |

## 技术栈

- [Tauri 2](https://v2.tauri.app/)：桌面应用容器与本地文件能力
- [React 19](https://react.dev/)：用户界面
- [TypeScript](https://www.typescriptlang.org/)：前端类型系统
- [Vite 6](https://vite.dev/)：开发服务器与前端构建
- [marked](https://marked.js.org/)：Markdown 解析
- [DOMPurify](https://github.com/cure53/DOMPurify)：HTML 内容清理
- [notify](https://github.com/notify-rs/notify)：本地文件变化监听

## 开发环境

开始前请安装：

- Node.js 22 或兼容版本
- npm
- Rust stable 工具链
- Tauri 对应平台的系统依赖

安装项目依赖：

```bash
npm ci
```

启动桌面应用开发环境：

```bash
npm run tauri dev
```

只启动前端预览：

```bash
npm run dev
```

浏览器预览模式仅用于检查界面，打开本地文件、打开目录、文件监听等桌面能力需要在 Tauri 窗口中使用。

## 构建

在当前操作系统上构建安装包：

```bash
npm run tauri build
```

应用应在目标操作系统上构建：

- Windows：生成 NSIS 安装包
- macOS：生成 App/DMG

仓库中的 GitHub Actions 工作流会在推送 `v*` 格式的标签时，同时构建 Windows 和 macOS 产物，也可以在 Actions 页面手动触发。

## 项目结构

```text
.
├── .github/workflows/    # GitHub Actions 构建配置
├── src/                  # React 前端
│   ├── App.tsx           # 主界面与交互逻辑
│   ├── main.tsx          # 前端入口
│   ├── styles.css        # 全局样式
│   └── types.ts          # TypeScript 类型
├── src-tauri/            # Tauri/Rust 桌面端
│   ├── capabilities/     # Tauri 权限配置
│   ├── icons/            # 应用图标
│   ├── src/              # Rust 命令与文件监听逻辑
│   └── tauri.conf.json   # 应用与打包配置
├── package.json
└── vite.config.ts
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 前端开发服务器 |
| `npm run build` | 执行 TypeScript 检查并构建前端 |
| `npm run preview` | 预览前端生产构建 |
| `npm run tauri dev` | 启动 Tauri 桌面开发环境 |
| `npm run tauri build` | 构建桌面安装包 |

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 开源。
