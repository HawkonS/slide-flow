import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";

export type MetadataTagDomain = "subject" | "status";

interface MetadataTag {
  id: number;
  name: string;
  label: string;
  sort_order: number;
}

interface MetadataTagResponse {
  groups: Array<{ category: string; tags: MetadataTag[] }>;
  can_create: boolean;
}

export function useMetadataTagOptions(domain: MetadataTagDomain) {
  const query = useQuery({
    queryKey: ["metadata-tags", domain],
    queryFn: () => api<MetadataTagResponse>(`/api/${domain}-tags`),
    staleTime: 30_000,
  });
  const options = (query.data?.groups ?? []).flatMap((group) =>
    group.tags.map((tag) => ({ value: tag.name, label: tag.label || tag.name })),
  );
  return { ...query, options, canCreate: query.data?.can_create ?? false };
}

function fallbackLabel(domain: MetadataTagDomain, value: string): string {
  void domain;
  return value;
}

export function MetadataTagSelect({
  domain,
  value,
  onChange,
  id,
  disabled,
}: {
  domain: MetadataTagDomain;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const { options, canCreate, isLoading, isError } = useMetadataTagOptions(domain);
  const createValue = "__create_tag__";
  const emptyValue = "__empty_tag__";
  const displayed = value && !options.some((item) => item.value === value)
    ? [{ value, label: fallbackLabel(domain, value) }, ...options]
    : options;
  const emptyText = domain === "subject" ? "请选择主体（可选）" : "请选择状态";
  return (
    <div className="grid gap-1">
      <Select
        value={value || undefined}
        onValueChange={(nextValue) => {
          if (nextValue === createValue) {
            navigate(`/manage/tags?tab=${encodeURIComponent(domain)}`);
            return;
          }
          if (nextValue === emptyValue) {
            onChange("");
            return;
          }
          onChange(nextValue);
        }}
        disabled={disabled || isLoading}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={isLoading ? "正在加载…" : emptyText} />
        </SelectTrigger>
        <SelectContent>
          {domain === "subject" && <SelectItem value={emptyValue}>不设置</SelectItem>}
          {canCreate && (
            <SelectItem value={createValue}>
              <span className="flex items-center gap-1.5"><Plus className="h-3.5 w-3.5" />新建</span>
            </SelectItem>
          )}
          {displayed.map((item) => (
            <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isError && <p className="text-xs text-destructive">标签选项加载失败，请刷新后重试</p>}
    </div>
  );
}
