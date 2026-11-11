"""Polish the first SVG set from the supplied 685x968 alphabet artwork.
Usage: python scripts/vectorize-references.py path/to/IMG_8265.WEBP
Requires Pillow, numpy and OpenCV-contrib (ximgproc) for regeneration only.
"""
import argparse
from pathlib import Path
from html import escape
import cv2
import numpy as np
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
args = parser.parse_args()
destination = Path(__file__).resolve().parents[1] / 'assets' / 'references'
destination.mkdir(parents=True, exist_ok=True)
source = Image.open(args.source).convert('RGB')
if source.size != (685, 968):
    raise SystemExit('Expected the supplied 685 x 968 alphabet layout.')
letters = ['ABCÇ', 'DEFG', 'HIJK', 'LMNO', 'PQRS', 'TUVW', 'XYZ']
cv2.setRNGSeed(42)

def bezier(points, closed=False):
    """Fit a smooth Catmull-Rom cubic chain, bounded to the simplified contour."""
    points = np.asarray(points, dtype=float) / 4
    if len(points) < 2:
        return ''
    def coordinates(values):
        return ' '.join(f'{number:.2f}' for number in np.ravel(values))
    result = 'M' + coordinates(points[0])
    count = len(points)
    for index in range(count if closed else count - 1):
        a = points[(index - 1) % count] if closed else points[max(0, index - 1)]
        b, c = points[index], points[(index + 1) % count]
        d = points[(index + 2) % count] if closed else points[min(count - 1, index + 2)]
        result += 'C' + coordinates([b + (c - a) / 6, c - (d - b) / 6, c])
    return result + ('Z' if closed else '')

def smooth_mask(mask, sigma=1.6):
    enlarged = cv2.resize(np.uint8(mask) * 255, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    return cv2.threshold(cv2.GaussianBlur(enlarged, (0, 0), sigma), 120, 255, cv2.THRESH_BINARY)[1]

def crease_paths(mask):
    """Convert linework to uniform, rounded center strokes instead of blobs."""
    skeleton = cv2.ximgproc.thinning(smooth_mask(mask))
    pixels = {(int(x), int(y)) for y, x in np.argwhere(skeleton > 0)}
    def neighbours(point):
        x, y = point
        result = []
        for dx, dy in [(1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)]:
            other = (x + dx, y + dy)
            if other in pixels and not (dx and dy and ((x + dx,y) in pixels or (x,y + dy) in pixels)):
                result.append(other)
        return result
    graph = {point: neighbours(point) for point in pixels}
    visited = set()
    result = []
    starts = sorted(pixels, key=lambda point: (len(graph[point]) == 2, point))
    for start in starts:
        for following in graph[start]:
            edge = tuple(sorted((start, following)))
            if edge in visited:
                continue
            path = [start, following]
            visited.add(edge)
            while len(graph[path[-1]]) == 2:
                choices = [p for p in graph[path[-1]] if tuple(sorted((path[-1], p))) not in visited]
                if not choices:
                    break
                point = choices[0]
                visited.add(tuple(sorted((path[-1], point))))
                path.append(point)
            length = sum(np.hypot(b[0]-a[0], b[1]-a[1]) for a,b in zip(path,path[1:]))
            if length < 18:
                continue
            closed = path[0] == path[-1]
            points = cv2.approxPolyDP(np.array(path, np.int32), 1.8, closed).reshape(-1,2)
            if closed and len(points)>2 and np.array_equal(points[0],points[-1]):
                points = points[:-1]
            result.append(bezier(points, closed))
    return ''.join(result)

motion_paths = {
    'H': 'M56 32 C43 18 69 11 94 15 C107 17 111 23 103 28',
    'J': 'M45 13 C36 31 25 56 28 72 C32 90 49 91 65 75',
    'K': 'M17 91 L17 33',
    'X': 'M36 96 L91 96',
    'Y': 'M23 66 C12 40 24 15 58 9',
    'Z': 'M27 15 L109 15 L27 52 L109 52',
    'Ç': 'M131 40 Q141 51 132 62',
}
for row, labels in enumerate(letters):
    for column, label in enumerate(labels):
        x, y = 29 + column * 159, 86 + row * 123
        tile = np.array(source.crop((x + 4, y + 4, x + 147, y + 108)))
        tile[66:, :30] = 255
        hsv = cv2.cvtColor(tile, cv2.COLOR_RGB2HSV)
        ink = ((hsv[:, :, 1] > 25) & (hsv[:, :, 2] < 253)).astype(np.uint8)
        count, components, stats, _ = cv2.connectedComponentsWithStats(ink)
        keep = np.zeros_like(ink)
        for component in range(1, count):
            if stats[component, cv2.CC_STAT_AREA] >= 4:
                keep[components == component] = 1
        tile[keep == 0] = 255
        hsv = cv2.cvtColor(tile, cv2.COLOR_RGB2HSV)
        red = ((hsv[:,:,0] < 10) & (hsv[:,:,1] > 100) & (hsv[:,:,2] > 120)) | ((hsv[:,:,0] > 173) & (hsv[:,:,1] > 115))
        skin = (keep > 0) & ~red
        # The old motion marks are replaced by native vector strokes. Retain
        # the hand component, not detached fragments of those raster marks.
        if label == 'Z':
            skin[:60, :] = False
            skin[:, :65] = False
        if label == 'H':
            # The source arrow is printed ON the two extended fingers. Fill
            # only its overlap with that narrow finger region, otherwise
            # removing orange would sever a finger into a detached component.
            skin[12:45, 73:104] |= red[12:45, 73:104]
            skin[:45] = cv2.morphologyEx(skin[:45].astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5,5), np.uint8))
        skin = cv2.morphologyEx(skin.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3,3), np.uint8))
        components_count, skin_components, skin_stats, _ = cv2.connectedComponentsWithStats(skin)
        if components_count > 1:
            largest = 1 + np.argmax(skin_stats[1:, cv2.CC_STAT_AREA])
            skin = np.uint8(skin_components == largest)
        line = (np.mean(tile.astype(float),axis=2) < 151) & (keep > 0) & ~red
        # Suppress the original outline in the crease layer: the smooth skin
        # silhouette supplies it once, at a consistent thickness.
        interior = cv2.distanceTransform(np.uint8(skin), cv2.DIST_L2, 5) > 1.1
        line = line & interior
        paths = []
        contours, _ = cv2.findContours(smooth_mask(skin, 3.0), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        segments = []
        for contour in contours:
            if abs(cv2.contourArea(contour)) < 40:
                continue
            points = cv2.approxPolyDP(contour, 3.5, True).reshape(-1,2)
            if len(points) >= 3:
                segments.append(bezier(points, True))
        paths.append(f'<path fill="#e2b795" stroke="#795a43" stroke-width=".7" stroke-linejoin="round" fill-rule="evenodd" d="{"".join(segments)}"/>')
        paths.append(f'<path fill="none" stroke="#795a43" stroke-width=".6" stroke-linecap="round" stroke-linejoin="round" d="{crease_paths(line)}"/>')
        if label in motion_paths:
            paths.append(f'<path fill="none" stroke="#ce6540" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 3" marker-end="url(#arrow)" d="{motion_paths[label]}"/>')
        title = f'Letra {label} em LIBRAS'
        description = ('Ilustração vetorizada da prancha fornecida pelo usuário, '
            'identificada como Toda Matéria. Marcas laranja indicam movimento '
            'na prancha original. Consulte também o vídeo e um instrutor.')
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 150" '
            f'role="img" aria-labelledby="title description">'
            f'<title id="title">{escape(title)}</title>'
            f'<desc id="description">{escape(description)}</desc>'
            '<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M2 1 L8 5 L2 9" fill="none" stroke="#ce6540" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>'
            f'<text x="12" y="26" fill="#175b4e" font-family="sans-serif" '
            f'font-size="23" font-weight="700">{label}</text>'
            '<g transform="translate(8 32) scale(1.13)">' + ''.join(paths) + '</g></svg>')
        filename = 'cedilla.svg' if label == 'Ç' else f'{label.lower()}.svg'
        (destination / filename).write_text(svg, encoding='utf-8')
print('27 SVGs generated with smooth curves and uniform strokes.')
