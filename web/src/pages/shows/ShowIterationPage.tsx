import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { ShowUpgradeDialog } from "@/components/show/ShowUpgradeDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { useDetailReturn } from "@/lib/detail-navigation";
import type { Show } from "@/lib/types";

export function ShowIterationPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const returnToList = useDetailReturn("/manage/shows");
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const initialTab: "upgrade" | "reorganize" | "order" =
    tabParam === "reorganize" || tabParam === "order" ? tabParam : "upgrade";
  const showId = Number(id);
  const validId = Number.isInteger(showId) && showId > 0;

  const { data, isLoading, error } = useQuery({
    queryKey: ["show-detail", showId, "iteration"],
    queryFn: () => api<{ show: Show }>(`/api/shows/${showId}`),
    enabled: validId,
    retry: false,
  });
  const show = data?.show ?? null;

  if (!validId) return <IterationError title="放映不存在" onBack={returnToList} />;
  if (isLoading) {
    return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />加载放映详情…</div>;
  }
  if (!show) {
    const status = error instanceof ApiError ? error.status : 0;
    return <IterationError title={status === 403 ? "没有查看权限" : "放映不存在或加载失败"} onBack={returnToList} />;
  }

  if (!show.can_manage) {
    return <IterationError title="没有版本迭代权限" onBack={() => navigate(`/shows/${show.id}`, { state: location.state })} />;
  }

  return (
    <div className="page-shell">
      <header className="flex min-w-0 flex-wrap items-center gap-2.5">
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" title="返回放映详情" aria-label="返回放映详情" onClick={() => navigate(`/shows/${show.id}`, { state: location.state })}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="page-title">版本迭代</h1>
        <Badge variant="outline" className="text-xs">{show.name} · v{show.version_no}</Badge>
      </header>

      <main className="min-h-0 flex-1">
        <ShowUpgradeDialog
          open
          page
          initialTab={initialTab}
          show={show}
          onOpenChange={(open) => {
            if (!open) navigate(`/shows/${show.id}`, { state: location.state });
          }}
          onSuccess={(newShow) => navigate(`/shows/${newShow.id}`, { state: location.state })}
        />
      </main>
    </div>
  );
}

function IterationError({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 p-6 text-center"><h1 className="text-lg font-semibold">{title}</h1><Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1.5 h-4 w-4" />返回</Button></div>;
}

export default ShowIterationPage;
