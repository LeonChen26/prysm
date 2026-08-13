/**
 * 工具展示元数据（label 与分类）
 * 纯常量、无 node 依赖：服务端 tools.ts 定义工具时引用，前端 ChatPanel 渲染工具卡片时引用，
 * 避免两处手写维护漂移。新增工具时在此登记一条，并在 lib/tools.ts 的 label 处引用。
 */
export const TOOL_META: Record<string, { label: string; type: string }> = {
  list_dir: { label: "列出目录", type: "文件" },
  read_file: { label: "读取文件", type: "文件" },
  write_file: { label: "写入文件", type: "文件" },
  append_file: { label: "追加写入", type: "文件" },
  create_dir: { label: "创建目录", type: "文件" },
  move_file: { label: "移动/重命名", type: "文件" },
  copy_file: { label: "复制文件", type: "文件" },
  delete_file: { label: "删除文件", type: "文件" },
  verify_file: { label: "校验文件", type: "文件" },
  todo_create: { label: "创建任务计划", type: "任务" },
  todo_modify: { label: "更新任务计划", type: "任务" },
  todo_list: { label: "查看任务计划", type: "任务" },
  web_search: { label: "网页搜索", type: "网络" },
  fetch_url: { label: "抓取网页", type: "网络" },
  search_files: { label: "搜索文件内容", type: "文件" },
  run_bash: { label: "执行命令", type: "系统" },
  env_info: { label: "环境信息", type: "系统" },
  port_check: { label: "端口查询", type: "系统" },
};
