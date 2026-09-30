import * as React from "react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
}

/** 用户操作确认弹窗，统一危险操作的语气、按钮和键盘行为。 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  destructive = false,
  loading = false,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!open || loading) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onOpenChange(false);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [open, loading, onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
      <DialogContent className="max-w-md" hideClose={loading} onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus(); }} onEscapeKeyDown={() => { if (!loading) onOpenChange(false); }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelRef} type="button" variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button type="button" variant={destructive ? "destructive" : "default"} disabled={loading} onClick={onConfirm}>
            {loading ? "处理中…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  label?: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  confirmLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
}

/** 需要用户输入名称等内容时使用，替代浏览器原生 prompt。 */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label = "名称",
  value,
  onValueChange,
  placeholder,
  confirmLabel = "继续",
  loading = false,
  onConfirm,
}: PromptDialogProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
      <DialogContent className="max-w-md" hideClose={loading} onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <label className="grid gap-1.5 text-sm font-medium">
          {label}
          <Input
            ref={inputRef}
            maxLength={200}
            disabled={loading}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder={placeholder}
            className="h-9 rounded-md border bg-background px-3 text-sm font-normal outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && value.trim() && !loading) onConfirm();
            }}
          />
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={loading || !value.trim()} onClick={onConfirm}>
            {loading ? "处理中…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
