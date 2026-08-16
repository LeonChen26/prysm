/**
 * Prysm 桌面壳 —— preload（contextBridge）
 * 把核心 IPC 能力以 window.prysm 暴露给渲染进程；事件流经 'prysm:event' 通道推送。
 */
import { contextBridge, ipcRenderer } from "electron";

const prysm = {
  // 会话
  listSessions: () => ipcRenderer.invoke("prysm:listSessions"),
  createSession: (opts?: { title?: string; surface?: string }) =>
    ipcRenderer.invoke("prysm:createSession", opts),
  renameSession: (id: string, title: string) =>
    ipcRenderer.invoke("prysm:renameSession", id, title),
  deleteSession: (id: string) => ipcRenderer.invoke("prysm:deleteSession", id),
  getMessages: (sessionId: string) => ipcRenderer.invoke("prysm:getMessages", sessionId),
  // 对话
  prompt: (opts: {
    sessionId?: string;
    message?: string;
    images?: { data: string; mimeType: string }[];
  }) => ipcRenderer.invoke("prysm:prompt", opts),
  stop: (sessionId: string) => ipcRenderer.invoke("prysm:stop", sessionId),
  // 审批
  listPendingApprovals: () => ipcRenderer.invoke("prysm:listPendingApprovals"),
  approve: (id: string, ok: boolean) => ipcRenderer.invoke("prysm:approve", id, ok),
  // 计划
  listPendingPlans: () => ipcRenderer.invoke("prysm:listPendingPlans"),
  decidePlan: (id: string, ok: boolean) => ipcRenderer.invoke("prysm:decidePlan", id, ok),
  // 工作区 / 技能 / 日志 / 路由
  listWorkspaces: () => ipcRenderer.invoke("prysm:listWorkspaces"),
  addWorkspace: (root: string, name?: string) =>
    ipcRenderer.invoke("prysm:addWorkspace", root, name),
  removeWorkspace: (id: string) => ipcRenderer.invoke("prysm:removeWorkspace", id),
  grantWorkspaceAccess: (id: string) => ipcRenderer.invoke("prysm:grantWorkspaceAccess", id),
  revokeWorkspaceAccess: (id: string) => ipcRenderer.invoke("prysm:revokeWorkspaceAccess", id),
  listSkills: () => ipcRenderer.invoke("prysm:listSkills"),
  enableSkill: (name: string) => ipcRenderer.invoke("prysm:enableSkill", name),
  disableSkill: (name: string) => ipcRenderer.invoke("prysm:disableSkill", name),
  // 在系统文件管理器中定位文件（权限配置文件）
  openPath: (p: string) => ipcRenderer.invoke("prysm:openPath", p),
  listRunLogs: () => ipcRenderer.invoke("prysm:listRunLogs"),
  listModelRoutes: () => ipcRenderer.invoke("prysm:listModelRoutes"),
  setModelRoute: (role: string, provider: string, model: string) =>
    ipcRenderer.invoke("prysm:setModelRoute", role, provider, model),
  // 事件流订阅（返回取消函数）
  onEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => cb(event);
    ipcRenderer.on("prysm:event", listener);
    return () => ipcRenderer.removeListener("prysm:event", listener);
  },
};

contextBridge.exposeInMainWorld("prysm", prysm);