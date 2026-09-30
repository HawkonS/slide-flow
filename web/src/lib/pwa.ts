import { toast } from "sonner";
import { useSyncExternalStore } from "react";

const UPDATE_NOTICE = "slideflow-pwa-update";
const INSTALL_NOTICE = "slideflow-pwa-install";
const INSTALL_TIMEOUT = 180_000;
let registered = false;
let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;
let installEvent: BeforeInstallPromptEvent | null = null;
let updateNoticeShown = false;
let installNoticeShown = false;
const observedRegistrations = new WeakSet<ServiceWorkerRegistration>();

export type PwaDeploymentStatus = "unsupported" | "development" | "checking" | "not-deployed" | "deployed" | "update-available" | "error";
export interface PwaStatusSnapshot {
  status: PwaDeploymentStatus;
  environment: "development" | "production";
  supported: boolean;
  secureContext: boolean;
  controlled: boolean;
  active: boolean;
  waiting: boolean;
  installable: boolean;
  standalone: boolean;
  message: string;
}
const statusListeners = new Set<() => void>();
const environment = import.meta.env.PROD ? "production" : "development";
const initialSupport = typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "caches" in window;
let pwaStatus: PwaStatusSnapshot = {
  status: !initialSupport ? "unsupported" : environment === "development" ? "development" : "checking",
  environment,
  supported: initialSupport,
  secureContext: typeof window !== "undefined" && window.isSecureContext,
  controlled: typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller,
  active: false,
  waiting: false,
  installable: false,
  standalone: typeof window !== "undefined" && !!(window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true),
  message: !initialSupport ? "当前浏览器或连接不支持本地应用" : environment === "development" ? "开发环境不会部署本地应用，请访问构建后的应用服务" : "正在检查本地应用部署状态…",
};
function publishPwaStatus(next: Partial<PwaStatusSnapshot>): void {
  pwaStatus = { ...pwaStatus, ...next };
  for (const listener of statusListeners) listener();
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("slideflow-pwa-status-change", { detail: pwaStatus }));
}
export function getPwaStatus(): PwaStatusSnapshot { return pwaStatus; }
export function subscribePwaStatus(listener: () => void): () => void { statusListeners.add(listener); return () => statusListeners.delete(listener); }
export function usePwaStatus(): PwaStatusSnapshot { return useSyncExternalStore(subscribePwaStatus, getPwaStatus, getPwaStatus); }

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Shared with error recovery: no background update may interrupt playback. */
export function isPlaybackWindow(): boolean {
  return /^\/shows\/[^/]+\/(?:fullscreen|present|display)\/?$/.test(window.location.pathname);
}

function supportError(): string | null {
  if (!window.isSecureContext) return "离线播放需要安全连接，请使用 HTTPS 访问本站（本机 localhost 除外）。";
  if (!("serviceWorker" in navigator) || !("caches" in window)) return "当前浏览器不支持离线应用，请使用支持 Service Worker 的浏览器。";
  return null;
}

function standaloneMode(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function publishRegistrationStatus(registration?: ServiceWorkerRegistration): void {
  const active = !!registration?.active && isOurWorker(registration.active);
  const waiting = !!registration?.waiting && isOurWorker(registration.waiting);
  const controlled = !!navigator.serviceWorker.controller && isOurWorker(navigator.serviceWorker.controller);
  publishPwaStatus({
    status: waiting ? "update-available" : active ? "deployed" : "not-deployed",
    active, waiting, controlled, standalone: standaloneMode(),
    message: waiting
      ? "本地应用有新版本，完成当前工作后重新打开即可更新"
      : active && controlled
        ? "本地应用已部署并接管当前页面"
        : active
          ? "本地应用已部署，重新打开页面后即可接管"
          : "本地应用尚未完成部署，请联网后重试",
  });
}

function showNotices(registration?: ServiceWorkerRegistration): void {
  if (registration) publishRegistrationStatus(registration);
  if (isPlaybackWindow() || document.hidden) {
    toast.dismiss(UPDATE_NOTICE);
    toast.dismiss(INSTALL_NOTICE);
    return;
  }
  if (registration?.waiting && !updateNoticeShown) {
    updateNoticeShown = true;
    toast.info("新版已准备好", {
      id: UPDATE_NOTICE, duration: 8_000,
      description: "完成当前工作后，关闭所有 SlideFlow 窗口并重新打开即可更新；正在放映的页面会继续使用当前版本。",
    });
  }
  if (installEvent && !installNoticeShown && !window.matchMedia("(display-mode: standalone)").matches) {
    installNoticeShown = true;
    toast.info("可将 SlideFlow 安装到此设备", {
      id: INSTALL_NOTICE, duration: 10_000,
      description: "从桌面直接打开，已下载的放映可以断网播放。",
      action: {
        label: "安装",
        onClick: () => { void requestPwaInstall().then(accepted => { if (!accepted && !isPlaybackWindow()) toast.error("未能打开安装提示，请使用浏览器菜单中的安装应用功能。"); }); },
      },
    });
  }
}

function isOurWorker(worker: ServiceWorker | null): worker is ServiceWorker {
  return !!worker && new URL(worker.scriptURL).origin === window.location.origin && new URL(worker.scriptURL).pathname === "/sw.js";
}

function observeRegistration(registration: ServiceWorkerRegistration): void {
  if (observedRegistrations.has(registration)) return;
  observedRegistrations.add(registration);
  const observe = () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" || worker.state === "activated") showNotices(registration);
    });
  };
  registration.addEventListener("updatefound", observe);
  observe();
  showNotices(registration);
  // No skipWaiting or controllerchange reload. Every open window keeps its
  // version until closed, including a separate presenter/display window.
  const check = () => {
    showNotices(registration);
    if (!document.hidden && navigator.onLine && !isPlaybackWindow()) void registration.update().catch(() => {});
  };
  window.addEventListener("online", check);
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", check);
  navigator.serviceWorker.addEventListener("controllerchange", check);
  let previousPath = window.location.pathname;
  // React Router navigation does not emit popstate for every transition. This
  // inexpensive check also removes a notice before it can linger in a show.
  window.setInterval(() => {
    const path = window.location.pathname;
    if (path !== previousPath) { previousPath = path; showNotices(registration); }
  }, 1_000);
}

function getRegistration(): Promise<ServiceWorkerRegistration> {
  const error = supportError();
  if (error) return Promise.reject(new Error(error));
  if (!import.meta.env.PROD) return Promise.reject(new Error("开发环境不会部署本地应用，请从发布构建的应用服务访问。"));
  if (!registrationPromise) {
    publishPwaStatus({ status: "checking", message: "正在部署本地应用…" });
    registrationPromise = navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(registration => { observeRegistration(registration); return registration; })
      .catch(() => {
        registrationPromise = null;
        publishPwaStatus({ status: "error", message: "本地应用部署失败，请检查网络与浏览器存储权限" });
        throw new Error("离线应用注册失败，请检查网络、浏览器存储权限及 HTTPS 配置后重试。");
      });
  }
  return registrationPromise;
}

function waitForActive(registration: ServiceWorkerRegistration): Promise<ServiceWorker> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let installing = registration.installing;
    let interval: number;
    const check = () => {
      installing = registration.installing || installing;
      if (isOurWorker(registration.active) && registration.active.state === "activated") {
        window.clearInterval(interval);
        resolve(registration.active);
      } else if (installing?.state === "redundant" || Date.now() - started >= INSTALL_TIMEOUT) {
        window.clearInterval(interval);
        reject(new Error("离线应用安装未完成，可能是网络中断或存储空间不足。请联网后重试。"));
      }
    };
    interval = window.setInterval(check, 200);
    check();
  });
}

function waitForController(): Promise<ServiceWorker> {
  if (isOurWorker(navigator.serviceWorker.controller)) return Promise.resolve(navigator.serviceWorker.controller);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", check);
      reject(new Error("离线应用已安装，但此页面尚未接入。请重新打开当前页面后重试。"));
    }, 15_000);
    const check = () => {
      if (!isOurWorker(navigator.serviceWorker.controller)) return;
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", check);
      resolve(navigator.serviceWorker.controller);
    };
    navigator.serviceWorker.addEventListener("controllerchange", check);
    check();
  });
}

function checkShell(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      if (error) reject(error); else resolve();
    };
    const timeout = window.setTimeout(() => finish(new Error("离线应用没有及时响应，请重新打开页面后重试。")), 20_000);
    channel.port1.onmessage = event => {
      const data = event.data;
      if (data?.type !== "SLIDEFLOW_SHELL_STATUS" || data.protocol !== 1 || data.ready !== true) {
        finish(new Error("浏览器中的离线应用缓存不完整，请联网重新安装应用后再下载放映。"));
      } else finish();
    };
    try { worker.postMessage({ type: "SLIDEFLOW_SHELL_STATUS" }, [channel.port2]); }
    catch { finish(new Error("无法验证离线应用，请重新打开页面后重试。")); }
  });
}

/** A download may be published as offline-ready only after this resolves. */
export async function ensureOfflineShellReady(): Promise<void> {
  try {
    const registration = await getRegistration();
    await waitForActive(registration);
    const controller = await waitForController();
    await checkShell(controller);
  } catch (error) {
    // A later explicit retry must be able to restart a failed installation.
    registrationPromise = null;
    throw error;
  }
}

/** Ask the browser to install the local application when it is available. */
export async function requestPwaInstall(): Promise<boolean> {
  const event = installEvent;
  if (!event) return false;
  installEvent = null;
  try {
    await event.prompt();
    const choice = await event.userChoice;
    publishPwaStatus({ installable: false, standalone: standaloneMode() });
    return choice.outcome === "accepted";
  } catch {
    return false;
  }
}

/** Trigger a background update check for the currently deployed worker. */
export async function checkPwaUpdate(): Promise<void> {
  const registration = await getRegistration();
  await registration.update();
  publishRegistrationStatus(registration);
}

/** Register after initial rendering; callers may explicitly await readiness. */
export function registerPwa(): void {
  if (registered) return;
  registered = true;
  const unsupported = supportError();
  if (unsupported) {
    publishPwaStatus({ status: "unsupported", supported: false, message: unsupported });
    return;
  }
  if (!import.meta.env.PROD) {
    publishPwaStatus({ status: "development", supported: true, message: "开发环境不会部署本地应用，请访问构建后的应用服务" });
    return;
  }
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installEvent = event as BeforeInstallPromptEvent;
    publishPwaStatus({ installable: true });
    showNotices();
  });
  window.addEventListener("appinstalled", () => { installEvent = null; publishPwaStatus({ installable: false, standalone: true }); toast.dismiss(INSTALL_NOTICE); });
  const start = () => { void getRegistration().catch(() => { /* An explicit offline download reports errors. */ }); };
  if (document.readyState === "complete") window.setTimeout(start, 500);
  else window.addEventListener("load", () => window.setTimeout(start, 500), { once: true });
}
