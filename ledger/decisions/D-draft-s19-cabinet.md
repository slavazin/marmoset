---
id: D-draft-s19-cabinet
title: The live view is a drawn cabinet with instrument modules around the LCD, wide by default and handheld on a switch
status: draft
supersedes: null
---
**Decision:** S19 takes these Wiggle choices:
- Concept: an original chamfered cabinet (CSS only, no handheld shell or branding copied) holds the LCD at an integer scale (`--px` 2, 3 or 4 by viewport width), with an optional pixel grid (`grid` switch on the visor, per browser in localStorage). Instrument modules with screw heads and lamp headers sit left (scope, gate sequence), right (registers, heatmap) and below (incident log, ratchet stack, curve, Mooneye, V read).
- Type: Silkscreen for headings and labels, JetBrains Mono for data, both from Google Fonts. Palette: tokens on `:root`, dark first; `prefers-color-scheme: light` swaps them.
- Looks: "cabinet" (modules around the screen) is the default at every desktop width; "handheld" (modules stacked under the screen) is a header switch, remembered per browser, and `?look=compact` selects it for a page load. At 700 px or narrower the handheld look applies whatever was chosen (owner amendment, 2026-11-07).
- Gate sequence: one lamp bank per subject kind, the latest attempt verdict (the repair gate) first, then the latest skill verdict (the shadow trial). Lamp names and order are the verdict's `checks`, then an outcome lamp, merge for an attempt and graduate for a skill.
- Spend gauge: on the History tab, the guard's `usd` against `stop_usd`, with `ask_usd` marked, all from `/api/history` `meter`.

**Not this:**
- One lamp bank for the latest verdict only. In the fixture ledger the latest verdict is a skill trial, so the repair gate's six-step sequence would never show.
- A fixed six-name lamp list. A name not in the record would be a label the ledger did not write.
- A spend gauge on the live view. `/api/state` carries no meter; adding one is a server change outside S19.

**Warrant:**
- Owner request, 2026-11-07: the old look read as "the default LLM web look". The owner asked for a game-like screen with displays around the main one, and later for the wide layout as the desktop default.
- Screenshots of each look and each tab are in `evidence/s19/`.
- False if: in the 1440 px desktop screenshot, the modules around the LCD push it below the fold, or the LCD is not the largest element.

**Revisit when:** {when: "the demo video is cut", then: "drop any module the video never shows, before shrinking the LCD"}

**Residue:**
- The light theme was checked only on the replay screen.
- The animations were checked only by eye, in the browser pane.
