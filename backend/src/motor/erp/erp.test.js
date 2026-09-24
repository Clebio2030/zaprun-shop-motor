// Escolha do ERP pelo ERP_TIPO do backend/.env.
//
// O caso que mais importa é o PRIMEIRO: instalação antiga, sem a chave, tem de
// continuar sendo Automec — o .env é preservado pelo updater e nunca vai ganhar
// ERP_TIPO sozinho.

const test = require('node:test');
const assert = require('node:assert');

const caminho = require.resolve('./index');

/** Carrega o módulo do zero, com o ERP_TIPO pedido. */
function carregarCom(valor) {
  delete require.cache[caminho];
  if (valor === undefined) delete process.env.ERP_TIPO;
  else process.env.ERP_TIPO = valor;
  return require('./index');
}

test('sem ERP_TIPO é Automec — instalação anterior a esta escolha', () => {
  const { tipoErp } = carregarCom(undefined);
  assert.strictEqual(tipoErp(), 'automec');
});

test('ERP_TIPO tolera maiúscula e espaço', () => {
  const { tipoErp } = carregarCom('  Linear ');
  assert.strictEqual(tipoErp(), 'linear');
});

test('linear carrega o adaptador do Linear sem exigir o mysql2 no require', () => {
  const { erp } = carregarCom('linear');
  const adaptador = erp();
  assert.strictEqual(adaptador.id, 'linear');
  assert.strictEqual(typeof adaptador.extrairProdutos, 'function');
});

test('ERP_TIPO desconhecido lança, com a lista do que é suportado', () => {
  const { erp } = carregarCom('bling');
  assert.throws(() => erp(), /ERP_TIPO="bling".*automec, linear/);
});
