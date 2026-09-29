import * as React from "react";

import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  count?: string;
  titleExtra?: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

/** Shared page heading keeps title, count and actions aligned across modules. */
export function PageHeader({ title, count, titleExtra, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("page-header", className)}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="page-title">{title}</h1>
          {titleExtra}
          {count ? <span className="page-count">{count}</span> : null}
        </div>
        {description ? <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
