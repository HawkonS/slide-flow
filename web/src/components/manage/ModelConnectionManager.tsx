import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Pencil, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";

interface ModelConnection {
  id: number;
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  api_key_set: boolean;
  is_default: boolean;
  updated_at: string;
}

interface ModelOption { id: string; owned_by?: string }

interface FormState {
  id: number | null;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  is_default: boolean;
}

const EMPTY: FormState = { id: null, name: "", base_url: "https://api.openai.com/v1", api_key: "", model: "", is_default: false };

export function ModelConnectionManager() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "model-connections"],
    queryFn: () => api<{ connections: ModelConnection[] }>("/api/admin/model-connections"),
  });
  const [form, setForm] = React.useState<FormState>(EMPTY);
  const [models, setModels] = React.useState<ModelOption[]>([]);

  const saveMut = useMutation({
    mutationFn: () => form.id
      ? api(`/api/admin/model-connections/${form.id}`, { method: "PATCH", json: { name: form.name, base_url: form.base_url, api_key: form.api_key, model: form.model, is_default: form.is_default } })
      : api("/api/admin/model-connections", { method: "POST", json: { name: form.name, base_url: form.base_url, api_key: form.api_key, model: form.model, is_default: form.is_default } }),
    onSuccess: () => { toast.success("模型连接已保存"); setForm(EMPTY); setModels([]); void qc.invalidateQueries({ queryKey: ["admin", "model-connections"] }); },
    onError: (error: Error) => toast.error(error.message || "保存模型连接失败"),
  });
  const modelsMut = useMutation({
    mutationFn: (request: { connectionId?: number; baseUrl?: string; apiKey?: string }) => request.connectionId
      ? api<{ models: ModelOption[] }>(`/api/admin/model-connections/${request.connectionId}/models`, { method: "POST" })
      : api<{ models: ModelOption[] }>("/api/admin/model-connections/preview-models", {
        method: "POST",
        json: { base_url: request.baseUrl, api_key: request.apiKey },
      }),
    onSuccess: (result) => { setModels(result.models); toast.success(`已获取 ${result.models.length} 个模型`); },
    onError: (error: Error) => toast.error(error.message || "获取模型失败"),
  });
  const testMut = useMutation({
    mutationFn: (connectionId: number) => api<{ model_count: number; model_available: boolean }>(`/api/admin/model-connections/${connectionId}/test`, { method: "POST" }),
    onSuccess: (result) => toast.success(result.model_available ? `连接正常，发现 ${result.model_count} 个模型` : "连接正常，但当前模型不在模型列表中"),
    onError: (error: Error) => toast.error(error.message || "连接测试失败"),
  });
  const deleteMut = useMutation({
    mutationFn: (connectionId: number) => api(`/api/admin/model-connections/${connectionId}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("模型连接已删除"); void qc.invalidateQueries({ queryKey: ["admin", "model-connections"] }); },
    onError: (error: Error) => toast.error(error.message || "删除模型连接失败"),
  });

  const startEdit = (connection: ModelConnection) => {
    setForm({ id: connection.id, name: connection.name, base_url: connection.base_url, api_key: "", model: connection.model, is_default: connection.is_default });
    setModels([]);
  };
  const cancelEdit = () => { setForm(EMPTY); setModels([]); };
  const fetchModels = () => {
    if (form.id && !form.api_key.trim()) {
      modelsMut.mutate({ connectionId: form.id });
      return;
    }
    if (!form.base_url.trim() || !form.api_key.trim()) {
      toast.error("获取新连接模型时需要填写地址和 API Key");
      return;
    }
    modelsMut.mutate({ baseUrl: form.base_url, apiKey: form.api_key });
  };

  return (
    <section className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="text-base font-semibold">模型连接管理</h2>
          <p className="mt-1 text-xs text-muted-foreground">配置 OpenAI 兼容地址、API Key 和视觉模型。API Key 仅保存在服务端。</p>
        </div>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setForm(EMPTY)}><Plus className="h-4 w-4" />新增连接</Button>
      </div>
      <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-2">
          {isLoading ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div> : (data?.connections ?? []).length === 0 ? (
            <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">暂无模型连接</div>
          ) : (data?.connections ?? []).map((connection) => (
            <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{connection.name}</span>{connection.is_default && <Badge variant="secondary">默认</Badge>}</div>
                <p className="mt-1 truncate text-xs text-muted-foreground" title={connection.base_url}>{connection.base_url} · {connection.model || "未选择模型"}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">API Key：{connection.api_key_set ? "已配置" : "未配置"}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button type="button" variant="ghost" size="icon" title="测试连接" aria-label="测试连接" disabled={testMut.isPending} onClick={() => testMut.mutate(connection.id)}><CheckCircle2 className="h-4 w-4" /></Button>
                <Button type="button" variant="ghost" size="icon" title="获取模型" aria-label="获取模型" disabled={modelsMut.isPending} onClick={() => { startEdit(connection); modelsMut.mutate({ connectionId: connection.id }); }}><RefreshCw className="h-4 w-4" /></Button>
                <Button type="button" variant="ghost" size="icon" title="编辑连接" aria-label="编辑连接" onClick={() => startEdit(connection)}><Pencil className="h-4 w-4" /></Button>
                <Button type="button" variant="ghost" size="icon" title="删除连接" aria-label="删除连接" disabled={deleteMut.isPending} onClick={() => deleteMut.mutate(connection.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
              </div>
            </div>
          ))}
        </div>
        <div className="rounded-md border bg-muted/20 p-4">
          <div className="mb-4 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{form.id ? "编辑连接" : "新增连接"}</h3>{form.id && <Button type="button" variant="ghost" size="icon" className="h-7 w-7" title="取消编辑" aria-label="取消编辑" onClick={cancelEdit}><X className="h-4 w-4" /></Button>}</div>
          <div className="space-y-3">
            <div><Label htmlFor="model-connection-name">连接名称</Label><Input id="model-connection-name" className="mt-1.5" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：公司视觉模型" /></div>
            <div><Label htmlFor="model-connection-url">OpenAI 兼容地址</Label><Input id="model-connection-url" className="mt-1.5" value={form.base_url} onChange={(event) => setForm((current) => ({ ...current, base_url: event.target.value }))} placeholder="https://api.openai.com/v1" /></div>
            <div><Label htmlFor="model-connection-key">API Key {form.id && <span className="font-normal text-muted-foreground">（留空保持不变）</span>}</Label><Input id="model-connection-key" type="password" className="mt-1.5" value={form.api_key} onChange={(event) => setForm((current) => ({ ...current, api_key: event.target.value }))} placeholder="sk-…" autoComplete="off" /></div>
            <div><Label htmlFor="model-connection-model">模型</Label><div className="mt-1.5 flex gap-2"><Select value={form.model || undefined} onValueChange={(value) => setForm((current) => ({ ...current, model: value }))}><SelectTrigger id="model-connection-model" className="min-w-0 flex-1"><SelectValue placeholder="先获取模型" /></SelectTrigger><SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.id}</SelectItem>)}</SelectContent></Select><Button type="button" variant="outline" size="icon" title="获取模型" aria-label="获取模型" disabled={modelsMut.isPending || !form.base_url.trim() || (!form.id && !form.api_key.trim())} onClick={fetchModels}>{modelsMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}</Button></div></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_default} onChange={(event) => setForm((current) => ({ ...current, is_default: event.target.checked }))} />设为默认连接</label>
            <Button type="button" className="w-full gap-1.5" disabled={saveMut.isPending || !form.name.trim() || !form.base_url.trim() || (!form.id && !form.api_key.trim())} onClick={() => saveMut.mutate()}>{saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存连接</Button>
          </div>
        </div>
      </div>
    </section>
  );
}
