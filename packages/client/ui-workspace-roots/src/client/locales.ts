/** Workspace-root panel dictionaries. */

/** Locale namespace owned by the workspace-root panel. */
export const NS = 'workspace-roots'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  trigger: '工作目录',
  'trigger.aria': '工作目录：{count} 个',
  'trigger.loading': '正在读取工作目录',
  title: '工作目录',
  close: '关闭',
  'list.aria': '本会话的工作目录',
  primary: '主目录',
  'origin.local': '本机磁盘',
  'origin.network-drive': '网络驱动器',
  'origin.other': '来源：{kind}',
  'origin.aria': '工作目录来源：{origin}',
  'empty.title': '只有主目录',
  'empty.description': '再添加一个目录，会话的搜索、语言服务与写入围栏都会一并覆盖它。',
  'add.label': '目录绝对路径',
  'add.placeholder': '/path/to/folder',
  'add.submit': '添加目录',
  'add.browse': '浏览…',
  'add.relative': '目录必须是绝对路径。',
  'add.duplicate': '该目录已在本会话中。',
  'remove.aria': '移除目录 {path}',
  saving: '正在保存…',
  retry: '重试',
} satisfies Record<string, string>

/** Workspace-root locale key union. */
export type WorkspaceRootsKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  trigger: 'Folders',
  'trigger.aria': 'Workspace folders: {count}',
  'trigger.loading': 'Reading workspace folders',
  title: 'Workspace folders',
  close: 'Close',
  'list.aria': 'Folders this session works in',
  primary: 'Primary',
  'origin.local': 'Local disk',
  'origin.network-drive': 'Network drive',
  'origin.other': 'Origin: {kind}',
  'origin.aria': 'Workspace origin: {origin}',
  'empty.title': 'Only the primary folder',
  'empty.description': 'Add another folder and this session covers it too, in search, language servers, and the write fence.',
  'add.label': 'Absolute folder path',
  'add.placeholder': '/path/to/folder',
  'add.submit': 'Add folder',
  'add.browse': 'Browse…',
  'add.relative': 'A folder must be an absolute path.',
  'add.duplicate': 'This session already works in that folder.',
  'remove.aria': 'Remove folder {path}',
  saving: 'Saving…',
  retry: 'Retry',
} satisfies Record<WorkspaceRootsKey, string>
