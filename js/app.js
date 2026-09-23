import { MODES, createSequence, formatTime } from './games.js';
import { ProfileStore } from './storage.js';
import { GameEngine } from './engine.js';
import { VisionController, StaticClassifierMock } from './vision.js';
import { SIGN_REFERENCES } from './dataset.js';
import { MOTION_VERSION } from './dynamic.js';
import { DYNAMIC_CLASSES } from './trajectory.js';

const $ = id => document.getElementById(id);
const wideLayout = window.matchMedia('(min-width: 900px)');
$('calibration-panel').open = wideLayout.matches;
wideLayout.addEventListener('change', event => { $('calibration-panel').open = event.matches; });
function setText(id, value) {
  const element = $(id);
  if (element.textContent !== value) element.textContent = value;
}
let store, profile, selectedMode, sequence, simulated = false, holding = false, screen = 'profile';
let debugPending = false, dropUntil = 0, session = 0, lastMockAt = 0;
let lastMotionAlternatives = null;
let countdownEndsAt = null;
let pendingTrainingLabel = null;
function report(error) { $('error').textContent = error.message || String(error); $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
function showScreen(name, focus) {
  if (screen === 'training' && name !== 'training') $('reference-media').querySelector('video')?.pause();
  screen = name;
  document.body.dataset.screen = name;
  document.body.dataset.playing = String(name === 'game' && engine.state === 'running');
  for (const value of ['profile', 'dashboard', 'training', 'game', 'result']) $(`${value}-screen`).hidden = value !== name;
  $('switch-profile').hidden = name === 'profile';
  $('app-navigation').hidden = name !== 'dashboard' && name !== 'training';
  for (const [id, active] of [['nav-games', name !== 'training'], ['open-training', name === 'training']]) {
    if (active) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  $(focus)?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
const vision = new VisionController($('camera'), $('overlay'), (prediction, capturedAt, tracked) => {
  // In debug mode the camera remains authoritative until the developer holds
  // the manual injector. During that hold, ignore camera frames so they cannot
  // break the synthetic one-second confirmation being tested.
  if (simulated && holding) return;
  if (screen === 'game' && countdownEndsAt !== null) return;
  const approved = engine.state === 'running' && engine.observe(prediction, capturedAt);
  if (approved) return;
  if (prediction?.source === 'dtw') showMotionState(prediction);
  else if (!tracked && DYNAMIC_CLASSES.has(vision.target)) showMotionState({ state: 'tracking-lost' });
  const label = prediction?.targetClass;
  const expected = engine.state === 'running' ? engine.current?.target : vision.target;
  const probability = prediction?.confidenceProbability ?? 0;
  const score = (probability * 100).toFixed(1);
  $('detected-sign').textContent = !tracked ? 'Nenhuma mão detectada' : label ? `Detectado: ${label}` : 'Nenhum sinal identificado';
  $('detected-sign').dataset.match = label === expected && probability > .85 ? 'true' : 'false';
  $('confidence').textContent = !tracked ? 'Mão não detectada · confirmação reiniciada' : prediction?.source === 'dtw' ? motionMessage(prediction) : `Semelhança com os exemplos: ${score}%`;
  if (screen === 'training' && prediction?.alternatives && prediction.source === 'dtw') renderMotionDiagnostics(prediction);
  if (prediction?.source === 'dtw') $('recognition-hint').textContent = label ? `Movimento identificado: ${label}. Mantenha a pose final por 1 segundo.${label !== expected ? ` O alvo é ${expected}.` : ''}` : motionMessage(prediction);
  else if (label && label !== expected) $('recognition-hint').textContent = `A mão se parece mais com ${label}. O alvo continua sendo ${expected}.`;
  else if (label && probability <= .85) $('recognition-hint').textContent = 'Ainda incerto. Ajuste a posição e a orientação dos dedos. Para gravar exemplos pessoais, volte aos Desafios e abra o Treinamento.';
  else $('recognition-hint').textContent = screen === 'training' ? 'Repita o sinal selecionado para testar os exemplos gravados.' : engine.state === 'running' ? 'Mantenha a pose por um segundo para confirmar.' : 'O reconhecimento já está ativo. Clique em Iniciar partida quando estiver pronto.';
}, message => {
  setText('camera-status', message);
  $('camera-placeholder').hidden = Boolean(vision.stream);
  $('enable-camera').textContent = vision.stream ? 'Desligar câmera' : 'Ativar câmera';
  $('save-example').disabled = !vision.ready || Boolean(vision.calibration);
  if (!vision.stream && screen === 'training' && !$('cancel-calibration').hidden) {
    finishCalibration(); $('calibration-status').textContent = 'Captura interrompida. Ative a câmera novamente.';
  }
}, status => {
  // Captures belong exclusively to Training. A late frame after navigation
  // must never write examples or update capture controls from a minigame.
  if (screen !== 'training' || !profile) { vision.cancelCalibration(); return; }
  showMotionState(status);
  if (status.state === 'complete') {
    try {
      if (status.dynamic) {
        // Diagnose against PREVIOUS examples; matching a sample against itself is not a test.
        renderMotionDiagnostics(vision.dynamic.classifier.predict(status.clip));
        profile = store.saveMotion(profile.name, status.label, status.clip);
        vision.setMotionExamples(profile.motionExamples);
        $('calibration-status').textContent = `Movimento de ${status.label === 'UNKNOWN' ? 'rejeição' : status.label} salvo (${(status.clip.durationMs / 1000).toFixed(1)} s). Repita para testar; grave de 3 a 5 execuções variadas.`;
      } else {
        profile = store.saveExamples(profile.name, status.label, status.samples);
        vision.setPersonalExamples(profile.signExamples);
        $('calibration-status').textContent = `Cinco exemplos de ${status.label} salvos neste perfil. Faça o sinal novamente para testar.`;
      }
    } catch (error) { report(new Error(`Os exemplos não foram salvos: ${error.message}`)); }
    finishCalibration();
  } else if (status.state === 'timeout') {
    $('calibration-status').textContent = 'Captura encerrada. Tente novamente com a mão inteira no enquadramento, pausando antes e depois do movimento.';
    finishCalibration();
  } else $('calibration-status').textContent = status.state === 'warmup' ? `Prepare o sinal. A captura começa em ${status.remaining}…` : status.dynamic ? motionMessage(status) : status.state === 'tracking-lost' ? 'Mão não detectada. A captura recomeçará ao enquadrá-la.' : `Mantenha a pose estável… ${Math.round(status.progress * 100)}%`;
  if (status.dynamic) $('confidence').textContent = status.state === 'complete' ? 'Captura concluída. Consulte o resultado no Treinamento.' : $('calibration-status').textContent;
});
function motionMessage(status) {
  if (status.state === 'confirming') return `Movimento: ${status.targetClass} · semelhança ${(status.confidenceProbability * 100).toFixed(1)}% · mantenha a pose final`;
  const messages = {
    arming: 'Pare brevemente na posição inicial.', ready: 'Pronto: execute o movimento completo.',
    recording: 'Lendo movimento… Pare na posição final para concluir.',
    'tracking-lost': 'Rastreamento interrompido. Recomece pela posição inicial.',
    'too-long': 'Movimento longo demais. Recomece e conclua em até 4,5 segundos.',
    'too-short': 'Movimento curto demais. Recomece com a trajetória completa.',
    restart: 'Prepare a posição inicial e repita o movimento.',
    rejected: status.reason === 'no-examples' ? 'Grave movimentos de H, J, K, X e Z no Treinamento.' : status.reason === 'negative' ? 'Movimento semelhante a um exemplo de rejeição. Tente novamente.' : 'Movimento incerto. Confira a referência e repita a trajetória completa.',
  };
  return messages[status.state] ?? 'Aguardando movimento.';
}
function showMotionState(status) {
  const state = vision.stream ? status.state ?? 'arming' : 'camera-off';
  const capturing = screen === 'training' && Boolean(vision.calibration);
  document.body.dataset.capturing = String(capturing);
  const labels = { 'camera-off': 'CÂMERA DESLIGADA', warmup: `PREPARE-SE · ${status.remaining ?? 2}`, collecting: 'CAPTURANDO POSE', arming: 'POSIÇÃO INICIAL', ready: 'PRONTO · MOVA', recording: capturing ? 'GRAVANDO EXEMPLO' : 'LENDO MOVIMENTO', confirming: 'RECONHECIDO', rejected: 'NÃO RECONHECIDO', complete: 'CAPTURA CONCLUÍDA', 'tracking-lost': 'MÃO NÃO VISÍVEL', 'too-short': 'MOVIMENTO CURTO', 'too-long': 'MOVIMENTO LONGO', restart: 'RECOMECE' };
  const active = screen === 'training' || (screen === 'game' && DYNAMIC_CLASSES.has(vision.target));
  $('motion-indicator').hidden = !active;
  $('motion-cue').hidden = !active || state === 'camera-off';
  if (!active) return;
  $('camera-stage').dataset.motionState = state;
  setText('motion-indicator', labels[state] ?? 'AGUARDANDO');
  setText('motion-cue', state === 'camera-off' ? 'Ative a câmera para começar.' : state === 'warmup' ? `Prepare-se. A captura começa em ${status.remaining ?? 2}…` : state === 'collecting' ? `Mantenha a pose estável… ${Math.round((status.progress ?? 0) * 100)}%` : state === 'complete' ? 'Captura concluída. Faça o sinal novamente para testar.' : state === 'recording' ? (capturing ? 'Gravando seu exemplo. Termine a trajetória e pare a mão.' : 'Lendo a trajetória. Termine o movimento e pare a mão.') : state === 'ready' ? 'Pronto para começar: faça o movimento agora.' : motionMessage(status));
}
function cancelCountdown() {
  countdownEndsAt = null;
  $('countdown-overlay').hidden = true;
  $('start-game').disabled = false;
  $('enable-camera').disabled = false;
}
function attachCamera(screenName) {
  $(`${screenName}-camera-slot`).prepend($('camera-column'));
  $(`${screenName}-readout-slot`).append($('recognition-panel'));
  $('start-game').hidden = screenName !== 'game' || engine.state === 'running';
  $('game-feedback').hidden = screenName !== 'game';
  if (vision.stream && $('camera').paused) $('camera').play().catch(() => {});
}
function renderMotionDiagnostics(prediction) {
  if (prediction.alternatives === lastMotionAlternatives) return;
  lastMotionAlternatives = prediction.alternatives;
  $('motion-distances').replaceChildren();
  for (const item of prediction.alternatives ?? []) {
    const row = document.createElement('tr');
    for (const text of [item.label === 'UNKNOWN' ? 'Rejeição' : item.label, item.distance.toFixed(3)]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    $('motion-distances').append(row);
  }
  $('motion-diagnostic-status').textContent = prediction.reason === 'no-examples' ? 'Ainda não há exemplos para comparação.' : `Última sequência: ${prediction.targetClass ?? 'não reconhecida'} · escore ${((prediction.similarityScore ?? 0) * 100).toFixed(1)}%. Menor distância indica maior semelhança. Capturas são comparadas antes de serem adicionadas à base.`;
}
const mock = new StaticClassifierMock();
const engine = new GameEngine({
  onAdvance() {
    vision.setTarget(engine.current.target);
    renderTarget();
    if (DYNAMIC_CLASSES.has(engine.current.target)) showMotionState({ state: 'arming' });
    $('game-feedback').textContent = 'Sinal confirmado! Continue para o próximo.';
    $('target-area').classList.remove('success-flash');
    void $('target-area').offsetWidth;
    $('target-area').classList.add('success-flash');
  },
  onFinish(elapsed) {
    cancelCountdown();
    releaseHold();
    session++;
    vision.stop();
    $('final-time').textContent = formatTime(elapsed);
    $('result-mode').textContent = selectedMode.title;
    $('result-note').textContent = simulated ? 'Partida em modo debug. A câmera continuou ativa e a injeção manual ficou disponível. Este tempo fica separado dos recordes normais.' : 'Reconhecimento por exemplos e trajetórias. Este resultado não certifica fluência.';
    $('record-flag').textContent = '';
    $('best-time').textContent = '';
    try {
      const result = store.saveScore(profile.name, selectedMode.id, elapsed, simulated);
      profile = result.profile;
      $('record-flag').textContent = result.improved ? 'Novo Recorde!' : 'Você completou mais uma prática.';
      $('best-time').textContent = `${simulated ? 'Melhor tempo de demonstração' : 'Melhor tempo'}: ${formatTime(result.best)}`;
    } catch (error) { report(new Error(`Partida concluída, mas o recorde não foi salvo: ${error.message}`)); }
    showScreen('result', 'result-title');
  },
});
function listProfiles() {
  const names = store.list();
  $('profile-list').replaceChildren();
  $('existing-profiles').hidden = !names.length;
  names.forEach(name => {
    const button = document.createElement('button');
    button.textContent = name;
    button.addEventListener('click', () => login(name));
    $('profile-list').append(button);
  });
}
function login(name) {
  clearError();
  try { profile = store.login(name); vision.setPersonalExamples(profile.signExamples); vision.setMotionExamples(profile.motionExamples); dashboard(); } catch (error) { report(error); }
}
function dashboard() {
  session++; cancelCountdown();
  engine.cancel();
  releaseHold();
  finishCalibration();
  vision.stop();
  pendingTrainingLabel = null;
  simulated = Boolean(profile.settings.simulation);
  $('simulation').checked = simulated;
  $('profile-greeting').textContent = profile.name;
  $('visit-count').textContent = profile.accessHistory.length;
  $('mode-explanation').textContent = simulated ? 'Modo debug: o reconhecimento pela câmera continua ativo e você também pode injetar acertos manualmente. Os tempos ficam separados.' : `${vision.classifier.metadata.staticClasses.length} letras têm exemplos estáticos. Treine os movimentos de H, J, K, X e Z e salve poses pessoais para números.`;
  $('game-grid').replaceChildren();
  MODES.forEach(mode => {
    const button = document.createElement('button');
    button.className = 'game-card';
    const top = document.createElement('span'); top.className = 'card-top';
    for (const [className, text] of [['card-icon', mode.icon], ['card-badge', mode.badge]]) {
      const element = document.createElement('span'); element.className = className; element.textContent = text; top.append(element);
    }
    button.append(top);
    const record = (simulated ? profile.demoBestTimes : profile.bestTimes)[mode.id];
    for (const [className, text] of [['card-title', mode.title], ['card-description', mode.description], ['card-record', `${simulated ? 'Demo' : 'Recorde'} · ${Number.isFinite(record) ? formatTime(record) : 'Seu primeiro tempo começa aqui'} →`]]) {
      const element = document.createElement('span'); element.className = className; element.textContent = text; button.append(element);
    }
    button.addEventListener('click', () => prepare(mode));
    $('game-grid').append(button);
  });
  showScreen('dashboard', 'dashboard-title');
}
function prepare(mode, keepCamera = false) {
  clearError(); session++; cancelCountdown(); engine.cancel(); releaseHold();
  finishCalibration();
  if (keepCamera) vision.reset();
  else vision.stop();
  // Returning from Training keeps the challenge the player already selected.
  sequence = keepCamera && selectedMode?.id === mode.id && sequence ? sequence : createSequence(mode.id);
  selectedMode = mode; pendingTrainingLabel = null;
  engine.sequence = sequence; engine.index = 0;
  vision.setTarget(engine.current.target);
  $('game-title').textContent = mode.title;
  $('game-kind').textContent = simulated ? 'Modo debug' : 'Prática com câmera';
  $('timer').textContent = '00:00:000';
  $('hold-time').textContent = '0 / 1000 ms'; $('hold-progress').value = 0;
  $('confidence').textContent = 'Aguardando início';
  $('camera-status').textContent = vision.stream ? 'Câmera ativa. Prepare o primeiro sinal.' : 'A câmera está desligada.';
  $('camera-placeholder').hidden = Boolean(vision.stream);
  $('enable-camera').disabled = false;
  $('enable-camera').textContent = vision.stream ? 'Desligar câmera' : 'Ativar câmera';
  $('start-game').hidden = false; $('start-game').disabled = false;
  $('debug-controls').hidden = !simulated;
  $('recognition-panel').hidden = false;
  $('detected-sign').textContent = 'Aguardando câmera';
  $('recognition-hint').textContent = 'A letra detectada aparecerá aqui, mesmo antes de iniciar a partida.';
  lastMotionAlternatives = null;
  $('motion-distances').replaceChildren(); $('motion-diagnostic-status').textContent = 'Execute um movimento para comparar com os exemplos salvos.';
  attachCamera('game');
  $('simulate-hold').disabled = true; $('simulate-drop').disabled = true;
  $('game-feedback').textContent = simulated ? 'Ative a câmera para reconhecer sinais reais ou inicie sem ela e use a injeção manual.' : 'Ative a câmera. Após tocar em Iniciar, você terá 3 segundos para se preparar.';
  renderTarget();
  showScreen('game', 'game-title');
  if (DYNAMIC_CLASSES.has(vision.target)) showMotionState({ state: 'arming' });
}
function renderTarget() {
  const step = engine.current;
  $('target').replaceChildren();
  [...step.word].forEach((letter, index) => {
    const span = document.createElement('span'); span.textContent = letter;
    span.className = index === step.letterIndex ? 'current' : index < step.letterIndex ? 'completed' : '';
    if (index === step.letterIndex) span.setAttribute('aria-current', 'step');
    $('target').append(span);
  });
  $('target').setAttribute('aria-label', `Alvo ${step.word}. Sinal atual ${step.target}.`);
  $('step-label').textContent = `Sinal ${engine.index + 1} de ${sequence.length} · agora: ${step.target}`;
  $('sequence-progress').max = sequence.length; $('sequence-progress').value = engine.index;
  const dynamic = DYNAMIC_CLASSES.has(step.target);
  $('practice-title').textContent = dynamic ? `Explore o movimento de ${step.target}.` : `Vamos praticar ${step.target}?`;
  $('practice-instruction').textContent = simulated ? 'A câmera reconhece normalmente. Para testar a engine, você também pode manter a injeção manual por 1 segundo.' : dynamic ? 'Espere PRONTO na câmera, execute o movimento completo e mantenha a pose final por 1 segundo. A detecção ainda é experimental.' : vision.classifier.hasClass(step.target) ? 'Mostre uma mão inteira e reproduza o sinal. Mantenha a semelhança acima de 85% por um segundo.' : `Não há exemplos de ${step.target} no dataset. Volte aos Desafios e abra o Treinamento para salvar exemplos pessoais.`;
  $('motion-indicator').hidden = !dynamic;
  $('motion-cue').hidden = !dynamic;
  if (dynamic) showMotionState({ state: 'arming' });
}
function renderReference() {
  const label = $('calibration-class').value;
  const path = SIGN_REFERENCES[label];
  $('reference-media').replaceChildren();
  if (path) {
    const element = document.createElement(path.endsWith('.mp4') ? 'video' : 'img');
    element.src = path;
    if (element.tagName === 'VIDEO') { element.controls = true; element.muted = true; element.playsInline = true; element.preload = 'none'; }
    else { element.alt = `Referência de ${label} do acervo original`; element.loading = 'lazy'; }
    $('reference-media').append(element);
  }
  $('reference-caption').textContent = path ? `Referência de ${label} do acervo original. Confira a execução com um instrutor de LIBRAS.` : 'Não há imagem de referência para este número no acervo. Peça a um instrutor para demonstrá-lo antes de salvar.';
  const dynamic = DYNAMIC_CLASSES.has(label);
  const temporal = dynamic || label === 'UNKNOWN';
  const busy = Boolean(vision.calibration);
  $('reference-title').textContent = label === 'UNKNOWN' ? 'Movimento de rejeição' : `Referência · ${label}`;
  $('training-method').textContent = temporal ? 'Sinal com movimento · execute a trajetória completa.' : 'Sinal estático · mantenha a posição dos dedos.';
  $('save-example').disabled = busy || !vision.ready;
  $('save-example').textContent = temporal ? 'Gravar um movimento' : 'Salvar exemplos deste sinal';
  $('motion-tools').hidden = !temporal;
  $('motion-guide').hidden = !temporal;
  $('personal-count').textContent = temporal ? `${profile?.motionExamples?.[label]?.length ?? 0} de 8 movimentos salvos para ${label === 'UNKNOWN' ? 'rejeição' : label}. Recomendamos de 3 a 5 execuções.` : `${profile?.signExamples?.[label]?.length ?? 0} exemplos pessoais de ${label} salvos.`;
  if (label === 'UNKNOWN') $('reference-caption').textContent = 'Grave movimentos parecidos, mas incorretos (ex.: trajetória incompleta ou invertida), para ajudar o sistema a rejeitá-los.';
  $('remove-motion').disabled = busy || !profile?.motionExamples?.[label]?.length;
  $('import-motion').disabled = busy;
  $('export-motion').disabled = busy || !Object.values(vision.dynamic.classifier.examples).some(clips => clips.length);
}
function finishCalibration() {
  vision.cancelCalibration();
  vision.reset();
  document.body.dataset.capturing = 'false';
  $('calibration-class').disabled = false;
  $('cancel-calibration').hidden = true;
  if (profile) renderReference();
}
function openTraining(origin = 'dashboard', label = null) {
  if (!profile) return;
  clearError(); session++; cancelCountdown(); engine.cancel(); releaseHold();
  finishCalibration();
  $('training-return-game').hidden = origin !== 'game' || !selectedMode;
  attachCamera('training');
  if (label) $('calibration-class').value = label;
  else if (!$('calibration-class').value) $('calibration-class').value = 'K';
  vision.setTarget($('calibration-class').value === 'UNKNOWN' ? 'K' : $('calibration-class').value);
  $('calibration-status').textContent = '';
  $('detected-sign').textContent = vision.stream ? 'Aguardando sinal' : 'Aguardando câmera';
  $('recognition-hint').textContent = 'Faça o sinal selecionado para testar os exemplos gravados.';
  $('camera-status').textContent = vision.stream ? 'Câmera ativa. Escolha um sinal e prepare a pose.' : 'Ative a câmera para gravar ou testar sinais.';
  $('camera-placeholder').hidden = Boolean(vision.stream);
  $('enable-camera').textContent = vision.stream ? 'Desligar câmera' : 'Ativar câmera';
  renderReference();
  showScreen('training', 'training-title');
  if (DYNAMIC_CLASSES.has(vision.target)) showMotionState({ state: 'arming' });
  else { $('motion-indicator').hidden = true; $('motion-cue').hidden = true; }
}
for (const label of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'UNKNOWN']) {
  const option = document.createElement('option'); option.value = label; option.textContent = label === 'UNKNOWN' ? 'Rejeição' : label;
  $('calibration-class').append(option);
}
$('calibration-class').addEventListener('change', () => {
  if (screen !== 'training') return;
  vision.setTarget($('calibration-class').value === 'UNKNOWN' ? 'K' : $('calibration-class').value);
  $('recognition-hint').textContent = `Teste livre: ${$('calibration-class').value === 'UNKNOWN' ? 'movimento de rejeição' : $('calibration-class').value}.`;
  $('calibration-status').textContent = ''; renderReference();
  if (DYNAMIC_CLASSES.has(vision.target)) showMotionState({ state: 'arming' });
  else { $('motion-indicator').hidden = true; $('motion-cue').hidden = true; }
});
$('save-example').addEventListener('click', () => {
  if (screen !== 'training') return;
  try {
    vision.startCalibration($('calibration-class').value);
    $('calibration-status').textContent = 'Prepare o sinal escolhido. A captura começa em 2 segundos…';
    $('save-example').disabled = true; $('calibration-class').disabled = true;
    $('cancel-calibration').hidden = false;
    renderReference();
    showMotionState({ state: 'warmup', remaining: 2 });
    // On a phone, the record action may sit below the camera. Bring the live
    // preparation cue into view before the first sample can be collected.
    $('camera-stage').scrollIntoView({ block: 'start', behavior: 'auto' });
  } catch (error) { $('calibration-status').textContent = error.message; }
});
$('cancel-calibration').addEventListener('click', () => { finishCalibration(); $('calibration-status').textContent = 'Captura cancelada; nenhum exemplo foi salvo.'; });
$('remove-motion').addEventListener('click', () => {
  if (screen !== 'training' || vision.calibration) return;
  try {
    profile = store.removeLastMotion(profile.name, $('calibration-class').value);
    vision.setMotionExamples(profile.motionExamples); renderReference();
    $('calibration-status').textContent = 'Último movimento desta classe removido.';
  } catch (error) { report(error); }
});
$('export-motion').addEventListener('click', () => {
  if (screen !== 'training' || vision.calibration) return;
  const blob = new Blob([JSON.stringify({ version: MOTION_VERSION, examples: vision.dynamic.classifier.examples })], { type: 'application/json' });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'libras-movimentos-v1.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('import-motion').addEventListener('change', async event => {
  const file = event.target.files?.[0], token = session;
  event.target.value = '';
  if (!file || screen !== 'training' || vision.calibration) return;
  try {
    if (file.size > 2000000) throw new Error('O arquivo excede o limite de 2 MB.');
    const payload = JSON.parse(await file.text());
    if (token !== session || screen !== 'training' || vision.calibration) return;
    profile = store.importMotion(profile.name, payload);
    vision.setMotionExamples(profile.motionExamples); renderReference();
    $('calibration-status').textContent = 'Movimentos importados neste perfil. Teste com execuções novas.';
  } catch (error) { report(new Error(`Importação não concluída: ${error.message}`)); }
});
function releaseHold() {
  holding = false;
  $('simulate-hold').setAttribute('aria-pressed', 'false');
  if (simulated) engine.invalidate();
}
function pressHold() {
  if (!simulated || engine.state !== 'running') return;
  holding = true; $('simulate-hold').setAttribute('aria-pressed', 'true');
}
$('profile-form').addEventListener('submit', event => { event.preventDefault(); login($('profile-name').value); });
$('simulation').addEventListener('change', () => {
  try { profile = store.saveSettings(profile.name, { simulation: $('simulation').checked }); clearError(); dashboard(); }
  catch (error) { $('simulation').checked = simulated; report(error); }
});
$('switch-profile').addEventListener('click', () => {
  session++; cancelCountdown(); engine.cancel(); releaseHold(); finishCalibration(); vision.stop(); profile = null; clearError();
  try { listProfiles(); } catch (error) { report(error); }
  showScreen('profile', 'profile-name');
});
for (const id of ['back-menu', 'result-menu']) $(id).addEventListener('click', dashboard);
$('nav-games').addEventListener('click', () => { if (screen !== 'dashboard') dashboard(); });
$('open-training').addEventListener('click', () => {
  if (screen === 'training') return;
  openTraining(screen === 'game' ? 'game' : 'dashboard', screen === 'game' ? pendingTrainingLabel ?? engine.current?.target : null);
});
$('training-return-game').addEventListener('click', () => selectedMode ? prepare(selectedMode, true) : dashboard());
$('play-again').addEventListener('click', () => prepare(selectedMode));
$('enable-camera').addEventListener('click', async () => {
  if (vision.stream) {
    cancelCountdown(); vision.stop(); engine.invalidate(); $('camera-placeholder').hidden = false;
    finishCalibration();
    $('camera-status').textContent = 'Câmera desligada. A confirmação foi reiniciada.';
    $('enable-camera').textContent = 'Ativar câmera';
    if (DYNAMIC_CLASSES.has(vision.target)) showMotionState({ state: 'arming' });
    return;
  }
  const token = session;
  $('enable-camera').disabled = true;
  $('camera-status').textContent = 'Carregando rastreador e solicitando acesso à câmera…';
  try { await vision.start(); }
  catch (error) {
    if (token === session) {
      vision.stop();
      const messages = { NotAllowedError: 'Permissão de câmera negada. Libere o acesso no navegador e tente novamente.', NotFoundError: 'Nenhuma câmera foi encontrada.', NotReadableError: 'A câmera está ocupada ou indisponível. Feche outros aplicativos e tente novamente.' };
      $('camera-status').textContent = messages[error.name] || error.message;
    }
  } finally { if (token === session) $('enable-camera').disabled = false; }
});
$('start-game').addEventListener('click', () => {
  if (screen !== 'game' || countdownEndsAt !== null || engine.state === 'running') return;
  if (!simulated && !vision.ready) { $('game-feedback').textContent = 'Ative a câmera e aguarde a preparação dos exemplos para iniciar.'; return; }
  const missing = [...new Set(sequence.map(step => step.target))].filter(label => DYNAMIC_CLASSES.has(label) ? !vision.dynamic.classifier.hasClass(label) : !vision.classifier.hasClass(label));
  if (!simulated && missing.length) {
    pendingTrainingLabel = missing[0];
    $('game-feedback').textContent = `Este desafio precisa de exemplos de: ${missing.join(', ')}. Toque em ← Desafios, abra o Treinamento e prepare os sinais antes de jogar.`;
    return;
  }
  // The master clock starts only after the visible 3-second preparation window.
  vision.reset(); engine.invalidate();
  countdownEndsAt = performance.now() + 3000;
  $('start-game').disabled = true; $('enable-camera').disabled = true;
  $('countdown-number').textContent = '3'; $('countdown-overlay').hidden = false;
  $('game-feedback').textContent = 'Prepare-se. A partida começará depois da contagem.';
});
function beginMatch() {
  if (countdownEndsAt === null || screen !== 'game' || (!simulated && !vision.ready)) { cancelCountdown(); return; }
  countdownEndsAt = null; $('countdown-overlay').hidden = true;
  $('enable-camera').disabled = false;
  engine.start(sequence); vision.setTarget(engine.current.target);
  document.body.dataset.playing = 'true';
  if (DYNAMIC_CLASSES.has(vision.target)) showMotionState({ state: 'arming' });
  dropUntil = 0; lastMockAt = 0;
  $('start-game').hidden = true;
  $('simulate-hold').disabled = false; $('simulate-drop').disabled = false;
  $('game-feedback').textContent = 'Partida iniciada. Confirme cada sinal por 1 segundo.';
  if (simulated) $('simulate-hold').focus();
}
$('simulate-hold').addEventListener('pointerdown', event => { event.preventDefault(); $('simulate-hold').setPointerCapture(event.pointerId); pressHold(); });
$('simulate-hold').addEventListener('click', event => {
  // Keyboard/assistive activation has no pointer. Enter toggles continuous
  // injection so this development control does not require holding a mouse.
  if (event.detail === 0) { if (holding) releaseHold(); else pressHold(); }
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('simulate-hold').addEventListener(type, releaseHold);
$('simulate-drop').addEventListener('click', () => { dropUntil = performance.now() + 250; engine.invalidate(); $('confidence').textContent = 'Confiança simulada: 84% · confirmação reiniciada'; });
window.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.altKey || event.metaKey || screen !== 'game' || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  if (simulated && engine.state === 'running') { event.preventDefault(); pressHold(); }
});
window.addEventListener('keyup', event => { if (event.code === 'Space') { if (holding) event.preventDefault(); releaseHold(); } });
window.addEventListener('blur', () => { cancelCountdown(); releaseHold(); engine.invalidate(); vision.reset(); if (vision.calibration) finishCalibration(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelCountdown(); releaseHold(); engine.invalidate(); vision.reset(); if (vision.calibration) finishCalibration(); });
window.addEventListener('pagehide', () => { cancelCountdown(); engine.cancel(); vision.stop(); });
async function update(now) {
  if (countdownEndsAt !== null) {
    if (screen !== 'game' || document.hidden || (!simulated && !vision.ready)) cancelCountdown();
    else if (now >= countdownEndsAt) beginMatch();
    else setText('countdown-number', String(Math.ceil((countdownEndsAt - now) / 1000)));
  }
  if (vision.calibration && now - vision.calibration.startedAt > 15000) {
    finishCalibration(); $('calibration-status').textContent = 'Captura encerrada sem leituras suficientes. Verifique a câmera e tente novamente.';
  }
  if (engine.state === 'running' && !document.hidden) {
    if (simulated && holding && !debugPending && now - lastMockAt >= 30) {
      const token = session, target = engine.current.target;
      debugPending = true; lastMockAt = now;
      try {
        const prediction = await mock.predict(null, target, true);
        if (token === session && holding && engine.state === 'running' && target === engine.current.target) {
          if (now < dropUntil) prediction.confidenceProbability = 0.84;
          engine.observe(prediction, now);
          $('confidence').textContent = `Confiança simulada: ${Math.round(prediction.confidenceProbability * 100)}%`;
        }
      } finally { debugPending = false; }
    }
    if (engine.state === 'running') {
      const status = engine.tick(now);
      $('timer').textContent = formatTime(status.elapsed);
      $('hold-progress').value = engine.confirmedDuration;
      $('hold-time').textContent = `${Math.floor(engine.confirmedDuration)} / 1000 ms`;
    }
  }
  requestAnimationFrame(update);
}
try { store = new ProfileStore(localStorage); listProfiles(); }
catch (error) { report(new Error(`O armazenamento local está indisponível: ${error.message}. Permita o armazenamento do site para criar um perfil.`)); }
$('boot-status').hidden = true;
requestAnimationFrame(update);
