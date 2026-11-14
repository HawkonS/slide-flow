import { create } from "zustand";

interface SiteConfigState {
  siteName: string;
  siteDescription: string;
  logoSvgPath: string;
  versionCommit: string;
  versionUpdatedAt: string;
  setSiteName: (name: string) => void;
  setSiteDescription: (description: string) => void;
  setLogoSvgPath: (path: string) => void;
  setVersion: (commit: string, updatedAt: string) => void;
}

export const useSiteConfig = create<SiteConfigState>((set) => ({
  siteName: "页流幻灯片管理平台",
  siteDescription: "企业级演示文稿资源管理平台，助力团队高效协作与内容分发",
  logoSvgPath: "/static/img/logo.svg",
  versionCommit: "",
  versionUpdatedAt: "",
  setSiteName: (name) => set({ siteName: name }),
  setSiteDescription: (description) => set({ siteDescription: description }),
  setLogoSvgPath: (path) => set({ logoSvgPath: path }),
  setVersion: (commit, updatedAt) => set({ versionCommit: commit, versionUpdatedAt: updatedAt }),
}));
