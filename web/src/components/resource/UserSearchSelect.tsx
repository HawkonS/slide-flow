import * as React from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import type { UserOption } from "@/lib/types";
import { cn } from "@/lib/utils";

interface UserOptionsResponse {
  users: UserOption[];
}

export function UserSearchSelect({
  value,
  onChange,
  placeholder = "选择用户",
  excludeIds = [],
  disabled,
  triggerClassName,
}: {
  value: number | null;
  onChange: (id: number) => void;
  placeholder?: string;
  excludeIds?: number[];
  disabled?: boolean;
  triggerClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [search, setSearch] = React.useState("");
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearch(input.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [input]);

  const { data, isFetching } = useQuery({
    queryKey: ["users", "options", "single", search, value],
    queryFn: () => api<UserOptionsResponse>("/api/users/options", {
      params: {
        search: search || undefined,
        ids: value ? String(value) : undefined,
        limit: 100,
      },
    }),
    enabled: open || value != null,
    staleTime: 60_000,
  });

  const excluded = React.useMemo(() => new Set(excludeIds), [excludeIds]);
  const users = (data?.users ?? []).filter((user) => !excluded.has(user.id));
  const selected = users.find((user) => user.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("w-full justify-between font-normal", triggerClassName)}
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? `${selected.name || selected.username}（${selected.username}）` : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput value={input} onValueChange={setInput} placeholder="输入姓名或用户名搜索" />
          <CommandList>
            {isFetching && users.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> 加载用户…
              </div>
            ) : (
              <>
                <CommandEmpty>没有匹配的用户</CommandEmpty>
                {users.map((user) => (
                  <CommandItem
                    key={user.id}
                    value={String(user.id)}
                    onSelect={() => {
                      onChange(user.id);
                      setOpen(false);
                    }}
                  >
                    <Check className={cn("h-4 w-4", user.id === value ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{user.name || user.username}</span>
                    <span className="ml-auto truncate text-xs text-muted-foreground">@{user.username}</span>
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
