import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useNavLabel } from "@/lib/nav-config";

interface AdminTag {
  id: number;
  name: string;
  category: string;
  label: string;
  sort_order: number;
  usage_count: number;
  created_at: string | null;
}

interface AdminTagsResponse {
  tags: AdminTag[];
  user_custom_tags: boolean;
}

interface TagsCreateResponse {
  created: AdminTag[];
  skipped: string[];
}

interface CategoryGroup {
  category: string;
  tags: AdminTag[];
}

export default function TagManagePage() {
  const qc = useQueryClient();
  const title = useNavLabel("manage_tags", "标签管理");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin", "tags"],
    queryFn: async () => api<AdminTagsResponse>("/api/admin/tags"),
  });

  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTag, setEditTag] = React.useState<AdminTag | null>(null);

  const tags = data?.tags ?? [];
  const userCustomTags = data?.user_custom_tags ?? false;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) =>
      `${t.name} ${t.category} ${t.label}`.toLowerCase().includes(q),
    );
  }, [tags, query]);

  const groups = React.useMemo<CategoryGroup[]>(() => {
    const map = new Map<string, AdminTag[]>();
    for (const t of filtered) {
      const arr = map.get(t.category);
      if (arr) arr.push(t);
      else map.set(t.category, [t]);
    }
    return Array.from(map.entries()).map(([category, tagList]) => ({
      category,
      tags: tagList.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
    }));
  }, [filtered]);

  const toggleCategory = (cat: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const configMut = useMutation({
    mutationFn: async (next: boolean) =>
      api<{ user_custom_tags: boolean }>("/api/admin/tags/config", {
        method: "PUT",
        json: { user_custom_tags: next },
      }),
    onSuccess: (res) => {
      toast.success(res.user_custom_tags ? "已允许用户自定义标签" : "已禁止用户自定义标签");
      qc.invalidateQueries({ queryKey: ["admin", "tags"] });
    },
    onError: (err: Error) => toast.error(err.message || "更新失败"),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) =>
      api(`/api/admin/tags/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("标签已删除");
      qc.invalidateQueries({ queryKey: ["admin", "tags"] });
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const handleDelete = (t: AdminTag) => {
    const tip =
      t.usage_count > 0
        ? `标签「${t.name}」已被 ${t.usage_count} 个资源使用。\n删除后不影响已使用的标签数据，是否继续？`
        : `确认删除标签「${t.name}」？`;
    if (window.confirm(tip)) {
      delMut.mutate(t.id);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
            {filtered.length === tags.length
              ? `共 ${tags.length} 个`
              : `筛选后 ${filtered.length} / ${tags.length} 个`}
          </span>
        </div>
      </header>

      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标签名、分类"
            className={cn(
              "h-8 w-full rounded-full border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition sm:w-56",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              query.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label
            className={cn(
              "flex h-8 items-center gap-2 rounded-full border bg-background px-3 text-xs text-muted-foreground transition",
              userCustomTags && "border-primary/40 bg-primary/5 text-foreground",
              configMut.isPending && "opacity-60",
            )}
          >
            <span>允许用户自定义标签</span>
            <Switch
              checked={userCustomTags}
              disabled={configMut.isPending || isLoading}
              onCheckedChange={(v) => configMut.mutate(Boolean(v))}
            />
          </label>
          <Button
            size="sm"
            className="h-8 gap-1.5 rounded-full px-3 text-sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            添加标签
          </Button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-auto">
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
            {query.trim() ? "未找到匹配的标签" : "暂无标签，点击右上角“添加标签”创建"}
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => {
              const open = !collapsed.has(g.category);
              return (
                <div
                  key={g.category}
                  className="overflow-hidden rounded-md border bg-card"
                >
                  <button
                    type="button"
                    onClick={() => toggleCategory(g.category)}
                    className="flex w-full items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2 text-sm transition hover:bg-muted/60"
                  >
                    <div className="flex items-center gap-1.5 font-medium">
                      {open ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>{g.category}</span>
                      <Badge variant="soft" className="ml-1">
                        {g.tags.length}
                      </Badge>
                    </div>
                  </button>
                  {open && (
                    <ul className="divide-y">
                      {g.tags.map((t) => (
                        <li
                          key={t.id}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-sm transition hover:bg-accent/30"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium">{t.name}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              ·
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              使用 <span className="text-foreground">{t.usage_count}</span> 次
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-muted-foreground hover:text-foreground"
                              onClick={() => setEditTag(t)}
                            >
                              <Pencil className="mr-1 h-3.5 w-3.5" />
                              编辑
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => handleDelete(t)}
                              disabled={delMut.isPending}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <CreateTagsDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={() => qc.invalidateQueries({ queryKey: ["admin", "tags"] })}
      />
      <EditTagDialog
        tag={editTag}
        onOpenChange={(o) => {
          if (!o) setEditTag(null);
        }}
        onSuccess={() => qc.invalidateQueries({ queryKey: ["admin", "tags"] })}
      />
    </div>
  );
}

function CreateTagsDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSuccess: () => void;
}) {
  const [text, setText] = React.useState("");

  React.useEffect(() => {
    if (!open) setText("");
  }, [open]);

  const parseTags = (raw: string): string[] => {
    return raw
      .split(/[\n,，]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };

  const list = React.useMemo(() => parseTags(text), [text]);

  const mut = useMutation({
    mutationFn: async (tags: string[]) =>
      api<TagsCreateResponse>("/api/admin/tags", {
        method: "POST",
        json: { tags },
      }),
    onSuccess: (res) => {
      const created = res.created.length;
      const skipped = res.skipped.length;
      if (created > 0) {
        toast.success(
          skipped > 0
            ? `创建了 ${created} 个，跳过了 ${skipped} 个重复`
            : `成功创建 ${created} 个标签`,
        );
      } else if (skipped > 0) {
        toast.warning(`全部 ${skipped} 个标签已存在，已跳过`);
      } else {
        toast.message("未创建任何标签");
      }
      onSuccess();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || "创建失败"),
  });

  const submit = () => {
    if (list.length === 0) {
      toast.error("请至少输入一个标签");
      return;
    }
    mut.mutate(list);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加标签</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            每行输入一个标签，格式为「分类-标签名」（如：技术-Python）。无分类前缀的标签将归入「未分类」。
            <br />
            也支持使用英文逗号或中文逗号分隔批量输入。
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"技术-Python\n技术-React\n设计-封面\n未分类直接写"}
            disabled={mut.isPending}
            className={cn(
              "min-h-[160px] w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm outline-none transition",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          {list.length > 0 && (
            <div className="text-xs text-muted-foreground">
              将创建 <span className="font-medium text-foreground">{list.length}</span> 个标签
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mut.isPending}
          >
            取消
          </Button>
          <Button onClick={submit} disabled={mut.isPending || list.length === 0}>
            {mut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {mut.isPending ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditTagDialog({
  tag,
  onOpenChange,
  onSuccess,
}: {
  tag: AdminTag | null;
  onOpenChange: (o: boolean) => void;
  onSuccess: () => void;
}) {
  const [name, setName] = React.useState("");

  React.useEffect(() => {
    if (tag) setName(tag.name);
    else setName("");
  }, [tag]);

  const mut = useMutation({
    mutationFn: async (payload: { id: number; name: string }) =>
      api<AdminTag>(`/api/admin/tags/${payload.id}`, {
        method: "PUT",
        json: { name: payload.name },
      }),
    onSuccess: () => {
      toast.success("标签已更新");
      onSuccess();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || "更新失败"),
  });

  const submit = () => {
    if (!tag) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("标签名称不能为空");
      return;
    }
    if (trimmed === tag.name) {
      onOpenChange(false);
      return;
    }
    mut.mutate({ id: tag.id, name: trimmed });
  };

  return (
    <Dialog open={tag !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>编辑标签</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            修改标签名称，使用「分类-标签名」格式可调整分组归属。
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：技术-Python"
            disabled={mut.isPending}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            className={cn(
              "h-9 w-full rounded-md border bg-background px-3 text-sm shadow-sm outline-none transition",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          {tag && tag.usage_count > 0 && (
            <div className="text-xs text-muted-foreground">
              当前已被 {tag.usage_count} 个资源使用。重命名不会自动更新历史数据中的标签文本。
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mut.isPending}
          >
            取消
          </Button>
          <Button onClick={submit} disabled={mut.isPending || !name.trim()}>
            {mut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {mut.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
