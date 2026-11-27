// tools/fb-teste/testar-multiempresa.js
// ERP com várias empresas: o cadastro de clientes é um só, e IDEMPRESA é a loja
// onde o cliente foi cadastrado. O CLIENTE BALCAO (1) está na empresa 1; até a
// v1.3.14 quem configurava outra empresa (Zé Grande, 4) recebia "O cliente 1 não
// existe no ERP" e nenhum pedido virava orçamento.
// Monta e desmonta os próprios dados no banco de TESTE.
//
//   FB_PORT=3055 FB_DATABASE=/firebird/data/automec.fdb node tools/fb-teste/testar-multiempresa.js

process.env.FB_HOST = process.env.FB_HOST || '127.0.0.1';
process.env.FB_PORT = process.env.FB_PORT || '3055';
process.env.FB_DATABASE = process.env.FB_DATABASE || '/firebird/data/automec.fdb';

const assert = require('node:assert');
const path = require('path');
const orc = require(path.join(__dirname, '../../backend/src/motor/erp/automec-orcamento'));
const { executar } = require(path.join(__dirname, '../../backend/src/motor/firebirdEscrita'));
const { fixEncoding } = require(path.join(__dirname, '../../backend/src/motor/encoding'));

const LOJA = 4;
const PEDIDO_ID = 980001;
const NUMERO = 81;

const cfg = { idEmpresaErp: LOJA, cdClienteErp: 1, cdVendedorPadrao: '1', cdProdutoFrete: '90', extras: null };

const pedido = () => ({
  pedidoId: PEDIDO_ID, numero: NUMERO, criadoEm: new Date().toISOString(), versao: 'v', hash: 'h', cancelado: false,
  cliente: { nome: '*CLIENTE DA LOJA 4', telefone: null, cpf: null }, modalidade: 'retirada', entrega: null,
  itens: [{ cdproduto: '1201', descricao: 'CERVEJA', quantidade: 1, valorUnitario: 5, total: 5, idpreco: null }],
  frete: null, desconto: 0, subtotal: 5, total: 5, observacao: `PEDIDO ZAPRUN NÚMERO = ${NUMERO}`, nrOrcamento: null,
  idEmpresaErp: LOJA, vendedor: '1'
});

async function limpar() {
  await executar('DELETE FROM ORCPROD WHERE IDEMPRESA = ?', [LOJA]);
  await executar('DELETE FROM ORCAMENTO WHERE IDEMPRESA = ?', [LOJA]);
  await executar('DELETE FROM CONFIGURACAO WHERE IDEMPRESA = ?', [LOJA]);
}

(async () => {
  const [emp] = await executar("SELECT CAST(NOMEEMPRESA AS VARCHAR(60) CHARACTER SET OCTETS) AS N FROM CONFIGURACAO WHERE IDEMPRESA = 1");
  assert.strictEqual(fixEncoding(emp && emp.n).trim(), 'LOJA DE TESTE', 'banco não é o de teste — abortado');
  const [daLoja] = await executar('SELECT COUNT(*) AS Q FROM CLIENTE WHERE CDCLIENTE = 1 AND IDEMPRESA = ?', [LOJA]);
  assert.strictEqual(Number(daLoja.q), 0, 'o cenário exige o balcão cadastrado só na empresa 1');

  await limpar();
  await executar("INSERT INTO CONFIGURACAO (IDEMPRESA, CNPJ, NOMEEMPRESA) VALUES (?, '12345678000400', 'LOJA DE TESTE 4')", [LOJA]);
  try {
    // 1. O balcão cadastrado na 1 vale para a 4.
    let r = await orc.sincronizarPedido(pedido(), cfg, 'gravar');
    console.log('gravar na empresa 4:', r.acao, r.nrOrcamento, r.erro || '');
    assert.strictEqual(r.acao, 'criado', r.erro);
    const [o] = await executar('SELECT IDEMPRESA, CDCLIENTE FROM ORCAMENTO WHERE NRORCAMENTO = ? AND IDEMPRESA = ?', [r.nrOrcamento, LOJA]);
    assert.strictEqual(o.cdcliente, 1);

    // 2. Cliente que não está em empresa nenhuma continua barrado.
    r = await orc.sincronizarPedido(pedido(), { ...cfg, cdClienteErp: 99999 }, 'gravar');
    console.log('cliente inexistente:', r.acao, r.erro);
    assert.strictEqual(r.acao, 'erro');
    assert.match(r.erro, /cliente 99999 não existe/);

    console.log('\nOK — multiempresa.');
  } finally {
    await limpar();
  }
  process.exit(0);
})().catch(err => {
  console.error('FALHOU:', err);
  process.exit(1);
});
