const test = require('node:test');
const assert = require('node:assert');
const { montarInsert, aplicarExtras, linhasDoPedido, chaveDeNome, datasDoOrcamento } = require('./automec-orcamento');

const schema = {
  tabelas: {
    ORCAMENTO: {
      NRORCAMENTO: { tipo: 8, texto: false },
      CLIENTE: { tipo: 37, texto: true, tamanho: 10 },
      OBS: { tipo: 261, blob: true },
      DTORC: { tipo: 12 },
      HORAORC: { tipo: 35 }
    }
  }
};

test('INSERT só com as colunas que existem, texto cortado e com CAST WIN1252', () => {
  const r = montarInsert(schema, 'ORCAMENTO', { NRORCAMENTO: 1, CLIENTE: '*JOSÉ DA SILVA', NAOEXISTE: 3, OBS: 'AÇÃO' }, 'win1252');
  assert.strictEqual(r.sql, 'INSERT INTO ORCAMENTO (NRORCAMENTO, CLIENTE, OBS) VALUES (?, CAST(? AS VARCHAR(10) CHARACTER SET WIN1252), ?)');
  assert.deepStrictEqual(r.params.slice(0, 2), [1, '*JOSÉ DA S']);
  assert.ok(Buffer.isBuffer(r.params[2]), 'BLOB vai como Buffer WIN1252');
  assert.deepStrictEqual(r.ausentes, ['NAOEXISTE']);
});

test('extras: constante, por modalidade, e nome de coluna inválido ignorado', () => {
  const v = aplicarExtras({ A: 1 }, { CDTPENTREGA: { entrega: 'E', retirada: 'R' }, INDFINAL: 0, 'X;DROP': 1 }, 'retirada');
  assert.deepStrictEqual(v, { A: 1, CDTPENTREGA: 'R', INDFINAL: 0 });
});

test('frete vira a última linha do orçamento', () => {
  const linhas = linhasDoPedido({ itens: [{ cdproduto: '1', total: 10 }], frete: { cdproduto: '90', descricao: 'FRETE', valor: 8 } });
  assert.strictEqual(linhas.length, 2);
  assert.deepStrictEqual(linhas[1], { cdproduto: '90', descricao: 'FRETE', quantidade: 1, valorUnitario: 8, total: 8, idpreco: null });
});

test('município casa sem acento e sem pontuação', () => {
  assert.strictEqual(chaveDeNome('João  Pessoa'), chaveDeNome('JOAO PESSOA'));
  assert.strictEqual(chaveDeNome("Pau-d'Arco"), 'PAU D ARCO');
});

test('HORAORC no zero do Delphi quando o Automec guarda assim', () => {
  const d = datasDoOrcamento(schema, '2026-11-19T20:15:30.000Z', { horaBase1899: true, dataComHora: false });
  assert.strictEqual(d.HORAORC.getFullYear(), 1899);
  assert.strictEqual(d.DTORC.getHours(), 0);
});

test('regra copiada do Automec da casa para CALC/QTDELIB/QTDEPECA', () => {
  const { valorDaRegra } = require('./automec-orcamento');
  assert.strictEqual(valorDaRegra('qtd', 2.5), 2.5);
  assert.strictEqual(valorDaRegra('zero', 2.5), 0);
  assert.strictEqual(valorDaRegra('nulo', 2.5), null);
  assert.strictEqual(valorDaRegra('um', 2.5), 1);
  assert.strictEqual(valorDaRegra(undefined, 3), 3, 'sem regra, a quantidade (como a Pontual)');
});

test('prazo aprendido da casa vira data a partir da data do orçamento', () => {
  const { resolverPrazos } = require('./automec-orcamento');
  const r = resolverPrazos({ DTVALIDADE: { $diasAposDtorc: 7 }, TIPOORC: 'O' }, new Date(2026, 10, 23));
  assert.strictEqual(r.TIPOORC, 'O');
  assert.strictEqual(r.DTVALIDADE.getDate(), 30);
});
