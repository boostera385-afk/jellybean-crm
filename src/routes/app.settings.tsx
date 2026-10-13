import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { friendlyError } from "@/lib/error-messages";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2,
  Plus,
  KeyRound,
  Power,
  Settings as SettingsIcon,
  Users as UsersIcon,
  Trash2,
  CheckCircle2,
  Eye,
  EyeOff,
  BookOpen,
  Copy,
  Megaphone,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { DocumentationTab } from "@/components/settings/documentation-tab";
import { CrmUpdatesTab } from "@/components/settings/crm-updates-tab";
import { CrispSettingsTab } from "@/components/settings/crisp-settings-tab";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import {
  adminCreateUser,
  adminResetPassword,
  adminSetActive,
  adminSetRole,
  listManagedUsers,
  regenerateManagedUserAccessCode,
  type ManagedUserRow,
} from "@/lib/admin-users.functions";
import { adminDeleteUser } from "@/lib/login-otp.functions";
import {
  manageableRolesFor,
  type UserManagementRole,
  type UserManagerRole,
} from "@/lib/user-management-permissions";
import { cn } from "@/lib/utils";

type SettingsTab = "general" | "updates" | "users" | "docs" | "crm-updates" | "crisp";

const SETTINGS_TABS = new Set<SettingsTab>([
  "general",
  "updates",
  "users",
  "docs",
  "crm-updates",
  "crisp",
]);

function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && SETTINGS_TABS.has(value as SettingsTab);
}

export const Route = createFileRoute("/app/settings")({
  head: () => ({ meta: [
    { title: "Settings \u00b7 JellyBean" },
    { name: "description", content: "Manage JellyBean preferences, updates, and documentation." },
    { property: "og:title", content: "Settings \u00b7 JellyBean" },
    { property: "og:description", content: "Manage JellyBean preferences, updates, and documentation." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: Page,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: isSettingsTab(search.tab) ? search.tab : undefined,
  }),
});

const ADMIN_UPDATE_CHECKLIST_KEY = "admin_update_checklist";

type AdminUpdateItem = {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
};

type AdminUpdateValue = {
  items?: AdminUpdateItem[];
};

function readAdminUpdateItems(value: Json | null | undefined): AdminUpdateItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const items = (value as AdminUpdateValue).items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is AdminUpdateItem =>
      !!item &&
      typeof item.id === "string" &&
      typeof item.text === "string" &&
      typeof item.done === "boolean",
  );
}

function Page() {
  const auth = useAuth();
  const { tab: searchTab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const isAdmin = auth.primaryRole === "admin";
  const tab = isAdmin ? (searchTab ?? "general") : "users";

  function setTab(nextTab: SettingsTab) {
    void navigate({
      search: { tab: nextTab === "general" ? undefined : nextTab },
    });
  }

  return (
    <div>
      <PageHeader
        title={isAdmin ? "Settings" : "Users"}
        description={
          isAdmin ? "System-wide preferences and team management." : "Create and manage your team."
        }
      />
      <PageBody>
        <RoleGate allow={["admin", "sub_admin", "cs_admin"]} current={auth.primaryRole}>
          {isAdmin && (
            <div className="crm-toolbar-panel inline-flex mb-5">
              <div className="flex gap-1 flex-wrap">
                <TabBtn
                  active={tab === "general"}
                  onClick={() => setTab("general")}
                  icon={<SettingsIcon className="h-3.5 w-3.5" />}
                >
                  General
                </TabBtn>
                <TabBtn
                  active={tab === "updates"}
                  onClick={() => setTab("updates")}
                  icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                >
                  Updates
                </TabBtn>
                <TabBtn
                  active={tab === "users"}
                  onClick={() => setTab("users")}
                  icon={<UsersIcon className="h-3.5 w-3.5" />}
                >
                  Users
                </TabBtn>
                <TabBtn
                  active={tab === "docs"}
                  onClick={() => setTab("docs")}
                  icon={<BookOpen className="h-3.5 w-3.5" />}
                >
                  Documentation
                </TabBtn>
                <TabBtn
                  active={tab === "crm-updates"}
                  onClick={() => setTab("crm-updates")}
                  icon={<Megaphone className="h-3.5 w-3.5" />}
                >
                  CRM Updates
                </TabBtn>
                <TabBtn
                  active={tab === "crisp"}
                  onClick={() => setTab("crisp")}
                  icon={<MessageSquare className="h-3.5 w-3.5" />}
                >
                  Crisp
                </TabBtn>
              </div>
            </div>
          )}
          {isAdmin && tab === "general" && <GeneralTab />}
          {isAdmin && tab === "updates" && <UpdatesTab />}
          {tab === "users" && <UsersTab managerRole={auth.primaryRole as UserManagerRole} />}
          {isAdmin && tab === "docs" && <DocumentationTab />}
          {isAdmin && tab === "crm-updates" && <CrmUpdatesTab />}
          {isAdmin && tab === "crisp" && <CrispSettingsTab />}
        </RoleGate>
      </PageBody>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "crm-motion h-8 px-3 rounded-md text-[12.5px] font-medium flex items-center gap-1.5",
        active
          ? "bg-linear-to-r from-primary to-primary-glow text-white shadow-md"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon} {children}
    </button>
  );
}

function GeneralTab() {
  return (
    <div className="space-y-4 max-w-2xl">
      <div className="crm-section-panel">
        <div className="crm-surface-card p-5">
          <h3 className="text-sm font-semibold mb-1">Authentication</h3>
          <p className="text-xs text-muted-foreground">
            Login codes and OTP prompts are disabled for every role. Users sign in with their
            provisioned username or email and password only.
          </p>
        </div>
      </div>
    </div>
  );
}

function UpdatesTab() {
  const auth = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const updatesQuery = useQuery({
    queryKey: ["shared_state", ADMIN_UPDATE_CHECKLIST_KEY],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shared_state")
        .select("value")
        .eq("key", ADMIN_UPDATE_CHECKLIST_KEY)
        .maybeSingle();
      if (error) throw error;
      return readAdminUpdateItems(data?.value);
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel("admin-update-checklist-sync")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "shared_state",
          filter: `key=eq.${ADMIN_UPDATE_CHECKLIST_KEY}`,
        },
        () => qc.invalidateQueries({ queryKey: ["shared_state", ADMIN_UPDATE_CHECKLIST_KEY] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);

  async function saveItems(items: AdminUpdateItem[]) {
    const { error } = await supabase.from("shared_state").upsert({
      key: ADMIN_UPDATE_CHECKLIST_KEY,
      value: { items },
      updated_by: auth.user?.id ?? null,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    await qc.invalidateQueries({ queryKey: ["shared_state", ADMIN_UPDATE_CHECKLIST_KEY] });
  }

  async function addItem() {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const item: AdminUpdateItem = {
        id: crypto.randomUUID(),
        text,
        done: false,
        createdAt: now,
        updatedAt: now,
      };
      await saveItems([item, ...(updatesQuery.data ?? [])]);
      setDraft("");
      toast.success("Update note added");
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleItem(id: string, done: boolean) {
    setBusy(true);
    try {
      const now = new Date().toISOString();
      await saveItems(
        (updatesQuery.data ?? []).map((item) =>
          item.id === id ? { ...item, done, updatedAt: now } : item,
        ),
      );
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(id: string) {
    setBusy(true);
    try {
      await saveItems((updatesQuery.data ?? []).filter((item) => item.id !== id));
      toast.success("Update note removed");
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const items = updatesQuery.data ?? [];

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="bg-card border rounded-lg p-5">
        <h3 className="text-sm font-semibold mb-1">Update checklist</h3>
        <p className="text-xs text-muted-foreground">
          Add what needs to be updated, then tick it when the update is confirmed.
        </p>
        <div className="mt-4 space-y-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Write update note..."
          />
          <div className="flex justify-end">
            <Button onClick={addItem} disabled={busy || !draft.trim()}>
              Add update note
            </Button>
          </div>
        </div>
      </div>

      <div className="bg-card border rounded-lg overflow-hidden">
        {updatesQuery.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading updates...</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">No update notes yet.</div>
        ) : (
          <div className="divide-y divide-border">
            {items.map((item) => (
              <div key={item.id} className="flex items-start gap-3 p-4">
                <Checkbox
                  checked={item.done}
                  onCheckedChange={(checked) => toggleItem(item.id, checked === true)}
                  className="mt-0.5"
                  disabled={busy}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-sm whitespace-pre-wrap leading-relaxed",
                      item.done && "text-muted-foreground line-through",
                    )}
                  >
                    {item.text}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {item.done ? "Updated" : "Pending"}
                    {" - "}
                    {new Date(item.updatedAt || item.createdAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeItem(item.id)}
                  disabled={busy}
                >
                  <Trash2 className="h-4 w-4" />
                  <span className="sr-only">Remove update note</span>
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type UserRow = ManagedUserRow;

function roleLabel(role: string | null) {
  if (!role) return "-";
  if (role === "sub_admin") return "Sub-admin";
  return role.replace(/_/g, " ");
}

function UsersTab({ managerRole }: { managerRole: UserManagerRole }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const getUsers = useServerFn(listManagedUsers);
  const roleOptions = manageableRolesFor(managerRole);
  const usersQueryKey = ["managed-users", managerRole] as const;

  const usersQuery = useQuery({
    queryKey: usersQueryKey,
    queryFn: async (): Promise<UserRow[]> => await getUsers(),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4 mr-1" /> New user
        </Button>
      </div>
      <div className="bg-card border rounded-lg overflow-hidden">
        <table className="crm-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Email</th>
              <th>Role</th>
              <th>Access Code</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {usersQuery.isLoading && (
              <tr>
                <td colSpan={7} className="text-center text-muted-foreground py-6">
                  Loading...
                </td>
              </tr>
            )}
            {usersQuery.data?.map((u) => (
              <UserRowItem
                key={u.user_id}
                user={u}
                roleOptions={roleOptions}
                onChange={() => qc.invalidateQueries({ queryKey: usersQueryKey })}
              />
            ))}
            {usersQuery.isError && (
              <tr>
                <td colSpan={7} className="text-center text-destructive py-6">
                  {friendlyError(usersQuery.error)}
                </td>
              </tr>
            )}
            {usersQuery.data?.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-muted-foreground py-6">
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && (
        <CreateUserDialog
          roleOptions={roleOptions}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: usersQueryKey });
          }}
        />
      )}
    </div>
  );
}

function UserRowItem({
  user,
  roleOptions,
  onChange,
}: {
  user: UserRow;
  roleOptions: readonly UserManagementRole[];
  onChange: () => void;
}) {
  const setActive = useServerFn(adminSetActive);
  const resetPw = useServerFn(adminResetPassword);
  const deleteUser = useServerFn(adminDeleteUser);
  const setRole = useServerFn(adminSetRole);
  const [busy, setBusy] = useState(false);

  async function changeRole(next: UserManagementRole) {
    if (next === user.role) return;
    setBusy(true);
    try {
      await setRole({ data: { userId: user.user_id, role: next } });
      toast.success(`Role updated to ${roleLabel(next)}`);
      onChange();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showResetPw, setShowResetPw] = useState(false);
  const [showResetPwValue, setShowResetPwValue] = useState(false);
  const [newPw, setNewPw] = useState("");

  async function toggleActive() {
    setBusy(true);
    try {
      await setActive({ data: { userId: user.user_id, isActive: !user.is_active } });
      toast.success(user.is_active ? "Deactivated" : "Activated");
      onChange();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (newPw.length < 8) {
      toast.error("Password must be 8+ chars");
      return;
    }
    setBusy(true);
    try {
      await resetPw({ data: { userId: user.user_id, newPassword: newPw } });
      toast.success("Password updated");
      setShowResetPw(false);
      setNewPw("");
      setShowResetPwValue(false);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteUser({ data: { userId: user.user_id } });
      toast.success("User deleted");
      onChange();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="font-medium">{user.full_name || "-"}</td>
      <td className="font-mono text-xs">{user.username ?? "-"}</td>
      <td>{user.email}</td>
      <td>
        <Select
          value={user.role ?? undefined}
          onValueChange={(v) => void changeRole(v as UserManagementRole)}
          disabled={busy}
        >
          <SelectTrigger className="h-8 w-[150px] text-[12px] capitalize">
            <SelectValue placeholder="Set role" />
          </SelectTrigger>
          <SelectContent>
            {roleOptions.map((role) => (
              <SelectItem key={role} value={role} className="capitalize">
                {roleLabel(role)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
      <td>
        <AccessCodeCell user={user} onChange={onChange} />
      </td>
      <td>
        <span className={user.is_active ? "text-success" : "text-muted-foreground"}>
          {user.is_active ? "Active" : "Inactive"}
        </span>
      </td>
      <td className="text-right space-x-2 whitespace-nowrap">
        <Button size="sm" variant="outline" onClick={() => setShowResetPw(true)} disabled={busy}>
          <KeyRound className="h-3.5 w-3.5 mr-1" /> Reset PW
        </Button>
        <Button
          size="sm"
          variant={user.is_active ? "outline" : "default"}
          onClick={toggleActive}
          disabled={busy}
        >
          <Power className="h-3.5 w-3.5 mr-1" /> {user.is_active ? "Deactivate" : "Activate"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowDeleteConfirm(true)}
          disabled={busy}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
        </Button>

        <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete user</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete {user.full_name || user.email}. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  setShowDeleteConfirm(false);
                  remove();
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog
          open={showResetPw}
          onOpenChange={(o) => {
            setShowResetPw(o);
            if (!o) {
              setNewPw("");
              setShowResetPwValue(false);
            }
          }}
        >
          <DialogContent className="max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Reset password</DialogTitle>
              <DialogDescription>
                Set a new password for {user.full_name || user.email}.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                reset();
              }}
              className="space-y-3"
            >
              <Field label="New password">
                <div className="relative">
                  <Input
                    type={showResetPwValue ? "text" : "password"}
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    required
                    minLength={8}
                    autoFocus
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowResetPwValue((v) => !v)}
                    aria-label={showResetPwValue ? "Hide password" : "Show password"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {showResetPwValue ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </Field>
              <DialogFooter className="pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowResetPw(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || newPw.length < 8}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Update password
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </td>
    </tr>
  );
}

function CreateUserDialog({
  roleOptions,
  onClose,
  onCreated,
}: {
  roleOptions: readonly UserManagementRole[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const createUser = useServerFn(adminCreateUser);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: "",
    role: roleOptions[0] as UserManagementRole,
    isActive: true,
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await createUser({ data: form });
      toast.success("User created");
      onCreated();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create user</DialogTitle>
          <DialogDescription className="sr-only">Add a new user to the CRM.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Name">
            <Input
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              required
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </Field>
          <Field label="Password">
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
                minLength={8}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                title={showPassword ? "Hide password" : "Show password"}
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </Field>
          <Field label="Role">
            <Select
              value={form.role}
              onValueChange={(v) => setForm({ ...form, role: v as typeof form.role })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((role) => (
                  <SelectItem key={role} value={role} className="capitalize">
                    {roleLabel(role)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="block mb-1.5">{label}</Label>
      {children}
    </div>
  );
}

function AccessCodeCell({ user, onChange }: { user: UserRow; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const regenerateCode = useServerFn(regenerateManagedUserAccessCode);

  if (user.role === "admin") {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (!user.access_code) {
    return <span className="text-xs text-muted-foreground">Not set</span>;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(user.access_code!);
      toast.success("Access code copied");
    } catch {
      toast.error("Copy failed");
    }
  }

  async function regenerate() {
    setBusy(true);
    try {
      const { code: newCode } = await regenerateCode({ data: { userId: user.user_id } });
      try {
        await navigator.clipboard.writeText(newCode);
        toast.success(`New code ${newCode} copied`);
      } catch {
        toast.success(`New code: ${newCode}`);
      }
      onChange();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-sm tabular-nums tracking-[0.2em]">
        {reveal ? user.access_code : "••••••"}
      </span>
      <button
        type="button"
        onClick={() => setReveal((v) => !v)}
        aria-label={reveal ? "Hide code" : "Show code"}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
      >
        {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy access code"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={regenerate}
        disabled={busy}
        aria-label="Regenerate access code"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50"
      >
        <RefreshCw className={"h-3.5 w-3.5 " + (busy ? "animate-spin" : "")} />
      </button>
    </div>
  );
}
