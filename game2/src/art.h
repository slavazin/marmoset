/* Tile indices for Halogen's art (game2/src/art.c holds the pixels).
   BG and window tiles live in the 0x8800 block (LCDC bit 4 clear): indices 0..127 sit at 0x9000.
   Object tiles live at 0x8000 in pairs, so 8x16 mode (scene 2) shows tile n&0xFE over n|1. */
#ifndef HALOGEN_ART_H
#define HALOGEN_ART_H

#include <stdint.h>

#define T_VOID       0
#define T_STAR       1
#define T_STAR_BIG   2
#define T_CLOUD_L    3
#define T_CLOUD_R    4
#define T_RULE       5
#define T_LAMP_OFF   6
#define T_LAMP_ON    7
#define BG_TILE_COUNT 8

#define T_FONT      16
#define FONT_CHARS  "0123456789ACEGHLNOPRSTVWx-*"
#define FONT_COUNT  27

#define S_SHIP_L     0
#define S_SHIP_R     2
#define S_BOLT       4
#define S_BEETLE     6
#define S_SPARK      8
#define S_BIG_TOP   10   /* 8x16 pair 10/11 */
#define SPR_TILE_COUNT 12

void load_art(void);
uint8_t char_tile(char ch);

#endif
