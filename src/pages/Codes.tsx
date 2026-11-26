import { useEffect, useState } from "react";
import { api, rs } from "../api";
import { Badge, Button, Card, Field, Input, Modal, Pager, Select, Spinner, cx, toast, usePaged } from "../components/ui";
import type { DiscountCode, Sponsor } from "../../shared/types";

type Filter = "all" | "coupon" | "promo";
type CodeForm = {
  kind: "coupon" | "promo";
  sponsor_id: string;
  count: string;
  code: string;
  discount_type: "fixed" | "percent";
  value: string;
  min_order: string;
  max_uses: string;
  expires_on: string;
};

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "coupon", label: "Coupons" },
  { key: "promo", label: "Promo codes" },
];

const pkToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const digits = (v: string) => v.replace(/\D/g, "");

function blankForm(kind: CodeForm["kind"], sponsorId: string): CodeForm {
  return { kind, sponsor_id: sponsorId, count: "10", code: "", discount_type: "fixed", value: "", min_order: "", max_uses: "", expires_on: "" };
}

function discountLabel(c: Pick<DiscountCode, "discount_type" | "value" | "min_order">) {
  const off = c.discount_type === "percent" ? `${c.value}% off` : `${rs(c.value)} off`;
  if (c.min_order > 0) {
    return `${off} · min ${rs(c.min_order)}`;
  }
  return off;
}

function usesLabel(c: DiscountCode) {
  if (c.max_uses === null) {
    return `${c.uses} used`;
  }
  return `${c.uses}/${c.max_uses} used`;
}

function statusBadge(c: DiscountCode) {
  if (!c.active) {
    return <Badge tone="bad">Off</Badge>;
  }
  if (c.expires_on && c.expires_on < pkToday()) {
    return <Badge tone="warn">Expired</Badge>;
  }
  if (c.max_uses !== null && c.uses >= c.max_uses) {
    return <Badge>Used</Badge>;
  }
  return <Badge tone="good">Live</Badge>;
}

function kindBadge(c: DiscountCode) {
  if (c.kind === "coupon") {
    return <Badge tone="accent">Coupon</Badge>;
  }
  return <Badge>Promo</Badge>;
}

function codeMeta(c: DiscountCode) {
  const parts = [discountLabel(c), usesLabel(c)];
  if (c.sponsor_name) {
    parts.unshift(c.sponsor_name);
  }
  if (c.expires_on) {
    parts.push(`until ${c.expires_on}`);
  }
  return parts.join(" · ");
}

function SponsorRow({ s }: { s: Sponsor }) {
  const contact = s.contact ? <div className="truncate text-xs text-neutral-500">{s.contact}</div> : null;
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{s.name}</div>
        {contact}
      </div>
      <div className="text-right text-xs text-neutral-500">
        <div>{s.redeemed}/{s.coupons} redeemed</div>
        <div className="tabular font-semibold text-ink">{rs(s.owed)} owed</div>
      </div>
    </li>
  );
}

function renderSponsors(sponsors: Sponsor[]) {
  if (sponsors.length === 0) {
    return <p className="px-4 py-6 text-center text-xs text-neutral-400">No sponsors yet. Add one, then issue coupons on their behalf.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {sponsors.map((s) => <SponsorRow key={s.id} s={s} />)}
    </ul>
  );
}

function CodeRow({ c, onToggle }: { c: DiscountCode; onToggle: (c: DiscountCode) => void }) {
  const toggleLabel = c.active ? "Turn off" : "Turn on";
  return (
    <li className={cx("flex items-center gap-3 px-4 py-2.5 text-sm", !c.active && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono font-semibold">{c.code}</span>
          {kindBadge(c)}
          {statusBadge(c)}
        </div>
        <div className="truncate text-xs text-neutral-500">{codeMeta(c)}</div>
      </div>
      <button onClick={() => onToggle(c)} className="shrink-0 text-xs text-neutral-600 hover:text-ink">{toggleLabel}</button>
    </li>
  );
}

function renderCodes(codes: DiscountCode[], onToggle: (c: DiscountCode) => void) {
  if (codes.length === 0) {
    return <p className="px-4 py-6 text-center text-xs text-neutral-400">No codes match.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {codes.map((c) => <CodeRow key={c.id} c={c} onToggle={onToggle} />)}
    </ul>
  );
}

function renderKindFields(f: CodeForm, set: (f: CodeForm) => void, sponsors: Sponsor[]) {
  if (f.kind === "promo") {
    return (
      <>
        <Field label="Code" hint="Letters, digits and dashes. Customers type this at the counter.">
          <Input value={f.code} onChange={(e) => set({ ...f, code: e.target.value.toUpperCase() })} placeholder="LAUNCH10" required autoFocus />
        </Field>
        <Field label="Usage limit" hint="Leave empty for unlimited.">
          <Input inputMode="numeric" value={f.max_uses} onChange={(e) => set({ ...f, max_uses: digits(e.target.value) })} />
        </Field>
      </>
    );
  }
  return (
    <>
      <Field label="Sponsor">
        <Select value={f.sponsor_id} onChange={(e) => set({ ...f, sponsor_id: e.target.value })} required>
          <option value="">Pick a sponsor</option>
          {sponsors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
      <Field label="How many coupons" hint="Each code works once. Up to 200 at a time.">
        <Input inputMode="numeric" value={f.count} onChange={(e) => set({ ...f, count: digits(e.target.value) })} required />
      </Field>
    </>
  );
}

function CodeModal({ form, setForm, sponsors, onSave }: { form: CodeForm | null; setForm: (f: CodeForm | null) => void; sponsors: Sponsor[]; onSave: (e: React.FormEvent) => void }) {
  if (!form) {
    return null;
  }
  const title = form.kind === "coupon" ? "Issue sponsor coupons" : "New promo code";
  const valueLabel = form.discount_type === "percent" ? "Percent off" : "Rupees off";
  const submitLabel = form.kind === "coupon" ? "Issue coupons" : "Create code";
  return (
    <Modal open onClose={() => setForm(null)} title={title}>
      <form onSubmit={onSave} className="space-y-3">
        {renderKindFields(form, setForm, sponsors)}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Discount">
            <Select value={form.discount_type} onChange={(e) => setForm({ ...form, discount_type: e.target.value as CodeForm["discount_type"] })}>
              <option value="fixed">Fixed amount</option>
              <option value="percent">Percent</option>
            </Select>
          </Field>
          <Field label={valueLabel}>
            <Input inputMode="numeric" value={form.value} onChange={(e) => setForm({ ...form, value: digits(e.target.value) })} required />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum order" hint="Optional">
            <Input inputMode="numeric" value={form.min_order} onChange={(e) => setForm({ ...form, min_order: digits(e.target.value) })} />
          </Field>
          <Field label="Last valid day" hint="Optional">
            <Input type="date" min={pkToday()} value={form.expires_on} onChange={(e) => setForm({ ...form, expires_on: e.target.value })} />
          </Field>
        </div>
        <Button type="submit" variant="primary" className="w-full">{submitLabel}</Button>
      </form>
    </Modal>
  );
}

function IssuedModal({ issued, onClose }: { issued: string[] | null; onClose: () => void }) {
  if (!issued) {
    return null;
  }
  const copy = async () => {
    await navigator.clipboard.writeText(issued.join("\n"));
    toast("Codes copied");
  };
  const title = issued.length === 1 ? "1 code ready" : `${issued.length} codes ready`;
  return (
    <Modal open onClose={onClose} title={title}>
      <p className="mb-3 text-[13px] text-neutral-500">Hand these to the sponsor to give out. Each one works once.</p>
      <pre className="max-h-64 overflow-y-auto rounded-md bg-neutral-50 p-3 font-mono text-[13px]">{issued.join("\n")}</pre>
      <Button onClick={copy} variant="primary" className="mt-3 w-full">Copy all</Button>
    </Modal>
  );
}

function SponsorModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (id: number) => void }) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  if (!open) {
    return null;
  }
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const d = await api("/api/sponsors", { json: { name, contact } });
      toast(`${name} added`);
      setName("");
      setContact("");
      onSaved(d.id);
    } catch (err: any) {
      toast(err.message, true);
    }
  };
  return (
    <Modal open onClose={onClose} title="Add sponsor">
      <form onSubmit={save} className="space-y-3">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field>
        <Field label="Contact" hint="Optional: phone or email for settling up"><Input value={contact} onChange={(e) => setContact(e.target.value)} /></Field>
        <Button type="submit" variant="primary" className="w-full">Add sponsor</Button>
      </form>
    </Modal>
  );
}

export default function Codes() {
  const [sponsors, setSponsors] = useState<Sponsor[] | null>(null);
  const [codes, setCodes] = useState<DiscountCode[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [form, setForm] = useState<CodeForm | null>(null);
  const [issued, setIssued] = useState<string[] | null>(null);
  const [addSponsor, setAddSponsor] = useState(false);

  const load = () => api("/api/codes").then((d) => {
    setSponsors(d.sponsors);
    setCodes(d.codes);
  });
  useEffect(() => {
    load();
  }, []);
  const matching = codes.filter((c) => (filter === "all" || c.kind === filter) && `${c.code} ${c.sponsor_name || ""}`.toLowerCase().includes(q.toLowerCase()));
  const { shown, pager } = usePaged(matching, 25, `${filter} ${q}`);

  if (sponsors === null) {
    return <Spinner />;
  }

  const owed = sponsors.reduce((s, x) => s + (x.owed || 0), 0);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) {
      return;
    }
    try {
      const json = {
        kind: form.kind,
        sponsor_id: Number(form.sponsor_id),
        count: Number(form.count),
        code: form.code,
        discount_type: form.discount_type,
        value: Number(form.value),
        min_order: Number(form.min_order),
        max_uses: form.max_uses === "" ? null : Number(form.max_uses),
        expires_on: form.expires_on || null,
      };
      const d = await api("/api/codes", { json });
      setForm(null);
      setIssued(d.codes);
      load();
    } catch (err: any) {
      toast(err.message, true);
    }
  };
  const toggle = async (c: DiscountCode) => {
    try {
      await api(`/api/codes/${c.id}`, { method: "PUT", json: { active: !c.active } });
      toast(c.active ? `${c.code} turned off` : `${c.code} turned on`);
      load();
    } catch (err: any) {
      toast(err.message, true);
    }
  };
  const sponsorAdded = (id: number) => {
    setAddSponsor(false);
    load();
    setForm(blankForm("coupon", String(id)));
  };
  const firstSponsor = sponsors.length > 0 ? String(sponsors[0].id) : "";

  return (
    <div className="space-y-4 p-4 md:px-6 md:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Coupons & promo codes</h1>
          <p className="text-sm text-neutral-500">Sponsor coupons work once and the sponsor covers the discount. Promo codes are reusable and the shop covers them.</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setForm(blankForm("promo", ""))}>New promo code</Button>
          <Button variant="primary" onClick={() => setForm(blankForm("coupon", firstSponsor))} disabled={sponsors.length === 0}>Issue coupons</Button>
        </div>
      </div>

      <Card>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-[13px] font-semibold">Sponsors</h2>
            <p className="text-xs text-neutral-500">Owed is the discount on redeemed coupons, from sales that weren't voided. Total {rs(owed)}.</p>
          </div>
          <Button onClick={() => setAddSponsor(true)}>Add sponsor</Button>
        </div>
        {renderSponsors(sponsors)}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div className="flex gap-1 rounded-md bg-neutral-100 p-0.5 text-[12px] font-medium">
            {FILTERS.map((f) => (
              <button key={f.key} onClick={() => setFilter(f.key)} className={cx("rounded-md px-2.5 py-1", filter === f.key && "bg-white shadow-sm", filter !== f.key && "text-neutral-500")}>{f.label}</button>
            ))}
          </div>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code or sponsor" className="sm:w-56" />
        </div>
        {renderCodes(shown, toggle)}
        <Pager {...pager} className="border-t border-line" />
      </Card>

      <CodeModal form={form} setForm={setForm} sponsors={sponsors} onSave={save} />
      <IssuedModal issued={issued} onClose={() => setIssued(null)} />
      <SponsorModal open={addSponsor} onClose={() => setAddSponsor(false)} onSaved={sponsorAdded} />
    </div>
  );
}
