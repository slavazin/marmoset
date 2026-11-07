/* Fernwake level maps. Level n lives in ROM bank n; main.c switches to that bank at level start.
   Legend: '.' air, '#' ground (grass when the cell above is not ground), '=' plank,
   'f' fern (decor, not solid), 'G' the goal lantern. Rows map to BG rows 6..15 (screen y 48..127);
   a gap in row 9 drops the hero into the water band. */
#ifndef FERNWAKE_LEVELS_H
#define FERNWAKE_LEVELS_H

#define LEVEL_ROWS 10
#define LEVEL_COLS 64
#define LEVEL_COUNT 3

extern const char level1_map[LEVEL_ROWS][LEVEL_COLS + 1];
extern const char level2_map[LEVEL_ROWS][LEVEL_COLS + 1];
extern const char level3_map[LEVEL_ROWS][LEVEL_COLS + 1];

#endif
