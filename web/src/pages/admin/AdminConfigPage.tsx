import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { api } from "@/lib/api";

interface ConfigItem {
  value: string;
  label: string;
  group: string;
  hot_reload: boolean;
  type: "str" | "int" | "float" | "bool";
  desc: string;
}

interface ConfigGroup {
  key: string;
  label: string;
}

interface ConfigResponse {
  config: Record<string, ConfigItem>;
  groups: ConfigGroup[];
}

interface UpdateResponse {
  applied: string[];
  pending_restart: string[];
}

function isValidValue(raw: string, type: ConfigItem["type"]): boolean {
  if (type === "str" || type === "bool") return true;
  if (raw.trim() === "") return false;
  if (type === "int") return /^-?\d+$/.test(raw.trim());
  if (type === "float") return !Number.isNaN(Number(raw));
  return true;
}

export function AdminConfigPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin", "config"],
    queryFn: async () => api<ConfigResponse>("/api/admin/config"),
  });

  // 当前编辑中的值
  const [draft, setDraft] = React.useState<Record<string, string>>({});

  // 数据加载完成后，将当前值同步到 draft
  React.useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const [key, item] of Object.entries(data.config)) {
      next[key] = item.value;
    }
    setDraft(next);
  }, [data]);

  const dirtyKeys = React.useMemo(() => {
    if (!data) return [] as string[];
    const keys: string[] = [];
    for (const [key, item] of Object.entries(data.config)) {
      if ((draft[key] ?? "") !== item.value) keys.push(key);
    }
    return keys;
  }, [data, draft]);

  const invalidKeys = React.useMemo(() => {
    if (!data) return [] as string[];
    return dirtyKeys.filter((key) => {
      const meta = data.config[key];
      if (!meta) return false;
      return !isValidValue(draft[key] ?? "", meta.type);
    });
  }, [data, draft, dirtyKeys]);

  const saveMut = useMutation({
    mutationFn: async (items: Record<string, string>) =>
      api<UpdateResponse>("/api/admin/config", {
        method: "PUT",
        json: { items },
      }),
    onSuccess: (res) => {
      const appliedCount = res.applied.length;
      const pendingCount = res.pending_restart.length;
      if (appliedCount && pendingCount) {
        toast.success(
          `保存成功：${appliedCount} 项已即时生效，${pendingCount} 项需重启服务后生效`,
        );
      } else if (appliedCount) {
        toast.success(`保存成功，${appliedCount} 项已即时生效`);
      } else if (pendingCount) {
        toast.success(`保存成功，${pendingCount} 项需重启服务后生效`);
      } else {
        toast.success("保存成功");
      }
      qc.invalidateQueries({ queryKey: ["admin", "config"] });
    },
    onError: (err: Error) => toast.error(err.message || "保存失败"),
  });

  const handleSave = () => {
    if (!data || dirtyKeys.length === 0) return;
    if (invalidKeys.length > 0) {
      toast.error("存在无效的配置值，请检查后再提交");
      return;
    }
    const items: Record<string, string> = {};
    for (const key of dirtyKeys) {
      items[key] = draft[key] ?? "";
    }
    saveMut.mutate(items);
  };

  const handleReset = () => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const [key, item] of Object.entries(data.config)) {
      next[key] = item.value;
    }
    setDraft(next);
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        加载失败：{(error as Error)?.message || "未知错误"}
      </div>
    );
  }

  const groupedKeys: Record<string, string[]> = {};
  for (const g of data.groups) groupedKeys[g.key] = [];
  for (const [key, item] of Object.entries(data.config)) {
    if (!groupedKeys[item.group]) groupedKeys[item.group] = [];
    groupedKeys[item.group].push(key);
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">系统配置</h1>
        <p className="text-sm text-muted-foreground">
          直接读写 <code className="rounded bg-muted px-1.5 py-0.5 text-xs">slide_flow.properties</code>
          。可热加载项保存后立即生效，其余项需重启服务。
        </p>
      </div>

      <Tabs defaultValue={data.groups[0]?.key} className="w-full">
        <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/60 p-1">
          {data.groups.map((g) => (
            <TabsTrigger key={g.key} value={g.key} className="px-3 py-1.5">
              {g.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {data.groups.map((g) => (
          <TabsContent key={g.key} value={g.key} className="mt-4">
            <div className="flex flex-col gap-4">
              {(groupedKeys[g.key] || []).map((key) => {
                const item = data.config[key];
                const value = draft[key] ?? "";
                const valid = isValidValue(value, item.type);
                const changed = value !== item.value;
                return (
                  <div
                    key={key}
                    className="rounded-md border bg-card p-4 shadow-sm"
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Label className="text-sm font-medium">{item.label}</Label>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {key}
                      </code>
                      {item.hot_reload ? (
                        <Badge variant="secondary" className="text-[10px]">
                          可热加载
                        </Badge>
                      ) : (
                        <Badge
                          className="border-amber-500/40 bg-amber-100 text-[10px] text-amber-800 hover:bg-amber-100"
                          variant="outline"
                        >
                          需重启
                        </Badge>
                      )}
                      {changed && (
                        <Badge variant="outline" className="text-[10px]">
                          已修改
                        </Badge>
                      )}
                    </div>
                    <div className="max-w-xl">
                      {item.type === "bool" ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={value === "true" || value === "1"}
                            onCheckedChange={(checked) =>
                              setDraft((prev) => ({
                                ...prev,
                                [key]: checked ? "true" : "false",
                              }))
                            }
                          />
                          <span className="text-sm text-muted-foreground">
                            {value === "true" || value === "1" ? "已启用" : "已关闭"}
                          </span>
                        </div>
                      ) : (
                        <Input
                          type={item.type === "int" || item.type === "float" ? "text" : "text"}
                          value={value}
                          onChange={(e) =>
                            setDraft((prev) => ({
                              ...prev,
                              [key]: e.target.value,
                            }))
                          }
                          className={!valid ? "border-destructive" : undefined}
                        />
                      )}
                    </div>
                    {item.desc && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        {item.desc}
                      </div>
                    )}
                    {!valid && (
                      <div className="mt-1 text-xs text-destructive">
                        值类型不正确，应为 {item.type}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </TabsContent>
        ))}
      </Tabs>

      <div className="sticky bottom-0 z-10 flex items-center justify-between rounded-md border bg-card/95 px-4 py-3 shadow-sm backdrop-blur">
        <div className="text-sm text-muted-foreground">
          {dirtyKeys.length > 0 ? (
            <>
              已修改 <span className="font-medium text-foreground">{dirtyKeys.length}</span> 项
              {invalidKeys.length > 0 && (
                <span className="ml-2 text-destructive">
                  其中 {invalidKeys.length} 项无效
                </span>
              )}
            </>
          ) : (
            "尚未修改任何配置"
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={dirtyKeys.length === 0 || saveMut.isPending}
          >
            <RotateCcw className="mr-1.5 h-4 w-4" />
            重置为当前值
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={
              dirtyKeys.length === 0 ||
              invalidKeys.length > 0 ||
              saveMut.isPending
            }
          >
            {saveMut.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-4 w-4" />
            )}
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}

export default AdminConfigPage;
