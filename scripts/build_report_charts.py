"""Render measured public-data results, not estimated user error rates."""
from pathlib import Path
import hashlib
import json
from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/submission/2026-10-18-analysis'


def chart_values(data):
    names = data['names']
    counts = [names[k] for k in ['explicit', 'abbreviation_review', 'not_explicit']]
    if any(not isinstance(n, int) or n < 0 for n in counts) or sum(counts) != names['total']:
        raise ValueError('Name categories do not reconcile with the population')
    directions = [(r['mobileNo'], r['currentAlternativeDespiteNearestOutside'], r['total']) for r in data['totals']]
    if any(not 0 <= cases <= total or total <= 0 for _, cases, total in directions):
        raise ValueError('Direction cases exceed their comparison population')
    return {'names': counts, 'namesTotal': names['total'], 'directions': directions}


def run():
    source = ROOT / 'data/processed/imae-kiosk/report-2026-10-18/analysis.json'
    values = chart_values(json.loads(source.read_text(encoding='utf-8')))
    image = Image.new('RGB', (2400, 1760), 'white')
    draw = ImageDraw.Draw(image)
    regular = 'C:/Windows/Fonts/malgun.ttf'
    bold = 'C:/Windows/Fonts/malgunbd.ttf'
    font = lambda size, heavy=False: ImageFont.truetype(bold if heavy else regular, size)
    ink, muted, grid = '#193B37', '#4B5C59', '#DDE5E3'

    def text(x, y, content, size=58, color=ink, heavy=False, anchor='la'):
        draw.text((x, y), content, font=font(size, heavy), fill=color, anchor=anchor)

    def axis(y, maximum, ticks):
        draw.line((850, y, 2190, y), fill='#7B8A86', width=3)
        for tick in ticks:
            x = 850 + 1340 * tick / maximum
            draw.line((x, y, x, y + 13), fill='#7B8A86', width=3)
            text(x, y + 23, str(tick), 48, muted, anchor='ma')

    def bar(y, label, count, maximum, color, unit):
        text(70, y, label, 60, anchor='lm')
        end = 850 + 1340 * count / maximum
        draw.rectangle((850, y - 36, end, y + 36), fill=color)
        text(end + 22, y, f'{count}{unit}', 60, heavy=True, anchor='lm')

    text(70, 55, '시설명과 정류장명의 문자상 대응', 72, heavy=True)
    text(70, 165, f"표시 대상 고유 시설 {values['namesTotal']}곳 · 연결 정류장명과 비교", 51, muted)
    for y, label, count, color in zip([340, 475, 610],
            ['전체 이름 명시', '약칭·생략 검토', '규칙상 대응 미확인'], values['names'],
            ['#277F69', '#B48328', '#80918D']):
        bar(y, label, count, 300, color, '곳')
    axis(715, 300, [0, 100, 200, 300])
    text(70, 815, '※ 문자상 대응이며, 이용자의 인지·길 찾기 실패율이 아님.', 48, muted)
    draw.line((70, 915, 2320, 915), fill=grid, width=3)

    text(70, 965, '최단거리 선택의 구간 불일치 사례', 72, heavy=True)
    text(70, 1075, '각 방향 노선×시설 498조합 · 현재 구간에도 대안이 있는 경우', 49, muted)
    for y, (mobile, count, total), color in zip([1250, 1400], values['directions'], ['#277F69', '#426F9C']):
        if total != 498:
            raise ValueError('Update the displayed direction population before rendering')
        bar(y, f'{mobile} 탑승', count, 150, color, '건')
    axis(1500, 150, [0, 50, 100, 150])
    text(70, 1635, '※ 가상 선택 규칙의 분석 결과이며, 실제 이용자 오류율이 아님.', 48, muted)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text('Description', json.dumps({'values': values, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest()}, ensure_ascii=False))
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / 'analysis-charts.png'
    image.save(target, pnginfo=metadata, dpi=(508, 508))
    with Image.open(target) as check:
        check.verify()
    print(json.dumps(values, ensure_ascii=False))


if __name__ == '__main__':
    run()
