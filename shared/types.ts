export type Role = "admin" | "staff";

// A shift closes itself this long after it starts; people start a new one if they're staying.
export const SHIFT_MINUTES = 60;

// Three kinds of people: everyone approved is a user; on top of that someone can be HR and/or admin.
// Users work the shop once they start a shift (counter, stock, payments, pre-orders). Admins can do that without a
// shift and also approve people and run the setup (menu, prices, coupons, money). HR runs the schedule.
export type Scope = "admin" | "hr";
export const SCOPES: { key: Scope; label: string; desc: string }[] = [
  { key: "hr", label: "HR", desc: "lets people in, schedule, slots, attendance" },
  { key: "admin", label: "Admin", desc: "everything HR does, plus menu, prices, coupons, money; works without a shift" },
];
// Selling, stock, payments and pre-orders need an open shift; admins are exempt.
export const canOperate = (u: { scopes?: Scope[] } | null | undefined, shift: unknown) => hasScope(u, "admin") || !!shift;
export const hasScope = (u: { scopes?: Scope[] } | null | undefined, s: Scope) => !!u?.scopes && (u.scopes.includes("admin") || u.scopes.includes(s));

export interface User {
  id: number;
  username: string;
  name: string;
  email: string | null;
  picture: string | null;
  role: Role;
  active: number;
  approved: number;
  is_hr: number;
  /** Can give an AI agent write access through /mcp (owner always; set by migration/SQL only). */
  mcp_write: number;
  scopes: Scope[];
  created_at: string;
}

// Prices are rupees with up to 2 decimals (e.g. a buy price of Rs 4.17 from a box of 24). Round every
// price and every total to the paisa so floating-point noise never shows up.
export const round2 = (n: number) => Math.round(n * 100) / 100;
// Parses a price field: a number ≥ 0 with at most 2 decimals, or null for empty / invalid input.
export const parsePrice = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
};

// The counter's "Extra" amount (it only ever raises the total) is booked as revenue on this item.
export const EXTRA_ITEM = "Stickers";
export const isExtraItem = (i: { name: string; archived?: number }) => !i.archived && /^stickers?$/i.test(i.name.trim());

// Menu categories anyone can pick. Admins can add another; once an item uses it, it shows up for everyone.
export const CATEGORIES = ["Snacks", "Drinks"];

export interface Item {
  id: number;
  name: string;
  category: string;
  price: number;
  cost: number | null;
  stock: number;
  low_stock_at: number;
  image_key: string | null;
  visible: number;
  archived: number;
  preorder: number;
  sold?: number; // units sold in the last 30 days (GET /api/items)
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type PublicItem = Pick<Item, "id" | "name" | "category" | "price" | "image_key"> & {
  availability: "in" | "low" | "out";
};

export interface Shift {
  id: number;
  user_id: number;
  user_name?: string;
  started_at: string;
  ended_at: string | null;
  opening_cash: number | null;
  closing_cash: number | null;
  note: string | null;
  sales_count?: number;
  sales_total?: number;
}

export interface Sale {
  id: number;
  user_id: number;
  user_name?: string;
  shift_id: number | null;
  subtotal: number | null;
  discount: number;
  code?: string | null;
  total: number;
  payment: "cash" | "online";
  note: string | null;
  voided_at: string | null;
  created_at: string;
  items?: SaleItem[];
}

export interface SaleItem {
  id: number;
  sale_id: number;
  item_id: number;
  name: string;
  unit_price: number;
  unit_cost: number | null;
  qty: number;
  // 1 = extra money the customer added on top at the counter, booked on the Stickers item (no stock, no buy price).
  extra?: number;
}

export interface StockMove {
  id: number;
  item_id: number;
  item_name?: string;
  user_id: number;
  user_name?: string;
  delta: number;
  reason: "restock" | "sale" | "void" | "waste" | "correction";
  note: string | null;
  sale_id: number | null;
  // The item's buy price when the move happened.
  unit_cost: number | null;
  created_at: string;
}

export interface Activity {
  id: number;
  user_id: number | null;
  user_name?: string;
  action: string;
  entity: string | null;
  entity_id: number | null;
  details: string | null;
  created_at: string;
}

// profit = what customers paid − what we paid for the goods (buy price × qty).
export interface Stats {
  today: { revenue: number; profit: number; sales: number; items: number };
  week: { revenue: number; profit: number; sales: number };
  all: { revenue: number; profit: number; sales: number };
  by_day: { day: string; revenue: number; profit: number; sales: number }[];
  by_cashier: { user_id: number; name: string; revenue: number; profit: number; sales: number }[]; // highest profit first
  top_items: { item_id: number; name: string; qty: number; revenue: number; profit: number }[];
  top_profit: { item_id: number; name: string; qty: number; revenue: number; profit: number }[];
  units_without_cost: number;
  stock_value: { at_cost: number; at_price: number; profit: number; no_cost: number };
  last_24h: { hour: string; revenue: number; profit: number; sales: number }[]; // hour = "YYYY-MM-DDTHH:00" PKT
  low_stock: { id: number; name: string; stock: number; low_stock_at: number }[];
  by_hour: { hour: number; sales: number }[];
  payment_split: { payment: string; revenue: number; sales: number }[];
}

// Full history behind the Stats charts: every hour and day with a sale, every item ever sold.
export interface StatsHistory {
  by_hour: Stats["last_24h"];
  by_day: Stats["by_day"];
  items: Stats["top_items"];
}

// ---------- coupons & promo codes ----------
export interface Sponsor {
  id: number;
  name: string;
  contact: string | null;
  coupons?: number;
  redeemed?: number;
  owed?: number;
}

export interface DiscountCode {
  id: number;
  code: string;
  kind: "coupon" | "promo";
  sponsor_id: number | null;
  sponsor_name?: string | null;
  discount_type: "fixed" | "percent";
  value: number;
  min_order: number;
  max_uses: number | null;
  uses: number;
  expires_on: string | null;
  active: number;
  created_at: string;
}

export type CodeRule = Pick<DiscountCode, "id" | "code" | "kind" | "discount_type" | "value" | "min_order"> & { sponsor_name: string | null };

export function discountFor(rule: Pick<DiscountCode, "discount_type" | "value" | "min_order">, subtotal: number): number {
  if (subtotal < rule.min_order) return 0;
  const d = rule.discount_type === "percent" ? Math.floor((subtotal * Math.min(rule.value, 100)) / 100) : rule.value;
  return Math.min(d, subtotal);
}

// ---------- schedule ----------
export interface Slot {
  id: number;
  user_id: number;
  user_name: string;
  starts_at: string;
  ends_at: string;
  note: string | null;
  reminded_at: string | null;
  pick_id?: number | null; // set when the slot comes from a pick
}

// Slots people pick for themselves, one week at a time (never repeated): Monday to Friday, starting 8:40 (Pakistan time).
export const PICK_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]; // weekday 1..5

export interface PickSlot {
  start: string;
  end: string;
}

export const PICK_SLOTS: readonly PickSlot[] = [
  { start: "08:40", end: "09:40" },
  { start: "09:40", end: "10:40" },
  { start: "10:40", end: "11:40" },
  { start: "11:40", end: "12:40" },
  { start: "12:40", end: "14:00" },
  { start: "14:00", end: "14:40" },
  { start: "14:40", end: "15:40" },
  { start: "15:40", end: "17:00" },
];

export const PICK_TIMES = PICK_SLOTS.map((s) => s.start);
export const PICK_MINUTES = 60; // fallback default minutes

export const pickEndFor = (start: string): string => {
  const found = PICK_SLOTS.find((s) => s.start === start);
  if (found) return found.end;
  const [h, m] = start.split(":").map(Number);
  const endMin = (h || 0) * 60 + (m || 0) + PICK_MINUTES;
  return `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
};

export const pickMinutesFor = (start: string): number => {
  const found = PICK_SLOTS.find((s) => s.start === start);
  if (!found) return PICK_MINUTES;
  const [sh, sm] = found.start.split(":").map(Number);
  const [eh, em] = found.end.split(":").map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
};

// The daily attendance report is saved at this time, Pakistan time (worker/report.ts).
export const REPORT_AT = "17:00";
export const PICK_CAP = 3; // people per block (also a trigger in migration 0024)
// Window event: slots changed outside the Schedule page (a swap accepted from the bell), so it reloads at once.
export const SLOTS_CHANGED = "khaapa:slots-changed";
export const PICKS_MIN = 2; // everyone picks at least this many each week, no upper limit

export interface SlotPick {
  id: number;
  user_id: number;
  user_name: string;
  week: string; // Monday of the week, YYYY-MM-DD
  weekday: number;
  start: string;
}

export interface SlotSwap {
  id: number;
  from_user_id: number;
  from_user_name: string;
  to_user_id: number;
  to_user_name: string;
  from_slot_id: number;
  from_slot_start: string;
  from_slot_end: string;
  to_slot_id: number;
  to_slot_start: string;
  to_slot_end: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  note: string | null;
  created_at: string;
  responded_at: string | null;
}

export interface ShiftRequest {
  id: number;
  user_id: number;
  user_name: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reviewed_by: number | null;
  reviewed_by_name?: string | null;
  note: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface NotificationsData {
  swaps: SlotSwap[];
  shift_requests: ShiftRequest[];
  my_shift_request: ShiftRequest | null;
}

export interface Attendance {
  from: string; // first day, YYYY-MM-DD Pakistan time
  today: string;
  now: string;
  shifts: { id: number; user_id: number; user_name: string; started_at: string; ended_at: string | null; sales_count: number; sales_total: number }[];
  slots: { id: number; user_id: number; user_name: string; starts_at: string; ends_at: string; note: string | null }[];
  users: { id: number; name: string; picture: string | null; scopes: string }[];
}

// ---------- pre-orders ----------
export type PreorderStatus = "new" | "paid" | "collected" | "cancelled";
export const preorderCode = (id: number) => `PO-${id}`;

export interface PreorderLine {
  id: number;
  preorder_id: number;
  item_id: number;
  name: string;
  unit_price: number;
  qty: number;
}

export interface Preorder {
  id: number;
  code?: string;
  name: string;
  phone: string;
  pickup_on: string;
  note: string | null;
  total: number;
  status: PreorderStatus;
  sale_id: number | null;
  handled_by: number | null;
  handled_by_name?: string | null;
  token?: string | null;
  proof_key?: string | null;
  has_proof?: boolean;
  created_at: string;
  updated_at: string;
  lines?: PreorderLine[];
}

// payments.source: 'nayapay' rows come from the Gmail inbox. 'sadapay' is kept for rows from other sources.
export const walletName = (source: string | null | undefined) => (source === "sadapay" ? "SadaPay" : "NayaPay");

export interface PreorderSettings {
  nayapay_number: string;
  nayapay_name: string;
  sadapay_number: string;
  sadapay_name: string;
  whatsapp: string;
}

/** Where your shop is. Used in copy and the landing-page map. Edit this (and index.html) for your own shop;
 *  set lat/lng to null to hide the map. */
export const SHOP_PLACE: { name: string; campus: string; lat: number | null; lng: number | null } = { name: "Main Block", campus: "Your Campus", lat: null, lng: null };
