import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ArrowDownUp, GripVertical, Loader2, Plus, Save, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LinkEditDialog } from "@/components/link/LinkEditDialog";
import {
  api,
  fetchLinks,
  deleteLink,
  fetchAdminDefaultLinks,
  updateAdminDefaultLinks,
  updateLinksOrder,
} from "@/lib/api";
import { DEFAULT_SORT_KEY, type SortKey } from "@/lib/constants";
import { sortListItems } from "@/lib/sort";
import { NETWORK_ENV_LABELS, Link, NetworkEnv } from "@/lib/types";
import { cn } from "@/lib/utils";

interface LinkListResponse {
  links: Link[];
}

interface LinkSelectionResponse {
  link_ids: number[];
}

const NETWORK_ENV_BADGE: Record<string, string> = {
  company_intranet: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  private_cloud: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  public_net: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

function NetworkEnvBadge({ env }: { env?: NetworkEnv }) {
  if (!env) {
    return <span className="text-xs text-muted-foreground">-</span>;
  }
  const label = NETWORK_ENV_LABELS[env] ?? env;
  const cls = NETWORK_ENV_BADGE[env] ?? "bg-muted text-muted-foreground";
  return (
    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium", cls)}>
      {label}
    </span>
  );
}

/** 排序 chip：上方两个方向胶囊（顺序/倒序），下方字段单选（修改时间/创建时间/链接名称） */
const SORT_FIELD_OPTIONS = [
  { v: "updated", label: "修改时间" },
  { v: "created", label: "创建时间" },
  { v: "name", label: "链接名称" },
] as const;

type SortField = (typeof SORT_FIELD_OPTIONS)[number]["v"];
type SortDir = "asc" | "desc";

function splitSortKey(key: SortKey): { field: SortField; direction: SortDir } {
  const idx = key.lastIndexOf("_");
  return {
    field: key.slice(0, idx) as SortField,
    direction: key.slice(idx + 1) as SortDir,
  };
}

function joinSortKey(field: SortField, direction: SortDir): SortKey {
  return `${field}_${direction}` as SortKey;
}

function SortFilterChip({
  value,
  onChange,
  baseValue,
}: {
  value: SortKey;
  onChange: (v: SortKey) => void;
  baseValue: SortKey;
}) {
  const dirty = value !== baseValue;
  const { field, direction } = splitSortKey(value);
  const fieldLabel = SORT_FIELD_OPTIONS.find((o) => o.v === field)?.label ?? "修改时间";
  const dirLabel = direction === "asc" ? "顺序" : "倒序";
  const summary = `${fieldLabel} · ${dirLabel}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm transition",
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>排序</span>
          <span className="font-medium">{summary}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 opacity-60", dirty && "opacity-80")} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        <div className="mb-1 border-b px-1 pb-2 pt-1">
          <div className="mb-1 text-xs text-muted-foreground">排序方向</div>
          <div className="grid grid-cols-2 gap-1">
            {(
              [
                { v: "asc", label: "顺序" },
                { v: "desc", label: "倒序" },
              ] as const
            ).map((it) => {
              const active = it.v === direction;
              return (
                <button
                  key={it.v}
                  type="button"
                  onClick={() => onChange(joinSortKey(field, it.v))}
                  className={cn(
                    "h-7 rounded-md border text-xs transition",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "bg-background hover:border-primary/40 hover:bg-primary/5",
                  )}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="max-h-72 overflow-auto">
          {SORT_FIELD_OPTIONS.map((it) => {
            const active = it.v === field;
            return (
              <button
                key={it.v}
                type="button"
                onClick={() => onChange(joinSortKey(it.v, direction))}
                className={cn(
                  "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm transition hover:bg-accent",
                  active && "text-primary",
                )}
              >
                <span className="truncate">{it.label}</span>
                {active && <Check className="h-3.5 w-3.5" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function AdminLinksPage() {
  const qc = useQueryClient();
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>(DEFAULT_SORT_KEY);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editLink, setEditLink] = React.useState<Link | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const [defaultsOpen, setDefaultsOpen] = React.useState(false);
  const [sortOpen, setSortOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());

  const {
    data: linksData,
    isLoading,
    isError,
    error,
  } = useQuery<LinkListResponse>({
    queryKey: ["links"],
    queryFn: fetchLinks,
  });

  const links = linksData?.links ?? [];

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? links.filter((l) =>
          `${l.name} ${l.url} ${l.memo} ${l.owner?.name || ""} ${l.owner?.username || ""}`.toLowerCase().includes(q),
        )
      : links;
    return sortListItems(base, sort);
  }, [links, query, sort]);

  const filteredIds = React.useMemo(() => filtered.map((l) => l.id), [filtered]);

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleEdit = (link: Link) => {
    setEditLink(link);
    setEditOpen(true);
  };

  const delMut = useMutation({
    mutationFn: async (id: number) => deleteLink(id),
    onSuccess: () => {
      toast.success("链接已删除");
      qc.invalidateQueries({ queryKey: ["links"] });
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const bulkDelMut = useMutation({
    mutationFn: async (ids: number[]) =>
      api<{ deleted: number }>("/api/admin/links/bulk-delete", {
        method: "POST",
        json: { link_ids: ids },
      }),
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 个链接`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["links"] });
    },
    onError: (err: Error) => toast.error(err.message || "批量删除失败"),
  });

  const handleDelete = (link: Link) => {
    const ok = window.confirm(
      `确定要删除链接「${link.name}」吗？此操作不可恢复。`,
    );
    if (!ok) return;
    delMut.mutate(link.id);
  };

  // Pagination: dynamic page size based on content area height
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = React.useState(10);
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const compute = () => {
      const H = el.clientHeight;
      if (!H) return;
      const headerH = 45;
      const rowH = 57;
      const rows = Math.max(5, Math.floor((H - headerH) / rowH));
      setPageSize((prev) => (prev === rows ? prev : rows));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [page, setPage] = React.useState(1);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  React.useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);
  React.useEffect(() => {
    setPage(1);
  }, [query, sort]);
  const pageStart = (page - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);
  const pageItemIds = React.useMemo(() => pageItems.map((l) => l.id), [pageItems]);
  const allSelected = pageItemIds.length > 0 && pageItemIds.every((id) => selected.has(id));
  const someSelected = pageItemIds.some((id) => selected.has(id)) && !allSelected;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">链接管理</h1>
          <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
            {filtered.length === links.length
              ? `共 ${links.length} 条`
              : `筛选后 ${filtered.length} / ${links.length} 条`}
          </span>
        </div>
      </header>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索链接名称、URL、所有者"
            className={cn(
              "h-8 w-full sm:w-56 rounded-full border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              query.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
        <SortFilterChip value={sort} onChange={setSort} baseValue={DEFAULT_SORT_KEY} />
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <span className="text-xs text-muted-foreground">
              已选 <span className="font-medium text-primary">{selected.size}</span> 项
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            disabled={selected.size === 0 || bulkDelMut.isPending}
            onClick={() => {
              if (!window.confirm(`确认删除选中的 ${selected.size} 个链接？`)) return;
              bulkDelMut.mutate(Array.from(selected));
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            批量删除
          </Button>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-full px-3 text-sm"
          onClick={() => {
            if (links.length === 0) {
              toast.error("暂无链接可排序");
              return;
            }
            setSortOpen(true);
          }}
        >
          <ArrowDownUp className="h-3.5 w-3.5" />
          排序
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-full px-3 text-sm"
          onClick={() => setDefaultsOpen(true)}
        >
          <Save className="h-3.5 w-3.5" />
          配置演讲者默认链接
        </Button>
        <Button
          size="sm"
          className="h-8 gap-1.5 rounded-full px-3 text-sm"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          新建链接
        </Button>
      </div>

      {/* Content area */}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            加载失败：{(error as Error)?.message || "未知错误"}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            暂无链接
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <div className="flex items-center gap-0.5">
                      <Checkbox
                        checked={allSelected ? true : someSelected ? "indeterminate" : false}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelected(new Set(pageItemIds));
                          } else {
                            setSelected(new Set());
                          }
                        }}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button type="button" className="ml-0.5 rounded p-0.5 hover:bg-accent">
                            <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-40">
                          <DropdownMenuItem onClick={() => setSelected(new Set(pageItemIds))}>
                            <Check className="mr-2 h-3.5 w-3.5" />
                            全选本页
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSelected(new Set(filteredIds))}>
                            <Check className="mr-2 h-3.5 w-3.5" />
                            选择全部 ({filteredIds.length})
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSelected(new Set())}>
                            <X className="mr-2 h-3.5 w-3.5" />
                            取消选择
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>网络环境</TableHead>
                  <TableHead>所有者</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="w-32 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((link) => (
                  <TableRow key={link.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(link.id)}
                        onCheckedChange={() => toggleOne(link.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{link.name}</TableCell>
                    <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
                      {link.url}
                    </TableCell>
                    <TableCell>
                      <NetworkEnvBadge env={link.network_env as NetworkEnv | undefined} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {link.owner?.name || link.owner?.username || "-"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {link.created_at || "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEdit(link)}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleDelete(link)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {!isLoading && !isError && filtered.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground">
          <span>
            显示 {pageStart + 1}-{Math.min(pageStart + pageSize, filtered.length)}，共 {filtered.length} 条
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <span className="min-w-[52px] text-center text-foreground">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </Button>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <LinkEditDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        link={null}
      />

      <LinkEditDialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) setEditLink(null);
        }}
        link={editLink}
      />

      <AdminDefaultLinksDialog
        open={defaultsOpen}
        onOpenChange={setDefaultsOpen}
      />

      <LinkSortDialog
        open={sortOpen}
        onOpenChange={setSortOpen}
        links={links}
      />
    </div>
  );
}

// ─── Admin Default Links Dialog ──────────────────────────────────────

function AdminDefaultLinksDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = React.useState<number[]>([]);
  const [search, setSearch] = React.useState("");

  const { data: linksData, isLoading: linksLoading } = useQuery<LinkListResponse>({
    queryKey: ["links"],
    queryFn: fetchLinks,
    enabled: open,
  });

  const { data: defaultsData } = useQuery<LinkSelectionResponse>({
    queryKey: ["admin", "defaultLinks"],
    queryFn: fetchAdminDefaultLinks,
    enabled: open,
  });

  React.useEffect(() => {
    if (open && defaultsData) {
      setSelected(defaultsData.link_ids ?? []);
    }
  }, [open, defaultsData]);

  const links = linksData?.links ?? [];

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return links;
    return links.filter((l) =>
      `${l.name} ${l.url}`.toLowerCase().includes(q),
    );
  }, [links, search]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        return prev.filter((x) => x !== id);
      }
      if (prev.length >= 5) {
        toast.warning("最多只能选择 5 个默认链接");
        return prev;
      }
      return [...prev, id];
    });
  };

  const saveMut = useMutation({
    mutationFn: async () => updateAdminDefaultLinks(selected),
    onSuccess: () => {
      toast.success("默认链接已保存");
      qc.invalidateQueries({ queryKey: ["admin", "defaultLinks"] });
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || "保存失败"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>配置演讲者默认链接</DialogTitle>
          <DialogDescription>
            设置全局默认的 5 个快捷链接。当用户未自定义选择时，将使用这些默认链接。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-0.5 pb-1">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索链接…"
                className="h-7 w-full rounded-md border bg-background pl-7 pr-3 text-sm outline-none focus:border-primary/60"
              />
            </div>
            <span className="text-sm text-muted-foreground shrink-0">
              已选 <span className="font-medium text-foreground">{selected.length}</span> / 5
            </span>
          </div>

          {linksLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
              暂无可选链接
            </div>
          ) : (
            <div className="grid gap-1.5">
              {filtered.map((link) => {
                const checked = selected.includes(link.id);
                const disabled = !checked && selected.length >= 5;
                return (
                  <label
                    key={link.id}
                    className={cn(
                      "flex items-center gap-3 rounded-md border px-3 py-2.5 transition",
                      checked
                        ? "border-primary bg-primary/5"
                        : disabled
                          ? "cursor-not-allowed opacity-50"
                          : "cursor-pointer hover:bg-accent",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(link.id)}
                      disabled={disabled}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="line-clamp-1 text-sm font-medium">{link.name}</span>
                      </div>
                      <p className="line-clamp-1 text-xs text-muted-foreground">{link.url}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="border-t pt-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending}
          >
            {saveMut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// 链接排序对话框：单层级拖拽排序
// ============================================================================

function LinkSortDialog({
  open,
  onOpenChange,
  links,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  links: Link[];
}) {
  const qc = useQueryClient();
  const [list, setList] = React.useState<Link[]>([]);
  const [saving, setSaving] = React.useState(false);
  const dragIdRef = React.useRef<number | null>(null);
  const [draggingId, setDraggingId] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (open) {
      // 按当前后端返回顺序（已是 sort_order 序）展示
      setList(links.slice());
    }
  }, [open, links]);

  const clearDrag = () => {
    dragIdRef.current = null;
    setDraggingId(null);
  };

  /** 计算应插入到容器内的索引（排除正在拖动的元素） */
  const computeDropIndex = (
    container: HTMLElement,
    clientY: number,
  ): number => {
    const children = Array.from(
      container.querySelectorAll<HTMLElement>(":scope > [data-sort-item]"),
    ).filter((el) => !el.classList.contains("is-dragging"));
    for (let i = 0; i < children.length; i++) {
      const box = children[i].getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return i;
    }
    return children.length;
  };

  const reorder = (arr: Link[], from: number, to: number): Link[] => {
    if (from < 0 || from >= arr.length) return arr;
    const clamped = Math.max(0, Math.min(to, arr.length - 1));
    if (clamped === from) return arr;
    const next = arr.slice();
    const [item] = next.splice(from, 1);
    next.splice(clamped, 0, item);
    return next;
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const dragId = dragIdRef.current;
    if (dragId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const to = computeDropIndex(e.currentTarget, e.clientY);
    setList((prev) => {
      const from = prev.findIndex((l) => l.id === dragId);
      return reorder(prev, from, to);
    });
  };

  const handleSave = async () => {
    if (list.length === 0) {
      toast.error("暂无链接可排序");
      return;
    }
    setSaving(true);
    try {
      await updateLinksOrder(list.map((l) => l.id));
      toast.success("排序已更新");
      qc.invalidateQueries({ queryKey: ["links"] });
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!saving) onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>排序</DialogTitle>
          <DialogDescription>
            拖动调整链接顺序，保存后前台展示顺序将随之变化。
          </DialogDescription>
        </DialogHeader>
        <div
          className="max-h-[70vh] space-y-1.5 overflow-y-auto pr-1"
          onDragOver={handleDragOver}
          onDrop={(e) => {
            if (dragIdRef.current != null) e.preventDefault();
          }}
        >
          {list.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              暂无链接
            </div>
          ) : (
            list.map((link) => {
              const isDragging = draggingId === link.id;
              return (
                <div
                  key={link.id}
                  data-sort-item="link"
                  draggable
                  onDragStart={(e) => {
                    dragIdRef.current = link.id;
                    setDraggingId(link.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(link.id));
                  }}
                  onDragEnd={clearDrag}
                  className={cn(
                    "flex cursor-grab select-none items-center gap-2 rounded-md border bg-background px-3 py-2 transition active:cursor-grabbing",
                    isDragging && "is-dragging opacity-50 ring-2 ring-primary",
                  )}
                >
                  <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{link.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {link.url}
                    </div>
                  </div>
                  <NetworkEnvBadge env={link.network_env as NetworkEnv | undefined} />
                </div>
              );
            })
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving || list.length === 0}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            保存排序
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
