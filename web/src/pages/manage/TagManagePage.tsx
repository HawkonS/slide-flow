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
  UserRound,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type TagDomain = "resource" | "user";

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
  user_custom_tags?: boolean;
}

interface TagsCreateResponse {
  created: AdminTag[];
  skipped: string[];
}

interface CategoryGroup {
  category: string;
  tags: AdminTag[];
}

const domainCopy = {
  resource: {
    label: "素材标签",
    description: "用于单页素材与放映内容的分类、检索和筛选。",
    usage: "素材使用",
    empty: "暂无素材标签，点击右上角“添加素材标签”创建",
  },
  user: {
    label: "用户标签",
    description: "用于人员分类、用户筛选和后续按人群设置权限范围。",
    usage: "用户使用",
    empty: "暂无用户标签，点击右上角“添加用户标签”创建",
  },
} satisfies Record<TagDomain, Record<string, string>>;

function domainEndpoint(domain: TagDomain): string {
  return domain === "user" ? "/api/admin/user-tags" : "/api/admin/tags";
}

export default function TagManagePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const domain: TagDomain = searchParams.get("tab") === "user" ? "user" : "resource";

  const handleTabChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "user") next.set("tab", "user");
    else next.delete("tab");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="page-shell">
      <header className="space-y-1">
        <h1 className="page-title">标签管理</h1>
        <p className="text-sm text-muted-foreground">
          素材标签用于分类和筛选素材，用户标签用于分类和筛选用户。
        </p>
      </header>

      <Tabs value={domain} onValueChange={handleTabChange} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="w-fit">
          <TabsTrigger value="resource" className="gap-1.5">
            <Tag className="h-3.5 w-3.5" />
            素材标签
          </TabsTrigger>
          <TabsTrigger value="user" className="gap-1.5">
            <UserRound className="h-3.5 w-3.5" />
            用户标签
          </TabsTrigger>
        </TabsList>
        <TabsContent value="resource" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <TagDomainPanel domain="resource" />
        </TabsContent>
        <TabsContent value="user" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <TagDomainPanel domain="user" />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TagDomainPanel({ domain }: { domain: TagDomain }) {
  const qc = useQueryClient();
  const copy = domainCopy[domain];
  const endpoint = domainEndpoint(domain);
  const queryKey = ["admin", domain === "user" ? "user-tags" : "tags"];
  const { data, isLoading, isError, error } = useQuery({
    queryKey,
    queryFn: () => api<AdminTagsResponse>(endpoint),
  });
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTag, setEditTag] = React.useState<AdminTag | null>(null);

  const tags = data?.tags ?? [];
  const filtered = React.useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return tags;
    return tags.filter((item) =>
      `${item.name} ${item.category} ${item.label}`.toLowerCase().includes(search),
    );
  }, [query, tags]);
  const groups = React.useMemo<CategoryGroup[]>(() => {
    const grouped = new Map<string, AdminTag[]>();
    for (const item of filtered) {
      const current = grouped.get(item.category);
      if (current) current.push(item);
      else grouped.set(item.category, [item]);
    }
    return Array.from(grouped.entries()).map(([category, items]) => ({
      category,
      tags: items.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
    }));
  }, [filtered]);

  const configMutation = useMutation({
    mutationFn: (next: boolean) =>
      api<{ user_custom_tags: boolean }>("/api/admin/tags/config", {
        method: "PUT",
        json: { user_custom_tags: next },
      }),
    onSuccess: (result) => {
      toast.success(result.user_custom_tags ? "已允许自定义素材标签" : "已限制为预设素材标签");
      qc.invalidateQueries({ queryKey: ["admin", "tags"] });
      qc.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (mutationError: Error) => toast.error(mutationError.message || "更新失败"),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => api(`${endpoint}/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`${copy.label}已删除`);
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ["preset-tags", domain] });
      if (domain === "user") qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: (mutationError: Error) => toast.error(mutationError.message || "删除失败"),
  });

  const toggleCategory = (category: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };
  const handleDelete = (item: AdminTag) => {
    const detail = item.usage_count > 0
      ? `「${item.name}」当前有 ${item.usage_count} 个${domain === "user" ? "用户" : "素材或放映"}在使用。删除定义不会清除历史数据，是否继续？`
      : `确认删除${copy.label}「${item.name}」？`;
    if (window.confirm(detail)) deleteMutation.mutate(item.id);
  };
  const invalidate = () => {
    qc.invalidateQueries({ queryKey });
    qc.invalidateQueries({ queryKey: ["preset-tags", domain] });
    if (domain === "user") qc.invalidateQueries({ queryKey: ["admin", "users"] });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
        <div className="min-w-[220px] flex-1">
          <div className="text-sm font-medium">{copy.label}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{copy.description}</div>
        </div>
        {domain === "resource" && (
          <label
            className={cn(
              "flex h-8 items-center gap-2 rounded-md border bg-background px-3 text-xs text-muted-foreground transition",
              data?.user_custom_tags && "border-primary/40 bg-primary/5 text-foreground",
              configMutation.isPending && "opacity-60",
            )}
          >
            <span>允许自定义素材标签</span>
            <Switch
              checked={data?.user_custom_tags ?? false}
              disabled={configMutation.isPending || isLoading}
              onCheckedChange={(checked) => configMutation.mutate(Boolean(checked))}
            />
          </label>
        )}
        <Button size="sm" className="h-8 gap-1.5 px-3" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          添加{copy.label}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`搜索${copy.label}或分类`}
            className={cn(
              "h-8 w-full rounded-md border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition sm:w-64",
              "placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              query.trim() && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {filtered.length === tags.length ? `共 ${tags.length} 个` : `筛选后 ${filtered.length} / ${tags.length} 个`}
        </span>
      </div>

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
            {query.trim() ? `未找到匹配的${copy.label}` : copy.empty}
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => {
              const open = !collapsed.has(group.category);
              return (
                <section key={group.category} className="overflow-hidden rounded-lg border bg-card">
                  <button
                    type="button"
                    onClick={() => toggleCategory(group.category)}
                    className="flex w-full items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2 text-sm transition hover:bg-muted/60"
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                      {domain === "user" ? <UserRound className="h-3.5 w-3.5 text-muted-foreground" /> : <Tag className="h-3.5 w-3.5 text-muted-foreground" />}
                      {group.category}
                      <Badge variant="soft" className="ml-1">{group.tags.length}</Badge>
                    </span>
                  </button>
                  {open && (
                    <ul className="divide-y">
                      {group.tags.map((item) => (
                        <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm transition hover:bg-accent/30">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium">{item.name}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {copy.usage} <span className="text-foreground">{item.usage_count}</span>
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground hover:text-foreground" onClick={() => setEditTag(item)}>
                              <Pencil className="mr-1 h-3.5 w-3.5" /> 编辑
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => handleDelete(item)}
                              disabled={deleteMutation.isPending}
                              aria-label={`删除${item.name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      <CreateTagsDialog domain={domain} open={createOpen} onOpenChange={setCreateOpen} onSuccess={invalidate} />
      <EditTagDialog domain={domain} tag={editTag} onOpenChange={(open) => !open && setEditTag(null)} onSuccess={invalidate} />
    </div>
  );
}

function CreateTagsDialog({
  domain,
  open,
  onOpenChange,
  onSuccess,
}: {
  domain: TagDomain;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const copy = domainCopy[domain];
  const [text, setText] = React.useState("");
  React.useEffect(() => {
    if (!open) setText("");
  }, [open]);
  const tags = React.useMemo(
    () => text.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean),
    [text],
  );
  const mutation = useMutation({
    mutationFn: (items: string[]) => api<TagsCreateResponse>(domainEndpoint(domain), {
      method: "POST",
      json: { tags: items },
    }),
    onSuccess: (result) => {
      if (result.created.length) {
        toast.success(result.skipped.length
          ? `创建了 ${result.created.length} 个，跳过 ${result.skipped.length} 个重复项`
          : `已创建 ${result.created.length} 个${copy.label}`);
      } else if (result.skipped.length) toast.warning(`所选${copy.label}均已存在`);
      onSuccess();
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message || "创建失败"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>添加{copy.label}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            每行输入一个标签；可使用“分类-标签名”分组，也可用中英文逗号批量分隔。
          </p>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={domain === "user" ? "部门-销售\n部门-研发\n人员-外部协作" : "用途-封面\n行业-金融\n风格-简约"}
            disabled={mutation.isPending}
            className={cn(
              "min-h-[160px] w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm outline-none transition",
              "placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-60",
            )}
          />
          {tags.length > 0 && <div className="text-xs text-muted-foreground">将创建 <span className="font-medium text-foreground">{tags.length}</span> 个{copy.label}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>取消</Button>
          <Button onClick={() => mutation.mutate(tags)} disabled={mutation.isPending || tags.length === 0}>
            {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditTagDialog({
  domain,
  tag,
  onOpenChange,
  onSuccess,
}: {
  domain: TagDomain;
  tag: AdminTag | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const copy = domainCopy[domain];
  const [name, setName] = React.useState("");
  React.useEffect(() => setName(tag?.name ?? ""), [tag]);
  const mutation = useMutation({
    mutationFn: (payload: { id: number; name: string }) =>
      api<AdminTag>(`${domainEndpoint(domain)}/${payload.id}`, {
        method: "PUT",
        json: { name: payload.name },
      }),
    onSuccess: () => {
      toast.success(`${copy.label}已更新`);
      onSuccess();
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message || "更新失败"),
  });
  const submit = () => {
    if (!tag) return;
    const trimmed = name.trim();
    if (!trimmed) return toast.error("标签名称不能为空");
    if (trimmed === tag.name) return onOpenChange(false);
    mutation.mutate({ id: tag.id, name: trimmed });
  };

  return (
    <Dialog open={tag !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>编辑{copy.label}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            重命名只会更新{domain === "user" ? "用户标签及已分配用户" : "素材标签及已使用的素材、放映"}，不会影响另一类标签。
          </p>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
            disabled={mutation.isPending}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm shadow-sm outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          />
          {tag && tag.usage_count > 0 && (
            <div className="text-xs text-muted-foreground">当前{copy.usage} {tag.usage_count}。</div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>取消</Button>
          <Button onClick={submit} disabled={mutation.isPending || !name.trim()}>
            {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
