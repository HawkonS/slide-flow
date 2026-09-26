import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";

import { ResourceImportWizard } from "@/components/resource/BatchSplitImportDialog";
import { useAuth } from "@/lib/auth";

/** 标准模板系列导入：复用单页素材的上传、字体检测、渲染与确认流程。 */
export function TemplateImportPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const taskIdParam = Number(searchParams.get("task_id"));
  const taskId = Number.isInteger(taskIdParam) && taskIdParam > 0 ? taskIdParam : undefined;

  return (
    <ResourceImportWizard
      target="templates"
      ownerId={user?.id}
      taskId={taskId}
      onSuccess={() => {
        void queryClient.invalidateQueries({ queryKey: ["templates"] });
      }}
      onOpenChange={(open) => {
        if (!open) {
          void queryClient.invalidateQueries({ queryKey: ["templates"] });
          navigate("/templates");
        }
      }}
    />
  );
}

export default TemplateImportPage;
