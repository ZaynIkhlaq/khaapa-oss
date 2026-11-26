import { useEffect, useState } from "react";
import { api, imgUrl, rs } from "../api";
import { Badge, Button, Card, Input, ItemImage, Pager, Spinner, cx, toast, usePaged } from "../components/ui";
import { ItemEditor, shrinkImage } from "../components/ItemDialogs";
import { canOperate, type Item } from "../../shared/types";
import { useAuth } from "../auth";
import { ShiftNotice } from "../components/StartShift";

export default function Items() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [modal, setModal] = useState<"new" | Item | null>(null);
  const load = () => api(`/api/items?all=${showArchived ? 1 : 0}`).then((d) => setItems(d.items));
  useEffect(() => { load(); }, [showArchived]);
  const [q, setQ] = useState("");
  const [uploading, setUploading] = useState<number | null>(null);
  const needle = q.trim().toLowerCase();
  const matches = (items ?? []).filter((i) => !needle || i.name.toLowerCase().includes(needle) || i.category.toLowerCase().includes(needle));
  const { shown, pager } = usePaged(matches, 24, needle);
  // Anyone on shift can add and edit items; admins any time.
  const { user, shift } = useAuth();
  const live = canOperate(user, shift);

  const openNew = () => setModal("new");
  const openEdit = (i: Item) => setModal(i);

  const archive = async (i: Item) => {
    if (!confirm(`Archive "${i.name}"? It disappears from the menu and counter; past sales are kept.`)) return;
    await api(`/api/items/${i.id}`, { method: "DELETE" });
    toast("Archived"); load();
  };
  const restore = async (i: Item) => { await api(`/api/items/${i.id}/restore`, { method: "POST" }); toast("Restored"); load(); };
  // Every card has a camera button: snap a photo and it uploads straight away (replacing the old one, if any).
  const addPhoto = async (i: Item, picked: File | undefined) => {
    if (!picked) {
      return;
    }
    setUploading(i.id);
    try {
      const fd = new FormData();
      fd.set("image", await shrinkImage(picked));
      await api(`/api/items/${i.id}`, { method: "PUT", body: fd });
      toast(i.image_key ? `Photo of ${i.name} replaced` : `Photo added to ${i.name}`);
      load();
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setUploading(null);
    }
  };
  const toggleVisible = async (i: Item) => { await api(`/api/items/${i.id}`, { json: { visible: i.visible ? "0" : "1" }, method: "PUT" }); load(); };

  const cats = Array.from(new Set((items ?? []).map((i) => i.category)));

  return (
    <div className="space-y-6 p-4 md:px-6 md:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Menu items</h1>
          <p className="text-sm text-neutral-500">What shows on the public menu and the counter.</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items or categories" className="w-full sm:w-56" />
          <label className="flex items-center gap-1.5 text-xs text-neutral-500"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>
          {live && <Button variant="primary" onClick={openNew}>+ New item</Button>}
        </div>
      </div>
      <ShiftNotice what="add and edit menu items" />

      {items === null ? <Spinner /> : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center">
          <p className="font-medium">No items yet</p>
          <p className="mt-1 text-sm text-neutral-500">Add your first product to get the menu going.</p>
          {live && <Button variant="primary" className="mt-4" onClick={openNew}>+ New item</Button>}
        </div>
      ) : matches.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-400">Nothing matches “{q.trim()}”.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {shown.map((i) => (
            <Card key={i.id} className={cx("relative overflow-hidden", (!!i.archived || !i.visible) && "opacity-60")}>
              <button onClick={() => live && openEdit(i)} className={cx("block w-full text-left", !live && "cursor-default")}>
                <ItemImage src={imgUrl(i.image_key)} name={i.name} className="aspect-[4/3] w-full" />
                <div className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="line-clamp-2 text-sm font-semibold leading-tight">{i.name}</div>
                    <div className="tabular shrink-0 text-sm font-bold">{rs(i.price)}</div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-neutral-500">
                    <span>{i.category}</span>
                    <span>· {i.stock} in stock</span>
                    {i.cost != null && <span>· profit {rs(i.price - i.cost)}/unit</span>}
                  </div>
                  <div className="mt-2 flex gap-1">
                    {i.archived ? <Badge tone="bad">Archived</Badge> : i.visible ? <Badge tone="good">Live</Badge> : <Badge>Hidden</Badge>}
                    {!i.archived && !!i.preorder && <Badge tone="accent">Pre-order</Badge>}
                  </div>
                </div>
              </button>
              {live && !i.archived && <PhotoButton item={i} busy={uploading === i.id} disabled={uploading !== null} onPick={(f) => addPhoto(i, f)} />}
              {live && <div className="flex divide-x divide-line border-t border-neutral-100 text-xs">
                {i.archived ? (
                  <button onClick={() => restore(i)} className="flex-1 py-2 text-neutral-600 hover:bg-neutral-50">Restore</button>
                ) : (
                  <>
                    <button onClick={() => toggleVisible(i)} className="flex-1 py-2 text-neutral-600 hover:bg-neutral-50">{i.visible ? "Hide" : "Show"}</button>
                    <button onClick={() => archive(i)} className="flex-1 py-2 text-neutral-600 hover:bg-red-50 hover:text-red-700">Archive</button>
                  </>
                )}
              </div>}
            </Card>
          ))}
        </div>
      )}
      <Pager {...pager} className="px-0 sm:px-0" />

      <ItemEditor item={modal} categories={cats} onClose={() => setModal(null)} onSaved={() => load()} />
    </div>
  );
}

const CameraIcon = ({ className }: { className: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="3.5" /></svg>
);
const SmallSpinner = () => <span className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-ink" />;

// No photo: the whole image area is the camera button. With a photo: a small round camera button in its corner.
function PhotoButton({ item, busy, disabled, onPick }: { item: Item; busy: boolean; disabled: boolean; onPick: (f: File | undefined) => void }) {
  const input = <input type="file" accept="image/*" capture="environment" className="hidden" disabled={disabled} onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = ""; }} />;
  if (!item.image_key) {
    return (
      <label className="absolute inset-x-0 top-0 flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-1 bg-black/5 text-neutral-600 hover:bg-black/10">
        {busy ? <SmallSpinner /> : <><CameraIcon className="h-8 w-8" /><span className="rounded-full bg-white/90 px-2 py-0.5 text-xs font-medium">Add photo</span></>}
        {input}
      </label>
    );
  }
  return (
    <label title="Take a new photo" className="absolute right-2 top-2 grid h-9 w-9 cursor-pointer place-items-center rounded-full bg-white/90 text-neutral-700 shadow ring-1 ring-black/5 hover:bg-white">
      {busy ? <SmallSpinner /> : <CameraIcon className="h-5 w-5" />}
      {input}
    </label>
  );
}
