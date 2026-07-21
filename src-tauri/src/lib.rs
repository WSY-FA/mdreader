use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{Emitter, Manager, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<FileNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentSnapshot {
    name: String,
    path: String,
    content: String,
    modified_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChangePayload {
    path: String,
    kind: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenFilesPayload {
    paths: Vec<String>,
}

struct WatchRegistry {
    watcher: RecommendedWatcher,
    watched_paths: HashSet<PathBuf>,
}

struct AppState {
    registry: Mutex<WatchRegistry>,
    pending_files: Mutex<Vec<String>>,
}

fn canonicalize(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    fs::canonicalize(path.as_ref()).map_err(|error| {
        format!(
            "无法访问路径 {}：{error}",
            path.as_ref().to_string_lossy()
        )
    })
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

fn should_skip_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.') || matches!(name, "node_modules" | "target"))
}

fn read_tree(directory: &Path) -> Result<Vec<FileNode>, String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("无法读取目录 {}：{error}", directory.to_string_lossy()))?;

    let mut directories = Vec::new();
    let mut files = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;

        if file_type.is_dir() {
            if should_skip_dir(&path) {
                continue;
            }

            let children = read_tree(&path)?;
            if !children.is_empty() {
                directories.push(FileNode {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: path_to_string(&path),
                    is_dir: true,
                    children,
                });
            }
        } else if file_type.is_file() && is_markdown(&path) {
            files.push(FileNode {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path_to_string(&path),
                is_dir: false,
                children: Vec::new(),
            });
        }
    }

    directories.sort_by_key(|node| node.name.to_lowercase());
    files.sort_by_key(|node| node.name.to_lowercase());
    directories.extend(files);
    Ok(directories)
}

fn register_watch(
    path: &Path,
    mode: RecursiveMode,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "文件监听器状态不可用".to_string())?;

    if registry.watched_paths.insert(path.to_path_buf()) {
        if let Err(error) = registry.watcher.watch(path, mode) {
            registry.watched_paths.remove(path);
            return Err(format!(
                "无法监听路径 {}：{error}",
                path.to_string_lossy()
            ));
        }
    }

    Ok(())
}

#[tauri::command]
fn open_workspace(path: String, state: State<'_, AppState>) -> Result<Vec<FileNode>, String> {
    let root = canonicalize(path)?;
    if !root.is_dir() {
        return Err("所选路径不是目录".to_string());
    }

    register_watch(&root, RecursiveMode::Recursive, &state)?;
    read_tree(&root)
}

#[tauri::command]
fn read_markdown_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<DocumentSnapshot, String> {
    let canonical_path = canonicalize(path)?;
    if !canonical_path.is_file() || !is_markdown(&canonical_path) {
        return Err("请选择 Markdown 文件".to_string());
    }

    // Watch the parent so atomic-save renames are observed on Windows and macOS.
    if let Some(parent) = canonical_path.parent() {
        register_watch(parent, RecursiveMode::NonRecursive, &state)?;
    }

    let metadata = fs::metadata(&canonical_path).map_err(|error| error.to_string())?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64);
    let content = fs::read_to_string(&canonical_path)
        .map_err(|error| format!("无法读取 {}：{error}", canonical_path.to_string_lossy()))?;

    Ok(DocumentSnapshot {
        name: canonical_path
            .file_name()
            .map_or_else(String::new, |name| name.to_string_lossy().into_owned()),
        path: path_to_string(&canonical_path),
        content,
        modified_at,
    })
}

#[tauri::command]
fn initial_markdown_files(state: State<'_, AppState>) -> Vec<String> {
    let mut paths = markdown_paths_from_args(std::env::args_os().skip(1));
    if let Ok(mut pending) = state.pending_files.lock() {
        paths.append(&mut pending);
    }
    paths.sort_by_key(|path| path.to_lowercase());
    paths.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    paths
}

fn markdown_paths_from_args<I>(args: I) -> Vec<String>
where
    I: IntoIterator,
    I::Item: AsRef<std::ffi::OsStr>,
{
    args.into_iter()
        .filter_map(|argument| {
            let path = PathBuf::from(argument.as_ref());
            if !is_markdown(&path) {
                return None;
            }
            canonicalize(path).ok().map(|path| path_to_string(&path))
        })
        .collect()
}

fn focus_and_open(app: &tauri::AppHandle, paths: Vec<String>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }

    if paths.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut pending) = state.pending_files.lock() {
            pending.extend(paths.iter().cloned());
        }
    }
    let _ = app.emit("open-files", OpenFilesPayload { paths });
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = markdown_paths_from_args(args.into_iter().skip(1));
            focus_and_open(app, paths);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let watcher = RecommendedWatcher::new(
                move |result: notify::Result<notify::Event>| {
                    let Ok(event) = result else {
                        return;
                    };
                    if matches!(event.kind, EventKind::Access(_)) {
                        return;
                    }

                    let kind = format!("{:?}", event.kind);
                    for path in event.paths {
                        let _ = app_handle.emit(
                            "file-changed",
                            FileChangePayload {
                                path: path_to_string(&path),
                                kind: kind.clone(),
                            },
                        );
                    }
                },
                Config::default(),
            )
            .map_err(|error| error.to_string())?;

            app.manage(AppState {
                registry: Mutex::new(WatchRegistry {
                    watcher,
                    watched_paths: HashSet::new(),
                }),
                pending_files: Mutex::new(Vec::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            read_markdown_file,
            initial_markdown_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building mdreader");

    app.run(|app, event| {
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);

        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .filter(|path| is_markdown(path))
                .filter_map(|path| canonicalize(path).ok())
                .map(|path| path_to_string(&path))
                .collect();
            focus_and_open(app, paths);
        }
    });
}
