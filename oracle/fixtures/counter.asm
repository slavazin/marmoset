; counter.gb: an oracle fixture holding the SPEC §6.17 RAM contract.
; Each VBlank increments the frame counter (0xC0F0, 2 bytes little-endian)
; and sets SCX to its low byte, so frame n shows the background scrolled n-1.
; Build: oracle/fixtures/build.sh (rgbasm, rgblink, rgbfix).

DEF COUNTER EQU $C0F0
DEF SCENE   EQU $C0F2

SECTION "vblank", ROM0[$40]
vblank:
    push af
    push hl
    ld hl, COUNTER
    inc [hl]
    ld a, [hl+]
    ldh [$FF43], a          ; SCX = counter low byte
    jr nz, .done
    inc [hl]
.done:
    pop hl
    pop af
    reti

SECTION "entry", ROM0[$100]
    nop
    jp start
    ds $150 - @, 0        ; header, filled by rgbfix

SECTION "main", ROM0[$150]
start:
    di
    ld sp, $DFFF
.wait:
    ldh a, [$FF44]          ; LY
    cp 144
    jr c, .wait
    xor a
    ldh [$FF40], a          ; LCD off
    ld hl, COUNTER        ; counter = 0, scene = 0
    ld [hl+], a
    ld [hl+], a
    ld [hl], a
    ld hl, $8000          ; tile 0: blank; tile 1: a diagonal stripe
    ld bc, 16
.blank:
    ld [hl+], a
    dec c
    jr nz, .blank
    ld b, %10000000
.stripe:
    ld a, b
    ld [hl+], a
    ld [hl+], a
    srl b
    jr nz, .stripe
    ld hl, $9800          ; map: tile 1 in every third cell
    ld de, 32 * 32
    ld c, 0
.map:
    ld a, c
    inc c
    cp 3
    jr c, .keep
    ld c, 1
.keep:
    and 1
    ld [hl+], a
    dec de
    ld a, d
    or e
    jr nz, .map
    ld a, %11100100
    ldh [$FF47], a          ; BGP
    xor a
    ldh [$FF43], a          ; SCX
    ldh [$FF42], a          ; SCY
    ldh [$FF0F], a          ; IF
    ld a, 1
    ldh [$FFFF], a          ; IE = VBlank
    ld a, %10010001
    ldh [$FF40], a          ; LCD on, BG on, tiles at $8000
    ei
.loop:
    halt
    nop
    jr .loop
