import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { readOfflineIdentity } from '@/lib/offline-session';
import { applyResourceDeletion, type DeletionResult } from '@/lib/resource-deletion';
interface Props { open: boolean; onOpenChange: (open: boolean) => void; showId: number }
interface Preview { missing_count: number; remaining_pages: number; will_delete: boolean; confirmation_token: string }
export function MissingResourceCleanupDialog(props: Props) {
  return props.open ? <CleanupContent {...props} /> : null;
}
function CleanupContent({ onOpenChange, showId }: Props) {
  const client = useQueryClient();
  const url = '/api/shows/' + showId + '/cleanup-missing-resources';
  const preview = useQuery({ queryKey: ['missing-resource-cleanup', showId], queryFn: ({ signal }) => api<Preview>(url, { method: 'POST', json: { preview: true }, signal }), staleTime: 0, gcTime: 0 });
  const mutation = useMutation({
    mutationFn: async () => {
      if (!preview.data || preview.isFetching) throw new Error('请先检查清理影响');
      const identity = readOfflineIdentity();
      const result = await api<DeletionResult>(url, { method: 'POST', json: { preview: false, confirmation_token: preview.data.confirmation_token } });
      return { result, identity };
    },
    onSuccess: async ({ result, identity }) => {
      try { if (await applyResourceDeletion(client, result, identity)) toast.warning('清理已完成，请联网更新本地缓存'); } catch { toast.warning('清理已完成，请刷新页面'); }
      toast.success(result.deleted_show_ids.length ? '空放映已删除' : '失效页面已清理'); onOpenChange(false);
    },
    onError: (error: Error) => { toast.error(error.message); if (error instanceof ApiError && error.status === 409) void preview.refetch(); },
  });
  return <Dialog open onOpenChange={open => !mutation.isPending && onOpenChange(open)}><DialogContent hideClose={mutation.isPending}>
    <DialogHeader><DialogTitle>清理失效页面</DialogTitle><DialogDescription>仅清理已经不存在的素材或版本，不会移除只是没有查看权限的页面。</DialogDescription></DialogHeader>
    {preview.isFetching ? <p role="status">正在检查清理影响…</p> : preview.isError ? <p role="alert">{preview.error.message}</p> : preview.data && <div className="space-y-2 text-sm"><p>将清理 {preview.data.missing_count} 个失效页面，剩余 {preview.data.remaining_pages} 页。</p>{preview.data.will_delete && <p className="font-medium text-destructive">此放映将没有页面，确认后会同时删除该放映及其分享链接。</p>}</div>}
    <DialogFooter><Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>取消</Button><Button variant="destructive" disabled={mutation.isPending || preview.isFetching || !preview.data || preview.isError} onClick={() => mutation.mutate()}>{mutation.isPending ? '清理中…' : preview.data?.will_delete ? '确认清理并删除空放映' : '确认清理'}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
