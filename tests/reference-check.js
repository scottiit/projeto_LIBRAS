import { loadHands } from '../js/vision.js';
import { SIGN_REFERENCES } from '../js/dataset.js';
import { SignClassifier } from '../js/classifier.js';
const button = document.getElementById('run'), status = document.getElementById('status');
button.addEventListener('click', async () => {
  button.disabled = true;
  const classifier = new SignClassifier();
  let hands;
  document.getElementById('results').replaceChildren();
  try {
    status.textContent = 'Carregando MediaPipe…';
    await loadHands();
    hands = new globalThis.Hands({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}` });
    hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: .5, minTrackingConfidence: .65 });
    await classifier.adaptFromImages(hands, (index, total) => { status.textContent = `Preparando referências como na câmera: ${index}/${total}…`; });
    let detectedHand;
    hands.onResults(results => { detectedHand = results.multiHandLandmarks?.[0]; });
    let total = 0, correct = 0, accepted = 0;
    for (const [label, path] of Object.entries(SIGN_REFERENCES)) {
      if (path.endsWith('.mp4')) continue;
      status.textContent = `Processando referência ${label}…`;
      const image = new Image(); image.src = `../${path}`;
      await image.decode(); detectedHand = null;
      hands.reset(); // Independent photos must not inherit a previous video's ROI.
      await hands.send({ image });
      const result = classifier.predict(detectedHand, 'alphabet', image.naturalWidth / image.naturalHeight);
      const matches = result.targetClass === label;
      total++; correct += matches; accepted += matches && result.confidenceProbability > .85;
      const row = document.createElement('tr');
      for (const text of [label, result.targetClass ?? 'Sem mão', `${Math.round(result.confidenceProbability * 100)}%`, matches && result.confidenceProbability > .85 ? 'Aprovável' : matches ? 'Baixa confiança' : 'Divergente']) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      document.getElementById('results').append(row);
    }
    status.textContent = `Concluído: ${correct}/${total} classes corretas; ${accepted}/${total} acima de 85%. Referências do próprio acervo, sem validação externa.`;
  } catch (error) { status.textContent = `Falha: ${error.message}`; }
  finally { if (hands) await hands.close(); button.disabled = false; }
});
