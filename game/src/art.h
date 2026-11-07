/* Tile indices for Fernwake's art (game/src/art.c holds the pixels). */
#ifndef FERNWAKE_ART_H
#define FERNWAKE_ART_H

#include <stdint.h>

#define T_SKY        0
#define T_CLOUD_L    1
#define T_CLOUD_R    2
#define T_PEAK_L     3
#define T_PEAK_R     4
#define T_ROCK       5
#define T_GRASS      7
#define T_DIRT       8
#define T_PLANK      9
#define T_WATER_TOP 10
#define T_WATER     11
#define T_GOAL      12
#define T_FERN      13
#define T_BORDER    14
#define T_FLAME     15
#define BG_TILE_COUNT 16

#define T_FONT      16
#define FONT_CHARS  "0123456789AEFGKLMNOPRSTVWx:"
#define FONT_COUNT  27

/* Sprite tiles sit at 128+ in the shared 0x8000 tile block; 8x16 objects use even indices. */
#define S_BASE      128
#define S_WICK      128
#define S_WICK_ALT  130
#define S_FIREFLY   132
#define SPR_TILE_COUNT 6

void load_art(void);
uint8_t char_tile(char ch);

#endif
