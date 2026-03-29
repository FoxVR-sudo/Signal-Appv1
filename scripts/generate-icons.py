#!/usr/bin/env python3
"""
Generate Android mipmap icons for Signal Citizen and Signal Patrol.

Requirements: Pillow  (pip install pillow)
Run from repo root:  python3 scripts/generate-icons.py
"""
from PIL import Image, ImageDraw
import math
import os

BASE = os.path.join(os.path.dirname(__file__), "..", "apps")
MIPMAP_SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}
SS = 8  # superscale factor for smooth anti-aliasing


def draw_citizen(s: int, round_shape: bool = False) -> Image.Image:
    S = s * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bg = (11, 61, 145, 255)    # #0b3d91 Signal Blue
    white = (255, 255, 255, 255)
    yellow = (255, 210, 50, 255)

    if round_shape:
        d.ellipse([0, 0, S - 1, S - 1], fill=bg)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=bg)

    m = int(S * 0.13)
    bx1, bx2 = m, S - m
    bw = bx2 - bx1
    bh = int(bw * 0.60)
    by1 = (S - bh) // 2 + int(S * 0.05)
    by2 = by1 + bh
    d.rounded_rectangle([bx1, by1, bx2, by2], radius=max(3, int(S * 0.07)), fill=white)

    vbw = int(bw * 0.28)
    vbh = int(bh * 0.22)
    vbx = S // 2 - vbw // 2
    d.rounded_rectangle([vbx, by1 - vbh, vbx + vbw, by1 + int(S * 0.01)],
                        radius=max(2, int(S * 0.025)), fill=white)

    lcx, lcy = S // 2, by1 + bh // 2
    lr = int(bh * 0.28)
    d.ellipse([lcx - lr, lcy - lr, lcx + lr, lcy + lr], fill=bg)
    lr2 = int(lr * 0.70)
    d.ellipse([lcx - lr2, lcy - lr2, lcx + lr2, lcy + lr2], fill=white)
    lr3 = int(lr2 * 0.40)
    d.ellipse([lcx - lr3, lcy - lr3, lcx + lr3, lcy + lr3], fill=bg)

    fd = int(bh * 0.09)
    fx = bx2 - int(bw * 0.13)
    fy = by1 + int(bh * 0.18)
    d.ellipse([fx - fd, fy - fd, fx + fd, fy + fd], fill=yellow)

    return img.resize((s, s), Image.LANCZOS)


def draw_patrol(s: int, round_shape: bool = False) -> Image.Image:
    S = s * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bg = (8, 18, 36, 255)
    gold = (255, 190, 0, 255)

    if round_shape:
        d.ellipse([0, 0, S - 1, S - 1], fill=bg)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=bg)

    cx = S // 2
    shield_t = int(S * 0.10)
    shield_b = int(S * 0.90)
    shield_l = int(S * 0.16)
    shield_r = S - int(S * 0.16)
    shield_mid_y = shield_t + int((shield_b - shield_t) * 0.62)

    shield_pts = [
        (shield_l + int(S * 0.06), shield_t),
        (shield_r - int(S * 0.06), shield_t),
        (shield_r, shield_t + int(S * 0.08)),
        (shield_r, shield_mid_y),
        (cx, shield_b),
        (shield_l, shield_mid_y),
        (shield_l, shield_t + int(S * 0.08)),
    ]
    d.polygon(shield_pts, fill=gold)

    inset = int(S * 0.055)
    mid_cx = float(cx)
    mid_cy = shield_t + (shield_b - shield_t) * 0.40
    inner_pts = []
    for px, py in shield_pts:
        dx = mid_cx - px
        dy = mid_cy - py
        dn = math.hypot(dx, dy)
        ratio = min(inset / dn, 0.25) if dn > 0 else 0
        inner_pts.append((px + dx * ratio, py + dy * ratio))
    d.polygon(inner_pts, fill=bg)

    star_cx = float(cx)
    star_cy = shield_t + (shield_b - shield_t) * 0.40
    star_ro = (shield_r - shield_l) * 0.26
    star_ri = star_ro * 0.40
    star_pts = []
    for i in range(10):
        angle = math.pi * i / 5 - math.pi / 2
        r = star_ro if i % 2 == 0 else star_ri
        star_pts.append((star_cx + r * math.cos(angle), star_cy + r * math.sin(angle)))
    d.polygon(star_pts, fill=gold)

    return img.resize((s, s), Image.LANCZOS)


def save_icons(app_dir: str, label: str, fn) -> None:
    for folder, size in MIPMAP_SIZES.items():
        res_dir = os.path.join(app_dir, "android", "app", "src", "main", "res", folder)
        if not os.path.isdir(res_dir):
            print(f"  SKIP {folder} (dir not found)")
            continue
        for fname, rnd in [("ic_launcher.webp", False), ("ic_launcher_round.webp", True)]:
            icon = fn(size, rnd).convert("RGB")
            icon.save(os.path.join(res_dir, fname), "WEBP", quality=95)
        print(f"  {label} {size}px ✓")


if __name__ == "__main__":
    print("Generating Citizen icons...")
    save_icons(os.path.join(BASE, "citizen-mobile"), "citizen", draw_citizen)
    print("Generating Patrol icons...")
    save_icons(os.path.join(BASE, "patrol-mobile"), "patrol", draw_patrol)
    print("All icons generated.")
