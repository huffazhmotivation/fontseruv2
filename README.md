# FontSeru

**FontSeru** is a modern, browser‑based vector **type & font design studio**.
Draw letterforms with a real Bézier engine, edit them Affinity‑style, and keep
everything as clean, independent vector geometry — all client‑side.

---

## Running it locally

Requires [Node.js](https://nodejs.org) 18+. This project uses **yarn**.

```bash
yarn install
yarn dev        # Vite dev server (hot reload) — prints a localhost URL
```

Other scripts:

```bash
yarn start      # dev server bound to 0.0.0.0:3000 (used in hosted preview)
yarn build      # type-checks (tsc -b) then produces a production build in dist/
yarn preview    # serves the production build
yarn typecheck  # tsc -b --noEmit
```

---

## What changed in this upgrade

### 1. Independent‑object data model (fixes accidental holes)
The glyph outline is no longer one flat list of contours rendered with a single
`even‑odd` fill. Each drawn thing is now an **independent `VectorObject`** and is
rendered as **its own path with `nonzero` fill**. Consequences:

- Two shapes that **touch or overlap stay fully filled** — no transparent/black
  hole where they cross. This holds after moving, resizing, rotating, editing
  Bézier handles, expanding strokes and copy/paste.
- A **counter/hole** (the inside of `O`, `A`, `P`, `R`, `B`) is only created when
  you intentionally add a second contour *inside the same shape object*.

Geometry kinds are explicitly distinguished (`src/types/geometry.ts`):

| Kind | Meaning | Rendering |
|---|---|---|
| `shape` | Closed filled outline (may contain intentional counters) | filled `nonzero` |
| `line` | Open **centerline monoline** (Pen › Line) with a width | SVG stroke |
| `brush` | Editable **centerline** with brush settings + pressure samples | SVG stroke |
| `expanded` | Closed outline generated from a stroke via **Expand Stroke** | filled `nonzero` |

### 2. Object Select / Transform tool (`V`)
A true vector select tool: click to select, drag to move, **corner/edge handles**
to resize (**Shift** = proportional), a **top handle to rotate** (**Shift** = 15°
snaps), **marquee** selection on empty canvas, **Shift‑click** multi‑select,
arrow‑key nudging (**Shift** = ×10). Clearly separate from Node / Pen / Brush.

### 3. Cursor‑centered canvas zoom
`Ctrl/Cmd + wheel` (and trackpad **pinch**) zooms **toward the cursor**; a plain
wheel pans. The page never scrolls while over the canvas. **Fit**, **Reset** and
the zoom % control all still work, with sensible 20–800% limits.

### 4. Pen — Shape vs Line
- **Shape**: closed, filled contour; click near the first node to close.
- **Line**: a real **open centerline monoline** with adjustable width and
  **butt / round / square caps** — it is **never** auto‑outlined. Width/cap
  changes leave centerline nodes untouched. Expand later when you want a filled
  outline; expansion preserves the chosen cap.

### 5. Brush — inline centerline strokes + Expand
Brush strokes stay as **editable centerlines** (width, brush profile and pressure
samples preserved) rather than being flattened to outlines immediately. Presets
(**Basic Round, Monoline, Marker, Calligraphic, Pencil, Pressure Taper**) each
have an icon, name and description. **Monoline** uses the same editable
centerline cap model as Pen › Line. Select a stroke and press **Expand Stroke**
to bake it into a closed `expanded` outline — non‑destructive until then.

### 6. Advanced node editing (Affinity‑style)
- Multi‑node **marquee** + **Shift‑click** add/remove; move the group together.
- **Double‑click a segment** inserts a node exactly there (De Casteljau split).
- **Cmd/Ctrl‑drag a segment** bends it into a Bézier curve with real handles.
- Draggable smooth / symmetric / corner handles; **Alt‑drag** breaks a handle
  free; **Shift** constrains handle angle to 45°.
- Distinct visuals for corner / smooth / symmetric / selected nodes and handles.

### 7. Live glyph thumbnails
The left navigator renders each tile from the glyph's **actual vector data**.
Edit `A` and the `A` tile updates to your custom letter; undrawn glyphs fall back
to the reference character. Edited glyphs show a subtle dot indicator.

### 8. Copy / paste vector objects
`Cmd/Ctrl + C / V / X` and `Delete`/`Backspace` operate on real path geometry
(not rasters). Copy an `O`, switch to `Q`, paste, reposition, add a tail.

### 9. Rebrand → **FontSeru**
Brand, browser title, package metadata and README all updated.

### 10. Visual / UX redesign
Original dark‑first system: near‑black charcoal canvas, a single restrained
**lime/acid** accent, Inter (UI) + JetBrains Mono (numeric) typography, refined
toolbar/tool states, modern glyph cards, collapsible property sections, cleaner
guides/grid, professional node & selection rendering, minimal bottom bar.

### 11. Persistence
Edited glyphs + font name persist across a full reload via **IndexedDB**
(`src/glyph/persist.ts`).

---

## Phase 6 — Auto Kerning + Font Test Lab

Two new, additive features, reached from the top bar (**Kerning** / **Preview**
buttons) as a full-screen overlay. Closing it (✕ or `Esc`) returns to the
editor exactly as it was — nothing about the main layout, canvas, or tools
changes when the overlay is closed.

### A. Auto Kerning
- **Data model** (`types/kerning.ts`): `kerningPairs: Record<"L|R", number>`,
  kept entirely separate from glyph geometry, plus `kerningManual` — a set
  of pair keys the user has explicitly touched. **Auto-kern never
  overwrites a manual override** (enforced centrally in the store action,
  not just in the UI).
- **Geometry-based suggestions** (`kerning/autoKern.ts`): analyzes each
  glyph's actual ink bounding box (falling back to its side-bearings if
  nothing's drawn yet) to estimate a natural gap and suggest a kerning
  value that closes it toward a comfortable optical target. This is a
  **whole-glyph bounding-box approximation**, not a true per-scanline
  optical-kerning profile — see *Known limitations*.
- **Kerning Editor tab**: type or select any available glyph pair, then
  **drag the right glyph horizontally** for the primary adjustment; numeric
  entry remains available for precision. **Auto Kerning** analyzes every
  ordered pair in the currently available glyph set in one pass, applies the
  results immediately, and skips manual overrides. A completion status reports
  how many pairs were processed/updated and how many manual pairs were preserved.
- Fully integrated with the existing **undo/redo** stack (extended, not
  replaced — see *Architecture note* below) and **IndexedDB persistence**.

### B. Font Test Lab
- **`editor/GlyphRun.tsx`** — the core of this feature: lays out a string
  using each character's *actual* `advanceWidth` + kerning pairs, and
  renders every glyph's real vector objects (reusing the exact same
  fill/centerline/brush rendering rules as `GlyphThumbnail`, for
  consistency). **Never falls back to a system font** — an undrawn glyph
  renders as blank space at its advance width, not a substitute glyph.
- **Specimen tab**: **Custom Text is the primary left-side editor** and is
  immediately editable, with Uppercase, Lowercase, Numbers, Kerning Pairs,
  Pangrams, Paragraph and **All Glyphs** available as quick preview presets.
- Controls: font size, line height, tracking, alignment, dark/light
  preview background — all update the render immediately, no reload.
- Respects the project's actual font metrics (UPM, ascender, descender,
  cap-height, x-height) throughout.

### Architecture note (the one necessary touch to an existing system)
Kerning needed to share the existing, proven undo/redo stack rather than
invent a second one. `HistoryEntry` was extended from `{ glyphs }` to
`{ glyphs, kerningPairs, kerningManual }`, and `commit`/`undo`/`redo` now
carry all three. **Every existing call site of `commit(nextGlyphs)` is
unchanged** — the function still takes just the glyph map; it now also
snapshots the *current* (unchanged) kerning state alongside it, so glyph
edits round-trip through undo/redo exactly as before. A 2-line guard was
added to `useKeyboardShortcuts` so global tool/undo/clipboard shortcuts
don't fire while typing inside the Kerning/Test Lab overlay.

---

## Refinement pass — grid, brushes, kerning-in-context, editable preview

Targeted, additive polish on top of the Phase 6 baseline. No layout,
data model, or existing-tool rewrites.

- **Custom grid size** — a `[-] 50u [+]` stepper next to the Grid toggle
  in the bottom bar (`store.gridSize`, 2–200 units). Deliberately scoped
  to the **visual** grid only; the Pen/Node snap increment is untouched
  on purpose, so this can't change existing placement precision as a
  side effect.
- **Double-click Select → Node** — double-clicking an object with the
  Select tool active switches to the Node tool and selects every node
  in that object, matching the "jump straight into editing" behavior of
  professional vector editors.
- **Two new brush presets** — **Grunge** (deterministic, non-flickering
  two-octave noise perturbing the nib radius per sample — a real
  irregular vector outline, not a raster texture) and **Pixel** (stroke
  samples snap to the canvas grid as they're captured, with zero
  smoothing, producing a genuinely blocky/staircase vector path suitable
  for pixel-font work). Both are just new parameter sets through the
  existing shared brush engine, consistent with how every other preset
  already works.
- **Kerning workspace**: a new **"Test in context"** free-text field
  renders any typed string live (via the same `GlyphRun` component used
  everywhere else), so a pair's kerning can be checked in real usage
  alongside the dedicated two-glyph pair editor — which stays, since
  dragging still needs a concrete two-glyph target. While dragging the
  right glyph, two dashed vertical **ruler guides** now appear — one at
  the natural (zero-kerning) boundary, one tracking the live dragged
  position with its current value — FontLab-style visual feedback.
- **Test Lab**: the separate "Custom Text" box is gone. The preview
  itself is now directly editable — click anywhere in it and type
  (implemented as a transparent, full-preview `<textarea>` layered over
  the real glyph rendering, so clicks/typing land on it while only the
  vector glyphs are visible). Clicking a preset (Uppercase, Pangrams,
  etc.) loads that text into the same editable buffer, which you can then
  keep typing over. The Paragraph specimen is now several sentences
  covering upper/lowercase, digits, and punctuation instead of four
  short lines. Alignment and Preview Background switched from bordered
  segmented buttons to minimalist underline text-tabs.
- **Verified, not re-implemented**: read through the marquee/selection
  code path in full — dragging a just-marquee-selected group of nodes
  already works immediately (no extra selection step) for every object
  kind (shape/line/brush/expanded), since the node editor iterates
  `outline.objects` generically with no kind-specific filtering. No
  change was needed there.

**Known limitation of the editable-preview overlay**: the invisible
textarea's native caret is a best-effort approximation — it tracks line
height correctly but won't perfectly align horizontally with your custom
glyph widths (no browser textarea can lay out text using arbitrary vector
glyph metrics). This is disclosed in the panel's own hint text, not
hidden.

---

## Architecture

```
src/
├── components/   UI chrome: TopBar, LeftToolbar, GlyphNav, RightPanel, BottomBar, GlyphThumbnail
├── editor/       Vector engine:
│   ├── GlyphCanvas.tsx     SVG canvas, viewBox zoom/pan, wheel zoom, rendering
│   ├── useGlyphEditor.ts   Pen + Node interaction (curve-drag, insert, marquee)
│   ├── useSelectTool.ts    Object selection + move/resize/rotate transforms
│   ├── useBrushTool.ts     Brush capture -> editable centerline object
│   ├── objectOps.ts        Bounds, transforms, hit-testing, clone, flatten
│   ├── nodeOps.ts          Node/contour mutations (across objects)
│   ├── pathBuilder.ts      Object -> SVG path (fill vs centerline stroke)
│   ├── hitTest / segmentHitTest / bezier / coords
│   └── GhostGlyph.tsx
├── brushes/      Presets + stroke→centerline / centerline→outline / Expand
├── kerning/      Geometry-based auto-kerning suggestion (Phase 6)
├── glyph/        Store (zustand), default glyphs, IndexedDB persistence
├── types/        geometry (objects!), glyph, font, tool, brush, kerning
├── components/TestLab/  Kerning editor + Font Test Lab overlay (Phase 6)
├── hooks/        Keyboard shortcuts (tools, undo/redo, clipboard, nudge)
├── utils/        geometry math, id, unicode, polyline simplify
└── styles/       Design tokens + layout CSS (dark-first, light supported)
```

Coordinate space is **font units, Y‑up, baseline = 0** (opentype.js convention),
so a later export phase can consume `Glyph.outline` directly.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `V` / `N` / `P` / `B` | Select / Node / Pen / Brush |
| `H` / `Z` | Hand (pan) / Zoom |
| `Space` (hold) | Temporary pan |
| `Ctrl/Cmd` + wheel · pinch | Zoom toward cursor |
| Drag (Select) | Move · marquee on empty canvas |
| Handles (Select) | Resize (Shift = proportional) · top handle rotates (Shift = 15°) |
| Arrows (Select/Node) | Nudge selection (Shift = ×10) |
| Double‑click segment (Node) | Insert a node |
| `Ctrl/Cmd` + drag segment (Node) | Bend into a Bézier curve |
| Double‑click node (Node) | Cycle Corner / Smooth / Symmetric |
| Click current endpoint (Pen) | Convert Smooth/Symmetric endpoint to Corner in place |
| Double‑click current endpoint (Pen) | Finish path; next click starts an independent path |
| `Alt` + drag handle | Break handle free |
| `Shift` + drag handle | Snap angle to 45° |
| `Ctrl/Cmd` + `C` / `V` / `X` | Copy / Paste / Cut objects |
| `Delete` / `Backspace` | Delete selected objects (Select) / nodes (Node) |
| `Esc` | End open contour (Pen) / cancel brush stroke |
| `Ctrl/Cmd` + `Z` / `Shift+Z` | Undo / Redo |
| `Esc` (Kerning/Test Lab open) | Close the overlay |

---

## Known limitations (stated plainly)
- **Brush pressure on Expand** uses the captured samples; if you heavily reshape a
  brush centerline by node‑editing it first, Expand falls back to a uniform width
  along the edited path.
- **Rotation/scale bake into geometry** (no persisted transform matrix) — simple
  and predictable, but repeated rotations accumulate tiny floating‑point drift.
- **Eraser / Shape (rect/ellipse) / Import** tools remain intentionally disabled
  (later phase) and are shown greyed out rather than half‑working.
- **No font export yet** — that is a later phase; the data model is export‑ready.
- **Auto-kerning is a bounding-box approximation**, not a true per-scanline
  optical kerning profile. It reads each glyph's real ink extent (or its
  side-bearings, if undrawn) and estimates a value from that — genuinely
  geometry-driven, but it can't detect that (say) a diagonal stroke only
  protrudes near the baseline and not near the cap-height. Good enough as
  "a strong starting point," per the original project brief's own framing
  of what auto-kerning should be — not claimed as final professional
  spacing.
- **Font Test Lab has no dynamic word-wrap.** Paragraph and Custom Text use
  fixed line breaks (`\n`-separated); a long single line will overflow
  and require horizontal scrolling rather than reflowing.
- **Kerning applies between literal adjacent characters only** — no
  contextual/class-based kerning. Global Auto Kerning analyzes all available
  literal pairs; manual editing still works pair-by-pair.
- The repository ZIP does not include `node_modules`; install dependencies
  before running Vite locally. Source-level TypeScript parsing and internal
  import resolution can still be checked without changing the application.

---

## Supabase login (Free / Pro gate)

FontSeru now opens behind a **mandatory, non-dismissable** login popup
backed by Supabase (`@supabase/supabase-js`), using **email + password**
authentication (`signInWithPassword` / `signUp`) — magic link / OTP is not
used for normal login.

### Setup
1. Copy `.env.example` to `.env` and fill in:
   - `VITE_SUPABASE_URL` — your Supabase project's base URL.
   - `VITE_SUPABASE_PUBLISHABLE_KEY` — the public/publishable ("anon") key.
     **Never** put the `service_role`/secret key here or anywhere in
     frontend code.
   - `VITE_PRO_WHATSAPP_NUMBER` — WhatsApp number for the "Berminat
     menggunakan fitur PRO?" CTA (any common format; digits are extracted
     automatically for the `wa.me` link).
2. In the Supabase SQL editor, run `supabase/sql/profiles_policies.sql`
   once so the app can read rows in `public.profiles` under RLS.
3. In the Supabase Dashboard → Authentication → Providers → Email, make
   sure "Email" is enabled. Turn "Confirm email" on or off depending on
   whether you want new sign-ups to verify their address before their
   first login (the app supports both — see below).
4. In Authentication → URL Configuration, add your app's origin (e.g.
   `http://localhost:5173` for local dev, and your production URL) to
   **Redirect URLs** — both email confirmation and password-reset links
   redirect back to the app's own origin.
5. Restart `yarn dev` after editing `.env`.

### How it works
- On load, if there's no authenticated session yet, a login popup appears
  (styled with the app's existing dark/light tokens, radii and typography
  — no default Supabase UI) and **cannot be dismissed**: no close button,
  clicking the backdrop does nothing, Escape does nothing, and the editor
  behind it is locked (including keyboard shortcuts) until login succeeds.
- The popup has two tabs:
  - **Masuk (Sign in)** — email + password via `signInWithPassword()`.
    Includes a "Lupa password?" link that switches to a reset-password
    form (`resetPasswordForEmail()`); the email it sends links back into
    the app, which then shows a "set new password" form
    (`updateUser({ password })`) before letting the user in.
  - **Daftar (Sign up)** — email + password via `signUp()`. If your
    project has "Confirm email" turned on, the new account can't sign in
    until the verification link is clicked; the popup shows a message
    asking the user to check their inbox and then come back and sign in.
    If "Confirm email" is off, the account is signed in immediately.
- The **"Berminat menggunakan fitur PRO?"** link opens WhatsApp
  (`wa.me`) pre-filled with *"Halo, saya berminat menggunakan fitur PRO
  FontSeru."*, using the number from `VITE_PRO_WHATSAPP_NUMBER` — clickable
  even before logging in.
- Once signed in, the popup disappears automatically; the top bar shows an
  account avatar with a Free/Pro badge and a sign-out option. Sessions
  persist across refreshes via Supabase's own session storage.
- Plan status is **always read from the database** (`profiles.plan`) —
  never hardcoded, never trusted from the client, and the client never
  inserts/overwrites a `profiles` row (see `src/auth/AuthProvider.tsx`).
  If your account shows as Free right after logging in even though
  `profiles.plan = 'pro'` in the database, see "Troubleshooting" below.
- If Supabase isn't configured (`.env` incomplete), the app keeps working
  exactly as before, without the login gate.

### Troubleshooting: a PRO account shows as FREE after login
The client only ever **reads** `profiles.plan` for `auth.uid() = id`, with
a short retry — it never creates or overwrites a row. So if a known-PRO
email still shows as Free after signing in, the cause is on the database
side, not in the login flow. Check, in order:
1. **Does a `profiles` row exist whose `id` exactly matches that user's
   real `auth.users.id`?** This is the most common cause: PRO rows added
   by hand with a random/typo'd UUID instead of copying the actual
   `auth.users.id` will never match `auth.uid() = id`, so the SELECT
   always returns nothing (indistinguishable, from the client, from "no
   row yet"). Run in the SQL editor:
   ```sql
   select u.id, u.email, p.id as profile_id, p.plan
   from auth.users u
   left join public.profiles p on p.id = u.id
   where u.email = 'the-user@example.com';
   ```
   If `profile_id` is `null` or doesn't equal `u.id`, that's the bug —
   fix the row's `id` (or re-insert it with the correct `id`) rather than
   changing any application code.
2. **Is RLS actually enabled with the `"profiles: read own row"` policy
   from `supabase/sql/profiles_policies.sql` applied?** An RLS-blocked
   read and a genuinely missing row look identical to the client (both
   come back as "no row"), so it's worth re-running that file if unsure.
3. **Email casing/whitespace mismatches** only affect the pre-login PRO
   check (`check_pro_email`) used for messaging — never the post-login
   plan read, which is always keyed by `id`, not email.

Relevant files: `src/lib/supabaseClient.ts`, `src/auth/AuthProvider.tsx`,
`src/components/LoginModal.tsx` (the popup), `src/components/AuthWidget.tsx`
(post-login account menu in the top bar), `src/lib/whatsapp.ts`.
