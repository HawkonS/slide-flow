import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { CurrentUser } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

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
  const { setUser, reload } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [feishuConfig, setFeishuConfig] = useState<FeishuConfig | null>(null);
  const [feishuLogging, setFeishuLogging] = useState(false);
  const feishuCodeHandled = useRef(false);

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

  const from = ((location.state as { from?: string } | null)?.from) || "/resources";

  // 加载飞书 SSO 配置
  useEffect(() => {
    fetch("/api/auth/feishu/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: FeishuConfig | null) => {
        if (data?.enabled) setFeishuConfig(data);
      })
      .catch(() => { /* ignore */ });
  }, []);

  // 处理飞书回调：URL 中包含 code 参数
  useEffect(() => {
    // 防止 React StrictMode 下 useEffect 双重执行导致授权码被重复使用
    if (feishuCodeHandled.current) return;

    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    if (!code) return;

    feishuCodeHandled.current = true;

    // 清除 URL 中的 code 和 state 参数
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, "", cleanUrl);

    setFeishuLogging(true);
    api<{ user: CurrentUser }>("/api/auth/feishu/callback", {
      method: "POST",
      json: { code },
    })
      .then(async (res) => {
        setUser(res.user);
        await reload();
        toast.success(`欢迎，${res.user.name || res.user.username}`);
        navigate(from, { replace: true });
      })
      .catch((e) => {
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
      setUser(user);
      await reload();
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

  const isProcessing = submitting || feishuLogging;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-muted/30 via-background to-accent/40 p-6">
      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <img src="/static/img/logo.svg" alt="logo" className="h-8 w-8" />
          </div>
          <CardTitle className="text-xl">放映信息管理平台</CardTitle>
          <CardDescription>请登录后访问</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">账号</Label>
              <Input id="username" autoComplete="username" {...form.register("username")} disabled={isProcessing} />
              {form.formState.errors.username && (
                <p className="text-xs text-destructive">{form.formState.errors.username.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input id="password" type="password" autoComplete="current-password" {...form.register("password")} disabled={isProcessing} />
              {form.formState.errors.password && (
                <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={isProcessing}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              登录
            </Button>
          </form>

          {feishuConfig && (
            <>
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">或</span>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleFeishuLogin}
                disabled={isProcessing}
              >
                {feishuLogging ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <path d="M4.93 4.93l5.66 5.66-2.83 2.83-5.66-5.66a4 4 0 012.83-2.83z" fill="#3370FF"/>
                    <path d="M19.07 4.93l-5.66 5.66 2.83 2.83 5.66-5.66a4 4 0 00-2.83-2.83z" fill="#3370FF"/>
                    <path d="M4.93 19.07l5.66-5.66 2.83 2.83-5.66 5.66a4 4 0 01-2.83-2.83z" fill="#3370FF"/>
                    <path d="M19.07 19.07l-5.66-5.66-2.83 2.83 5.66 5.66a4 4 0 002.83-2.83z" fill="#3370FF"/>
                  </svg>
                )}
                飞书登录
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
