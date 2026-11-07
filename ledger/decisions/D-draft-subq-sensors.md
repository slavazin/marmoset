---
id: D-draft-subq-sensors
title: SubQ is a calibrated sensor whose abstention, planted questions and forecasts nominate and never decide
status: draft
supersedes: null
---
**Decision:** every SubQ call carries one decoy applies: question (a DECOY_POOL criterion from audio, serial, joypad or cartridge RAM, under an SKL-shaped label past the highest routed id) and one reworded subsystem question (`TWIN_KEY` in loop/route.ts), placed at seeded positions; their answers form the route's sensor reading (`ROUTE_SENSOR_KEY`) and never enter a route. A route abstains when top-p < `ROUTE_ABSTAIN_P` (0.35) or `other` wins; `subsystemOf` in loop/policies.ts then returns null, so no policy narrows focus, and the order of precedence is spot, then the route, then the trial family. `SUBSYSTEM_REGIONS` names one HANDLERS entry per subsystem, and packet/focus.json lists handlers and their files. Pass and mechanism forecasts are status records on ledger/attempts.jsonl (`forecast_pass`, `forecast_mechanism`), asked through `senseAttempt` in loop/fast.ts.
**Not this:** a route, a forecast or a planted answer read by any gate check or by the shown-skill pick; a planted question worded as one ("decoy", "twin", "control"); a spot subsystem overridden by the route.
**Warrant:** S17b brief, owner-approved 2026-11-07. A sensor whose confidence predicts its errors earns its place only when that is measured on held-out outcomes (D-0004). False if: loop/sensors.test.ts finds a gate check, decision or rule version that differs with forecasts on, or a sent question that matches /placebo|twin|sham|control|decoy|dummy/i.
**Revisit when:** {when: "routeCalibration reads subsystem n >= 20 with auroc_uncertainty <= 0.5", then: "drop abstention from focus narrowing and read the route as noise"}
**Residue:** one primary handler per subsystem leaves ppu.fifo, ppu.oam and ppu.sprites out of every focus set; the `llm` stream and the SubQ cache hold decoy applies: keys under ids a later skill can take (INC-0003's decoy is applies:SKL-0002, evidence/s17b/readout.txt).
