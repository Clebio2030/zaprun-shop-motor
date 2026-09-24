// setup-env.js — o que vai parar no backend/.env.
//
// O teste que importa é o da SENHA: `#` sem aspas é comentário para o dotenv, e
// foi assim que uma senha real chegou truncada ao banco em 23/09/2026.

const test = require('node:test');
const assert = require('node:assert');
const dotenv = require('dotenv');
const { formatarValor, aplicarAtualizacoes, sugestoesPorCnpj, DEFAULT_ENV } = require('./setup-env');

test('senha com # @ ! % chega intacta depois de passar pelo dotenv', () => {
  for (const senha of ['Linear@bi#cloud0_', 'a!b%c #d', "com'aspa", 'com"dupla\'e simples']) {
    const env = dotenv.parse(`LINEAR_PASSWORD=${formatarValor(senha)}\n`);
    assert.strictEqual(env.LINEAR_PASSWORD, senha);
  }
});

test('caminho, IP e token continuam sem aspas, como sempre foram', () => {
  assert.strictEqual(formatarValor('C:\\Sistemas\\Banco\\DADOS.FDB'), 'C:\\Sistemas\\Banco\\DADOS.FDB');
  assert.strictEqual(formatarValor('10.0.32.42'), '10.0.32.42');
  assert.strictEqual(formatarValor('zrerp_abc123'), 'zrerp_abc123');
});

test('caminho com espaço sobrevive ao dotenv', () => {
  const v = 'C:\\Program Files\\Sistema\\DADOS.FDB';
  assert.strictEqual(dotenv.parse(`FB_DATABASE=${formatarValor(v)}`).FB_DATABASE, v);
});

test('aplicarAtualizacoes troca, acrescenta e mantém o vazio', () => {
  const saida = aplicarAtualizacoes(DEFAULT_ENV, {
    ERP_TIPO: 'linear',
    FB_HOST: 'EMPTY_VAL',
    LINEAR_DATABASE: 'bd17124086000167'
  });
  const env = dotenv.parse(saida);
  assert.strictEqual(env.ERP_TIPO, 'linear');
  assert.strictEqual(env.FB_HOST, '127.0.0.1'); // EMPTY_VAL manteve
  assert.strictEqual(env.LINEAR_DATABASE, 'bd17124086000167');
  assert.strictEqual(env.PORT, '3010');
});

test('banco e usuário sugeridos pelo CNPJ da loja', () => {
  assert.deepStrictEqual(sugestoesPorCnpj('17.124.086/0001-67'), {
    database: 'bd17124086000167',
    user: '17124086_bi'
  });
  assert.strictEqual(sugestoesPorCnpj('123'), null);
});
