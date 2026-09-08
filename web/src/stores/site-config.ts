import { create } from "zustand";

interface SiteConfigState {
  siteName: string;
  logoSvgPath: string;
  versionCommit: string;
  versionUpdatedAt: string;
  setSiteName: (name: string) => void;
  setLogoSvgPath: (path: string) => void;
  setVersion: (commit: string, updatedAt: string) => void;
}

export const useSiteConfig = create<SiteConfigState>((set) => ({
  siteName: "页流幻灯片管理平台",
  logoSvgPath: "/static/img/logo.svg",
  versionCommit: "",
  versionUpdatedAt: "",
  setSiteName: (name) => set({ siteName: name }),
  setLogoSvgPath: (path) => set({ logoSvgPath: path }),
  setVersion: (commit, updatedAt) => set({ versionCommit: commit, versionUpdatedAt: updatedAt }),
}));
