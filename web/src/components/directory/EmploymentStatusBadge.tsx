import { Badge } from "@/components/ui/badge";
import type { EmploymentStatus } from "@/lib/types";

const LABELS: Record<EmploymentStatus, string> = {
  active: "在职",
  resigned: "离职",
  frozen: "冻结",
  unknown: "未知",
};

const VARIANTS: Record<EmploymentStatus, "success" | "secondary" | "warning" | "destructive"> = {
  active: "success",
  resigned: "secondary",
  frozen: "warning",
  unknown: "destructive",
};

export function EmploymentStatusBadge({ status }: { status?: EmploymentStatus | string | null }) {
  const key = (status || "active") as EmploymentStatus;
  const label = LABELS[key] || LABELS.unknown;
  return (
    <Badge variant={VARIANTS[key] || "secondary"} className="whitespace-nowrap">
      <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
