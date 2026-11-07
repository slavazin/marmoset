/* Fernwake: Wick, a small candle, crosses three fern-shore levels above a dark lake.
   The game exists to exercise the raster effects real DMG games use (SPEC §5 S4):
     1. a window HUD cut off by an LYC interrupt at SPLIT_HUD_END;
     2. parallax bands: SCX rewritten at SPLIT_MOUNTAIN and SPLIT_PLAY;
     3. a water band from SPLIT_WATER with a mid-frame BGP swap;
     4. a firefly row of FIREFLY_COUNT 8x16 objects on the same lines;
     5. OAM DMA every frame (the GBDK default VBlank handler copies shadow OAM);
     6. a ROM bank switch per level (level n lives in bank n, game/src/levelN.c);
     7. a per-line SCX wobble across the water band.
   Nothing here reads DIV or the timer (D-0007); all motion derives from `tick` and input.
   vbl_isr writes the SPEC §6.17 RAM contract (contract.h) once per VBlank. */
#include <gb/gb.h>
#include <stdint.h>
#include "contract.h"
#include "art.h"
#include "levels.h"

/* Raster splits. The LCD handler fires at LY == LYC and writes in that line's HBlank,
   so each value takes effect from line LYC + 1. */
#define SPLIT_HUD_END   15u  /* window off; cloud band (BG rows 2-3) from line 16 */
#define SPLIT_MOUNTAIN  31u  /* mountain band (BG rows 4-5) from line 32 */
#define SPLIT_PLAY      47u  /* playfield (BG rows 6-15) from line 48 */
#define SPLIT_WATER    127u  /* water band (BG rows 16-17) from line 128 */
#define WATER_LAST     143u  /* last visible line */

/* LCDC: on, window map 9C00, window on, tiles 8000, BG map 9800, 8x16 objects, objects on, BG on. */
#define LCDC_WITH_WIN 0xF7u
#define LCDC_NO_WIN   0xD7u
#define BGP_LAND  0xE4u   /* identity shade map */
#define BGP_WATER 0x1Bu   /* inverted shade map: the lake reads dark */
#define STAT_LYC_IRQ 0x40u

/* World geometry, in pixels. */
#define PLAY_TOP     48
#define PLAY_BOTTOM  128
#define PLAY_ROW0    6u      /* BG row of level row 0 */
#define LEVEL_PX     (LEVEL_COLS * 8u)
#define CAM_MAX      (LEVEL_PX - 160u)
#define CAM_LEAD     72u     /* hero screen x the camera holds */
#define VIS_COLS     20u     /* extra columns streamed beyond the leftmost visible one */

/* Hero physics, velocities in 1/16 px per frame. */
#define HERO_START_X  16u
#define HERO_START_Y  96     /* standing on level row 8 */
#define HB_L 1u
#define HB_R 6u
#define GRAVITY  3
#define JUMP_V   60
#define MAX_FALL 64
#define DEATH_Y  120         /* feet 8 px under the water surface */
#define START_LIVES 3u

/* Firefly row: FIREFLY_COUNT objects share one 16-line band, beyond the DMG's 10-per-line limit. */
#define FIREFLY_COUNT 12u
#define FIREFLY_Y     60u    /* screen y of the row's top */
#define FIREFLY_GAP   14u

static const uint8_t wobble[16] = { 0, 1, 2, 2, 3, 2, 2, 1, 0, 255, 254, 254, 253, 254, 254, 255 };

/* State read by the interrupt handlers. */
static volatile uint8_t split;
static volatile uint8_t scx_far, scx_mid, scx_play, wob_phase;
static volatile uint8_t pub_scene, pub_hero_y, pub_lives;
static volatile uint16_t pub_hero_x;
static uint16_t frame_counter;

/* Game state. */
static uint8_t scene;          /* 0 title, 1..3 levels */
static uint8_t lives;
static uint16_t hero_x;
static uint8_t hero_y;
static int16_t hero_yf;        /* hero y in 1/16 px */
static int16_t hero_vy;
static uint8_t grounded;
static uint16_t cam;
static int8_t cam_dir;
static uint16_t tick;
static uint8_t keys, prev_keys;

/* Background streaming. */
static const char (*lvl)[LEVEL_COLS + 1];
static uint8_t col_lo, col_hi, redraw_next, redrawing;
static uint8_t hud_dirty;      /* bit 0: HUD row 0, bit 1: HUD row 1 */
static uint8_t colbuf[LEVEL_ROWS];
static uint8_t rowbuf[32];

static void lcd_isr(void) {
  uint8_t l, base;
  while (STAT_REG & 3u) ;
  if (split == 0u) {
    LCDC_REG = LCDC_NO_WIN;
    SCX_REG = scx_far;
    LYC_REG = SPLIT_MOUNTAIN;
    split = 1u;
  } else if (split == 1u) {
    SCX_REG = scx_mid;
    LYC_REG = SPLIT_PLAY;
    split = 2u;
  } else if (split == 2u) {
    SCX_REG = scx_play;
    LYC_REG = SPLIT_WATER;
    split = 3u;
  } else {
    base = scx_play;
    BGP_REG = BGP_WATER;
    SCX_REG = (uint8_t)(base + wobble[(uint8_t)(SPLIT_WATER + 1u + wob_phase) & 15u]);
    for (l = SPLIT_WATER + 1u; l < WATER_LAST; l++) {
      while (LY_REG != l) ;
      while (STAT_REG & 3u) ;
      SCX_REG = (uint8_t)(base + wobble[(uint8_t)(l + 1u + wob_phase) & 15u]);
    }
    LYC_REG = SPLIT_HUD_END;
    split = 0u;
  }
}

static void vbl_isr(void) {
  LCDC_REG = LCDC_WITH_WIN;
  BGP_REG = BGP_LAND;
  SCX_REG = 0u;
  LYC_REG = SPLIT_HUD_END;
  split = 0u;
  wob_phase++;
  frame_counter++;
  RAM8(RAM_COUNTER_ADDR) = (uint8_t)frame_counter;
  RAM8(RAM_COUNTER_ADDR + 1u) = (uint8_t)(frame_counter >> 8);
  RAM8(RAM_SCENE_ADDR) = pub_scene;
  RAM8(RAM_HERO_X_ADDR) = (uint8_t)pub_hero_x;
  RAM8(RAM_HERO_X_ADDR + 1u) = (uint8_t)(pub_hero_x >> 8);
  RAM8(RAM_HERO_Y_ADDR) = pub_hero_y;
  RAM8(RAM_LIVES_ADDR) = pub_lives;
}

static void publish(void) {
  disable_interrupts();
  pub_scene = scene;
  pub_hero_x = hero_x;
  pub_hero_y = hero_y;
  pub_lives = lives;
  scx_far = (uint8_t)(cam >> 3);
  scx_mid = (uint8_t)(cam >> 2);
  scx_play = (uint8_t)cam;
  enable_interrupts();
}

/* Fixed BG rows: HUD underlay, clouds, mountains, water. */
static void draw_bands(void) {
  uint8_t c, m;
  for (c = 0; c < 32u; c++) rowbuf[c] = T_SKY;
  set_bkg_tiles(0, 0, 32, 1, rowbuf);
  set_bkg_tiles(0, 1, 32, 1, rowbuf);
  for (c = 0; c < 32u; c++) { m = c & 7u; rowbuf[c] = m == 1u ? T_CLOUD_L : m == 2u ? T_CLOUD_R : T_SKY; }
  set_bkg_tiles(0, 2, 32, 1, rowbuf);
  for (c = 0; c < 32u; c++) { m = c & 7u; rowbuf[c] = m == 5u ? T_CLOUD_L : m == 6u ? T_CLOUD_R : T_SKY; }
  set_bkg_tiles(0, 3, 32, 1, rowbuf);
  for (c = 0; c < 32u; c++) { m = c & 3u; rowbuf[c] = m == 1u ? T_PEAK_L : m == 2u ? T_PEAK_R : T_SKY; }
  set_bkg_tiles(0, 4, 32, 1, rowbuf);
  for (c = 0; c < 32u; c++) { m = c & 3u; rowbuf[c] = m == 0u ? T_PEAK_L : m == 3u ? T_PEAK_R : T_ROCK; }
  set_bkg_tiles(0, 5, 32, 1, rowbuf);
  for (c = 0; c < 32u; c++) rowbuf[c] = T_WATER_TOP;
  set_bkg_tiles(0, 16, 32, 1, rowbuf);
  for (c = 0; c < 32u; c++) rowbuf[c] = T_WATER;
  set_bkg_tiles(0, 17, 32, 1, rowbuf);
}

static void draw_column(uint8_t col) {
  uint8_t r;
  char ch;
  for (r = 0; r < LEVEL_ROWS; r++) {
    ch = lvl[r][col];
    if (ch == '#') colbuf[r] = (r > 0u && lvl[r - 1u][col] == '#') ? T_DIRT : T_GRASS;
    else if (ch == '=') colbuf[r] = T_PLANK;
    else if (ch == 'f') colbuf[r] = T_FERN;
    else if (ch == 'G') colbuf[r] = T_GOAL;
    else colbuf[r] = T_SKY;
  }
  set_bkg_tiles(col & 31u, PLAY_ROW0, 1, LEVEL_ROWS, colbuf);
}

static void begin_redraw(void) {
  col_lo = (uint8_t)(cam >> 3);
  col_hi = (uint8_t)(col_lo + VIS_COLS);
  if (col_hi > LEVEL_COLS - 1u) col_hi = LEVEL_COLS - 1u;
  redraw_next = col_lo;
  redrawing = 1u;
}

static void hud_text(const char *s) {
  uint8_t i;
  for (i = 0; i < 20u; i++) {
    rowbuf[i] = *s ? char_tile(*s) : T_SKY;
    if (*s) s++;
  }
}

static void draw_hud_row(uint8_t row) {
  static char line[21];
  if (scene == 0u) {
    hud_text(row == 0u ? "      FERNWAKE" : "    PRESS START");
  } else if (row == 0u) {
    /* " FERNWAKE  LV1  ~x3" */
    const char *t = " FERNWAKE  LV1  ~x3";
    uint8_t i = 0;
    while (t[i]) { line[i] = t[i]; i++; }
    line[i] = 0;
    line[13] = (char)('0' + scene);
    line[18] = (char)('0' + (lives > 9u ? 9u : lives));
    hud_text(line);
  } else {
    hud_text("--------------------");
  }
  set_win_tiles(0, row, 20, 1, rowbuf);
}

/* Runs at the start of VBlank: one VRAM job per frame, so writes stay inside the blanking period. */
static void service_vram(void) {
  uint8_t need_lo, need_hi;
  if (redrawing) {
    draw_column(redraw_next++);
    if (redraw_next <= col_hi) draw_column(redraw_next++);
    if (redraw_next > col_hi) redrawing = 0u;
    return;
  }
  need_lo = (uint8_t)(cam >> 3);
  need_hi = (uint8_t)(need_lo + VIS_COLS);
  if (need_hi > LEVEL_COLS - 1u) need_hi = LEVEL_COLS - 1u;
  if (need_hi > col_hi) {
    col_hi++;
    draw_column(col_hi);
    if (col_lo < need_lo) col_lo++;
  } else if (need_lo < col_lo) {
    col_lo--;
    draw_column(col_lo);
    if (col_hi > need_hi) col_hi--;
  } else if (hud_dirty & 1u) {
    draw_hud_row(0);
    hud_dirty &= (uint8_t)~1u;
  } else if (hud_dirty & 2u) {
    draw_hud_row(1);
    hud_dirty &= (uint8_t)~2u;
  }
}

static void load_level_bank(uint8_t n) {
  SWITCH_ROM(n);
  if (n == 1u) lvl = level1_map;
  else if (n == 2u) lvl = level2_map;
  else lvl = level3_map;
}

static void reset_hero(void) {
  hero_x = HERO_START_X;
  hero_y = HERO_START_Y;
  hero_yf = (int16_t)(HERO_START_Y << 4);
  hero_vy = 0;
  grounded = 1u;
  cam = 0u;
}

static void enter_title(void) {
  scene = 0u;
  lives = START_LIVES;
  load_level_bank(1u);
  reset_hero();
  cam_dir = 1;
  begin_redraw();
  hud_dirty = 3u;
}

static void enter_level(uint8_t n) {
  scene = n;
  load_level_bank(n);
  reset_hero();
  begin_redraw();
  hud_dirty = 3u;
}

static uint8_t solid(uint16_t px, int16_t py) {
  char ch;
  uint8_t tx;
  if (py < PLAY_TOP || py >= PLAY_BOTTOM) return 0u;
  if (px >= LEVEL_PX) return 1u;
  tx = (uint8_t)(px >> 3);
  ch = lvl[(uint8_t)((py - PLAY_TOP) >> 3)][tx];
  return (uint8_t)(ch == '#' || ch == '=');
}

static uint8_t tile_at(uint16_t px, int16_t py) {
  if (py < PLAY_TOP || py >= PLAY_BOTTOM || px >= LEVEL_PX) return '.';
  return (uint8_t)lvl[(uint8_t)((py - PLAY_TOP) >> 3)][(uint8_t)(px >> 3)];
}

static void step_x(int8_t dir) {
  uint16_t nx, edge;
  int16_t y = hero_y;
  if (dir < 0) {
    if (hero_x == 0u) return;
    nx = hero_x - 1u;
    edge = nx + HB_L;
  } else {
    if (hero_x >= LEVEL_PX - 8u) return;
    nx = hero_x + 1u;
    edge = nx + HB_R;
  }
  if (solid(edge, y) || solid(edge, y + 8) || solid(edge, y + 15)) return;
  hero_x = nx;
}

static void lose_life(void) {
  if (lives > 0u) lives--;
  if (lives == 0u) { enter_title(); return; }
  reset_hero();
  begin_redraw();
  hud_dirty = 1u;
}

static void update_play(void) {
  uint8_t steps, i;
  int16_t ny, py, cx;
  if (keys & (J_LEFT | J_RIGHT)) {
    steps = (tick & 1u) ? 2u : 1u;
    for (i = 0; i < steps; i++) step_x((keys & J_RIGHT) ? 1 : -1);
  }
  if (grounded && (keys & J_A) && !(prev_keys & J_A)) { hero_vy = -JUMP_V; grounded = 0u; }
  hero_vy += GRAVITY;
  if (hero_vy > MAX_FALL) hero_vy = MAX_FALL;
  hero_yf += hero_vy;
  if (hero_yf < 0) { hero_yf = 0; hero_vy = 0; }
  ny = hero_yf >> 4;
  if (hero_vy > 0) {
    for (py = (int16_t)hero_y + 1; py <= ny; py++) {
      if (solid(hero_x + HB_L, py + 15) || solid(hero_x + HB_R, py + 15)) {
        ny = py - 1; hero_yf = ny << 4; hero_vy = 0; break;
      }
    }
  } else if (hero_vy < 0) {
    for (py = (int16_t)hero_y - 1; py >= ny; py--) {
      if (solid(hero_x + HB_L, py) || solid(hero_x + HB_R, py)) {
        ny = py + 1; hero_yf = ny << 4; hero_vy = 0; break;
      }
    }
  }
  hero_y = (uint8_t)ny;
  grounded = 0u;
  if (hero_vy >= 0 && (solid(hero_x + HB_L, (int16_t)hero_y + 16) || solid(hero_x + HB_R, (int16_t)hero_y + 16))) {
    grounded = 1u; hero_vy = 0; hero_yf = (int16_t)hero_y << 4;
  }
  if (hero_y >= DEATH_Y) { lose_life(); return; }
  cx = (int16_t)hero_y + 8;
  if (tile_at(hero_x + 4u, cx) == 'G' || tile_at(hero_x + 4u, (int16_t)hero_y) == 'G') {
    if (scene < LEVEL_COUNT) enter_level((uint8_t)(scene + 1u));
    else enter_title();
    return;
  }
  cam = hero_x > CAM_LEAD ? hero_x - CAM_LEAD : 0u;
  if (cam > CAM_MAX) cam = CAM_MAX;
}

static void update_title(void) {
  if ((keys & J_START) && !(prev_keys & J_START)) { lives = START_LIVES; enter_level(1u); return; }
  if (tick & 1u) {
    if (cam_dir > 0) { if (cam >= CAM_MAX) cam_dir = -1; else cam++; }
    else { if (cam == 0u) cam_dir = 1; else cam--; }
  }
}

static void update_sprites(void) {
  uint8_t i, bob;
  uint16_t x, d;
  if (scene == 0u) {
    move_sprite(0, 0, 0);
  } else {
    set_sprite_tile(0, ((tick >> 3) & 1u) ? S_WICK_ALT : S_WICK);
    move_sprite(0, (uint8_t)(hero_x - cam + 8u), (uint8_t)(hero_y + 16u));
  }
  d = (tick >> 2) % 168u;
  bob = (uint8_t)((tick >> 3) & 7u);
  if (bob > 3u) bob = (uint8_t)(7u - bob);
  for (i = 0; i < FIREFLY_COUNT; i++) {
    x = (uint16_t)i * FIREFLY_GAP + d;
    if (x >= 168u) x -= 168u;
    move_sprite((uint8_t)(1u + i), (uint8_t)x, (uint8_t)(FIREFLY_Y + 16u + bob));
  }
}

void main(void) {
  uint8_t i;
  DISPLAY_OFF;
  LCDC_REG = LCDC_WITH_WIN & 0x7Fu;
  BGP_REG = BGP_LAND;
  OBP0_REG = 0xE4u;
  OBP1_REG = 0xE4u;
  SCX_REG = 0u; SCY_REG = 0u;
  WX_REG = 7u; WY_REG = 0u;
  load_art();
  draw_bands();
  for (i = 0; i < 40u; i++) {
    move_sprite(i, 0, 0);
    set_sprite_tile(i, S_FIREFLY);
    set_sprite_prop(i, 0);
  }
  set_sprite_tile(0, S_WICK);
  tick = 0u;
  frame_counter = 0u;
  prev_keys = 0u;
  enter_title();
  while (redrawing) service_vram();
  while (hud_dirty) service_vram();
  update_sprites();
  publish();
  CRITICAL {
    STAT_REG = STAT_LYC_IRQ;
    LYC_REG = SPLIT_HUD_END;
    split = 0u;
    add_LCD(lcd_isr);
    add_VBL(vbl_isr);
  }
  IF_REG = 0u;
  set_interrupts(VBL_IFLAG | LCD_IFLAG);
  LCDC_REG = LCDC_WITH_WIN;
  while (1) {
    vsync();
    service_vram();
    keys = joypad();
    if (scene == 0u) update_title();
    else if (!redrawing) update_play();
    update_sprites();
    prev_keys = keys;
    tick++;
    publish();
  }
}
