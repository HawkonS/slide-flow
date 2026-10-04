import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2, RotateCcw, Save } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/PageHeader";

interface ConfigItem {
  value: string;
  label: string;
  group: string;
  hot_reload: boolean;
  type: "str" | "int" | "float" | "bool";
  secret: boolean;
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
  const { data, isFetching, isError, error } = useQuery({
    queryKey: ["admin", "config"],
    queryFn: async () => api<ConfigResponse>("/api/admin/config"),
  });

  // 当前编辑中的值
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [revealed, setRevealed] = React.useState<Record<string, boolean>>({});
  const [secretOriginals, setSecretOriginals] = React.useState<Record<string, string>>({});

  const revealMut = useMutation({
    mutationFn: async (key: string) =>
      api<{ key: string; value: string }>(`/api/admin/config/secret/${encodeURIComponent(key)}`),
    onSuccess: (res) => {
      setSecretOriginals((prev) => ({ ...prev, [res.key]: res.value }));
      setDraft((prev) => ({ ...prev, [res.key]: res.value }));
      setRevealed((prev) => ({ ...prev, [res.key]: true }));
    },
    onError: (err: Error) => toast.error(err.message || "读取敏感配置失败"),
  });

  // 数据加载完成后，将当前值同步到 draft
  React.useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const [key, item] of Object.entries(data.config)) {
      next[key] = item.value;
    }
    setDraft(next);
    setRevealed({});
    setSecretOriginals({});
  }, [data]);

  const dirtyKeys = React.useMemo(() => {
    if (!data) return [] as string[];
    const keys: string[] = [];
    for (const [key, item] of Object.entries(data.config)) {
      const baseline = item.secret && secretOriginals[key] !== undefined
        ? secretOriginals[key]
        : item.value;
      if ((draft[key] ?? "") !== baseline) keys.push(key);
    }
    return keys;
  }, [data, draft, secretOriginals]);

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
      const pendingCount = res.pending_restart.length;
      if (pendingCount) {
        toast.success(`保存成功，${pendingCount} 项配置需重启服务后生效`);
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
    setRevealed({});
    setSecretOriginals({});
  };

  // A cached error can be refetched when the route is mounted again. During
  // that request TanStack Query reports `isError` and `isFetching` together,
  // while `isLoading` is false. Keep the transient request state neutral so
  // the page does not flash the error panel before the response arrives.
  if (!data) {
    if (isError && !isFetching) {
      return (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          加载失败：{(error as Error)?.message || "未知错误"}
        </div>
      );
    }
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
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
    <div className="page-shell">
      <PageHeader
        title="配置管理"
        description="管理系统配置参数，按分类查看和调整各项设置。"
        titleExtra={dirtyKeys.length > 0 ? (
          <span className="page-count bg-primary-weak text-foreground">
            已修改 {dirtyKeys.length} 项
          </span>
        ) : null}
      />

      <Tabs defaultValue={data.groups[0]?.key} className="w-full">
        <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/60 p-1">
          {data.groups.map((g) => (
            <TabsTrigger key={g.key} value={g.key} className="px-3 py-1.5">
              {g.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {data.groups.map((g) => (
          <TabsContent key={g.key} value={g.key} className="mt-6">
            <div className="rounded-lg border bg-card">
              <div className="divide-y divide-border">
                {(groupedKeys[g.key] || []).map((key, index) => {
                  const item = data.config[key];
                  const value = draft[key] ?? "";
                  const valid = isValidValue(value, item.type);
                  const baseline = item.secret && secretOriginals[key] !== undefined
                    ? secretOriginals[key]
                    : item.value;
                  const changed = value !== baseline;
                  return (
                    <div
                      key={key}
                      className={cn(
                        "flex flex-col gap-3 p-5 transition-colors hover:bg-muted/30",
                        index === 0 && "rounded-t-lg",
                        index === (groupedKeys[g.key] || []).length - 1 && "rounded-b-lg"
                      )}
                    >
                      <div className="flex flex-wrap items-start gap-2">
                        <Label className="text-sm font-medium">{item.label}</Label>
                        <div className="flex items-center gap-1.5">
                          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            {key}
                          </code>
                          {item.hot_reload === false && (
                            <Badge
                              variant="outline"
                              className="border-amber-500/40 bg-amber-50 text-[10px] text-amber-700 hover:bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400"
                            >
                              需重启
                            </Badge>
                          )}
                          {changed && (
                            <Badge variant="secondary" className="text-[10px]">
                              已修改
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
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
                            <div className="relative max-w-md">
                              <Input
                                type={item.secret && !revealed[key] ? "password" : "text"}
                                value={item.secret && !revealed[key] ? "********" : value}
                                readOnly={item.secret && !revealed[key]}
                                onChange={(e) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    [key]: e.target.value,
                                  }))
                                }
                                className={cn(
                                  "max-w-md pr-10",
                                  !valid && "border-destructive focus-visible:ring-destructive"
                                )}
                              />
                              {item.secret && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="absolute right-0 top-0 h-10 w-10"
                                  aria-label={revealed[key] ? "隐藏敏感配置" : "显示敏感配置"}
                                  disabled={revealMut.isPending && revealMut.variables === key}
                                  onClick={() => {
                                    if (revealed[key]) {
                                      setRevealed((prev) => ({ ...prev, [key]: false }));
                                    } else {
                                      revealMut.mutate(key);
                                    }
                                  }}
                                >
                                  {revealMut.isPending && revealMut.variables === key ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : revealed[key] ? (
                                    <EyeOff className="h-4 w-4" />
                                  ) : (
                                    <Eye className="h-4 w-4" />
                                  )}
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex items-start gap-3">
                          {item.desc && (
                            <p className="text-xs text-muted-foreground flex-1">
                              {item.desc}
                            </p>
                          )}
                          {!valid && (
                            <p className="text-xs text-destructive shrink-0">
                              值类型不正确，应为 {item.type}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </TabsContent>
        ))}
      </Tabs>

      {/* 底部操作栏 */}
      {dirtyKeys.length > 0 && (
        <div className="sticky bottom-0 z-10 flex items-center justify-between rounded-lg border bg-card/95 px-5 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/60">
          <div className="text-sm text-muted-foreground">
            {invalidKeys.length > 0 ? (
              <span className="text-destructive">
                存在 {invalidKeys.length} 项无效配置
              </span>
            ) : (
              <span>已修改 <span className="font-medium text-foreground">{dirtyKeys.length}</span> 项配置</span>
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
              重置
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
              保存更改
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminConfigPage;
