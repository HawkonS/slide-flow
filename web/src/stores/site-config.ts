import { create } from "zustand";

interface SiteConfigState {
  siteName: string;
  logoSvgPath: string;
  setSiteName: (name: string) => void;
  setLogoSvgPath: (path: string) => void;
}

export const useSiteConfig = create<SiteConfigState>((set) => ({
  siteName: "页流幻灯片管理平台",
  logoSvgPath: "/static/img/logo.svg",
  setSiteName: (name) => set({ siteName: name }),
  setLogoSvgPath: (path) => set({ logoSvgPath: path }),
}));
