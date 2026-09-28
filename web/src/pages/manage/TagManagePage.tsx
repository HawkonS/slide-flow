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

type TagDomain = "resource" | "subject" | "secrecy" | "status" | "user";

interface AdminTag {
  id: number;
  name: string;
  category: string;
  label: string;
  sort_order: number;
  usage_count: number;
  default_filter: boolean;
  created_at: string | null;
}

interface AdminTagsResponse {
  tags: AdminTag[];
  resource_custom_tags?: boolean;
  user_custom_tags?: boolean;
  secrecy_custom_tags?: boolean;
  status_custom_tags?: boolean;
}

interface TagsCustomConfig {
  resource_custom_tags: boolean;
  user_custom_tags: boolean;
  secrecy_custom_tags: boolean;
  status_custom_tags: boolean;
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
    label: "分类标签",
    description: "用于单页素材与放映内容的通用分类、检索和筛选。",
    usage: "素材使用",
    empty: "暂无分类标签，点击右上角“添加分类标签”创建",
  },
  subject: {
    label: "主体标签",
    description: "用于维护素材导入和编辑时可选择的主体。",
    usage: "素材使用",
    empty: "暂无主体标签，点击右上角“添加主体标签”创建",
  },
  secrecy: {
    label: "密级标签",
    description: "用于维护素材导入和编辑时可选择的密级。",
    usage: "素材使用",
    empty: "暂无密级标签，点击右上角“添加密级标签”创建",
  },
  status: {
    label: "状态标签",
    description: "用于维护素材导入和编辑时可选择的状态。",
    usage: "素材使用",
    empty: "暂无状态标签，点击右上角“添加状态标签”创建",
  },
  user: {
    label: "用户标签",
    description: "用于人员分类、用户筛选和后续按人群设置权限范围；批量分配请在用户管理中操作。",
    usage: "用户使用",
    empty: "暂无用户标签，点击右上角“添加用户标签”创建",
  },
} satisfies Record<TagDomain, Record<string, string>>;

function domainEndpoint(domain: TagDomain): string {
  if (domain === "resource") return "/api/admin/tags";
  return `/api/admin/${domain}-tags`;
}

const TAG_DOMAINS: TagDomain[] = ["resource", "subject", "secrecy", "status", "user"];

export default function TagManagePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedDomain = searchParams.get("tab") as TagDomain | null;
  const domain: TagDomain = requestedDomain && TAG_DOMAINS.includes(requestedDomain) ? requestedDomain : "resource";

  const handleTabChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value !== "resource") next.set("tab", value);
    else next.delete("tab");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="page-shell">
      <header className="space-y-1">
        <h1 className="page-title">标签管理</h1>
        <p className="text-sm text-muted-foreground">
          分类、主体、密级、状态与用户标签分别维护，互不混用。
        </p>
      </header>

      <Tabs value={domain} onValueChange={handleTabChange} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="w-fit">
          {TAG_DOMAINS.map((item) => (
            <TabsTrigger key={item} value={item} className="gap-1.5">
              {item === "user" ? <UserRound className="h-3.5 w-3.5" /> : <Tag className="h-3.5 w-3.5" />}
              {domainCopy[item].label}
            </TabsTrigger>
          ))}
        </TabsList>
        {TAG_DOMAINS.map((item) => (
          <TabsContent key={item} value={item} className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
            <TagDomainPanel domain={item} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function TagDomainPanel({ domain }: { domain: TagDomain }) {
  const qc = useQueryClient();
  const copy = domainCopy[domain];
  const endpoint = domainEndpoint(domain);
  const queryKey = ["admin", `${domain}-tags`];
  const { data, isLoading, isError, error } = useQuery({
    queryKey,
    queryFn: () => api<AdminTagsResponse>(endpoint),
  });
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTag, setEditTag] = React.useState<AdminTag | null>(null);
  const isFlatDomain = domain === "subject" || domain === "secrecy" || domain === "status";

  const tags = data?.tags ?? [];
  const filtered = React.useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return tags;
    return tags.filter((item) =>
      `${item.name} ${item.category} ${item.label}`.toLowerCase().includes(search),
    );
  }, [query, tags]);
  const groups = React.useMemo<CategoryGroup[]>(() => {
    if (isFlatDomain) {
      return [{
        category: domainCopy[domain].label,
        tags: [...filtered].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
      }];
    }
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
  }, [domain, filtered, isFlatDomain]);

  const customConfigKey: keyof TagsCustomConfig | null = domain === "resource"
    ? "resource_custom_tags"
    : domain === "user"
      ? "user_custom_tags"
      : domain === "secrecy"
        ? "secrecy_custom_tags"
        : domain === "status"
          ? "status_custom_tags"
          : null;
  const customAllowed = customConfigKey ? data?.[customConfigKey] : false;
  const configMutation = useMutation({
    mutationFn: (next: boolean) => {
      if (!customConfigKey) throw new Error("该标签类型不支持用户自定义配置");
      return api<TagsCustomConfig>("/api/admin/tags/config", {
        method: "PUT",
        json: { [customConfigKey]: next },
      });
    },
    onSuccess: (result) => {
      const enabled = customConfigKey ? result[customConfigKey] : false;
      toast.success(enabled ? `已允许自定义${copy.label}` : `已限制为预设${copy.label}`);
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (mutationError: Error) => toast.error(mutationError.message || "更新失败"),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => api(`${endpoint}/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`${copy.label}已删除`);
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: domain === "resource" || domain === "user" ? ["preset-tags", domain] : ["metadata-tags", domain] });
      if (domain === "user") qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: (mutationError: Error) => toast.error(mutationError.message || "删除失败"),
  });
  const defaultFilterMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api<AdminTag>(endpoint + "/" + id + "/default-filter", {
        method: "PUT",
        json: { enabled },
      }),
    onSuccess: (updated) => {
      toast.success(
        (updated.default_filter ? "已设为默认筛选：" : "已取消默认筛选：") + updated.name,
      );
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (mutationError: Error) => toast.error(mutationError.message || "更新默认筛选失败"),
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
      ? domain === "user"
        ? `「${item.name}」当前有 ${item.usage_count} 个用户在使用。删除后会同时移除用户分组以及依赖该标签的素材/模板动态权限，是否继续？`
        : `「${item.name}」当前有 ${item.usage_count} 个素材或放映在使用。删除定义不会清除历史业务字段，是否继续？`
      : `确认删除${copy.label}「${item.name}」？`;
    if (window.confirm(detail)) deleteMutation.mutate(item.id);
  };
  const invalidate = () => {
    qc.invalidateQueries({ queryKey });
    qc.invalidateQueries({ queryKey: domain === "resource" || domain === "user" ? ["preset-tags", domain] : ["metadata-tags", domain] });
    if (domain === "user") qc.invalidateQueries({ queryKey: ["admin", "users"] });
  };
  const renderTagRow = (item: AdminTag) => (
    <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm transition hover:bg-accent/30">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium">{domain === "subject" ? item.name : (item.label || item.name)}</span>
        {domain !== "subject" && item.label && item.label !== item.name && (
          <span className="truncate text-xs text-muted-foreground">{item.name}</span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">
          {copy.usage} <span className="text-foreground">{item.usage_count}</span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <label className="mr-1 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={item.default_filter}
            onCheckedChange={(enabled) => defaultFilterMutation.mutate({ id: item.id, enabled })}
            disabled={defaultFilterMutation.isPending && defaultFilterMutation.variables?.id === item.id}
            aria-label={item.name + "默认筛选"}
          />
          默认筛选
        </label>
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
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
        <div className="min-w-[220px] flex-1">
          <div className="text-sm font-medium">{copy.label}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{copy.description}</div>
        </div>
        {customConfigKey && (
          <label
            className={cn(
              "flex h-8 items-center gap-2 rounded-md border bg-background px-3 text-xs text-muted-foreground transition",
              customAllowed && "border-primary/40 bg-primary/5 text-foreground",
              configMutation.isPending && "opacity-60",
            )}
          >
            <span>允许自定义{copy.label}</span>
            <Switch
              checked={customAllowed ?? false}
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
            placeholder={isFlatDomain ? `搜索${copy.label}` : `搜索${copy.label}或分类`}
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
          isFlatDomain ? (
            <ul className="divide-y rounded-lg border bg-card">
              {groups[0]?.tags.map(renderTagRow)}
            </ul>
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
                    {open && <ul className="divide-y">{group.tags.map(renderTagRow)}</ul>}
                  </section>
                );
              })}
            </div>
          )
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
            {domain === "subject" || domain === "secrecy" || domain === "status"
              ? `每行输入一个${copy.label}名称，也可用中英文逗号批量分隔。${copy.label}是平面标签，不分级。`
              : "每行输入一个标签；可使用“分类-标签名”分组，也可用中英文逗号批量分隔。"}
          </p>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={domain === "user"
              ? "部门-销售\n部门-研发\n人员-外部协作"
              : domain === "resource"
                ? "用途-封面\n行业-金融\n风格-简约"
                : domain === "subject"
                  ? "集团\n产品线\n品牌名称"
                  : domain === "secrecy"
                    ? "内部公开\n内部保密"
                    : "草稿\n已发布\n已归档"}
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
            重命名只会更新当前{copy.label}及其已使用素材，不会影响其他标签类型。
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
