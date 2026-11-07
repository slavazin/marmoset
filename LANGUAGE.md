# Authoring language

The voice, vocabulary and structure rules for every durable file in this repository:
- decisions, beliefs, skills and tombstones;
- observations and incident narrations;
- READMEs and the spec;
- code headers and docstrings, test titles, messages;
- implementer and cold-reader reports, and commit messages.

This file is a **register**: corrected in place, with git holding its past. Every other file points to it by path and never carries a copy of it.

The field schemas of each record are in [SPEC.md](SPEC.md) §6; this file governs the words inside them. The terms are SPEC §2's.

## Purpose

It blocks three authoring failures:

- **Declarative drift.** Files name one concept in different words until the concepts fork. Countermeasure: the closed lexicon and one home per fact.
- **Session bias.** The authoring session writes what happened to it instead of what a later reader, who knows nothing of that session, should do. The later reader is a repairer, a consolidator or a judge reading the repo. Countermeasure: L1 and L2.
- **Claim drift.** A sentence asserts more than, or other than, what makes it true. Nothing fails when it turns, and it misleads its reader. Countermeasure: claim language.

The repairer reads skills, beliefs and decisions as part of its context. A skill written in session bias ("we found that the delay helped") teaches the next run a story instead of a rule. **In this repository, authoring quality is model input quality.**

## Write card

Hold these at the moment of writing any durable file. Each line names the section where its rule stands.

1. Write for a reader who knows nothing of this session: duties imperative, premises present tense, evidence as dated facts (L1).
2. No tells: first person, "now", "new", "still", "the above", "we decided", "was added", "TODO", "for now" (L1).
3. Each sentence is a premise with a nameable falsifier, a dated fact, or a directive (L2).
4. No as-of date on the repository's own state; git holds it. A date marks only a measurement of the world: a model string a service echoed, a reading from a run (L2).
5. A sentence on what code does, what a set holds or what a figure is cites its truth-maker (the test, the constant, the ledger file) by path or symbol (L2 corollary).
6. Every Do ships its Don't, and the Don't names a failure recognisable in a draft (L3).
7. A quantifier or enforcement verb (every, never, only, refuses, ensures) reaches no further than its truth-maker reads. With no enforcer, write "held by review" (C1).
8. No hedges ("may", "tends to"): narrow the set and keep the verb (C1).
9. A header or docstring states what its symbol offers a caller. An edit to a symbol greps every sentence naming it (C2).
10. A status word (open, owed, graduated, the default) points to the one home that holds the status (C3).
11. A figure names its unit and population and is copied from its ledger or evidence file, never retyped (C4).
12. Open every path you cite; the target says what your sentence says it says (C5).
13. One home per fact. Every other site names its home and never carries a copy beside the pointer (Reference discipline).
14. Name a fork, id or label with the words of what it is: "SKL-0003, fetcher-steps-not-delays", never a bare id (Reference discipline).
15. Dates are absolute, `YYYY-MM-DD`.
16. A lexicon word only for its concept (Lexicon; SPEC §2).
17. A procedure step names who acts, on what trigger, and what it writes (C7).
18. A report names every asked item with its status, and every default or reading the change moved (C6).
19. A latch's words key on what the reader holds *before* the payload helps (Latch language).

## The three laws

Every directive in this file ships as a pair: the Do, plus the named overshoot the Do must not be taken to. A directive without its counter-directive steers writers past one failure into its opposite.

### L1 — Session-invariance

**Do:** write every sentence to be true and actionable for a reader who knows nothing of the authoring session. State duties in the imperative, premises in the present tense, and evidence as dated facts. A file tells its reader what to do, never what was done to produce the telling.

**Don't (the overshoot):** don't strip provenance to reach timelessness. Anchors, dated measurements and warrant citations are required content; L1 bans *narration of process*, not *evidence*. "Chosen after a long debugging session" is narration. "False if: a repair passes H by adding a constant mode-3 delay (observed 2026-11-07, ATT-0009)" is evidence.

| Banned form | Legal replacement |
|---|---|
| "still", "the last", "the next" as a referent | the referent's id or path |
| "was added", "has been changed", "we decided" | a present-tense statement of what stands |
| "will", "soon", "planned", forecasting this repository's own state | the premise as it stands, plus a revisit trigger `{when, then}` if the move is an event to act on |
| "TODO", "for now", "temporarily" | a revisit trigger `{when, then}`, or nothing |
| "now", "currently", "so far" | an as-of date on a world measurement, or nothing |
| "new", "latest", "old", "the above" | the referent's id, name or path |

### L2 — State-invariance (true until false)

**Do:** every sentence in a payload is exactly one of three things:
- (a) a **premise or trigger** that holds until a nameable event falsifies it;
- (b) a **dated fact**: a measurement frozen with its date;
- (c) a **directive** to the reader.

Before committing a sentence, name the event that would make it false. If none is nameable and no date is attached, the sentence does not belong.

**Don't:** don't delete constraining context to pass this test. Move it to the warrant's falsification list, dated. A decision stripped of its constraining facts is unfalsifiable, which is worse than stale.

L2's target is **tangential rot**: detail that decays independently of the premise (tool versions, counts, directory listings) riding inside a payload whose premise stays correct, so the entry reads false while being right.

**Git holds the past.** A sentence never says *when* it was true of this repository; the commits are the history. An as-of date on a claim about the tree's own state (a test passes, a skill is graduated) is deleted. A premise that turned is rewritten as it stands, with nothing about the turn. A date stays only on a measurement of something outside the tree: a model string, an oracle reading, a run's figure.

### L2 corollary — the truth-maker owns the truth

**Do:** where an artifact in the repository makes a sentence true or false, the sentence states the constraint and cites that artifact by path. The artifact can be a test, a typed constant, a ledger record, or a generated file such as `ledger/provenance.json`. The sentence then stays true for exactly as long as the truth-maker passes.

A sentence describing what code does, what a set holds or what a figure is, without citing what makes it so, is **state prose**: true at authoring, false at some later commit, with nothing failing when it turns.

**Don't:** don't manufacture a truth-maker for every premise. A constraint no check can run (what may never be built, a fact about SameBoy, a design principle) stays a premise with a `False if:` or a dated fact. And don't cite the source that exhibits a behaviour as its truth-maker: the source *is* the state, and the test that asserts it is what fails.

### L3 — Bounded directives

**Do:** every directive ("Do X") ships with the counter-directive naming its overshoot ("Don't X′"), the specific opposite error a writer lands in when steering away from the original failure. In a skill this is the `not-this` clause plus the **Don't** paragraph; in a decision it is **Not this**.

**Don't (the overshoot of this law itself):** don't manufacture vacuous pairs. "Don't overdo it" bounds nothing. A counter-directive names a failure recognisable in a draft or a diff. In a skill, the Don't is best drawn from a real failure in the ledger: the refused attempt it came from, cited by id (the contrast law, GCE V2 § 6).

## Claim language

Governs every sentence that asserts what holds: what code does, what a set contains, what a figure is, where an item stands.

### C1 — Reach

**Do:** write a claim no wider than its truth-maker reads. Three word classes widen a claim:
- quantifiers: every, never, always, all, exactly;
- enforcement verbs: refuses, checks, guarantees, ensures, cannot;
- level terms: exact, held-out, sealed, independent.

Each carries its **reach**: the set the claim covers, and the truth-maker that reads every member of it. What the truth-maker does not read is stated as a premise ("given traces the gate has admitted"). An enforcement verb with no enforcer is written as what holds it ("held by review", "by convention"). A test title is such a claim: the property its assertions read, over the members they read.

Write-time test: name the reading that would refute the sentence, and check it covers every member the sentence names.

**Don't:** don't hedge a claim out of reach. "May", "tends to" and "should usually" name no event that makes them false, and a hedge misleads as surely as an overclaim. Narrow the set and keep the verb.

### C2 — Prose beside code

**Do:** a module header, docstring, message or usage string states what its symbol offers a caller: what it returns, refuses or writes, on which inputs. Name the symbol it describes, and cite the test that asserts the behaviour. An edit to a symbol re-reads every sentence naming it, wherever a grep of the name finds one.

**Don't:** don't trace the body ("calls A, then loops over B"); a trace rots on the first refactor. And don't strip a header to escape rot.

### C3 — Status words

**Do:** treat a **status word** (open, owed, shadow, graduated, tombstoned, repaired, the default) as a claim whose falsifier is an event. An item's status lives in one home: a record's `status` field, or a ledger verdict. Every other sentence points to that home. A change that turns a status greps the item's id across the files it touches.

**Don't:** don't strip status from prose that reads wrong without it. Point to the home; don't restate it.

### C4 — Quantities

**Do:** a count, rate or figure names its unit, its population and, where more than one exists, its estimator. Write "mean pixel match over H's 7 Mealybug families, one run each", not "accuracy". Write "1 family-run per arm per family", not "3 runs". Two figures set side by side count one population under one estimator, or the sentence names where they differ. A figure is copied from the ledger or evidence file that holds it, never retyped.

**Don't:** don't load every figure with its method. Unit and population are the claim; how it was measured belongs in the warrant.

### C5 — Pointers

**Do:** every pointer resolves, and what it points to says what the sentence says it says. A cited path exists at the commit that cites it; a cited test asserts the property named; a figure quotes its file digit for digit. A reference never carries a second copy of the value it points to: write "the floor `MARGIN_FLOOR` holds", not "the floor of 1.0 (`MARGIN_FLOOR`)".

**Don't:** don't cite in bulk ("see `ledger/`"). A citation the reader can't narrow to one artifact is decoration.

### C6 — Reports

**Do:** a report (an implementer's return, a cold reader's findings, a commit message, the README's "what was built") names every item it was asked for with its status: done, open or dropped, each with its reason. It also names every default, output or reading the change moved; the reader takes silence as done or unchanged. A headline names the mechanism its reading supports, or says none was read. A difference inside its noise is reported as none.

**Don't:** don't pad a report with items no one asked for, nor restate the diff line by line.

### C7 — Procedure steps

**Do:** a step of a brief, an agent definition, the workflow or a skill names who acts, on what trigger, and what it writes, so a reader can walk it. Before it lands, grep its key terms in its sibling steps and settle any contradiction.

**Don't:** don't restate a sibling's step to make a step self-contained. Point to its home.

### The forms drift takes

| Draft (rots or misleads) | Rule | Legal form |
|---|---|---|
| "the gate checks all traces (as of 2026-11-07)" | L2 corollary | "the gate replays every trace in `traces/` (`gate.test.ts`, 'reverts on a broken replay')" |
| "the skill improved things a lot" | C4 | "+2.1 pts mean pixel match on H's 2 trial families, candidate against placebo, 1 family-run per arm (VER-0012)" |
| "Ratchet beats baseline" on a gap inside the margin | C6 | "no difference at this margin (VER-0014)" |
| "the oracle never sees our code" | C1 | name the enforcer, or write "held by construction: the oracle is a separate process fed only ROM and buttons (`oracle/frontend.py`)" |
| "we found that adding a delay fixes BGP" | L1 | a belief: "**Claim:** … **False if:** …", marked suspected, anchored to the attempt |
| "TODO: tune K" | L1 | "**Revisit when:** {when: 'median attempt > 10 min', then: 'retune K'}" |
| a skill whose Don't is "don't overfit" | L3 | "Don't add a constant startup delay that fits one test (ATT-0009: `mealybug:palette-scroll-bg` up, `mooneye:instr-timing`'s `call_timing` broke)" |
| "the PPU is mostly correct" | C1, C4 | "passes 5/12 of H's Mooneye `ppu/*` (VER-0010)" |
| a skill naming a file path in its payload | L2 corollary | the constraint in the payload; paths go in `activation.paths` |

## Voice by surface

| Surface | Voice | Never |
|---|---|---|
| Register (the spec, the splits file, this file, the skill set) | present tense, current state, corrected in place | history narration; git carries it |
| Ledger (incidents, attempts, verdicts, observations, fires, decisions, beliefs, tombstones) | frozen in meaning; append, or supersede with a pointer; a status flip is the only in-place change | rewriting a committed record's meaning |
| Skill (`SKILL.md`) | imperative to the repairer: Do and Don't, with activation in presentation words | narrative of how it was learned (that is the warrant's anchors) |
| Decision | constraint plus Not this plus warrant plus revisit trigger plus residue | an implementation trace |
| Belief | one claim about the hardware, its mark, its anchors, its `False if:` | a mixture of suspected and verified claims in one entry (I13) |
| Observation | one noticing, one sentence, one anchor, presentation-keyed | a conclusion, a fix or a plan |
| Narration (narrator's sentence on an incident) | what looks wrong, in screen words ("the HUD bar starts one line low") | a cause or a fix; the narrator nominates, never decides |
| Code prose | present tense; what the symbol offers a caller, the test cited | a trace of the body |
| Test title | the property its assertions read, over the members they read | a property over a set its cases cover part of |
| Report | every asked item with its status; every default and reading moved | silence on an item left undone |

## Reference discipline

**Do:**
- Dates are absolute (`YYYY-MM-DD`).
- Refer by stable id (`D-0005`, `SKL-0003`) or path.
- Name things by their referent, never by alias or position ("the above", "the previous rule").

**Don't:** don't date decoration. A date marks a frozen measurement or an adjudication.

**Do: one home per fact.** A fact (a model pin, a margin, a path, a split, a list, a rule) is stated in one file and referenced from every other by path or id. The owner is the file whose lifecycle matches the fact's:
- model pins: the run manifest;
- the gate rule: `loop/gate.ts`'s constants;
- the split: `splits.json`;
- a measurement: the ledger record holding it; the calibrated margin: the run manifest.

**Don't:** don't strip the reader's context to reach one home, and don't write the value again "for convenience" beside the pointer. A reference says what it points to and why it matters here: "the margin floor, `MARGIN_FLOOR` in `loop/gate.ts`". Never a bare id a reader must open another file to decode.

## Lexicon

A closed vocabulary. Use these words for these concepts, no synonyms for them, and none of them for anything else. A concept fitting no term enters SPEC §2 first, with its defining line, before a sentence uses it. The product's own terms (core, oracle, player, repairer, gate, incident, attempt, verdict, skill, shadow trial, placebo skill, latch, fire, S₀/P/D/H/S\*/V) are SPEC §2's; the authoring terms are here.

| Term | Means | Not to be called / not to be confused with |
|---|---|---|
| store | one directory or file holding one kind of record under one lifecycle | database, memory, pile |
| entry | one record carrying the pentad (a skill, a decision, a belief) | doc, note, item |
| register | a current-state surface, corrected in place | log, history |
| ledger | an append-only history; records frozen at admission | list, archive |
| admission | the gate's or the owner's act that turns a nominated entry into an admitted one (a status flip: `shadow`→`graduated`, `draft`→`admitted`); ids are minted earlier, at nomination | creation, saving |
| supersede | retire an entry by pointing to its successor | edit, update, fix |
| status flip | the in-place change of a record's `status` | edit |
| payload | what an entry exists to deliver: the rule, the decision, the claim | summary |
| warrant | what grounds a payload, causally independent of it: anchors plus `False if:` | context, rationale prose |
| anchor | an id or path tying a claim to evidence in the ledger | link, example |
| falsifier | the nameable event that would kill a claim (`False if:`) | risk, caveat |
| truth-maker | the artifact whose run or content makes a claim true or false: a test, a constant, a ledger record | source of truth; the source file that exhibits the behaviour |
| residue | what a check does not check, stated on the check's output | limitation, disclaimer |
| latch | a condition an entry carries that routes attention: a skill's activation (`fires-when`), a revisit trigger, a `retire-when` | a synonym for trigger; the *hook* is the mechanism a skill's activation compiles into (SPEC §2.3) |
| fires-when | a skill's presentation condition: when the repairer should apply it | trigger |
| not-this | the shapes a latch matches but must not bind | exception, edge case |
| trigger (revisit) | `{when, then}`: a world-state condition that re-opens a decision; `then` opens with one act of apply, re-derive, check, retire | reminder |
| retire-when | an entry's retirement condition; `moot:` marks the kind where the entry's domain stops existing, which retires without contradicting | falsifier |
| disposition | the terminal mark a consumer records on an entry it was shown: `applied` or `considered-not-applicable`; a lesson relied on that no shown entry holds is recorded beside them as `off_map` (SPEC §6.6) | verdict (the gate's, written at adjudication) |
| claim | a sentence asserting what holds | — |
| reach | the set a claim covers, held against the set its truth-maker reads | scope |
| status word | a word placing an item in its lifecycle, whose falsifier is an event | state |
| state prose | a sentence describing code or a set without citing its truth-maker | documentation |

## Latch language

Governs every latch written as words: a skill's `fires-when` and `not-this`, a revisit trigger's `when`, a `False if:`, a `retire-when`. Producer and consumer never meet, and no mechanism repairs a key that fails to fire. A missed condition is silent forever, so its words are the entire channel.

**Do: key on the presentation, not the conclusion.** Phrase the condition in what the repairer holds *before* the skill helps: the incident's symptoms ("a mode-3 divergence whose diff is a horizontal shift of whole tiles"). Never phrase it as the skill's conclusion ("when the fetcher delay is wrong"), which fires only once the skill is no longer needed.
**Don't:** don't reduce the condition to surface features unrelated to the payload. Presentation words still track the payload's domain.

**Do: bias broad; the costs are asymmetric.** A false fire costs one `considered-not-applicable` disposition and is telemetry that later narrows the latch. A miss is invisible until a refused repair pays for it.
**Don't:** don't broaden past prediction. A condition matching shapes with no route to the payload trains the repairer to skim. Recover precision through `not-this`.

**Do: build conditions from SPEC §2's vocabulary and §2.5's domain terms**, the words producer and consumer both hold.
**Don't:** don't coin a term inside a condition.

## Consultation language

Governs text that sends a reader to an admitted entry: the repairer's fixed instruction text, the agent definitions, the workflow.

**Do: answer with the count and the provenance.** The repairer reports a consultation as how many skills it opened and which, each by id with its disposition: "consulted 2: SKL-0003 applied, SKL-0005 considered-not-applicable". A count with ids is a pointer no answer can fabricate without the reads behind it.
**Don't:** don't report a bare assurance ("the relevant skills were checked"). A skipped read and a real one would write the same sentence, and the backward pass could not tell them apart.

**Do: presume the store when the directive is to consult.** "Open `.agents/skills/` and apply each skill whose `fires-when` matches the incident in hand." Certainty, with the cue bound to the act.
**Don't:** don't hedge a consultation into an option ("consider whether a skill might apply"). And don't presume a *specific* entry into existence ("apply the fetcher skill") where none is admitted.

## Checks

No lint holds this file in this repository. It is held by review: by the cold reader's pass at the WORKFLOW triggers, and by the gate where a test reads a text against its home (the projection allowlist, the schema module).

Residue: no check reads whether a sentence is true, whether a Do/Don't pair is non-vacuous, whether a falsifier is the right one, a claim's reach, a status word against its home, or a report's omissions.
