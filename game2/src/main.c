/* Halogen: a moth of light holds the bottom of a dark sky against beetle swarms, over two sectors.
   Game 2 exists to reach hardware paths game 1 (Fernwake) does not:
     1. a 32 KiB ROM-only cart (no MBC) and BG/window tile data in the 0x8800 block (LCDC bit 4 clear);
     2. a window HUD at the bottom (WY = HUD_WY) and a title card that slides in by WX;
     3. vertical parallax: SCY rewritten at SPLIT_NEBULA, with a BGP swap written mid-line (no HBlank wait);
     4. in sector 2, a switch of the STAT source from LYC to mode-0 HBlank for a per-line SCX shimmer,
        and the STAT writes that switch it (which fire a spurious interrupt on a DMG);
     5. 8x8 objects in sector 1 and 8x16 in sector 2 (LCDC bit 2 flipped per scene), more than 10 per line,
        OBJ-behind-BG priority, X flip, and OBP1 for the beetles' sparks;
     6. the timer interrupt driving the music (APU channels 2 and 4) and the HUD beat lamp, its phase fixed
        by a DIV reset at a fixed point after the LCD comes on (D-draft-game2-timer);
     7. OAM DMA every frame (the GBDK default VBlank handler copies shadow OAM).
   The timer reaches no game state: the beat counter feeds only the APU and the lamp tile.
   vbl_isr writes the SPEC §6.17 RAM contract (contract.h) once per VBlank. */
#include <gb/gb.h>
#include <stdint.h>
#include "contract.h"
#include "art.h"

/* Raster splits (lines). The LYC handler at SPLIT_NEBULA writes without waiting for HBlank. */
#define SPLIT_NEBULA    23u
#define SPLIT_SHIMMER   47u  /* sector 2: STAT source moves to mode-0 HBlank from here */
#define SHIMMER_END     79u  /* ...and back to LYC at this line's HBlank */
#define HUD_WY         128u
#define TITLE_WY        80u
#define JOYPAD_LINE    148u  /* the main loop reads the pad from this VBlank line on */

/* LCDC: on, window map 9C00, window on, tile data 8800, BG map 9800, objects on, BG on; bit 2 = 8x16. */
#define LCDC_8X8   0xE3u
#define LCDC_8X16  0xE7u
#define BGP_NEBULA 0x06u  /* top band: sky dark grey, stars white */
#define BGP_SPACE  0x1Bu  /* inverted: sky black, stars and text white */
#define STAT_LYC   0x40u
#define STAT_HBL   0x08u

/* Timer: 4096 Hz input, modulo TMA_RELOAD gives 64 overflows per second; one music step per 8. */
#define TAC_START   0x04u
#define TMA_RELOAD  0xC0u

/* Play. */
#define SCENE_FRAMES  900u   /* a sector lasts this many frames, then the next begins */
#define TITLE_FRAMES  600u   /* the title starts sector 1 by itself after this many */
#define START_LIVES   5u
#define INVULN_FRAMES 90u
#define HERO_X0       76u
#define HERO_Y0      104u
#define HERO_XMIN      4u
#define HERO_XMAX    148u
#define HERO_YMIN     88u
#define HERO_YMAX    112u
#define BOLTS          3u
#define SPARKS         4u
#define FIRE_EVERY     8u    /* auto-fire period, frames */

/* Formations. Sector 1: 2 rows of 12 one-tile beetles; sector 2: 1 row of 11 tall beetles. */
#define S1_COLS   12u
#define S1_ROWS    2u
#define S1_GAP    11u
#define S1_Y0     32u
#define S1_DY     12u
#define S1_SWEEP  12u
#define S2_COLS   11u
#define S2_GAP    13u
#define S2_Y      56u
#define S2_SWEEP   8u

/* OAM slots. */
#define O_SHIP   0u
#define O_BOLT   2u
#define O_SPARK  5u
#define O_BEETLE 9u
#define O_COUNT 33u

static const uint8_t wobble[16] = { 0, 1, 2, 3, 3, 2, 1, 0, 0, 255, 254, 253, 253, 254, 255, 0 };

/* Music: channel 2 frequency register values, 0 a rest. An original 32-step line. */
static const uint16_t melody[32] = {
  1797, 0, 1849, 1881, 1899, 0, 1881, 1849,
  1825, 1797, 0, 1750, 1797, 0, 0, 0,
  1881, 0, 1899, 1923, 1899, 1881, 0, 1860,
  1849, 0, 1825, 1797, 1750, 0, 1714, 0,
};

/* State read by the interrupt handlers. */
static volatile uint8_t split, fx_shimmer, shimmer_phase;
static volatile uint8_t pub_scene, pub_hero_y, pub_lives, pub_lcdc, pub_wx, pub_wy, pub_scy_far, pub_scy_near;
static volatile uint16_t pub_hero_x;
static volatile uint8_t beat;
static uint8_t music_step;
static uint16_t frame_counter;

/* Game state. */
static uint8_t scene, lives, hero_y, invuln, wx_title;
static uint16_t hero_x, score, scene_tick, tick;
static uint8_t keys, prev_keys;
static uint8_t bolt_on[BOLTS], bolt_x[BOLTS], bolt_y[BOLTS];
static uint8_t spark_on[SPARKS], spark_x[SPARKS], spark_y[SPARKS];
static uint16_t alive[S1_ROWS];
static uint8_t form_x;
static int8_t form_dir;
static uint8_t scy_far, scy_near;
static uint8_t hud_dirty, lamp_shown;
static uint8_t rowbuf[32];

static void lcd_isr(void) {
  uint8_t l;
  if (split == 0u) {
    BGP_REG = BGP_SPACE;
    SCY_REG = pub_scy_near;
    if (fx_shimmer) { LYC_REG = SPLIT_SHIMMER; split = 1u; }
    else split = 3u;
  } else if (split == 1u) {
    split = 2u;
    STAT_REG = STAT_HBL;
  } else if (split == 2u) {
    l = LY_REG;
    if (l >= SHIMMER_END) {
      SCX_REG = 0u;
      split = 3u;
      STAT_REG = STAT_LYC;
    } else {
      SCX_REG = wobble[(uint8_t)(l + shimmer_phase) & 15u];
    }
  }
}

static void vbl_isr(void) {
  LCDC_REG = pub_lcdc;
  BGP_REG = BGP_NEBULA;
  SCY_REG = pub_scy_far;
  SCX_REG = 0u;
  WX_REG = pub_wx;
  WY_REG = pub_wy;
  LYC_REG = SPLIT_NEBULA;
  split = 0u;
  shimmer_phase++;
  frame_counter++;
  RAM8(RAM_COUNTER_ADDR) = (uint8_t)frame_counter;
  RAM8(RAM_COUNTER_ADDR + 1u) = (uint8_t)(frame_counter >> 8);
  RAM8(RAM_SCENE_ADDR) = pub_scene;
  RAM8(RAM_HERO_X_ADDR) = (uint8_t)pub_hero_x;
  RAM8(RAM_HERO_X_ADDR + 1u) = (uint8_t)(pub_hero_x >> 8);
  RAM8(RAM_HERO_Y_ADDR) = pub_hero_y;
  RAM8(RAM_LIVES_ADDR) = pub_lives;
}

static void tim_isr(void) {
  uint16_t f;
  beat++;
  if (beat & 7u) return;
  music_step++;
  f = melody[music_step & 31u];
  if (f) {
    NR21_REG = 0x80u;
    NR22_REG = 0x73u;
    NR23_REG = (uint8_t)f;
    NR24_REG = (uint8_t)(0x80u | (f >> 8));
  }
  if ((music_step & 3u) == 0u) {
    NR42_REG = 0x51u;
    NR43_REG = 0x33u;
    NR44_REG = 0x80u;
  }
}

static void publish(void) {
  disable_interrupts();
  pub_scene = scene;
  pub_hero_x = hero_x;
  pub_hero_y = hero_y;
  pub_lives = lives;
  pub_lcdc = scene == 2u ? LCDC_8X16 : LCDC_8X8;
  pub_wy = scene == 0u ? TITLE_WY : HUD_WY;
  pub_wx = scene == 0u ? wx_title : 7u;
  pub_scy_far = scy_far;
  pub_scy_near = scy_near;
  fx_shimmer = scene == 2u ? 1u : 0u;
  enable_interrupts();
}

/* The starfield: a fixed hash of (x, y) places stars; dust clouds every eighth row. */
static void draw_sky(void) {
  uint8_t x, y, h, m;
  for (y = 0; y < 32u; y++) {
    for (x = 0; x < 32u; x++) {
      h = (uint8_t)((x * 7u + y * 13u + x * y) & 31u);
      m = (uint8_t)((x + y * 3u) % 10u);
      if ((y & 7u) == 3u && m == 2u) rowbuf[x] = T_CLOUD_L;
      else if ((y & 7u) == 3u && m == 3u) rowbuf[x] = T_CLOUD_R;
      else if (h == 0u) rowbuf[x] = T_STAR_BIG;
      else if (h < 3u) rowbuf[x] = T_STAR;
      else rowbuf[x] = T_VOID;
    }
    set_bkg_tiles(0, y, 32, 1, rowbuf);
  }
  for (x = 0; x < 32u; x++) rowbuf[x] = T_VOID;
  for (y = 0; y < 18u; y++) set_win_tiles(0, y, 32, 1, rowbuf);
  for (x = 0; x < 20u; x++) rowbuf[x] = T_RULE;
  set_win_tiles(0, 0, 20, 1, rowbuf);
}

static void text_at(uint8_t col, const char *s) {
  while (*s && col < 20u) rowbuf[col++] = char_tile(*s++);
}

static void blank_row(void) {
  uint8_t i;
  for (i = 0; i < 20u; i++) rowbuf[i] = T_VOID;
}

static void draw_hud(void) {
  uint16_t s;
  uint8_t i;
  blank_row();
  if (scene == 0u) {
    text_at(6, "HALOGEN");
    set_win_tiles(0, 1, 20, 1, rowbuf);
    blank_row();
    text_at(4, "PRESS START");
    set_win_tiles(0, 3, 20, 1, rowbuf);
    return;
  }
  text_at(0, "SC");
  s = score;
  for (i = 0; i < 5u; i++) { rowbuf[7u - i] = char_tile((char)('0' + (uint8_t)(s % 10u))); s /= 10u; }
  text_at(9, "x");
  rowbuf[10] = char_tile((char)('0' + (lives > 9u ? 9u : lives)));
  text_at(12, "LV");
  rowbuf[14] = char_tile((char)('0' + scene));
  rowbuf[19] = lamp_shown ? T_LAMP_ON : T_LAMP_OFF;
  set_win_tiles(0, 1, 20, 1, rowbuf);
}

/* One VRAM job per frame, at the start of VBlank. */
static void service_vram(void) {
  uint8_t lamp;
  if (hud_dirty) { draw_hud(); hud_dirty = 0u; return; }
  if (scene == 0u) return;
  lamp = (uint8_t)((beat >> 5) & 1u);
  if (lamp != lamp_shown) {
    lamp_shown = lamp;
    rowbuf[0] = lamp ? T_LAMP_ON : T_LAMP_OFF;
    set_win_tiles(19, 1, 1, 1, rowbuf);
  }
}

static void clear_shots(void) {
  uint8_t i;
  for (i = 0; i < BOLTS; i++) bolt_on[i] = 0u;
  for (i = 0; i < SPARKS; i++) spark_on[i] = 0u;
}

static void fill_wave(void) {
  alive[0] = scene == 2u ? (1u << S2_COLS) - 1u : (1u << S1_COLS) - 1u;
  alive[1] = scene == 2u ? 0u : (1u << S1_COLS) - 1u;
  form_x = 0u;
  form_dir = 1;
}

static void enter_scene(uint8_t n) {
  scene = n;
  scene_tick = 0u;
  hero_x = HERO_X0;
  hero_y = HERO_Y0;
  invuln = 0u;
  clear_shots();
  fill_wave();
  hud_dirty = 1u;
  if (n == 0u) { lives = START_LIVES; score = 0u; wx_title = 166u; }
}

static uint8_t cols(void) { return scene == 2u ? S2_COLS : S1_COLS; }
static uint8_t gap(void) { return scene == 2u ? S2_GAP : S1_GAP; }
static uint8_t sweep(void) { return scene == 2u ? S2_SWEEP : S1_SWEEP; }
static uint8_t row_y(uint8_t r) { return scene == 2u ? S2_Y : (uint8_t)(S1_Y0 + r * S1_DY); }
static uint8_t beetle_h(void) { return scene == 2u ? 16u : 8u; }

/* The column whose beetle covers screen x, or 255. */
static uint8_t col_at(uint8_t x) {
  uint8_t base = (uint8_t)(8u + form_x), c, off;
  if (x < base) return 255u;
  c = (uint8_t)((x - base) / gap());
  off = (uint8_t)((x - base) % gap());
  if (c >= cols() || off >= 8u) return 255u;
  return c;
}

static void update_bolts(void) {
  uint8_t i, r, c, rows = scene == 2u ? 1u : S1_ROWS, y;
  uint8_t fire = (uint8_t)((scene_tick & (FIRE_EVERY - 1u)) == 0u || ((keys & J_A) && !(prev_keys & J_A)));
  for (i = 0; i < BOLTS; i++) {
    if (!bolt_on[i]) {
      if (fire) { bolt_on[i] = 1u; bolt_x[i] = (uint8_t)(hero_x + 4u); bolt_y[i] = (uint8_t)(hero_y - 6u); fire = 0u; }
      continue;
    }
    if (bolt_y[i] < 12u) { bolt_on[i] = 0u; continue; }
    bolt_y[i] -= 4u;
    for (r = 0; r < rows; r++) {
      y = row_y(r);
      if (bolt_y[i] + 2u < y || bolt_y[i] >= y + beetle_h()) continue;
      c = col_at((uint8_t)(bolt_x[i] + 3u));
      if (c != 255u && (alive[r] & (1u << c))) {
        alive[r] &= (uint16_t)~(1u << c);
        bolt_on[i] = 0u;
        score += scene == 2u ? 25u : 10u;
        hud_dirty = 1u;
        break;
      }
    }
  }
  if (alive[0] == 0u && alive[1] == 0u) { fill_wave(); score += 100u; hud_dirty = 1u; }
}

static void lose_life(void) {
  if (lives) lives--;
  if (lives == 0u) { enter_scene(0u); return; }
  invuln = INVULN_FRAMES;
  clear_shots();
  hud_dirty = 1u;
}

static void update_sparks(void) {
  uint8_t i, c, k, r = 255u, every = scene == 2u ? 32u : 40u;
  if (scene_tick % every == (uint16_t)(every - 1u)) {
    /* The dropping column steps by 5 each drop and skips to the next live beetle. */
    c = (uint8_t)(((scene_tick / every) * 5u + score) % cols());
    for (k = 0; k < cols(); k++) {
      r = (alive[1] & (1u << c)) ? 1u : (alive[0] & (1u << c)) ? 0u : 255u;
      if (r != 255u) break;
      c = (uint8_t)((c + 1u) % cols());
    }
    if (r != 255u) {
      for (i = 0; i < SPARKS; i++) {
        if (spark_on[i]) continue;
        spark_on[i] = 1u;
        spark_x[i] = (uint8_t)(8u + form_x + c * gap());
        spark_y[i] = (uint8_t)(row_y(r) + beetle_h());
        break;
      }
    }
  }
  for (i = 0; i < SPARKS; i++) {
    if (!spark_on[i]) continue;
    spark_y[i] += 2u;
    if (spark_y[i] >= 128u) { spark_on[i] = 0u; continue; }
    if (!invuln && spark_y[i] + 6u > hero_y + 2u && spark_y[i] < hero_y + 8u
        && (uint8_t)(spark_x[i] + 6u) > (uint8_t)hero_x && spark_x[i] < (uint8_t)(hero_x + 14u)) {
      lose_life();
      return;
    }
  }
}

static void update_play(void) {
  uint8_t steps = (tick & 1u) ? 2u : 1u;
  if ((keys & J_LEFT) && hero_x > HERO_XMIN) hero_x -= steps;
  if ((keys & J_RIGHT) && hero_x < HERO_XMAX) hero_x += steps;
  if (hero_x < HERO_XMIN) hero_x = HERO_XMIN;
  if (hero_x > HERO_XMAX) hero_x = HERO_XMAX;
  if ((keys & J_UP) && hero_y > HERO_YMIN) hero_y--;
  if ((keys & J_DOWN) && hero_y < HERO_YMAX) hero_y++;
  if (invuln) invuln--;
  if (tick & 1u) {
    if (form_dir > 0) { if (form_x >= sweep()) form_dir = -1; else form_x++; }
    else { if (form_x == 0u) form_dir = 1; else form_x--; }
  }
  update_bolts();
  if (scene == 0u) return;
  update_sparks();
  if (scene == 0u) return;
  if (++scene_tick >= SCENE_FRAMES) enter_scene(scene == 1u ? 2u : 1u);
}

static void update_title(void) {
  if (wx_title > 7u) wx_title -= 2u;
  if (wx_title < 7u) wx_title = 7u;
  if (((keys & J_START) && !(prev_keys & J_START)) || ++scene_tick >= TITLE_FRAMES) enter_scene(1u);
}

static void update_sprites(void) {
  uint8_t i, r, c, o, x, flip, rows, ship = scene != 0u && !(invuln & 4u);
  move_sprite(O_SHIP, ship ? (uint8_t)(hero_x + 8u) : 0u, ship ? (uint8_t)(hero_y + 16u) : 0u);
  move_sprite(O_SHIP + 1u, ship ? (uint8_t)(hero_x + 16u) : 0u, ship ? (uint8_t)(hero_y + 16u) : 0u);
  for (i = 0; i < BOLTS; i++)
    move_sprite((uint8_t)(O_BOLT + i), bolt_on[i] ? (uint8_t)(bolt_x[i] + 8u) : 0u, bolt_on[i] ? (uint8_t)(bolt_y[i] + 16u) : 0u);
  for (i = 0; i < SPARKS; i++)
    move_sprite((uint8_t)(O_SPARK + i), spark_on[i] ? (uint8_t)(spark_x[i] + 8u) : 0u, spark_on[i] ? (uint8_t)(spark_y[i] + 16u) : 0u);
  flip = ((tick >> 4) & 1u) ? S_FLIPX : 0u;
  rows = scene == 0u ? 0u : scene == 2u ? 1u : S1_ROWS;
  o = O_BEETLE;
  for (r = 0; r < rows; r++) {
    for (c = 0; c < cols(); c++, o++) {
      if (!(alive[r] & (1u << c))) { move_sprite(o, 0, 0); continue; }
      x = (uint8_t)(8u + form_x + c * gap());
      set_sprite_tile(o, scene == 2u ? S_BIG_TOP : S_BEETLE);
      set_sprite_prop(o, scene == 2u ? (uint8_t)(S_PALETTE | flip) : (uint8_t)(S_PRIORITY | flip));
      move_sprite(o, (uint8_t)(x + 8u), (uint8_t)(row_y(r) + 16u));
    }
  }
  for (; o < O_COUNT; o++) move_sprite(o, 0, 0);
}

void main(void) {
  uint8_t i;
  DISPLAY_OFF;
  LCDC_REG = LCDC_8X8 & 0x7Fu;
  BGP_REG = BGP_NEBULA;
  OBP0_REG = 0x90u;
  OBP1_REG = 0x18u;
  SCX_REG = 0u; SCY_REG = 0u;
  WX_REG = 166u; WY_REG = TITLE_WY;
  NR52_REG = 0x80u;
  NR50_REG = 0x77u;
  NR51_REG = 0xFFu;
  load_art();
  draw_sky();
  for (i = 0; i < 40u; i++) { move_sprite(i, 0, 0); set_sprite_tile(i, S_BEETLE); set_sprite_prop(i, 0); }
  set_sprite_tile(O_SHIP, S_SHIP_L);
  set_sprite_tile(O_SHIP + 1u, S_SHIP_R);
  for (i = 0; i < BOLTS; i++) set_sprite_tile((uint8_t)(O_BOLT + i), S_BOLT);
  for (i = 0; i < SPARKS; i++) { set_sprite_tile((uint8_t)(O_SPARK + i), S_SPARK); set_sprite_prop((uint8_t)(O_SPARK + i), S_PALETTE); }
  tick = 0u; frame_counter = 0u; prev_keys = 0u; beat = 0u; music_step = 0u;
  scy_far = 0u; scy_near = 0u; lamp_shown = 0u;
  enter_scene(0u);
  draw_hud();
  hud_dirty = 0u;
  update_sprites();
  publish();
  CRITICAL {
    STAT_REG = STAT_LYC;
    LYC_REG = SPLIT_NEBULA;
    split = 0u;
    add_LCD(lcd_isr);
    add_VBL(vbl_isr);
    add_TIM(tim_isr);
  }
  IF_REG = 0u;
  set_interrupts(VBL_IFLAG | LCD_IFLAG);
  LCDC_REG = LCDC_8X8;
  /* The timer's phase: DIV is reset one VBlank after the LCD comes on, then the timer starts. */
  vsync();
  CRITICAL {
    DIV_REG = 0u;
    TMA_REG = TMA_RELOAD;
    TIMA_REG = TMA_RELOAD;
    TAC_REG = TAC_START;
    IF_REG &= (uint8_t)~TIM_IFLAG;
    set_interrupts(VBL_IFLAG | LCD_IFLAG | TIM_IFLAG);
  }
  while (1) {
    vsync();
    service_vram();
    /* The pad is read from line JOYPAD_LINE on. A read in the first VBlank lines lands before the oracle
       applies the frame's input and one frame after the core does (reading 2026-11-07: scene 1 at counter 32
       on the S1 core, 33 on SameBoy); game2/game2.test.ts smoke reads equal contract RAM at counter 60. */
    while (LY_REG >= 144u && LY_REG < JOYPAD_LINE) ;
    keys = joypad();
    if (scene == 0u) update_title();
    else update_play();
    if ((tick & 3u) == 0u) scy_far--;
    scy_near--;
    update_sprites();
    prev_keys = keys;
    tick++;
    publish();
  }
}
