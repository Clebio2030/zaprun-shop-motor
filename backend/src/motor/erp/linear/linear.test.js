// Linear Sistemas: da linha do MySQL até o produto que vai para a API.
//
// O MySQL não é real: o módulo ./mysql é trocado no require.cache antes de o
// adaptador carregá-lo. As linhas abaixo são cópias de linhas REAIS do banco
// da loja (23/09/2026), com os aliases da consulta.

const test = require('node:test');
const assert = require('node:assert');

const mysqlPath = require.resolve('./mysql');

let ultimaQuery = null;
let proximasLinhas = [];

require.cache[mysqlPath] = {
  id: mysqlPath,
  filename: mysqlPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    query: async (sql, params) => {
      ultimaQuery = { sql, params };
      return proximasLinhas;
    },
    testarConexao: async () => ({ ok: true }),
    explicarErro: e => String(e),
    opcoes: () => ({ host: '10.0.32.42', port: 3306, database: 'bd1', user: 'x_bi' })
  }
};

const linear = require('./index');
const { montarSqlLinear, hojeLocal } = require('./consulta');

/** Linha no formato da consulta, com os defaults do produto sem promoção. */
function linha(extra) {
  return {
    CDPRODUTO: 5888,
    PRODUTO_DESCRICAO: 'SALSICHA SEARA KG',
    PRODUTO_OBS: null,
    GRUPO: 'RESFRIADOS',
    CODBARRA: '0000000000003',
    IDPRECO: 1,
    TABELA_PRECO: 'PRECO DE VENDA',
    PRECO: '11.490',
    CDDEPOSITO: 1,
    DEPOSITO_DESCRICAO: 'LOJA',
    SALDO: '7.609',
    UNIDADE: 'KG',
    PROMO_PRECO: null,
    PROMO_INICIO: null,
    PROMO_FIM: null,
    PROMO_NOME: null,
    ...extra
  };
}

// ── GTIN ─────────────────────────────────────────────────────────────────────

test('gtinValido aceita EAN-13 real e recusa o código de balança', () => {
  assert.strictEqual(linear.gtinValido('7896010002133'), true); // conhaque Dreher
  assert.strictEqual(linear.gtinValido('7898306402740'), true);
  assert.strictEqual(linear.gtinValido('0000000000003'), false); // salsicha a granel
  assert.strictEqual(linear.gtinValido('0000000002147'), false); // abóbora
});

test('gtinValido recusa dígito verificador errado, letra e comprimento estranho', () => {
  assert.strictEqual(linear.gtinValido('7896010002134'), false);
  assert.strictEqual(linear.gtinValido('78960100021A3'), false);
  assert.strictEqual(linear.gtinValido('12345'), false);
});

test('gtinValido recusa código curto demais mesmo com o dígito certo por acaso', () => {
  // "0000000000000" + verificador 0 fecha a conta GS1, mas não é EAN de nada.
  assert.strictEqual(linear.gtinValido('0000000000000'), false);
  assert.strictEqual(linear.gtinValido('0000000000017'), false);
});

// ── Consulta ─────────────────────────────────────────────────────────────────

test('a consulta usa a data da MÁQUINA para a agenda de promoções', () => {
  const { sql, params } = montarSqlLinear(null, new Date(2026, 8, 23, 21, 30));
  assert.deepStrictEqual(params, [1, '2026-09-23', 1]);
  assert.match(sql, /\? BETWEEN b\.es1_dtini AND b\.es1_dtfim/);
  assert.doesNotMatch(sql, /CURDATE\(\)/);
});

test('o filtro por produto vai como parâmetro, nunca interpolado', () => {
  const { sql, params } = montarSqlLinear(5888, new Date(2026, 8, 23));
  assert.match(sql, /AND e\.es1_cod = \?/);
  assert.deepStrictEqual(params, [1, '2026-09-23', 1, 5888]);
});

test('a consulta aplica a mesma regra da loja virtual do Linear', () => {
  const { sql } = montarSqlLinear();
  assert.match(sql, /e\.es1_ativo = '1'/);
  assert.match(sql, /e\.es1_lojavirtual = 1/);
  // Preço de balcão, não o +12% da view_sitemercado.
  assert.match(sql, /e\.es1_prvarejo\s+AS PRECO/);
});

test('hojeLocal é o calendário local, com zero à esquerda', () => {
  assert.strictEqual(hojeLocal(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

// ── Extração ─────────────────────────────────────────────────────────────────

test('produto sem promoção sai com promocao: null e a unidade', async () => {
  proximasLinhas = [linha()];
  const { produtos } = await linear.extrairProdutos();

  assert.strictEqual(produtos.length, 1);
  const p = produtos[0];
  assert.strictEqual(p.cdproduto, 5888);
  assert.strictEqual(p.descricao, 'SALSICHA SEARA KG');
  assert.strictEqual(p.unidade, 'KG');
  assert.strictEqual(p.promocao, null);
  assert.deepStrictEqual(p.precos, [{ idpreco: 1, tabela: 'PRECO DE VENDA', preco: 11.49 }]);
  assert.deepStrictEqual(p.estoque, [{ cddeposito: 1, deposito: 'LOJA', saldo: 7.609 }]);
  // O código de balança não vai como código de barras.
  assert.deepStrictEqual(p.codigos_barra, []);
});

test('produto em promoção leva preço, datas e nome — e o preço normal continua em precos', async () => {
  proximasLinhas = [
    linha({
      CDPRODUTO: 6263,
      PRODUTO_DESCRICAO: 'LINGUICA CALABRESA CIACARNE',
      CODBARRA: '0000000000020',
      PRECO: '21.900',
      PROMO_PRECO: '19.980',
      PROMO_INICIO: '2026-09-18',
      PROMO_FIM: '2026-09-30',
      PROMO_NOME: '2° QUINZ ANIVERSARIO SUPERVAREJISTA 2026'
    })
  ];
  const [p] = (await linear.extrairProdutos()).produtos;

  assert.deepStrictEqual(p.promocao, {
    preco: 19.98,
    inicio: '2026-09-18',
    fim: '2026-09-30',
    nome: '2° QUINZ ANIVERSARIO SUPERVAREJISTA 2026'
  });
  assert.strictEqual(p.precos[0].preco, 21.9);
});

test('promoção MAIOR que o preço é relatada como veio — quem decide é o servidor', async () => {
  proximasLinhas = [linha({ CDPRODUTO: 6393, PRECO: '3.590', PROMO_PRECO: '3.990' })];
  const [p] = (await linear.extrairProdutos()).produtos;
  assert.strictEqual(p.promocao && p.promocao.preco, 3.99);
});

test('vários códigos de barras viram um produto só, com os EAN válidos', async () => {
  proximasLinhas = [
    linha({ CDPRODUTO: 72, PRODUTO_DESCRICAO: 'CONHAQUE DREHER 900ML', CODBARRA: '7896010002133', UNIDADE: 'UN' }),
    linha({ CDPRODUTO: 72, PRODUTO_DESCRICAO: 'CONHAQUE DREHER 900ML', CODBARRA: '7896010006360', UNIDADE: 'UN' })
  ];
  const { produtos, linhas } = await linear.extrairProdutos();
  assert.strictEqual(linhas, 2);
  assert.strictEqual(produtos.length, 1);
  assert.deepStrictEqual(produtos[0].codigos_barra, ['7896010002133', '7896010006360']);
  assert.strictEqual(produtos[0].precos.length, 1);
});

test('extrairProdutos por produto passa o código como parâmetro', async () => {
  proximasLinhas = [linha()];
  await linear.extrairProdutos(null, '5888');
  assert.strictEqual(ultimaQuery.params[ultimaQuery.params.length - 1], 5888);
});
