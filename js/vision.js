import { DYNAMIC_CLASSES, isValidHand } from './trajectory.js';
import { SignClassifier, CalibrationSession } from './classifier.js';
import { TemporalRecognizer, MotionCapture, MOTION_LABELS } from './dynamic.js';
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240';

/** Replace this adapter with a TensorFlow.js classifier returning the same contract.
 * Default confidence is zero: hand detection alone must never imply a correct sign.
 */
export class StaticClassifierMock {
  async predict(landmarks, targetClass, injected = false) {
    return { targetClass, confidenceProbability: injected ? 0.98 : 0, timestamp: Date.now() };
  }
}
let libraryPromise;
export function loadHands() {
  if (globalThis.Hands) return Promise.resolve();
  libraryPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => { script.remove(); libraryPromise = null; reject(new Error('Tempo esgotado ao carregar o MediaPipe. Verifique sua conexão.')); }, 20000);
    script.src = `${CDN}/hands.js`;
    script.crossOrigin = 'anonymous';
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); libraryPromise = null; reject(new Error('Não foi possível carregar o MediaPipe pela CDN.')); };
    document.head.append(script);
  });
  return libraryPromise;
}
const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

export class VisionController {
  constructor(video, canvas, onFrame, onStatus, onCalibration = () => {}) {
    Object.assign(this, { video, canvas, onFrame, onStatus });
    this.onCalibration = onCalibration;
    this.classifier = new SignClassifier();
    this.dynamic = new TemporalRecognizer();
    this.generation = 0;
    this.revision = 0;
    this.target = null;
  }
  setPersonalExamples(examples) { this.classifier.setPersonalExamples(examples); }
  setMotionExamples(examples) { this.dynamic.setExamples(examples); }
  startCalibration(label) {
    if (!this.ready) throw new Error('Ative a câmera e aguarde a preparação dos exemplos antes de ensinar um sinal.');
    this.reset();
    this.calibration = MOTION_LABELS.includes(label) ? new MotionCapture(label, performance.now()) : new CalibrationSession(label, performance.now());
  }
  cancelCalibration() { this.calibration = null; }
  setTarget(target) { this.target = target; this.reset(); }
  reset() { this.revision++; this.dynamic.reset(); }
  async start() {
    this.stop();
    const generation = this.generation;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Câmera indisponível. Use localhost (Live Server) ou HTTPS.');
    await loadHands();
    if (generation !== this.generation) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
    if (generation !== this.generation) return;
    const hands = new globalThis.Hands({ locateFile: file => `${CDN}/${file}` });
    this.hands = hands;
    hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.5, minTrackingConfidence: 0.65 });
    this.onStatus('Preparando o reconhecimento local…');
    await this.classifier.adaptFromImages(hands, (index, total) => {
      this.onStatus(`Preparando exemplos do acervo: ${index}/${total}…`);
    }, () => generation !== this.generation);
    if (generation !== this.generation) return;
    hands.onResults(results => this.handleResults(results, generation));
    this.ready = true;
    this.onStatus(`Câmera ativa · ${this.classifier.metadata.staticClasses.length} letras disponíveis. Posicione uma mão no enquadramento.`);
    const processFrame = async () => {
      if (generation !== this.generation) return;
      try {
        // Serial await prevents overlapping inference requests and unbounded queues.
        if (!document.hidden && this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = this.video.currentTime;
          this.captureTime = performance.now();
          this.captureTarget = this.target;
          this.captureRevision = this.revision;
          await hands.send({ image: this.video });
        }
      } catch (error) {
        if (generation === this.generation) { this.stop(); this.onStatus(`Falha no rastreamento: ${error.message}. Tente ativar a câmera novamente.`); }
        return;
      }
      if (generation === this.generation) this.raf = requestAnimationFrame(processFrame);
    };
    this.raf = requestAnimationFrame(processFrame);
  }
  async handleResults(results, generation) {
    if (generation !== this.generation || document.hidden) return;
    const hand = results.multiHandLandmarks?.[0];
    const target = this.captureTarget, time = this.captureTime, revision = this.captureRevision;
    this.draw(hand);
    if (target !== this.target || revision !== this.revision) return;
    const aspectRatio = this.video.videoHeight ? this.video.videoWidth / this.video.videoHeight : 1;
    // Hands labels assume mirrored input, but send() receives raw video.
    const rawLabel = results.multiHandedness?.[0]?.label;
    const handedness = rawLabel === 'Left' ? 'Right' : rawLabel === 'Right' ? 'Left' : null;
    if (this.calibration) {
      const status = this.calibration.observe(hand, time, aspectRatio, handedness);
      if (['complete', 'timeout'].includes(status.state)) this.calibration = null;
      this.onCalibration(status);
      return;
    }
    let prediction = null;
    if (isValidHand(hand)) {
      prediction = DYNAMIC_CLASSES.has(target)
        ? this.dynamic.predict(hand, time, handedness, aspectRatio)
        : this.classifier.predict(hand, /^\d$/.test(target) ? 'numbers' : 'alphabet', aspectRatio);
    } else this.dynamic.reset();
    if (generation === this.generation && target === this.target && revision === this.revision) this.onFrame(prediction, time, isValidHand(hand));
  }
  draw(hand) {
    const width = this.video.videoWidth || 640, height = this.video.videoHeight || 480;
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    const context = this.canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    if (!isValidHand(hand)) return;
    context.strokeStyle = '#85f4d5'; context.lineWidth = 3; context.fillStyle = '#ffffff';
    CONNECTIONS.forEach(([a, b]) => { context.beginPath(); context.moveTo(hand[a].x * width, hand[a].y * height); context.lineTo(hand[b].x * width, hand[b].y * height); context.stroke(); });
    hand.forEach(point => { context.beginPath(); context.arc(point.x * width, point.y * height, 4, 0, Math.PI * 2); context.fill(); });
  }
  stop() {
    this.ready = false;
    this.generation++;
    this.cancelCalibration();
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    const oldHands = this.hands;
    this.hands = null;
    if (oldHands) Promise.resolve(oldHands.close()).catch(() => {});
    this.lastVideoTime = null;
    this.reset();
    this.canvas.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
