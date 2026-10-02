import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api';
import { readOfflineIdentity } from '@/lib/offline-session';
import { applyResourceDeletion, type DeletionPreview, type DeletionResult, type DeletionScope, type ReferenceAction } from '@/lib/resource-deletion';

interface Props {
  open: boolean; onOpenChange: (open: boolean) => void; resourceIds: number[];
  name?: string; versionCount?: number; mode?: 'delete' | 'rollback'; onSuccess?: () => void;
}
export function ResourceDeletionDialog(props: Props) {
  return props.open ? <DeletionContent key={props.resourceIds.join(',') + ':' + props.mode} {...props} /> : null;
}
function DeletionContent({ onOpenChange, resourceIds, name, versionCount = 1, mode = 'delete', onSuccess }: Props) {
  const client = useQueryClient();
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const isBatch = mode !== 'rollback' && resourceIds.length > 1;
  const defaultScope: DeletionScope = mode === 'rollback' || (resourceIds.length === 1 && versionCount > 1) || isBatch ? 'latest' : 'all';
  const [scope, setScope] = React.useState<DeletionScope>(defaultScope);
  const [batchScopeChoice, setBatchScopeChoice] = React.useState<DeletionScope | null>(isBatch ? null : defaultScope);
  const [action, setAction] = React.useState<ReferenceAction | null>(null);
  const [conflict, setConflict] = React.useState('');
  const preview = useQuery({
    queryKey: ['resource-deletion-preview', resourceIds.join(','), scope],
    queryFn: ({ signal }) => api<DeletionPreview>('/api/resources/delete-preview', { method: 'POST', json: { resource_ids: resourceIds, scope }, signal }),
    enabled: resourceIds.length > 0, staleTime: 0, gcTime: 0,
  });
  const impact = preview.data;
  const mutation = useMutation({
    mutationFn: async () => {
      if (!impact || preview.isFetching || (impact.has_references && !action)) throw new Error('请先查看引用清单并选择处理方式');
      const identity = readOfflineIdentity();
      const json = { reference_action: impact.has_references ? action : 'remove', confirmation_token: impact.confirmation_token };
      const result = mode === 'rollback'
        ? await api<DeletionResult>('/api/resources/' + resourceIds[0] + '/versions/rollback', { method: 'POST', json })
        : resourceIds.length === 1
          ? await api<DeletionResult>('/api/resources/' + resourceIds[0], { method: 'DELETE', params: { scope }, json })
          : await api<DeletionResult>('/api/resources/batch', { method: 'DELETE', json: { ...json, resource_ids: resourceIds, scope } });
      return { result, identity };
    },
    onSuccess: async ({ result, identity }) => {
      try {
        if (await applyResourceDeletion(client, result, identity)) toast.warning('删除已完成，部分本地缓存未能更新，请联网重新获取');
      } catch { toast.warning('删除已完成，请刷新页面查看最新状态'); }
      toast.success(result.reference_action === 'preserve'
        ? (mode === 'rollback' ? '已回退，放映仍保留原页面' : '已从素材库移除，放映页面已保留')
        : '操作完成：移除 ' + result.removed_pages + ' 页，删除 ' + result.deleted_show_ids.length + ' 个空放映');
      onOpenChange(false); onSuccess?.();
    },
    onError: (error: Error) => {
      toast.error(error.message);
      if (error instanceof ApiError && [403, 404, 409].includes(error.status)) {
        setAction(null); setConflict('引用、权限或版本已变化，请查看更新后的清单并重新选择。'); void preview.refetch();
      }
    },
  });
  const busy = mutation.isPending;
  const scopeChoiceRequired = mode !== 'rollback' && resourceIds.length > 1 && Boolean(impact?.targets.some(target => target.version_count > 1));
  const singleScopeVisible = mode !== 'rollback' && resourceIds.length === 1 && (versionCount > 1 || Boolean(impact?.targets.some(target => target.version_count > 1)));
  const disabled = busy || preview.isFetching || !impact || preview.isError || (scopeChoiceRequired && !batchScopeChoice) || (impact.has_references && !action);
  const confirmLabel = action === 'preserve'
    ? (mode === 'rollback' ? '确认回退并保留放映页面' : '确认移出素材库并保留页面')
    : impact?.has_references ? '确认删除：移除 ' + impact.removed_pages + ' 页' + (impact.removed_share_pages ? '，清理 ' + impact.removed_share_pages + ' 个分享页面' : '') + '，删除 ' + impact.empty_show_count + ' 个空放映'
      : mode === 'rollback' ? '确认回退' : '确认删除';
  return <Dialog open onOpenChange={next => !busy && onOpenChange(next)}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" hideClose={busy} onOpenAutoFocus={event => { event.preventDefault(); cancelRef.current?.focus(); }}>
      <DialogHeader>
        <DialogTitle>{mode === 'rollback' ? '回退素材版本' : resourceIds.length > 1 ? '批量删除素材' : '删除素材'}</DialogTitle>
        <DialogDescription>{name ? '「' + name + '」' : '已选择 ' + resourceIds.length + ' 项素材'}。请先检查引用和删除范围，此操作不可恢复。</DialogDescription>
      </DialogHeader>
      {(singleScopeVisible || scopeChoiceRequired) && <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="resource-delete-scope">删除范围</label>
        <Select value={isBatch ? (batchScopeChoice ?? 'choose') : scope} disabled={busy} onValueChange={value => { if (value === 'choose') return; setScope(value as DeletionScope); if (isBatch) setBatchScopeChoice(value as DeletionScope); setAction(null); setConflict(''); }}>
          <SelectTrigger id="resource-delete-scope"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="choose" disabled>请选择删除范围</SelectItem><SelectItem value="latest">仅删除最新版本</SelectItem><SelectItem value="all">删除全部版本</SelectItem></SelectContent>
        </Select>
      </div>}
      {conflict && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{conflict}</p>}
      {preview.isFetching ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />正在检查放映引用…</p>
        : preview.isError ? <div role="alert" className="space-y-2 text-sm"><p>{preview.error.message}</p><Button variant="outline" size="sm" onClick={() => void preview.refetch()}>重试引用检查</Button></div>
        : impact && <>
          <p className="text-sm text-muted-foreground">本次涉及 {impact.targets.reduce((total, target) => total + target.selected_version_count, 0)} 个素材版本；被 {impact.show_count} 个放映版本引用，含 {impact.share_count} 个有效分享链接。</p>
          {scopeChoiceRequired && <p className="rounded-md border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100">所选素材包含多个版本，请选择本次删除范围。单版本素材选择“仅删除最新版本”时，也会删除整份素材。</p>}
          <ul aria-label="删除目标清单" className="max-h-[20dvh] space-y-1 overflow-y-auto rounded-md border p-3 text-xs text-muted-foreground">
            {impact.targets.map(target => <li key={target.id}>「{target.name}」：有效版本 {target.version_count} 个，本次删除 v{target.version_nos.join('、v')}（{target.delete_resource ? '删除整份素材' : '保留素材'}）</li>)}
          </ul>
          {impact.has_references ? <>
            <ul aria-label="引用放映清单" className="max-h-[30dvh] space-y-2 overflow-y-auto rounded-md border p-3">
              {impact.shows.map(show => <li key={show.id} className="space-y-1 border-b pb-2 text-sm last:border-b-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2"><a href={'/shows/' + show.id} target="_blank" rel="noreferrer" className="break-words font-medium underline underline-offset-2">{show.name} · v{show.version_no}</a>{show.will_delete && <strong className="text-destructive">同步移除后将删除此空放映</strong>}</div>
                <p className="text-xs text-muted-foreground">所有者：{show.owner?.name || show.owner?.username || '未知用户'}</p>
                <p className="text-xs text-muted-foreground">当前 {show.page_count} 页；将移除 {show.removed_pages} 页，剩余 {show.remaining_pages} 页{show.share_count > 0 && '；涉及 ' + show.share_count + ' 个分享链接'}{!show.can_manage && '；无管理权限'}</p>
                <p className="break-words text-xs text-muted-foreground">{show.references.map(ref => '素材 #' + ref.resource_id + ' · v' + ref.version_no + (ref.hidden ? '（隐藏页）' : '')).join('、') || '仅分享快照引用'}</p>
              </li>)}
              {impact.restricted_show_count > 0 && <li className="text-sm text-muted-foreground">另有 {impact.restricted_show_count} 个无查看权限的放映引用，详情不予展示。</li>}
            </ul>
            <fieldset className="space-y-2" disabled={busy}><legend className="mb-2 text-sm font-medium">本次如何处理放映引用？</legend>
              <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3"><input type="radio" name="reference-action" value="preserve" checked={action === 'preserve'} onChange={() => setAction('preserve')} className="mt-1" /><span className="text-sm"><strong>从素材库移除，保留放映页面</strong><span className="mt-1 block text-xs text-muted-foreground">保留原页面、版本、备注和放映分享；解除全部引用后再回收文件。</span></span></label>
              <label className="flex items-start gap-3 rounded-md border p-3"><input type="radio" name="reference-action" value="remove" checked={action === 'remove'} disabled={!impact.available_actions.includes('remove')} onChange={() => setAction('remove')} className="mt-1" /><span className="text-sm"><strong>删除素材并同步移除引用页面</strong><span className="mt-1 block text-xs text-muted-foreground">同时清理相关分享页面，并删除 {impact.empty_show_count} 个因此变空的放映。{!impact.available_actions.includes('remove') && '你对部分引用放映无管理权限，本次只能保留页面。'}</span></span></label>
            </fieldset>
          </> : <p className="rounded-md border p-3 text-sm">没有放映或有效放映分享引用这些版本，可以直接删除。</p>}
        </>}
      <DialogFooter className="gap-2"><Button ref={cancelRef} variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button><Button variant="destructive" className="h-auto min-h-10 whitespace-normal" disabled={disabled} onClick={() => mutation.mutate()}>{busy ? '处理中…' : confirmLabel}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
