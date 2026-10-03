import * as React from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { DefaultScene, TagDomain } from "@/lib/tag-defaults";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface Definition { id: number; name: string; label: string }
interface Scene { id: DefaultScene; label: string; kind: "query" | "create"; domains: TagDomain[] }
type Slots = Partial<Record<TagDomain, number[]>>;
interface DefaultsResponse { scenes: Scene[]; defaults: Record<DefaultScene, Slots> }
export interface DefaultTagTarget { id: number; name: string; domain: TagDomain }
const DOMAINS: TagDomain[] = ["subject", "status", "resource", "user"];
const LABELS: Record<TagDomain, string> = { subject: "主体", status: "状态", resource: "分类标签", user: "用户标签" };

export function TagDefaultsDialog({ onClose, tag }: { onClose: () => void; tag?: DefaultTagTarget }) {
  const defaults = useQuery({ queryKey: ["admin", "tag-defaults"], queryFn: () => api<DefaultsResponse>("/api/admin/tag-defaults") });
  const definitions = useQueries({ queries: DOMAINS.map((domain) => ({
    queryKey: ["admin", `${domain}-tags`],
    queryFn: () => api<{ tags: Definition[] }>(domain === "resource" ? "/api/admin/tags" : `/api/admin/${domain}-tags`),
  })) });
  const error = defaults.error || definitions.find((query) => query.error)?.error;
  const ready = defaults.data && definitions.every((query) => query.data);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col overflow-hidden">
      <DialogHeader className="shrink-0">
        <DialogTitle>{tag ? `默认设置 · ${tag.name}` : "默认设置"}</DialogTitle>
        <DialogDescription>由管理员统一设置，作为所有用户的初始值。查询筛选与新建填写分别配置，已保存的内容不受影响。</DialogDescription>
      </DialogHeader>
      {error ? <div role="alert" className="text-sm text-destructive">加载失败：{error.message}<Button variant="ghost" onClick={() => { void defaults.refetch(); definitions.forEach((query) => void query.refetch()); }}>重试</Button></div>
        : ready ? <DefaultsEditor initial={defaults.data!} definitions={Object.fromEntries(DOMAINS.map((domain, index) => [domain, definitions[index].data!.tags])) as Record<TagDomain, Definition[]>} tag={tag} onClose={onClose} />
          : <p className="py-8 text-center text-sm text-muted-foreground">正在加载默认设置…</p>}
    </DialogContent>
  </Dialog>;
}

function MultiTags({ value, items, onChange, label }: { value: number[]; items: Definition[]; onChange: (ids: number[]) => void; label: string }) {
  const [query, setQuery] = React.useState("");
  const names = items.filter((item) => value.includes(item.id)).map((item) => item.name);
  return <Popover><PopoverTrigger asChild><Button variant="outline" className="h-auto min-h-9 w-full justify-start whitespace-normal text-left text-xs" aria-label={label}>
    {names.length ? names.join("、") : "未设置"}
  </Button></PopoverTrigger><PopoverContent className="w-72" align="start">
    <input className="mb-2 h-8 w-full rounded border px-2 text-sm" aria-label={`搜索${label}`} placeholder="搜索标签" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="max-h-52 space-y-1 overflow-y-auto">{items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())).map((item) => <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted">
      <Checkbox checked={value.includes(item.id)} onCheckedChange={(checked) => onChange(checked ? [...value, item.id] : value.filter((id) => id !== item.id))} />{item.name}
    </label>)}</div>
    <Button variant="ghost" size="sm" onClick={() => onChange([])}>清空</Button>
  </PopoverContent></Popover>;
}

function DefaultsEditor({ initial, definitions, tag, onClose }: { initial: DefaultsResponse; definitions: Record<TagDomain, Definition[]>; tag?: DefaultTagTarget; onClose: () => void }) {
  // Freeze the edit baseline. Background refetches must not overwrite edits.
  const [original] = React.useState(initial);
  const [draft, setDraft] = React.useState(initial.defaults);
  const client = useQueryClient();
  const setSlot = (scene: DefaultScene, domain: TagDomain, ids: number[]) => setDraft((prev) => ({ ...prev, [scene]: { ...prev[scene], [domain]: ids } }));
  const summary = (scene: DefaultScene, domain: TagDomain) => {
    const ids = draft[scene][domain] ?? [];
    return definitions[domain].filter((item) => ids.includes(item.id)).map((item) => item.name).join("、") || "未设置";
  };
  const changes = original.scenes.flatMap((scene) => scene.domains.flatMap((domain) => {
    const before = original.defaults[scene.id][domain] ?? [];
    const after = draft[scene.id][domain] ?? [];
    return before.length === after.length && before.every((id) => after.includes(id)) ? [] : [{ scene: scene.id, domain, tag_ids: after }];
  }));
  const save = useMutation({
    mutationFn: () => api<DefaultsResponse>("/api/admin/tag-defaults", { method: "PATCH", json: { changes } }),
    onSuccess: (result) => {
      client.setQueryData(["admin", "tag-defaults"], result);
      DOMAINS.forEach((domain) => void client.invalidateQueries({ queryKey: ["admin", `${domain}-tags`] }));
      void client.invalidateQueries({ queryKey: ["config"] });
      toast.success("默认设置已保存");
      onClose();
    },
    onError: (error: Error) => toast.error(error.message || "保存默认设置失败"),
  });
  return <>
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
    <fieldset disabled={save.isPending} className="min-w-0 space-y-5">
      {(["query", "create"] as const).map((kind) => {
        const scenes = original.scenes.filter((scene) => scene.kind === kind && (!tag || scene.domains.includes(tag.domain)));
        if (!scenes.length) return null;
        return <section key={kind} className="space-y-2"><h3 className="text-sm font-semibold">{kind === "query" ? "查询默认筛选" : "新建默认填写"}</h3>
          {scenes.map((scene) => {
            const selected = tag ? (draft[scene.id][tag.domain] ?? []).includes(tag.id) : false;
            const replaced = tag && (tag.domain === "subject" || tag.domain === "status") && selected
              ? definitions[tag.domain].filter((item) => item.id !== tag.id && original.defaults[scene.id][tag.domain]?.includes(item.id)) : [];
            return <div key={scene.id} className="space-y-2 rounded-lg border p-3">
              {tag ? <>
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Checkbox checked={selected} disabled={save.isPending} onCheckedChange={(checked) => {
                  const previous = draft[scene.id][tag.domain] ?? [];
                  setSlot(scene.id, tag.domain, checked ? (tag.domain === "subject" || tag.domain === "status" ? [tag.id] : [...previous, tag.id]) : previous.filter((id) => id !== tag.id));
                }} />{scene.label}</label>
                <p className="text-xs text-muted-foreground">{LABELS[tag.domain]}：{summary(scene.id, tag.domain)}</p>
                {replaced.length > 0 && <p role="status" className="text-xs text-amber-700">保存后将替换「{replaced[0].name}」</p>}
              </> : <>
                <div className="flex items-center justify-between"><h4 className="text-sm font-medium">{scene.label}</h4><Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => setDraft((prev) => ({ ...prev, [scene.id]: Object.fromEntries(scene.domains.map((domain) => [domain, []])) }))}>清空此场景</Button></div>
                <div className="grid gap-3 sm:grid-cols-3">{scene.domains.map((domain) => <div key={domain} className={domain === "user" ? "sm:col-span-3" : ""}>
                  <label className="mb-1 block text-xs text-muted-foreground" htmlFor={`${scene.id}-${domain}`}>{LABELS[domain]}</label>
                  {domain === "subject" || domain === "status" ? <select id={`${scene.id}-${domain}`} aria-label={`${scene.label} ${LABELS[domain]}`} className="h-9 w-full rounded border bg-background px-2 text-sm" disabled={save.isPending} value={draft[scene.id][domain]?.[0] ?? ""} onChange={(event) => setSlot(scene.id, domain, event.target.value ? [Number(event.target.value)] : [])}>
                    <option value="">未设置</option>{definitions[domain].map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select> : <MultiTags label={`${scene.label} ${LABELS[domain]}`} value={draft[scene.id][domain] ?? []} items={definitions[domain]} onChange={(ids) => setSlot(scene.id, domain, ids)} />}
                </div>)}</div>
              </>}
              {scene.id === "resource_picker" && <p className="text-xs text-muted-foreground">新建、编辑和版本迭代共用此设置。</p>}
            </div>;
          })}
        </section>;
      })}
    </fieldset>
    </div>
    <DialogFooter className="shrink-0 border-t bg-background pt-3"><Button variant="outline" disabled={save.isPending} onClick={onClose}>取消</Button><Button disabled={!changes.length || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "正在保存…" : "保存默认设置"}</Button></DialogFooter>
  </>;
}
