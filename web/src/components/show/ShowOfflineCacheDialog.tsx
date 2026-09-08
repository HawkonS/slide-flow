import * as React from "react";
import { CheckCircle2, HardDriveDownload } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import {
  cacheShowToDirectory,
  ensurePermission,
  getDirectoryHandle,
  isFileSystemAccessSupported,
  OfflinePackageData,
} from "@/lib/offline-cache";
import { Show } from "@/lib/types";

interface ShowOfflineCacheDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  show: Show | null;
}

type CacheStage =
  | "checking"
  | "unsupported"
  | "no-folder"
  | "requesting-permission"
  | "permission-denied"
  | "options"
  | "caching"
  | "done";

export default function ShowOfflineCacheDialog({
  open,
  onOpenChange,
  show,
}: ShowOfflineCacheDialogProps) {
  const [stage, setStage] = React.useState<CacheStage>("checking");
  const [authMode, setAuthMode] = React.useState<"required" | "none">("none");
  const [dirHandle, setDirHandle] =
    React.useState<FileSystemDirectoryHandle | null>(null);
  const [dirName, setDirName] = React.useState("");
  const [progress, setProgress] = React.useState({ current: 0, total: 0 });

  // 每次打开时初始化
  React.useEffect(() => {
    if (!open) return;
    setStage("checking");
    setAuthMode("none");
    setProgress({ current: 0, total: 0 });

    if (!isFileSystemAccessSupported()) {
      setStage("unsupported");
      return;
    }

    getDirectoryHandle().then((handle) => {
      if (!handle) {
        setStage("no-folder");
        return;
      }
      setDirHandle(handle);
      setDirName(handle.name);
      setStage("requesting-permission");
      ensurePermission(handle).then((granted) => {
        if (granted) {
          setStage("options");
        } else {
          setStage("permission-denied");
        }
      });
    });
  }, [open]);

  const retryPermission = async () => {
    if (!dirHandle) return;
    const granted = await ensurePermission(dirHandle);
    if (granted) {
      setStage("options");
    } else {
      toast.error("权限被拒绝，请重试");
    }
  };

  const startCache = async () => {
    if (!show || !dirHandle) return;
    setStage("caching");
    try {
      const data = await api<OfflinePackageData>(
        `/api/shows/${show.id}/offline-package?auth_mode=${authMode}`
      );
      const serverUrl = window.location.origin;
      setProgress({ current: 0, total: data.resources.length });
      await cacheShowToDirectory(dirHandle, data, serverUrl, (current, total) => {
        setProgress({ current: Math.min(current, data.resources.length), total: data.resources.length });
      });
      setStage("done");
    } catch (err) {
      toast.error((err as Error).message || "缓存失败");
      setStage("options");
    }
  };

  if (!show) return null;

  const resourceCount = show.resources.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDriveDownload className="h-5 w-5" />
            离线缓存
          </DialogTitle>
          <DialogDescription className="sr-only">
            将放映资源缓存到本地文件夹
          </DialogDescription>
        </DialogHeader>

        {/* 不支持 File System Access API */}
        {stage === "unsupported" && (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              当前浏览器不支持 File System Access API，无法使用离线缓存功能。
            </p>
            <p className="text-sm text-muted-foreground">
              请使用 Chrome / Edge 等现代浏览器。
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* 检查中 */}
        {stage === "checking" && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            正在检查缓存配置...
          </div>
        )}

        {/* 未配置文件夹 */}
        {stage === "no-folder" && (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              请先在{" "}
              <Link
                to="/manage/offline-cache"
                className="text-primary underline underline-offset-4 hover:text-primary/80"
                onClick={() => onOpenChange(false)}
              >
                离线缓存页面
              </Link>{" "}
              中配置缓存文件夹。
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* 请求权限中 */}
        {stage === "requesting-permission" && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            正在请求文件夹访问权限...
          </div>
        )}

        {/* 权限被拒绝 */}
        {stage === "permission-denied" && (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              文件夹访问权限被拒绝。需要读写权限才能进行离线缓存。
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={retryPermission}>重新授权</Button>
            </DialogFooter>
          </div>
        )}

        {/* 选项配置 */}
        {stage === "options" && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <div className="text-sm font-medium">身份校验模式:</div>
              <div className="space-y-2">
                <label className="flex cursor-pointer items-center gap-2 rounded-md border p-3 transition-colors hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                  <input
                    type="radio"
                    name="auth_mode"
                    value="required"
                    checked={authMode === "required"}
                    onChange={() => setAuthMode("required")}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="text-sm">进行身份校验</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded-md border p-3 transition-colors hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                  <input
                    type="radio"
                    name="auth_mode"
                    value="none"
                    checked={authMode === "none"}
                    onChange={() => setAuthMode("none")}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="text-sm">无需身份校验</span>
                </label>
              </div>
            </div>

            <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
              将缓存 <span className="font-medium text-foreground">{resourceCount}</span> 个幻灯片到文件夹{" "}
              <span className="font-medium text-foreground">"{dirName}"</span>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={startCache} disabled={resourceCount === 0}>
                开始缓存
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* 缓存进度 */}
        {stage === "caching" && (
          <div className="space-y-4 py-4">
            <p className="text-center text-sm font-medium">正在缓存...</p>
            <div className="space-y-2">
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{
                    width: progress.total > 0
                      ? `${(progress.current / progress.total) * 100}%`
                      : "0%",
                  }}
                />
              </div>
              <p className="text-center text-sm text-muted-foreground">
                {progress.current}/{progress.total}
              </p>
            </div>
          </div>
        )}

        {/* 完成 */}
        {stage === "done" && (
          <div className="space-y-4 py-4">
            <div className="flex flex-col items-center gap-2">
              <CheckCircle2 className="h-10 w-10 text-green-500" />
              <p className="text-sm font-medium">缓存完成！</p>
              <p className="text-sm text-muted-foreground">
                已成功缓存 {resourceCount} 个幻灯片
              </p>
            </div>
            <DialogFooter className="sm:justify-center">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
