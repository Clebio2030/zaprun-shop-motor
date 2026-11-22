const test = require('node:test');
const assert = require('node:assert');
const { parametrosDaTransacao, TPB_ESCRITA } = require('./firebirdEscrita');

test('node-firebird 1.x recebe o TPB inteiro, com o byte de versão', () => {
  assert.deepStrictEqual(parametrosDaTransacao({ ISOLATION_READ_COMMITTED: [3, 9, 6, 15, 18] }), TPB_ESCRITA);
});

test('node-firebird 2.x recebe só o isolamento, sem espera (o driver põe versão e escrita)', () => {
  assert.deepStrictEqual(parametrosDaTransacao({ ISOLATION_READ_COMMITTED: [15, 18] }), {
    isolation: [15, 17],
    readOnly: false,
    wait: false
  });
});

test('o driver instalado aqui (1.1.9) cai no formato 1.x', () => {
  assert.deepStrictEqual(parametrosDaTransacao(), TPB_ESCRITA);
});
