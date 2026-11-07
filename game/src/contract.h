/* Game RAM contract (SPEC §6.17; mirrored by GAME_RAM in src/schema.ts).
   The VBlank handler in main.c writes all five fields once per VBlank.
   game/build.sh links _DATA at 0xC100 so these bytes are never allocated
   to a C variable; game/game.test.ts reads the addresses below against GAME_RAM. */
#ifndef FERNWAKE_CONTRACT_H
#define FERNWAKE_CONTRACT_H

#include <stdint.h>

#define RAM_COUNTER_ADDR 0xC0F0 /* 2 bytes, little-endian frame counter */
#define RAM_SCENE_ADDR   0xC0F2 /* 1 byte: 0 title, 1..3 levels */
#define RAM_HERO_X_ADDR  0xC0F3 /* 2 bytes, little-endian, world pixels */
#define RAM_HERO_Y_ADDR  0xC0F5 /* 1 byte, screen pixels (SCY is 0) */
#define RAM_LIVES_ADDR   0xC0F6 /* 1 byte */

#define RAM8(a) (*(volatile uint8_t *)(a))

#endif
