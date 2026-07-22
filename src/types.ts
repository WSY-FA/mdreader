export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

export interface DocumentTab {
  name: string;
  path: string;
  content: string;
  modifiedAt: number;
}

export interface FileChangePayload {
  path: string;
  kind: string;
}

export interface OpenFilesPayload {
  paths: string[];
}
