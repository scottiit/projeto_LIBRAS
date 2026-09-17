export const ALPHABET = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
export const NUMBERS = [...'0123456789'];
export const FIXED_WORDS = ['BOLA', 'CASA', 'MAO', 'LUZ'];
export const WORDS = ['BOLA', 'CASA', 'MAO', 'LUZ', 'SOL', 'LUA', 'PATO', 'GATO', 'SAPO', 'MALA', 'MESA', 'CAMA', 'COPO', 'DADO', 'FADA', 'FITA', 'LATA', 'LEAO', 'LOBO', 'OVO', 'PIPA', 'RATO', 'ROSA', 'SUCO', 'UVA', 'VELA', 'VIDA', 'AMOR'];
export const MODES = [
  { id: 'alphabet-ordered', title: 'Alfabeto em ordem', description: 'Um passo de cada vez, de A a Z.', badge: '26 sinais', icon: 'Aa' },
  { id: 'alphabet-random', title: 'Alfabeto aleatório', description: 'Cinco letras para uma nova descoberta.', badge: '5 sinais', icon: 'Az' },
  { id: 'numbers-ordered', title: 'Números em ordem', description: 'Conte com as mãos, do zero ao nove.', badge: '10 sinais', icon: '01' },
  { id: 'numbers-random', title: 'Números aleatórios', description: 'Cinco números em uma ordem surpresa.', badge: '5 sinais', icon: '08' },
  { id: 'words-fixed', title: 'Palavras do dia a dia', description: 'Soletre BOLA, CASA, MAO e LUZ.', badge: '4 palavras', icon: 'Ab' },
  { id: 'words-random', title: 'Palavras surpresa', description: 'Descubra três palavras a cada rodada.', badge: '3 palavras', icon: '?!' },
];
export function sample(pool, count, random = Math.random) {
  const shuffled = [...pool];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled.slice(0, count);
}
export function createSequence(mode, random = Math.random) {
  const pools = {
    'alphabet-ordered': () => ALPHABET,
    'alphabet-random': () => sample(ALPHABET, 5, random),
    'numbers-ordered': () => NUMBERS,
    'numbers-random': () => sample(NUMBERS, 5, random),
    'words-fixed': () => FIXED_WORDS,
    'words-random': () => sample(WORDS, 3, random),
  };
  if (!Object.hasOwn(pools, mode)) throw new Error('Modo desconhecido.');
  return pools[mode]().flatMap((word, wordIndex) => [...word].map((target, letterIndex) => ({ target, word, wordIndex, letterIndex })));
}
export function formatTime(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds));
  return `${String(Math.floor(total / 60000)).padStart(2, '0')}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')}:${String(total % 1000).padStart(3, '0')}`;
}
