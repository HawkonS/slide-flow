import { useSiteConfig } from "@/stores/site-config";

/**
 * React Hook：获取指定导航 key 的标签名，未配置时回退到 fallback。
 */
export function useNavLabel(key: string, fallback: string): string {
  const label = useSiteConfig((s) => s.navLabels[key]);
  return label || fallback;
}

/**
 * 非 hook 版本：直接读取当前 store 中的导航标签。
 * 适用于无法使用 hook 的场景（如事件回调、工具函数）。
 */
export function getNavLabel(key: string, fallback: string): string {
  const label = useSiteConfig.getState().navLabels[key];
  return label || fallback;
}
