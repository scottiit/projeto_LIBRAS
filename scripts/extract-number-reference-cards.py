"""Extract number cards from the user-supplied chart at original resolution."""
import argparse
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
args = parser.parse_args()
output = Path(__file__).resolve().parents[1] / 'assets' / 'references'
output.mkdir(parents=True, exist_ok=True)
with Image.open(args.source) as source:
    if source.size != (1083, 1452):
        raise ValueError('Expected the supplied 1083 x 1452 number chart.')
    for number in range(10):
        left = [43, 549][number % 2]
        top = [139, 395, 651, 907, 1162][number // 2]
        source.crop((left, top, left + 492, top + 246)).save(output / f'number-{number}.png')
print('Saved 10 number reference cards at their original resolution.')
