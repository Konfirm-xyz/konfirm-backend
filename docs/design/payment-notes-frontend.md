# Payment detail panel with investigation notes thread

**Issue:** #34 — No dispute/investigation notes on payments beyond a one-shot status-change reason  
**Backend:** migration `028_payment_notes`, `AdminPaymentNotesService`,  
`POST /admin/payments/:id/notes`, `GET /admin/payments/:id/notes`

---

## Problem

Admins reviewing a held or disputed payment have no way to record context without
changing the payment's status. The only available mechanism is the `reason` field
on the status-change form — a `window.prompt()` that writes one line to the global
activity feed and is gone from the payment record once the feed scrolls off.

## What to build

Two things, added to `konfirm-frontend/src/app/admin/payments/`:

1. **Payment detail panel** — a slide-over / drawer that opens when an admin clicks
   a row in the existing payments table. It shows the payment's full details (what
   the list already shows, plus tx hash and flag reason) and hosts the notes thread
   below them.

2. **Notes thread** — an ordered list of notes oldest-first with a compose box at
   the bottom, inside the detail panel.

No new page is needed. A slide-over keeps context visible (the payments table stays
underneath) and doesn't break the current URL structure.

---

## API endpoints

### `GET /admin/payments/:id/notes`

Returns the full notes thread for one payment, oldest first.

```json
[
  {
    "id": "uuid",
    "payment_id": "uuid",
    "body": "Confirmed with merchant via email. Releasing.",
    "created_at": "2026-10-19T01:00:00.000Z",
    "admin_id": "uuid",
    "admin_name": "Ops Admin"
  }
]
```

Returns `404` if the payment id doesn't exist.  
Returns an empty array `[]` when the payment has no notes yet.

### `POST /admin/payments/:id/notes`

Appends a note. Body:

```json
{ "body": "text, 1–5000 chars" }
```

Returns `201` with the created note:

```json
{
  "id": "uuid",
  "payment_id": "uuid",
  "body": "Confirmed with merchant via email. Releasing.",
  "created_at": "2026-10-19T01:05:00.000Z"
}
```

Returns `404` if the payment doesn't exist.  
Returns `400` if `body` is empty or exceeds 5000 characters.

---

## Component sketch

```
payments/page.tsx          (existing)
  └─ PaymentsTable         (existing — add onClick to open panel)
  └─ PaymentDetailPanel    (new)
       ├─ PaymentSummary   (payment fields: amount, status, flag_reason, tx_hash…)
       └─ NotesThread      (new)
            ├─ NoteItem[]  (author, timestamp, body)
            └─ AddNoteForm (textarea + submit)
```

Keep them in `src/app/admin/payments/` or a `components/` subfolder of it —
consistent with where `changeStatus` already lives in `page.tsx`.

---

## `PaymentDetailPanel`

```tsx
// src/app/admin/payments/PaymentDetailPanel.tsx
'use client';

import { useState, useEffect } from 'react';

interface Payment {
  id: string;
  amount_usdc: string;
  asset_code: string;
  payer_address: string;
  status: string;
  flag_reason: string | null;
  tx_hash: string | null;
  created_at: string;
  merchant_name: string;
  merchant_email: string;
}

interface Note {
  id: string;
  payment_id: string;
  body: string;
  created_at: string;
  admin_id: string | null;
  admin_name: string | null;
}

interface Props {
  payment: Payment | null;
  onClose: () => void;
}

export function PaymentDetailPanel({ payment, onClose }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteBody, setNoteBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load notes whenever the selected payment changes.
  useEffect(() => {
    if (!payment) return;
    setNotes([]);
    setError(null);
    fetch(`/api/admin/payments/${payment.id}/notes`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(setNotes)
      .catch(() => setError('Failed to load notes.'));
  }, [payment?.id]);

  async function submitNote(e: React.FormEvent) {
    e.preventDefault();
    if (!payment || !noteBody.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/admin/payments/${payment.id}/notes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: noteBody.trim() }),
      });
      if (!r.ok) throw new Error(await r.text());
      const note: Note = await r.json();
      setNotes((prev) => [...prev, note]);
      setNoteBody('');
    } catch {
      setError('Failed to save note. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!payment) return null;

  return (
    // Slide-over overlay — adapt class names to whatever Tailwind/CSS-in-JS
    // the frontend already uses for drawers.
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col bg-white shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <h2 className="text-lg font-semibold">Payment</h2>
        <button onClick={onClose} aria-label="Close panel">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* Payment summary */}
        <section>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-gray-500">ID</dt>
            <dd className="font-mono text-xs">{payment.id}</dd>

            <dt className="text-gray-500">Amount</dt>
            <dd>{payment.amount_usdc} {payment.asset_code}</dd>

            <dt className="text-gray-500">Status</dt>
            <dd>{payment.status}</dd>

            {payment.flag_reason && (
              <>
                <dt className="text-gray-500">Flag reason</dt>
                <dd>{payment.flag_reason}</dd>
              </>
            )}

            <dt className="text-gray-500">Merchant</dt>
            <dd>{payment.merchant_name}</dd>

            <dt className="text-gray-500">Payer</dt>
            <dd className="font-mono text-xs truncate">{payment.payer_address}</dd>

            {payment.tx_hash && (
              <>
                <dt className="text-gray-500">Tx hash</dt>
                <dd className="font-mono text-xs truncate">{payment.tx_hash}</dd>
              </>
            )}

            <dt className="text-gray-500">Date</dt>
            <dd>{new Date(payment.created_at).toLocaleString()}</dd>
          </dl>
        </section>

        {/* Notes thread */}
        <section>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">Investigation notes</h3>

          {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

          {notes.length === 0 ? (
            <p className="text-sm text-gray-400">No notes yet.</p>
          ) : (
            <ul className="space-y-3">
              {notes.map((note) => (
                <li key={note.id} className="rounded border border-gray-100 bg-gray-50 p-3 text-sm">
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="font-medium">{note.admin_name ?? 'Admin'}</span>
                    <span className="text-xs text-gray-400">
                      {new Date(note.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-gray-800">{note.body}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Compose box — pinned to the bottom of the panel */}
      <form onSubmit={submitNote} className="border-t px-6 py-4 space-y-2">
        <label htmlFor="note-body" className="block text-sm font-medium text-gray-700">
          Add note
        </label>
        <textarea
          id="note-body"
          className="w-full rounded border border-gray-300 p-2 text-sm"
          rows={3}
          maxLength={5000}
          placeholder="Leave context for the next reviewer…"
          value={noteBody}
          onChange={(e) => setNoteBody(e.target.value)}
          disabled={submitting}
        />
        <button
          type="submit"
          disabled={submitting || !noteBody.trim()}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Add note'}
        </button>
      </form>
    </div>
  );
}
```

---

## Wiring it into `page.tsx`

The existing payments page at `src/app/admin/payments/page.tsx` has a `changeStatus`
function and renders a table. Add:

```tsx
// 1. State for the selected payment
const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);

// 2. Make table rows clickable
// In your <tr> or row-level element add:
onClick={() => setSelectedPayment(payment)}
className="cursor-pointer hover:bg-gray-50"

// 3. Render the panel (import from ./PaymentDetailPanel)
<PaymentDetailPanel
  payment={selectedPayment}
  onClose={() => setSelectedPayment(null)}
/>

// 4. Optional: backdrop to close on outside click
{selectedPayment && (
  <div
    className="fixed inset-0 z-30 bg-black/20"
    onClick={() => setSelectedPayment(null)}
  />
)}
```

---

## Accessibility notes

- The panel should be a `<dialog>` or have `role="dialog"` and `aria-modal="true"`.
- Trap focus inside the open panel (`focus-trap-react` or a custom hook).
- `Escape` key should close it — wire `onKeyDown` on the overlay or use `<dialog>`'s
  native close behavior.
- The compose `<textarea>` already has a `<label>` with `htmlFor`.

---

## What stays unchanged

- The existing `changeStatus` flow (`window.prompt` → `PATCH /admin/payments/:id/status`)
  is untouched. Notes are additive — an admin can add a note and change the status
  independently or together.
- The global activity feed (`GET /admin/activity`) already surfaces `payment.note-added`
  entries because the backend logs every note creation to `admin_actions`. No changes
  needed there.
