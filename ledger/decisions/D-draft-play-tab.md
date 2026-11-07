---
id: D-draft-play-tab
title: The visitor's Play tab is a presentation tab on main's core, scaled by whole multiples, and holds a tap for two frames
status: draft
supersedes: null
---
**Decision:**
- Play is the sixth presentation tab (`TABS` in `ui/present/mount.ts`), not a top-level route. While it is open the live LCD is hidden (`ui/play/play.css`, `body.play-on #centre`) and the live core keeps running.
- Play runs main's `core/` through `ui/core-seam.ts` `loadCore(null)`. No "S0 core / current core" toggle: the server names no core-live head to the browser, so a toggle needs a route serving a bundle of that head.
- The Play LCD is drawn at the largest whole multiple of 160×144 that fits its column and `LCD_MAX_VH` of the viewport height (`integerScale`, `ui/play/session.ts`), with `image-rendering: pixelated`.
- A press is held for at least `MIN_HOLD_FRAMES = 2` emulated frames (`PlayInput`, `ui/play/session.ts`). game/game.gb starts on a rising edge of Start between two per-frame joypad reads (`update_title`, `game/src/main.c`).
- Play input is kept off the experiment by a capture-phase window keydown handler that stops the event (`playKeyHandler`), and Play posts only `POST /api/play-session` (`server/index.ts`), which writes one `ui` telemetry record "play-session" and refuses any field beyond `op` and `duration_ms`.

**Not this:**
- A top-level route: it splits the header and tab bar the presentation tabs already carry.
- Fractional scaling to fill the column: it draws uneven pixel widths.
- Passing a keydown and keyup straight to `setButtons`: a keydown and keyup inside one animation frame never reach a frame, and Start is lost (read in the browser pane, 2026-11-07, before `MIN_HOLD_FRAMES`).

**Warrant:**
- `ui/play/play.test.ts`: Play keypresses produce no `/api/input` request and no `input`-stream record; the session writes only play-session start and stop.
- Browser pane, 2026-11-07: Start from the keyboard and from the on-screen button opened LV1; `read_network_requests` matched no `/api/input` request; the mobile viewport (375 px) drew the LCD at 2× (320 px) with document scroll width 375.
- False if: a Play-tab key produces a `POST /api/input`, or a tap of Start on the title screen fails to open LV1.

**Revisit when:** {when: "the server names core-live's head and serves its bundle to the browser", then: "add the S0 core / current core toggle to the Play tab"}

**Residue:**
- The play-session record carries no `event` field, so `server/replay.ts` puts it in no replay timeline; the replay inspector lists it (`/api/replay/records`).
- A key held on the live view when Play opens is released by its keyup, which passes through to `ui/main.ts` and posts `/api/input` for the live view.
