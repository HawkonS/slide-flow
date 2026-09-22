import * as React from "react";
import { FolderUp, Loader2, Server, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type FontUploadDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
};

export function FontUploadDialog({ open, onOpenChange, onSuccess }: FontUploadDialogProps) {
  type Mode = "file" | "folder";
  const FONT_EXT = /\.(ttf|otf|ttc|otc)$/i;

  const [mode, setMode] = React.useState<Mode>("file");
  const [files, setFiles] = React.useState<File[]>([]);
  const [displayName, setDisplayName] = React.useState("");
  const [installOnServer, setInstallOnServer] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });

  React.useEffect(() => {
    if (!open) {
      setMode("file");
      setFiles([]);
      setDisplayName("");
      setInstallOnServer(false);
      setLoading(false);
      setProgress({ done: 0, total: 0 });
    }
  }, [open]);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setFiles([]);
    setProgress({ done: 0, total: 0 });
  };

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []).filter((file) => FONT_EXT.test(file.name));
    setFiles(mode === "file" ? selected.slice(0, 1) : selected);
    event.target.value = "";
  };

  const submit = async () => {
    if (files.length === 0) {
      toast.error(mode === "folder" ? "所选文件夹未发现字体文件" : "请选择字体文件");
      return;
    }

    setLoading(true);
    const failed: string[] = [];
    setProgress({ done: 0, total: files.length });

    for (const file of files) {
      const body = new FormData();
      body.append("font_file", file);
      if (mode === "file" && displayName.trim()) body.append("display_name", displayName.trim());
      body.append("install_on_server", String(installOnServer));

      try {
        const response = await fetch("/api/fonts/upload", {
          method: "POST",
          credentials: "include",
          body,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data?.detail || "上传失败");
        }
      } catch (error) {
        failed.push(`${file.name}（${(error as Error).message || "失败"}）`);
      }
      setProgress((current) => ({ ...current, done: current.done + 1 }));
    }

    setLoading(false);
    const successCount = files.length - failed.length;
    if (successCount > 0) {
      toast.success(`已上传 ${successCount} 个字体${failed.length ? `，${failed.length} 个失败` : ""}`);
    }
    if (failed.length > 0) {
      toast.error(`失败：${failed.slice(0, 3).join("；")}${failed.length > 3 ? " …" : ""}`);
    }

    onSuccess();
    if (failed.length === 0) onOpenChange(false);
    else setFiles([]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>上传字体</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-xs">
            {([
              { value: "file", label: "单个文件", icon: <Upload className="h-3.5 w-3.5" /> },
              { value: "folder", label: "整个文件夹", icon: <FolderUp className="h-3.5 w-3.5" /> },
            ] as const).map((item) => {
              const active = item.value === mode;
              return (
                <button
                  key={item.value}
                  type="button"
                  disabled={loading}
                  onClick={() => switchMode(item.value)}
                  className={cn(
                    "flex h-8 items-center justify-center gap-1.5 rounded-[0.35rem] text-sm transition",
                    active ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    loading && "cursor-not-allowed opacity-60",
                  )}
                >
                  {item.icon}
                  {item.label}
                </button>
              );
            })}
          </div>

          {mode === "file" && (
            <div className="grid gap-2">
              <Label htmlFor="font-display-name">字体展示名（可选）</Label>
              <Input
                id="font-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="例如：思源黑体 Bold"
                maxLength={100}
                disabled={loading}
              />
              <p className="text-xs text-muted-foreground">留空时自动使用字体文件内置名称。</p>
            </div>
          )}

          <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2.5">
            <div className="space-y-1">
              <Label htmlFor="font-install-server" className="flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5 text-primary" />安装到服务器
              </Label>
              <p className="text-xs text-muted-foreground">安装到当前服务账号的字体目录，并刷新字体缓存（如系统支持）。</p>
            </div>
            <Switch
              id="font-install-server"
              checked={installOnServer}
              onCheckedChange={setInstallOnServer}
              disabled={loading}
              aria-label="安装到服务器"
            />
          </div>

          <label
            htmlFor={mode === "folder" ? "font-folder-input" : "font-file-input"}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center transition",
              "hover:border-primary hover:bg-primary/5",
              loading && "pointer-events-none opacity-60",
            )}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              {mode === "folder" ? <FolderUp className="h-5 w-5" /> : <Upload className="h-5 w-5" />}
            </span>
            <span className="text-sm font-medium">{mode === "folder" ? "点击选择文件夹" : "点击选择字体文件"}</span>
            <span className="text-xs text-muted-foreground">
              支持 TTF / OTF / TTC / OTC{mode === "folder" ? "，将自动过滤并批量上传" : ""}
            </span>
            <input id="font-file-input" type="file" accept=".ttf,.otf,.ttc,.otc" className="hidden" onChange={onPick} />
            <input
              id="font-folder-input"
              type="file"
              multiple
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              className="hidden"
              onChange={onPick}
            />
          </label>

          {files.length > 0 && (
            <div className="rounded-md border bg-background">
              <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
                <span>已选 <span className="font-medium text-foreground">{files.length}</span> 个字体</span>
                {!loading && (
                  <button type="button" className="text-primary hover:underline" onClick={() => setFiles([])}>
                    清空
                  </button>
                )}
              </div>
              <ul className="max-h-40 overflow-auto px-3 py-1.5 text-xs">
                {files.map((file, index) => (
                  <li key={`${file.name}-${index}`} className="truncate py-0.5" title={file.name}>{file.name}</li>
                ))}
              </ul>
            </div>
          )}

          {loading && progress.total > 0 && (
            <div className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
              </div>
              <div className="text-right text-xs text-muted-foreground">{progress.done} / {progress.total}</div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>取消</Button>
          <Button onClick={submit} disabled={loading || files.length === 0}>
            {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {loading ? "上传中…" : `上传${files.length > 1 ? ` ${files.length} 个` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
