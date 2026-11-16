import { ChangePasswordDialog } from "@/components/common/ChangePasswordDialog";
import { useAuth } from "@/lib/auth";

/** Blocking dialog shown after signing in with a temporary password. */
export function ForceChangePassword() {
  const { user } = useAuth();
  return (
    <ChangePasswordDialog
      open={!!user?.must_change_pwd}
      onOpenChange={() => { /* The forced flow only closes after the password changes. */ }}
      force
    />
  );
}
