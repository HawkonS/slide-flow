import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, GitBranch, Loader2 } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { ShowUpgradeDialog } from "@/components/show/ShowUpgradeDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import type { Show } from "@/lib/types";

export function ShowIterationPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab") === "reorganize" ? "reorganize" : "upgrade";
  const showId = Number(id);
  const validId = Number.isInteger(showId) && showId > 0;

  const { data, isLoading, error } = useQuery({
    queryKey: ["show-detail", showId, "iteration"],
    queryFn: () => api<{ show: Show }>(`/api/shows/${showId}`),
    enabled: validId,
    retry: false,
  });
  const show = data?.show ?? null;

  if (!validId) return <IterationError title="放映不存在" onBack={() => navigate("/manage/shows")} />;
  if (isLoading) {
    return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />加载放映详情…</div>;
  }
  if (!show) {
    const status = error instanceof ApiError ? error.status : 0;
    return <IterationError title={status === 403 ? "没有查看权限" : "放映不存在或加载失败"} onBack={() => navigate(-1)} />;
  }

  if (!show.can_manage) {
    return <IterationError title="没有版本迭代权限" onBack={() => navigate(`/shows/${show.id}`)} />;
  }

  return (
    <div className="min-h-full w-full px-1 pb-10 sm:px-2">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 border-b py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" title="返回放映详情" aria-label="返回放映详情" onClick={() => navigate(`/shows/${show.id}`)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">版本迭代</h1>
              <Badge variant="outline" className="text-xs">{show.name} · v{show.version_no}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">创建新版本，升级资源或重新组织放映页面。</p>
          </div>
        </div>
        <GitBranch className="hidden h-5 w-5 shrink-0 text-primary sm:block" />
      </header>

      <main className="mx-auto mt-5 w-full max-w-7xl">
        <ShowUpgradeDialog
          open
          page
          initialTab={initialTab}
          show={show}
          onOpenChange={(open) => {
            if (!open) navigate(`/shows/${show.id}`);
          }}
          onSuccess={(newShow) => navigate(`/shows/${newShow.id}`)}
        />
      </main>
    </div>
  );
}

function IterationError({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 p-6 text-center"><h1 className="text-lg font-semibold">{title}</h1><Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1.5 h-4 w-4" />返回</Button></div>;
}

export default ShowIterationPage;
