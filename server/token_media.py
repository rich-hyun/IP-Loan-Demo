"""Public, deterministic PNG token cards. Never include source documents or secrets."""
import functools
import io
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


class TokenMediaError(Exception):
    pass


# Bundled IBM Plex (SIL OFL 1.1, see fonts/OFL-*.txt), so every server renders identically.
FONTS = Path(__file__).with_name('fonts')
FONT_FILES = {'bold': 'IBMPlexSansKR-Bold.ttf', 'semibold': 'IBMPlexSansKR-SemiBold.ttf',
              'mono': 'IBMPlexMono-Regular.ttf', 'mono-medium': 'IBMPlexMono-Medium.ttf'}
SIZE, SCALE = 1200, 2  # Drawn at 2x and downsampled, so hairlines and text stay smooth.
LEFT, RIGHT, TOP, BOTTOM = 80, 1120, 72, 1136
NAVY, MUTED, RULE, ART, DOTS = '#0B1A33', '#5A6372', '#DCE0E6', '#E5E9EF', '#C9D0DA'
# The SBT's rings sit near its right edge; the NFT's continue them from beyond its left edge,
# so the two cards placed side by side (SBT, then NFT) read as one drawing. The height follows
# the title block (same for both cards of one application) and clears the header.
RING_X = 1110
RINGS = (44, 78, 111, 144, 178, 244, 278, 311, 344, 378, 411, 444, 478)
DASHED_RING = 211


@functools.lru_cache(maxsize=64)
def _load(path, size):
    return ImageFont.truetype(path, size)


def font(size, weight='semibold'):
    path = FONTS / FONT_FILES[weight]
    if not path.is_file():
        raise TokenMediaError(f'토큰 카드 글꼴 파일이 없습니다: {path}')
    return _load(str(path), round(size * SCALE))


def clean(value, limit):
    return ' '.join(str(value or '').split())[:limit]


class Plate:
    """Coordinates are in final 1200px units; drawing happens at SCALE."""

    def __init__(self):
        self.image = Image.new('RGB', (SIZE * SCALE, SIZE * SCALE), '#FFFFFF')
        self.draw = ImageDraw.Draw(self.image)

    def width(self, text, face, track=0):
        if not track:
            return self.draw.textlength(text, font=face) / SCALE
        chars = sum(self.draw.textlength(char, font=face) for char in text)
        return (chars + track * face.size * max(len(text) - 1, 0)) / SCALE

    def baseline(self, top, face, line_height):
        ascent, descent = face.getmetrics()
        return top + ((line_height * SCALE - ascent - descent) / 2 + ascent) / SCALE

    def text(self, x, baseline, text, face, fill, track=0, align='left'):
        if align != 'left':
            x -= self.width(text, face, track) / (2 if align == 'center' else 1)
        if not track:
            self.draw.text((x * SCALE, baseline * SCALE), text, font=face, fill=fill, anchor='ls')
            return
        x *= SCALE
        for char in text:
            self.draw.text((x, baseline * SCALE), char, font=face, fill=fill, anchor='ls')
            x += self.draw.textlength(char, font=face) + track * face.size

    def rect(self, box, fill=None, outline=None):
        self.draw.rectangle([v * SCALE for v in box], fill=fill, outline=outline, width=SCALE)

    def line(self, points, fill, width=1):
        self.draw.line([v * SCALE for point in points for v in point], fill=fill, width=round(width * SCALE))

    def circle(self, cx, cy, r, fill=None, outline=None):
        self.draw.ellipse([(cx - r) * SCALE, (cy - r) * SCALE, (cx + r) * SCALE, (cy + r) * SCALE],
                          fill=fill, outline=outline, width=SCALE)

    def png(self):
        output = io.BytesIO()
        self.image.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(output, format='PNG', optimize=True)
        return output.getvalue()


def wrap(measure, text, width):
    """Greedy wrap that breaks at spaces; a word wider than the line breaks between characters."""
    result, current = [], ''
    for word in text.split(' '):
        candidate = f'{current} {word}' if current else word
        if measure(candidate) <= width:
            current = candidate
            continue
        if current:
            result.append(current)
        while measure(word) > width:
            cut = len(word) - 1
            while cut > 1 and measure(word[:cut]) > width:
                cut -= 1
            result.append(word[:cut])
            word = word[cut:]
        current = word
    if current:
        result.append(current)
    return result


def fit(plate, text, sizes, weight, width, max_lines, track=0):
    """Largest size that fits in max_lines; at the smallest size the last line ends with an ellipsis."""
    for size in sizes:
        face = font(size, weight)
        rows = wrap(lambda t: plate.width(t, face, track), text, width)
        if len(rows) <= max_lines:
            return face, size, rows
    rows = rows[:max_lines]
    while rows[-1] and plate.width(rows[-1] + '…', face, track) > width:
        rows[-1] = rows[-1][:-1]
    rows[-1] = rows[-1].rstrip() + '…'
    return face, size, rows


def background(plate, debt, accent, cy):
    cx = RING_X - SIZE if debt else RING_X
    for r in RINGS:
        plate.circle(cx, cy, r, outline=ART)
    # Dotted ring (2px dash, 6px gap), shared navy across both cards so the seam joins.
    count = int(math.tau * DASHED_RING / 8)
    for i in range(count):
        a, b = i * math.tau / count, i * math.tau / count + 2 / DASHED_RING
        plate.line([(cx + DASHED_RING * math.cos(a), cy + DASHED_RING * math.sin(a)),
                    (cx + DASHED_RING * math.cos(b), cy + DASHED_RING * math.sin(b))], NAVY)
    plate.circle(cx + (DASHED_RING if debt else -DASHED_RING), cy, 4.5, fill=accent)


def dot_steps(plate, debt, bottom):
    for row, count in enumerate((6, 5, 4)):
        for col in range(count):
            x = RIGHT - col * 18 if debt else LEFT + col * 18
            plate.circle(x, bottom - (2 - row) * 18, 1.7, fill=DOTS)


def emblem(plate, top, debt, accent):
    side = 62
    left, bottom = 600 - side / 2, top + side
    right = left + side
    corner = right if debt else left
    plate.draw.pieslice([(corner - side) * SCALE, (bottom - side) * SCALE, (corner + side) * SCALE,
                         (bottom + side) * SCALE], 180 if debt else 270, 270 if debt else 360, fill=accent)
    plate.rect((left, top, right, bottom), outline=NAVY)
    mark = left + 4 if debt else right - 13
    plate.rect((mark, top + 4, mark + 9, top + 13), fill=NAVY)


def icon(plate, x, y, debt):
    k = 17 / 24  # 24-unit stroke icons drawn at 17px

    def p(u, v):
        return x + u * k, y + v * k
    if debt:  # bank
        plate.line([p(3, 9), p(12, 4), p(21, 9)], NAVY, 1.4)
        for u in (5, 9.7, 14.3, 19):
            plate.line([p(u, 10), p(u, 18)], NAVY, 1.4)
        plate.line([p(3, 21), p(21, 21)], NAVY, 1.4)
    else:  # lock
        plate.line([p(4, 11), p(20, 11), p(20, 21), p(4, 21), p(4, 11)], NAVY, 1.4)
        arc = [p(12 - 4 * math.cos(t * math.pi / 12), 7 - 4 * math.sin(t * math.pi / 12)) for t in range(13)]
        plate.line([p(8, 11)] + arc + [p(16, 11)], NAVY, 1.4)


def card(application, debt=False):
    """Render each application/type with accurate Korean text, without an AI API."""
    kind = '대출채권 NFT' if debt else '평가보고서 열람 SBT'
    title = clean(application.get('ipTitle'), 200) or '특허 가치평가'
    company = clean(application.get('company'), 200)
    user = clean(application.get('ceo'), 100)
    app_id = clean(application['id'], 80)
    name = f'{kind} · {company} · {title} · {app_id}'
    accent = '#9A4A12' if debt else NAVY
    plate = Plate()

    # Measure everything that can grow first, then share the leftover height the way the
    # design's flex spacers do (1 : 1.2 : 0.6), so long text pushes space, never overlaps.
    asset_x = LEFT + 233
    asset_face, asset_size, asset_rows = fit(plate, title, (42, 38, 34, 30), 'semibold', RIGHT - asset_x, 3, -0.02)
    asset_lh = asset_size * 1.3
    col_w = (RIGHT - LEFT - 70) / 3
    columns = []
    for number, label, english, value in (('01', '차주기업', 'BORROWER', company),
                                          ('02', '대표자', 'REPRESENTATIVE', user or '미등록'),
                                          ('03', '신청번호', 'APPLICATION', app_id)):
        mono = number == '03' and value.isascii()
        sizes, weight, track = ((28, 24, 20), 'mono-medium', 0) if mono else ((29, 25, 22), 'semibold', -0.02)
        columns.append((number, label, english, *fit(plate, value, sizes, weight, col_w, 2, track), track))
    values_h = max(len(rows) * size * 1.25 for *_, size, rows, _ in columns)
    header_bottom, center_h, gap = 132, 200, 53
    asset_h = 24 + len(asset_rows) * asset_lh
    cols_h = 56 + values_h
    footer_h = 42
    free = BOTTOM - header_bottom - center_h - asset_h - gap - cols_h - footer_h
    center_top = header_bottom + free / 2.8
    asset_top = center_top + center_h + free * 1.2 / 2.8
    cols_top = asset_top + asset_h + gap
    footer_top = BOTTOM - footer_h

    background(plate, debt, accent, max(center_top + 40, header_bottom + DASHED_RING + 8))
    dot_steps(plate, debt, footer_top - 32)

    plate.rect((LEFT, TOP, RIGHT, TOP + 4), fill=accent)
    face = font(22, 'bold')
    plate.text(LEFT, 123, 'IP LOAN', face, NAVY, 0.06)
    plate.text(LEFT + plate.width('IP LOAN', face, 0.06) + 20, 123, 'ASSET PLAQUE / 2026', font(12, 'mono'), MUTED, 0.12)
    pill = font(12, 'mono-medium')
    pill_w = plate.width('INSTITUTIONAL', pill, 0.16) + 30
    plate.rect((RIGHT - pill_w, 98, RIGHT, 132), fill=accent)
    plate.text(RIGHT - pill_w + 15, plate.baseline(98, pill, 34), 'INSTITUTIONAL', pill, '#FFFFFF', 0.16)

    emblem(plate, center_top, debt, accent)
    face = font(70, 'bold')
    plate.text(600, plate.baseline(center_top + 84, face, 77), kind, face, NAVY, -0.03, 'center')
    face = font(13, 'mono')
    subtitle = 'TOKENIZED CAPITAL BOND CONTRACT' if debt else 'NON-TRANSFERABLE VALUATION PERMIT'
    plate.text(600, plate.baseline(center_top + 183, face, 17), subtitle, face, MUTED, 0.24, 'center')

    plate.line([(LEFT, asset_top), (RIGHT, asset_top)], NAVY)
    face = font(14)
    plate.text(LEFT, plate.baseline(asset_top + 24, face, 20), '지식재산 자산', face, NAVY)
    face = font(11, 'mono')
    plate.text(LEFT, plate.baseline(asset_top + 50, face, 14), 'IP ASSET', face, MUTED, 0.14)
    for i, row in enumerate(asset_rows):
        plate.text(asset_x, plate.baseline(asset_top + 24 + i * asset_lh, asset_face, asset_lh), row,
                   asset_face, NAVY, -0.02)

    for i, (number, label, english, face, size, rows, track) in enumerate(columns):
        x = LEFT + i * (col_w + 35)
        plate.line([(x, cols_top), (x + col_w, cols_top)], NAVY)
        label_face, english_face = font(14), font(11, 'mono')
        plate.text(x, plate.baseline(cols_top + 20, label_face, 18), label, label_face, NAVY)
        plate.text(x + col_w, plate.baseline(cols_top + 20, label_face, 18), f'{number} {english}',
                   english_face, MUTED, 0.14, 'right')
        for j, row in enumerate(rows):
            plate.text(x, plate.baseline(cols_top + 56 + j * size * 1.25, face, size * 1.25), row, face, NAVY, track)

    plate.line([(LEFT, footer_top), (RIGHT, footer_top)], RULE)
    icon(plate, LEFT, footer_top + 22, debt)
    face = font(17)
    footer = '은행 보유 · 시연용 채권 증서' if debt else '담당 평가자 전용 · 양도 불가'
    plate.text(LEFT + 28, plate.baseline(footer_top + 20, face, 22), footer, face, NAVY)
    face = font(12, 'mono')
    plate.text(RIGHT, plate.baseline(footer_top + 20, face, 22), 'SMART CONTRACT CONTAINER', face, MUTED, 0.14, 'right')

    metadata = {
        'name': name,
        'description': f'{title} 평가보고서와 연결된 {kind}. 신청번호 {app_id}. 시연용 증서입니다.',
        'attributes': [
            {'trait_type': '유형', 'value': kind},
            {'trait_type': '신청번호', 'value': app_id},
            {'trait_type': '차주기업', 'value': company},
            {'trait_type': '대표자', 'value': user},
            {'trait_type': '평가보고서', 'value': title + ' 평가보고서'},
        ],
    }
    return plate.png(), metadata


HTTPS_GATEWAY = 'https://rwa-gw.mustree.kr/ipfs/'


def media_cid(uri):
    """Accept only canonical IPFS or our immutable CID gateway paths."""
    import re
    if not isinstance(uri, str):
        return None
    for prefix in ('ipfs://', HTTPS_GATEWAY):
        if uri.startswith(prefix):
            cid = uri[len(prefix):]
            return cid if re.fullmatch(r'[A-Za-z0-9]{10,128}', cid) else None
    return None


def prepare(application, upload, *, https=False):
    # Render both before uploading, so font errors never cause partial uploads.
    cards = [(prefix, *card(application, debt)) for prefix, debt in [('sbt', False), ('debt', True)]]
    result = {}
    for prefix, png, metadata in cards:
        image = upload(png, f'{application["id"]}-{prefix}.png', 'image/png')
        if not media_cid('ipfs://' + str(image['cid'])):
            raise TokenMediaError('Invalid image CID')
        uri_prefix = HTTPS_GATEWAY if https else 'ipfs://'
        metadata['image'] = uri_prefix + image['cid']
        payload = json.dumps(metadata, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        document = upload(payload, f'{application["id"]}-{prefix}.json', 'application/json')
        if not media_cid('ipfs://' + str(document['cid'])):
            raise TokenMediaError('Invalid metadata CID')
        result.update({prefix + 'MetadataUri': uri_prefix + document['cid'],
                       prefix + 'ImageUri': metadata['image'], prefix + 'Name': metadata['name']})
    return result
