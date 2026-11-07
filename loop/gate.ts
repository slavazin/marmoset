// The gate's rule constants (SPEC §6.8, G4). Declared at S0 with defaults; tunable only until the run opens,
// when loop/campaign.ts hashes them into the manifest as rule_version and they never change after.
// The gate's logic is S8's (repairs) and S9's (skills).

/** Max drop in an H family's mean pixel match (0..1) a repair may cause and still graduate. */
export const H_TOLERANCE = 0.005;
/** Per-family floor on a skill's trial margin, in the family's unit: Mealybug points of mean pixel match (0..100), Mooneye ROMs passed. */
export const MARGIN_FLOOR: Record<string, number> = { "mealybug:window": 1.0, "mooneye:ppu": 1 };
/** The H families every shadow trial repairs. */
export const TRIAL_FAMILIES: readonly string[] = ["mealybug:window", "mooneye:ppu"];
/** Min rise in a suite incident ROM's mean pixel match (0..1) that counts as its repro passing. */
export const SUITE_MIN_GAIN = 0.01;
/** Incidents between slow-loop generations. */
export const K = 4;
/** Repairer step cap per attempt. */
export const MAX_STEPS = 60;
/** Attempts per incident. */
export const MAX_ATTEMPTS = 2;
/** Graduated skills shown to one attempt; overflow evicts the least recently fired. */
export const MAX_SHOWN = 6;
/** Largest literal (bytes) a repair diff may add before the gate refuses it as memorisation. */
export const LITERAL_LIMIT = 64;

export const RULE_CONSTANTS = { H_TOLERANCE, MARGIN_FLOOR, TRIAL_FAMILIES, SUITE_MIN_GAIN, K, MAX_STEPS, MAX_ATTEMPTS, MAX_SHOWN, LITERAL_LIMIT } as const;
