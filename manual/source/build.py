"""Build the manual PDF: cover + body (two passes so the TOC carries real page numbers)."""
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright
from pypdf import PdfReader, PdfWriter

HERE = Path(__file__).resolve().parent
PARTS = ['part0_overview.html', 'part1_overview_ch.html', 'part2_bank.html', 'part3_evaluator.html',
         'part4_emergency.html', 'part5_appendix.html']
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / 'IP담보_자동대출_업무프로세스_매뉴얼.pdf'

HEAD = """<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>IP담보 자동대출 플랫폼 업무 프로세스 매뉴얼</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@500;600;700&display=block">
<link rel="stylesheet" href="style.css"></head><body>"""
FOOTER = ("<div style=\"width:100%;font-size:7.4pt;font-family:'Noto Sans CJK KR',sans-serif;color:#8a93a3;"
          "padding:0 17mm;display:flex;justify-content:space-between;\">"
          "<span>IP담보 자동대출 플랫폼 · 업무 프로세스 매뉴얼</span><span class=\"pageNumber\"></span></div>")


def toc_entries(html):
    entries = []
    for m in re.finditer(r'<section class="chapter" id="([^"]+)" data-toc="([^"]+)">|<h2 id="([^"]+)"><span class="no">([^<]+)</span>(.*?)</h2>', html, re.S):
        if m.group(1):
            entries.append(('l1', m.group(1), m.group(2)))
        else:
            title = re.sub(r'<[^>]+>.*?</span>', '', m.group(5)).strip()
            title = re.sub(r'<[^>]+>', '', title).strip()
            entries.append(('l2', m.group(3), f'{m.group(4)}&nbsp;&nbsp;{title}'))
    return entries


def toc_html(entries, pages):
    rows = []
    for (level, anchor, label), page in zip(entries, pages):
        rows.append(f'<a class="{level}" href="#{anchor}"><span>{label}</span><span class="fill"></span><span class="pg">{page}</span></a>')
    return '\n'.join(rows)


def render(page, html_path, pdf_path, footer=True):
    page.goto(html_path.as_uri())
    page.wait_for_load_state('networkidle')
    page.evaluate('document.fonts.ready')
    page.wait_for_timeout(300)
    page.pdf(path=str(pdf_path), prefer_css_page_size=True, print_background=True,
             display_header_footer=footer, header_template='<span></span>', footer_template=FOOTER if footer else '<span></span>')


def link_pages(pdf_path, count):
    """Destination page (1-based) of the first `count` internal links, in reading order."""
    reader = PdfReader(str(pdf_path))
    index = {p.indirect_reference.idnum: i for i, p in enumerate(reader.pages)}
    found = []
    for page in reader.pages:
        links = []
        for annot in page.get('/Annots') or []:
            a = annot.get_object()
            if a.get('/Subtype') != '/Link':
                continue
            dest = a.get('/Dest')
            if dest is None and '/A' in a:
                dest = a['/A'].get('/D')
            if isinstance(dest, str) or hasattr(dest, 'startswith'):
                dest = reader.named_destinations[str(dest)] if str(dest) in reader.named_destinations else None
                target = index.get(dest.page.idnum) if dest is not None else None
            elif dest is not None:
                target = index.get(dest[0].idnum)
            else:
                continue
            rect = [float(v) for v in a['/Rect']]
            links.append((-rect[3], rect[0], target))
        found.extend(t for _, _, t in sorted(links))
        if len(found) >= count:
            break
    return [t + 1 if t is not None else '?' for t in found[:count]]


def main():
    content = '\n'.join((HERE / p).read_text(encoding='utf-8') for p in PARTS)
    entries = toc_entries(content)
    body_path = HERE / 'body.html'
    pages = ['00'] * len(entries)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--headless=new'])
        page = browser.new_page()
        for attempt in range(3):
            body_path.write_text(HEAD + content.replace('<!--TOC-->', toc_html(entries, pages)) + '</body></html>', encoding='utf-8')
            render(page, body_path, HERE / 'body.pdf')
            found = link_pages(HERE / 'body.pdf', len(entries))
            print('pass', attempt + 1, found)
            if found == pages:
                break
            pages = found
        render(page, HERE / 'cover.html', HERE / 'cover.pdf', footer=False)
        browser.close()

    writer = PdfWriter()
    for part in ('cover.pdf', 'body.pdf'):
        for pg in PdfReader(str(HERE / part)).pages:
            writer.add_page(pg)
    writer.add_metadata({'/Title': 'IP담보 자동대출 플랫폼 업무 프로세스 매뉴얼', '/Author': '주식회사 머스트리',
                         '/Subject': '여신담당자 업무 매뉴얼 · IP 가치평가기관 협업 프로세스 · 비상시 대응 매뉴얼'})
    with open(OUT, 'wb') as fh:
        writer.write(fh)
    print('wrote', OUT, len(writer.pages), 'pages')


if __name__ == '__main__':
    main()
