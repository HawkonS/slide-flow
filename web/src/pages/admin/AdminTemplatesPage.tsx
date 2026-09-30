import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownUp,
  Check,
  ChevronDown,
  Download,
  GripVertical,
  ImageOff,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MetadataTagSelect } from "@/components/resource/MetadataTagSelect";
import { UserPicker } from "@/components/resource/UserPicker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  MANAGEMENT_SCOPE_OPTIONS,
  TEMPLATE_PLATFORM_LABEL,
  TEMPLATE_PLATFORM_OPTIONS,
  TEMPLATE_RATIO_OPTIONS,
  TEMPLATE_TYPE_LABEL,
  TEMPLATE_TYPE_OPTIONS,
  VISIBILITY_SCOPE_OPTIONS,
} from "@/lib/constants";
import { downloadWithProgress } from "@/lib/fonts";
import { TemplateItem, VisibilityScope } from "@/lib/types";
import { useUrlPage } from "@/lib/use-url-page";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/PageHeader";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";

interface TemplateListResponse {
  items: TemplateItem[];
  total: number;
}

export function AdminTemplatesPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["templates"],
    queryFn: async () => api<TemplateListResponse>("/api/templates"),
  });

  const [query, setQuery] = React.useState("");
  const [editing, setEditing] = React.useState<TemplateItem | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [sortOpen, setSortOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<TemplateItem | null>(null);

  const templates = data?.items ?? [];
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => {
      const hay = [
        t.name,
        t.subject || "",
        t.series || "",
        t.platform || "",
        t.ratio || "",
        t.template_type || "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [templates, query]);

  const filteredIds = React.useMemo(() => filtered.map((t) => t.id), [filtered]);

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const delMut = useMutation({
    mutationFn: async (id: number) =>
      api(`/api/admin/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("模板已删除");
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const bulkDelMut = useMutation({
    mutationFn: async (ids: number[]) =>
      api<{ deleted: number }>("/api/admin/templates/bulk-delete", {
        method: "POST",
        json: { template_ids: ids },
      }),
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 个模板`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (err: Error) => toast.error(err.message || "批量删除失败"),
  });

  const handleDownload = async (t: TemplateItem) => {
    const url = t.download_url || `/api/templates/${t.id}/download`;
    const base = t.office_file_name || `${t.name}.pptx`;
    try {
      await downloadWithProgress(url, base);
      toast.success("下载完成");
    } catch (err) {
      toast.error((err as Error).message || "下载失败");
    }
  };

  // 动态分页：模板行较高（含缩略图），单行高度按 76px 估算
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = React.useState(8);
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const compute = () => {
      const H = el.clientHeight;
      if (!H) return;
      const headerH = 45;
      const rowH = 76;
      const rows = Math.max(5, Math.floor((H - headerH) / rowH));
      setPageSize((prev) => (prev === rows ? prev : rows));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [page, setPage] = useUrlPage();
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  React.useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);
  React.useEffect(() => {
    setPage(1);
  }, [query]);
  const pageStart = (page - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);
  const pageItemIds = React.useMemo(() => pageItems.map((t) => t.id), [pageItems]);
  const allSelected = pageItemIds.length > 0 && pageItemIds.every((id) => selected.has(id));
  const someSelected = pageItemIds.some((id) => selected.has(id)) && !allSelected;

  return (
    <div className="page-shell">
      <PageHeader
        title="模板管理"
        count={filtered.length === templates.length
          ? `共 ${templates.length} 条`
          : `筛选后 ${filtered.length} / ${templates.length} 条`}
      />

      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模板、主体、系列"
            className={cn(
              "h-8 w-full rounded-md border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition sm:w-56",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              query.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
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
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            批量删除
          </Button>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-3 text-sm"
          onClick={() => {
            if (templates.length === 0) {
              toast.error("暂无模板可排序");
              return;
            }
            setSortOpen(true);
          }}
        >
          <ArrowDownUp className="h-3.5 w-3.5" />
          排序
        </Button>
        <Button
          size="sm"
          className="h-8 gap-1.5 px-3 text-sm"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          新增模板
        </Button>
      </div>

      {/* 内容区 */}
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
            暂无模板
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
                  <TableHead className="w-24">预览</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead className="w-24">类型</TableHead>
                  <TableHead className="w-24">平台</TableHead>
                  <TableHead className="w-20">比例</TableHead>
                  <TableHead className="w-28">可见性</TableHead>
                  <TableHead className="w-32 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(t.id)}
                        onCheckedChange={() => toggleOne(t.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex h-12 w-20 items-center justify-center overflow-hidden rounded border bg-muted">
                        {t.preview_url ? (
                          <img
                            src={t.preview_url}
                            alt={t.name}
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <ImageOff className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{t.name}</div>
                      {(t.subject || t.series) && (
                        <div className="text-xs text-muted-foreground">
                          {[t.subject, t.series].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {t.template_type ? (
                        <Badge variant="outline" className="text-[11px]">
                          {TEMPLATE_TYPE_LABEL[t.template_type] || t.template_type}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {t.platform ? (
                        <Badge variant="outline" className="text-[11px]">
                          {TEMPLATE_PLATFORM_LABEL[t.platform] || t.platform}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {t.ratio || "-"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={t.visibility_scope === "public" ? "default" : "secondary"}
                        className="text-[11px]"
                      >
                        {t.visibility_scope === "public"
                          ? "公开"
                          : t.visibility_scope === "partial"
                          ? "部分"
                          : "仅自己"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDownload(t)}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(t)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(t)}
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

      {/* 分页条 */}
      {!isLoading && !isError && filtered.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground select-none">
          <span>
            显示 {pageStart + 1}-{Math.min(pageStart + pageSize, filtered.length)}，共{" "}
            {filtered.length} 条
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
            <span className="min-w-[52px] text-center text-foreground select-none">
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

      <TemplateFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        template={null}
      />
      <TemplateFormDialog
        open={editing != null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        template={editing}
      />
      <TemplateSortDialog
        open={sortOpen}
        onOpenChange={setSortOpen}
        templates={templates}
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="批量删除模板"
        description={`确定删除选中的 ${selected.size} 个模板吗？删除后无法恢复。`}
        confirmLabel="删除模板"
        destructive
        loading={bulkDelMut.isPending}
        onConfirm={() => {
          bulkDelMut.mutate(Array.from(selected), { onSuccess: () => setBulkDeleteOpen(false) });
        }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="删除模板"
        description={deleteTarget ? `确定删除模板「${deleteTarget.name}」吗？删除后无法恢复。` : ""}
        confirmLabel="删除模板"
        destructive
        loading={delMut.isPending}
        onConfirm={() => {
          const target = deleteTarget;
          if (target) delMut.mutate(target.id, { onSuccess: () => setDeleteTarget(null) });
        }}
      />
    </div>
  );
}

export function TemplateFormDialog({
  open,
  onOpenChange,
  template,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  template: TemplateItem | null;
}) {
  const qc = useQueryClient();
  const editing = !!template;
  const { user } = useAuth();
  const ownerId = template?.owner?.id ?? user?.id;

  const [series, setSeries] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [platform, setPlatform] = React.useState("wps");
  const [ratio, setRatio] = React.useState("16:9");
  const [templateType, setTemplateType] = React.useState("content");
  const [visibility, setVisibility] = React.useState<VisibilityScope>("public");
  const [visibleIds, setVisibleIds] = React.useState<number[]>([]);
  const [visibleTags, setVisibleTags] = React.useState<string[]>([]);
  const [management, setManagement] = React.useState<VisibilityScope>("private");
  const [manageIds, setManageIds] = React.useState<number[]>([]);
  const [manageTags, setManageTags] = React.useState<string[]>([]);
  const [officeFile, setOfficeFile] = React.useState<File | null>(null);
  const [pngFile, setPngFile] = React.useState<File | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setSeries(template?.series || "");
    setSubject(template?.subject || "");
    setPlatform(template?.platform || "wps");
    setRatio(template?.ratio || "16:9");
    setTemplateType(template?.template_type || "content");
    setVisibility((template?.visibility_scope as VisibilityScope) || "public");
    setVisibleIds(template?.visible_user_ids || []);
    setVisibleTags(template?.visible_user_tags || []);
    setManagement((template?.management_scope as VisibilityScope) || "private");
    setManageIds(template?.manage_user_ids || []);
    setManageTags(template?.manage_user_tags || []);
    setOfficeFile(null);
    setPngFile(null);
    setLoading(false);
  }, [open, template]);

  const submit = async () => {
    if (!series.trim() || !subject.trim()) {
      toast.error("系列和主体必填");
      return;
    }
    if (!editing && !officeFile) {
      toast.error("请选择 Office 文件");
      return;
    }
    if (visibility === "partial" && !visibleIds.length && !visibleTags.length) {
      toast.error("可见范围为部分时请至少选择一位用户或一个用户标签");
      return;
    }
    if (management === "partial" && !manageIds.length && !manageTags.length) {
      toast.error("管理范围为部分时请至少选择一位用户或一个用户标签");
      return;
    }
    const body = new FormData();
    body.set("series", series.trim());
    body.set("subject", subject.trim());
    body.set("platform", platform);
    body.set("ratio", ratio);
    body.set("template_type", templateType);
    body.set("visibility_scope", visibility);
    body.set("visible_user_ids", JSON.stringify(visibility === "partial" ? visibleIds : []));
    body.set("visible_user_tags", JSON.stringify(visibility === "partial" ? visibleTags : []));
    body.set("management_scope", management);
    body.set("manage_user_ids", JSON.stringify(management === "partial" ? manageIds : []));
    body.set("manage_user_tags", JSON.stringify(management === "partial" ? manageTags : []));
    if (officeFile) body.set("office_file", officeFile);
    if (pngFile) body.set("png_file", pngFile);

    setLoading(true);
    try {
      const url = editing ? `/api/templates/${template!.id}` : "/api/templates";
      const res = await fetch(url, {
        method: editing ? "PUT" : "POST",
        credentials: "include",
        body,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || "保存失败");
      }
      toast.success("模板已保存");
      qc.invalidateQueries({ queryKey: ["templates"] });
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || "保存失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑模板" : "新增模板"}</DialogTitle>
        </DialogHeader>
        <div className="grid max-h-[70vh] gap-3 overflow-y-auto sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>系列 *</Label>
            <Input
              value={series}
              onChange={(e) => setSeries(e.target.value)}
              placeholder="只能填写一个系列"
            />
          </div>
          <div className="space-y-1.5">
            <Label>主体 *</Label>
            <MetadataTagSelect
              domain="subject"
              value={subject}
              onChange={setSubject}
            />
          </div>
          <div className="space-y-1.5">
            <Label>平台</Label>
            <Select value={platform} onValueChange={setPlatform}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TEMPLATE_PLATFORM_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>比例</Label>
            <Select value={ratio} onValueChange={setRatio}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TEMPLATE_RATIO_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>类型</Label>
            <Select value={templateType} onValueChange={setTemplateType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TEMPLATE_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Office 文件 {editing ? "（可选）" : "*"}</Label>
            <Input
              type="file"
              accept=".ppt,.pptx,.pot,.potx,.pps,.ppsx"
              onChange={(e) => setOfficeFile(e.target.files?.[0] ?? null)}
            />
            {editing && (
              <div className="text-xs text-muted-foreground">
                当前：{template?.office_file_name || "-"}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>PNG 预览（可选）</Label>
            <Input
              type="file"
              accept=".png"
              onChange={(e) => setPngFile(e.target.files?.[0] ?? null)}
            />
          </div>

          <ScopeBlock
            label="可见范围"
            scope={visibility}
            onScopeChange={setVisibility}
            selected={visibleIds}
            onChange={setVisibleIds}
            selectedTags={visibleTags}
            onTagsChange={setVisibleTags}
            lockedIds={ownerId ? [ownerId] : undefined}
            options={VISIBILITY_SCOPE_OPTIONS}
          />
          <ScopeBlock
            label="管理范围"
            scope={management}
            onScopeChange={setManagement}
            selected={manageIds}
            onChange={setManageIds}
            selectedTags={manageTags}
            onTagsChange={setManageTags}
            lockedIds={ownerId ? [ownerId] : undefined}
            options={MANAGEMENT_SCOPE_OPTIONS}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            取消
          </Button>
          <Button onClick={submit} disabled={loading}>
            {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeBlock({
  label,
  scope,
  onScopeChange,
  selected,
  onChange,
  selectedTags,
  onTagsChange,
  lockedIds,
  options,
}: {
  label: string;
  scope: VisibilityScope;
  onScopeChange: (v: VisibilityScope) => void;
  selected: number[];
  onChange: (ids: number[]) => void;
  selectedTags: string[];
  onTagsChange: (tags: string[]) => void;
  lockedIds?: number[];
  options: readonly { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <Label>{label}</Label>
      <Select value={scope} onValueChange={(v) => onScopeChange(v as VisibilityScope)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {scope === "partial" && (
        <UserPicker
          value={selected}
          onChange={onChange}
          tagValue={selectedTags}
          onTagChange={onTagsChange}
          allowTagSelection
          lockedIds={lockedIds}
        />
      )}
    </div>
  );
}

// ============================================================================
// 模板排序对话框：主体 / 系列 / 模板三级拖拽排序
// ============================================================================

type SortSubject = {
  subject: string;
  series: SortSeries[];
};
type SortSeries = {
  series: string;
  templates: SortTemplate[];
};
type SortTemplate = {
  id: number;
  name: string;
  template_type: string | null;
};

function buildSortTree(templates: TemplateItem[]): SortSubject[] {
  const bySubject = new Map<string, Map<string, SortTemplate[]>>();
  templates.forEach((t) => {
    const subject = (t.subject || "").trim() || "未设置主体";
    const series = (t.series || "").trim() || "未设置系列";
    if (!bySubject.has(subject)) bySubject.set(subject, new Map());
    const seriesMap = bySubject.get(subject)!;
    if (!seriesMap.has(series)) seriesMap.set(series, []);
    seriesMap.get(series)!.push({
      id: t.id,
      name: t.name,
      template_type: t.template_type,
    });
  });
  return Array.from(bySubject.entries()).map(([subject, seriesMap]) => ({
    subject,
    series: Array.from(seriesMap.entries()).map(([series, items]) => ({
      series,
      templates: items,
    })),
  }));
}

export function TemplateSortDialog({
  open,
  onOpenChange,
  templates,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  templates: TemplateItem[];
}) {
  const qc = useQueryClient();
  const [tree, setTree] = React.useState<SortSubject[]>([]);
  const [saving, setSaving] = React.useState(false);
  // 拖拽状态：kind 区分层级
  type DragState =
    | { kind: "subject"; subject: string }
    | { kind: "series"; subject: string; series: string }
    | { kind: "template"; subject: string; series: string; id: number };
  const dragRef = React.useRef<DragState | null>(null);
  const [draggingKey, setDraggingKey] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) setTree(buildSortTree(templates));
  }, [open, templates]);

  const clearDrag = () => {
    dragRef.current = null;
    setDraggingKey(null);
  };

  /** 根据鼠标 Y 坐标，在容器的直接子项中找出应该插入的索引（排除正在拖动的元素后的索引） */
  const computeDropIndex = (container: HTMLElement, clientY: number): number => {
    const children = Array.from(
      container.querySelectorAll<HTMLElement>(":scope > [data-sort-item]"),
    ).filter((el) => !el.classList.contains("is-dragging"));
    for (let i = 0; i < children.length; i++) {
      const box = children[i].getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return i;
    }
    return children.length;
  };

  /** 将 from 位置的元素移动到 to 位置（to 基于"移除 from 后"的数组索引） */
  const reorder = <T,>(arr: T[], from: number, to: number): T[] => {
    if (from < 0 || from >= arr.length) return arr;
    const clamped = Math.max(0, Math.min(to, arr.length - 1));
    if (clamped === from) return arr;
    const next = arr.slice();
    const [item] = next.splice(from, 1);
    next.splice(clamped, 0, item);
    return next;
  };

  /** 主体层容器的 dragover：根据鼠标位置将主体移动到新索引 */
  const handleSubjectDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.kind !== "subject") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const to = computeDropIndex(e.currentTarget, e.clientY);
    setTree((prev) => {
      const from = prev.findIndex((s) => s.subject === drag.subject);
      return reorder(prev, from, to);
    });
  };

  /** 系列层容器的 dragover */
  const handleSeriesDragOver = (
    e: React.DragEvent<HTMLDivElement>,
    subjectName: string,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.kind !== "series" || drag.subject !== subjectName) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const to = computeDropIndex(e.currentTarget, e.clientY);
    setTree((prev) =>
      prev.map((s) => {
        if (s.subject !== subjectName) return s;
        const from = s.series.findIndex((x) => x.series === drag.series);
        return { ...s, series: reorder(s.series, from, to) };
      }),
    );
  };

  /** 模板层容器的 dragover */
  const handleTemplateDragOver = (
    e: React.DragEvent<HTMLDivElement>,
    subjectName: string,
    seriesName: string,
  ) => {
    const drag = dragRef.current;
    if (
      !drag ||
      drag.kind !== "template" ||
      drag.subject !== subjectName ||
      drag.series !== seriesName
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const to = computeDropIndex(e.currentTarget, e.clientY);
    setTree((prev) =>
      prev.map((s) => {
        if (s.subject !== subjectName) return s;
        return {
          ...s,
          series: s.series.map((se) => {
            if (se.series !== seriesName) return se;
            const from = se.templates.findIndex((t) => t.id === drag.id);
            return { ...se, templates: reorder(se.templates, from, to) };
          }),
        };
      }),
    );
  };

  const handleSave = async () => {
    const payload = {
      subjects: tree.map((s) => ({
        subject: s.subject === "未设置主体" ? "" : s.subject,
        series: s.series.map((se) => ({
          series: se.series === "未设置系列" ? "" : se.series,
          template_ids: se.templates.map((t) => t.id),
        })),
      })),
    };
    const total = payload.subjects.reduce(
      (acc, s) => acc + s.series.reduce((a, se) => a + se.template_ids.length, 0),
      0,
    );
    if (total === 0) {
      toast.error("暂无模板可排序");
      return;
    }
    setSaving(true);
    try {
      await api("/api/admin/templates/order", {
        method: "PUT",
        json: payload,
      });
      toast.success("排序已更新");
      qc.invalidateQueries({ queryKey: ["templates"] });
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
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>排序</DialogTitle>
        </DialogHeader>
        <div
          className="max-h-[70vh] space-y-2 overflow-y-auto pr-1"
          onDragOver={handleSubjectDragOver}
          onDrop={(e) => {
            if (dragRef.current?.kind === "subject") e.preventDefault();
          }}
        >
          {tree.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              暂无模板
            </div>
          ) : (
            tree.map((s) => {
              const subjectKey = `subject:${s.subject}`;
              const count = s.series.reduce((a, se) => a + se.templates.length, 0);
              const isDraggingSubject = draggingKey === subjectKey;
              return (
                <div
                  key={s.subject}
                  data-sort-item="subject"
                  className={cn(
                    "rounded-md border bg-muted/30 transition",
                    isDraggingSubject && "is-dragging opacity-50 ring-2 ring-primary",
                  )}
                >
                  <div
                    draggable
                    onDragStart={(e) => {
                      dragRef.current = { kind: "subject", subject: s.subject };
                      setDraggingKey(subjectKey);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", s.subject);
                    }}
                    onDragEnd={clearDrag}
                    className="flex cursor-grab select-none items-center gap-2 border-b bg-muted/60 px-3 py-2 active:cursor-grabbing"
                  >
                    <GripVertical className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">主体</span>
                    <strong className="truncate text-sm">{s.subject}</strong>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {count} 个模板
                    </span>
                  </div>
                  <div
                    className="space-y-1.5 p-2"
                    onDragOver={(e) => handleSeriesDragOver(e, s.subject)}
                    onDrop={(e) => {
                      if (
                        dragRef.current?.kind === "series" &&
                        dragRef.current.subject === s.subject
                      ) {
                        e.preventDefault();
                        e.stopPropagation();
                      }
                    }}
                  >
                    {s.series.map((se) => {
                      const seriesKey = `series:${s.subject}/${se.series}`;
                      const isDraggingSeries = draggingKey === seriesKey;
                      return (
                        <div
                          key={se.series}
                          data-sort-item="series"
                          className={cn(
                            "rounded-md border bg-background transition",
                            isDraggingSeries &&
                              "is-dragging opacity-50 ring-2 ring-primary",
                          )}
                        >
                          <div
                            draggable
                            onDragStart={(e) => {
                              e.stopPropagation();
                              dragRef.current = {
                                kind: "series",
                                subject: s.subject,
                                series: se.series,
                              };
                              setDraggingKey(seriesKey);
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", se.series);
                            }}
                            onDragEnd={clearDrag}
                            className="flex cursor-grab select-none items-center gap-2 border-b px-3 py-1.5 active:cursor-grabbing"
                          >
                            <GripVertical className="h-4 w-4 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">系列</span>
                            <strong className="truncate text-sm">{se.series}</strong>
                            <span className="ml-auto text-xs text-muted-foreground">
                              {se.templates.length} 个
                            </span>
                          </div>
                          <div
                            className="space-y-1 p-2"
                            onDragOver={(e) =>
                              handleTemplateDragOver(e, s.subject, se.series)
                            }
                            onDrop={(e) => {
                              if (
                                dragRef.current?.kind === "template" &&
                                dragRef.current.subject === s.subject &&
                                dragRef.current.series === se.series
                              ) {
                                e.preventDefault();
                                e.stopPropagation();
                              }
                            }}
                          >
                            {se.templates.map((t) => {
                              const tplKey = `tpl:${t.id}`;
                              const isDraggingTpl = draggingKey === tplKey;
                              return (
                                <div
                                  key={t.id}
                                  data-sort-item="template"
                                  draggable
                                  onDragStart={(e) => {
                                    e.stopPropagation();
                                    dragRef.current = {
                                      kind: "template",
                                      subject: s.subject,
                                      series: se.series,
                                      id: t.id,
                                    };
                                    setDraggingKey(tplKey);
                                    e.dataTransfer.effectAllowed = "move";
                                    e.dataTransfer.setData("text/plain", t.name);
                                  }}
                                  onDragEnd={clearDrag}
                                  className={cn(
                                    "flex cursor-grab select-none items-center gap-2 rounded border bg-muted/30 px-2.5 py-1.5 text-xs transition active:cursor-grabbing",
                                    isDraggingTpl &&
                                      "is-dragging opacity-50 ring-2 ring-primary",
                                  )}
                                >
                                  <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                                  <span className="truncate">{t.name}</span>
                                  {t.template_type && (
                                    <span className="ml-auto text-[11px] text-muted-foreground">
                                      {TEMPLATE_TYPE_LABEL[t.template_type] ||
                                        t.template_type}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                            {se.templates.length === 0 && (
                              <div className="py-2 text-center text-[11px] text-muted-foreground">
                                拖到此处
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
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
          <Button onClick={handleSave} disabled={saving || tree.length === 0}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            保存排序
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
