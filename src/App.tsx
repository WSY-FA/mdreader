import { invoke, isTauri } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import DOMPurify from "dompurify";
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

interface SessionData {
  workspacePath: string | null;
  workspaceName: string;
  openPaths: string[];
  activePath: string | null;
  sidebarWidth: number;
  sidebarVisible: boolean;
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

function renderMarkdown(content: string, documentPath: string) {
  const parsed = marked.parse(content, {
    gfm: true,
    breaks: false,
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

  if (isTauri()) {
    template.content.querySelectorAll("img").forEach((image) => {
      const resolved = resolveAssetPath(documentPath, image.getAttribute("src") ?? "");
      if (resolved) image.src = convertFileSrc(resolved);
    });
  }

  return template.innerHTML;
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
  const [status, setStatus] = useState("就绪");
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const tabsRef = useRef(tabs);
  const workspacePathRef = useRef(workspacePath);
  const activePathRef = useRef(activePath);
  const pendingPaths = useRef(new Set<string>());
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
    try {
      const document = await invoke<DocumentTab>("read_markdown_file", { path });
      setTabs((current) =>
        current.map((tab) =>
          pathKey(tab.path) === pathKey(document.path)
            ? { ...document, refreshedAt: Date.now() }
            : tab,
        ),
      );
      if (pathKey(activePathRef.current ?? "") === pathKey(document.path)) {
        setStatus(`已自动更新 · ${new Date().toLocaleTimeString()}`);
      }
    } catch {
      // Editors may briefly replace a file during an atomic save. The next event retries it.
    }
  }, []);

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
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }, [
    activePath,
    hydrated,
    sidebarVisible,
    sidebarWidth,
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
      const openTab = tabsRef.current.find((tab) => pathKey(tab.path) === changedKey);
      if (openTab) {
        const existingTimer = refreshTimers.current.get(changedKey);
        if (existingTimer) window.clearTimeout(existingTimer);
        const timer = window.setTimeout(() => {
          refreshTimers.current.delete(changedKey);
          void reloadDocument(openTab.path);
        }, 140);
        refreshTimers.current.set(changedKey, timer);
      }

      const root = workspacePathRef.current;
      if (root && changedKey.startsWith(`${pathKey(root)}/`)) {
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
  }, [chooseFiles, chooseWorkspace, closeTab]);

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
    () => (activeTab ? renderMarkdown(activeTab.content, activeTab.path) : ""),
    [activeTab],
  );

  return (
    <div
      className="app-shell"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
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
                      {tab.refreshedAt && <i title="文件已自动更新" />}
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
                <span>{dirname(activeTab.path)}</span>
                <span className="document-name">{activeTab.name}</span>
              </div>
              <div className="reader-scroll">
                <article
                  className="markdown-body"
                  key={`${activeTab.path}-${activeTab.modifiedAt}`}
                  dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
                />
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
