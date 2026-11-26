// tools/fb-teste/testar-orcamento.js
// Teste de integração da gravação de orçamento (ADR-307) contra um Firebird DE
// TESTE — nunca contra o banco de um cliente.
//
//   docker run -d --name zr-fb-teste -p 127.0.0.1:3055:3050 -e ISC_PASSWORD=masterkey jacobalberty/firebird:v4.0
//   (criar /firebird/data/automec.fdb com schema-automec-minimo.sql — ver o cabeçalho de lá)
//   FB_PORT=3055 FB_DATABASE=/firebird/data/automec.fdb node tools/fb-teste/testar-orcamento.js
//
// Recusa rodar se o banco não tiver a empresa "LOJA DE TESTE" do schema mínimo.

process.env.FB_HOST = process.env.FB_HOST || '127.0.0.1';
process.env.FB_PORT = process.env.FB_PORT || '3055';
process.env.FB_DATABASE = process.env.FB_DATABASE || '/firebird/data/automec.fdb';

const assert = require('node:assert');
const path = require('path');
const orc = require(path.join(__dirname, '../../backend/src/motor/erp/automec-orcamento'));
const { executar } = require(path.join(__dirname, '../../backend/src/motor/firebirdEscrita'));
const { fixEncoding } = require(path.join(__dirname, '../../backend/src/motor/encoding'));

const config = { idEmpresaErp: 1, cdClienteErp: 1, cdVendedorPadrao: '1', cdProdutoFrete: '90', extras: null };

const pedido = (extra = {}) => ({
  pedidoId: 900001,
  numero: 12,
  criadoEm: new Date().toISOString(),
  versao: new Date().toISOString(),
  hash: 'h1',
  cancelado: false,
  cliente: { nome: '*MARIA JOSÉ DA CONCEIÇÃO 😀', telefone: '83999990000', cpf: null },
  modalidade: 'entrega',
  entrega: { logradouro: 'RUA DAS ACÁCIAS, 100', complemento: 'APTO 2', bairro: 'CENTRO', cidade: 'JOÃO PESSOA', uf: 'PB', cep: '58000000' },
  itens: [
    { cdproduto: '1201', descricao: 'CERVEJA LATA 350ML', quantidade: 3, valorUnitario: 9.95, total: 29.85, idpreco: null },
    { cdproduto: '88', descricao: 'CARVÃO 5KG', quantidade: 1.5, valorUnitario: 20, total: 30, idpreco: 4 }
  ],
  frete: { cdproduto: '90', descricao: 'FRETE', valor: 8 },
  desconto: 5,
  subtotal: 67.85,
  total: 62.85,
  observacao: 'PEDIDO ZAPRUN #12 | ENTREGA | PAG: PIX',
  nrOrcamento: null,
  idEmpresaErp: 1,
  vendedor: '7',
  ...extra
});

async function orcamento(nr) {
  const [o] = await executar(
    `SELECT NRORCAMENTO, STATUS, CDCLIENTE, CDVENDEDOR, VLTOTAL, SUBTOTAL, DESCONTO, PERC_DESCONTO, CDMUNICIPIO, DTORC, HORAORC, ZR_PEDIDO,
            CAST(CLIENTE AS VARCHAR(100) CHARACTER SET OCTETS) AS CLIENTE, TELEFONE,
            CAST(LOCALENTR AS VARCHAR(60) CHARACTER SET OCTETS) AS LOCALENTR, CAST(OBSERVACAO AS VARCHAR(255) CHARACTER SET OCTETS) AS OBS
       FROM ORCAMENTO WHERE NRORCAMENTO = ? AND IDEMPRESA = 1`,
    [nr]
  );
  const itens = await executar(
    `SELECT POSIC, CDPRODUTO, CAST(DESCRICAO AS VARCHAR(150) CHARACTER SET OCTETS) AS DESCRICAO, UNID, QTDPRODUTO, VLUNIT, TOTAL,
            QTDEPECA, STATUS, CDDEPOSITO, IDPRECO, ORDEM, SUBTOTAL, CALC, QTDELIB, VLCUSTO, CDCLIENTE
       FROM ORCPROD WHERE NRORCAMENTO = ? AND IDEMPRESA = 1 ORDER BY POSIC`,
    [nr]
  );
  return { o, itens };
}

async function contar() {
  const [c] = await executar('SELECT COUNT(*) AS Q FROM ORCAMENTO WHERE IDEMPRESA = 1');
  return Number(c.q);
}

(async () => {
  const [emp] = await executar("SELECT CAST(NOMEEMPRESA AS VARCHAR(60) CHARACTER SET OCTETS) AS N FROM CONFIGURACAO WHERE IDEMPRESA = 1");
  assert.strictEqual(fixEncoding(emp && emp.n).trim(), 'LOJA DE TESTE', 'banco não é o de teste — abortado');

  const antes = await contar();

  // 1. Ensaio: valida tudo e não deixa nada.
  let r = await orc.sincronizarPedido(pedido(), config, 'ensaio');
  console.log('ensaio:', r.acao, 'previsto', r.nrPrevisto, r.avisos);
  assert.strictEqual(r.acao, 'criado');
  assert.strictEqual(r.ensaio, true);
  assert.strictEqual(r.nrPrevisto, 7301);
  assert.strictEqual(await contar(), antes, 'ensaio deixou orçamento no banco');

  // 2. Gravar: cria a coluna ZR_PEDIDO e o orçamento.
  r = await orc.sincronizarPedido(pedido(), config, 'gravar');
  console.log('gravar:', r.acao, r.nrOrcamento, r.avisos, r.duracaoMs + 'ms');
  assert.strictEqual(r.acao, 'criado');
  assert.strictEqual(r.nrOrcamento, 7301);
  assert.strictEqual(r.cdVendedor, '7');
  let { o, itens } = await orcamento(7301);
  assert.strictEqual(o.status, 0);
  assert.strictEqual(o.zr_pedido, 12, 'ZR_PEDIDO guarda o número do pedido na Loja, não o pedidoId');
  assert.strictEqual(o.cdvendedor, 7);
  assert.strictEqual(Number(o.subtotal), 67.85);
  assert.strictEqual(Number(o.desconto), 5);
  assert.strictEqual(Number(o.vltotal), 62.85);
  assert.strictEqual(o.cdmunicipio, 2507507, 'município por nome sem acento');
  assert.strictEqual(o.cliente.toString('hex'), Buffer.from('*MARIA JOSÉ DA CONCEIÇÃO', 'latin1').toString('hex'), 'bytes WIN1252 do nome');
  assert.strictEqual(fixEncoding(o.localentr), 'RUA DAS ACÁCIAS, 100');
  assert.strictEqual(fixEncoding(o.obs), 'PEDIDO ZAPRUN #12 | ENTREGA | PAG: PIX');
  assert.strictEqual(o.horaorc.getFullYear(), 1899, 'HORAORC no zero do Delphi, como o último orçamento');
  assert.strictEqual(itens.length, 3);
  assert.deepStrictEqual(itens.map(i => [i.posic, String(i.cdproduto).trim(), Number(i.qtdproduto), Number(i.total)]), [
    [1, '1201', 3, 29.85],
    [2, '88', 1.5, 30],
    [3, '90', 1, 8]
  ]);
  assert.strictEqual(String(itens[0].unid).trim(), 'UN');
  assert.strictEqual(String(itens[1].unid).trim(), 'UN', 'CDUNIDVENDA vazio cai no CDUNIDADE');
  assert.strictEqual(Number(itens[0].vlcusto), 6.1234);
  assert.strictEqual(itens[0].idpreco, 1, 'sem idpreco do servidor, o do produto');
  assert.strictEqual(itens[1].idpreco, 4, 'idpreco do servidor');
  assert.strictEqual(itens[1].cddeposito, 2);
  assert.strictEqual(String(itens[0].status).trim(), 'EN', 'entrega: item EN');
  assert.deepStrictEqual(itens.map(i => Number(i.calc)), [9.95, 20, 8], 'CALC = valor unitário');
  assert.strictEqual(fixEncoding(itens[1].descricao), 'CARVÃO 5KG');

  // 3. Internet caiu antes de o servidor saber o número: acha pela ZR_PEDIDO.
  r = await orc.sincronizarPedido(pedido(), config, 'gravar');
  console.log('reenvio sem número:', r.acao, r.nrOrcamento);
  assert.strictEqual(r.acao, 'atualizado');
  assert.strictEqual(r.nrOrcamento, 7301);
  assert.strictEqual(await contar(), antes + 1, 'duplicou');

  // 4. Pedido alterado: tira o carvão, muda a quantidade.
  r = await orc.sincronizarPedido(
    pedido({ nrOrcamento: 7301, itens: [{ cdproduto: '1201', descricao: 'CERVEJA LATA 350ML', quantidade: 6, valorUnitario: 9.95, total: 59.7, idpreco: null }], subtotal: 67.7, total: 62.7, hash: 'h2' }),
    config,
    'gravar'
  );
  ({ o, itens } = await orcamento(7301));
  console.log('alterado:', r.acao, itens.length, 'linhas', Number(o.vltotal));
  assert.strictEqual(r.acao, 'atualizado');
  assert.strictEqual(itens.length, 2);
  assert.strictEqual(Number(o.vltotal), 62.7);
  assert.strictEqual(o.cdvendedor, 7, 'vendedor não muda na atualização');

  // 5. Produto que não existe no ERP: erro definitivo, nada gravado.
  r = await orc.sincronizarPedido(
    pedido({ pedidoId: 900002, numero: 13, itens: [{ cdproduto: '99999', descricao: 'NAO EXISTE', quantidade: 1, valorUnitario: 1, total: 1, idpreco: null }], frete: null, desconto: 0, subtotal: 1, total: 1 }),
    config,
    'gravar'
  );
  console.log('produto inexistente:', r.acao, r.erro, 'transitório:', r.transitorio);
  assert.strictEqual(r.acao, 'erro');
  assert.strictEqual(r.transitorio, false);
  assert.strictEqual(await contar(), antes + 1, 'orçamento pela metade ficou no banco');

  // 6. Cancelado no ZapRun.
  r = await orc.sincronizarPedido(pedido({ nrOrcamento: 7301, cancelado: true, hash: 'h3' }), config, 'gravar');
  ({ o } = await orcamento(7301));
  console.log('cancelado:', r.acao, 'STATUS', o.status);
  assert.strictEqual(r.acao, 'cancelado');
  assert.strictEqual(o.status, 2);

  // 7. Finalizado no ERP: travado, não mexe.
  r = await orc.sincronizarPedido(pedido({ nrOrcamento: 7301, hash: 'h4' }), config, 'gravar');
  console.log('travado:', r.acao, r.situacaoErp);
  assert.strictEqual(r.acao, 'travado');

  // 8. Cancelado antes de existir: ignorado.
  r = await orc.sincronizarPedido(pedido({ pedidoId: 900003, numero: 14, cancelado: true }), config, 'gravar');
  assert.strictEqual(r.acao, 'ignorado');

  // 9. Excluído no ERP: removido, não recria.
  await executar('DELETE FROM ORCPROD WHERE NRORCAMENTO = 7301 AND IDEMPRESA = 1');
  await executar('DELETE FROM ORCAMENTO WHERE NRORCAMENTO = 7301 AND IDEMPRESA = 1');
  r = await orc.sincronizarPedido(pedido({ nrOrcamento: 7301, hash: 'h5' }), config, 'gravar');
  console.log('excluído no ERP:', r.acao);
  assert.strictEqual(r.acao, 'removido');
  assert.strictEqual(await contar(), antes);

  // 10. Vendedor que não existe: erro com o motivo.
  r = await orc.sincronizarPedido(pedido({ pedidoId: 900004, numero: 15 }), { ...config, cdVendedorPadrao: '55' }, 'gravar');
  console.log('config inválida:', r.acao, r.erro);
  assert.strictEqual(r.acao, 'erro');
  assert.match(r.erro, /vendedor 55/);

  // 11. Relatório.
  orc.esquecerCaches();
  const rel = await orc.relatorio(config);
  console.log('relatório:', JSON.stringify({ numeracao: rel.numeracao, texto: rel.texto, colunaZr: rel.colunaZr, validacao: rel.validacao, calibracao: rel.calibracao, posicionais: rel.posicionais, obrigatoriasSemValor: rel.obrigatoriasSemValor }));
  assert.strictEqual(rel.colunaZr, true);
  assert.strictEqual(rel.validacao.nomes.vendedor, 'LOJA VIRTUAL');

  console.log('\nOK — todos os cenários passaram.');
  process.exit(0);
})().catch(err => {
  console.error('FALHOU:', err);
  process.exit(1);
});
