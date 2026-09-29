import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { CurrentUser } from "@/lib/types";
import { useSiteConfig } from "@/stores/site-config";

type SetupStatus = { required: boolean; automatic?: boolean };

export function SetupPage() {
  const navigate = useNavigate();
  const { beginLogin, completeLogin } = useAuth();
  const siteName = useSiteConfig((s) => s.siteName);
  const logoSvgPath = useSiteConfig((s) => s.logoSvgPath);
  const [checking, setChecking] = useState(true);
  const [automatic, setAutomatic] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [token, setToken] = useState("");
  const [name, setName] = useState("Hawkon");
  const [username, setUsername] = useState("Hawkon");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    api<SetupStatus>("/api/auth/setup")
      .then((status) => {
        if (!status.required) {
          navigate("/login", { replace: true });
          return;
        }
        setAutomatic(!!status.automatic);
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : "无法读取初始化状态"))
      .finally(() => setChecking(false));
  }, [navigate]);

  const submit = async () => {
    if ((!automatic && !token.trim()) || !name.trim() || !username.trim()) {
      toast.error(automatic ? "姓名和用户名均为必填项" : "初始化令牌、姓名和用户名均为必填项");
      return;
    }
    if (password.trim().length < 10) {
      toast.error("密码长度不能少于 10 位");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    const loginEpoch = beginLogin();
    try {
      const result = await api<{ user: CurrentUser }>("/api/auth/setup", {
        method: "POST",
        json: {
          token: automatic ? "" : token.trim(),
          name: name.trim(),
          username: username.trim(),
          password,
        },
      });
      await completeLogin(result.user, loginEpoch);
      toast.success("系统管理员初始化完成");
      navigate("/home", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "初始化失败");
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-lg rounded-lg border bg-background p-7 shadow-sm">
        <div className="mb-7 flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <img src={logoSvgPath} alt="" className="h-7 w-7" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">初始化 {siteName}</h1>
              <ShieldCheck className="h-5 w-5 text-primary" />
            </div>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              {automatic
                ? "当前通过本机安全访问，初始化凭证已自动验证。请直接设置管理员账号和密码。"
                : "当前不是本机访问。请从服务器安全文件 .secrets/initial-admin-setup.json 中获取一次性令牌。"}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {!automatic && (
            <div className="space-y-1.5">
              <Label htmlFor="setup-token">一次性初始化令牌</Label>
              <Input
                id="setup-token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                placeholder="从服务器安全文件中复制"
              />
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="setup-name">姓名</Label>
              <Input id="setup-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="setup-username">登录用户名</Label>
              <Input
                id="setup-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="setup-password">管理员密码</Label>
              <Input
                id="setup-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                placeholder="至少 10 位"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="setup-confirm">确认密码</Label>
              <Input
                id="setup-confirm"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
        </div>

        <Button className="mt-6 w-full" onClick={submit} disabled={submitting}>
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
          完成安全初始化
        </Button>
      </div>
    </div>
  );
}
