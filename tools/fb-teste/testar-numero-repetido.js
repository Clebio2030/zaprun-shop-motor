// tools/fb-teste/testar-numero-repetido.js
// O número do pedido na Loja se repete: é MAX+1 dos pedidos que existem, e
// excluir o último pedido devolve o número ao próximo. Com ZR_PEDIDO = número
// (v1.3.12), o pedido novo achava pela coluna o orçamento do pedido excluído:
// ficava "travado" no orçamento cancelado, ou regravava o do outro por cima.
// Confere a v1.3.13, que só aceita o orçamento gravado na hora em que ESTE
// pedido nasceu, e que segue sem duplicar quando o servidor perde o número.
// Monta e desmonta os próprios dados no banco de TESTE.
//
//   FB_PORT=3055 FB_DATABASE=/firebird/data/automec.fdb node tools/fb-teste/testar-numero-repetido.js

process.env.FB_HOST = process.env.FB_HOST || '127.0.0.1';
process.env.FB_PORT = process.env.FB_PORT || '3055';
process.env.FB_DATABASE = process.env.FB_DATABASE || '/firebird/data/automec.fdb';

const assert = require('node:assert');
const path = require('path');
const orc = require(path.join(__dirname, '../../backend/src/motor/erp/automec-orcamento'));
const { executar } = require(path.join(__dirname, '../../backend/src/motor/firebirdEscrita'));
const { fixEncoding } = require(path.join(__dirname, '../../backend/src/motor/encoding'));

const cfg = { idEmpresaErp: 1, cdClienteErp: 1, cdVendedorPadrao: '1', cdProdutoFrete: '90', extras: null };
const IDS = [970001, 970002, 970003, 970004, 970005, 970006];
const NUMEROS = [77, 78, 79, 80];

const ped = (pedidoId, numero, minutosAtras, extra = {}) => ({
  pedidoId, numero, criadoEm: new Date(Date.now() - minutosAtras * 60000).toISOString(), versao: 'v', hash: 'h', cancelado: false,
  cliente: { nome: `*CLIENTE ${pedidoId}`, telefone: null, cpf: null }, modalidade: 'retirada', entrega: null,
  itens: [{ cdproduto: '1201', descricao: 'CERVEJA', quantidade: 1, valorUnitario: 5, total: 5, idpreco: null }],
  frete: null, desconto: 0, subtotal: 5, total: 5, observacao: `PEDIDO ZAPRUN NÚMERO = ${numero}`, nrOrcamento: null, idEmpresaErp: 1, vendedor: '1',
  ...extra
});

async function orcamento(nr) {
  const [o] = await executar(
    'SELECT STATUS, ZR_PEDIDO, CAST(CLIENTE AS VARCHAR(100) CHARACTER SET OCTETS) AS CLIENTE FROM ORCAMENTO WHERE NRORCAMENTO = ? AND IDEMPRESA = 1',
    [nr]
  );
  return o ? { status: o.status, zr: o.zr_pedido, cliente: fixEncoding(o.cliente).trim() } : null;
}

async function contar() {
  const [c] = await executar(`SELECT COUNT(*) AS Q FROM ORCAMENTO WHERE IDEMPRESA = 1 AND ZR_PEDIDO IN (${[...NUMEROS, ...IDS].join(', ')})`);
  return Number(c.q);
}

async function limpar() {
  const nrs = await executar(`SELECT NRORCAMENTO FROM ORCAMENTO WHERE IDEMPRESA = 1 AND ZR_PEDIDO IN (${[...NUMEROS, ...IDS].join(', ')})`);
  for (const { nrorcamento } of nrs) {
    await executar('DELETE FROM ORCPROD WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [nrorcamento]);
    await executar('DELETE FROM ORCAMENTO WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [nrorcamento]);
    await executar('DELETE FROM SIS_APPHISTORY WHERE CONTEXTO = ?', [`NRORCAMENTO=${nrorcamento};IDEMPRESA=1;`]).catch(() => {});
  }
}

(async () => {
  const [emp] = await executar('SELECT CAST(NOMEEMPRESA AS VARCHAR(60) CHARACTER SET OCTETS) AS N FROM CONFIGURACAO WHERE IDEMPRESA = 1');
  assert.strictEqual(fixEncoding(emp && emp.n).trim(), 'LOJA DE TESTE', 'banco não é o de teste — abortado');
  await orc.garantirColunaZr('gravar');
  orc.esquecerCaches();
  await limpar();
  try {
    // 1. Pedido #77 vai ao ERP e é EXCLUÍDO (orçamento cancelado); o próximo
    //    pedido nasce de novo com o #77.
    const a = await orc.sincronizarPedido(ped(IDS[0], 77, 30), cfg, 'gravar');
    assert.strictEqual(a.acao, 'criado', a.erro);
    const aCancel = await orc.sincronizarPedido(ped(IDS[0], 77, 30, { nrOrcamento: a.nrOrcamento, cancelado: true }), cfg, 'gravar');
    assert.strictEqual(aCancel.acao, 'cancelado');
    const b = await orc.sincronizarPedido(ped(IDS[1], 77, 1), cfg, 'gravar');
    console.log('número reaproveitado depois de excluir:', a.nrOrcamento, '→', b.acao, b.nrOrcamento);
    assert.strictEqual(b.acao, 'criado', `o pedido novo #77 ficou "${b.acao}" no orçamento ${b.nrOrcamento} do excluído`);
    assert.notStrictEqual(b.nrOrcamento, a.nrOrcamento);
    assert.strictEqual((await orcamento(a.nrOrcamento)).status, 2, 'o do excluído continua cancelado');
    assert.strictEqual((await orcamento(b.nrOrcamento)).zr, 77, 'ZR_PEDIDO segue com o número da Loja');

    // 2. #78 foi ao ERP; foi excluído e outro #78 nasceu ANTES de o Motor
    //    processar o cancelamento (Motor desligado, pausa, internet fora).
    const c = await orc.sincronizarPedido(ped(IDS[2], 78, 30), cfg, 'gravar');
    const d = await orc.sincronizarPedido(ped(IDS[3], 78, 1, { cliente: { nome: '*OUTRO CLIENTE', telefone: null, cpf: null } }), cfg, 'gravar');
    const cCancel = await orc.sincronizarPedido(ped(IDS[2], 78, 30, { nrOrcamento: c.nrOrcamento, cancelado: true }), cfg, 'gravar');
    const oc = await orcamento(c.nrOrcamento);
    const od = d.nrOrcamento ? await orcamento(d.nrOrcamento) : null;
    console.log('outro #78 antes do cancelamento:', c.nrOrcamento, oc, '|', d.acao, d.nrOrcamento, od, '| exclusão:', cCancel.acao);
    assert.strictEqual(d.acao, 'criado', 'o #78 novo regravou o orçamento do outro');
    assert.strictEqual(oc.cliente, `*CLIENTE ${IDS[2]}`, 'o orçamento do excluído não foi regravado');
    assert.strictEqual(oc.status, 2);
    assert.strictEqual(od.status, 0, 'o do pedido novo ficou aberto');
    assert.strictEqual(od.cliente, '*OUTRO CLIENTE');

    // 3. O servidor perdeu o número do orçamento (resultado não chegou): acha
    //    o PRÓPRIO pela coluna e não duplica.
    const e = ped(IDS[4], 79, 5);
    const e1 = await orc.sincronizarPedido(e, cfg, 'gravar');
    const antes = await contar();
    const e2 = await orc.sincronizarPedido({ ...e, hash: 'h2' }, cfg, 'gravar');
    console.log('resultado perdido:', e1.nrOrcamento, '→', e2.acao, e2.nrOrcamento);
    assert.strictEqual(e2.acao, 'atualizado');
    assert.strictEqual(e2.nrOrcamento, e1.nrOrcamento);
    assert.strictEqual(await contar(), antes, 'duplicou');
    // HORAORC gravado é a hora local do pedido, exata (até a v1.3.12 ia 28 s
    // adiantado no zero de 1899).
    const [hr] = await executar('SELECT CAST(HORAORC AS VARCHAR(30)) AS H FROM ORCAMENTO WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [e1.nrOrcamento]);
    const q = new Date(e.criadoEm);
    const esperado = [q.getHours(), q.getMinutes(), q.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    console.log('HORAORC gravado:', String(hr.h).trim(), '| hora do pedido:', esperado);
    assert.ok(String(hr.h).includes(` ${esperado}`), `HORAORC ${hr.h} ≠ ${esperado}`);

    // 4. Orçamento de até a v1.3.11 (ZR_PEDIDO = pedidoId) com o resultado
    //    perdido: também é achado, e não duplica.
    const f = ped(IDS[5], 80, 5);
    const f1 = await orc.sincronizarPedido(f, cfg, 'gravar');
    await executar('UPDATE ORCAMENTO SET ZR_PEDIDO = ? WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [IDS[5], f1.nrOrcamento]);
    const f2 = await orc.sincronizarPedido({ ...f, hash: 'h2' }, cfg, 'gravar');
    console.log('legado (ZR = pedidoId):', f1.nrOrcamento, '→', f2.acao, f2.nrOrcamento);
    assert.strictEqual(f2.acao, 'atualizado');
    assert.strictEqual(f2.nrOrcamento, f1.nrOrcamento);

    console.log('\nOK — número repetido não pega orçamento de outro pedido, e o resultado perdido não duplica.');
  } finally {
    await limpar();
    orc.esquecerCaches();
  }
  process.exit(0);
})().catch(err => {
  console.error('FALHOU:', err);
  process.exit(1);
});
