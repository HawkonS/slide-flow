import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ResourceImportWizard } from "@/components/resource/BatchSplitImportDialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { forgetPendingImport, readPendingImport } from "@/lib/resourceImportLifecycle";

/** 单页素材统一导入页面：关闭后返回资源列表。 */
export function ResourceImportPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const taskIdParam = Number(searchParams.get("task_id"));
  const taskId = Number.isInteger(taskIdParam) && taskIdParam > 0 ? taskIdParam : undefined;
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [pending, setPending] = React.useState(() => readPendingImport(user?.id));
  const [checking, setChecking] = React.useState(false);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [recovered, setRecovered] = React.useState(false);
  const requestRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    if (user?.id === undefined || recovered) return;
    setPending(readPendingImport(user.id));
  }, [recovered, user?.id]);
  React.useEffect(() => () => { requestRef.current?.abort(); requestRef.current = null; }, []);
  const checkReceipt = async () => {
    if (!pending || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    setChecking(true);
    try {
      const result = await api<{ status: string; created?: number }>(`/api/resource-import/${encodeURIComponent(pending.sessionId)}/result`, { signal: controller.signal, cache: "no-store" });
      if (controller.signal.aborted) return;
      if (result.status === "completed" && Number.isInteger(result.created) && result.created === pending.slideCount) {
        forgetPendingImport(user?.id, pending.sessionId);
        setRecovered(true);
        setMessage(`已确认上次上传成功，共保存 ${result.created} 个单页素材，无需重复上传。`);
        void queryClient.invalidateQueries({ queryKey: ["resources"] });
      } else {
        setMessage("服务器尚未返回完整保存回执，请稍后再次核对。不要直接重新上传同一批素材。");
      }
    } catch {
      if (requestRef.current === controller) setMessage(timedOut ? "保存结果查询超时，请稍后重试；不要重新提交同一批素材。" : "暂时无法取得保存回执；会话过期或网络失败不等于未保存，请先到素材库核对。");
    } finally {
      clearTimeout(timeout);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setChecking(false);
      }
    }
  };
  if (pending && !taskId) return <section className="mx-auto grid w-full max-w-2xl gap-4 p-6">
    <h1 className="text-xl font-semibold">核对上次导入结果</h1>
    <p className="text-sm text-muted-foreground">浏览器记录了一次已发起的 {pending.slideCount} 页保存请求。为避免断网或刷新后重复创建素材，请先查询服务器回执；此页面不会重新提交保存。</p>
    {message && <p role="status" className="rounded-md border p-3 text-sm">{message}</p>}
    <div className="flex flex-wrap gap-2">
      {!recovered && <Button onClick={checkReceipt} disabled={checking}>{checking ? "正在核对…" : "查询上次保存结果"}</Button>}
      <Button variant="outline" onClick={() => navigate("/resources")}>返回素材库核对</Button>
    </div>
    {!recovered && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={checking} onChange={(event) => setAcknowledged(event.target.checked)} />我已人工核对素材库，确认可以清除这条恢复提醒并开始其他导入</label>}
    <Button className="justify-self-start" variant="ghost" disabled={checking || (!recovered && !acknowledged)} onClick={() => { forgetPendingImport(user?.id, pending.sessionId); setPending(null); }}>开始新的导入</Button>
  </section>;
  return (
    <ResourceImportWizard
      ownerId={user?.id}
      taskId={taskId}
      onSuccess={() => { void queryClient.invalidateQueries({ queryKey: ["resources"] }); }}
      onOpenChange={(open) => {
        if (!open) {
          queryClient.invalidateQueries({ queryKey: ["resources"] });
          navigate("/resources");
        }
      }}
    />
  );
}

export default ResourceImportPage;
