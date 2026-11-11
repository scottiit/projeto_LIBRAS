"""Extract the supplied alphabet cards without rescaling or redrawing them."""
import argparse
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
args = parser.parse_args()
output = Path(__file__).resolve().parents[1] / 'assets' / 'references'
output.mkdir(parents=True, exist_ok=True)
with Image.open(args.source) as source:
    if source.size != (1728, 2442):
        raise ValueError('Expected the supplied 1728 x 2442 alphabet chart.')
    for row, letters in enumerate(['ABCÇ', 'DEFG', 'HIJK', 'LMNO', 'PQRS', 'TUVW', 'XYZ']):
        top = [212, 523, 834, 1144, 1455, 1765, 2076][row]
        for column, letter in enumerate(letters):
            left = [68, 470, 871, 1272][column]
            name = 'cedilla' if letter == 'Ç' else letter.lower()
            source.crop((left, top, left + 390, top + 290)).save(output / f'{name}.png')
print('Saved 27 reference cards at their original resolution.')
