import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpCircle,
  CheckCircle2,
  Clock,
  Download,
  HardDrive,
  Loader2,
  Pause,
  Play,
  Power,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Wifi,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ApiError, api, downloadFile } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/PageHeader";
import { AdminConfigPage } from "./AdminConfigPage";

// ==================== 升级遮罩 ====================

type UpgradePhase = "upgrading" | "restarting" | "done" | "failed";

type UpgradeState = {
  phase: UpgradePhase;
  startTime: number;
  operation?: "upgrade" | "restart";
  jobId?: string;
  errorMessage?: string;
  statusMessage?: string;
  baselineBootId?: string | null;
  baselineStartTime?: string | null;
};

type UpgradeTaskState = "idle" | "queued" | "running" | "restarting" | "succeeded" | "failed";

interface UpgradeTaskStatus {
  job_id?: string;
  operation?: "upgrade" | "restart" | "shutdown";
  state: UpgradeTaskState;
  message: string;
}

interface UpgradeStartResponse {
  job_id: string;
  state: "queued";
  message: string;
}

/**
 * 升级中全屏遮罩：显示升级进度状态，轮询服务可用性，恢复后自动刷新；
 * 超时或服务端返回认证失败时进入 failed 状态，提供关闭入口，避免无限等待。
 */
function UpgradeOverlay({
  phase,
  elapsed,
  errorMessage,
  statusMessage,
  operation,
  onClose,
}: {
  phase: UpgradePhase;
  elapsed: number;
  errorMessage?: string;
  statusMessage?: string;
  operation?: "upgrade" | "restart";
  onClose: () => void;
}) {
  const isRestart = operation === "restart";
  const phaseText: Record<UpgradePhase, string> = {
    upgrading: isRestart ? "正在准备重启服务..." : "正在拉取最新代码并升级...",
    restarting: "服务重启中，请稍候...",
    done: `${isRestart ? "重启" : "升级"}完成，正在刷新页面...`,
    failed: "未能在预期时间内检测到服务恢复",
  };

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-5 text-center">
        {phase === "done" ? (
          <CheckCircle2 className="h-14 w-14 text-green-500" />
        ) : phase === "failed" ? (
          <XCircle className="h-14 w-14 text-red-500" />
        ) : (
          <Loader2 className="h-14 w-14 animate-spin text-blue-500" />
        )}
        <div>
          <h2 className="text-xl font-semibold">
            {phase === "failed"
              ? `${isRestart ? "重启" : "升级"}状态异常`
              : phase === "done"
                ? `${isRestart ? "重启" : "升级"}完成`
                : isRestart ? "系统重启中" : "系统升级中"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{phaseText[phase]}</p>
        </div>
        {phase === "failed" ? (
          <>
            <p className="max-w-sm text-xs text-muted-foreground">
              {errorMessage || `${isRestart ? "重启" : "升级"}可能失败或服务尚未恢复，请查看运行日志，必要时手动恢复服务。`}
            </p>
            <Button variant="outline" onClick={onClose}>关闭并返回</Button>
          </>
        ) : (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>已耗时 {elapsed} 秒 · 操作期间请勿关闭页面</p>
            {statusMessage && <p className="max-w-sm text-amber-600">{statusMessage}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== 升级状态持久化 ====================

const UPGRADE_STATE_KEY = "slideflow_upgrade_state";

// 升级阶段先留出 git 拉取和停服务的时间；已进入重启阶段或重新打开页面时立即探测
const UPGRADE_INITIAL_DELAY = 1_000;
const POLL_INTERVAL = 3_000;
// 依赖安装和前端构建在慢网络环境下可能超过 3 分钟；服务端会即时报告脚本失败，
// 浏览器仅保留一个宽松的最终兜底，避免正常的长升级被误判为失败。
const UPGRADE_TIMEOUT = 15 * 60_000;

function saveUpgradeState(state: UpgradeState) {
  try {
    sessionStorage.setItem(UPGRADE_STATE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

function loadUpgradeState(): UpgradeState | null {
  try {
    const raw = sessionStorage.getItem(UPGRADE_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UpgradeState;
    // Do not revive the pre-baseline format. It could only tell that the
    // endpoint was reachable, which is exactly how a completed upgrade was
    // left showing an endless timer after navigating back to this page.
    if (
      !parsed ||
      typeof parsed.startTime !== "number" ||
      !["upgrading", "restarting", "done", "failed"].includes(parsed.phase) ||
      (!parsed.jobId && !parsed.baselineBootId && !parsed.baselineStartTime)
    ) {
      sessionStorage.removeItem(UPGRADE_STATE_KEY);
      return null;
    }
    // 超过 30 分钟自动过期，避免异常关闭浏览器后永久残留
    if (Date.now() - parsed.startTime > 30 * 60 * 1000) {
      sessionStorage.removeItem(UPGRADE_STATE_KEY);
      return null;
    }
    // done / failed 状态无需恢复
    if (parsed.phase === "done" || parsed.phase === "failed") {
      sessionStorage.removeItem(UPGRADE_STATE_KEY);
      return null;
    }
    // 旧版重启流程没有服务端任务状态，只能在刷新后直接探测新进程；
    // 新版升级任务以服务端持久化状态为准，不能提前显示“重启中”。
    if (parsed.phase === "upgrading" && !parsed.jobId) {
      parsed.phase = "restarting";
    }
    if (!parsed.operation) {
      parsed.operation = parsed.jobId ? "upgrade" : "restart";
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(UPGRADE_STATE_KEY);
    return null;
  }
}

function clearUpgradeState() {
  try {
    sessionStorage.removeItem(UPGRADE_STATE_KEY);
  } catch { /* ignore */ }
}

// ==================== 运行状态 ====================

interface SystemStatus {
  uptime_seconds: number;
  backend_pid: number;
  backend_port: number;
  boot_id: string | null;
  frontend_pid: number | null;
  frontend_port: number;
  /** "static" = 生产模式前端由后端静态托管；"dev" = Vite dev server 运行中 */
  frontend_mode: "static" | "dev";
  start_time: string;
  config_file: string;
  log_dir: string;
  service_name: string;
  service_status: "running" | "stopped" | "activating" | "deactivating" | "failed" | "reloading" | "maintenance" | "unknown";
  service_enabled: "enabled" | "enabled-runtime" | "linked" | "linked-runtime" | "static" | "indirect" | "generated" | "transient" | "disabled" | "masked" | "masked-runtime" | "unknown";
  mode: "systemd" | "direct";
  windows_renderer: {
    process: {
      status: "running" | "idle" | "disconnected" | "stopped";
      worker_count: number;
      active_task_count: number;
      worker_id: string | null;
      task_id: string | null;
    };
    connection: {
      status: "connected" | "disconnected";
      worker_count: number;
      worker_id: string | null;
      last_seen_at: string | null;
      age_seconds: number | null;
    };
  };
  oss: {
    status: "connected" | "disconnected" | "misconfigured" | "disabled";
    endpoint_type: "internal" | "external" | null;
    message: string;
    checked_at: number;
  };
}

const rendererProcessLabels: Record<SystemStatus["windows_renderer"]["process"]["status"], string> = {
  running: "运行中", idle: "空闲", disconnected: "进程失联", stopped: "未运行",
};

const rendererConnectionLabels: Record<SystemStatus["windows_renderer"]["connection"]["status"], string> = {
  connected: "已连接", disconnected: "未连接",
};

const ossStatusLabels: Record<SystemStatus["oss"]["status"], string> = {
  connected: "已连接", disconnected: "连接失败", misconfigured: "配置错误", disabled: "未启用",
};

const ossEndpointLabels: Record<Exclude<SystemStatus["oss"]["endpoint_type"], null>, string> = {
  internal: "内网",
  external: "外网",
};

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
  // 升级状态：控制全屏遮罩和轮询逻辑（从 sessionStorage 恢复，避免页面刷新丢失）
  const [upgradeState, setUpgradeState] = React.useState<UpgradeState | null>(() => loadUpgradeState());
  const [elapsed, setElapsed] = React.useState(0);

  // 同步升级状态到 sessionStorage，确保页面刷新后能恢复。终态不持久化，
  // 防止用户手动刷新或切换页面后再次看到已经完成的倒计时。
  React.useEffect(() => {
    if (upgradeState && upgradeState.phase !== "done" && upgradeState.phase !== "failed") {
      saveUpgradeState(upgradeState);
    } else {
      clearUpgradeState();
    }
  }, [upgradeState?.phase, upgradeState?.startTime]);
  const pollTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const elapsedTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const reloadTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const probeRef = React.useRef<(() => void) | null>(null);
  const probeFailuresRef = React.useRef(0);

  React.useEffect(() => () => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
  }, []);

  // 计时器：每秒更新已耗时（基于 startTime 累计，阶段切换不重置）
  React.useEffect(() => {
    if (!upgradeState) return;
    setElapsed(Math.floor((Date.now() - upgradeState.startTime) / 1000));
    elapsedTimerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - upgradeState.startTime) / 1000));
    }, 1000);
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [upgradeState]);

  const failUpgrade = React.useCallback((reason: string) => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    clearUpgradeState();
    setUpgradeState((s) => (s ? { ...s, phase: "failed", errorMessage: reason } : s));
    toast.error(reason);
  }, []);

  const completeUpgrade = React.useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    clearUpgradeState();
    setUpgradeState((s) => (s ? { ...s, phase: "done" } : s));
    // 状态先短暂显示完成，再获取新的 index.html 和 hashed chunks。
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => window.location.reload(), 500);
  }, []);

  // 轮询逻辑：只有确认服务启动批次发生变化后才判定升级完成。
  React.useEffect(() => {
    if (!upgradeState) return;
    if (upgradeState.phase === "done" || upgradeState.phase === "failed") return;

    const startTime = upgradeState.startTime;
    const operationLabel = upgradeState.operation === "restart" ? "重启" : "升级";
    const initialDelay = upgradeState.jobId && upgradeState.phase === "upgrading" ? UPGRADE_INITIAL_DELAY : 0;
    let cancelled = false;
    let inFlight = false;

    const hasRestarted = (status: SystemStatus) => {
      if (upgradeState.baselineBootId && status.boot_id) {
        return upgradeState.baselineBootId !== status.boot_id;
      }
      // A mixed-version deployment may have supplied no boot_id before the
      // upgrade. Seeing the field after the service returns proves that the
      // new backend is serving the request, so do not fall back to a worker
      // PID/start time that may differ across Gunicorn workers.
      if (!upgradeState.baselineBootId && status.boot_id) {
        return true;
      }
      // Backward-compatible fallback for installations that were started
      // without run.sh/SLIDEFLOW_BOOT_ID.
      return Boolean(
        upgradeState.baselineStartTime &&
        status.start_time &&
        upgradeState.baselineStartTime !== status.start_time,
      );
    };

    const probe = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        if (Date.now() - startTime > UPGRADE_TIMEOUT) {
          failUpgrade(`等待服务恢复超时，${operationLabel}可能未成功，请检查运行日志`);
          return;
        }
        const path = upgradeState.jobId
          ? "/api/admin/system/operation/status"
          : "/api/admin/system/status";
        const controller = new AbortController();
        const requestTimeout = window.setTimeout(() => controller.abort(), 10_000);
        let res: Response;
        try {
          res = await fetch(path, {
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          });
        } finally {
          window.clearTimeout(requestTimeout);
        }
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          failUpgrade("服务已恢复但登录状态失效，请重新登录");
          return;
        }
        if (res.ok) {
          if (upgradeState.jobId) {
            const status = (await res.json()) as UpgradeTaskStatus;
            // Ignore a stale response from a previous completed task. Active
            // upgrades are locked server-side, so the matching job remains
            // authoritative until it reaches a terminal state.
            if (status.state === "idle") {
              probeFailuresRef.current += 1;
              if (probeFailuresRef.current >= 3) {
                failUpgrade(`${operationLabel}任务状态丢失，请检查运行日志`);
                return;
              }
            } else {
              probeFailuresRef.current = 0;
              if (upgradeState.statusMessage) {
                setUpgradeState((current) => current ? { ...current, statusMessage: undefined } : current);
              }
            }
            if (status.job_id && status.job_id !== upgradeState.jobId) {
              failUpgrade(`${operationLabel}任务状态不匹配，请检查是否有其他管理员重新发起了运行操作`);
              return;
            }
            if (status.operation && upgradeState.operation && status.operation !== upgradeState.operation) {
              failUpgrade("运行操作类型不匹配，请检查是否有其他管理员发起了操作");
              return;
            }
            if (status.state === "failed") {
              failUpgrade(status.message || `${operationLabel}失败，请检查运行日志`);
              return;
            }
            if (status.state === "succeeded") {
              completeUpgrade();
              return;
            }
            if (status.state === "restarting" && upgradeState.phase !== "restarting") {
              setUpgradeState((current) => current ? { ...current, phase: "restarting" } : current);
              return;
            }
          } else {
            const status = (await res.json()) as SystemStatus;
            probeFailuresRef.current = 0;
            if (upgradeState.statusMessage) {
              setUpgradeState((current) => current ? { ...current, statusMessage: undefined } : current);
            }
            // A healthy response from the old process is not completion. This
            // is the key guard against clearing the restart state too early.
            if (hasRestarted(status)) {
              completeUpgrade();
              return;
            }
          }
        } else {
          probeFailuresRef.current += 1;
        }
      } catch {
        // The service is expected to be unreachable while it restarts.
        probeFailuresRef.current += 1;
      } finally {
        inFlight = false;
      }
      if (probeFailuresRef.current === 3) {
        setUpgradeState((current) => current ? {
          ...current,
          statusMessage: "服务暂时不可达，仍在等待恢复；若持续失败请查看运行日志。",
        } : current);
      }
      if (!cancelled) {
        pollTimerRef.current = setTimeout(probe, POLL_INTERVAL);
      }
    };

    probeRef.current = () => { void probe(); };
    const kickoff = () => {
      if (cancelled) return;
      if (!upgradeState.jobId && upgradeState.phase === "upgrading") {
        setUpgradeState((s) => (s ? { ...s, phase: "restarting" } : s));
        return;
      }
      void probe();
    };
    pollTimerRef.current = setTimeout(kickoff, initialDelay);
    const onVisible = () => {
      if (!document.hidden) {
        if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
        probeRef.current?.();
      }
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      probeRef.current = null;
    };
  }, [upgradeState, completeUpgrade, failUpgrade]);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
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
    mutationFn: async () => api<UpgradeStartResponse>("/api/admin/system/restart", { method: "POST" }),
    onSuccess: (result) => {
      // 显示升级遮罩，进入重启轮询流程
      const nextState: UpgradeState = {
        phase: "restarting",
        startTime: Date.now(),
        operation: "restart",
        jobId: result.job_id,
        baselineBootId: data?.boot_id,
        baselineStartTime: data?.start_time,
      };
      // 先写入再更新 React，用户切到其他管理页或刷新时也能恢复监控。
      saveUpgradeState(nextState);
      probeFailuresRef.current = 0;
      setUpgradeState(nextState);
    },
    onError: (err: Error) => toast.error(err.message || "重启失败"),
  });

  const upgradeMut = useMutation({
    mutationFn: async () => api<UpgradeStartResponse>("/api/admin/system/upgrade", { method: "POST" }),
    onSuccess: (result) => {
      // 显示升级遮罩，开始轮询
      const nextState: UpgradeState = {
        phase: "upgrading",
        startTime: Date.now(),
        operation: "upgrade",
        jobId: result.job_id,
        baselineBootId: data?.boot_id,
        baselineStartTime: data?.start_time,
      };
      // 先写入再更新 React，用户切到其他管理页或刷新时也能恢复监控。
      saveUpgradeState(nextState);
      probeFailuresRef.current = 0;
      setUpgradeState(nextState);
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

  const operationPending = shutdownMut.isPending || restartMut.isPending || upgradeMut.isPending;

  const serviceStatusLabel: Record<SystemStatus["service_status"], string> = {
    running: "运行中",
    stopped: "已停止",
    activating: "启动中",
    deactivating: "停止中",
    failed: "故障",
    reloading: "重载中",
    maintenance: "维护中",
    unknown: "未知",
  };
  const serviceEnabledLabel: Record<SystemStatus["service_enabled"], string> = {
    enabled: "已开启",
    "enabled-runtime": "本次启动已开启",
    linked: "已链接",
    "linked-runtime": "本次启动已链接",
    static: "静态单元",
    indirect: "间接启用",
    generated: "动态生成",
    transient: "临时单元",
    disabled: "已关闭",
    masked: "已屏蔽",
    "masked-runtime": "本次启动已屏蔽",
    unknown: "未知",
  };

  if (upgradeState) {
    return (
      <UpgradeOverlay
        phase={upgradeState.phase}
        elapsed={elapsed}
        errorMessage={upgradeState.errorMessage}
        statusMessage={upgradeState.statusMessage}
        operation={upgradeState.operation}
        onClose={() => {
          clearUpgradeState();
          setUpgradeState(null);
        }}
      />
    );
  }

  if (isLoading || (!data && !isError)) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载状态中…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <XCircle className="h-8 w-8 text-red-500" />
        <p>无法获取系统状态，服务可能尚未恢复</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="border-b pb-4">
          <CardTitle>服务控制</CardTitle>
          <CardDescription>
            {data.mode === "systemd"
              ? <>使用 systemd 服务管理（{data.service_name}）。配置修改后需要重启服务生效。</>
              : <>使用 run.sh/stop.sh 脚本管理服务。配置修改后需要重启服务生效。</>}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="default" onClick={handleUpgrade} disabled={operationPending} className="bg-blue-600 hover:bg-blue-700">
              {upgradeMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowUpCircle className="mr-2 h-4 w-4" />}
              系统升级
            </Button>
            <Button variant="outline" onClick={handleRestart} disabled={operationPending}>
              {restartMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
              重启服务
            </Button>
            <Button variant="destructive" onClick={handleShutdown} disabled={operationPending}>
              {shutdownMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Power className="mr-2 h-4 w-4" />}
              关闭系统
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">运行状态</h2>
          <p className="mt-1 text-xs text-muted-foreground">服务、存储和 Windows 渲染子进程的实时状态。</p>
        </div>
        <span className="text-xs text-muted-foreground">每 5 秒自动刷新</span>
      </div>

      {/* 状态卡片 */}
      <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="flex min-h-[148px] flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">服务模式</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-3">
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
                  <span className={data.service_status === "running" ? "text-green-600" : data.service_status === "failed" ? "text-red-600" : "text-amber-600"}>
                    {serviceStatusLabel[data.service_status]}
                  </span>
                </>
              ) : (
                "未使用 systemd"
              )}
            </p>
          </CardContent>
        </Card>

        <Card className="flex min-h-[148px] flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">OSS 连接状态</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-3">
            <div className="text-2xl font-bold">
              <Badge
                variant={data.oss.status === "connected" ? "default" : data.oss.status === "disconnected" || data.oss.status === "misconfigured" ? "destructive" : "secondary"}
                className="text-sm"
              >
                {data.oss.status === "connected"
                  ? `${ossStatusLabels[data.oss.status]}（${ossEndpointLabels[data.oss.endpoint_type ?? "external"]}）`
                  : ossStatusLabels[data.oss.status]}
              </Badge>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={data.oss.message}>
              {data.oss.message}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              最近检查: {new Date(data.oss.checked_at * 1000).toLocaleTimeString("zh-CN")}
            </p>
          </CardContent>
        </Card>

        <Card className="flex min-h-[148px] flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">运行时长</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-3">
            <div className="text-2xl font-bold">{formatUptime(data.uptime_seconds)}</div>
            <p className="text-xs text-muted-foreground">
              启动时间: {new Date(data.start_time).toLocaleString('zh-CN')}
            </p>
          </CardContent>
        </Card>

        <Card className="flex min-h-[148px] flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">后端服务</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-3">
            <div className="text-2xl font-bold">
              <Badge variant="default" className="text-sm">运行中</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              PID: {data.backend_pid} | 端口: {data.backend_port}
            </p>
          </CardContent>
        </Card>

        <Card className="flex min-h-[148px] flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">前端服务</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-3">
            <div className="text-2xl font-bold">
              {data.frontend_pid ? (
                <Badge variant="default" className="text-sm">运行中</Badge>
              ) : data.frontend_mode === "dev" ? (
                <Badge variant="secondary" className="text-sm">未运行</Badge>
              ) : (
                <Badge variant="secondary" className="text-sm">静态托管</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {data.frontend_pid
                ? `PID: ${data.frontend_pid} | 端口: ${data.frontend_port}`
                : data.frontend_mode === "dev"
                  ? `开发模式下未检测到 Vite 监听进程（端口 ${data.frontend_port}）`
                  : "前端由后端静态托管（经后端端口访问）"}
            </p>
          </CardContent>
        </Card>

        <Card className="flex min-h-[148px] flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Windows 子进程运行</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-3">
            <div className="text-2xl font-bold">
              <Badge
                variant={data.windows_renderer.process.status === "running" ? "default" : data.windows_renderer.process.status === "disconnected" ? "destructive" : "secondary"}
                className="text-sm"
              >
                {rendererProcessLabels[data.windows_renderer.process.status]}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {data.windows_renderer.process.status === "running" && data.windows_renderer.process.task_id
                ? `Worker: ${data.windows_renderer.process.worker_id ?? "未知"} · 任务: ${data.windows_renderer.process.task_id.slice(0, 8)}`
                : data.windows_renderer.process.active_task_count > 0
                  ? `有效租约任务 ${data.windows_renderer.process.active_task_count} 个，Worker 暂无心跳`
                  : `在线 Worker: ${data.windows_renderer.process.worker_count} 个`}
            </p>
          </CardContent>
        </Card>

        <Card className="flex min-h-[148px] flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Windows 子进程连接</CardTitle>
            <Wifi className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-3">
            <div className="text-2xl font-bold">
              <Badge
                variant={data.windows_renderer.connection.status === "connected" ? "default" : "secondary"}
                className="text-sm"
              >
                {rendererConnectionLabels[data.windows_renderer.connection.status]}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {data.windows_renderer.connection.worker_id
                ? `Worker: ${data.windows_renderer.connection.worker_id} · ${data.windows_renderer.connection.age_seconds ?? 0} 秒前心跳`
                : "尚未收到 Windows Worker 心跳"}
            </p>
          </CardContent>
        </Card>

        <Card className="flex min-h-[148px] flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">配置文件</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-3">
            <div className="text-sm font-bold truncate" title={data.config_file}>
              {data.config_file}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              日志目录: {data.log_dir}
            </p>
          </CardContent>
        </Card>

        <Card className="flex min-h-[148px] flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">开机自启</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-3">
            <div className="text-2xl font-bold">
              {data.mode === "systemd" ? (
                <Badge
                  variant={data.service_enabled === "enabled" || data.service_enabled === "enabled-runtime"
                    ? "default"
                    : data.service_enabled.startsWith("masked") ? "destructive" : "secondary"}
                  className="text-sm"
                >
                  {serviceEnabledLabel[data.service_enabled]}
                </Badge>
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

    </div>
  );
}

// ==================== 日志管理 ====================

interface LogFileInfo {
  filename: string;
  size_bytes: number;
  modified: string;
  version: string;
}

interface LogTailResponse {
  filename: string;
  lines: string[];
  line_count: number;
  requested_lines: number;
  truncated: boolean;
  size_bytes: number;
  modified: string;
  version: string;
}

type LogLevelFilter = "all" | "error" | "warn" | "info" | "debug";

const LOG_REFRESH_INTERVAL = 3_000;
const LOG_LINE_LIMITS = [200, 500, 1000, 2000, 5000] as const;

function getLogLevel(line: string): Exclude<LogLevelFilter, "all"> | null {
  if (/\b(ERROR|FATAL|CRITICAL)\b/i.test(line)) return "error";
  if (/\bWARN(?:ING)?\b/i.test(line)) return "warn";
  if (/\bINFO\b/i.test(line)) return "info";
  if (/\b(DEBUG|TRACE)\b/i.test(line)) return "debug";
  return null;
}

function getLogLineClass(line: string): string {
  const level = getLogLevel(line);
  if (level === "error") return "text-red-300";
  if (level === "warn") return "text-amber-300";
  if (level === "info") return "text-sky-200";
  if (level === "debug") return "text-slate-400";
  return "text-slate-200";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LogTab() {
  const [selectedFilename, setSelectedFilename] = React.useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [followTail, setFollowTail] = React.useState(true);
  const [lineLimit, setLineLimit] = React.useState(500);
  const [search, setSearch] = React.useState("");
  const [levelFilter, setLevelFilter] = React.useState<LogLevelFilter>("all");
  const [downloadingFilename, setDownloadingFilename] = React.useState<string | null>(null);
  const viewerRef = React.useRef<HTMLDivElement>(null);
  const requestedFileVersionRef = React.useRef<{ filename: string; version: string } | null>(null);
  const deferredSearch = React.useDeferredValue(search.trim().toLocaleLowerCase());

  const logsQuery = useQuery({
    queryKey: ["system", "logs"],
    queryFn: async ({ signal }) => api<LogFileInfo[]>("/api/admin/system/logs", { signal }),
    refetchInterval: autoRefresh ? LOG_REFRESH_INTERVAL : false,
  });

  React.useEffect(() => {
    const files = logsQuery.data ?? [];
    if (!files.length) {
      setSelectedFilename(null);
      return;
    }
    if (!selectedFilename || !files.some((file) => file.filename === selectedFilename)) {
      setSelectedFilename(files[0].filename);
      setFollowTail(true);
    }
  }, [logsQuery.data, selectedFilename]);

  const files = logsQuery.data ?? [];
  const selectedFile = files.find((file) => file.filename === selectedFilename);

  const tailQuery = useQuery({
    queryKey: ["system", "logs", selectedFilename, "tail", lineLimit],
    queryFn: async ({ signal }) => api<LogTailResponse>(
      `/api/admin/system/logs/${encodeURIComponent(selectedFilename!)}/tail`,
      { params: { lines: lineLimit }, signal },
    ),
    enabled: Boolean(selectedFilename),
    refetchInterval: (query) => autoRefresh && query.state.status === "error"
      ? LOG_REFRESH_INTERVAL
      : false,
  });

  React.useEffect(() => {
    if (!selectedFilename || !selectedFile?.version) return;
    const previous = requestedFileVersionRef.current;
    requestedFileVersionRef.current = {
      filename: selectedFilename,
      version: selectedFile.version,
    };
    if (!previous || previous.filename !== selectedFilename) return;
    if (previous.version !== selectedFile.version) {
      void tailQuery.refetch();
    }
  }, [selectedFilename, selectedFile?.version, tailQuery.refetch]);

  const visibleLines = React.useMemo(() => {
    return (tailQuery.data?.lines ?? [])
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => {
        if (levelFilter !== "all" && getLogLevel(line) !== levelFilter) return false;
        return !deferredSearch || line.toLocaleLowerCase().includes(deferredSearch);
      });
  }, [tailQuery.data?.lines, deferredSearch, levelFilter]);

  React.useEffect(() => {
    if (!followTail || !viewerRef.current) return;
    viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
  }, [followTail, selectedFilename, lineLimit, deferredSearch, levelFilter, tailQuery.data?.modified, visibleLines.length]);

  const handleSelectFile = (filename: string) => {
    setSelectedFilename(filename);
    setFollowTail(true);
  };

  const handleDownload = async (filename: string) => {
    setDownloadingFilename(filename);
    try {
      await downloadFile(
        `/api/admin/system/logs/${encodeURIComponent(filename)}?download=true`,
        filename,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        toast.error("日志文件不存在，可能已被轮转或清理");
      } else if (error instanceof ApiError && error.status === 403) {
        toast.error("没有下载该日志的权限");
      } else {
        toast.error(error instanceof Error ? error.message : "日志下载失败");
      }
    } finally {
      setDownloadingFilename(null);
    }
  };

  const handleRefresh = () => {
    void Promise.all([logsQuery.refetch(), selectedFilename ? tailQuery.refetch() : Promise.resolve()]);
  };

  const handleToggleAutoRefresh = () => {
    const next = !autoRefresh;
    setAutoRefresh(next);
    if (next) handleRefresh();
  };

  const handleJumpToLatest = () => {
    setFollowTail(true);
    requestAnimationFrame(() => {
      if (!viewerRef.current) return;
      viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
    });
  };

  if (logsQuery.isLoading && !logsQuery.data) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载日志列表…
      </div>
    );
  }

  if (logsQuery.isError && !logsQuery.data) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <XCircle className="h-8 w-8 text-destructive" />
        <p>日志列表加载失败：{logsQuery.error.message}</p>
        <Button variant="outline" size="sm" onClick={() => logsQuery.refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />重试
        </Button>
      </div>
    );
  }

  const isRefreshing = logsQuery.isFetching || tailQuery.isFetching;
  const refreshError = logsQuery.isError
    ? `日志列表刷新失败：${logsQuery.error.message}`
    : tailQuery.isError
      ? `日志内容刷新失败：${tailQuery.error.message}`
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <div className="flex items-center gap-2">
            <Switch
              id="log-follow-tail"
              checked={followTail}
              onCheckedChange={setFollowTail}
            />
            <label htmlFor="log-follow-tail" className="cursor-pointer font-medium">
              跟随最新
            </label>
          </div>
          <span className={cn("flex items-center gap-1.5 text-xs", refreshError ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
            <span className={cn("h-2 w-2 rounded-full", refreshError ? "bg-red-500" : autoRefresh ? "bg-emerald-500" : "bg-slate-400")} />
            {refreshError ?? (autoRefresh ? "每 3 秒自动刷新" : "自动刷新已暂停")}
            {isRefreshing && <Loader2 className="h-3 w-3 animate-spin" />}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleToggleAutoRefresh}>
            {autoRefresh ? <Pause className="mr-1.5 h-4 w-4" /> : <Play className="mr-1.5 h-4 w-4" />}
            {autoRefresh ? "暂停" : "继续"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={cn("mr-1.5 h-4 w-4", isRefreshing && "animate-spin")} />
            刷新
          </Button>
        </div>
      </div>

      <div className="grid min-h-[620px] gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="border-b pb-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">日志文件</CardTitle>
                <CardDescription className="mt-1">按修改时间排序</CardDescription>
              </div>
              <Badge variant="secondary">{files.length}</Badge>
            </div>
          </CardHeader>
          <CardContent className="max-h-[710px] overflow-y-auto p-2">
            {files.map((log) => (
              <button
                type="button"
                key={log.filename}
                onClick={() => handleSelectFile(log.filename)}
                aria-pressed={selectedFilename === log.filename}
                className={cn(
                  "mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors last:mb-0 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  selectedFilename === log.filename && "bg-primary/10 text-primary hover:bg-primary/10",
                )}
              >
                <span className="block truncate text-sm font-medium" title={log.filename}>{log.filename}</span>
                <span className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>{formatFileSize(log.size_bytes)}</span>
                  <span>{new Date(log.modified).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                </span>
              </button>
            ))}
            {files.length === 0 && (
              <div className="px-3 py-12 text-center text-sm text-muted-foreground">暂无日志文件</div>
            )}
          </CardContent>
        </Card>

        <Card className="flex min-w-0 flex-col overflow-hidden">
          <CardHeader className="border-b pb-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="truncate text-base" title={selectedFilename ?? undefined}>
                  {selectedFilename ?? "日志查看器"}
                </CardTitle>
                <CardDescription className="mt-1">
                  {selectedFile
                    ? `${formatFileSize(tailQuery.data?.size_bytes ?? selectedFile.size_bytes)} · 更新于 ${new Date(tailQuery.data?.modified ?? selectedFile.modified).toLocaleString("zh-CN")}`
                    : "选择左侧日志文件后可直接查看"}
                </CardDescription>
              </div>
              {selectedFilename && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleDownload(selectedFilename)}
                  disabled={downloadingFilename === selectedFilename}
                >
                  {downloadingFilename === selectedFilename ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-1.5 h-4 w-4" />
                  )}
                  下载完整日志
                </Button>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <div className="relative min-w-[220px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="pl-8"
                  placeholder="搜索当前加载的日志"
                  aria-label="搜索日志"
                />
              </div>
              <Select value={levelFilter} onValueChange={(value) => setLevelFilter(value as LogLevelFilter)}>
                <SelectTrigger className="w-[130px]" aria-label="日志级别">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部级别</SelectItem>
                  <SelectItem value="error">错误</SelectItem>
                  <SelectItem value="warn">警告</SelectItem>
                  <SelectItem value="info">信息</SelectItem>
                  <SelectItem value="debug">调试</SelectItem>
                </SelectContent>
              </Select>
              <Select value={String(lineLimit)} onValueChange={(value) => setLineLimit(Number(value))}>
                <SelectTrigger className="w-[140px]" aria-label="加载行数">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOG_LINE_LIMITS.map((limit) => (
                    <SelectItem key={limit} value={String(limit)}>最新 {limit} 行</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>

          <CardContent className="flex min-h-0 flex-1 flex-col p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
              <span>
                显示 {visibleLines.length} / {tailQuery.data?.line_count ?? 0} 行
                {tailQuery.data?.truncated ? " · 内容已安全截断" : ""}
              </span>
              <button
                type="button"
                onClick={handleJumpToLatest}
                className="inline-flex items-center gap-1 rounded-sm text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowDownToLine className="h-3.5 w-3.5" />跳到最新
              </button>
            </div>

            <div
              ref={viewerRef}
              role="region"
              aria-label={selectedFilename ? `${selectedFilename} 日志内容` : "日志内容"}
              tabIndex={0}
              onScroll={(event) => {
                const target = event.currentTarget;
                const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
                if (followTail && distanceToBottom > 80) setFollowTail(false);
              }}
              className="relative h-[560px] overflow-auto bg-slate-950 font-mono text-[12px] leading-5"
            >
              {tailQuery.isLoading && (
                <div className="absolute inset-0 flex items-center justify-center text-slate-400">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />加载日志内容…
                </div>
              )}
              {tailQuery.isError && !tailQuery.data && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-slate-400">
                  <XCircle className="h-7 w-7 text-red-400" />
                  <p>日志内容加载失败：{tailQuery.error.message}</p>
                  <Button variant="secondary" size="sm" onClick={() => tailQuery.refetch()}>重试</Button>
                </div>
              )}
              {!tailQuery.isLoading && !tailQuery.isError && !selectedFilename && (
                <div className="absolute inset-0 flex items-center justify-center text-slate-500">暂无可查看的日志文件</div>
              )}
              {!tailQuery.isLoading && !tailQuery.isError && selectedFilename && visibleLines.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-slate-500">
                  {tailQuery.data?.line_count ? "没有匹配当前筛选条件的日志" : "日志文件为空"}
                </div>
              )}
              {visibleLines.length > 0 && (
                <div className="min-w-max py-2">
                  {visibleLines.map(({ line, lineNumber }) => (
                    <div key={lineNumber} className="group flex min-h-5 hover:bg-white/5">
                      <span className="sticky left-0 w-14 shrink-0 select-none border-r border-slate-800 bg-slate-950 pr-3 text-right text-slate-600 group-hover:bg-slate-900">
                        {lineNumber}
                      </span>
                      <span className={cn("whitespace-pre px-3", getLogLineClass(line))}>{line || " "}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ==================== 主页面 ====================

type SystemSection = "runtime" | "config" | "logs";

export function AdminSystemPage({ section = "runtime" }: { section?: SystemSection }) {
  if (section === "config") {
    return <AdminConfigPage />;
  }

  const title = section === "logs" ? "日志管理" : "运行管理";
  const description = section === "logs"
    ? "查看和筛选服务日志，定位运行异常与系统问题。"
    : "查看服务、存储和 Windows 渲染子进程状态，并执行系统维护操作。";

  return (
    <div className="page-shell">
      <PageHeader title={title} description={description} />
      {section === "logs" ? <LogTab /> : <RuntimeTab />}
    </div>
  );
}

export default AdminSystemPage;
