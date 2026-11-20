const test = require('node:test');
const assert = require('node:assert');
const { textoParaErp, marcadorDeTexto, testarEscritaWin1252, paraBufferWin1252 } = require('./textoParaErp');
const { decodeWin1252 } = require('./encoding');

test('mantém o que existe em WIN1252 e dobra o que não existe', () => {
  assert.strictEqual(textoParaErp('*JOSÉ DA CONCEIÇÃO'), '*JOSÉ DA CONCEIÇÃO');
  assert.strictEqual(textoParaErp('Café ☕ com açúcar 😀'), 'Café com açúcar');
  assert.strictEqual(textoParaErp('Łódź'), 'Lódz');
  assert.strictEqual(textoParaErp('preço — “ótimo” €'), 'preço — “ótimo” €');
});

test('modo ascii tira todo acento', () => {
  assert.strictEqual(textoParaErp('AÇÃO ÚNICA', null, 'ascii'), 'ACAO UNICA');
});

test('corta no tamanho da coluna e limpa espaço e quebra de linha', () => {
  assert.strictEqual(textoParaErp('  RUA   A\nCASA 2 ', 8), 'RUA A CA');
  assert.strictEqual(textoParaErp('   '), null);
  assert.strictEqual(textoParaErp(null), null);
  assert.strictEqual(textoParaErp(123), '123');
});

test('marcador do parâmetro', () => {
  assert.strictEqual(marcadorDeTexto(60), 'CAST(? AS VARCHAR(60) CHARACTER SET WIN1252)');
  assert.strictEqual(marcadorDeTexto(60, 'ascii'), '?');
});

test('auto-teste: bytes certos = win1252; errados ou erro = ascii', async () => {
  const certo = Buffer.from([0x41, 0xC7, 0xC3, 0x4F, 0x20, 0xC9, 0x20, 0xDA, 0x4E, 0x49, 0x43, 0x4F]);
  assert.strictEqual((await testarEscritaWin1252(async () => [{ b: certo }])).modo, 'win1252');
  const utf8 = Buffer.from('AÇÃO É ÚNICO', 'utf8');
  assert.strictEqual((await testarEscritaWin1252(async () => [{ b: utf8 }])).modo, 'ascii');
  assert.strictEqual((await testarEscritaWin1252(async () => { throw new Error('x'); })).modo, 'ascii');
});

test('buffer WIN1252 para coluna BLOB faz ida e volta com o decodificador', () => {
  const texto = 'AÇÃO — “ótimo” € ok';
  assert.strictEqual(decodeWin1252(paraBufferWin1252(texto)), texto);
  assert.strictEqual(paraBufferWin1252('É')[0], 0xC9);
});
