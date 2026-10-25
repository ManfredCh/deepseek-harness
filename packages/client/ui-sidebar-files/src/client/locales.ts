/**
 * `sidebarFiles` namespace dictionaries, and the namespace's declaration.
 *
 * The failure lines name what the tree could not list, one code each, because a
 * directory that is gone, one outside the workspace, and a path that is not a
 * directory each suggest a different next step.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'sidebarFiles'>` or `PropsLocale<'sidebarFiles'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-tree type name, guide entry, row states, and failure lines. */
    sidebarFiles: SidebarFilesKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  copyUnavailable: '当前浏览器无法访问剪贴板，可从路径栏复制。',
  'error.writeDenied': '当前工作区禁止写入。', 'error.alreadyExists': '同名文件或文件夹已存在。', 'error.invalidName': '请填写单个文件或文件夹名称，不能包含路径分隔符。', 'error.sessionUnavailable': '请先打开这个会话再修改工作区。',
  back: '后退', forward: '前进', up: '上一级', copyPath: '复制完整路径', breadcrumbs: '目录面包屑', path: '当前目录路径', open: '打开', newFile: '新建文件', newFolder: '新建文件夹', showHidden: '显示隐藏文件', createIn: '创建位置：', entryName: '文件或文件夹名称', create: '创建', cancel: '取消', expand: '展开或收起 {name}',

  'shortcut.noSession': '请先选择会话',
  'type.label': '文件',
  'guide.title': '工作区文件',
  'guide.description': '浏览会话工作区的文件',
  loading: '正在读取…',
  empty: '空目录',
  truncated: '条目太多，只显示了一部分。',
  noWorkspace: '这个会话没有工作区目录。',
  reload: '重新读取',
  autoRefresh: '自动刷新',
  'autoRefresh.enable': '开启自动刷新',
  'autoRefresh.disable': '关闭自动刷新',
  'entry.other': '这不是文件或目录，没法打开。',
  'error.notFound': '这个目录不在了。可能已被移动或删除。',
  'error.outsideWorkspace': '这个目录在工作区之外，侧栏不会读取它。',
  'error.notDirectory': '这不是一个目录。',
  'error.unavailable': '读取失败：{message}',
} satisfies Record<string, string>

/** Files dictionary key union. */
export type SidebarFilesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  copyUnavailable: 'Clipboard unavailable; copy from the path field.',
  'error.writeDenied': 'This workspace is read-only.', 'error.alreadyExists': 'That file or folder already exists.', 'error.invalidName': 'Use one file or folder name, without path separators.', 'error.sessionUnavailable': 'Open this Session before modifying the workspace.',
  back: 'Back', forward: 'Forward', up: 'Up', copyPath: 'Copy full path', breadcrumbs: 'Directory breadcrumbs', path: 'Current directory path', open: 'Open', newFile: 'New file', newFolder: 'New folder', showHidden: 'Show hidden files', createIn: 'Create in:', entryName: 'File or folder name', create: 'Create', cancel: 'Cancel', expand: 'Expand or collapse {name}',

  'shortcut.noSession': 'Select a session first',
  'type.label': 'Files',
  'guide.title': 'Workspace files',
  'guide.description': 'Browse files in this session\'s workspace',
  loading: 'Reading…',
  empty: 'Empty directory',
  truncated: 'Too many entries, showing only some of them.',
  noWorkspace: 'This session has no workspace directory.',
  reload: 'Reload',
  autoRefresh: 'Auto refresh',
  'autoRefresh.enable': 'Enable auto refresh',
  'autoRefresh.disable': 'Disable auto refresh',
  'entry.other': 'Not a file or a directory, so it cannot be opened.',
  'error.notFound': 'That directory is gone. It may have been moved or deleted.',
  'error.outsideWorkspace': 'That directory is outside the workspace, so the sidebar will not read it.',
  'error.notDirectory': 'That is not a directory.',
  'error.unavailable': 'Read failed: {message}',
} satisfies Record<SidebarFilesKey, string>
