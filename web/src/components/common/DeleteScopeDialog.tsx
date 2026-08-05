import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** 删除范围：仅最新版本 / 全部版本 */
export type DeleteScope = "latest" | "all";

interface DeleteScopeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 实体类型名，如「放映」「资源」 */
  entityLabel: string;
  /** 实体名称 */
  name: string;
  /** 版本总数（>1 时才应打开本弹窗） */
  versionCount: number;
  /** 最新版本号，用于按钮上显示 vN（可选） */
  latestVersionNo?: number;
  /** 删除请求进行中 */
  loading?: boolean;
  onDelete: (scope: DeleteScope) => void;
}

/**
 * 多版本实体删除确认弹窗：让用户选择「仅删除最新版本」还是「删除全部版本」。
 */
export function DeleteScopeDialog({
  open,
  onOpenChange,
  entityLabel,
  name,
  versionCount,
  latestVersionNo,
  loading = false,
  onDelete,
}: DeleteScopeDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!loading) onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>删除{entityLabel}</DialogTitle>
          <DialogDescription>
            「{name}」共有 {versionCount}{" "}
            个版本，请选择删除范围。此操作不可恢复。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
          <Button
            type="button"
            variant="outline"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={loading}
            onClick={() => onDelete("latest")}
          >
            仅删除最新版本{latestVersionNo ? `（v${latestVersionNo}）` : ""}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={loading}
            onClick={() => onDelete("all")}
          >
            {loading ? "删除中…" : `删除全部版本（${versionCount} 个）`}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={loading}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
