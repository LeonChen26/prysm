/**
 * 工具展示元数据（label、分类、能力与敏感标记）
 * 纯常量、无 node 依赖：服务端 tools.ts 定义工具时引用，前端 ChatPanel 渲染工具卡片时引用，
 * 避免两处手写维护漂移。新增工具时在此登记一条，并在 lib/tools.ts 的 label 处引用。
 *
 * 字段说明：
 * - label      前端展示名
 * - type       分类（文件/任务/网络/系统）
 * - surface    所属形态（work/coding），Phase 7 UI 分化与工具集筛选用
 * - sensitive  是否为敏感工具（需走审批流），替代 agent.ts 硬编码的 SENSITIVE_TOOLS
 * - capability 读写能力（readonly/readwrite），Phase 5 子 agent 按此筛选工具集
 */
export type ToolCapability = "readonly" | "readwrite";
export type ToolSurface = "work" | "coding";

export interface ToolMeta {
  label: string;
  type: string;
  surface?: ToolSurface;
  sensitive?: boolean;
  capability?: ToolCapability;
}

export const TOOL_META: Record<string, ToolMeta> = {
  list_dir: { label: "列出目录", type: "文件", capability: "readonly" },
  read_file: { label: "读取文件", type: "文件", capability: "readonly" },
  write_file: { label: "写入文件", type: "文件", capability: "readwrite", sensitive: true },
  append_file: { label: "追加写入", type: "文件", capability: "readwrite" },
  // coding 专属：基于精确文本替换的局部编辑（风格参考 pi-coding-agent 的 edit 工具），work 形态下不注入
  edit_file: { label: "精准编辑", type: "文件", capability: "readwrite", sensitive: true, surface: "coding" },
  create_dir: { label: "创建目录", type: "文件", capability: "readwrite" },
  move_file: { label: "移动/重命名", type: "文件", capability: "readwrite" },
  copy_file: { label: "复制文件", type: "文件", capability: "readwrite" },
  delete_file: { label: "删除文件", type: "文件", capability: "readwrite", sensitive: true },
  verify_file: { label: "校验文件", type: "文件", capability: "readonly" },
  todo_create: { label: "创建任务计划", type: "任务", capability: "readonly" },
  todo_modify: { label: "更新任务计划", type: "任务", capability: "readonly" },
  todo_list: { label: "查看任务计划", type: "任务", capability: "readonly" },
  // work 专属：联网检索（办公调研/资料查阅核心），coding 形态下不注入
  web_search: { label: "网页搜索", type: "网络", capability: "readonly", surface: "work" },
  fetch_url: { label: "抓取网页", type: "网络", capability: "readonly", surface: "work" },
  search_files: { label: "搜索文件内容", type: "文件", capability: "readonly" },
  // 按文件名 glob 查找文件（与 search_files 互补，参考 pi-coding-agent 的 find）
  find: { label: "查找文件", type: "文件", capability: "readonly" },
  // coding 专属：命令执行 / 环境与端口调试（编码调试核心），work 形态下不注入
  run_bash: { label: "执行命令", type: "系统", capability: "readwrite", sensitive: true, surface: "coding" },
  env_info: { label: "环境信息", type: "系统", capability: "readonly", surface: "coding" },
  port_check: { label: "端口查询", type: "系统", capability: "readonly", surface: "coding" },
};
