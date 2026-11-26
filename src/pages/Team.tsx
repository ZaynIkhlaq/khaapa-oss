import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Badge, Button, Card, Field, Input, Modal, Pager, Spinner, cx, toast, usePaged } from "../components/ui";
import { SCOPES, type Scope, type User } from "../../shared/types";

type Form = { name: string; scopes: Scope[]; approve: boolean };
type PagerProps = ReturnType<typeof usePaged>["pager"];

function scopeLabel(u: User) {
  if (u.scopes.length === 0) {
    return "User";
  }
  return u.scopes.map((s) => SCOPES.find((x) => x.key === s)!.label).join(", ");
}

function Avatar({ u }: { u: User }) {
  if (u.picture) {
    return <img src={u.picture} alt="" referrerPolicy="no-referrer" className="h-9 w-9 rounded-full" />;
  }
  return <div className="grid h-9 w-9 place-items-center rounded-full bg-neutral-100 font-semibold">{u.name[0]}</div>;
}

function Badges({ u, meId }: { u: User; meId: number | undefined }) {
  const out = [];
  if (!u.approved) {
    out.push(<Badge key="p" tone="warn">Pending</Badge>);
  }
  if (!u.active) {
    out.push(<Badge key="d" tone="bad">Disabled</Badge>);
  }
  if (u.id === meId) {
    out.push(<Badge key="y">You</Badge>);
  }
  return <>{out}</>;
}

function UserRow({ u, me, onReview, onEdit, onToggle }: { u: User; me: User; onReview: (u: User) => void; onEdit: (u: User) => void; onToggle: (u: User) => void }) {
  const locked = u.scopes.includes("admin") && !me.scopes.includes("admin");
  const actions = [];
  if (!u.approved) {
    actions.push(<Button key="r" variant="primary" onClick={() => onReview(u)} className="px-2.5">Review</Button>);
  }
  if (u.approved && !locked) {
    actions.push(<button key="e" onClick={() => onEdit(u)} className="text-xs text-neutral-600 hover:text-ink">Edit</button>);
  }
  if (u.id !== me.id && !locked) {
    actions.push(<button key="t" onClick={() => onToggle(u)} className="text-xs text-neutral-600 hover:text-ink">{u.active ? "Disable" : "Enable"}</button>);
  }
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm">
      <Avatar u={u} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 font-medium">{u.name}<Badges u={u} meId={me.id} /></div>
        <div className="truncate text-xs text-neutral-500">{u.email} · {scopeLabel(u)}</div>
      </div>
      {actions}
    </div>
  );
}

function ScopeChecks({ form, setForm, canGrantAdmin }: { form: Form; setForm: (f: Form) => void; canGrantAdmin: boolean }) {
  const flip = (s: Scope) => {
    const scopes = form.scopes.includes(s) ? form.scopes.filter((x) => x !== s) : [...form.scopes, s];
    setForm({ ...form, scopes });
  };
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-[12px] font-medium text-neutral-600">Everyone is a user: once they start a shift they can sell, manage stock, and handle payments and pre-orders. Add a role only if they need more.</legend>
      {SCOPES.map((s) => {
        const disabled = s.key === "admin" && !canGrantAdmin;
        return (
          <label key={s.key} className={cx("flex items-start gap-2 text-[13px]", disabled && "opacity-50")}>
            <input type="checkbox" checked={form.scopes.includes(s.key)} disabled={disabled} onChange={() => flip(s.key)} className="mt-0.5" />
            <span>
              <span className="font-medium">{s.label}</span>
              <span className="text-neutral-500">: {s.desc}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function EditModal({ target, form, setForm, canGrantAdmin, onClose, onSave }: { target: User | null; form: Form; setForm: (f: Form) => void; canGrantAdmin: boolean; onClose: () => void; onSave: (e: React.FormEvent) => void }) {
  if (!target) {
    return null;
  }
  const title = form.approve ? `Review ${target.name}` : "Edit teammate";
  const submitLabel = form.approve ? "Approve" : "Save";
  return (
    <Modal open onClose={onClose} title={title}>
      <form onSubmit={onSave} className="space-y-4">
        <p className="text-[13px] text-neutral-500">{target.email}</p>
        <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus /></Field>
        <ScopeChecks form={form} setForm={setForm} canGrantAdmin={canGrantAdmin} />
        <Button type="submit" variant="primary" className="w-full">{submitLabel}</Button>
      </form>
    </Modal>
  );
}

function renderList(users: User[] | null, pager: PagerProps, me: User, handlers: { onReview: (u: User) => void; onEdit: (u: User) => void; onToggle: (u: User) => void }) {
  if (users === null) {
    return <Spinner />;
  }
  return (
    <Card className="divide-y divide-line">
      {users.map((u) => <UserRow key={u.id} u={u} me={me} {...handlers} />)}
      <Pager {...pager} />
    </Card>
  );
}

export default function Team() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[] | null>(null);
  const [target, setTarget] = useState<User | null>(null);
  const [form, setForm] = useState<Form>({ name: "", scopes: [], approve: false });

  const load = () => api("/api/users").then((d) => setUsers(d.users));
  useEffect(() => {
    load();
  }, []);
  const { shown, pager } = usePaged(users ?? []);

  if (!me) {
    return <Spinner />;
  }

  const open = (u: User, approve: boolean) => {
    const scopes: Scope[] = u.scopes;
    setForm({ name: u.name, scopes, approve });
    setTarget(u);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) {
      return;
    }
    try {
      await api(`/api/users/${target.id}`, { method: "PUT", json: { name: form.name, scopes: form.scopes, approved: true } });
      toast(form.approve ? `${form.name} approved` : "Saved");
      setTarget(null);
      load();
    } catch (err: any) {
      toast(err.message, true);
    }
  };
  const toggle = async (u: User) => {
    try {
      await api(`/api/users/${u.id}`, { method: "PUT", json: { active: !u.active } });
      load();
    } catch (err: any) {
      toast(err.message, true);
    }
  };
  const pending = (users || []).filter((u) => !u.approved).length;
  const pendingNote = pending > 0 ? `${pending} waiting for review. ` : "";

  return (
    <div className="space-y-6 p-4 md:px-6 md:py-6">
      <div>
        <h1 className="text-xl font-semibold">Team</h1>
        <p className="text-sm text-neutral-500">{pendingNote}Anyone with a Google account on the allowed domain can sign in, but sees nothing until HR or an admin lets them in.</p>
      </div>
      {renderList(users && shown, pager, me, { onReview: (u) => open(u, true), onEdit: (u) => open(u, false), onToggle: toggle })}
      <EditModal target={target} form={form} setForm={setForm} canGrantAdmin={me.scopes.includes("admin")} onClose={() => setTarget(null)} onSave={save} />
    </div>
  );
}
