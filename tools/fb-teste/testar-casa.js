// tools/fb-teste/testar-casa.js
// O Motor copia o que o Automec da casa sempre preenche (v1.3.3): códigos
// e indicadores repetidos em 90% dos últimos registros, e prazos de data
// ("validade = data do orçamento + 7 dias"). Monta 12 orçamentos "da casa" no
// banco de TESTE, confere a cópia na criação, o conserto de um orçamento
// antigo com o Reenviar e a comparação — e desmonta tudo no fim.
//
//   FB_PORT=3055 FB_DATABASE=/firebird/data/automec.fdb node tools/fb-teste/testar-casa.js

process.env.FB_HOST = process.env.FB_HOST || '127.0.0.1';
process.env.FB_PORT = process.env.FB_PORT || '3055';
process.env.FB_DATABASE = process.env.FB_DATABASE || '/firebird/data/automec.fdb';

const assert = require('node:assert');
const path = require('path');
const orc = require(path.join(__dirname, '../../backend/src/motor/erp/automec-orcamento'));
const { executar } = require(path.join(__dirname, '../../backend/src/motor/firebirdEscrita'));
const { fixEncoding } = require(path.join(__dirname, '../../backend/src/motor/encoding'));

const cfg = { idEmpresaErp: 1, cdClienteErp: 1, cdVendedorPadrao: '1', cdProdutoFrete: '90' };
const ped = (id, extra = {}) => ({
  pedidoId: id, numero: id, criadoEm: new Date(2026, 10, 23, 15, 0).toISOString(), versao: 'v', hash: 'h', cancelado: false,
  cliente: { nome: '*TESTE CASA', telefone: null, cpf: null }, modalidade: 'retirada', entrega: null,
  itens: [{ cdproduto: '1201', descricao: 'CERVEJA', quantidade: 2, valorUnitario: 5, total: 10, idpreco: null }],
  frete: null, desconto: 0, subtotal: 10, total: 10, observacao: `PEDIDO ZAPRUN #${id}`, nrOrcamento: null, idEmpresaErp: 1, vendedor: '1',
  ...extra
});

async function colunaExiste(tabela, coluna) {
  const [l] = await executar(
    'SELECT COUNT(*) AS Q FROM RDB$RELATION_FIELDS WHERE TRIM(RDB$RELATION_NAME) = ? AND TRIM(RDB$FIELD_NAME) = ?',
    [tabela, coluna]
  );
  return Number(l.q) > 0;
}

async function limpar(extra = []) {
  const nrs = [7400, ...extra].join(', ');
  await executar(`DELETE FROM ORCPROD WHERE IDEMPRESA = 1 AND (NRORCAMENTO BETWEEN 7200 AND 7211 OR NRORCAMENTO IN (${nrs}))`);
  await executar(`DELETE FROM ORCAMENTO WHERE IDEMPRESA = 1 AND (NRORCAMENTO BETWEEN 7200 AND 7211 OR NRORCAMENTO IN (${nrs}))`);
}

(async () => {
  const [emp] = await executar('SELECT CAST(NOMEEMPRESA AS VARCHAR(60) CHARACTER SET OCTETS) AS N FROM CONFIGURACAO WHERE IDEMPRESA = 1');
  assert.strictEqual(fixEncoding(emp && emp.n).trim(), 'LOJA DE TESTE', 'banco não é o de teste — abortado');

  for (const [t, c, tipo] of [['ORCAMENTO', 'TIPOORC', 'CHAR(1)'], ['ORCAMENTO', 'CDUSUARIO', 'INTEGER'], ['ORCAMENTO', 'DTVALIDADE', 'DATE'], ['ORCPROD', 'FLAGX', 'SMALLINT']]) {
    if (!(await colunaExiste(t, c))) await executar(`ALTER TABLE ${t} ADD ${c} ${tipo}`);
  }
  await limpar();
  for (let i = 0; i < 12; i++) {
    const nr = 7200 + i;
    await executar(
      `INSERT INTO ORCAMENTO (NRORCAMENTO, IDEMPRESA, CDCLIENTE, DTORC, STATUS, CLIENTE, TIPOORC, CDUSUARIO, DTVALIDADE)
       VALUES (?, 1, 1, ?, 1, ?, 'O', 3, ?)`,
      [nr, new Date(2026, 10, 1 + i), `*CASA ${i}`, new Date(2026, 10, 8 + i)]
    );
    await executar(
      `INSERT INTO ORCPROD (POSIC, NRORCAMENTO, IDEMPRESA, CDPRODUTO, QTDPRODUTO, VLUNIT, TOTAL, STATUS, ORDEM, FLAGX, CALC, QTDELIB, QTDEPECA)
       VALUES (1, ?, 1, '1201', 1, 1, 1, 'FF', 'A', 1, 1, 1, 1)`,
      [nr]
    );
  }
  // Orçamento gravado por um Motor antigo, sem os campos da casa.
  await executar("INSERT INTO ORCAMENTO (NRORCAMENTO, IDEMPRESA, CDCLIENTE, DTORC, STATUS, CLIENTE, ZR_PEDIDO) VALUES (7400, 1, 1, '2026-11-20', 0, '*ANTIGO', 910001)");
  orc.esquecerCaches();
  let criado = null;
  try {
    const antes = (await orc.compararComACasa(cfg, 7400)).faltando.filter(f => f.tabela === 'ORCAMENTO').map(f => f.coluna).sort();
    console.log('faltando no antigo:', antes);
    assert.deepStrictEqual(antes, ['CDUSUARIO', 'DTVALIDADE', 'TIPOORC']);

    const r1 = await orc.sincronizarPedido(ped(910002), cfg, 'gravar');
    criado = r1.nrOrcamento;
    const [o1] = await executar('SELECT DTORC, DTVALIDADE, TIPOORC, CDUSUARIO FROM ORCAMENTO WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [criado]);
    const [i1] = await executar('SELECT FLAGX FROM ORCPROD WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [criado]);
    console.log('novo:', criado, JSON.stringify({ ...o1, ...i1 }));
    assert.strictEqual(String(o1.tipoorc).trim(), 'O');
    assert.strictEqual(o1.cdusuario, 3);
    assert.strictEqual(Math.round((o1.dtvalidade - o1.dtorc) / 86400000), 7, 'validade = data + 7, como a casa');
    assert.strictEqual(i1.flagx, 1);

    const r2 = await orc.sincronizarPedido(ped(910001, { nrOrcamento: 7400 }), cfg, 'gravar');
    assert.strictEqual(r2.acao, 'atualizado');
    const depois = (await orc.compararComACasa(cfg, 7400)).faltando.filter(f => f.tabela === 'ORCAMENTO');
    console.log('faltando no antigo depois do Reenviar:', depois);
    assert.deepStrictEqual(depois, []);
    console.log('\nOK — cópia da casa, prazo de data e conserto do antigo.');
  } finally {
    await limpar(criado ? [criado] : []);
    orc.esquecerCaches();
  }
  process.exit(0);
})().catch(err => {
  console.error('FALHOU:', err);
  process.exit(1);
});
