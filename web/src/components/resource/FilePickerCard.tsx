import * as React from "react";

import { cn } from "@/lib/utils";

export interface FilePickerCardProps {
  id: string;
  /** 卡片顶部的标签文字（例如 "PPT 文件"） */
  label: string;
  /** 原生 accept 值 */
  accept: string;
  /** 已选文件 */
  file: File | null;
  /** 可选的左侧小图标 */
  icon?: React.ReactNode;
  /** 空状态下的占位提示，默认"点击选择文件" */
  placeholder?: string;
  /** 是否必填（传给底层 input，利于表单原生校验） */
  required?: boolean;
  onChange: (file: File | null) => void;
  className?: string;
}

/**
 * 虚线边框的文件选择卡片：点击卡片任意位置弹出文件选择框，
 * 已选时显示文件名，未选时显示占位提示。两个对话框共用。
 */
export function FilePickerCard({
  id,
  label,
  accept,
  file,
  icon,
  placeholder = "点击选择文件",
  required,
  onChange,
  className,
}: FilePickerCardProps) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-md border border-dashed bg-background px-3 py-2.5 text-sm transition hover:border-primary hover:bg-primary/5",
        className,
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </span>
      <span
        className={
          file ? "truncate font-medium text-foreground" : "text-xs text-muted-foreground"
        }
      >
        {file ? file.name : placeholder}
      </span>
      <input
        id={id}
        type="file"
        accept={accept}
        required={required}
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
    </label>
  );
}
