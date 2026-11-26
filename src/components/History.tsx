import { Modal, Pager, Spinner, usePaged } from "./ui";

export type HistoryRow = { key: string | number; label: string; cells: string[]; bar: number };

export function HistoryButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-neutral-500 hover:bg-neutral-100 hover:text-ink" title="Show full history">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>
      History
    </button>
  );
}

function renderNote(note: string | undefined) {
  if (!note) {
    return null;
  }
  return <p className="-mt-2 mb-3 text-xs text-neutral-500">{note}</p>;
}

function headerClass(i: number) {
  if (i === 0) {
    return "pb-2 font-medium";
  }
  return "pb-2 pl-3 text-right font-medium";
}

function HistoryTable({ headers, rows }: { headers: string[]; rows: HistoryRow[] }) {
  const { shown, pager } = usePaged(rows, 25);
  const max = Math.max(1, ...rows.map((r) => r.bar));
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-neutral-500">
            {headers.map((h, i) => <th key={h} className={headerClass(i)}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {shown.map((r) => (
            <tr key={r.key}>
              <td className="py-1.5">
                <div className="font-medium">{r.label}</div>
                <div className="mt-1 h-1 rounded-sm bg-neutral-100"><div className="h-1 rounded-sm bg-accent" style={{ width: `${Math.max(0, (r.bar / max) * 100)}%` }} /></div>
              </td>
              {r.cells.map((c, i) => <td key={i} className="tabular whitespace-nowrap py-1.5 pl-3 text-right text-neutral-600">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <Pager {...pager} className="mt-2 border-t border-line px-0 sm:px-0" />
    </>
  );
}

function renderBody(headers: string[], rows: HistoryRow[] | null) {
  if (!rows) {
    return <Spinner />;
  }
  if (rows.length === 0) {
    return <p className="py-6 text-center text-xs text-neutral-400">No data yet</p>;
  }
  return <HistoryTable headers={headers} rows={rows} />;
}

export function HistoryModal({ open, onClose, title, note, headers, rows }: { open: boolean; onClose: () => void; title: string; note?: string; headers: string[]; rows: HistoryRow[] | null }) {
  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      {renderNote(note)}
      {renderBody(headers, rows)}
    </Modal>
  );
}
