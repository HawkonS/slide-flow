import { create } from "zustand";

interface SiteConfigState {
  siteName: string;
  logoSvgPath: string;
  versionCommit: string;
  versionUpdatedAt: string;
  navLabels: Record<string, string>;
  navOrder: Record<string, number>;
  setSiteName: (name: string) => void;
  setLogoSvgPath: (path: string) => void;
  setVersion: (commit: string, updatedAt: string) => void;
  setNavConfig: (labels: Record<string, string>, order: Record<string, number>) => void;
}

export const useSiteConfig = create<SiteConfigState>((set) => ({
  siteName: "页流幻灯片管理平台",
  logoSvgPath: "/static/img/logo.svg",
  versionCommit: "",
  versionUpdatedAt: "",
  navLabels: {},
  navOrder: {},
  setSiteName: (name) => set({ siteName: name }),
  setLogoSvgPath: (path) => set({ logoSvgPath: path }),
  setVersion: (commit, updatedAt) => set({ versionCommit: commit, versionUpdatedAt: updatedAt }),
  setNavConfig: (labels, order) => set({ navLabels: labels, navOrder: order }),
}));
