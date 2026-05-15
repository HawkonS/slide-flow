import * as React from "react";
import { Bold, Italic, List, ListOrdered, Underline, RemoveFormatting } from "lucide-react";

import { cn } from "@/lib/utils";

export interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  /** 编辑区域最小高度（px），默认 120 */
  minHeight?: number;
  /** 编辑区域最大高度（px），超过时内部滚动 */
  maxHeight?: number;
  /** 是否带自己的边框。宿主已经提供边框时传 false 避免 "框套框" */
  bordered?: boolean;
  disabled?: boolean;
}

/**
 * 极简富文本编辑器：基于 contentEditable + execCommand。
 * 支持 加粗 / 斜体 / 下划线 / 有序列表 / 无序列表 / 清除格式。
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  className,
  minHeight = 120,
  maxHeight,
  bordered = true,
  disabled,
}: RichTextEditorProps) {
  const editorRef = React.useRef<HTMLDivElement | null>(null);
  const lastEmittedRef = React.useRef<string>(value || "");

  // 受控：外部 value 变化且与当前内容不一致时同步，避免覆盖用户正在输入
  React.useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const next = value || "";
    if (next !== lastEmittedRef.current) {
      el.innerHTML = next;
      lastEmittedRef.current = next;
    }
  }, [value]);

  const exec = (command: string, arg?: string) => {
    if (disabled) return;
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    // 关闭 linebreak 以防止每次 execCommand 插入 <br>
    try {
      document.execCommand("styleWithCSS", false, "false");
    } catch {
      /* ignore */
    }
    document.execCommand(command, false, arg);
    const html = el.innerHTML;
    lastEmittedRef.current = html;
    onChange(html);
  };

  const handleInput = () => {
    const el = editorRef.current;
    if (!el) return;
    const html = el.innerHTML;
    lastEmittedRef.current = html;
    onChange(html);
  };

  // 处理粘贴：把 HTML 降格为纯文本，避免粘贴进奇怪样式
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  };

  const isEmpty = !value || value === "<br>" || value === "<p><br></p>";

  return (
    <div
      className={cn(
        "flex flex-col bg-background text-sm transition",
        bordered && "rounded-md border shadow-sm focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/20",
        disabled && "opacity-60",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-0.5 border-b px-1.5 py-1">
        <ToolButton label="加粗 (Ctrl+B)" onClick={() => exec("bold")}>
          <Bold className="h-3.5 w-3.5" />
        </ToolButton>
        <ToolButton label="斜体 (Ctrl+I)" onClick={() => exec("italic")}>
          <Italic className="h-3.5 w-3.5" />
        </ToolButton>
        <ToolButton label="下划线 (Ctrl+U)" onClick={() => exec("underline")}>
          <Underline className="h-3.5 w-3.5" />
        </ToolButton>
        <div className="mx-1 h-4 w-px bg-border" />
        <ToolButton label="无序列表" onClick={() => exec("insertUnorderedList")}>
          <List className="h-3.5 w-3.5" />
        </ToolButton>
        <ToolButton label="有序列表" onClick={() => exec("insertOrderedList")}>
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolButton>
        <div className="mx-1 h-4 w-px bg-border" />
        <ToolButton label="清除格式" onClick={() => exec("removeFormat")}>
          <RemoveFormatting className="h-3.5 w-3.5" />
        </ToolButton>
      </div>

      <div className="relative flex-1 overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
        <div
          ref={editorRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={handleInput}
          onBlur={handleInput}
          onPaste={handlePaste}
          className={cn(
            "prose prose-sm max-w-none px-3 py-2 outline-none",
            "[&_ul]:ml-5 [&_ul]:list-disc [&_ol]:ml-5 [&_ol]:list-decimal",
            "[&_p]:my-1",
          )}
          style={{ minHeight }}
        />
        {isEmpty && placeholder && (
          <div
            className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground"
            aria-hidden
          >
            {placeholder}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      // mousedown preventDefault 防止失去编辑区焦点
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground",
        "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** 把 HTML 转纯文本用于空值判定等 */
export function richTextToPlain(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html || "";
  return (tmp.textContent || "").trim();
}
