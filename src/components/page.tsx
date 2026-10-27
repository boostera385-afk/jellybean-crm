import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "crm-page-header crm-enter flex items-center justify-between gap-4 px-5 md:px-7 py-5 mx-3 md:mx-5 mt-3 md:mt-5",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="crm-page-title">{title}</h1>
        {description && <p className="crm-page-subtitle mt-1.5 max-w-3xl">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function PageBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("crm-page-body crm-enter px-3 md:px-5 pb-6 pt-4", className)}>
      <div className="px-0.5 py-1 md:py-2">{children}</div>
    </div>
  );
}

type Role =
  | "admin"
  | "sub_admin"
  | "scraping"
  | "maturing"
  | "cs"
  | "cs_admin"
  | "acc_handler"
  | "facebook"
  | "seo";

export function RoleGate({
  allow,
  current,
  allowOverride = false,
  children,
}: {
  allow: Array<Role>;
  current: Role | null;
  /** Grant access regardless of role, e.g. when the user has a per-user feature grant. */
  allowOverride?: boolean;
  children: React.ReactNode;
}) {
  if (allowOverride) {
    return <>{children}</>;
  }

  if (!current) {
    return (
      <div className="flex items-center justify-center p-10 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (!allow.includes(current)) {
    return (
      <div className="glass-card p-10 text-center max-w-md mx-auto mt-10">
        <div className="text-sm font-medium">Restricted</div>
        <div className="text-xs text-muted-foreground mt-1.5">
          You don't have access to this page.
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
