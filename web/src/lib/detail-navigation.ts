import { useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

type ScrollPositions = Record<string, { top: number; left: number }>;
interface DetailOrigin {
  url: string;
  key: string;
  scroll: ScrollPositions;
}
export type ResourceListParams = Record<string, string | number | boolean | undefined>;
interface NavigationState {
  detailOrigin?: DetailOrigin;
  listScroll?: ScrollPositions;
  resourceListParams?: ResourceListParams;
}

// Keep browser Back working too; the detail's history state retains its origin
// across reloads, without adding private list filters to shareable detail URLs.
const savedScroll = new Map<string, ScrollPositions>();
const scrollSelector = "[data-list-scroll]";

function rememberScroll(key: string, scroll: ScrollPositions) {
  savedScroll.delete(key);
  savedScroll.set(key, scroll);
  if (savedScroll.size > 100) savedScroll.delete(savedScroll.keys().next().value!);
}

function captureScroll(): ScrollPositions {
  const positions: ScrollPositions = {};
  document.querySelectorAll<HTMLElement>(scrollSelector).forEach((element) => {
    positions[element.dataset.listScroll!] = { top: element.scrollTop, left: element.scrollLeft };
  });
  return positions;
}

/** Navigate from a list while preserving its full URL and scroll position. */
export function useOpenDetail() {
  const location = useLocation();
  const navigate = useNavigate();
  return (url: string, resourceListParams?: ResourceListParams) => {
    const scroll = captureScroll();
    rememberScroll(location.key, scroll);
    navigate(url, { state: { resourceListParams, detailOrigin: {
      url: location.pathname + location.search + location.hash,
      key: location.key,
      scroll,
    } } satisfies NavigationState });
  };
}

const defaultResourceListParams: ResourceListParams = { sort: "updated_desc" };

/** Keep the originating list's filters out of shareable detail URLs. */
export function useResourceListParams(): ResourceListParams {
  const location = useLocation();
  return (location.state as NavigationState | null)?.resourceListParams ?? defaultResourceListParams;
}

/** Return to the list even after visiting other detail versions or reloading. */
export function useDetailReturn(fallback: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const origin = (location.state as NavigationState | null)?.detailOrigin;
  useLayoutEffect(() => {
    if (origin) rememberScroll(origin.key, origin.scroll);
  }, [origin]);
  return () => {
    if (typeof origin?.url === "string" && origin.url.startsWith("/") && !origin.url.startsWith("//")) {
      navigate(origin.url, { replace: true, state: { listScroll: origin.scroll } satisfies NavigationState });
    } else {
      navigate(fallback, { replace: true });
    }
  };
}

/** Restore only after list data and responsive layout have rendered. */
export function useRestoreListScroll(ready: boolean) {
  const location = useLocation();
  const restoredKey = useRef<string>();
  useLayoutEffect(() => {
    if (!ready || restoredKey.current === location.key) return;
    const scroll = (location.state as NavigationState | null)?.listScroll ?? savedScroll.get(location.key);
    if (!scroll) return;
    const frame = requestAnimationFrame(() => {
      document.querySelectorAll<HTMLElement>(scrollSelector).forEach((element) => {
        const position = scroll[element.dataset.listScroll!];
        if (position) {
          element.scrollTop = position.top;
          element.scrollLeft = position.left;
        }
      });
      restoredKey.current = location.key;
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, location.key, location.state]);
}
