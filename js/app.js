import { MODES, createSequence, formatTime } from './games.js';
import { ProfileStore } from './storage.js';
import { GameEngine } from './engine.js';
import { VisionController, StaticClassifierMock } from './vision.js';
import { SIGN_REFERENCES } from './dataset.js';

const $ = id => document.getElementById(id);
let store, profile, selectedMode, sequence, simulated = false, holding = false, screen = 'profile';
let debugPending = false, dropUntil = 0, session = 0, lastMockAt = 0;
function report(error) { $('error').textContent = error.message || String(error); $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
function showScreen(name, focus) {
  screen = name;
  for (const value of ['profile', 'dashboard', 'game', 'result']) $(`${value}-screen`).hidden = value !== name;
  $('switch-profile').hidden = name === 'profile';
  $(focus)?.focus();
}
const vision = new VisionController($('camera'), $('overlay'), (prediction, capturedAt, tracked) => {
  if (simulated) return;
  const approved = engine.state === 'running' && engine.observe(prediction, capturedAt);
  if (approved) return;
  const label = prediction?.targetClass;
  const probability = prediction?.confidenceProbability ?? 0;
  const score = (probability * 100).toFixed(1);
  $('detected-sign').textContent = !tracked ? 'Nenhuma mão detectada' : label ? `Detectado: ${label}` : 'Nenhum sinal identificado';
  $('detected-sign').dataset.match = label === engine.current?.target && probability > .85 ? 'true' : 'false';
  $('confidence').textContent = !tracked ? 'Mão não detectada · confirmação reiniciada' : prediction?.source === 'heuristic' ? `Evidência de movimento: ${score}%` : `Semelhança com os exemplos: ${score}%`;
  if (label && label !== engine.current?.target) $('recognition-hint').textContent = `A mão se parece mais com ${label}. O alvo continua sendo ${engine.current?.target}.`;
  else if (label && probability <= .85) $('recognition-hint').textContent = 'Ainda incerto. Ajuste a posição e a orientação dos dedos; antes da partida, você pode salvar exemplos pessoais.';
  else $('recognition-hint').textContent = engine.state === 'running' ? 'Mantenha a pose por um segundo para confirmar.' : 'O reconhecimento já está ativo. Clique em Iniciar partida quando estiver pronto.';
}, message => {
  $('camera-status').textContent = message;
  $('camera-placeholder').hidden = Boolean(vision.stream);
  $('enable-camera').textContent = vision.stream ? 'Desligar câmera' : 'Ativar câmera';
}, status => {
  if (status.state === 'complete') {
    try {
      profile = store.saveExamples(profile.name, status.label, status.samples);
      vision.setPersonalExamples(profile.signExamples);
      $('calibration-status').textContent = `Cinco exemplos de ${status.label} salvos neste perfil. Faça o sinal novamente para testar.`;
    } catch (error) { report(new Error(`Os exemplos não foram salvos: ${error.message}`)); }
    finishCalibration();
  } else if (status.state === 'timeout') {
    $('calibration-status').textContent = 'Não foi possível obter uma pose estável. Tente novamente com a mão inteira no enquadramento.';
    finishCalibration();
  } else $('calibration-status').textContent = status.state === 'warmup' ? `Prepare o sinal. A captura começa em ${status.remaining}…` : status.state === 'tracking-lost' ? 'Mão não detectada. A captura recomeçará ao enquadrá-la.' : `Mantenha a pose estável… ${Math.round(status.progress * 100)}%`;
});
const mock = new StaticClassifierMock();
const engine = new GameEngine({
  onAdvance() {
    vision.setTarget(engine.current.target);
    renderTarget();
    $('game-feedback').textContent = 'Sinal confirmado! Continue para o próximo.';
    $('target-area').classList.remove('success-flash');
    void $('target-area').offsetWidth;
    $('target-area').classList.add('success-flash');
  },
  onFinish(elapsed) {
    releaseHold();
    session++;
    vision.stop();
    $('final-time').textContent = formatTime(elapsed);
    $('result-mode').textContent = selectedMode.title;
    $('result-note').textContent = simulated ? 'Partida simulada. Este tempo não mede reconhecimento ou domínio de LIBRAS.' : 'Reconhecimento por exemplos e trajetórias. Este resultado não certifica fluência.';
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
  try { profile = store.login(name); vision.setPersonalExamples(profile.signExamples); dashboard(); } catch (error) { report(error); }
}
function dashboard() {
  session++;
  engine.cancel();
  releaseHold();
  vision.stop();
  simulated = Boolean(profile.settings.simulation);
  $('simulation').checked = simulated;
  $('profile-greeting').textContent = profile.name;
  $('visit-count').textContent = profile.accessHistory.length;
  $('mode-explanation').textContent = simulated ? 'Modo de teste: os acertos são injetados e os tempos ficam separados.' : 'Reconhecimento pela câmera ativo: 23 letras usam os exemplos do projeto; J, Z e X usam trajetórias. Números precisam de exemplos pessoais.';
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
function prepare(mode) {
  clearError(); session++; engine.cancel(); releaseHold(); vision.stop();
  selectedMode = mode; sequence = createSequence(mode.id);
  engine.sequence = sequence; engine.index = 0;
  vision.setTarget(engine.current.target);
  $('game-title').textContent = mode.title;
  $('game-kind').textContent = simulated ? 'Demonstração · acertos simulados' : 'Reconhecimento pela câmera';
  $('timer').textContent = '00:00:000';
  $('hold-time').textContent = '0 / 1000 ms'; $('hold-progress').value = 0;
  $('confidence').textContent = 'Aguardando início';
  $('camera-status').textContent = 'A câmera está desligada.';
  $('camera-placeholder').hidden = false;
  $('enable-camera').disabled = false;
  $('enable-camera').textContent = 'Ativar câmera';
  $('start-game').hidden = false; $('start-game').disabled = false;
  $('debug-controls').hidden = !simulated;
  $('recognition-panel').hidden = simulated;
  $('calibration-panel').hidden = simulated;
  $('detected-sign').textContent = 'Aguardando câmera';
  $('recognition-hint').textContent = 'A letra detectada aparecerá aqui, mesmo antes de iniciar a partida.';
  $('calibration-status').textContent = '';
  finishCalibration();
  $('simulate-hold').disabled = true; $('simulate-drop').disabled = true;
  $('game-feedback').textContent = simulated ? 'Você pode testar a mecânica sem câmera. Inicie e segure o botão de simulação.' : 'Ative a câmera e teste a pose antes de iniciar. O relógio só começa com o botão Iniciar partida.';
  renderTarget();
  showScreen('game', 'game-title');
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
  const dynamic = ['J', 'Z', 'X'].includes(step.target);
  $('practice-title').textContent = dynamic ? `Explore o movimento de ${step.target}.` : `Vamos praticar ${step.target}?`;
  $('practice-instruction').textContent = simulated ? 'Segure o acerto simulado por 1 segundo. Qualquer interrupção reinicia a confirmação.' : dynamic ? 'Execute a trajetória e mantenha a pose final por 1 segundo. A detecção ainda é experimental.' : vision.classifier.hasClass(step.target) ? 'Mostre uma mão inteira e reproduza o sinal. Mantenha a semelhança acima de 85% por um segundo.' : `Não há exemplos de ${step.target} no dataset. Antes de iniciar, salve exemplos pessoais desse número no painel abaixo da câmera.`;
  if (engine.state !== 'running') $('calibration-class').value = step.target;
  renderReference();
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
  const dynamic = ['J', 'Z', 'X'].includes(label);
  $('save-example').disabled = dynamic || engine.state === 'running';
  $('personal-count').textContent = dynamic ? 'Este sinal é avaliado pelo movimento, não por uma foto da pose.' : `${profile?.signExamples?.[label]?.length ?? 0} exemplos pessoais de ${label} salvos.`;
}
function finishCalibration() {
  vision.cancelCalibration();
  $('start-game').disabled = false;
  $('calibration-class').disabled = engine.state === 'running';
  $('cancel-calibration').hidden = true;
  renderReference();
}
for (const label of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']) {
  const option = document.createElement('option'); option.value = label; option.textContent = label;
  $('calibration-class').append(option);
}
$('calibration-class').addEventListener('change', renderReference);
$('save-example').addEventListener('click', () => {
  if (engine.state === 'running') return;
  try {
    vision.startCalibration($('calibration-class').value);
    $('calibration-status').textContent = 'Prepare o sinal escolhido. A captura começa em 2 segundos…';
    $('save-example').disabled = true; $('start-game').disabled = true; $('calibration-class').disabled = true;
    $('cancel-calibration').hidden = false;
  } catch (error) { $('calibration-status').textContent = error.message; }
});
$('cancel-calibration').addEventListener('click', () => { finishCalibration(); $('calibration-status').textContent = 'Captura cancelada; nenhum exemplo foi salvo.'; });
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
  session++; engine.cancel(); releaseHold(); vision.stop(); profile = null; clearError();
  try { listProfiles(); } catch (error) { report(error); }
  showScreen('profile', 'profile-name');
});
for (const id of ['back-menu', 'result-menu']) $(id).addEventListener('click', dashboard);
$('play-again').addEventListener('click', () => prepare(selectedMode));
$('enable-camera').addEventListener('click', async () => {
  if (vision.stream) {
    vision.stop(); engine.invalidate(); $('camera-placeholder').hidden = false;
    finishCalibration();
    $('camera-status').textContent = 'Câmera desligada. A confirmação foi reiniciada.';
    $('enable-camera').textContent = 'Ativar câmera'; return;
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
  if (vision.calibration) return;
  if (!simulated && !vision.ready) { $('game-feedback').textContent = 'Ative a câmera e aguarde a preparação dos exemplos para iniciar.'; return; }
  const missing = [...new Set(sequence.map(step => step.target))].filter(label => !['J', 'Z', 'X'].includes(label) && !vision.classifier.hasClass(label));
  if (!simulated && missing.length) {
    $('game-feedback').textContent = `Faltam exemplos de: ${missing.join(', ')}. Salve esses sinais no painel de ajuste antes de iniciar.`;
    $('calibration-panel').open = true;
    $('calibration-class').value = missing[0]; renderReference();
    return;
  }
  engine.start(sequence); vision.setTarget(engine.current.target);
  $('save-example').disabled = true; $('calibration-class').disabled = true;
  dropUntil = 0; lastMockAt = 0;
  $('start-game').hidden = true;
  $('simulate-hold').disabled = false; $('simulate-drop').disabled = false;
  $('game-feedback').textContent = 'Partida iniciada. Confirme cada sinal por 1 segundo.';
  if (simulated) $('simulate-hold').focus();
});
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
window.addEventListener('blur', () => { releaseHold(); engine.invalidate(); vision.reset(); if (vision.calibration) finishCalibration(); });
document.addEventListener('visibilitychange', () => { releaseHold(); engine.invalidate(); vision.reset(); if (vision.calibration) finishCalibration(); });
window.addEventListener('pagehide', () => { engine.cancel(); vision.stop(); });
async function update(now) {
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
