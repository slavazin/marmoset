#!/usr/bin/env python3
"""Oracle frontend: SameBoy's libretro core, run headless, speaking SPEC §6.4.

One JSON request per stdin line, one JSON response per stdout line. Requests
are the `OracleReq` union in src/schema.ts. `load` takes an optional `align`
("counter", the default, or "frame") and an optional `model` ("DMG", the
default, or "CGB"; D-0019). `frame` returns DMG shades and refuses any colour
outside the greyscale palette; `frame_rgb` returns the RGB888 frame of either
model.

Alignment:
  align "counter": `run_to_counter n` runs frames until the game's counter
    (WRAM 0xC0F0, 2 bytes little-endian; SPEC §6.17) reads n. `frame` then
    returns the frame completed before the VBlank that wrote n.
  align "frame": the counter is the number of frames completed since load;
    `frame` returns the last completed frame. Residue: SameBoy runs its DMG
    boot ROM, so frame indices include the boot frames a post-boot core skips.
Inputs (`TraceInput[]`) are keyed by that same counter: the entry with the
largest `from_counter` <= the counter before a frame holds for that frame.

Python 3 stdlib only. The dylib path comes from $SAMEBOY_LIBRETRO.
"""

import base64
import ctypes
import hashlib
import json
import os
import struct
import sys

# --- libretro API constants (libretro.h) -------------------------------------
ENV_GET_CAN_DUPE = 3
ENV_GET_SYSTEM_DIRECTORY = 9
ENV_SET_PIXEL_FORMAT = 10
ENV_GET_VARIABLE = 15
ENV_SET_VARIABLES = 16
ENV_GET_VARIABLE_UPDATE = 17
ENV_GET_SAVE_DIRECTORY = 31
PIXEL_FORMAT_XRGB8888 = 1
MEMORY_SYSTEM_RAM = 2
DEVICE_JOYPAD = 1
JOYPAD_ID_MASK = 256

# TraceInput mask bit (src/schema.ts Core.setButtons) -> libretro joypad id.
MASK_BIT_TO_RETRO_ID = {
    0: 7,  # right
    1: 6,  # left
    2: 4,  # up
    3: 5,  # down
    4: 8,  # A
    5: 0,  # B
    6: 2,  # select
    7: 3,  # start
}

# Core options forced on SameBoy. Keys and values are those SameBoy's
# libretro/libretro.c check_variables() compares against (SameBoy commit
# ea667ad, version 1.0.5, read 2026-11-07). That libretro core defines no
# frame-blending option in libretro/libretro_core_options.inc, so none is set.
CORE_OPTIONS = {
    b"sameboy_model": b"Game Boy",
    b"sameboy_mono_palette": b"greyscale",
    b"sameboy_color_correction_mode": b"off",
    b"sameboy_light_temperature": b"0",
    b"sameboy_border": b"never",
    b"sameboy_high_pass_filter_mode": b"off",
    b"sameboy_audio_interference": b"0",
    b"sameboy_rumble": b"never",
    b"sameboy_rtc": b"accurate",
}

# SHADE_OF_RGB: SameBoy's greyscale palette (GB_PALETTE_GREY) with colour
# correction off, as 0xRRGGBB -> DMG shade (0 = white). Read from a dmg-acid2
# run and asserted by oracle/oracle.test.ts ("dmg-acid2 emits exactly SameBoy's
# four greyscale palette values ..."). Any other colour raises; no nearest match.
SHADE_OF_RGB = {0xFFFFFF: 0, 0xAAAAAA: 1, 0x555555: 2, 0x000000: 3}
WIDTH, HEIGHT = 160, 144
FRAME_BYTES = WIDTH * HEIGHT

# STALL_FRAMES: frames run_to_counter runs without the counter reaching its
# target before it answers stalled=true. 600 frames is 10 s of DMG time, longer
# than any boot or scene transition a contract ROM is allowed (SPEC §6.17).
STALL_FRAMES = 600

# RANDOM_SEED: SameBoy seeds its power-on RAM noise from time(NULL)
# (SameBoy Core/random.c, init_seed); the frontend reseeds GB_random_seed with
# this constant before every load so two runs start from equal RAM.
RANDOM_SEED = 0x5EED

# MODEL_OPTION: the sameboy_model value each `load` model forces. "Game Boy"
# is GB_MODEL_DMG_B and "Game Boy Color C" is GB_MODEL_CGB_C in SameBoy's
# libretro/libretro.c string_to_model() (commit ea667ad, read 2026-11-07).
# CPU CGB C is chosen because the Mealybug CGB references in the ROM pack are
# the `_cgb_c.png` set ("CPU CGB C"); cgb-acid2 and cgb-acid-hell name no
# revision. SameBoy reads the option in retro_load_game (check_variables), so
# each load takes the model it asks for. Colour correction stays "off": SameBoy
# then expands each RGB555 channel by (x << 3) | (x >> 2) (Core/display.c
# scale_channel), the convention cgb-acid2's and Mealybug's READMEs give for
# their reference images.
MODEL_OPTION = {"DMG": b"Game Boy", "CGB": b"Game Boy Color C"}
RGB_BYTES = WIDTH * HEIGHT * 3

COUNTER_OFFSET = 0xC0F0 - 0xC000
WRAM_BASE, WRAM_END = 0xC000, 0xE000
STATE_MAGIC = b"RTO1"

# A translate table that sends each of the four exact grey levels to its shade
# and every other byte to 0xFF, the error sentinel.
_GREY_TABLE = bytearray([0xFF] * 256)
for _rgb, _shade in SHADE_OF_RGB.items():
    _GREY_TABLE[_rgb & 0xFF] = _shade
_GREY_TABLE = bytes(_GREY_TABLE)


class RetroVariable(ctypes.Structure):
    _fields_ = [("key", ctypes.c_char_p), ("value", ctypes.c_char_p)]


class RetroGameInfo(ctypes.Structure):
    _fields_ = [
        ("path", ctypes.c_char_p),
        ("data", ctypes.c_void_p),
        ("size", ctypes.c_size_t),
        ("meta", ctypes.c_char_p),
    ]


class RetroSystemInfo(ctypes.Structure):
    _fields_ = [
        ("library_name", ctypes.c_char_p),
        ("library_version", ctypes.c_char_p),
        ("valid_extensions", ctypes.c_char_p),
        ("need_fullpath", ctypes.c_bool),
        ("block_extract", ctypes.c_bool),
    ]


ENV_CB = ctypes.CFUNCTYPE(ctypes.c_bool, ctypes.c_uint, ctypes.c_void_p)
VIDEO_CB = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_size_t)
AUDIO_SAMPLE_CB = ctypes.CFUNCTYPE(None, ctypes.c_int16, ctypes.c_int16)
AUDIO_BATCH_CB = ctypes.CFUNCTYPE(ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t)
INPUT_POLL_CB = ctypes.CFUNCTYPE(None)
INPUT_STATE_CB = ctypes.CFUNCTYPE(ctypes.c_int16, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint)


def default_dylib():
    return os.environ.get("SAMEBOY_LIBRETRO") or os.path.expanduser(
        "~/.cache/ratchet/tools/SameBoy/build/bin/sameboy_libretro.dylib")


def rgb_to_shades(raw, width, height, pitch):
    """Map one XRGB8888 frame to 23040 shade bytes; raise on any non-palette colour."""
    if width != WIDTH or height != HEIGHT:
        raise ValueError(f"frame is {width}x{height}, expected {WIDTH}x{HEIGHT}")
    if pitch != WIDTH * 4:
        raw = b"".join(raw[y * pitch:y * pitch + WIDTH * 4] for y in range(HEIGHT))
    b, g, r = raw[0::4], raw[1::4], raw[2::4]
    if not (b == g == r):
        raise ValueError("frame holds a non-grey colour")
    shades = b.translate(_GREY_TABLE)
    if b"\xff" in shades:
        bad = sorted({v for v in b if _GREY_TABLE[v] == 0xFF})
        raise ValueError(f"frame holds grey levels outside the palette: {[hex(v) for v in bad]}")
    return shades


def xrgb_to_rgb888(raw, width, height, pitch):
    """Map one XRGB8888 frame (little-endian B,G,R,X bytes) to 160*144*3 R,G,B bytes."""
    if width != WIDTH or height != HEIGHT:
        raise ValueError(f"frame is {width}x{height}, expected {WIDTH}x{HEIGHT}")
    if pitch != WIDTH * 4:
        raw = b"".join(raw[y * pitch:y * pitch + WIDTH * 4] for y in range(HEIGHT))
    out = bytearray(RGB_BYTES)
    out[0::3] = raw[2::4]
    out[1::3] = raw[1::4]
    out[2::3] = raw[0::4]
    return bytes(out)


def distinct_colours(raw, pitch):
    """The set of 0xRRGGBB values in one XRGB8888 frame (palette reading)."""
    out = set()
    for y in range(HEIGHT):
        row = raw[y * pitch:y * pitch + WIDTH * 4]
        for x in range(WIDTH):
            out.add(struct.unpack_from("<I", row, x * 4)[0] & 0xFFFFFF)
    return out


class Oracle:
    def __init__(self, dylib_path):
        self.dylib_path = dylib_path
        with open(dylib_path, "rb") as f:
            self.build_hash = hashlib.sha256(f.read()).hexdigest()
        self.lib = ctypes.CDLL(dylib_path)
        self._declare()
        tools_dir = os.path.join(os.environ.get("RATCHET_CACHE") or os.path.expanduser("~/.cache/ratchet"), "oracle", "sys")
        os.makedirs(tools_dir, exist_ok=True)
        self._dir_bytes = tools_dir.encode()
        self._dir_buf = ctypes.create_string_buffer(self._dir_bytes)
        self._option_bufs = {k: ctypes.create_string_buffer(v) for k, v in CORE_OPTIONS.items()}
        self.unknown_variables = set()
        self.mask = 0
        self.raw = None           # last completed frame, raw XRGB bytes
        self.raw_prev = None      # the frame completed before `raw`
        self.geom = (WIDTH, HEIGHT, WIDTH * 4)
        self.frames = 0           # frames completed since load
        self.loaded = False
        self.align = "counter"
        self.model = "DMG"
        self.counter_live = False
        self.first_write_frame = None  # frame index of the game's first counter write
        self.compare_raw = None   # the frame `frame` returns
        self._rom = None
        # Every ctypes callback is held here for the life of the process; a
        # collected callback is a dangling C pointer inside SameBoy.
        self._callbacks = {
            "env": ENV_CB(self._env),
            "video": VIDEO_CB(self._video),
            "audio": AUDIO_SAMPLE_CB(lambda l, r: None),
            "audio_batch": AUDIO_BATCH_CB(lambda data, frames: frames),
            "poll": INPUT_POLL_CB(lambda: None),
            "state": INPUT_STATE_CB(self._input_state),
        }
        lib = self.lib
        lib.retro_set_environment(self._callbacks["env"])
        lib.retro_set_video_refresh(self._callbacks["video"])
        lib.retro_set_audio_sample(self._callbacks["audio"])
        lib.retro_set_audio_sample_batch(self._callbacks["audio_batch"])
        lib.retro_set_input_poll(self._callbacks["poll"])
        lib.retro_set_input_state(self._callbacks["state"])
        lib.retro_init()
        info = RetroSystemInfo()
        lib.retro_get_system_info(ctypes.byref(info))
        self.version = (info.library_version or b"").decode()

    def _declare(self):
        lib = self.lib
        for name in ("retro_set_environment", "retro_set_video_refresh", "retro_set_audio_sample",
                     "retro_set_audio_sample_batch", "retro_set_input_poll", "retro_set_input_state"):
            getattr(lib, name).argtypes = [ctypes.c_void_p]
            getattr(lib, name).restype = None
        lib.retro_init.restype = None
        lib.retro_run.restype = None
        lib.retro_unload_game.restype = None
        lib.retro_get_system_info.argtypes = [ctypes.POINTER(RetroSystemInfo)]
        lib.retro_load_game.argtypes = [ctypes.POINTER(RetroGameInfo)]
        lib.retro_load_game.restype = ctypes.c_bool
        lib.retro_serialize_size.restype = ctypes.c_size_t
        lib.retro_serialize.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        lib.retro_serialize.restype = ctypes.c_bool
        lib.retro_unserialize.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        lib.retro_unserialize.restype = ctypes.c_bool
        lib.retro_get_memory_data.argtypes = [ctypes.c_uint]
        lib.retro_get_memory_data.restype = ctypes.c_void_p
        lib.retro_get_memory_size.argtypes = [ctypes.c_uint]
        lib.retro_get_memory_size.restype = ctypes.c_size_t
        lib.GB_random_seed.argtypes = [ctypes.c_uint64]
        lib.GB_random_seed.restype = None

    # --- callbacks -------------------------------------------------------------
    def _env(self, cmd, data):
        try:
            if cmd == ENV_SET_PIXEL_FORMAT:
                return ctypes.cast(data, ctypes.POINTER(ctypes.c_int))[0] == PIXEL_FORMAT_XRGB8888
            if cmd == ENV_GET_VARIABLE:
                var = ctypes.cast(data, ctypes.POINTER(RetroVariable))[0]
                buf = self._option_bufs.get(var.key)
                if buf is None:
                    self.unknown_variables.add(var.key.decode() if var.key else "")
                    var.value = None
                    return False
                ctypes.cast(data, ctypes.POINTER(ctypes.c_void_p))[1] = ctypes.addressof(buf)
                return True
            if cmd == ENV_GET_VARIABLE_UPDATE:
                ctypes.cast(data, ctypes.POINTER(ctypes.c_bool))[0] = False
                return True
            if cmd in (ENV_GET_SYSTEM_DIRECTORY, ENV_GET_SAVE_DIRECTORY):
                ctypes.cast(data, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(self._dir_buf)
                return True
            if cmd == ENV_SET_VARIABLES:
                return True
            if cmd == ENV_GET_CAN_DUPE:
                ctypes.cast(data, ctypes.POINTER(ctypes.c_bool))[0] = True
                return True
        except Exception as e:  # an exception must never unwind through C
            sys.stderr.write(f"oracle env cmd {cmd}: {e}\n")
        return False

    def _video(self, data, width, height, pitch):
        if not data:
            return  # a duped frame: the last completed frame stands
        self.raw_prev = self.raw
        self.raw = ctypes.string_at(data, pitch * height)
        self.geom = (width, height, pitch)

    def _input_state(self, port, device, index, ident):
        if port != 0 or device != DEVICE_JOYPAD:
            return 0
        if ident == JOYPAD_ID_MASK:
            bits = 0
            for bit, rid in MASK_BIT_TO_RETRO_ID.items():
                if self.mask >> bit & 1:
                    bits |= 1 << rid
            return bits
        for bit, rid in MASK_BIT_TO_RETRO_ID.items():
            if rid == ident:
                return 1 if self.mask >> bit & 1 else 0
        return 0

    # --- state -----------------------------------------------------------------
    def _wram(self):
        ptr = self.lib.retro_get_memory_data(MEMORY_SYSTEM_RAM)
        size = self.lib.retro_get_memory_size(MEMORY_SYSTEM_RAM)
        if not ptr or size < WRAM_END - WRAM_BASE:
            raise RuntimeError(f"SYSTEM_RAM unavailable (size {size})")
        return ptr

    def counter(self):
        if self.align == "frame":
            return self.frames
        return struct.unpack("<H", ctypes.string_at(self._wram() + COUNTER_OFFSET, 2))[0]

    def run_frame(self):
        self.lib.retro_run()
        self.frames += 1

    # --- ops -------------------------------------------------------------------
    def op_load(self, req):
        align = req.get("align", "counter")
        if align not in ("counter", "frame"):
            raise ValueError(f"align must be counter or frame, got {align!r}")
        model = req.get("model", "DMG")
        if model not in MODEL_OPTION:
            raise ValueError(f"model must be DMG or CGB, got {model!r}")
        self._option_bufs[b"sameboy_model"] = ctypes.create_string_buffer(MODEL_OPTION[model])
        if self.loaded:
            self.lib.retro_unload_game()
        with open(req["rom_path"], "rb") as f:
            rom = f.read()
        self._rom = ctypes.create_string_buffer(rom, len(rom))
        self.lib.GB_random_seed(RANDOM_SEED)
        path = ctypes.create_string_buffer(os.path.abspath(req["rom_path"]).encode())
        info = RetroGameInfo(ctypes.cast(path, ctypes.c_char_p), ctypes.cast(self._rom, ctypes.c_void_p), len(rom), None)
        self._path = path
        if not self.lib.retro_load_game(ctypes.byref(info)):
            raise RuntimeError("retro_load_game refused the ROM")
        self.loaded = True
        self.align = align
        self.model = model
        self.frames = 0
        self.counter_live = align == "frame"
        self.first_write_frame = None
        self.raw = self.raw_prev = self.compare_raw = None
        self.mask = 0
        return {"rom_sha": hashlib.sha256(rom).hexdigest(), "align": align, "model": model}

    def op_run_to_counter(self, req):
        if not self.loaded:
            raise RuntimeError("no ROM loaded")
        target = int(req["counter"])
        inputs = sorted(req.get("inputs") or [], key=lambda i: i["from_counter"])
        since_change = 0
        cur = self.counter()
        while not (self.counter_live and cur == target):
            if self.counter_live and cur > target:
                return {"counter": cur, "stalled": True}
            key = cur if self.counter_live else 0
            mask = 0
            for entry in inputs:
                if entry["from_counter"] <= key:
                    mask = entry["mask"]
                else:
                    break
            self.mask = mask
            before_raw = self.raw
            self.run_frame()
            nxt = self.counter()
            if nxt == cur:
                since_change += 1
                if since_change >= STALL_FRAMES:
                    return {"counter": cur, "stalled": True}
            else:
                since_change = 0
                if not self.counter_live:
                    # Power-on RAM at 0xC0F0 is noise until the game writes it;
                    # the first change marks the counter as the game's.
                    self.counter_live = True
                    self.first_write_frame = self.frames
            cur = nxt
            if self.counter_live and cur == target:
                # counter: the VBlank handler that writes n runs at the start of
                # the retro_run after the one that delivered the frame, so the
                # frame completed before that VBlank is the one at entry
                # (oracle/oracle.test.ts reads it on counter.gb's SCX).
                self.compare_raw = before_raw if self.align == "counter" else self.raw
        if self.compare_raw is None:
            self.compare_raw = self.raw
        return {"counter": cur, "stalled": False}

    def op_frame(self, req):
        raw = self.compare_raw if self.compare_raw is not None else self.raw
        if raw is None:
            raise RuntimeError("no frame completed")
        w, h, p = self.geom
        return {"shades_b64": base64.b64encode(rgb_to_shades(raw, w, h, p)).decode()}

    def op_frame_rgb(self, req):
        raw = self.compare_raw if self.compare_raw is not None else self.raw
        if raw is None:
            raise RuntimeError("no frame completed")
        w, h, p = self.geom
        return {"rgb_b64": base64.b64encode(xrgb_to_rgb888(raw, w, h, p)).decode()}

    def op_colours(self, req):
        """Debug op: the distinct 0xRRGGBB values in the frame `frame` returns."""
        raw = self.compare_raw if self.compare_raw is not None else self.raw
        return {"colours": sorted(distinct_colours(raw, self.geom[2]))}

    def op_ram(self, req):
        addr, length = int(req["addr"]), int(req["len"])
        if addr < WRAM_BASE or length < 0 or addr + length > WRAM_END:
            raise ValueError("ram reads WRAM 0xC000-0xDFFF only")
        data = ctypes.string_at(self._wram() + (addr - WRAM_BASE), length)
        return {"bytes_b64": base64.b64encode(data).decode()}

    def op_save(self, req):
        size = self.lib.retro_serialize_size()
        buf = ctypes.create_string_buffer(size)
        if not self.lib.retro_serialize(buf, size):
            raise RuntimeError("retro_serialize failed")
        frames = [self.raw, self.raw_prev, self.compare_raw]
        head = STATE_MAGIC + struct.pack("<QBB", self.frames, 1 if self.align == "frame" else 0, 1 if self.counter_live else 0)
        parts = [head]
        for fr in frames:
            fr = fr or b""
            parts.append(struct.pack("<I", len(fr)) + fr)
        parts.append(buf.raw)
        return {"state_b64": base64.b64encode(b"".join(parts)).decode()}

    def op_restore(self, req):
        blob = base64.b64decode(req["state_b64"])
        if blob[:4] != STATE_MAGIC:
            raise ValueError("state is not an oracle save")
        frames, align, live = struct.unpack_from("<QBB", blob, 4)
        off = 4 + 10
        saved = []
        for _ in range(3):
            (n,) = struct.unpack_from("<I", blob, off)
            off += 4
            saved.append(blob[off:off + n] or None)
            off += n
        state = blob[off:]
        buf = ctypes.create_string_buffer(state, len(state))
        if not self.lib.retro_unserialize(buf, len(state)):
            raise RuntimeError("retro_unserialize failed")
        self.frames = frames
        self.align = "frame" if align else "counter"
        self.counter_live = bool(live)
        self.raw, self.raw_prev, self.compare_raw = saved
        return {}

    def op_info(self, req):
        return {"core": "SameBoy", "version": self.version, "model": self.model, "build_hash": self.build_hash,
                "frames": self.frames, "first_write_frame": self.first_write_frame}


def main():
    # The protocol owns the original stdout; fd 1 is pointed at stderr so any
    # print from inside SameBoy cannot corrupt a response line.
    out = os.fdopen(os.dup(1), "w", buffering=1)
    os.dup2(2, 1)
    oracle = Oracle(default_dylib())
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            handler = getattr(oracle, "op_" + str(req.get("op")), None)
            if handler is None:
                raise ValueError(f"unknown op {req.get('op')!r}")
            res = {"ok": True}
            res.update(handler(req))
        except Exception as e:
            res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        out.write(json.dumps(res) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
