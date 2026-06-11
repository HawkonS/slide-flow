import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Power, RotateCw, Download, Server, Clock, HardDrive, ArrowUpCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { AdminConfigPage } from "./AdminConfigPage";
import { useNavLabel } from "@/lib/nav-config";

// ==================== 升级遮罩 ====================

type UpgradePhase = "upgrading" | "restarting" | "done";

/**
 * 升级中全屏遮罩：显示升级进度状态，轮询服务可用性，恢复后自动刷新。
 */
function UpgradeOverlay({ phase, elapsed }: { phase: UpgradePhase; elapsed: number }) {
  const phaseText: Record<UpgradePhase, string> = {
    upgrading: "正在拉取最新代码并升级...",
    restarting: "服务重启中，请稍候...",
    done: "升级完成，正在刷新页面...",
  };

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-5 text-center">
        {phase === "done" ? (
          <CheckCircle2 className="h-14 w-14 text-green-500" />
        ) : (
          <Loader2 className="h-14 w-14 animate-spin text-blue-500" />
        )}
        <div>
          <h2 className="text-xl font-semibold">系统升级中</h2>
          <p className="mt-2 text-sm text-muted-foreground">{phaseText[phase]}</p>
        </div>
        <p className="text-xs text-muted-foreground">
          已耗时 {elapsed} 秒 · 升级期间请勿关闭页面
        </p>
      </div>
    </div>
  );
}

// ==================== 运行状态 ====================

interface SystemStatus {
  uptime_seconds: number;
  backend_pid: number;
  backend_port: number;
  frontend_pid: number | null;
  frontend_port: number;
  start_time: string;
  config_file: string;
  log_dir: string;
  service_name: string;
  service_status: "running" | "stopped" | "unknown";
  service_enabled: "enabled" | "disabled" | "unknown";
  mode: "systemd" | "direct";
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);

  return parts.join('');
}

function RuntimeTab() {
  // 升级状态：控制全屏遮罩和轮询逻辑
  const [upgradeState, setUpgradeState] = React.useState<null | {
    phase: UpgradePhase;
    startTime: number;
  }>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const pollTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // 计时器：每秒更新已耗时
  React.useEffect(() => {
    if (!upgradeState) return;
    setElapsed(0);
    elapsedTimerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - upgradeState.startTime) / 1000));
    }, 1000);
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [upgradeState]);

  // 轮询逻辑：升级/重启后探测服务是否恢复
  React.useEffect(() => {
    if (!upgradeState || upgradeState.phase === "done") return;

    // 升级从 "upgrading" 开始需要等8秒；重启直接从 "restarting" 开始则等4秒
    const initialDelay = upgradeState.phase === "upgrading" ? 8000 : 4000;

    const startDelay = setTimeout(() => {
      if (upgradeState.phase === "upgrading") {
        setUpgradeState((s) => s ? { ...s, phase: "restarting" } : s);
      }

      // 每 3 秒轮询一次服务健康检查（使用原生 fetch，不经过 api() 以避免错误传播）
      pollTimerRef.current = setInterval(async () => {
        try {
          const res = await fetch("/api/admin/system/status", {
            credentials: "include",
            cache: "no-store",
          });
          if (res.ok) {
            // 服务恢复
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setUpgradeState((s) => s ? { ...s, phase: "done" } : s);
            // 等待 1.5 秒让用户看到"完成"状态后刷新
            setTimeout(() => window.location.reload(), 1500);
          }
          // 非 ok 响应（如 502）：静默忽略，继续轮询
        } catch {
          // 网络错误（服务完全不可达）：继续轮询
        }
      }, 3000);
    }, initialDelay);

    return () => {
      clearTimeout(startDelay);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [upgradeState?.phase]); // 依赖改为只看 phase 变化

  const { data, isLoading } = useQuery({
    queryKey: ["system", "status"],
    queryFn: async () => api<SystemStatus>("/api/admin/system/status"),
    refetchInterval: upgradeState ? false : 5000,
    enabled: !upgradeState,
  });

  const shutdownMut = useMutation({
    mutationFn: async () => api("/api/admin/system/shutdown", { method: "POST" }),
    onSuccess: () => toast.success("系统关闭指令已发送"),
    onError: (err: Error) => toast.error(err.message || "关闭失败"),
  });

  const restartMut = useMutation({
    mutationFn: async () => api("/api/admin/system/restart", { method: "POST" }),
    onSuccess: () => {
      // 显示升级遮罩，进入重启轮询流程
      setUpgradeState({ phase: "restarting", startTime: Date.now() });
    },
    onError: (err: Error) => toast.error(err.message || "重启失败"),
  });

  const upgradeMut = useMutation({
    mutationFn: async () => api("/api/admin/system/upgrade", { method: "POST" }),
    onSuccess: () => {
      // 显示升级遮罩，开始轮询
      setUpgradeState({ phase: "upgrading", startTime: Date.now() });
    },
    onError: (err: Error) => toast.error(err.message || "升级失败"),
  });

  const handleShutdown = () => {
    if (window.confirm("确定要关闭系统吗？这将停止所有服务。")) {
      shutdownMut.mutate();
    }
  };

  const handleRestart = () => {
    if (window.confirm("确定要重启系统吗？服务将短暂中断。")) {
      restartMut.mutate();
    }
  };

  const handleUpgrade = () => {
    if (window.confirm(
      "确定要升级系统吗？\n\n" +
      "此操作将：\n" +
      "1. 从 Git 仓库拉取最新代码\n" +
      "2. 自动重启服务\n\n" +
      "升级期间页面将显示升级进度，服务恢复后自动刷新，确定继续吗？"
    )) {
      upgradeMut.mutate();
    }
  };

  if (upgradeState) {
    return <UpgradeOverlay phase={upgradeState.phase} elapsed={elapsed} />;
  }

  if (isLoading || !data) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载状态中…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 状态卡片 */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">服务模式</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {data.mode === "systemd" ? (
                <Badge variant="default" className="text-sm">systemd</Badge>
              ) : (
                <Badge variant="secondary" className="text-sm">直接运行</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {data.mode === "systemd" ? (
                <>
                  服务: {data.service_name} | 
                  {data.service_status === "running" ? (
                    <span className="text-green-600">运行中</span>
                  ) : (
                    <span className="text-red-600">已停止</span>
                  )}
                </>
              ) : (
                "未使用 systemd"
              )}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">运行时长</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatUptime(data.uptime_seconds)}</div>
            <p className="text-xs text-muted-foreground">
              启动时间: {new Date(data.start_time).toLocaleString('zh-CN')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">后端服务</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              <Badge variant="default" className="text-sm">运行中</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              PID: {data.backend_pid} | 端口: {data.backend_port}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">前端服务</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {data.frontend_pid ? (
                <Badge variant="default" className="text-sm">运行中</Badge>
              ) : (
                <Badge variant="secondary" className="text-sm">未运行</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {data.frontend_pid ? `PID: ${data.frontend_pid} | ` : ''}端口: {data.frontend_port}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">配置文件</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-sm font-bold truncate" title={data.config_file}>
              {data.config_file}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              日志目录: {data.log_dir}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">开机自启</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {data.mode === "systemd" ? (
                data.service_enabled === "enabled" ? (
                  <Badge variant="default" className="text-sm">已开启</Badge>
                ) : (
                  <Badge variant="secondary" className="text-sm">已关闭</Badge>
                )
              ) : (
                <Badge variant="outline" className="text-sm">N/A</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {data.mode === "systemd" ? "systemd 服务自启状态" : "直接运行模式无此功能"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 控制按钮 */}
      <Card>
        <CardHeader>
          <CardTitle>服务控制</CardTitle>
          <CardDescription>
            {data.mode === "systemd" ? (
              <>使用 systemd 服务管理（{data.service_name}）。所有配置修改需要重启服务后生效。</>
            ) : (
              <>使用 start.sh/stop.sh 脚本管理服务。所有配置修改需要重启服务后生效。</>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="default"
              onClick={handleUpgrade}
              disabled={upgradeMut.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {upgradeMut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ArrowUpCircle className="mr-2 h-4 w-4" />
              )}
              系统升级
            </Button>
            <Button
              variant="outline"
              onClick={handleRestart}
              disabled={restartMut.isPending}
            >
              {restartMut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCw className="mr-2 h-4 w-4" />
              )}
              重启服务
            </Button>
            <Button
              variant="destructive"
              onClick={handleShutdown}
              disabled={shutdownMut.isPending}
            >
              {shutdownMut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Power className="mr-2 h-4 w-4" />
              )}
              关闭系统
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==================== 日志管理 ====================

interface LogFileInfo {
  filename: string;
  path: string;
  size_bytes: number;
  modified: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LogTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["system", "logs"],
    queryFn: async () => api<LogFileInfo[]>("/api/admin/system/logs"),
  });

  const handleDownload = (filename: string) => {
    const url = `/api/admin/system/logs/${encodeURIComponent(filename)}?download=true`;
    window.open(url, '_blank');
  };

  if (isLoading || !data) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载日志列表…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>日志文件列表</CardTitle>
          <CardDescription>
            下载并查看系统运行日志
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <div className="grid grid-cols-12 gap-4 px-4 py-3 text-sm font-medium border-b bg-muted/50">
              <div className="col-span-6">文件名</div>
              <div className="col-span-2">大小</div>
              <div className="col-span-3">修改时间</div>
              <div className="col-span-1">操作</div>
            </div>
            {data.map((log) => (
              <div
                key={log.filename}
                className="grid grid-cols-12 gap-4 px-4 py-3 text-sm border-b last:border-b-0 hover:bg-muted/30"
              >
                <div className="col-span-6 font-medium truncate" title={log.filename}>
                  {log.filename}
                </div>
                <div className="col-span-2 text-muted-foreground">
                  {formatFileSize(log.size_bytes)}
                </div>
                <div className="col-span-3 text-muted-foreground">
                  {new Date(log.modified).toLocaleString('zh-CN')}
                </div>
                <div className="col-span-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDownload(log.filename)}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
            {data.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                暂无日志文件
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==================== 主页面 ====================

export function AdminSystemPage() {
  return (
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-center gap-4">
        <h1 className="text-xl font-semibold tracking-tight">{useNavLabel("admin_system", "系统管理")}</h1>
      </header>

      <Tabs defaultValue="runtime" className="w-full">
        <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/60 p-1">
          <TabsTrigger value="runtime" className="px-3 py-1.5">
            运行管理
          </TabsTrigger>
          <TabsTrigger value="config" className="px-3 py-1.5">
            配置管理
          </TabsTrigger>
          <TabsTrigger value="logs" className="px-3 py-1.5">
            日志管理
          </TabsTrigger>
        </TabsList>

        <TabsContent value="runtime" className="mt-4">
          <RuntimeTab />
        </TabsContent>

        <TabsContent value="config" className="mt-4">
          <AdminConfigPage />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <LogTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default AdminSystemPage;
