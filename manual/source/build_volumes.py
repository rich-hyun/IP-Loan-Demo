"""Build the three separate volumes from the same chapter sources used by build.py (통합본)."""
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright
from pypdf import PdfReader, PdfWriter

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build  # noqa: E402
OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / 'volumes'
OUT_DIR.mkdir(parents=True, exist_ok=True)
read = lambda name: (HERE / name).read_text(encoding='utf-8')

VOLUMES = [
    {'no': 1, 'short': '여신담당자 업무 매뉴얼', 'name': 'NH농협은행 여신담당자 업무 매뉴얼',
     'title_lines': ['NH농협은행', '여신담당자 업무 매뉴얼'],
     'file': 'IP담보대출_매뉴얼_제1권_여신담당자_업무매뉴얼.pdf',
     'audience': 'NH농협은행 여신담당자(여신심사역), 여신 업무 책임자',
     'purpose': '자동심사를 통과한 IP담보 대출 신청을 NH농협은행 여신담당자가 검토해 최종 승인 또는 거절을 결정하고, 승인 건의 상환 내역을 기록하는 절차와 기준을 정한다.',
     'chapters': [('제1장', '시스템 및 업무 개요', '참여 주체, 전체 업무 흐름, 신청 상태 체계, 지갑·네트워크 준비, 공통 보안 수칙'),
                  ('제2장', 'NH농협은행 여신담당자 업무 매뉴얼', '심사 대기 확인, 자동심사 결과·평가보고서·재무 검토, 여신 검토 체크리스트, 최종 승인·거절, 채권 NFT, 상환 기록'),
                  ('부록', '', '화면 메시지별 조치, 상태 코드 대조표, 용어 설명, 시스템 접속 정보')],
     'parts': ['part1_overview_ch.html', 'part2_bank.html'],
     'renumber': None,
     'refs': [('(3.7절)', '(제2권 2.7절)'), ('(4.4절 D3)', '(제3권 D3)'), ('(4.4절 A2·A6)', '(제3권 A2·A6)'),
              ('4.4절 E3', '제3권 E3'), ('(4.4절 E4)', '(제3권 E4)'), ('3.7절 이견 조정 절차', '제2권 2.7절 이견 조정 절차')]},
    {'no': 2, 'short': '평가기관 협업 프로세스', 'name': 'IP 가치평가기관 협업 프로세스',
     'title_lines': ['IP 가치평가기관', '협업 프로세스'],
     'file': 'IP담보대출_매뉴얼_제2권_평가기관_협업프로세스.pdf',
     'audience': 'IP 가치평가기관 평가사·평가 업무 책임자, 플랫폼 운영사, NH농협은행 여신담당자',
     'purpose': 'LLM 평가 엔진, 지정 IP 가치평가기관, 플랫폼 운영사, NH농협은행이 특허 가치평가 단계에서 주고받는 업무의 순서와 책임, 평가사의 화면 업무 절차, 기관 간 소통·이견 조정 체계를 정한다.',
     'chapters': [('제1장', '시스템 및 업무 개요', '참여 주체, 전체 업무 흐름, 신청 상태 체계, 지갑·네트워크 준비, 공통 보안 수칙'),
                  ('제2장', 'IP 가치평가기관 협업 프로세스', '협업 원칙, 기관별 역할과 책임(RACI), 평가 상태별 조치, 평가사 업무 절차, 검토 사유 작성 기준, 소통·이견 조정 체계, 품질 관리'),
                  ('부록', '', '화면 메시지별 조치, 상태 코드 대조표, 용어 설명, 시스템 접속 정보')],
     'parts': ['part1_overview_ch.html', 'part3_evaluator.html'],
     'renumber': '3',
     'refs': [('4.4절 B5', '제3권 B5'), ('(4.4절 B4)', '(제3권 B4)'), ('(4.4절 B1)', '(제3권 B1)'), ('(4.4절 B2)', '(제3권 B2)'),
              ('(4.4절 B3)', '(제3권 B3)'), ('4.3절 비상 연락망', '제3권 2.3절 비상 연락망'), ('4.4절 D1', '제3권 D1'),
              ('(3.5절)', '(2.5절)'), ('(3.6절 기준)', '(2.6절 기준)'), ('3.1절 독립성', '2.1절 독립성')]},
    {'no': 3, 'short': '비상시 대응 매뉴얼', 'name': '비상시 대응 매뉴얼',
     'title_lines': ['비상시', '대응 매뉴얼'],
     'file': 'IP담보대출_매뉴얼_제3권_비상시_대응매뉴얼.pdf',
     'audience': 'NH농협은행 여신담당자, IP 가치평가기관 평가사, 플랫폼 운영자·관리자, 각 기관 정보보호 책임자',
     'purpose': '시범운영 중 생길 수 있는 지갑·거래 오류, 보고서 생성 장애, 시스템·인프라 장애, 보안사고, 업무 오처리에 대해 참여기관이 같은 절차로 대응해 업무 중단과 피해를 줄이도록 한다.',
     'chapters': [('제1장', '시스템 및 업무 개요', '참여 주체, 전체 업무 흐름, 신청 상태 체계, 지갑·네트워크 준비, 공통 보안 수칙'),
                  ('제2장', '비상시 대응 매뉴얼', '대응 원칙, 비상 등급, 연락·보고 체계, 상황별 대응 절차(A1~E4), 복구 후 점검, 예방 점검, 장애 기록 양식'),
                  ('부록', '', '화면 메시지별 조치, 상태 코드 대조표, 용어 설명, 시스템 접속 정보')],
     'parts': ['part1_overview_ch.html', 'part4_emergency.html'],
     'renumber': '4',
     'refs': [('4.7절 양식', '2.7절 양식')]},
]


def replace_all(text, pairs, where):
    for old, new in pairs:
        if old not in text:
            raise SystemExit(f'[{where}] pattern not found: {old}')
        text = text.replace(old, new)
    return text


def renumber(text, old):
    text = text.replace(f'<span class="no">{old}.', '<span class="no">2.')
    text = text.replace(f'그림 {old}-', '그림 2-')
    text = re.sub(rf'data-toc="제{old}장 ', 'data-toc="제2장 ', text)
    text = text.replace(f'CHAPTER {old} ·', 'CHAPTER 2 ·')
    return text


def appendix(vol):
    html = read('part5_appendix.html')
    start = html.index('<tbody>', html.index('id="a-1"'))
    end = html.index('</tbody>', start)
    rows, group = [], None
    for m in re.finditer(r'<tr><th colspan="3">([^<]+)</th></tr>|<tr><td>(.*?)</td><td>(.*?)</td><td class="c">(.*?)</td></tr>', html[start:end]):
        if m.group(1):
            group = m.group(1)
        else:
            rows.append((group, m.group(2), m.group(3), m.group(4)))
    keep = []
    for group, msg, action, ref in rows:
        if vol['no'] == 1 and group == '평가':
            continue
        if vol['no'] == 2 and ref == '2.10':
            continue
        ref = {1: {}, 2: {'3.5': '2.5'}, 3: {'2.10': '제1권 2.10', '3.5': '제2권 2.5'}}[vol['no']].get(ref, ref)
        keep.append((group, msg, action, ref))
    body, last = ['<tbody>'], None
    for group, msg, action, ref in keep:
        if group != last:
            body.append(f'      <tr><th colspan="3">{group}</th></tr>')
            last = group
        body.append(f'      <tr><td>{msg}</td><td>{action}</td><td class="c">{ref}</td></tr>')
    html = html[:start] + '\n'.join(body) + '\n    ' + html[end:]
    note = ('참조 열의 A1~E4는 2.4절의 상황 번호다.' if vol['no'] == 3 else
            '참조 열의 A1~E4는 제3권 「비상시 대응 매뉴얼」 2.4절의 상황 번호다.')
    html = html.replace('<th style="width:8%" class="c">참조</th>', '<th style="width:12%" class="c">참조</th>')
    html = html.replace('<h2 id="a-1"><span class="no">부록 1</span>화면 메시지별 조치 요약</h2>',
                        f'<h2 id="a-1"><span class="no">부록 1</span>화면 메시지별 조치 요약</h2>\n  <p class="small">{note}</p>')
    return html


def overview(vol):
    volumes = ''.join(
        f'<tr{" style=\"background:#e3f1ee\"" if v["no"] == vol["no"] else ""}><td><b>제{v["no"]}권</b></td><td>{v["name"]}'
        f'{" <b style=\"color:#0e7a6e\">(이 권)</b>" if v["no"] == vol["no"] else ""}</td><td>{v["audience"]}</td></tr>'
        for v in VOLUMES)
    chapters = ''.join(f'<tr><td><b>{c}</b> {t}</td><td>{d}</td></tr>' for c, t, d in vol['chapters'])
    premise = re.search(r'<h3>시범운영 전제</h3>\s*<div class="callout plain">.*?</div>', read('part0_overview.html'), re.S).group(0)
    return f"""<section class="overview">
  <div class="overview-head"><div class="kicker">DOCUMENT OVERVIEW · VOLUME {vol['no']}</div><h1>문서 개요</h1></div>
  <table class="t kv compact"><tbody>
    <tr><th>문서명</th><td>IP담보 자동대출 플랫폼 업무 프로세스 매뉴얼 <b>제{vol['no']}권 · {vol['name']}</b></td></tr>
    <tr><th>버전·작성</th><td>1.0 · 2026. 10. 22. 최초 작성 · 주식회사 머스트리</td></tr>
    <tr><th>적용 시스템</th><td>IP담보 자동대출 플랫폼 웹 서비스(<b>https://iploan.mustree.kr</b>)와 Mustsem 블록체인(Chain ID 7601)에 배포된 대출 관리 계약. 2026년 10월 22일 배포 버전 기준</td></tr>
    <tr><th>적용 대상</th><td>{vol['audience']}</td></tr>
  </tbody></table>
  <h3>목적</h3>
  <p>{vol['purpose']}</p>
  <h3>매뉴얼 구성</h3>
  <p>업무 프로세스 매뉴얼은 세 권으로 구성된다. 각 권에는 공통 내용(제1장 시스템 및 업무 개요, 부록)이 함께 들어 있다. 본문의 '제2권 2.7절', '제3권 A2' 같은 표기는 다른 권의 절 또는 비상 상황 번호를 가리킨다.</p>
  <table class="t compact"><thead><tr><th style="width:12%">권</th><th style="width:40%">이름</th><th>주 독자</th></tr></thead><tbody>{volumes}</tbody></table>
  <h3>이 권의 구성</h3>
  <table class="t compact"><thead><tr><th style="width:40%">구분</th><th>주요 내용</th></tr></thead><tbody>{chapters}</tbody></table>
  {premise}
</section>
<section class="toc-page"><div class="toc"><h1>목 차</h1><!--TOC--></div></section>
"""


def cover(vol):
    html = read('cover.html')
    title = '<br>'.join(vol['title_lines'])
    html = html.replace('<h1>업무 프로세스<br>매뉴얼</h1>', f'<div class="vol">업무 프로세스 매뉴얼 · 제{vol["no"]}권</div><h1>{title}</h1>')
    html = html.replace('h1 { font-family', '.vol { margin-top: 7mm; font-size: 12pt; color: #c9d2e3; font-weight: 700; letter-spacing: 0.04em; }\nh1 { font-size: 34pt !important; font-family')
    html = html.replace('margin: 7mm 0 0; font-weight: 700', 'margin: 4mm 0 0; font-weight: 700')
    descs = {1: '심사 대기 확인부터 자동심사 결과·보고서·재무 검토, 최종 승인·거절, 상환 기록까지',
             2: '기관별 역할과 책임, 평가 상태별 조치, 평가사 업무 절차, 소통·이견 조정 체계',
             3: '비상 등급과 보고 체계, 상황별 대응 절차, 복구 후 점검과 예방 활동'}
    parts = ''.join(
        f'<div class="part{" cur" if v["no"] == vol["no"] else ""}"><div class="num">0{v["no"]}</div><div><div class="pt">제{v["no"]}권 · {v["name"]}</div><div class="pd">{descs[v["no"]]}</div></div></div>'
        for v in VOLUMES)
    html = re.sub(r'<div class="parts">.*?</div>\n  <div class="meta">', f'<div class="parts">{parts}</div>\n  <div class="meta">', html, flags=re.S)
    html = html.replace('</style>', '.part:not(.cur) { opacity: 0.45; }\n.part.cur .pt { color: #0e7a6e; }\n</style>')
    return html


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--headless=new'])
        page = browser.new_page()
        for vol in VOLUMES:
            chapter = read(vol['parts'][1])
            if vol['renumber']:
                chapter = renumber(chapter, vol['renumber'])
            chapter = replace_all(chapter, vol['refs'], vol['file'])
            leftover = re.findall(r'[34]\.\d+절', chapter)
            if leftover:
                raise SystemExit(f'[{vol["file"]}] unresolved references: {leftover}')
            content = overview(vol) + read(vol['parts'][0]) + chapter + appendix(vol)
            entries = build.toc_entries(content)
            build.FOOTER = build.FOOTER.replace(build.FOOTER.split('<span>')[1].split('</span>')[0],
                                                f'IP담보 자동대출 플랫폼 · 업무 프로세스 매뉴얼 제{vol["no"]}권 · {vol["short"]}')
            body_path, body_pdf = HERE / f'vol{vol["no"]}.html', HERE / f'vol{vol["no"]}.pdf'
            pages = ['00'] * len(entries)
            for _ in range(3):
                body_path.write_text(build.HEAD + content.replace('<!--TOC-->', build.toc_html(entries, pages)) + '</body></html>', encoding='utf-8')
                build.render(page, body_path, body_pdf)
                found = build.link_pages(body_pdf, len(entries))
                if found == pages:
                    break
                pages = found
            cover_path, cover_pdf = HERE / f'cover_vol{vol["no"]}.html', HERE / f'cover_vol{vol["no"]}.pdf'
            cover_path.write_text(cover(vol), encoding='utf-8')
            build.render(page, cover_path, cover_pdf, footer=False)
            writer = PdfWriter()
            for part in (cover_pdf, body_pdf):
                for pg in PdfReader(str(part)).pages:
                    writer.add_page(pg)
            writer.add_metadata({'/Title': f'IP담보 자동대출 플랫폼 업무 프로세스 매뉴얼 제{vol["no"]}권 · {vol["name"]}',
                                 '/Author': '주식회사 머스트리'})
            out = OUT_DIR / vol['file']
            with open(out, 'wb') as fh:
                writer.write(fh)
            print(out.name, len(writer.pages), 'pages', pages)
        browser.close()


if __name__ == '__main__':
    main()
