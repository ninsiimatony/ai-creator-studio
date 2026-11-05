# Makes a YouTube thumbnail: AI background + Tony's face (emotion) + big title text. 1280x720 JPEG.
# usage: python3 thumb.py <background.jpg> <face.png> <left|right face side> <text> <out.jpg>
import sys, os
from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageFilter
bg_path, face_path, side, text, out = sys.argv[1:6]
HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "fonts", "Anton.ttf")
W, H = 1280, 720
bg = Image.open(bg_path).convert("RGB")
s = max(W / bg.width, H / bg.height)
bg = bg.resize((int(bg.width * s) + 1, int(bg.height * s) + 1), Image.LANCZOS)
bg = bg.crop(((bg.width - W) // 2, (bg.height - H) // 2, (bg.width - W) // 2 + W, (bg.height - H) // 2 + H))
bg = ImageEnhance.Brightness(bg).enhance(0.62).convert("RGBA")
# dark gradient under the text side
ov = Image.new("RGBA", (W, H)); d = ImageDraw.Draw(ov)
for x in range(W):
    t = x / W if side == "left" else 1 - x / W
    d.line([(x, 0), (x, H)], fill=(0, 0, 0, int(190 * max(0, min(1, (t - 0.25) / 0.5)))))
bg = Image.alpha_composite(bg, ov)
NOFACE = face_path == "none"
face = Image.new("RGBA", (10, H), (0, 0, 0, 0)) if NOFACE else Image.open(face_path).convert("RGBA")
fh = int(H * 1.0)
if not NOFACE:
    face = face.resize((int(face.width * fh / face.height), fh), Image.LANCZOS)
# fade the inner edge so a cut-off photo edge never shows as a hard line
from PIL import ImageChops
m = Image.new("L", face.size, 255); md = ImageDraw.Draw(m)
fw = 60
for i in range(fw):
    v = int(255 * i / fw)
    xx = i if side == "right" else face.width - 1 - i
    md.line([(xx, 0), (xx, face.height)], fill=v)
face.putalpha(ImageChops.multiply(face.split()[3], m))
# soft glow behind face
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0)); gd = ImageDraw.Draw(glow)
fx = W - face.width + 30 if side == "right" else -30
gd.ellipse((fx + 40, 80, fx + face.width - 40, H + 200), fill=(255, 190, 80, 110))
if not NOFACE:
    bg = Image.alpha_composite(bg, glow.filter(ImageFilter.GaussianBlur(70)))
    bg.alpha_composite(face, (fx, H - face.height))
# text block on the other side
area_x = 40 if side == "right" else face.width - 10
area_w = (W - face.width + 10) - 60 if side == "right" else W - area_x - 40
words = text.upper().replace('"', "").split()
def layout(size):
    f = ImageFont.truetype(FONT, size); lines, cur = [], ""
    dd = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    for w in words:
        trial = (cur + " " + w).strip()
        if dd.textlength(trial, font=f) <= area_w or not cur: cur = trial
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return f, lines
size = 130
while True:
    f, lines = layout(size)
    if (len(lines) <= 3 and all(ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength(l, font=f) <= area_w for l in lines)) or size <= 60: break
    size -= 6
lines = lines[:3]
lh = int(size * 1.08)
y = (H - lh * len(lines)) // 2
d = ImageDraw.Draw(bg)
for i, l in enumerate(lines):
    col = (255, 214, 0) if i == len(lines) - 1 and len(lines) > 1 else (255, 255, 255)
    d.text((area_x, y), l, font=f, fill=col, stroke_width=6, stroke_fill=(0, 0, 0))
    y += lh
bg.convert("RGB").save(out, quality=90)
