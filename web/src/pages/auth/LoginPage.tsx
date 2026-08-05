import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Loader2, Eye, EyeOff } from "lucide-react";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { CurrentUser } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useSiteConfig } from "@/stores/site-config";

const loginSchema = z.object({
  username: z.string().min(1, "请输入账号"),
  password: z.string().min(1, "请输入密码"),
});
type LoginForm = z.infer<typeof loginSchema>;

interface FeishuConfig {
  enabled: boolean;
  app_id: string;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setUser } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [feishuConfig, setFeishuConfig] = useState<FeishuConfig | null>(null);
  const [feishuLogging, setFeishuLogging] = useState(false);
  // 配置加载状态：避免配置（站点名、飞书 SSO 等）尚未就绪时用户可以点击登录/飞书。
  const [configLoading, setConfigLoading] = useState(true);
  const [feishuConfigLoading, setFeishuConfigLoading] = useState(true);

  const siteName = useSiteConfig((s) => s.siteName);
  const logoSvgPath = useSiteConfig((s) => s.logoSvgPath);
  const versionCommit = useSiteConfig((s) => s.versionCommit);
  const versionUpdatedAt = useSiteConfig((s) => s.versionUpdatedAt);

  // 加载站点配置（站点名称、浏览器标题）
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    fetch("/api/config", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((config) => {
        if (config?.site_name) {
          useSiteConfig.getState().setSiteName(config.site_name);
          document.title = config.site_name;
        }
        if (config?.logo_svg_path) {
          useSiteConfig.getState().setLogoSvgPath(config.logo_svg_path);
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => {
        window.clearTimeout(timeout);
        setConfigLoading(false);
      });
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

  const from = ((location.state as { from?: string } | null)?.from) || "/resources";

  // 加载飞书 SSO 配置
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    fetch("/api/auth/feishu/config", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: FeishuConfig | null) => {
        if (data?.enabled) setFeishuConfig(data);
      })
      .catch(() => { /* ignore */ })
      .finally(() => {
        window.clearTimeout(timeout);
        setFeishuConfigLoading(false);
      });
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  // 处理飞书回调：URL 中包含 code 参数
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code) return;
  
    // 防止 React StrictMode 下 useEffect 双重执行导致授权码被重复使用
    // 使用 sessionStorage 而非 useRef，因为 StrictMode 卸载重建组件时 ref 会重置
    const codeKey = `feishu_code_used_${code}`;
    if (sessionStorage.getItem(codeKey)) {
      // 已处理过此 code，仅清理 URL
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    sessionStorage.setItem(codeKey, "1");
  
    // 验证 state 参数防 CSRF
    const savedState = sessionStorage.getItem("feishu_sso_state");
    sessionStorage.removeItem("feishu_sso_state");
    if (savedState && state !== savedState) {
      toast.error("登录验证失败，请重试");
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
  
    // 清除 URL 中的 code 和 state 参数
    window.history.replaceState({}, "", window.location.pathname);
  
    setFeishuLogging(true);
    api<{ user: CurrentUser }>("/api/auth/feishu/callback", {
      method: "POST",
      json: { code },
    })
      .then((res) => {
        // 回调已返回完整用户信息，直接登录跳转，无需再请求 /api/me
        setUser(res.user);
        toast.success(`欢迎，${res.user.name || res.user.username}`);
        navigate(from, { replace: true });
      })
      .catch((e) => {
        // 不清除 codeKey：StrictMode 下 useEffect 会二次执行，若清除了标记，
        // 重试时会再次使用已被后端作废的 code 及可能导致错误反复提示。
        // 如需重新登录，用户可重新发起飞书授权获取新 code。
        toast.error(e instanceof Error ? e.message : "飞书登录失败");
      })
      .finally(() => setFeishuLogging(false));
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  async function onSubmit(values: LoginForm) {
    setSubmitting(true);
    try {
      const res = await api<{ user: CurrentUser }>("/api/auth/login", {
        method: "POST",
        json: values,
      });
      const user = res.user;
      // 登录接口已返回完整用户信息，直接跳转，无需再请求 /api/me
      setUser(user);
      toast.success(`欢迎回来，${user.display_name || user.name || user.username}`);
      navigate(from, { replace: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  function handleFeishuLogin() {
    if (!feishuConfig?.app_id) return;
    // 构造回调 URL：当前页面的 origin + pathname（即 /login）
    const redirectUri = `${window.location.origin}/login`;
    // 生成随机 state 防 CSRF
    const state = crypto.randomUUID();
    sessionStorage.setItem("feishu_sso_state", state);
    const authUrl =
      `https://open.feishu.cn/open-apis/authen/v1/authorize` +
      `?app_id=${encodeURIComponent(feishuConfig.app_id)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&state=${state}`;
    window.location.href = authUrl;
  }

  const [showPassword, setShowPassword] = useState(false);
  const isProcessing = submitting || feishuLogging;
  // 登录按钮需等待基础配置加载完成（避免在未初始化状态下提交）
  const loginDisabled = isProcessing || configLoading;
  // 飞书按钮需等待飞书配置加载完成
  const feishuDisabled = isProcessing || feishuConfigLoading;

  return (
    <div className="flex min-h-screen">
      {/* ── 左侧品牌区（桌面端） ── */}
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 lg:flex lg:w-[38%] lg:flex-col lg:items-center lg:justify-center">
        {/* 装饰圆 */}
        <div className="pointer-events-none absolute -left-20 -top-20 h-72 w-72 rounded-full bg-white/[0.04]" />
        <div className="pointer-events-none absolute -bottom-32 -right-16 h-96 w-96 rounded-full bg-white/[0.03]" />
        <div className="pointer-events-none absolute left-1/2 top-1/3 h-48 w-48 -translate-x-1/2 rounded-full bg-white/[0.02]" />

        {/* 品牌内容 */}
        <div className="relative z-10 flex flex-col items-center px-12 text-center">
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/20 backdrop-blur-sm">
            <img src={logoSvgPath} alt="logo" className="h-9 w-9" />
          </div>
          <h1 className="mb-3 text-2xl font-bold tracking-tight text-white">
            {siteName}
          </h1>
          <p className="max-w-xs text-sm leading-relaxed text-slate-400">
            企业级演示文稿资源管理平台，助力团队高效协作与内容分发
          </p>
        </div>

        {/* 底部版权 */}
        <p className="absolute bottom-6 text-xs text-slate-600">
          &copy; {new Date().getFullYear()} {siteName}
        </p>
      </div>

      {/* ── 右侧表单区 ── */}
      <div className="relative flex flex-1 flex-col items-center justify-center bg-white px-6 py-12">
        {/* 移动端顶部 Logo */}
        <div className="mb-10 flex flex-col items-center gap-3 lg:hidden">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 shadow-sm">
            <img src={logoSvgPath} alt="logo" className="h-7 w-7" />
          </div>
          <span className="text-lg font-semibold tracking-tight text-slate-900">{siteName}</span>
        </div>

        <div className="w-full max-w-[360px]">
          {/* 标题 */}
          <div className="mb-8">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              欢迎回来
            </h2>
            <p className="mt-1.5 text-sm text-slate-500">请登录您的账号以继续</p>
          </div>

          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            {/* 账号 */}
            <div className="space-y-1.5">
              <Label htmlFor="username" className="text-sm font-medium text-slate-700">
                账号
              </Label>
              <Input
                id="username"
                autoComplete="username"
                {...form.register("username")}
                disabled={isProcessing}
                className="h-11 rounded-lg border-slate-200 transition-shadow focus-visible:ring-2"
                placeholder="请输入账号"
              />
              {form.formState.errors.username && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.username.message}
                </p>
              )}
            </div>

            {/* 密码 */}
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-sm font-medium text-slate-700">
                密码
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  {...form.register("password")}
                  disabled={isProcessing}
                  className="h-11 rounded-lg border-slate-200 pr-10 transition-shadow focus-visible:ring-2"
                  placeholder="请输入密码"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {form.formState.errors.password && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.password.message}
                </p>
              )}
            </div>

            {/* 登录按钮 */}
            <Button
              type="submit"
              className="h-11 w-full rounded-lg text-sm font-medium shadow-sm transition-colors"
              disabled={loginDisabled}
            >
              {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {configLoading ? "加载中…" : "登录"}
            </Button>
          </form>

          {/* 飞书 SSO */}
          {feishuConfig && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-slate-200" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-white px-3 text-slate-400">或</span>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-11 w-full rounded-lg border-slate-200"
                onClick={handleFeishuLogin}
                disabled={feishuDisabled}
              >
                {feishuLogging ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <path d="M4.93 4.93l5.66 5.66-2.83 2.83-5.66-5.66a4 4 0 012.83-2.83z" fill="#3370FF" />
                    <path d="M19.07 4.93l-5.66 5.66 2.83 2.83 5.66-5.66a4 4 0 00-2.83-2.83z" fill="#3370FF" />
                    <path d="M4.93 19.07l5.66-5.66 2.83 2.83-5.66 5.66a4 4 0 01-2.83-2.83z" fill="#3370FF" />
                    <path d="M19.07 19.07l-5.66-5.66-2.83 2.83 5.66 5.66a4 4 0 002.83-2.83z" fill="#3370FF" />
                  </svg>
                )}
                飞书登录
              </Button>
            </>
          )}
        </div>

        {/* 右下角版本信息 */}
        {(versionCommit || versionUpdatedAt) && (
          <div className="absolute bottom-4 right-6 text-right text-xs text-slate-400">
            {versionCommit && <div>{versionCommit}</div>}
            {versionUpdatedAt && <div>最后更新: {versionUpdatedAt}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
