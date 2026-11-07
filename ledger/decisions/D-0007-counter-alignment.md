---
id: D-0007
title: Frames align by the game's counter, and the game seeds nothing from DIV or the timer
status: admitted
supersedes: null
---
**Decision:** core and oracle frames are compared at equal values of the game's counter (SPEC §6.17); `game.gb` derives no state from DIV or the timer.
**Not this:** frame-index alignment for the game.
**Warrant:** the oracle runs a boot ROM and the core starts post-boot, so frame indices differ by the boot length. False if: two runs of `game.gb` from equal inputs diverge in game-state RAM on the oracle.
**Revisit when:** {when: "a ROM without the counter contract enters D", then: "align it by frame with boot-offset residue"}
**Residue:** lag frames before the first counter write are not compared.
