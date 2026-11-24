// tools/fb-teste/testar-historico.js
// O orçamento do Motor entra na aba "Histórico" do Automec (v1.3.9), como o
// da casa: SIS_APPHISTORY via SP_ADDHISTORY, TIPO 1 na inclusão e 2 na
// alteração/cancelamento, CONTEXTO 'NRORCAMENTO=n;IDEMPRESA=e;', MENSAGEM com
// as colunas. Confere também que o histórico nunca derruba o orçamento, e que
// CALC = valor unitário. Monta e desmonta os próprios dados no banco de TESTE.
//
//   FB_PORT=3055 FB_DATABASE=/firebird/data/automec.fdb node tools/fb-teste/testar-historico.js

process.env.FB_HOST = process.env.FB_HOST || '127.0.0.1';
process.env.FB_PORT = process.env.FB_PORT || '3055';
process.env.FB_DATABASE = process.env.FB_DATABASE || '/firebird/data/automec.fdb';

const assert = require('node:assert');
const path = require('path');
const orc = require(path.join(__dirname, '../../backend/src/motor/erp/automec-orcamento'));
const { executar } = require(path.join(__dirname, '../../backend/src/motor/firebirdEscrita'));
const { fixEncoding } = require(path.join(__dirname, '../../backend/src/motor/encoding'));

const cfg = { idEmpresaErp: 1, cdClienteErp: 1, cdVendedorPadrao: '1', cdProdutoFrete: '90', extras: null };
const IDS = [940001, 940002, 940003, 940004];

const ped = (id, extra = {}) => ({
  pedidoId: id, numero: id, criadoEm: new Date().toISOString(), versao: 'v', hash: 'h', cancelado: false,
  cliente: { nome: '*CLIENTE HISTÓRICO', telefone: '83999990000', cpf: null }, modalidade: 'entrega',
  entrega: { logradouro: 'RUA A, 1', complemento: null, bairro: 'CENTRO', cidade: 'JOAO PESSOA', uf: 'PB', cep: '58000000' },
  itens: [{ cdproduto: '1201', descricao: 'CERVEJA', quantidade: 2, valorUnitario: 9.95, total: 19.9, idpreco: null }],
  frete: null, desconto: 0, subtotal: 19.9, total: 19.9, observacao: `PEDIDO ZAPRUN NÚMERO = ${id}`, nrOrcamento: null, idEmpresaErp: 1, vendedor: '1',
  ...extra
});

async function existeObjeto(sql, nome) {
  const [l] = await executar(sql, [nome]);
  return Number(l.q) > 0;
}
const tabelaExiste = n => existeObjeto('SELECT COUNT(*) AS Q FROM RDB$RELATIONS WHERE TRIM(RDB$RELATION_NAME) = ?', n);
const procExiste = n => existeObjeto('SELECT COUNT(*) AS Q FROM RDB$PROCEDURES WHERE TRIM(RDB$PROCEDURE_NAME) = ?', n);
const geradorExiste = n => existeObjeto('SELECT COUNT(*) AS Q FROM RDB$GENERATORS WHERE TRIM(RDB$GENERATOR_NAME) = ?', n);
const gatilhoExiste = n => existeObjeto('SELECT COUNT(*) AS Q FROM RDB$TRIGGERS WHERE TRIM(RDB$TRIGGER_NAME) = ?', n);

async function historicoDe(nr) {
  const linhas = await executar(
    `SELECT ID, IDMENUITEM, TIPO, CAST(CONTEXTO AS VARCHAR(50) CHARACTER SET OCTETS) AS CONTEXTO,
            CAST(MENSAGEM AS VARCHAR(80) CHARACTER SET OCTETS) AS MENSAGEM, IDUSUARIO, DATA_HORA
       FROM SIS_APPHISTORY WHERE CONTEXTO = ? ORDER BY ID`,
    [`NRORCAMENTO=${nr};IDEMPRESA=1;`]
  );
  return linhas.map(l => ({ ...l, contexto: fixEncoding(l.contexto).trim(), mensagem: fixEncoding(l.mensagem || '').trim() }));
}

async function criarProcedure() {
  // Firebird 2.5 aceita SUSPEND sem RETURNS (é assim no Automec da JPR); do 3
  // em diante, não — lá a procedure de teste vai sem o SUSPEND.
  const corpo = suspend => `CREATE PROCEDURE SP_ADDHISTORY (IDMENUITEM INTEGER, TIPO INTEGER, CONTEXTO VARCHAR(50), MENSAGEM VARCHAR(80), IDUSUARIO INTEGER)
    AS BEGIN INSERT INTO SIS_APPHISTORY (IDMENUITEM, TIPO, CONTEXTO, MENSAGEM, IDUSUARIO) VALUES (:IDMENUITEM, :TIPO, :CONTEXTO, :MENSAGEM, :IDUSUARIO);${suspend ? ' SUSPEND;' : ''} END`;
  try {
    await executar(corpo(true));
    return 'com SUSPEND';
  } catch (err) {
    await executar(corpo(false));
    return 'sem SUSPEND';
  }
}

async function limpar() {
  const nrs = await executar(
    `SELECT NRORCAMENTO FROM ORCAMENTO WHERE IDEMPRESA = 1 AND ZR_PEDIDO IN (${IDS.join(', ')})`
  ).catch(() => []);
  for (const { nrorcamento } of nrs) {
    await executar('DELETE FROM ORCPROD WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [nrorcamento]);
    await executar('DELETE FROM ORCAMENTO WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [nrorcamento]);
  }
  if (await tabelaExiste('SIS_APPHISTORY')) await executar('DELETE FROM SIS_APPHISTORY');
}

(async () => {
  const [emp] = await executar('SELECT CAST(NOMEEMPRESA AS VARCHAR(60) CHARACTER SET OCTETS) AS N FROM CONFIGURACAO WHERE IDEMPRESA = 1');
  assert.strictEqual(fixEncoding(emp && emp.n).trim(), 'LOJA DE TESTE', 'banco não é o de teste — abortado');

  // A coluna ZR_PEDIDO (o Motor cria em modo Gravar).
  await orc.garantirColunaZr('gravar');
  // Tabela do histórico como a do Automec da JPR; ID e DATA_HORA pelo banco.
  if (!(await tabelaExiste('SIS_APPHISTORY'))) {
    await executar(`CREATE TABLE SIS_APPHISTORY (ID INTEGER NOT NULL PRIMARY KEY, IDMENUITEM INTEGER, TIPO INTEGER,
      CONTEXTO VARCHAR(50), MENSAGEM VARCHAR(80), IDUSUARIO INTEGER, DATA_HORA TIMESTAMP, DTALTER TIMESTAMP, SIST_ALT VARCHAR(7))`);
  }
  if (!(await geradorExiste('GEN_SIS_APPHISTORY'))) await executar('CREATE GENERATOR GEN_SIS_APPHISTORY');
  if (!(await gatilhoExiste('TG_SIS_APPHISTORY'))) {
    await executar(`CREATE TRIGGER TG_SIS_APPHISTORY FOR SIS_APPHISTORY ACTIVE BEFORE INSERT POSITION 0 AS
      BEGIN IF (NEW.ID IS NULL) THEN NEW.ID = GEN_ID(GEN_SIS_APPHISTORY, 1); IF (NEW.DATA_HORA IS NULL) THEN NEW.DATA_HORA = CURRENT_TIMESTAMP; END`);
  }
  await executar('ALTER TRIGGER TG_SIS_APPHISTORY ACTIVE');
  if (await procExiste('SP_ADDHISTORY')) await executar('DROP PROCEDURE SP_ADDHISTORY');
  await limpar();

  try {
    // 1. A casa nunca gravou histórico de orçamento: o Motor não inventa a tela.
    orc.esquecerCaches();
    let r = await orc.sincronizarPedido(ped(IDS[0]), cfg, 'gravar');
    assert.strictEqual(r.acao, 'criado', r.erro);
    const nrSemRef = r.nrOrcamento;
    assert.strictEqual((await historicoDe(nrSemRef)).length, 0, 'gravou histórico sem referência da casa');
    let rel = await orc.relatorio(cfg);
    console.log('sem referência:', rel.historicoAutomec);
    assert.strictEqual(rel.historicoAutomec.modo, null);
    assert.match(rel.historicoAutomec.motivo, /nunca gravou/);

    // 2. Com uma linha da casa (tela 15) e SEM a procedure: INSERT direto.
    await executar("INSERT INTO SIS_APPHISTORY (IDMENUITEM, TIPO, CONTEXTO, MENSAGEM, IDUSUARIO) VALUES (16, 1, 'NRPEDIDO=10;IDEMPRESA=1;', 'X;', 4)");
    await executar("INSERT INTO SIS_APPHISTORY (IDMENUITEM, TIPO, CONTEXTO, MENSAGEM, IDUSUARIO) VALUES (15, 1, 'NRORCAMENTO=7300;IDEMPRESA=1;', 'CDVENDEDOR;CLIENTE;', 4)");
    orc.esquecerCaches();
    r = await orc.sincronizarPedido(ped(IDS[1]), cfg, 'gravar');
    assert.strictEqual(r.acao, 'criado', r.erro);
    const nr = r.nrOrcamento;
    let h = await historicoDe(nr);
    console.log('inclusão (INSERT direto):', h.map(x => [x.tipo, x.idmenuitem, x.idusuario, x.mensagem]), r.avisos);
    assert.strictEqual(h.length, 1);
    assert.strictEqual(h[0].tipo, 1);
    assert.strictEqual(h[0].idmenuitem, 15, 'a tela de orçamento da casa, não a de pedido');
    assert.strictEqual(h[0].idusuario, 1, 'usuário 1 (decisão do dono)');
    assert.ok(h[0].data_hora instanceof Date, 'DATA_HORA pelo banco');
    assert.match(h[0].mensagem, /^CDVENDEDOR;CLIENTE;CDMUNICIPIO;VLTOTAL;IDENDERECO;CDPROPAGANDA;CDCLIENTE;BAIRRO;/);
    assert.ok(h[0].mensagem.length <= 80);
    assert.ok(!/NRORCAMENTO|ZR_PEDIDO/.test(h[0].mensagem), 'chave e ZR_PEDIDO fora da mensagem');

    // CALC = valor unitário (o dono, 23/11).
    const itens = await executar('SELECT CALC, VLUNIT FROM ORCPROD WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [nr]);
    assert.deepStrictEqual(itens.map(i => Number(i.calc)), [9.95], 'CALC = VLUNIT');

    // 3. Com a procedure do Automec: EXECUTE PROCEDURE.
    console.log('procedure de teste:', await criarProcedure());
    orc.esquecerCaches();
    rel = await orc.relatorio(cfg);
    console.log('relatório:', rel.historicoAutomec);
    assert.strictEqual(rel.historicoAutomec.modo, 'procedure');
    assert.strictEqual(rel.historicoAutomec.idMenuItem, 15);

    // Alteração de quantidade, com o usuário trocado pelo servidor (extras).
    const cfgUsuario = { ...cfg, extras: { HISTORICO: { IDUSUARIO: 9 } } };
    r = await orc.sincronizarPedido(
      ped(IDS[1], { nrOrcamento: nr, itens: [{ cdproduto: '1201', descricao: 'CERVEJA', quantidade: 3, valorUnitario: 9.95, total: 29.85, idpreco: null }], subtotal: 29.85, total: 29.85 }),
      cfgUsuario,
      'gravar'
    );
    assert.strictEqual(r.acao, 'atualizado', r.erro);
    h = await historicoDe(nr);
    console.log('alteração (procedure):', h.slice(1).map(x => [x.tipo, x.idusuario, x.mensagem]), r.avisos);
    assert.strictEqual(h.length, 2);
    assert.strictEqual(h[1].tipo, 2);
    assert.strictEqual(h[1].idusuario, 9);
    assert.strictEqual(h[1].mensagem, 'VLTOTAL;SUBTOTAL;', 'só o que mudou');

    // 4. Reenviar sem mudança: conserta o orçamento, mas não é alteração.
    r = await orc.sincronizarPedido(
      ped(IDS[1], { nrOrcamento: nr, itens: [{ cdproduto: '1201', descricao: 'CERVEJA', quantidade: 3, valorUnitario: 9.95, total: 29.85, idpreco: null }], subtotal: 29.85, total: 29.85 }),
      cfg,
      'gravar'
    );
    assert.strictEqual(r.acao, 'atualizado');
    assert.strictEqual((await historicoDe(nr)).length, 2, 'reenvio igual gravou histórico');

    // 5. Troca de item com o mesmo total: ITENS.
    r = await orc.sincronizarPedido(
      ped(IDS[1], { nrOrcamento: nr, itens: [{ cdproduto: '88', descricao: 'CARVÃO', quantidade: 1, valorUnitario: 29.85, total: 29.85, idpreco: null }], subtotal: 29.85, total: 29.85 }),
      cfg,
      'gravar'
    );
    h = await historicoDe(nr);
    console.log('troca de item:', h[h.length - 1].mensagem);
    assert.strictEqual(h.length, 3);
    assert.strictEqual(h[2].mensagem, 'ITENS;');

    // 6. Mudou o nome e a observação.
    r = await orc.sincronizarPedido(
      ped(IDS[1], { nrOrcamento: nr, cliente: { nome: '*OUTRO NOME', telefone: '83999990000', cpf: null }, observacao: 'OBS NOVA',
        itens: [{ cdproduto: '88', descricao: 'CARVÃO', quantidade: 1, valorUnitario: 29.85, total: 29.85, idpreco: null }], subtotal: 29.85, total: 29.85 }),
      cfg,
      'gravar'
    );
    h = await historicoDe(nr);
    assert.strictEqual(h[h.length - 1].mensagem, 'CLIENTE;OBSERVACAO;');

    // 7. Cancelado no ZapRun: alteração do STATUS.
    r = await orc.sincronizarPedido(ped(IDS[1], { nrOrcamento: nr, cancelado: true }), cfg, 'gravar');
    assert.strictEqual(r.acao, 'cancelado');
    h = await historicoDe(nr);
    assert.deepStrictEqual([h[h.length - 1].tipo, h[h.length - 1].mensagem], [2, 'STATUS;']);

    // 8. Ensaio não deixa histórico.
    const [{ q: antesEnsaio }] = await executar('SELECT COUNT(*) AS Q FROM SIS_APPHISTORY');
    r = await orc.sincronizarPedido(ped(IDS[2]), cfg, 'ensaio');
    assert.strictEqual(r.acao, 'criado');
    const [{ q: depoisEnsaio }] = await executar('SELECT COUNT(*) AS Q FROM SIS_APPHISTORY');
    assert.strictEqual(Number(depoisEnsaio), Number(antesEnsaio), 'ensaio deixou histórico');

    // 9. Histórico que falha não derruba o orçamento: sem o gatilho, ID nulo.
    await executar('ALTER TRIGGER TG_SIS_APPHISTORY INACTIVE');
    orc.esquecerCaches();
    r = await orc.sincronizarPedido(ped(IDS[3]), cfg, 'gravar');
    console.log('histórico falhando:', r.acao, r.nrOrcamento, r.avisos);
    assert.strictEqual(r.acao, 'criado', r.erro);
    assert.ok(r.avisos.some(a => /Histórico do Automec não gravado/.test(a)), 'falha do histórico sem aviso');
    const [o] = await executar('SELECT COUNT(*) AS Q FROM ORCAMENTO WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [r.nrOrcamento]);
    assert.strictEqual(Number(o.q), 1, 'orçamento sumiu junto com o histórico');
    const [i] = await executar('SELECT COUNT(*) AS Q FROM ORCPROD WHERE NRORCAMENTO = ? AND IDEMPRESA = 1', [r.nrOrcamento]);
    assert.strictEqual(Number(i.q), 1);
    await executar('ALTER TRIGGER TG_SIS_APPHISTORY ACTIVE');

    // 10. Desligado pelo servidor.
    orc.esquecerCaches();
    rel = await orc.relatorio({ ...cfg, extras: { HISTORICO: { desligado: true } } });
    assert.strictEqual(rel.historicoAutomec.modo, null);
    assert.match(rel.historicoAutomec.motivo, /desligado/);

    console.log('\nOK — histórico como o da casa.');
  } finally {
    await executar('ALTER TRIGGER TG_SIS_APPHISTORY ACTIVE').catch(() => {});
    await limpar();
  }
  process.exit(0);
})().catch(err => {
  console.error('FALHOU:', err);
  process.exit(1);
});
