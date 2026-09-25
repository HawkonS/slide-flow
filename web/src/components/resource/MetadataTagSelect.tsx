import { useQuery } from "@tanstack/react-query";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { RESOURCE_STATUS_LABEL, RESOURCE_SECRECY_LABEL } from "@/lib/constants";

export type MetadataTagDomain = "subject" | "secrecy" | "status";

interface MetadataTag {
  id: number;
  name: string;
  label: string;
  sort_order: number;
}

interface MetadataTagResponse {
  groups: Array<{ category: string; tags: MetadataTag[] }>;
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
  return { ...query, options };
}

function fallbackLabel(domain: MetadataTagDomain, value: string): string {
  if (domain === "secrecy") return RESOURCE_SECRECY_LABEL[value] || value;
  if (domain === "status") return RESOURCE_STATUS_LABEL[value] || value;
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
  const { options, isLoading, isError } = useMetadataTagOptions(domain);
  const displayed = value && !options.some((item) => item.value === value)
    ? [{ value, label: fallbackLabel(domain, value) }, ...options]
    : options;
  const emptyText = domain === "subject"
    ? "请先到标签管理维护主体标签"
    : `暂无可用${domain === "secrecy" ? "密级" : "状态"}标签`;

  return (
    <div className="grid gap-1">
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled || isLoading || displayed.length === 0}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={isLoading ? "正在加载…" : emptyText} />
        </SelectTrigger>
        <SelectContent>
          {displayed.map((item) => (
            <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isError && <p className="text-xs text-destructive">标签选项加载失败，请刷新后重试</p>}
      {!isLoading && !isError && displayed.length === 0 && (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      )}
    </div>
  );
}
