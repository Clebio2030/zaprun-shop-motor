// tools/fb-teste/testar-jpr.js
// Reproduz o que a comparação mostrou na JPR (23/11) e confere o Motor 1.3.5:
//  - pedido de retirada leva o endereço do cliente balcão (LOCALENTR, BAIRRO,
//    CEP, UF, CDMUNICIPIO), como o Automec e a Pontual fazem;
//  - STATUS/ORDEM do item seguem a casa (lá: vazio, não 'FF');
//  - número de orçamento já citado numa venda (SAIDAESTOQUE) é pulado.
// Monta e desmonta os próprios dados no banco de TESTE.
//
//   FB_PORT=3055 FB_DATABASE=/firebird/data/automec.fdb node tools/fb-teste/testar-jpr.js

process.env.FB_HOST = process.env.FB_HOST || '127.0.0.1';
process.env.FB_PORT = process.env.FB_PORT || '3055';
process.env.FB_DATABASE = process.env.FB_DATABASE || '/firebird/data/automec.fdb';

const assert = require('node:assert');
const path = require('path');
const orc = require(path.join(__dirname, '../../backend/src/motor/erp/automec-orcamento'));
const { executar } = require(path.join(__dirname, '../../backend/src/motor/firebirdEscrita'));
const { fixEncoding } = require(path.join(__dirname, '../../backend/src/motor/encoding'));

const cfg = { idEmpresaErp: 1, cdClienteErp: 1, cdVendedorPadrao: '1', cdProdutoFrete: '90' };

async function existe(tabela, coluna) {
  const sql = coluna
    ? 'SELECT COUNT(*) AS Q FROM RDB$RELATION_FIELDS WHERE TRIM(RDB$RELATION_NAME) = ? AND TRIM(RDB$FIELD_NAME) = ?'
    : 'SELECT COUNT(*) AS Q FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?';
  const [l] = await executar(sql, coluna ? [tabela, coluna] : [tabela]);
  return Number(l.q) > 0;
}

(async () => {
  const [emp] = await executar('SELECT CAST(NOMEEMPRESA AS VARCHAR(60) CHARACTER SET OCTETS) AS N FROM CONFIGURACAO WHERE IDEMPRESA = 1');
  assert.strictEqual(fixEncoding(emp && emp.n).trim(), 'LOJA DE TESTE', 'banco não é o de teste — abortado');

  for (const [c, t] of [['ENDERECO', 'VARCHAR(60)'], ['BAIRRO', 'VARCHAR(40)'], ['CEP', 'VARCHAR(10)'], ['UF', 'VARCHAR(2)'], ['CDMUNICIPIO', 'INTEGER']]) {
    if (!(await existe('CLIENTE', c))) await executar(`ALTER TABLE CLIENTE ADD ${c} ${t}`);
  }
  if (!(await existe('SAIDAESTOQUE'))) {
    await executar('CREATE TABLE SAIDAESTOQUE (NRPEDIDO INTEGER NOT NULL PRIMARY KEY, IDEMPRESA INTEGER, NRORCAMENTO INTEGER, DTSAIDA DATE, STATUS INTEGER)');
  }
  await executar("UPDATE CLIENTE SET ENDERECO = 'AV. DA LOJA, 500', BAIRRO = 'CENTRO', CEP = '58000-000', UF = 'PB', CDMUNICIPIO = 2507507 WHERE CDCLIENTE = 1 AND IDEMPRESA = 1");
  // Venda que já cita o próximo número (7301) e o seguinte (7302).
  await executar('DELETE FROM SAIDAESTOQUE WHERE NRPEDIDO IN (1, 2)');
  await executar("INSERT INTO SAIDAESTOQUE (NRPEDIDO, IDEMPRESA, NRORCAMENTO, DTSAIDA, STATUS) VALUES (1, 1, 7301, '2026-11-10', 1)");
  await executar("INSERT INTO SAIDAESTOQUE (NRPEDIDO, IDEMPRESA, NRORCAMENTO, DTSAIDA, STATUS) VALUES (2, 1, 7302, '2026-11-11', 1)");
  // Itens da casa com STATUS vazio (12 orçamentos antigos).
  for (let i = 0; i < 12; i++) {
    await executar("INSERT INTO ORCAMENTO (NRORCAMENTO, IDEMPRESA, CDCLIENTE, DTORC, STATUS, CLIENTE) VALUES (?, 1, 1, '2026-11-01', 1, '*CASA')", [7250 + i]);
    await executar("INSERT INTO ORCPROD (POSIC, NRORCAMENTO, IDEMPRESA, CDPRODUTO, QTDPRODUTO, VLUNIT, TOTAL, STATUS, ORDEM) VALUES (1, ?, 1, '1201', 1, 1, 1, '', 'A')", [7250 + i]);
  }
  orc.esquecerCaches();
  let nr = null;
  try {
    const p = { pedidoId: 930001, numero: 88, criadoEm: new Date().toISOString(), versao: 'v', hash: 'h', cancelado: false,
      cliente: { nome: '*RETIRA NA LOJA', telefone: '83999990000', cpf: null }, modalidade: 'retirada', entrega: null,
      itens: [{ cdproduto: '1201', descricao: 'CERVEJA', quantidade: 2, valorUnitario: 5, total: 10, idpreco: null }],
      frete: null, desconto: 0, subtotal: 10, total: 10, observacao: 'PEDIDO ZAPRUN #88 | RETIRADA', nrOrcamento: null, idEmpresaErp: 1, vendedor: '1' };
    const r = await orc.sincronizarPedido(p, cfg, 'gravar');
    nr = r.nrOrcamento;
    console.log('gravou:', r.acao, nr, r.avisos);
    assert.strictEqual(nr, 7303, 'pula 7301 e 7302, citados em vendas');
    const [o] = await executar(
      'SELECT CAST(LOCALENTR AS VARCHAR(60) CHARACTER SET OCTETS) AS L, CAST(BAIRRO AS VARCHAR(40) CHARACTER SET OCTETS) AS B, CEP, UF, CDMUNICIPIO FROM ORCAMENTO WHERE NRORCAMENTO = ? AND IDEMPRESA = 1',
      [nr]
    );
    console.log('endereço:', fixEncoding(o.l), '|', fixEncoding(o.b), '|', String(o.cep).trim(), String(o.uf).trim(), o.cdmunicipio);
    assert.strictEqual(fixEncoding(o.l).trim(), 'AV. DA LOJA, 500');
    assert.strictEqual(o.cdmunicipio, 2507507);
    const [i] = await executar('SELECT CAST(STATUS AS VARCHAR(2) CHARACTER SET OCTETS) AS S, ORDEM FROM ORCPROD WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [nr]);
    console.log('item STATUS:', JSON.stringify(i.s === null ? null : fixEncoding(i.s)), 'ORDEM:', String(i.ordem).trim());
    assert.strictEqual(i.s === null ? null : fixEncoding(i.s).trim(), '');
    const cmp = await orc.compararDois(cfg, nr, 7250);
    console.log('vendas ligadas ao 7303:', JSON.stringify(cmp.tabelasLigadas));
    console.log('\nOK — endereço do balcão, item no jeito da casa e número pulando a venda.');
  } finally {
    if (nr) {
      await executar('DELETE FROM ORCPROD WHERE IDEMPRESA = 1 AND NRORCAMENTO = ?', [nr]);
      await executar('DELETE FROM ORCAMENTO WHERE IDEMPRESA = 1 AND NRORCAMENTO = ?', [nr]);
    }
    await executar('DELETE FROM ORCPROD WHERE IDEMPRESA = 1 AND NRORCAMENTO BETWEEN 7250 AND 7261');
    await executar('DELETE FROM ORCAMENTO WHERE IDEMPRESA = 1 AND NRORCAMENTO BETWEEN 7250 AND 7261');
    await executar('DELETE FROM SAIDAESTOQUE WHERE NRPEDIDO IN (1, 2)');
    await executar('UPDATE CLIENTE SET ENDERECO = NULL, BAIRRO = NULL, CEP = NULL, UF = NULL, CDMUNICIPIO = NULL WHERE CDCLIENTE = 1 AND IDEMPRESA = 1');
    orc.esquecerCaches();
  }
  process.exit(0);
})().catch(err => {
  console.error('FALHOU:', err);
  process.exit(1);
});
