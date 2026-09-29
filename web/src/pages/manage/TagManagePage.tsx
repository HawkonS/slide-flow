import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ListFilter,
  Loader2,
  MoreHorizontal,
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/PageHeader";

type TagDomain = "resource" | "subject" | "status" | "user";

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
  status_custom_tags?: boolean;
}

interface TagsCustomConfig {
  resource_custom_tags: boolean;
  user_custom_tags: boolean;
  status_custom_tags: boolean;
}

interface TagsCreateResponse {
  created: AdminTag[];
  skipped: string[];
}

interface TagsBatchUpdateResponse {
  updated: AdminTag[];
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

function isFlatTagDomain(domain: TagDomain) {
  return domain === "subject" || domain === "status";
}

function tagLabel(tag: Pick<AdminTag, "name" | "category" | "label">) {
  return tag.label || tag.name;
}

function tagEditorValue(domain: TagDomain, tag: Pick<AdminTag, "name" | "category" | "label">) {
  return isFlatTagDomain(domain) || !tag.category || tag.category === "未分类"
    ? tag.name
    : tagLabel(tag);
}

function tagNameFromEditorValue(
  domain: TagDomain,
  tag: Pick<AdminTag, "name" | "category" | "label">,
  value: string,
) {
  if (isFlatTagDomain(domain) || !tag.category || tag.category === "未分类") return value;
  return `${tag.category}-${value}`;
}

const TAG_DOMAINS: TagDomain[] = ["resource", "subject", "status", "user"];

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
      <PageHeader
        title="标签管理"
        description="分类、主体、状态与用户标签分别维护，互不混用。"
      />

      <Tabs value={domain} onValueChange={handleTabChange} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="w-fit border bg-muted/40">
          {TAG_DOMAINS.map((item) => (
            <TabsTrigger
              key={item}
              value={item}
              className="gap-1.5"
            >
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
  const [batchEditOpen, setBatchEditOpen] = React.useState(false);
  const [editTag, setEditTag] = React.useState<AdminTag | null>(null);
  const [editCategory, setEditCategory] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());
  const isFlatDomain = isFlatTagDomain(domain);

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
  const filteredIds = React.useMemo(() => filtered.map((item) => item.id), [filtered]);
  const selectedTags = React.useMemo(
    () => tags.filter((item) => selectedIds.has(item.id)),
    [selectedIds, tags],
  );
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const someFilteredSelected = filteredIds.some((id) => selectedIds.has(id));

  React.useEffect(() => {
    const availableIds = new Set(tags.map((item) => item.id));
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => availableIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [tags]);

  const customConfigKey: keyof TagsCustomConfig | null = domain === "resource"
    ? "resource_custom_tags"
    : domain === "user"
      ? "user_custom_tags"
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
        (updated.default_filter ? "已设为默认筛选：" : "已取消默认筛选：") + tagLabel(updated),
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
    setSelectedIds(new Set());
    qc.invalidateQueries({ queryKey });
    qc.invalidateQueries({ queryKey: domain === "resource" || domain === "user" ? ["preset-tags", domain] : ["metadata-tags", domain] });
    if (domain === "user") qc.invalidateQueries({ queryKey: ["admin", "users"] });
  };
  const toggleSelected = (id: number, checked: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const toggleFilteredSelection = (checked: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const id of filteredIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };
  const renderTagCard = (item: AdminTag) => (
    <li key={item.id} className="group flex min-h-[68px] items-center gap-3 rounded-lg border bg-background px-3 py-2 transition hover:border-foreground/20 hover:bg-accent/20">
      <Checkbox
        checked={selectedIds.has(item.id)}
        onCheckedChange={(checked) => toggleSelected(item.id, checked === true)}
        aria-label={`选择${item.name}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium" title={item.name}>{tagLabel(item)}</span>
          {item.default_filter && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-primary" title="已设为默认筛选">
              <Check className="h-3 w-3" />默认
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {item.usage_count} {copy.usage}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-70 transition group-hover:opacity-100">
        <Button variant="ghost" size="sm" className="h-8 px-2 text-muted-foreground hover:text-foreground" onClick={() => setEditTag(item)}>
          <Pencil className="h-3.5 w-3.5" />编辑
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={`${item.name} 更多操作`}
              title="更多操作"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              disabled={defaultFilterMutation.isPending && defaultFilterMutation.variables?.id === item.id}
              onClick={() => defaultFilterMutation.mutate({ id: item.id, enabled: !item.default_filter })}
            >
              <ListFilter className="mr-2 h-3.5 w-3.5" />
              {item.default_filter ? "取消默认筛选" : "设为默认筛选"}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => handleDelete(item)}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />删除标签
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );

  const renderTagCards = (group: CategoryGroup) => (
    <section key={group.category} className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 border-b bg-muted/20 px-4 py-2.5">
        <button
          type="button"
          onClick={() => toggleCategory(group.category)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] transition hover:text-foreground"
        >
          {collapsed.has(group.category)
            ? <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
          {domain === "user"
            ? <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
            : <Tag className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="truncate font-medium">{group.category}</span>
          <Badge variant="soft" className="shrink-0">{group.tags.length}</Badge>
        </button>
        {group.category !== "未分类" && (domain === "resource" || domain === "user") && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground"
                aria-label={`分类 ${group.category} 更多操作`}
                title="分类操作"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-32">
              <DropdownMenuItem onClick={() => setEditCategory(group.category)}>
                <Pencil className="mr-2 h-3.5 w-3.5" />编辑分类
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {!collapsed.has(group.category) && (
        <ul className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {group.tags.map(renderTagCard)}
        </ul>
      )}
    </section>
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
        <label className="flex h-8 items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={allFilteredSelected ? true : someFilteredSelected ? "indeterminate" : false}
            onCheckedChange={(checked) => toggleFilteredSelection(checked === true)}
            disabled={filteredIds.length === 0}
            aria-label="选择当前筛选结果"
          />
          全选当前结果
        </label>
        {selectedIds.size > 0 && (
          <span className="text-xs text-muted-foreground">已选 {selectedIds.size} 个</span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => setBatchEditOpen(true)}
          disabled={selectedIds.size === 0}
        >
          <Pencil className="h-3.5 w-3.5" />
          批量修改
        </Button>
        {selectedIds.size > 0 && (
          <Button variant="ghost" size="sm" className="h-8 px-2 text-muted-foreground" onClick={() => setSelectedIds(new Set())}>
            清空选择
          </Button>
        )}
      </div>

      <div className="surface min-h-0 flex-1 overflow-auto">
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
            {groups.map(renderTagCards)}
          </div>
        )}
      </div>

      <CreateTagsDialog domain={domain} open={createOpen} onOpenChange={setCreateOpen} onSuccess={invalidate} />
      <BatchEditTagsDialog
        domain={domain}
        tags={selectedTags}
        open={batchEditOpen}
        onOpenChange={setBatchEditOpen}
        onSuccess={invalidate}
      />
      <EditTagDialog domain={domain} tag={editTag} onOpenChange={(open) => !open && setEditTag(null)} onSuccess={invalidate} />
      <EditCategoryDialog
        domain={domain}
        category={editCategory}
        count={tags.filter((item) => item.category === editCategory).length}
        onOpenChange={(open) => !open && setEditCategory(null)}
        onSuccess={invalidate}
      />
    </div>
  );
}

function EditCategoryDialog({
  domain, category, count, onOpenChange, onSuccess,
}: {
  domain: TagDomain;
  category: string | null;
  count: number;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [name, setName] = React.useState("");
  React.useEffect(() => setName(category ?? ""), [category]);
  const mutation = useMutation({
    mutationFn: (newCategory: string) => api<{ updated_count: number; category: string }>(
      `${domainEndpoint(domain)}/categories/rename`,
      { method: "PUT", json: { old_category: category, new_category: newCategory } },
    ),
    onSuccess: (result) => {
      toast.success(`已将 ${result.updated_count} 个标签移至「${result.category}」`);
      onSuccess();
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message || "修改分类失败"),
  });
  const submit = () => {
    if (!category) return;
    const next = name.trim();
    if (!next) return toast.error("一级分类名称不能为空");
    if (next === category) return onOpenChange(false);
    mutation.mutate(next);
  };

  return (
    <Dialog open={category !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>编辑一级分类</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <p className="text-xs text-muted-foreground">「{category}」下的 {count} 个标签将一起更名，已有使用记录和权限不会丢失。</p>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
            aria-label="新的一级分类名称"
            disabled={mutation.isPending}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm shadow-sm outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>取消</Button>
          <Button onClick={submit} disabled={mutation.isPending || !name.trim()}>
            {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            保存分类
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
            {domain === "subject" || domain === "status"
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

function BatchEditTagsDialog({
  domain,
  tags,
  open,
  onOpenChange,
  onSuccess,
}: {
  domain: TagDomain;
  tags: AdminTag[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const copy = domainCopy[domain];
  const [names, setNames] = React.useState<Record<number, string>>({});

  React.useEffect(() => {
    if (!open) return;
    const next: Record<number, string> = {};
    for (const tag of tags) next[tag.id] = tagEditorValue(domain, tag);
    setNames(next);
  }, [domain, open, tags]);

  const mutation = useMutation({
    mutationFn: (updates: Array<{ id: number; name: string }>) =>
      api<TagsBatchUpdateResponse>(`${domainEndpoint(domain)}/batch`, {
        method: "PUT",
        json: { updates },
      }),
    onSuccess: (result) => {
      toast.success(`已批量更新 ${result.updated.length} 个${copy.label}`);
      onSuccess();
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message || "批量修改失败"),
  });

  const submit = () => {
    const updates = tags.map((tag) => ({
      id: tag.id,
      name: tagNameFromEditorValue(domain, tag, (names[tag.id] ?? "").trim()),
    }));
    if (updates.some((item) => !item.name)) {
      toast.error("标签名称不能为空");
      return;
    }
    if (new Set(updates.map((item) => item.name)).size !== updates.length) {
      toast.error("批量修改后的标签名称不能重复");
      return;
    }
    mutation.mutate(updates);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>批量修改{copy.label}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="text-xs text-muted-foreground">已选 {tags.length} 个{copy.label}</div>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {tags.map((tag) => (
              <label key={tag.id} className="grid gap-1.5 rounded-md border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,1.4fr)] sm:items-center">
                <span className="min-w-0">
                  {!isFlatTagDomain(domain) && tag.category !== "未分类" && (
                    <span className="block truncate text-xs text-muted-foreground" title={tag.category}>
                      {tag.category}
                    </span>
                  )}
                  <span className="block truncate text-sm text-foreground" title={tag.name}>
                    {tagEditorValue(domain, tag)}
                  </span>
                </span>
                <input
                  value={names[tag.id] ?? ""}
                  onChange={(event) => setNames((previous) => ({ ...previous, [tag.id]: event.target.value }))}
                  disabled={mutation.isPending}
                  aria-label={`${tag.name}的新名称`}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm shadow-sm outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                />
              </label>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>取消</Button>
          <Button onClick={submit} disabled={mutation.isPending || tags.length === 0}>
            {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            保存修改
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
  React.useEffect(() => {
    setName(tag ? tagEditorValue(domain, tag) : "");
  }, [domain, tag]);
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
    const nextName = tagNameFromEditorValue(domain, tag, trimmed);
    if (nextName === tag.name) return onOpenChange(false);
    mutation.mutate({ id: tag.id, name: nextName });
  };

  return (
    <Dialog open={tag !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>编辑{copy.label}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {tag && !isFlatTagDomain(domain) && tag.category !== "未分类"
              ? `当前一级分类：${tag.category}。修改后仍归属于该分类。`
              : `重命名只会更新当前${copy.label}及其已使用素材，不会影响其他标签类型。`}
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
