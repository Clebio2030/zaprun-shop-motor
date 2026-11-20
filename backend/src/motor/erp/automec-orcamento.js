// motor/erp/automec-orcamento.js
// Pedido da Loja → ORÇAMENTO no Automec (ADR-307 do ZapRun).
//
// O servidor manda o ESTADO DESEJADO do orçamento (itens, valores, cliente,
// entrega, observação). Aqui fica só o que depende do banco do cliente:
// colunas que existem e seus tamanhos, numeração, unidade/custo/depósito do
// produto, município, convenções de data e o encoding da escrita.
//
// Desenho tirado do srvPDV.Web da Pontual (que grava ORCAMENTO + ORCPROD no
// mesmo Automec) com UMA diferença de propósito: a Pontual grava com
// `UPDATE OR INSERT ... MATCHING (NRORCAMENTO, IDEMPRESA)`. Se o número
// colidir com um orçamento que o balcão acabou de criar, aquilo SOBRESCREVE o
// orçamento do balcão. Aqui é INSERT puro: colisão vira erro de chave, e o
// Motor numera de novo.
//
// A ligação pedido ↔ orçamento é a coluna ORCAMENTO.ZR_PEDIDO (o id do pedido
// no ZapRun), gravada na MESMA transação do orçamento: se a internet cair
// depois do commit e antes de o servidor saber o número, a próxima consulta
// acha o orçamento pela coluna e não cria outro.

const { comTransacao, executar, ehViolacaoDeUnicidade, ehTransitorio } = require('../firebirdEscrita');
const { textoParaErp, marcadorDeTexto, testarEscritaWin1252, paraBufferWin1252 } = require('../textoParaErp');
const { fixEncoding } = require('../encoding');
const { logWarn, logInfo } = require('../../logger');

const TABELAS = ['ORCAMENTO', 'ORCPROD', 'PRODUTO', 'PRODUTOPRECO', 'MUNICIPIO', 'VENDEDOR', 'CLIENTE', 'CONFIGURACAO'];
const COLUNA_ZR = 'ZR_PEDIDO';
const CACHE_SCHEMA_MS = 10 * 60 * 1000;
const CACHE_MUNICIPIO_MS = 24 * 60 * 60 * 1000;
const TENTATIVAS_NUMERACAO = 3;

const TIPO_TEXTO = new Set([14, 37]); // CHAR, VARCHAR
const TIPO_BLOB = 261;
const TIPO_DATA = 12;
const TIPO_HORA = 13;
const TIPO_TIMESTAMP = 35;

/** Erro de configuração/dado: não adianta tentar de novo até alguém mexer. */
class ErroDefinitivo extends Error {}

// ── Schema ───────────────────────────────────────────────────────────────────

/** @typedef {{ em: number, tabelas: Record<string, Record<string, any>>, chaves: Record<string, string[]> }} SchemaErp */

/** @type {SchemaErp | null} */
let _schema = null;

/** @returns {Promise<SchemaErp>} */
async function lerSchema(forcar = false) {
  if (!forcar && _schema && Date.now() - _schema.em < CACHE_SCHEMA_MS) return _schema;
  const marcas = TABELAS.map(() => '?').join(',');
  const linhas = await executar(
    `SELECT TRIM(rf.RDB$RELATION_NAME) AS T, TRIM(rf.RDB$FIELD_NAME) AS C,
            f.RDB$FIELD_TYPE AS TIPO, f.RDB$CHARACTER_LENGTH AS CHARS, f.RDB$FIELD_LENGTH AS BYTES,
            COALESCE(rf.RDB$NULL_FLAG, f.RDB$NULL_FLAG, 0) AS NAO_NULO,
            IIF(rf.RDB$DEFAULT_SOURCE IS NULL AND f.RDB$DEFAULT_SOURCE IS NULL, 0, 1) AS TEM_DEFAULT
       FROM RDB$RELATION_FIELDS rf
       JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
      WHERE TRIM(rf.RDB$RELATION_NAME) IN (${marcas})
      ORDER BY rf.RDB$RELATION_NAME, rf.RDB$FIELD_POSITION`,
    TABELAS
  );
  /** @type {Record<string, Record<string, any>>} */
  const tabelas = {};
  for (const t of TABELAS) tabelas[t] = {};
  for (const l of linhas) {
    const t = String(l.t).trim();
    const c = String(l.c).trim();
    const tipo = Number(l.tipo);
    tabelas[t][c] = {
      tipo,
      texto: TIPO_TEXTO.has(tipo),
      blob: tipo === TIPO_BLOB,
      tamanho: Number(l.chars) || Number(l.bytes) || null,
      obrigatorio: Number(l.nao_nulo) === 1 && Number(l.tem_default) === 0
    };
  }

  /** @type {Record<string, string[]>} */
  const chaves = {};
  const ks = await executar(
    `SELECT TRIM(rc.RDB$RELATION_NAME) AS T, TRIM(s.RDB$FIELD_NAME) AS C
       FROM RDB$RELATION_CONSTRAINTS rc
       JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
      WHERE TRIM(rc.RDB$RELATION_NAME) IN ('ORCAMENTO', 'ORCPROD')
        AND rc.RDB$CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
      ORDER BY s.RDB$FIELD_POSITION`
  );
  for (const k of ks) {
    const t = String(k.t).trim();
    (chaves[t] = chaves[t] || []).push(String(k.c).trim());
  }

  _schema = { em: Date.now(), tabelas, chaves };
  return _schema;
}

function existe(schema, tabela, coluna) {
  return !!(schema.tabelas[tabela] && schema.tabelas[tabela][coluna]);
}

// ── Montagem de SQL adaptada ao schema ───────────────────────────────────────

/**
 * Um valor para uma coluna, no formato que ela pede. Texto passa por
 * textoParaErp (WIN1252, tamanho real); BLOB de texto vai como Buffer WIN1252.
 * @returns {{ marca: string, param: any }}
 */
function valorDaColuna(def, valor, modoTexto) {
  if (def.texto) {
    if (valor === '') return { marca: '?', param: '' };
    const t = textoParaErp(valor, def.tamanho, modoTexto);
    return { marca: marcadorDeTexto(def.tamanho, modoTexto), param: t };
  }
  if (def.blob) {
    const t = textoParaErp(valor, null, modoTexto);
    return { marca: '?', param: t === null ? null : modoTexto === 'win1252' ? paraBufferWin1252(t) : t };
  }
  if (valor === '' || valor === undefined) return { marca: '?', param: null };
  return { marca: '?', param: valor };
}

/**
 * INSERT só com as colunas que existem neste Automec. As que faltam voltam em
 * `ausentes`, para o relatório — "a coluna X não existe aqui" é diagnóstico,
 * não erro.
 */
function montarInsert(schema, tabela, valores, modoTexto) {
  const colunas = [];
  const marcas = [];
  const params = [];
  const ausentes = [];
  for (const [coluna, valor] of Object.entries(valores)) {
    const def = schema.tabelas[tabela][coluna];
    if (!def) {
      ausentes.push(coluna);
      continue;
    }
    const v = valorDaColuna(def, valor, modoTexto);
    colunas.push(coluna);
    marcas.push(v.marca);
    params.push(v.param);
  }
  return {
    sql: `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${marcas.join(', ')})`,
    params,
    ausentes
  };
}

function montarUpdate(schema, tabela, valores, onde, paramsOnde, modoTexto) {
  const sets = [];
  const params = [];
  for (const [coluna, valor] of Object.entries(valores)) {
    const def = schema.tabelas[tabela][coluna];
    if (!def) continue;
    const v = valorDaColuna(def, valor, modoTexto);
    sets.push(`${coluna} = ${v.marca}`);
    params.push(v.param);
  }
  return { sql: `UPDATE ${tabela} SET ${sets.join(', ')} WHERE ${onde}`, params: [...params, ...paramsOnde] };
}

/** Colunas constantes vindas do servidor (calibração sem release). */
function aplicarExtras(valores, extras, modalidade) {
  if (!extras || typeof extras !== 'object') return valores;
  const saida = { ...valores };
  for (const [coluna, valor] of Object.entries(extras)) {
    if (!/^[A-Z0-9_$]{1,31}$/.test(coluna)) continue;
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      if (modalidade in valor) saida[coluna] = valor[modalidade];
      continue;
    }
    if (valor === null || ['string', 'number'].includes(typeof valor)) saida[coluna] = valor;
  }
  return saida;
}

// ── Datas no jeito do Automec ────────────────────────────────────────────────

/** @type {{ em: number, horaBase1899: boolean, dataComHora: boolean } | null} */
let _convencao = null;

async function lerConvencao(schema, idEmpresa) {
  if (_convencao && Date.now() - _convencao.em < CACHE_SCHEMA_MS) return _convencao;
  let horaBase1899 = true;
  let dataComHora = false;
  if (existe(schema, 'ORCAMENTO', 'HORAORC') || existe(schema, 'ORCAMENTO', 'DTORC')) {
    const cols = ['DTORC', 'HORAORC'].filter(c => existe(schema, 'ORCAMENTO', c)).join(', ');
    const [ultimo] = await executar(
      `SELECT FIRST 1 ${cols} FROM ORCAMENTO WHERE IDEMPRESA = ? ORDER BY NRORCAMENTO DESC`,
      [idEmpresa]
    );
    if (ultimo && ultimo.horaorc instanceof Date) horaBase1899 = ultimo.horaorc.getFullYear() < 1900;
    if (ultimo && ultimo.dtorc instanceof Date) {
      dataComHora = ultimo.dtorc.getHours() !== 0 || ultimo.dtorc.getMinutes() !== 0;
    }
  }
  _convencao = { em: Date.now(), horaBase1899, dataComHora };
  return _convencao;
}

function datasDoOrcamento(schema, criadoEm, convencao) {
  const quando = new Date(criadoEm);
  const def = schema.tabelas.ORCAMENTO;
  const meiaNoite = new Date(quando.getFullYear(), quando.getMonth(), quando.getDate());
  const dtorc = def.DTORC && def.DTORC.tipo === TIPO_TIMESTAMP && convencao.dataComHora ? quando : meiaNoite;
  let horaorc = quando;
  if (def.HORAORC && def.HORAORC.tipo === TIPO_TIMESTAMP && convencao.horaBase1899) {
    // O zero do TDateTime do Delphi: o Automec guarda só a hora em cima dele.
    horaorc = new Date(1899, 11, 30, quando.getHours(), quando.getMinutes(), quando.getSeconds());
  }
  return { DTORC: dtorc, HORAORC: horaorc };
}

// ── Município ────────────────────────────────────────────────────────────────

const _municipios = new Map();

const chaveDeNome = texto =>
  String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

async function codigoDoMunicipio(schema, cidade, uf) {
  if (!cidade || !uf || !existe(schema, 'MUNICIPIO', 'MUNICIPIO') || !existe(schema, 'MUNICIPIO', 'UF')) return null;
  const chaveUf = String(uf).toUpperCase();
  let cache = _municipios.get(chaveUf);
  if (!cache || Date.now() - cache.em > CACHE_MUNICIPIO_MS) {
    const linhas = await executar(
      'SELECT CDMUNICIPIO, CAST(MUNICIPIO AS VARCHAR(100) CHARACTER SET OCTETS) AS NOME FROM MUNICIPIO WHERE UF = ?',
      [chaveUf]
    );
    const mapa = new Map();
    for (const l of linhas) mapa.set(chaveDeNome(fixEncoding(l.nome)), l.cdmunicipio);
    cache = { em: Date.now(), mapa };
    _municipios.set(chaveUf, cache);
  }
  return cache.mapa.get(chaveDeNome(cidade)) ?? null;
}

// ── Produto ──────────────────────────────────────────────────────────────────

function paramDoProduto(schema, codigo) {
  const def = schema.tabelas.PRODUTO.CDPRODUTO;
  return def && def.texto ? String(codigo) : Number(codigo);
}

/** Unidade, depósito, tabela e custo do produto, como a Pontual lê. */
async function lerProduto(tx, schema, codigo) {
  const p = schema.tabelas.PRODUTO;
  const pp = schema.tabelas.PRODUTOPRECO;
  const un = p.CDUNIDVENDA && p.CDUNIDADE
    ? "COALESCE(NULLIF(TRIM(p.CDUNIDVENDA), ''), p.CDUNIDADE)"
    : p.CDUNIDADE ? 'p.CDUNIDADE' : 'NULL';
  const custo =
    pp.VLCUSTO && pp.CDPRODUTO && pp.IDPRECO && p.IDPRECO
      ? `(SELECT FIRST 1 pp.VLCUSTO FROM PRODUTOPRECO pp WHERE pp.CDPRODUTO = p.CDPRODUTO AND pp.IDPRECO = p.IDPRECO${
          pp.CDUNIDADE && un !== 'NULL' ? ` AND pp.CDUNIDADE = ${un}` : ''
        })`
      : 'NULL';
  const [linha] = await tx.query(
    `SELECT CAST(${un} AS VARCHAR(10) CHARACTER SET OCTETS) AS UNID,
            ${p.CDDEPOSITO ? 'p.CDDEPOSITO' : 'NULL'} AS CDDEPOSITO,
            ${p.IDPRECO ? 'p.IDPRECO' : 'NULL'} AS IDPRECO,
            ${custo} AS VLCUSTO
       FROM PRODUTO p WHERE p.CDPRODUTO = ?`,
    [paramDoProduto(schema, codigo)]
  );
  if (!linha) return null;
  return {
    unid: linha.unid === null || linha.unid === undefined ? null : fixEncoding(linha.unid).trim() || null,
    cddeposito: linha.cddeposito ?? null,
    idpreco: linha.idpreco ?? null,
    vlcusto: linha.vlcusto === null || linha.vlcusto === undefined ? 0 : Number(linha.vlcusto)
  };
}

// ── Coluna ZR_PEDIDO ─────────────────────────────────────────────────────────

/** Procedure ou trigger que insere em ORCAMENTO sem listar colunas quebraria com a coluna nova. */
async function insercoesPorPosicao() {
  const linhas = await executar(
    `SELECT TRIM(RDB$PROCEDURE_NAME) AS N FROM RDB$PROCEDURES
      WHERE RDB$PROCEDURE_SOURCE CONTAINING 'INTO ORCAMENTO VALUES'
         OR RDB$PROCEDURE_SOURCE CONTAINING 'INTO ORCAMENTO SELECT'
     UNION ALL
     SELECT TRIM(RDB$TRIGGER_NAME) FROM RDB$TRIGGERS
      WHERE RDB$TRIGGER_SOURCE CONTAINING 'INTO ORCAMENTO VALUES'
         OR RDB$TRIGGER_SOURCE CONTAINING 'INTO ORCAMENTO SELECT'`
  );
  return linhas.map(l => String(l.n).trim());
}

/**
 * Cria ORCAMENTO.ZR_PEDIDO quando falta — só em modo Gravar, nunca no boot da
 * frota. Nula, sem default e sem índice: no Firebird é só metadado, as linhas
 * que existem não são reescritas.
 */
async function garantirColunaZr(modo) {
  const schema = await lerSchema();
  if (existe(schema, 'ORCAMENTO', COLUNA_ZR)) return { ok: true, criadaAgora: false };
  if (modo !== 'gravar') return { ok: true, criadaAgora: false, pendente: true };

  const posicionais = await insercoesPorPosicao();
  if (posicionais.length) {
    throw new ErroDefinitivo(
      `Não criei a coluna ORCAMENTO.${COLUNA_ZR}: ${posicionais.join(', ')} grava em ORCAMENTO sem listar as colunas e quebraria. Fale com o suporte do ZapRun.`
    );
  }
  await executar(`ALTER TABLE ORCAMENTO ADD ${COLUNA_ZR} INTEGER`);
  await lerSchema(true);
  logInfo(`[Pedidos] Coluna ORCAMENTO.${COLUNA_ZR} criada no ERP.`);
  return { ok: true, criadaAgora: true };
}

// ── Validação da configuração ────────────────────────────────────────────────

/** @type {{ chave: string, em: number, resultado: any } | null} */
let _validacao = null;

async function nomeDe(sql, params) {
  const [l] = await executar(sql, params);
  if (!l) return null;
  return fixEncoding(l.nome).trim() || '(sem nome)';
}

/**
 * Os códigos configurados no painel existem neste ERP? Devolve os nomes, que é
 * o que o painel mostra ("Vendedor 1 = LOJA VIRTUAL") — ninguém precisa abrir o
 * Automec para conferir.
 */
async function validarConfig(config) {
  const chave = JSON.stringify([config.idEmpresaErp, config.cdClienteErp, config.cdVendedorPadrao, config.cdProdutoFrete]);
  if (_validacao && _validacao.chave === chave && Date.now() - _validacao.em < 5 * 60 * 1000) {
    return _validacao.resultado;
  }
  const schema = await lerSchema();
  const erros = [];
  const nomes = {};

  if (existe(schema, 'CONFIGURACAO', 'NOMEEMPRESA')) {
    nomes.empresa = await nomeDe(
      'SELECT CAST(NOMEEMPRESA AS VARCHAR(100) CHARACTER SET OCTETS) AS NOME FROM CONFIGURACAO WHERE IDEMPRESA = ?',
      [config.idEmpresaErp]
    );
    if (!nomes.empresa) erros.push(`A empresa ${config.idEmpresaErp} não existe na CONFIGURACAO do ERP.`);
  }
  if (existe(schema, 'CLIENTE', 'CLIENTE')) {
    const porEmpresa = existe(schema, 'CLIENTE', 'IDEMPRESA') ? ' AND IDEMPRESA = ?' : '';
    nomes.cliente = await nomeDe(
      `SELECT FIRST 1 CAST(CLIENTE AS VARCHAR(100) CHARACTER SET OCTETS) AS NOME FROM CLIENTE WHERE CDCLIENTE = ?${porEmpresa}`,
      porEmpresa ? [config.cdClienteErp, config.idEmpresaErp] : [config.cdClienteErp]
    );
    if (!nomes.cliente) erros.push(`O cliente ${config.cdClienteErp} não existe no ERP.`);
  }
  if (existe(schema, 'VENDEDOR', 'VENDEDOR')) {
    nomes.vendedor = await nomeDe(
      'SELECT CAST(VENDEDOR AS VARCHAR(100) CHARACTER SET OCTETS) AS NOME FROM VENDEDOR WHERE CDVENDEDOR = ?',
      [Number(config.cdVendedorPadrao)]
    );
    if (!nomes.vendedor) erros.push(`O vendedor ${config.cdVendedorPadrao} não existe no ERP.`);
  }
  if (config.cdProdutoFrete && existe(schema, 'PRODUTO', 'PRODUTO')) {
    nomes.frete = await nomeDe(
      'SELECT CAST(PRODUTO AS VARCHAR(150) CHARACTER SET OCTETS) AS NOME FROM PRODUTO WHERE CDPRODUTO = ?',
      [paramDoProduto(schema, config.cdProdutoFrete)]
    );
    if (!nomes.frete) erros.push(`O produto de frete ${config.cdProdutoFrete} não existe no ERP.`);
  }
  if (!Object.keys(schema.tabelas.ORCAMENTO).length) erros.push('A tabela ORCAMENTO não existe neste banco.');
  if (!Object.keys(schema.tabelas.ORCPROD).length) erros.push('A tabela ORCPROD não existe neste banco.');

  const resultado = { ok: erros.length === 0, erros, nomes };
  _validacao = { chave, em: Date.now(), resultado };
  return resultado;
}

// ── Texto (auto-teste de acento) ─────────────────────────────────────────────

/** @type {{ modo: 'win1252'|'ascii', detalhe: string } | null} */
let _texto = null;

async function modoDeTexto() {
  if (!_texto) _texto = await testarEscritaWin1252((sql, params) => executar(sql, params));
  return _texto;
}

// ── Reconciliação de um pedido ───────────────────────────────────────────────

const COLUNAS_NOSSAS_ORCAMENTO = new Set([
  'NRORCAMENTO', 'IDEMPRESA', 'CDCLIENTE', 'DTORC', 'HORAORC', 'VLTOTAL', 'CDVENDEDOR', 'CDPROPAGANDA',
  'STATUS', 'CLIENTE', 'DESCONTO', 'PERC_DESCONTO', 'FRETE', 'INDFINAL', 'PONTUACAO', 'SUBTOTAL',
  'LOCALENTR', 'BAIRRO', 'CEP', 'UF', 'COMPLEMENTO', 'TELEFONE', 'TELEFONE_ENTREGA', 'CDMUNICIPIO',
  'IDENDERECO', 'OBSERVACAO', 'OBS', COLUNA_ZR
]);

/** O cabeçalho que o pedido muda (no UPDATE, sem número, data, hora e vendedor). */
function cabecalhoVariavel(p, cdMunicipio) {
  const e = p.entrega || {};
  const perc = p.subtotal > 0 ? Math.round((p.desconto / p.subtotal) * 1000000) / 10000 : 0;
  return {
    CLIENTE: p.cliente.nome,
    TELEFONE: p.cliente.telefone,
    TELEFONE_ENTREGA: p.cliente.telefone,
    VLTOTAL: p.total,
    SUBTOTAL: p.subtotal,
    DESCONTO: p.desconto,
    PERC_DESCONTO: perc,
    LOCALENTR: e.logradouro || null,
    BAIRRO: e.bairro || null,
    CEP: e.cep || null,
    UF: e.uf || null,
    COMPLEMENTO: e.complemento || null,
    CDMUNICIPIO: cdMunicipio,
    OBSERVACAO: p.observacao,
    OBS: p.observacao
  };
}

/** As linhas do ORCPROD: os itens e, se houver, o frete. */
function linhasDoPedido(p) {
  const linhas = p.itens.map(i => ({ ...i }));
  if (p.frete) {
    linhas.push({
      cdproduto: p.frete.cdproduto,
      descricao: p.frete.descricao,
      quantidade: 1,
      valorUnitario: p.frete.valor,
      total: p.frete.valor,
      idpreco: null
    });
  }
  return linhas;
}

async function gravarItens(tx, schema, p, nr, idEmpresa, cdCliente, extras, modoTexto, avisos) {
  let posic = 0;
  for (const linha of linhasDoPedido(p)) {
    const produto = await lerProduto(tx, schema, linha.cdproduto);
    if (!produto) {
      throw new ErroDefinitivo(`O produto ${linha.cdproduto} (${linha.descricao}) não existe no ERP.`);
    }
    posic += 1;
    const valores = aplicarExtras(
      {
        POSIC: posic,
        NRORCAMENTO: nr,
        IDEMPRESA: idEmpresa,
        CDPRODUTO: paramDoProduto(schema, linha.cdproduto),
        DESCRICAO: linha.descricao,
        UNID: produto.unid,
        QTDPRODUTO: linha.quantidade,
        VLUNIT: linha.valorUnitario,
        TOTAL: linha.total,
        QTDEPECA: linha.quantidade,
        STATUS: 'FF',
        CDDEPOSITO: produto.cddeposito,
        DESCONTO: 0,
        IDPRECO: linha.idpreco ?? produto.idpreco,
        ORDEM: 'A',
        SUBTOTAL: linha.total,
        CALC: linha.quantidade,
        VLBCICMS: 0, PERC_ICMS: 0, VLICMS: 0, PERC_REDUCAO: 0, VLBCST: 0,
        PERC_ST: 0, VLST: 0, PERC_REDUCAO_ST: 0, PERC_COMISS: 0,
        CDCLIENTE: cdCliente,
        HASH: '',
        QTDELIB: linha.quantidade,
        VLCUSTO: produto.vlcusto,
        PRAZOPRODUTO: '',
        RESUMO_OS: ''
      },
      extras && extras.ORCPROD,
      p.modalidade
    );
    const ins = montarInsert(schema, 'ORCPROD', valores, modoTexto);
    if (posic === 1 && ins.ausentes.length) avisos.push(`ORCPROD sem as colunas: ${ins.ausentes.join(', ')}`);
    await tx.query(ins.sql, ins.params);
  }
  return posic;
}

/**
 * Leva UM pedido ao ERP. Uma transação; no Ensaio, a mesma transação desfeita.
 *
 * @param {any} p       pedido do servidor (estado desejado)
 * @param {any} config  { idEmpresaErp, cdClienteErp, cdVendedorPadrao, cdProdutoFrete, extras }
 * @param {'ensaio'|'gravar'} modo
 */
async function sincronizarPedido(p, config, modo) {
  const inicio = Date.now();
  const ensaio = modo !== 'gravar';
  const base = { pedidoId: p.pedidoId, versao: p.versao, hash: p.hash, ensaio };
  const avisos = [];

  try {
    const validacao = await validarConfig(config);
    if (!validacao.ok) throw new ErroDefinitivo(validacao.erros.join(' '));

    const zr = await garantirColunaZr(modo);
    if (zr.pendente) avisos.push(`A coluna ORCAMENTO.${COLUNA_ZR} será criada ao passar para Gravar.`);
    const texto = await modoDeTexto();
    if (texto.modo !== 'win1252') avisos.push(texto.detalhe);

    const idEmpresa = Number(p.idEmpresaErp || config.idEmpresaErp || 1);
    const cdCliente = Number(config.cdClienteErp || 1);
    const schemaInicial = await lerSchema();
    const convencao = await lerConvencao(schemaInicial, idEmpresa);
    const cdMunicipio = p.entrega
      ? await codigoDoMunicipio(schemaInicial, p.entrega.cidade, p.entrega.uf)
      : null;
    if (p.entrega && p.entrega.cidade && cdMunicipio === null && existe(schemaInicial, 'ORCAMENTO', 'CDMUNICIPIO')) {
      avisos.push(`Município "${p.entrega.cidade}/${p.entrega.uf}" não achado no ERP.`);
    }

    for (let tentativa = 1; ; tentativa++) {
      try {
        const resultado = await comTransacao(
          tx => reconciliar(tx, p, config, { idEmpresa, cdCliente, cdMunicipio, convencao, ensaio, modoTexto: texto.modo, avisos }),
          { desfazer: ensaio }
        );
        return { ...base, ...resultado, idEmpresaErp: idEmpresa, avisos, duracaoMs: Date.now() - inicio };
      } catch (err) {
        // Outro caixa pegou o mesmo número no mesmo instante: numera de novo.
        if (ehViolacaoDeUnicidade(err) && tentativa < TENTATIVAS_NUMERACAO) {
          logWarn(`[Pedidos] Pedido #${p.numero}: número de orçamento disputado, tentando de novo (${tentativa}).`);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    return {
      ...base,
      acao: 'erro',
      erro: err.message,
      transitorio: !(err instanceof ErroDefinitivo) && ehTransitorio(err),
      avisos,
      duracaoMs: Date.now() - inicio
    };
  }
}

async function reconciliar(tx, p, config, ctx) {
  const schema = await lerSchema();
  const temZr = existe(schema, 'ORCAMENTO', COLUNA_ZR);
  const colStatus = existe(schema, 'ORCAMENTO', 'STATUS') ? 'STATUS' : 'NULL';

  // 1. Achar o orçamento deste pedido.
  let atual = null;
  if (p.nrOrcamento) {
    const [linha] = await tx.query(
      `SELECT NRORCAMENTO, ${colStatus} AS STATUS${temZr ? `, ${COLUNA_ZR} AS ZR` : ''}
         FROM ORCAMENTO WHERE NRORCAMENTO = ? AND IDEMPRESA = ?`,
      [p.nrOrcamento, ctx.idEmpresa]
    );
    if (!linha) return { acao: 'removido', nrOrcamento: p.nrOrcamento };
    if (temZr && linha.zr !== null && linha.zr !== undefined && Number(linha.zr) !== Number(p.pedidoId)) {
      throw new ErroDefinitivo(`O orçamento ${p.nrOrcamento} do ERP pertence a outro pedido do ZapRun (${linha.zr}).`);
    }
    atual = linha;
  } else if (temZr) {
    const desde = new Date(new Date(p.criadoEm).getTime() - 2 * 24 * 60 * 60 * 1000);
    const linhas = await tx.query(
      `SELECT NRORCAMENTO, ${colStatus} AS STATUS FROM ORCAMENTO
        WHERE ${COLUNA_ZR} = ? AND IDEMPRESA = ? AND DTORC >= ?
        ORDER BY NRORCAMENTO`,
      [p.pedidoId, ctx.idEmpresa, new Date(desde.getFullYear(), desde.getMonth(), desde.getDate())]
    );
    if (linhas.length > 1) {
      ctx.avisos.push(`${linhas.length} orçamentos com ${COLUNA_ZR}=${p.pedidoId} (copiados no ERP?); usei o ${linhas[0].nrorcamento}.`);
    }
    atual = linhas[0] || null;
  }

  // 2. Não existe.
  if (!atual) {
    if (p.cancelado) return { acao: 'ignorado' };
    const [{ n }] = await tx.query(
      'SELECT COALESCE(MAX(NRORCAMENTO), 0) + 1 AS N FROM ORCAMENTO WHERE IDEMPRESA = ?',
      [ctx.idEmpresa]
    );
    const nr = Number(n);
    const vendedor = Number(p.vendedor || config.cdVendedorPadrao || 1);
    const valores = aplicarExtras(
      {
        NRORCAMENTO: nr,
        IDEMPRESA: ctx.idEmpresa,
        CDCLIENTE: ctx.cdCliente,
        ...datasDoOrcamento(schema, p.criadoEm, ctx.convencao),
        CDVENDEDOR: vendedor,
        CDPROPAGANDA: 0,
        STATUS: 0,
        FRETE: 0,
        INDFINAL: -1,
        PONTUACAO: 0,
        IDENDERECO: 0,
        ...cabecalhoVariavel(p, ctx.cdMunicipio),
        ...(temZr ? { [COLUNA_ZR]: p.pedidoId } : {})
      },
      config.extras && config.extras.ORCAMENTO,
      p.modalidade
    );
    const ins = montarInsert(schema, 'ORCAMENTO', valores, ctx.modoTexto);
    const faltam = Object.entries(schema.tabelas.ORCAMENTO)
      .filter(([c, d]) => d.obrigatorio && !(c in valores))
      .map(([c]) => c);
    if (faltam.length) ctx.avisos.push(`ORCAMENTO tem obrigatórias que o Motor não preenche: ${faltam.join(', ')}`);
    await tx.query(ins.sql, ins.params);
    const linhas = await gravarItens(tx, schema, p, nr, ctx.idEmpresa, ctx.cdCliente, config.extras, ctx.modoTexto, ctx.avisos);
    return ctx.ensaio
      ? { acao: 'criado', nrPrevisto: nr, linhas, cdVendedor: String(vendedor), situacaoErp: 0 }
      : { acao: 'criado', nrOrcamento: nr, linhas, cdVendedor: String(vendedor), situacaoErp: 0 };
  }

  // 3. Existe.
  const nr = Number(atual.nrorcamento);
  const situacao = atual.status === null || atual.status === undefined ? 0 : Number(atual.status);
  if (situacao !== 0) return { acao: 'travado', nrOrcamento: nr, situacaoErp: situacao };

  if (p.cancelado) {
    await tx.query('UPDATE ORCAMENTO SET STATUS = 2 WHERE NRORCAMENTO = ? AND IDEMPRESA = ?', [nr, ctx.idEmpresa]);
    return { acao: 'cancelado', nrOrcamento: nr, situacaoErp: 2 };
  }

  const up = montarUpdate(
    schema,
    'ORCAMENTO',
    aplicarExtras(cabecalhoVariavel(p, ctx.cdMunicipio), config.extras && config.extras.ORCAMENTO_UPDATE, p.modalidade),
    'NRORCAMENTO = ? AND IDEMPRESA = ?',
    [nr, ctx.idEmpresa],
    ctx.modoTexto
  );
  await tx.query(up.sql, up.params);
  await tx.query('DELETE FROM ORCPROD WHERE NRORCAMENTO = ? AND IDEMPRESA = ?', [nr, ctx.idEmpresa]);
  const linhas = await gravarItens(tx, schema, p, nr, ctx.idEmpresa, ctx.cdCliente, config.extras, ctx.modoTexto, ctx.avisos);
  return { acao: 'atualizado', nrOrcamento: nr, linhas, situacaoErp: 0 };
}

// ── Relatório para o painel ──────────────────────────────────────────────────

/**
 * O que o painel precisa para conferir este ERP sem acesso à máquina. Sem dado
 * pessoal: estrutura, números de controle e proporções.
 */
async function relatorio(config) {
  const schema = await lerSchema(true);
  const idEmpresa = Number(config.idEmpresaErp || 1);
  /** @type {any} */
  const saida = {
    em: new Date().toISOString(),
    colunaZr: existe(schema, 'ORCAMENTO', COLUNA_ZR),
    chaves: schema.chaves,
    obrigatoriasSemValor: Object.entries(schema.tabelas.ORCAMENTO)
      .filter(([c, d]) => d.obrigatorio && !COLUNAS_NOSSAS_ORCAMENTO.has(c))
      .map(([c]) => c),
    colunasAusentes: [...COLUNAS_NOSSAS_ORCAMENTO].filter(
      c => c !== COLUNA_ZR && c !== 'OBS' && c !== 'OBSERVACAO' && !existe(schema, 'ORCAMENTO', c)
    ),
    observacaoEm: ['OBSERVACAO', 'OBS'].filter(c => existe(schema, 'ORCAMENTO', c)),
    texto: await modoDeTexto(),
    validacao: await validarConfig(config),
    numeracao: {},
    calibracao: {},
    posicionais: []
  };

  try {
    const [m] = await executar('SELECT MAX(NRORCAMENTO) AS M, COUNT(*) AS Q FROM ORCAMENTO WHERE IDEMPRESA = ?', [idEmpresa]);
    saida.numeracao = { maior: m ? m.m : null, proximo: m && m.m !== null ? Number(m.m) + 1 : 1, orcamentos: m ? m.q : 0 };
    const geradores = await executar(
      "SELECT TRIM(RDB$GENERATOR_NAME) AS N FROM RDB$GENERATORS WHERE RDB$GENERATOR_NAME CONTAINING 'ORC' AND COALESCE(RDB$SYSTEM_FLAG, 0) = 0"
    );
    saida.numeracao.geradores = [];
    for (const g of geradores) {
      const nome = String(g.n).trim();
      if (!/^[A-Z0-9_$]{1,63}$/i.test(nome)) continue;
      const [v] = await executar(`SELECT GEN_ID(${nome}, 0) AS V FROM RDB$DATABASE`);
      saida.numeracao.geradores.push({ nome, valor: v ? Number(v.v) : null });
    }
    const colsConf = Object.keys(schema.tabelas.CONFIGURACAO).filter(c => /ORC/.test(c));
    if (colsConf.length && existe(schema, 'CONFIGURACAO', 'IDEMPRESA')) {
      const [c] = await executar(`SELECT ${colsConf.join(', ')} FROM CONFIGURACAO WHERE IDEMPRESA = ?`, [idEmpresa]);
      saida.numeracao.configuracao = c || null;
    }
  } catch (err) {
    saida.numeracao.erro = err.message;
  }

  try {
    const p = schema.tabelas.ORCPROD;
    const cmp = (a, b) => (p[a] && p[b] ? `SUM(IIF(${a} = ${b}, 1, 0))` : 'NULL');
    const [c] = await executar(
      `SELECT COUNT(*) AS Q, ${cmp('CALC', 'QTDPRODUTO')} AS CALC_QTD, ${cmp('QTDEPECA', 'QTDPRODUTO')} AS PECA_QTD,
              ${cmp('SUBTOTAL', 'TOTAL')} AS SUB_TOTAL, ${cmp('QTDELIB', 'QTDPRODUTO')} AS LIB_QTD
         FROM (SELECT FIRST 200 * FROM ORCPROD WHERE IDEMPRESA = ? ORDER BY NRORCAMENTO DESC)`,
      [idEmpresa]
    );
    saida.calibracao.orcprod = c || null;
    const o = schema.tabelas.ORCAMENTO;
    for (const col of ['INDFINAL', 'CDTPENTREGA', 'CDPROPAGANDA']) {
      if (!o[col]) continue;
      const dist = await executar(
        `SELECT CAST(${col} AS VARCHAR(20) CHARACTER SET OCTETS) AS V, COUNT(*) AS Q
           FROM (SELECT FIRST 200 ${col} FROM ORCAMENTO WHERE IDEMPRESA = ? ORDER BY NRORCAMENTO DESC)
          GROUP BY 1 ORDER BY 2 DESC`,
        [idEmpresa]
      );
      saida.calibracao[col] = dist.slice(0, 5).map(d => ({ valor: d.v === null ? null : fixEncoding(d.v).trim(), qtd: d.q }));
    }
    const conv = await lerConvencao(schema, idEmpresa);
    saida.calibracao.horaBase1899 = conv.horaBase1899;
    saida.calibracao.dataComHora = conv.dataComHora;
  } catch (err) {
    saida.calibracao.erro = err.message;
  }

  try {
    saida.posicionais = await insercoesPorPosicao();
  } catch (err) {
    saida.posicionais = [`(não deu para verificar: ${err.message})`];
  }
  return saida;
}

/** Zera os caches (o servidor mudou a configuração, ou um teste quer recomeçar). */
function esquecerCaches() {
  _schema = null;
  _convencao = null;
  _validacao = null;
  _texto = null;
  _municipios.clear();
}

module.exports = {
  sincronizarPedido,
  relatorio,
  esquecerCaches,
  // exportados para teste
  montarInsert,
  montarUpdate,
  aplicarExtras,
  datasDoOrcamento,
  linhasDoPedido,
  cabecalhoVariavel,
  chaveDeNome,
  ErroDefinitivo
};
