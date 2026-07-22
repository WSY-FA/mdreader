import { invoke, isTauri } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Menu } from "@tauri-apps/api/menu";
import { open } from "@tauri-apps/plugin-dialog";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Type,
  X,
} from "lucide-react";
import { marked } from "marked";
import {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  DocumentTab,
  FileChangePayload,
  FileNode,
  OpenFilesPayload,
} from "./types";

const SESSION_KEY = "mdreader.session.v1";
const MIN_SIDEBAR_WIDTH = 210;
const MAX_SIDEBAR_WIDTH = 420;
let mermaidInitialized = false;

type ReaderFont = "serif" | "rounded" | "sans";

const READER_FONT_STACKS: Record<ReaderFont, string> = {
  serif:
    'Charter, "Bitstream Charter", "Noto Serif CJK SC", "Songti SC", Georgia, serif',
  rounded:
    'ui-rounded, "SF Pro Rounded", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  sans:
    'Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
};

interface SessionData {
  workspacePath: string | null;
  workspaceName: string;
  openPaths: string[];
  activePath: string | null;
  sidebarWidth: number;
  sidebarVisible: boolean;
  readerFont: ReaderFont;
}

interface OutlineItem {
  id: string;
  level: number;
  text: string;
}

interface RenderedMarkdown {
  html: string;
  outline: OutlineItem[];
}

function pathKey(path: string) {
  return path.replaceAll("\\", "/").toLocaleLowerCase();
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function dirname(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

function isReaderFont(value: unknown): value is ReaderFont {
  return typeof value === "string" && value in READER_FONT_STACKS;
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const markdownRenderer = new marked.Renderer();
const renderCodeBlock = markdownRenderer.code.bind(markdownRenderer);
markdownRenderer.code = (token) => {
  const language = token.lang?.trim().split(/\s+/, 1)[0].toLowerCase();
  if (language === "mermaid") {
    return `<div class="mermaid">${escapeHtml(token.text)}</div>`;
  }
  if (language && hljs.getLanguage(language)) {
    const highlighted = hljs.highlight(token.text, { language }).value;
    return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
  }
  if (!language && token.text.trim()) {
    const highlighted = hljs.highlightAuto(token.text).value;
    return `<pre><code class="hljs">${highlighted}</code></pre>`;
  }
  return renderCodeBlock(token);
};

async function renderMermaidDiagrams(container: HTMLElement) {
  if (!container.querySelector(".mermaid")) return;

  const { default: mermaid } = await import("mermaid");
  if (!container.isConnected) return;
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "neutral",
    });
    mermaidInitialized = true;
  }

  const diagrams = container.querySelectorAll<HTMLElement>(".mermaid");
  await mermaid.run({
    nodes: diagrams,
    suppressErrors: true,
  });
}

function resolveAssetPath(documentPath: string, source: string) {
  if (/^(?:[a-z]+:|#|\/\/)/i.test(source)) {
    return null;
  }

  let decoded = source;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    // Keep malformed URL text unchanged.
  }

  const separator = documentPath.includes("\\") ? "\\" : "/";
  const base = dirname(documentPath).split(/[\\/]/);
  for (const part of decoded.split(/[\\/]/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (base.length > 1) base.pop();
    } else {
      base.push(part);
    }
  }
  return base.join(separator);
}

function renderMarkdown(content: string, documentPath: string): RenderedMarkdown {
  const parsed = marked.parse(content, {
    gfm: true,
    breaks: false,
    renderer: markdownRenderer,
  }) as string;
  const clean = DOMPurify.sanitize(parsed);
  const template = document.createElement("template");
  template.innerHTML = clean;

  template.content.querySelectorAll("a").forEach((link) => {
    if (/^https?:/i.test(link.href)) {
      link.target = "_blank";
      link.rel = "noreferrer";
    }
  });

  const outline: OutlineItem[] = [];
  template.content
    .querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
    .forEach((heading, index) => {
      const id = `mdreader-heading-${index}`;
      heading.id = id;
      outline.push({
        id,
        level: Number(heading.tagName.slice(1)),
        text: heading.textContent?.replace(/\s+/g, " ").trim() || "未命名标题",
      });
    });

  if (isTauri()) {
    template.content.querySelectorAll("img").forEach((image) => {
      const resolved = resolveAssetPath(documentPath, image.getAttribute("src") ?? "");
      if (resolved) image.src = convertFileSrc(resolved);
    });
  }

  return {
    html: template.innerHTML,
    outline,
  };
}

function TreeItem({
  node,
  depth,
  activePath,
  expanded,
  onToggle,
  onOpen,
}: {
  node: FileNode;
  depth: number;
  activePath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const isExpanded = expanded.has(pathKey(node.path));
  const isActive = activePath ? pathKey(activePath) === pathKey(node.path) : false;

  if (node.isDir) {
    return (
      <li>
        <button
          className="tree-row"
          style={{ "--tree-depth": depth } as CSSProperties}
          onClick={() => onToggle(node.path)}
          title={node.path}
          type="button"
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />}
          <span>{node.name}</span>
        </button>
        {isExpanded && (
          <ul>
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                expanded={expanded}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li>
      <button
        className={`tree-row tree-file ${isActive ? "is-active" : ""}`}
        style={{ "--tree-depth": depth } as CSSProperties}
        onClick={() => onOpen(node.path)}
        title={node.path}
        type="button"
      >
        <span className="tree-spacer" />
        <FileText size={15} />
        <span>{node.name}</span>
      </button>
    </li>
  );
}

function App() {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("未打开目录");
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const [readerFont, setReaderFont] = useState<ReaderFont>("serif");
  const [status, setStatus] = useState("就绪");
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const tabsRef = useRef(tabs);
  const workspacePathRef = useRef(workspacePath);
  const activePathRef = useRef(activePath);
  const articleRef = useRef<HTMLElement | null>(null);
  const readerMenuRef = useRef<Menu | null>(null);
  const pendingPaths = useRef(new Set<string>());
  const stalePaths = useRef(new Set<string>());
  const refreshTimers = useRef(new Map<string, number>());
  const treeRefreshTimer = useRef<number | null>(null);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    workspacePathRef.current = workspacePath;
  }, [workspacePath]);
  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  const loadWorkspace = useCallback(async (path: string, name = basename(path)) => {
    setLoading(true);
    try {
      const nodes = await invoke<FileNode[]>("open_workspace", { path });
      setWorkspacePath(path);
      setWorkspaceName(name);
      setTree(nodes);
      setExpanded((current) => {
        const next = new Set(current);
        nodes.filter((node) => node.isDir).forEach((node) => next.add(pathKey(node.path)));
        return next;
      });
      setStatus(`${nodes.length} 个顶层项目`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const openDocument = useCallback(async (path: string, quiet = false) => {
    const requestedKey = pathKey(path);
    const existing = tabsRef.current.find((tab) => pathKey(tab.path) === requestedKey);
    if (existing) {
      setActivePath(existing.path);
      setStatus("已切换到打开的标签");
      return;
    }
    if (pendingPaths.current.has(requestedKey)) return;

    pendingPaths.current.add(requestedKey);
    if (!quiet) setLoading(true);
    try {
      const document = await invoke<DocumentTab>("read_markdown_file", { path });
      setTabs((current) => {
        const duplicate = current.find((tab) => pathKey(tab.path) === pathKey(document.path));
        return duplicate ? current : [...current, document];
      });
      setActivePath(document.path);
      setStatus(document.path);
    } catch (error) {
      if (!quiet) setStatus(String(error));
    } finally {
      pendingPaths.current.delete(requestedKey);
      if (!quiet) setLoading(false);
    }
  }, []);

  const reloadDocument = useCallback(async (path: string) => {
    const requestedKey = pathKey(path);
    if (pathKey(activePathRef.current ?? "") !== requestedKey) return;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const document = await invoke<DocumentTab>("read_markdown_file", { path });
        if (pathKey(activePathRef.current ?? "") !== requestedKey) return;

        setTabs((current) => {
          const existing = current.find((tab) => pathKey(tab.path) === requestedKey);
          if (!existing || existing.content === document.content) return current;
          return current.map((tab) =>
            pathKey(tab.path) === requestedKey ? document : tab,
          );
        });
        return;
      } catch {
        if (attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 120 * (attempt + 1)));
        }
      }
    }
  }, []);

  useEffect(() => {
    if (!activePath) return;
    const activeKey = pathKey(activePath);
    if (!stalePaths.current.delete(activeKey)) return;
    void reloadDocument(activePath);
  }, [activePath, reloadDocument]);

  const chooseWorkspace = useCallback(async () => {
    if (!isTauri()) {
      setStatus("请在 Tauri 桌面窗口中选择目录");
      return;
    }
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      await loadWorkspace(selected);
    }
  }, [loadWorkspace]);

  const chooseFiles = useCallback(async () => {
    if (!isTauri()) {
      setStatus("请在 Tauri 桌面窗口中选择文件");
      return;
    }
    const selected = await open({
      multiple: true,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const path of paths) {
      await openDocument(path);
    }
  }, [openDocument]);

  const closeTab = useCallback((path: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => pathKey(tab.path) === pathKey(path));
      if (index < 0) return current;
      const next = current.filter((tab) => pathKey(tab.path) !== pathKey(path));
      if (pathKey(activePathRef.current ?? "") === pathKey(path)) {
        const nextActive = next[Math.min(index, next.length - 1)]?.path ?? null;
        setActivePath(nextActive);
      }
      return next;
    });
  }, []);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      const key = pathKey(path);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      setHydrated(true);
      setStatus("浏览器预览模式");
      return;
    }

    let cancelled = false;
    const restore = async () => {
      let session: Partial<SessionData> = {};
      try {
        session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}");
      } catch {
        localStorage.removeItem(SESSION_KEY);
      }

      if (typeof session.sidebarWidth === "number") setSidebarWidth(session.sidebarWidth);
      if (typeof session.sidebarVisible === "boolean") {
        setSidebarVisible(session.sidebarVisible);
      }
      if (isReaderFont(session.readerFont)) setReaderFont(session.readerFont);
      if (session.workspacePath) {
        await loadWorkspace(session.workspacePath, session.workspaceName);
      }
      for (const path of session.openPaths ?? []) {
        if (cancelled) return;
        await openDocument(path, true);
      }
      if (session.activePath && !cancelled) setActivePath(session.activePath);

      const initialPaths = await invoke<string[]>("initial_markdown_files");
      for (const path of initialPaths) {
        if (cancelled) return;
        await openDocument(path, true);
      }
      if (!cancelled) setHydrated(true);
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, [loadWorkspace, openDocument]);

  useEffect(() => {
    if (!hydrated) return;
    const session: SessionData = {
      workspacePath,
      workspaceName,
      openPaths: tabs.map((tab) => tab.path),
      activePath,
      sidebarWidth,
      sidebarVisible,
      readerFont,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }, [
    activePath,
    hydrated,
    sidebarVisible,
    sidebarWidth,
    readerFont,
    tabs,
    workspaceName,
    workspacePath,
  ]);

  useEffect(() => {
    if (!isTauri()) return;

    const unlisteners: Array<() => void> = [];
    void listen<OpenFilesPayload>("open-files", ({ payload }) => {
      payload.paths.forEach((path) => void openDocument(path));
    }).then((unlisten) => unlisteners.push(unlisten));

    void listen<FileChangePayload>("file-changed", ({ payload }) => {
      const changedKey = pathKey(payload.path);
      const activeDocument = activePathRef.current;
      if (activeDocument && pathKey(activeDocument) === changedKey) {
        const existingTimer = refreshTimers.current.get(changedKey);
        if (existingTimer) window.clearTimeout(existingTimer);
        const timer = window.setTimeout(() => {
          refreshTimers.current.delete(changedKey);
          void reloadDocument(activeDocument);
        }, 180);
        refreshTimers.current.set(changedKey, timer);
      } else if (tabsRef.current.some((tab) => pathKey(tab.path) === changedKey)) {
        stalePaths.current.add(changedKey);
      }

      const root = workspacePathRef.current;
      const structureChanged =
        payload.kind.startsWith("Create") ||
        payload.kind.startsWith("Remove") ||
        payload.kind.includes("Name(");
      if (root && structureChanged && changedKey.startsWith(`${pathKey(root)}/`)) {
        if (treeRefreshTimer.current) window.clearTimeout(treeRefreshTimer.current);
        treeRefreshTimer.current = window.setTimeout(() => {
          void invoke<FileNode[]>("open_workspace", { path: root }).then(setTree);
        }, 240);
      }
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
      refreshTimers.current.forEach((timer) => window.clearTimeout(timer));
      if (treeRefreshTimer.current) window.clearTimeout(treeRefreshTimer.current);
    };
  }, [openDocument, reloadDocument]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey;
      if (command && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void chooseWorkspace();
      } else if (command && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void chooseFiles();
      } else if (command && event.key.toLowerCase() === "w" && activePathRef.current) {
        event.preventDefault();
        closeTab(activePathRef.current);
      } else if (
        event.key === "F5" ||
        (command && event.key.toLowerCase() === "r")
      ) {
        event.preventDefault();
        if (activePathRef.current) void reloadDocument(activePathRef.current);
      } else if (event.key === "Tab" && event.ctrlKey && tabsRef.current.length > 1) {
        event.preventDefault();
        const currentIndex = tabsRef.current.findIndex(
          (tab) => pathKey(tab.path) === pathKey(activePathRef.current ?? ""),
        );
        const direction = event.shiftKey ? -1 : 1;
        const nextIndex =
          (currentIndex + direction + tabsRef.current.length) % tabsRef.current.length;
        setActivePath(tabsRef.current[nextIndex].path);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [chooseFiles, chooseWorkspace, closeTab, reloadDocument]);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const handleMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + moveEvent.clientX - startX),
      );
      setSidebarWidth(nextWidth);
    };
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const activeTab = tabs.find(
    (tab) => pathKey(tab.path) === pathKey(activePath ?? ""),
  );
  const renderedMarkdown = useMemo(
    () =>
      activeTab
        ? renderMarkdown(activeTab.content, activeTab.path)
        : { html: "", outline: [] },
    [activeTab],
  );

  useEffect(() => {
    const article = articleRef.current;
    if (!article || !activeTab) return;
    void renderMermaidDiagrams(article);
  }, [activeTab, renderedMarkdown.html]);

  const scrollToHeading = useCallback((id: string) => {
    const heading = articleRef.current?.querySelector<HTMLElement>(`#${id}`);
    heading?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const exportPdf = useCallback(async () => {
    const article = articleRef.current;
    if (!article) return;

    await renderMermaidDiagrams(article);
    const previousTitle = document.title;
    document.title = basename(activePathRef.current ?? "mdreader").replace(
      /\.(?:md|markdown)$/i,
      "",
    );
    window.addEventListener(
      "afterprint",
      () => {
        document.title = previousTitle;
      },
      { once: true },
    );
    window.print();
  }, []);

  const openReaderMenu = useCallback(async () => {
    if (!readerMenuRef.current) {
      readerMenuRef.current = await Menu.new({
        items: [
          { item: "Copy", text: "复制" },
          { item: "SelectAll", text: "全选" },
          { item: "Separator" },
          {
            id: "export-pdf",
            text: "导出 PDF...",
            action: () => void exportPdf(),
          },
        ],
      });
    }
    await readerMenuRef.current.popup();
  }, [exportPdf]);

  useEffect(
    () => () => {
      void readerMenuRef.current?.close();
    },
    [],
  );

  return (
    <div
      className="app-shell"
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--reader-font-family": READER_FONT_STACKS[readerFont],
        } as CSSProperties
      }
    >
      <header className="topbar">
        <div className="brand" aria-label="mdreader Markdown 阅读器">
          <span className="brand-mark">M</span>
          <span>mdreader</span>
        </div>
        <div className="toolbar-actions">
          <button
            className="icon-button"
            type="button"
            title={sidebarVisible ? "收起目录" : "展开目录"}
            onClick={() => setSidebarVisible((visible) => !visible)}
          >
            {sidebarVisible ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <span className="toolbar-divider" />
          <button className="command-button" type="button" onClick={() => void chooseWorkspace()}>
            <FolderOpen size={17} />
            打开目录
          </button>
          <button className="command-button" type="button" onClick={() => void chooseFiles()}>
            <File size={17} />
            打开文件
          </button>
        </div>
        <div className="window-status" title={status}>
          <span className={`status-dot ${loading ? "is-loading" : ""}`} />
          <span>{loading ? "正在读取" : status}</span>
        </div>
      </header>

      <div className={`workspace ${sidebarVisible ? "" : "sidebar-hidden"}`}>
        {sidebarVisible && (
          <>
            <aside className="sidebar">
              <div className="sidebar-heading">
                <div>
                  <span className="section-label">目录</span>
                  <strong title={workspacePath ?? undefined}>{workspaceName}</strong>
                </div>
                {workspacePath && (
                  <button
                    className="icon-button small"
                    type="button"
                    title="刷新目录"
                    onClick={() => void loadWorkspace(workspacePath, workspaceName)}
                  >
                    <RotateCcw size={15} />
                  </button>
                )}
              </div>
              <nav className="file-tree" aria-label="Markdown 文件目录">
                {tree.length > 0 ? (
                  <ul>
                    {tree.map((node) => (
                      <TreeItem
                        key={node.path}
                        node={node}
                        depth={0}
                        activePath={activePath}
                        expanded={expanded}
                        onToggle={toggleExpanded}
                        onOpen={openDocument}
                      />
                    ))}
                  </ul>
                ) : (
                  <button className="sidebar-empty" type="button" onClick={chooseWorkspace}>
                    <FolderOpen size={22} />
                    <span>打开一个 Markdown 目录</span>
                  </button>
                )}
              </nav>
            </aside>
            <div
              className="sidebar-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整目录宽度"
              onPointerDown={beginResize}
            />
          </>
        )}

        <main className="main-area">
          <div className="tab-strip" role="tablist" aria-label="打开的文档">
            {tabs.length === 0 ? (
              <span className="tab-placeholder">没有打开的文档</span>
            ) : (
              tabs.map((tab) => {
                const isActive = pathKey(tab.path) === pathKey(activePath ?? "");
                return (
                  <div
                    className={`tab ${isActive ? "is-active" : ""}`}
                    role="tab"
                    aria-selected={isActive}
                    key={tab.path}
                    title={tab.path}
                  >
                    <button
                      className="tab-select"
                      type="button"
                      onClick={() => setActivePath(tab.path)}
                    >
                      <FileText size={15} />
                      <span>{tab.name}</span>
                    </button>
                    <button
                      className="tab-close"
                      type="button"
                      title={`关闭 ${tab.name}`}
                      onClick={() => closeTab(tab.path)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {activeTab ? (
            <>
              <div className="document-bar">
                <div className="document-path">
                  <span>{dirname(activeTab.path)}</span>
                  <span className="document-name">{activeTab.name}</span>
                </div>
                <label className="font-picker" title="阅读字体">
                  <Type size={13} />
                  <select
                    aria-label="阅读字体"
                    value={readerFont}
                    onChange={(event) => setReaderFont(event.target.value as ReaderFont)}
                  >
                    <option value="serif">衬线</option>
                    <option value="rounded">圆润</option>
                    <option value="sans">无衬线</option>
                  </select>
                </label>
              </div>
              <div
                className="reader-layout"
                onContextMenu={(event) => {
                  if (!isTauri()) return;
                  event.preventDefault();
                  void openReaderMenu();
                }}
              >
                <div className="reader-scroll">
                  {renderedMarkdown.outline.length > 0 && (
                    <nav className="print-outline" aria-label="PDF 文档目录">
                      <h1>目录</h1>
                      <ol>
                        {renderedMarkdown.outline.map((item) => (
                          <li
                            data-level={item.level}
                            key={item.id}
                            style={{ marginLeft: `${(item.level - 1) * 14}px` }}
                          >
                            <a href={`#${item.id}`}>{item.text}</a>
                          </li>
                        ))}
                      </ol>
                    </nav>
                  )}
                  <article
                    ref={articleRef}
                    className="markdown-body"
                    dangerouslySetInnerHTML={{ __html: renderedMarkdown.html }}
                  />
                </div>
                {renderedMarkdown.outline.length > 0 && (
                  <aside className="document-outline" aria-label="当前文档目录">
                    <div className="outline-heading">本文目录</div>
                    <nav>
                      {renderedMarkdown.outline.map((item) => (
                        <button
                          className="outline-item"
                          data-level={item.level}
                          key={item.id}
                          style={{
                            paddingLeft: `${8 + (item.level - 1) * 12}px`,
                          }}
                          title={item.text}
                          type="button"
                          onClick={() => scrollToHeading(item.id)}
                        >
                          {item.text}
                        </button>
                      ))}
                    </nav>
                  </aside>
                )}
              </div>
            </>
          ) : (
            <section className="empty-reader">
              <div className="empty-glyph">
                <ChevronsLeft size={18} />
                <FileText size={34} />
                <ChevronsRight size={18} />
              </div>
              <h1>打开文档开始阅读</h1>
              <p>从左侧目录选择 Markdown 文件，或直接打开本地文件。</p>
              <div className="empty-actions">
                <button className="primary-button" type="button" onClick={chooseWorkspace}>
                  <FolderOpen size={17} />
                  打开目录
                </button>
                <button className="secondary-button" type="button" onClick={chooseFiles}>
                  <File size={17} />
                  打开文件
                </button>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
