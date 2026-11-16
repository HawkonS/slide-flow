import * as React from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  Check,
  CheckCircle2,
  Loader2,
  OctagonX,
  RefreshCw,
  Undo2,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  SheetContent,
  SheetDescription,
  SheetRoot,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAuth } from "@/lib/auth";
import {
  fetchNotifications,
  fetchUnreadNotificationCount,
  formatNotificationTime,
  formatNotificationTitle,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
  sortNotifications,
  type NotificationItem,
} from "@/lib/notifications";
import { usePwaStatus } from "@/lib/pwa";
import { cn } from "@/lib/utils";
import { useLocalNotifications } from "@/stores/local-notifications";

const NOTIFICATIONS_KEY = ["notifications"] as const;
const PAGE_SIZE = 20;

function notificationVisual(item: NotificationItem): { icon: React.ReactNode; tone: string } {
  if (item.kind === "pwa_update") {
    return { icon: <RefreshCw className="h-4 w-4" />, tone: "text-warning" };
  }
  if (item.status === "completed") {
    return { icon: <CheckCircle2 className="h-4 w-4" />, tone: "text-success" };
  }
  if (item.status === "failed") {
    return { icon: <XCircle className="h-4 w-4" />, tone: "text-destructive" };
  }
  return { icon: <OctagonX className="h-4 w-4" />, tone: "text-muted-foreground" };
}

function NotificationRow({
  item,
  onOpen,
  onToggleRead,
  busy,
}: {
  item: NotificationItem;
  onOpen: (item: NotificationItem) => void;
  onToggleRead: (item: NotificationItem) => void;
  busy: boolean;
}) {
  const visual = notificationVisual(item);
  const actionLabel = item.read_at ? `标为未读：${item.title}` : `标为已读：${item.title}`;
  return (
    <div className={cn("group flex items-stretch transition-colors hover:bg-accent/60", !item.read_at && "bg-primary-weak/40")}>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="flex min-w-0 flex-1 items-start gap-3 py-3 pl-4 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-background/80", visual.tone)}>
          {visual.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-sm", item.read_at ? "text-foreground/80" : "font-medium text-foreground")}>
              {item.title}
            </span>
            {!item.read_at && (
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive">
                <span className="sr-only">未读</span>
              </span>
            )}
          </span>
          {item.body && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.body}</span>}
          <span className="mt-1 block text-[10px] text-muted-foreground" title={formatNotificationTitle(item.created_at)}>
            {formatNotificationTime(item.created_at)}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-start pr-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground/70 hover:text-foreground"
          aria-label={actionLabel}
          title={actionLabel}
          disabled={busy}
          onClick={() => onToggleRead(item)}
        >
          {item.read_at ? <Undo2 className="h-4 w-4" /> : <Check className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2 px-4 py-3" role="status" aria-label="正在加载通知">
      {[0, 1, 2].map((index) => (
        <div key={index} className="h-12 animate-pulse rounded-md bg-muted/60" />
      ))}
    </div>
  );
}

function ErrorRow({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground">
      <span role="alert">通知加载失败，请重试。</span>
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onRetry}>重试</Button>
    </div>
  );
}

interface NotificationSectionProps {
  title: string;
  count?: number;
  items: NotificationItem[];
  emptyText: string;
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  fetchingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  onOpenItem: (item: NotificationItem) => void;
  onToggleRead: (item: NotificationItem) => void;
  actionBusy: boolean;
}

function NotificationSection({
  title,
  count,
  items,
  emptyText,
  loading,
  error,
  hasMore,
  fetchingMore,
  onLoadMore,
  onRetry,
  onOpenItem,
  onToggleRead,
  actionBusy,
}: NotificationSectionProps) {
  return (
    <section aria-label={`${title}通知`} className="border-b border-border/70 last:border-b-0">
      <h2 className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-border/70 bg-background/95 px-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
        {title}
        {typeof count === "number" && <span className="font-normal tabular-nums">{count}</span>}
      </h2>
      {loading && items.length === 0 ? (
        <LoadingRows />
      ) : (
        <>
          {error && <ErrorRow onRetry={onRetry} />}
          {items.length > 0 ? (
            <div className="divide-y divide-border/60">
              {items.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  onOpen={onOpenItem}
                  onToggleRead={onToggleRead}
                  busy={actionBusy}
                />
              ))}
            </div>
          ) : !error ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">{emptyText}</p>
          ) : null}
        </>
      )}
      {hasMore && !loading && !error && (
        <div className="flex justify-center py-2">
          <Button variant="ghost" size="sm" className="h-8 px-3 text-xs" disabled={fetchingMore} onClick={onLoadMore}>
            {fetchingMore && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            加载更多
          </Button>
        </div>
      )}
    </section>
  );
}

export function NotificationCenter() {
  const { user, offline } = useAuth();
  const pwaStatus = usePwaStatus();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const localItems = useLocalNotifications((state) => state.items);
  const recordPwaUpdate = useLocalNotifications((state) => state.recordPwaUpdate);
  const markLocalRead = useLocalNotifications((state) => state.markRead);
  const markLocalUnread = useLocalNotifications((state) => state.markUnread);
  const markAllLocalRead = useLocalNotifications((state) => state.markAllRead);
  const settleLocalPwaUpdates = useLocalNotifications((state) => state.settlePwaUpdates);

  const enabled = !!user && !offline && !user.must_change_pwd;

  React.useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  React.useEffect(() => {
    if (!enabled || !user) return;
    if (pwaStatus.status === "update-available" && pwaStatus.updateVersion) {
      recordPwaUpdate(user.id, pwaStatus.updateVersion);
    }
  }, [enabled, pwaStatus.status, pwaStatus.updateVersion, recordPwaUpdate, user]);

  React.useEffect(() => {
    if (!enabled || !user) return;
    // No update is waiting any more: keep the old notice as history, but stop
    // claiming that a new version is still available. Read state is untouched.
    if (pwaStatus.status === "deployed") settleLocalPwaUpdates(user.id);
  }, [enabled, pwaStatus.status, settleLocalPwaUpdates, user]);

  React.useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: 0 });
  }, [open]);

  const unreadQuery = useInfiniteQuery({
    queryKey: [...NOTIFICATIONS_KEY, "list", "unread"],
    queryFn: ({ pageParam }) => fetchNotifications("unread", PAGE_SIZE, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
    enabled: enabled && open,
    staleTime: 15_000,
    refetchInterval: open ? 30_000 : false,
    refetchOnWindowFocus: true,
  });

  const readQuery = useInfiniteQuery({
    queryKey: [...NOTIFICATIONS_KEY, "list", "read"],
    queryFn: ({ pageParam }) => fetchNotifications("read", PAGE_SIZE, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
    enabled: enabled && open,
    staleTime: 15_000,
    refetchInterval: open ? 30_000 : false,
    refetchOnWindowFocus: true,
  });

  const countQuery = useQuery({
    queryKey: [...NOTIFICATIONS_KEY, "unread-count"],
    queryFn: fetchUnreadNotificationCount,
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const markReadMutation = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "通知状态更新失败"),
  });

  const markUnreadMutation = useMutation({
    mutationFn: markNotificationUnread,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "通知状态更新失败"),
  });

  const markAllMutation = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      if (user) markAllLocalRead(user.id);
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "通知状态更新失败"),
  });

  const localForUser = React.useMemo(
    () => sortNotifications(localItems.filter((item) => item.user_id === user?.id)),
    [localItems, user?.id],
  );
  const localUnread = localForUser.filter((item) => !item.read_at);
  const localRead = localForUser.filter((item) => item.read_at);

  const serverUnread = React.useMemo(
    () => unreadQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [unreadQuery.data],
  );
  const serverRead = React.useMemo(
    () => readQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [readQuery.data],
  );
  const unreadItems = React.useMemo(
    () => sortNotifications([...localUnread, ...serverUnread]),
    [localUnread, serverUnread],
  );
  const readItems = React.useMemo(
    () => sortNotifications([...localRead, ...serverRead]),
    [localRead, serverRead],
  );

  const listUnreadCount = unreadQuery.data?.pages[0]?.unread_count;
  const serverUnreadCount = open && typeof listUnreadCount === "number"
    ? listUnreadCount
    : countQuery.data?.count ?? 0;
  const unreadTotal = serverUnreadCount + localUnread.length;

  if (!user || offline || user.must_change_pwd) return null;

  const openItem = (item: NotificationItem) => {
    if (!item.read_at) {
      if (item.kind === "pwa_update") markLocalRead(user.id, item.id);
      else markReadMutation.mutate(item.id);
    }
    setOpen(false);
    if (item.link) navigate(item.link);
  };

  const toggleRead = (item: NotificationItem) => {
    if (item.kind === "pwa_update") {
      if (item.read_at) markLocalUnread(user.id, item.id);
      else markLocalRead(user.id, item.id);
      return;
    }
    if (item.read_at) markUnreadMutation.mutate(item.id);
    else markReadMutation.mutate(item.id);
  };

  const actionBusy = markReadMutation.isPending || markUnreadMutation.isPending;

  const markAll = () => {
    markAllMutation.mutate();
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={unreadTotal > 0 ? `通知，${unreadTotal} 条未读` : "通知"}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="通知"
        className="relative h-9 w-9 text-foreground/80"
        onClick={() => setOpen(true)}
      >
        <Bell className="h-4 w-4" />
        {unreadTotal > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-md bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground">
            {unreadTotal > 99 ? "99+" : unreadTotal}
          </span>
        )}
        <span className="sr-only" aria-live="polite">
          {unreadTotal > 0 ? `${unreadTotal} 条未读通知` : "没有未读通知"}
        </span>
      </Button>
      <SheetRoot open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          autoFocusContent
          hideClose
          className="flex w-full flex-col gap-0 p-0 sm:max-w-[420px]"
        >
          <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <SheetTitle className="text-base">通知</SheetTitle>
            {unreadTotal > 0 && (
              <span className="rounded-md bg-primary-weak px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {unreadTotal} 未读
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-8 px-2 text-xs"
              disabled={unreadTotal === 0 || markAllMutation.isPending}
              onClick={markAll}
            >
              {markAllMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              全部已读
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => setOpen(false)}
            >
              <X className="h-3.5 w-3.5" />
              关闭
            </Button>
          </div>
          <SheetDescription className="border-b bg-muted/20 px-4 py-2 text-[11px] leading-4 text-muted-foreground">
            点击通知或手动标记即视为已读；打开面板不会自动清空未读。
          </SheetDescription>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <NotificationSection
              title="未读"
              count={unreadTotal}
              items={unreadItems}
              emptyText="暂无未读通知"
              loading={unreadQuery.isLoading}
              error={unreadQuery.isError}
              hasMore={!!unreadQuery.hasNextPage}
              fetchingMore={unreadQuery.isFetchingNextPage}
              onLoadMore={() => { void unreadQuery.fetchNextPage(); }}
              onRetry={() => { void unreadQuery.refetch(); }}
              onOpenItem={openItem}
              onToggleRead={toggleRead}
              actionBusy={actionBusy}
            />
            <NotificationSection
              title="已读"
              items={readItems}
              emptyText="暂无已读通知"
              loading={readQuery.isLoading}
              error={readQuery.isError}
              hasMore={!!readQuery.hasNextPage}
              fetchingMore={readQuery.isFetchingNextPage}
              onLoadMore={() => { void readQuery.fetchNextPage(); }}
              onRetry={() => { void readQuery.refetch(); }}
              onOpenItem={openItem}
              onToggleRead={toggleRead}
              actionBusy={actionBusy}
            />
          </div>
        </SheetContent>
      </SheetRoot>
    </>
  );
}
