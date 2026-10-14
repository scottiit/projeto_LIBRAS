import { validTrainingThreshold } from './example-policy.js';

/** DOM adapter: staged changes are inert until this native dialog confirms.
 * Native dialog handles focus trapping and Escape. A cancelled/stale operation
 * never calls the persistence adapter. Actual persistence errors keep the modal
 * open so the user can retry or cancel; the repository restores committed data.
 */
export class TrainingDangerZone {
  constructor(root, getContext, apply, onError = () => {}) {
    Object.assign(this, { root, getContext, apply, onError });
    this.pending = null; this.working = false;
    this.element = id => root.getElementById(id);
    this.dialog = this.element('training-confirmation');
    this.element('training-threshold').addEventListener('input', () => this.renderProposal());
    this.element('apply-training-threshold').addEventListener('click', () => this.open('threshold'));
    this.element('delete-oldest-examples').addEventListener('click', () => this.open('oldest'));
    this.element('delete-newest-examples').addEventListener('click', () => this.open('newest'));
    this.element('cancel-training-action').addEventListener('click', () => this.cancel());
    this.element('confirm-training-action').addEventListener('click', () => this.confirm());
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.cancel(); });
    this.dialog.addEventListener('close', () => { this.pending = null; this.trigger?.focus(); });
  }
  signature(context) { return JSON.stringify([context.name, context.label, context.threshold, context.records]); }
  render() {
    const context = this.getContext();
    if (!context) return;
    this.context = context;
    const count = Math.min(5, context.records.length);
    this.element('danger-scope').textContent = `Perfil global · sinal ${context.label === 'UNKNOWN' ? 'de rejeição' : context.label}. Alterações no CSV serão usadas por todos os jogadores.`;
    this.element('threshold-current').textContent = `Mínimo aplicado: mais de ${Math.round(context.threshold * 100)}%.`;
    this.element('training-threshold').value = String(Math.round(context.threshold * 100));
    this.element('training-threshold').disabled = context.busy;
    for (const [id, description] of [['delete-oldest-examples', 'mais antigos'], ['delete-newest-examples', 'mais recentes']]) {
      this.element(id).textContent = `Apagar ${count || 5} ${description}`;
      this.element(id).disabled = context.busy || count === 0;
    }
    this.renderProposal();
  }
  renderProposal() {
    const value = Number(this.element('training-threshold').value);
    this.element('training-threshold-value').textContent = `${value}%`;
    this.element('apply-training-threshold').disabled = !this.context || this.context.busy || !validTrainingThreshold(value / 100) || value === Math.round(this.context.threshold * 100);
  }
  open(kind) {
    const context = this.getContext();
    if (!context || context.busy || this.dialog.open || this.working) return;
    const count = Math.min(5, context.records.length);
    const value = Number(this.element('training-threshold').value) / 100;
    if (kind === 'threshold' ? !validTrainingThreshold(value) || value === context.threshold : count === 0) return;
    this.pending = { kind, value, count, label: context.label, name: context.name, signature: this.signature(context) };
    this.trigger = this.root.activeElement;
    this.element('training-confirmation-error').hidden = true;
    this.element('training-confirmation-title').textContent = kind === 'threshold' ? 'Alterar tolerância?' : 'Excluir exemplos permanentemente?';
    this.element('training-confirmation-description').textContent = kind === 'threshold'
      ? `Tem certeza que deseja alterar a tolerância de ${context.label} para ${Math.round(value * 100)}% no Perfil global? Isso afetará a captura de novos sinais por todos os treinadores. Os exemplos existentes serão preservados e o limite do jogo continuará igual.`
      : `Você está prestes a excluir ${count} ${count === 1 ? 'exemplo' : 'exemplos'} ${kind === 'oldest' ? 'mais antigos' : 'mais recentes'} de ${context.label} permanentemente do Perfil global em dataset_libras.csv. Esta ação também pode remover âncoras protegidas e afetará todos os jogadores. Deseja continuar?`;
    this.element('confirm-training-action').textContent = kind === 'threshold' ? 'Aplicar tolerância' : `Excluir ${count} ${count === 1 ? 'exemplo' : 'exemplos'}`;
    this.element('confirm-training-action').className = kind === 'threshold' ? 'primary' : 'danger-button danger-solid';
    this.dialog.showModal();
    this.element('cancel-training-action').focus();
  }
  cancel() { if (this.working) return; this.pending = null; if (this.dialog.open) this.dialog.close(); }
  async confirm() {
    if (!this.pending || this.working) return;
    const context = this.getContext(), operation = this.pending;
    if (!context || context.busy || this.signature(context) !== operation.signature) {
      this.cancel(); this.onError(new Error('Os dados mudaram. Revise a letra e abra a confirmação novamente.')); return;
    }
    this.working = true;
    for (const id of ['confirm-training-action', 'cancel-training-action']) this.element(id).disabled = true;
    try {
      await this.apply(operation);
      this.pending = null; this.dialog.close();
    } catch (error) {
      this.element('training-confirmation-error').textContent = `Alteração não salva: ${error.message}`;
      this.element('training-confirmation-error').hidden = false;
      this.onError(error);
    } finally {
      this.working = false;
      for (const id of ['confirm-training-action', 'cancel-training-action']) this.element(id).disabled = false;
      this.render();
    }
  }
}
