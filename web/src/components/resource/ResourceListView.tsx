import { Download, ImageOff, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

import { TableTags, TableText } from "@/components/common/TableContent";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEFAULT_RESOURCE_SUBJECT } from "@/lib/constants";
import { parseTags, type Resource } from "@/lib/types";

interface ResourceListViewProps {
  resources: Resource[];
  selectedIds: Set<number>;
  allPageSelected: boolean;
  somePageSelected: boolean;
  onToggle: (id: number) => void;
  onTogglePage: (checked: boolean) => void;
  onOpen: (resource: Resource) => void;
  onPreview: (resource: Resource) => void;
  onDownload: (resource: Resource) => void;
  onEdit: (resource: Resource) => void;
  onDelete: (resource: Resource) => void;
}

export function ResourceListView({
  resources, selectedIds, allPageSelected, somePageSelected, onToggle, onTogglePage,
  onOpen, onPreview, onDownload, onEdit, onDelete,
}: ResourceListViewProps) {
  return (
    <div className="surface overflow-hidden">
      <Table className="min-w-[900px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allPageSelected ? true : somePageSelected ? "indeterminate" : false}
                onCheckedChange={(checked) => onTogglePage(checked === true)}
                aria-label="选择本页素材"
              />
            </TableHead>
            <TableHead className="w-20">预览</TableHead>
            <TableHead className="w-[calc(20em+1rem)]">名称</TableHead>
            <TableHead className="w-28">主体</TableHead>
            <TableHead>标签</TableHead>
            <TableHead className="w-20">状态</TableHead>
            <TableHead className="w-24">更新时间</TableHead>
            <TableHead className="w-12"><span className="sr-only">操作</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {resources.map((resource) => {
            const preview = resource.current?.preview_url;
            const tags = parseTags(resource.tags);
            const selected = selectedIds.has(resource.id);
            return (
              <TableRow key={resource.id} data-state={selected ? "selected" : undefined} className={selected ? "bg-[hsl(var(--selection))]" : undefined}>
                <TableCell>
                  <Checkbox
                    checked={selected}
                    onCheckedChange={() => onToggle(resource.id)}
                    aria-label={`选择素材 ${resource.name}`}
                  />
                </TableCell>
                <TableCell>
                  <button
                    type="button"
                    onClick={() => onPreview(resource)}
                    aria-label={`放大查看 ${resource.name}`}
                    className="flex h-9 w-16 items-center justify-center overflow-hidden rounded border bg-muted"
                  >
                    {preview ? <img src={preview} alt="" loading="lazy" className="h-full w-full object-contain" /> : <ImageOff className="h-4 w-4 text-muted-foreground" />}
                  </button>
                </TableCell>
                <TableCell>
                  <TableText text={resource.name} className="flex-1"><button type="button" className="w-full text-left font-medium hover:text-primary hover:underline" onClick={() => onOpen(resource)}>
                    {resource.name}
                  </button></TableText>
                  <div className="text-[11px] text-muted-foreground">ID {resource.id} · v{resource.current_version}</div>
                </TableCell>
                <TableCell className="text-muted-foreground"><TableText text={resource.subject || DEFAULT_RESOURCE_SUBJECT} /></TableCell>
                <TableCell>
                  <TableTags tags={tags} fitToWidth />
                </TableCell>
                <TableCell><Badge variant="outline" className="max-w-full text-[11px]"><TableText text={resource.status} /></Badge></TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(resource.updated_at).toLocaleDateString("zh-CN")}</TableCell>
                <TableCell>
                  {resource.can_manage && <DropdownMenu>
                    <DropdownMenuTrigger asChild><button type="button" aria-label={`${resource.name} 更多操作`} className="rounded p-1 hover:bg-accent"><MoreHorizontal className="h-4 w-4" /></button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => window.setTimeout(() => onEdit(resource), 0)}><Pencil className="mr-2 h-4 w-4" />编辑</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => window.setTimeout(() => onDownload(resource), 0)}><Download className="mr-2 h-4 w-4" />下载</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => window.setTimeout(() => onDelete(resource), 0)} className="text-destructive focus:text-destructive"><Trash2 className="mr-2 h-4 w-4" />删除</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
