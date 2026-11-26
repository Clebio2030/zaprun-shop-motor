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
  // O que o node-firebird (1.x e 2.x) grava: getTime() − getTimezoneOffset().
  // Tem de dar a hora local do pedido exata, sem os 28 s do fuso de 1899.
  const q = new Date('2026-11-19T20:15:30.000Z');
  const gravado = d.HORAORC.getTime() - d.HORAORC.getTimezoneOffset() * 60000;
  assert.strictEqual(gravado, Date.UTC(1899, 11, 30, q.getHours(), q.getMinutes(), q.getSeconds()));
});

test('histórico: colunas na ordem do Automec, com ";" e cortadas em 80', () => {
  const { mensagemDoHistorico } = require('./automec-orcamento');
  const m = mensagemDoHistorico(['NRORCAMENTO', 'IDEMPRESA', 'CDCLIENTE', 'DTORC', 'CDVENDEDOR', 'CLIENTE', 'ZR_PEDIDO', 'VLTOTAL', 'OBSERVACAO']);
  assert.strictEqual(m, 'CDVENDEDOR;CLIENTE;VLTOTAL;CDCLIENTE;DTORC;OBSERVACAO;', 'chave e ZR_PEDIDO ficam de fora');
  // O da JPR (23/11), exatamente 80 caracteres.
  const jpr = mensagemDoHistorico(['CDVENDEDOR', 'CLIENTE', 'CDMUNICIPIO', 'VLTOTAL', 'IDENDERECO', 'CDPROPAGANDA', 'CDCLIENTE', 'BAIRRO', 'CEP', 'UF']);
  assert.strictEqual(jpr, 'CDVENDEDOR;CLIENTE;CDMUNICIPIO;VLTOTAL;IDENDERECO;CDPROPAGANDA;CDCLIENTE;BAIRRO;');
  assert.strictEqual(mensagemDoHistorico(['STATUS'], 80), 'STATUS;');
});

test('histórico: o que conta como alteração', () => {
  const { valorMudou } = require('./automec-orcamento');
  const texto = { texto: true, tamanho: 10 };
  const numero = { texto: false };
  assert.strictEqual(valorMudou(texto, Buffer.from('JOS\xc9      ', 'latin1'), 'JOSÉ', 'win1252'), false, 'CHAR com espaços e WIN1252');
  assert.strictEqual(valorMudou(texto, 'ABCDEFGHIJ', 'ABCDEFGHIJKLM', 'win1252'), false, 'compara já cortado no tamanho');
  assert.strictEqual(valorMudou(texto, null, '', 'win1252'), false);
  assert.strictEqual(valorMudou(texto, 'A', 'B', 'win1252'), true);
  assert.strictEqual(valorMudou(numero, 7.3746, 7.37463768, 'win1252'), false, 'NUMERIC(15,4) arredondado');
  assert.strictEqual(valorMudou(numero, 62.85, 62.7, 'win1252'), true);
  assert.strictEqual(valorMudou(numero, null, 0, 'win1252'), true);
  assert.strictEqual(valorMudou(numero, null, null, 'win1252'), false);
});

test('regra copiada do Automec da casa para QTDELIB/QTDEPECA', () => {
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

test('ZR_PEDIDO usa número da Loja e aceita legado pedidoId na validação', () => {
  const { zrDoPedido, pertenceAoPedido } = require('./automec-orcamento');
  const ped = { pedidoId: 359, numero: 56 };
  assert.strictEqual(zrDoPedido(ped), 56);
  assert.strictEqual(zrDoPedido({ pedidoId: 359 }), 359);
  assert.strictEqual(pertenceAoPedido(56, ped), true, 'v1.3.12+ (número da loja)');
  assert.strictEqual(pertenceAoPedido(359, ped), true, 'legado <= v1.3.11 (pedidoId)');
  assert.strictEqual(pertenceAoPedido(null, ped), true);
  assert.strictEqual(pertenceAoPedido(55, ped), false, 'orçamento de outro pedido');
});

test('número da Loja repetido: só vale o orçamento gravado na hora em que ESTE pedido nasceu', () => {
  const { nasceuJunto, datasDoOrcamento } = require('./automec-orcamento');
  const schemaComHora = { tabelas: { ORCAMENTO: { DTORC: { tipo: 12 }, HORAORC: { tipo: 35 } } } };
  const criadoEm = '2026-11-26T14:59:48.440Z';
  // O que o Motor grava para este pedido, nas duas convenções de HORAORC.
  for (const horaBase1899 of [true, false]) {
    const d = datasDoOrcamento(schemaComHora, criadoEm, { horaBase1899, dataComHora: false });
    assert.strictEqual(nasceuJunto({ dtorc: d.DTORC, horaorc: d.HORAORC }, criadoEm), true, `próprio (1899=${horaBase1899})`);
  }
  // Gravado até a v1.3.12: HORAORC 28 s adiantado (fuso de 1899).
  const q = new Date(criadoEm);
  const adiantado = new Date(1899, 11, 30, q.getHours(), q.getMinutes(), q.getSeconds() + 28);
  assert.strictEqual(nasceuJunto({ dtorc: new Date(q.getFullYear(), q.getMonth(), q.getDate()), horaorc: adiantado }, criadoEm), true, 'legado com 28 s');
  // Outro pedido com o mesmo número, criado antes (excluído; número reaproveitado).
  const outro = datasDoOrcamento(schemaComHora, '2026-11-26T14:12:05.000Z', { horaBase1899: true, dataComHora: false });
  assert.strictEqual(nasceuJunto({ dtorc: outro.DTORC, horaorc: outro.HORAORC }, criadoEm), false, 'mesmo dia, outra hora');
  const ontem = datasDoOrcamento(schemaComHora, '2026-11-25T14:59:48.440Z', { horaBase1899: true, dataComHora: false });
  assert.strictEqual(nasceuJunto({ dtorc: ontem.DTORC, horaorc: ontem.HORAORC }, criadoEm), false, 'mesma hora, outro dia');
  // Sem HORAORC na tabela, ou nula: decide pela data.
  assert.strictEqual(nasceuJunto({ dtorc: outro.DTORC }, criadoEm), true);
  assert.strictEqual(nasceuJunto({ dtorc: outro.DTORC, horaorc: null }, criadoEm), true);
});
