import { SIGN_REFERENCES } from './dataset.js';

// Presentation assets are intentionally independent of recognition prototypes.
// VisionController must keep using the original photos in SIGN_REFERENCES.
export const ALPHABET_ILLUSTRATIONS = Object.freeze(Object.fromEntries(
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZÇ'].map(label => [label,
    `assets/references/${label === 'Ç' ? 'cedilla' : label.toLowerCase()}.png`])
));

export const NUMBER_ILLUSTRATIONS = Object.freeze(Object.fromEntries(
  [...'0123456789'].map(label => [label, `assets/references/number-${label}.png`])
));

export function referenceMedia(label) {
  const illustration = ALPHABET_ILLUSTRATIONS[label] ?? NUMBER_ILLUSTRATIONS[label] ?? null;
  const source = SIGN_REFERENCES[label];
  return { illustration, video: source?.endsWith('.mp4') ? source : null };
}

export function renderReferenceMedia(container, label) {
  const document = container.ownerDocument;
  const media = referenceMedia(label);
  container.replaceChildren();
  if (media.illustration) {
    const image = document.createElement('img');
    image.src = media.illustration;
    const isNumber = /^[0-9]$/.test(String(label));
    image.alt = `Ilustração ${isNumber ? 'do número' : 'da letra'} ${label} em LIBRAS`;
    image.loading = 'lazy'; image.decoding = 'async';
    image.width = isNumber ? 492 : 390; image.height = isNumber ? 246 : 290;
    container.append(image);
  }
  if (media.video) {
    const details = document.createElement('details');
    details.className = 'reference-motion';
    const summary = document.createElement('summary');
    summary.textContent = 'Ver vídeo do movimento';
    const video = document.createElement('video');
    video.src = media.video;
    video.controls = true; video.muted = true;
    video.playsInline = true; video.preload = 'none';
    video.setAttribute('aria-label', `Vídeo de referência da letra ${label}`);
    details.append(summary, video);
    details.addEventListener('toggle', () => { if (!details.open) video.pause(); });
    container.append(details);
  }
  return media;
}
