"""Token cards drawn on the server (v2's renderer): a PNG and its metadata JSON go to IPFS, and the contract fixes the
HTTPS gateway URI — the SBT's at submission, the RWA token's at final approval.

Everything here is public and permanent, so a card names no company, representative or patent and carries no
loan terms: only the application number, IP type and the amounts the contract already records."""
import functools
import io
import json
import math
import re
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
# The SBT's rings sit near its right edge; the RWA token's continue them from beyond its left edge,
# so the two cards placed side by side (SBT, then RWA token) read as one drawing. The height follows
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


def background(plate, rwa, accent, cy):
    cx = RING_X - SIZE if rwa else RING_X
    for r in RINGS:
        plate.circle(cx, cy, r, outline=ART)
    # Dotted ring (2px dash, 6px gap), shared navy across both cards so the seam joins.
    count = int(math.tau * DASHED_RING / 8)
    for i in range(count):
        a, b = i * math.tau / count, i * math.tau / count + 2 / DASHED_RING
        plate.line([(cx + DASHED_RING * math.cos(a), cy + DASHED_RING * math.sin(a)),
                    (cx + DASHED_RING * math.cos(b), cy + DASHED_RING * math.sin(b))], NAVY)
    plate.circle(cx + (DASHED_RING if rwa else -DASHED_RING), cy, 4.5, fill=accent)


def dot_steps(plate, rwa, bottom):
    for row, count in enumerate((6, 5, 4)):
        for col in range(count):
            x = RIGHT - col * 18 if rwa else LEFT + col * 18
            plate.circle(x, bottom - (2 - row) * 18, 1.7, fill=DOTS)


def emblem(plate, top, rwa, accent):
    side = 62
    left, bottom = 600 - side / 2, top + side
    right = left + side
    corner = right if rwa else left
    plate.draw.pieslice([(corner - side) * SCALE, (bottom - side) * SCALE, (corner + side) * SCALE,
                         (bottom + side) * SCALE], 180 if rwa else 270, 270 if rwa else 360, fill=accent)
    plate.rect((left, top, right, bottom), outline=NAVY)
    mark = left + 4 if rwa else right - 13
    plate.rect((mark, top + 4, mark + 9, top + 13), fill=NAVY)


def icon(plate, x, y, rwa):
    k = 17 / 24  # 24-unit stroke icons drawn at 17px

    def p(u, v):
        return x + u * k, y + v * k
    if rwa:  # bank
        plate.line([p(3, 9), p(12, 4), p(21, 9)], NAVY, 1.4)
        for u in (5, 9.7, 14.3, 19):
            plate.line([p(u, 10), p(u, 18)], NAVY, 1.4)
        plate.line([p(3, 21), p(21, 21)], NAVY, 1.4)
    else:  # lock
        plate.line([p(4, 11), p(20, 11), p(20, 21), p(4, 21), p(4, 11)], NAVY, 1.4)
        arc = [p(12 - 4 * math.cos(t * math.pi / 12), 7 - 4 * math.sin(t * math.pi / 12)) for t in range(13)]
        plate.line([p(8, 11)] + arc + [p(16, 11)], NAVY, 1.4)


def won(amount):
    return f'{int(amount):,}원'


def card(application, rwa=False):
    """application: id, ipType, amount and appliedDate; for the RWA token also appraisedValue."""
    kind = '대출 RWA 토큰' if rwa else '평가보고서 열람 SBT'
    app_id = clean(application['id'], 80)
    ip_type = clean(application.get('ipType'), 50) or '특허권'
    amount = int(application['amount'])
    if rwa:
        value = int(application['appraisedValue'])
        ltv = amount * 1000 // value
        fields = (('01', '신청번호', 'APPLICATION', app_id), ('02', '약정 금액', 'PRINCIPAL', won(amount)),
                  ('03', '확정 평가액', 'APPRAISAL', won(value)))
    else:
        fields = (('01', '신청번호', 'APPLICATION', app_id), ('02', '신청 금액', 'AMOUNT', won(amount)),
                  ('03', '신청일', 'DATE', clean(application.get('appliedDate'), 10)))
    accent = '#9A4A12' if rwa else NAVY
    plate = Plate()

    # Measure everything that can grow first, then share the leftover height the way the
    # design's flex spacers do (1 : 1.2 : 0.6), so long text pushes space, never overlaps.
    asset_x = LEFT + 233
    asset_face, asset_size, asset_rows = fit(plate, ip_type, (42, 38, 34, 30), 'semibold', RIGHT - asset_x, 3, -0.02)
    asset_lh = asset_size * 1.3
    col_w = (RIGHT - LEFT - 70) / 3
    columns = []
    for number, label, english, text in fields:
        mono = text.isascii()
        sizes, weight, track = ((28, 24, 20), 'mono-medium', 0) if mono else ((29, 25, 22), 'semibold', -0.02)
        columns.append((number, label, english, *fit(plate, text, sizes, weight, col_w, 2, track), track))
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

    background(plate, rwa, accent, max(center_top + 40, header_bottom + DASHED_RING + 8))
    dot_steps(plate, rwa, footer_top - 32)

    plate.rect((LEFT, TOP, RIGHT, TOP + 4), fill=accent)
    face = font(22, 'bold')
    plate.text(LEFT, 123, 'IP LOAN', face, NAVY, 0.06)
    plate.text(LEFT + plate.width('IP LOAN', face, 0.06) + 20, 123, 'ASSET PLAQUE / 2026', font(12, 'mono'), MUTED, 0.12)
    pill = font(12, 'mono-medium')
    pill_w = plate.width('INSTITUTIONAL', pill, 0.16) + 30
    plate.rect((RIGHT - pill_w, 98, RIGHT, 132), fill=accent)
    plate.text(RIGHT - pill_w + 15, plate.baseline(98, pill, 34), 'INSTITUTIONAL', pill, '#FFFFFF', 0.16)

    emblem(plate, center_top, rwa, accent)
    face = font(70, 'bold')
    plate.text(600, plate.baseline(center_top + 84, face, 77), kind, face, NAVY, -0.03, 'center')
    face = font(13, 'mono')
    subtitle = 'TOKENIZED LOAN AGREEMENT' if rwa else 'NON-TRANSFERABLE VALUATION PERMIT'
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
    icon(plate, LEFT, footer_top + 22, rwa)
    face = font(17)
    footer = '은행 보유 · 시연용 대출 증서' if rwa else '담당 평가자 전용 · 양도 불가'
    plate.text(LEFT + 28, plate.baseline(footer_top + 20, face, 22), footer, face, NAVY)
    face = font(12, 'mono')
    plate.text(RIGHT, plate.baseline(footer_top + 20, face, 22), 'SMART CONTRACT CONTAINER', face, MUTED, 0.14, 'right')

    attributes = [{'trait_type': '유형', 'value': kind}, {'trait_type': '신청번호', 'value': app_id},
                  {'trait_type': 'IP 유형', 'value': ip_type}]
    if rwa:
        attributes += [{'trait_type': '약정 금액(원)', 'value': str(amount)}, {'trait_type': '확정 평가액(원)', 'value': str(value)},
                       {'trait_type': '담보인정비율', 'value': f'{ltv // 10}.{ltv % 10}%'}]
    else:
        attributes.append({'trait_type': '신청 금액(원)', 'value': str(amount)})
    metadata = {
        'name': f'{kind} · {app_id}',
        'description': f'IP 담보대출 시범 서비스의 {kind}입니다. 실제 자금 이동과 법적 효력은 없습니다.',
        'attributes': attributes,
    }
    return plate.png(), metadata


# Must equal the contract's tokenMediaGateway; the contract accepts only <gateway><CID>.
HTTPS_GATEWAY = 'https://rwa-gw.mustree.kr/ipfs/'
CID = re.compile(r'^[A-Za-z0-9]{10,128}$')


def prepare(application, upload, *, rwa=False):
    """Draws the card, uploads the PNG and then the metadata JSON, and returns their gateway URIs."""
    png, metadata = card(application, rwa)  # rendered before any upload, so a font error uploads nothing
    prefix = 'rwa' if rwa else 'sbt'
    image = upload(png, f'{application["id"]}-{prefix}.png', 'image/png')
    if not CID.fullmatch(str(image['cid'])):
        raise TokenMediaError('Invalid image CID')
    metadata['image'] = HTTPS_GATEWAY + image['cid']
    payload = json.dumps(metadata, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    document = upload(payload, f'{application["id"]}-{prefix}.json', 'application/json')
    if not CID.fullmatch(str(document['cid'])):
        raise TokenMediaError('Invalid metadata CID')
    return {'metadataUri': HTTPS_GATEWAY + document['cid'], 'imageUri': metadata['image']}
