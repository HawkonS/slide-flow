import * as React from "react";
import { ArrowRight, Layers, Pin } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { Resource, Show } from "@/lib/types";

interface HomePinnedProps {
  shows: Show[];
  resources: Resource[];
  loading: boolean;
  error: boolean;
  onOpenShow: (show: Show) => void;
  onOpenResource: (resource: Resource) => void;
}

type PinType = "shows" | "resources";

function pinPreview(show: Show): string | null {
  const item = show.resources.find((resource) => resource.accessible);
  return item && item.accessible ? item.preview_url : null;
}

function PinnedThumb({
  src,
  name,
  onClick,
}: {
  src: string | null;
  name: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="group relative block h-14 w-24 shrink-0 overflow-hidden rounded-md bg-muted text-left">
      {src ? (
        <img src={src} alt={name} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-muted-foreground"><Layers className="h-4 w-4" /></span>
      )}
      <span className="absolute inset-x-0 bottom-0 truncate bg-slate-950/70 px-1.5 py-1 text-[8px] text-white opacity-0 transition-opacity group-hover:opacity-100">
        {name}
      </span>
    </button>
  );
}

function PinAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
      <span className="text-[9px] text-muted-foreground">{label}</span>
      <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground hover:text-foreground">
        更多<ArrowRight className="h-3 w-3" />
      </button>
    </div>
  );
}

export function HomePinned({ shows, resources, loading, error, onOpenShow, onOpenResource }: HomePinnedProps) {
  const [pinType, setPinType] = React.useState<PinType | null>(null);
  const allShows = shows;
  const allResources = resources;
  const total = allShows.length + allResources.length;
  const modalItems = pinType === "shows" ? allShows : allResources;

  return (
    <>
      <article className="flex min-h-0 flex-col rounded-xl border bg-card shadow-sm">
        <div className="flex h-[50px] shrink-0 items-center justify-between gap-3 border-b px-5">
          <h2 className="text-sm font-semibold tracking-tight">我的置顶</h2>
          <span className="text-[10px] text-muted-foreground">共 {total} 项</span>
        </div>

        {loading ? (
          <div className="flex min-h-[120px] items-center justify-center text-sm text-muted-foreground">加载中…</div>
        ) : error ? (
          <div className="flex min-h-[120px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Pin className="h-4 w-4" />
            暂时无法加载置顶内容
          </div>
        ) : total === 0 ? (
          <div className="flex min-h-[120px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Pin className="h-4 w-4" />
            还没有置顶内容
          </div>
        ) : (
          <div className="divide-y">
            <div className="flex items-center gap-3 px-5 py-2">
              <div className="flex min-w-0 flex-1 gap-2 overflow-hidden">
                {allShows.slice(0, 5).map((show) => (
                  <PinnedThumb key={show.id} src={pinPreview(show)} name={show.name} onClick={() => onOpenShow(show)} />
                ))}
                {allShows.length === 0 && <span className="text-[10px] text-muted-foreground">暂无置顶放映</span>}
              </div>
              <PinAction label="放映素材" onClick={() => setPinType("shows")} />
            </div>
            <div className="flex items-center gap-3 px-5 py-2">
              <div className="flex min-w-0 flex-1 gap-2 overflow-hidden">
                {allResources.slice(0, 5).map((resource) => (
                  <PinnedThumb key={resource.id} src={resource.current.preview_url} name={resource.name} onClick={() => onOpenResource(resource)} />
                ))}
                {allResources.length === 0 && <span className="text-[10px] text-muted-foreground">暂无置顶单页素材</span>}
              </div>
              <PinAction label="单页素材" onClick={() => setPinType("resources")} />
            </div>
          </div>
        )}
      </article>

      <Dialog open={pinType !== null} onOpenChange={(open) => { if (!open) setPinType(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{pinType === "shows" ? "全部置顶放映" : "全部置顶单页素材"}</DialogTitle>
            <DialogDescription>共 {modalItems.length} 项，点击即可打开。</DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[60vh] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {pinType === "shows" && allShows.map((show) => (
              <div key={show.id} role="button" tabIndex={0} className="flex cursor-pointer items-center gap-3 rounded-lg border p-2 text-left hover:bg-muted/40" onClick={() => { onOpenShow(show); setPinType(null); }}>
                <PinnedThumb src={pinPreview(show)} name={show.name} onClick={() => { onOpenShow(show); setPinType(null); }} />
                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{show.name}</span><span className="mt-1 block text-[10px] text-muted-foreground">v{show.version_no} · {show.all_resource_ids?.length || show.resources.length} 页</span></span>
              </div>
            ))}
            {pinType === "resources" && allResources.map((resource) => (
              <div key={resource.id} role="button" tabIndex={0} className="flex cursor-pointer items-center gap-3 rounded-lg border p-2 text-left hover:bg-muted/40" onClick={() => { onOpenResource(resource); setPinType(null); }}>
                <PinnedThumb src={resource.current.preview_url} name={resource.name} onClick={() => { onOpenResource(resource); setPinType(null); }} />
                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{resource.name}</span><span className="mt-1 block text-[10px] text-muted-foreground">v{resource.current_version}{resource.subject ? ` · ${resource.subject}` : ""}</span></span>
              </div>
            ))}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setPinType(null)}>关闭</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
