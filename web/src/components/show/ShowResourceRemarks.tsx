import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";

import { RichTextEditor, richTextToPlain } from "@/components/resource/RichTextEditor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { Resource, ShowResourceAccessible } from "@/lib/types";

type RemarkKind = "common" | "personal" | "show";
interface RemarkResponse { content_html: string | null }
interface RemarkCard {
  kind: RemarkKind;
  title: string;
  description: string;
  html: string;
  editable: boolean;
  loading: boolean;
  failed: boolean;
  retry: () => void;
}

/** Each page is keyed by the show and pinned resource version in the detail page. */
export function ShowResourceRemarks({ showId, resource }: { showId: number; resource: ShowResourceAccessible }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState<RemarkKind | null>(null);
  React.useEffect(() => { setEditing(null); }, [resource.id, resource.version_no]);
  const detail = useQuery({
    queryKey: ["resource", resource.id, "detail"],
    queryFn: async () => (await api<{ resource: Resource }>(`/api/resources/${resource.id}`)).resource,
    staleTime: 30_000,
  });
  // A show pins version_no, whereas the remark APIs expect the version row ID.
  const version = detail.data?.versions?.find((item) => item.version_no === resource.version_no)
    ?? (detail.data?.current?.version_no === resource.version_no ? detail.data.current : null);
  const personal = useQuery({
    queryKey: ["resource", resource.id, "personal-remark", version?.id],
    queryFn: () => api<RemarkResponse>(`/api/resources/${resource.id}/personal-remark`, { params: { version_id: version!.id } }),
    enabled: !!version,
    staleTime: 30_000,
  });
  const showRemark = useQuery({
    queryKey: ["shows", showId, "remarks", resource.id],
    queryFn: () => api<RemarkResponse>(`/api/shows/${showId}/remarks/${resource.id}`),
    staleTime: 30_000,
  });
  const versionUnavailable = detail.isError || (!detail.isPending && !version);
  const cards: RemarkCard[] = [
    {
      kind: "common", title: "通用备注", description: detail.data?.can_manage ? "可维护" : "仅查看",
      html: version?.common_remark_html || "", editable: !!detail.data?.can_manage,
      loading: detail.isPending, failed: versionUnavailable, retry: () => { void detail.refetch(); },
    },
    {
      kind: "personal", title: "个人备注", description: "仅自己可见",
      html: personal.data?.content_html || "", editable: true,
      loading: detail.isPending || (!!version && personal.isPending), failed: versionUnavailable || personal.isError,
      retry: () => { if (!version) void detail.refetch(); else void personal.refetch(); },
    },
    {
      kind: "show", title: "放映备注", description: "仅本次放映使用",
      html: showRemark.data?.content_html || "", editable: true,
      loading: showRemark.isPending, failed: showRemark.isError, retry: () => { void showRemark.refetch(); },
    },
  ];
  const activeCard = cards.find((card) => card.kind === editing);

  const refresh = async (kind: RemarkKind) => {
    if (kind === "common") {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["resource", resource.id] }),
        queryClient.invalidateQueries({ queryKey: ["resource-detail", detail.data?.detail_token] }),
        queryClient.invalidateQueries({ queryKey: ["resources"] }),
      ]);
    } else if (kind === "personal") {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["resource", resource.id, "personal-remark", version?.id] }),
        queryClient.invalidateQueries({ queryKey: ["me", "personal-remarks", "summary"] }),
        queryClient.invalidateQueries({ queryKey: ["resources", "asset"] }),
      ]);
    } else {
      await queryClient.invalidateQueries({ queryKey: ["shows", showId, "remarks", resource.id] });
    }
  };

  return (
    <>
      {cards.map((card) => (
        <button
          key={card.kind}
          type="button"
          aria-label={card.title}
          disabled={card.loading}
          onClick={() => card.failed ? card.retry() : setEditing(card.kind)}
          className="group relative flex min-h-24 w-full flex-col items-start rounded-lg border bg-card p-3 text-left shadow-sm transition hover:border-primary/40 hover:bg-muted/30 disabled:cursor-wait disabled:opacity-60"
        >
          <span className="flex w-full items-center justify-between gap-2">
            <span className="text-sm font-medium">{card.title}</span>
            <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{card.description}</span>
          </span>
          <span className="mt-2 line-clamp-3 w-full pr-7 text-xs leading-5 text-muted-foreground">
            {card.loading ? "正在加载…" : card.failed ? "加载失败，点击重试" : richTextToPlain(card.html) || `暂无${card.title}`}
          </span>
          <ArrowRight className="absolute bottom-3 right-3 h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </button>
      ))}
      {activeCard && (
        <RemarkEditorDialog
          key={activeCard.kind}
          card={activeCard}
          resourceId={resource.id}
          resourceName={resource.name}
          versionId={version?.id}
          versionNo={resource.version_no}
          showId={showId}
          onClose={() => setEditing(null)}
          onSaved={() => refresh(activeCard.kind)}
        />
      )}
    </>
  );
}

function RemarkEditorDialog({ card, resourceId, resourceName, versionId, versionNo, showId, onClose, onSaved }: {
  card: RemarkCard;
  resourceId: number;
  resourceName: string;
  versionId?: number;
  versionNo: number;
  showId: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = React.useState(card.html);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!card.editable || (card.kind !== "show" && !versionId)) throw new Error("当前备注不可编辑，请重新加载页面");
      if (card.kind === "common") {
        return api(`/api/resources/${resourceId}/common-remark`, {
          method: "POST", json: { content_html: draft, apply_scope: "selected", version_id: versionId },
        });
      }
      if (card.kind === "personal") {
        return api(`/api/resources/${resourceId}/personal-remark`, {
          method: "PUT", json: { content_html: draft, version_id: versionId },
        });
      }
      return api(`/api/shows/${showId}/remarks/${resourceId}`, { method: "PUT", json: { content_html: draft } });
    },
    onSuccess: async () => { await onSaved(); toast.success(`${card.title}已保存`); onClose(); },
    onError: (error: Error) => toast.error(error.message || "保存备注失败"),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{card.title}</DialogTitle>
          <DialogDescription>{resourceName} · v{versionNo} · {card.description}</DialogDescription>
        </DialogHeader>
        {card.editable ? (
          <div className="min-h-0 overflow-auto rounded-md border">
            <RichTextEditor bordered={false} value={draft} onChange={setDraft} placeholder={`输入${card.title}…`} minHeight={240} maxHeight={360} disabled={mutation.isPending} />
          </div>
        ) : (
          <div className="min-h-40 overflow-auto rounded-md border p-4">
            {richTextToPlain(card.html) ? <div className="prose prose-sm max-w-none text-sm" dangerouslySetInnerHTML={{ __html: card.html }} /> : <p className="text-sm text-muted-foreground">暂无{card.title}</p>}
          </div>
        )}
        <DialogFooter>
          {!card.editable && <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="h-3.5 w-3.5" />仅素材管理者可编辑</span>}
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>{card.editable ? "取消" : "关闭"}</Button>
          {card.editable && <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || draft === card.html}>{mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}保存</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
