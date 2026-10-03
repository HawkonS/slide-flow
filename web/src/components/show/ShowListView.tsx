import { useQueryClient } from "@tanstack/react-query";
import { Eye, GitBranch, ImageOff, MoreHorizontal, Pencil, Pin, PinOff, Star, StarOff, Trash2, Copy } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableTags, TableText } from "@/components/common/TableContent";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEFAULT_RESOURCE_SUBJECT } from "@/lib/constants";
import { api } from "@/lib/api";
import { isAdminRole, parseTags, type Show, type ShowResourceAccessible } from "@/lib/types";
import { useAuth } from "@/lib/auth";

interface ShowListViewProps {
  shows: Show[];
  onOpen: (show: Show) => void;
  onEdit?: (show: Show) => void;
  onDuplicate?: (show: Show) => void;
  onIterate?: (show: Show) => void;
  onDelete?: (show: Show) => void;
  onToggleStandard?: (show: Show) => void;
  selectedIds?: Set<number>;
  allPageSelected?: boolean;
  somePageSelected?: boolean;
  onToggle?: (id: number) => void;
  onTogglePage?: (checked: boolean) => void;
}

export function ShowListView({
  shows, onOpen, onEdit, onDuplicate, onIterate, onDelete, onToggleStandard,
  selectedIds, allPageSelected, somePageSelected, onToggle, onTogglePage,
}: ShowListViewProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const togglePin = async (show: Show) => {
    try {
      if (show.is_pinned) {
        await api(`/api/me/pins/shows/${show.id}`, { method: "DELETE" });
        toast.success("已取消置顶");
      } else {
        await api(`/api/me/pins/shows/${show.id}`, { method: "POST" });
        toast.success("已置顶到首页");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["shows"] }),
        queryClient.invalidateQueries({ queryKey: ["home", "pins"] }),
        queryClient.invalidateQueries({ queryKey: ["home", "stats"] }),
      ]);
    } catch (err) {
      toast.error((err as Error).message || "操作失败");
    }
  };

  return (
    <div className="surface overflow-hidden">
      <Table className="min-w-[1040px]">
        <TableHeader>
          <TableRow>
            {selectedIds && onTogglePage && <TableHead className="w-10"><Checkbox checked={allPageSelected ? true : somePageSelected ? "indeterminate" : false} onCheckedChange={(checked) => onTogglePage(checked === true)} aria-label="选择本页放映" /></TableHead>}
            <TableHead className="w-20">预览</TableHead>
            <TableHead>名称</TableHead>
            <TableHead className="w-32">主体</TableHead>
            <TableHead className="w-48">标签</TableHead>
            <TableHead className="w-20">状态</TableHead>
            <TableHead className="w-20">页数</TableHead>
            <TableHead className="w-28">更新时间</TableHead>
            <TableHead className="w-12"><span className="sr-only">操作</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shows.map((show) => {
            const preview = show.resources.find((resource): resource is ShowResourceAccessible => resource.accessible)?.preview_url;
            const tags = parseTags(show.tags);
            const selected = selectedIds?.has(show.id) ?? false;
            return (
              <TableRow key={show.id} data-state={selected ? "selected" : undefined} className={selected ? "bg-[hsl(var(--selection))]" : undefined}>
                {selectedIds && onToggle && <TableCell><Checkbox checked={selected} onCheckedChange={() => onToggle(show.id)} aria-label={`选择放映 ${show.name}`} /></TableCell>}
                <TableCell>
                  <button type="button" onClick={() => onOpen(show)} aria-label={`查看放映 ${show.name}`} className="flex h-10 w-16 items-center justify-center overflow-hidden rounded border bg-muted">
                    {preview ? <img src={preview} alt="" loading="lazy" className="h-full w-full object-cover" /> : <ImageOff className="h-4 w-4 text-muted-foreground" />}
                  </button>
                </TableCell>
                <TableCell>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <TableText text={show.name} className="flex-1"><button type="button" className="w-full text-left font-medium hover:text-primary hover:underline" onClick={() => onOpen(show)}>
                      {show.name}
                    </button></TableText>
                    {show.has_other_versions && <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"><GitBranch className="h-3 w-3" />v{show.version_no}</span>}
                    {show.is_standard && <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]"><Star className="mr-1 h-3 w-3 fill-current" />标准</Badge>}
                  </div>
                  <div className="text-[11px] text-muted-foreground">ID {show.id}</div>
                </TableCell>
                <TableCell className="text-muted-foreground"><TableText text={show.subject || DEFAULT_RESOURCE_SUBJECT} /></TableCell>
                <TableCell>
                  <TableTags tags={tags} />
                </TableCell>
                <TableCell><Badge variant="outline" className="max-w-full text-[11px]"><TableText text={show.status} /></Badge></TableCell>
                <TableCell className="text-muted-foreground">{show.all_resource_ids?.length ?? show.resources.length}</TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(show.updated_at).toLocaleDateString("zh-CN")}</TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><button type="button" aria-label={`${show.name} 更多操作`} className="rounded p-1 hover:bg-accent"><MoreHorizontal className="h-4 w-4" /></button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => onOpen(show)}><Eye className="mr-2 h-4 w-4" />查看详情</DropdownMenuItem>
                      {user && <DropdownMenuItem onSelect={() => void togglePin(show)}>{show.is_pinned ? <><PinOff className="mr-2 h-4 w-4" />取消置顶</> : <><Pin className="mr-2 h-4 w-4" />置顶首页</>}</DropdownMenuItem>}
                      {onToggleStandard && isAdminRole(user?.role) && <DropdownMenuItem onSelect={() => onToggleStandard(show)}>{show.is_standard ? <><StarOff className="mr-2 h-4 w-4" />取消标准放映</> : <><Star className="mr-2 h-4 w-4" />设为标准放映</>}</DropdownMenuItem>}
                      {show.can_manage && (onEdit || onDuplicate || onIterate || onDelete) && <>
                        <DropdownMenuSeparator />
                        {onEdit && <DropdownMenuItem onSelect={() => window.setTimeout(() => onEdit(show), 0)}><Pencil className="mr-2 h-4 w-4" />编辑信息</DropdownMenuItem>}
                        {onDuplicate && <DropdownMenuItem onSelect={() => window.setTimeout(() => onDuplicate(show), 0)}><Copy className="mr-2 h-4 w-4" />创建副本</DropdownMenuItem>}
                        {onIterate && <DropdownMenuItem onSelect={() => onIterate(show)}><GitBranch className="mr-2 h-4 w-4" />版本迭代</DropdownMenuItem>}
                        {onDelete && <DropdownMenuItem onSelect={() => window.setTimeout(() => onDelete(show), 0)} className="text-destructive focus:text-destructive"><Trash2 className="mr-2 h-4 w-4" />删除</DropdownMenuItem>}
                      </>}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
