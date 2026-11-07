// The Pre-event evidence tab's data (S14): readings from prep scripts run outside this repository on 2026-11-06.
// This file is the one place under ui/present/ that carries figures (SPEC §1.4, G9); no other tab imports it, and
// ui/present/present.test.ts exempts only this file from its numeric-literal grep. None of these figures comes from
// today's ledger, and none enters a card, a curve or a verdict.

/** The tab's label, shown on the tab button and as the tab's heading. */
export const PRE_EVENT_LABEL = "Pre-event evidence (measured 2026-11-06, not today's ledger)";

export const PRE_EVENT_PREMISE =
  "Each core below was written blind, from a model's memory with no web access and no test ROMs. The Muse cores came from single API calls with no tools; the Claude cores came from agents allowed to run small self-tests. These readings shaped the design. They are not results of this build.";

export interface PreEventFact { id: string; claim: string; table?: { head: string[]; rows: string[][] }; consequence: string }

export const PRE_EVENT_FACTS: PreEventFact[] = [
  {
    id: "F1",
    claim: "A CPU written blind passes 99.8% of the 500,000 SingleStepTests cases, with 499 of 500 opcodes fully correct. The same held for Muse Wonder 1.0, Muse Spark 1.3, Claude Opus (two seeds) and Claude Sonnet; every one of them got only the length of STOP wrong.",
    consequence: "The SM83 CPU leaves no room for the repair loop to show anything.",
  },
  {
    id: "F2",
    claim: "Given a CPU, a full DMG system written blind passes Blargg 15 of 15, Mooneye MBC1 12 of 12, and matches dmg-acid2 exactly, yet misses on accuracy:",
    table: {
      head: ["Core", "93 ROMs passed (Mooneye acceptance, Blargg, MBC1)", "24 Mealybug PPU screenshots"],
      rows: [
        ["Muse Wonder", "57", "0 exact; 77% mean pixel match"],
        ["Opus", "66", "1 exact; 87%"],
        ["Sonnet", "61", "0 exact; 84%"],
      ],
    },
    consequence: "The misses cluster in instruction timing (2 of 14 Mooneye ROMs pass), PPU interrupt timing (3 to 5 of 12), OAM DMA (1 to 3 of 6) and boot state (1 of 4). Every blind core draws a whole scanline at once, where Mealybug needs a dot-by-dot pixel FIFO.",
  },
  {
    id: "F3",
    claim: "A kill test on Muse Wonder's blind core, over the Mealybug train and held-out split:",
    table: {
      head: ["Arm", "9 train tests", "15 held-out tests", "Mooneye"],
      rows: [
        ["Claude agent with test access, 8 scorer runs", "0 exact; 74.0% → 89.6%", "0 exact; 79.2% → 80.6%", "57 → 56 (ppu/intr_2_0_timing broke)"],
        ["Muse Wonder API, 1 round", "0 exact; 74.0% → 83.7%", "0 exact; 79.2% → 83.3%", "—"],
      ],
    },
    consequence: "There is room to improve, and an agent tuning against train tests can overfit and break timing it never saw. The gate is built to catch that shape; whether it appears today is a reading for today's ledger, not this tab.",
  },
  {
    id: "F4",
    claim: "Long Muse Wonder calls reason without output for 9 to 12 minutes. Non-streaming calls hit the gateway's time limit, and Node's default 300 s fetch timeout ends silent requests. Two of the kill loop's three streamed repair calls returned a stop with empty content.",
    consequence: "Muse Spark under Muse Code, editing files with tools, is the repairer partly for this reason; an empty reply is logged as a failed attempt rather than quietly called again.",
  },
];
