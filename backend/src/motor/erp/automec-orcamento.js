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

const { comTransacao, executar, ehViolacaoDeUnicidade, ehTransitorio, geracaoDoDriver } = require('../firebirdEscrita');
const { textoParaErp, marcadorDeTexto, testarEscritaWin1252, paraBufferWin1252 } = require('../textoParaErp');
const { fixEncoding } = require('../encoding');
const { logWarn, logInfo } = require('../../logger');

const TABELAS = ['ORCAMENTO', 'ORCPROD', 'PRODUTO', 'PRODUTOPRECO', 'MUNICIPIO', 'VENDEDOR', 'CLIENTE', 'CONFIGURACAO', 'SAIDAESTOQUE'];
const COLUNA_ZR = 'ZR_PEDIDO';
const CACHE_SCHEMA_MS = 10 * 60 * 1000;
const CACHE_MUNICIPIO_MS = 24 * 60 * 60 * 1000;
const TENTATIVAS_NUMERACAO = 6;

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

/** @type {{ em: number, horaBase1899: boolean, dataComHora: boolean, itens: Record<string, any>, casa: any } | null} */
let _convencao = null;

// Colunas do ORCPROD cujo valor a Pontual chuta (= quantidade) e que o
// Automec de cada cliente preenche do seu jeito. Na JPR (relatório de
// 19/11) CALC = QTDPRODUTO em 2 de 200 itens e QTDELIB em 0 de 200: copiar a
// Pontual punha no orçamento um valor que o próprio Automec nunca põe.
const COLUNAS_COPIADAS = ['CALC', 'QTDELIB', 'QTDEPECA'];
const PARCELA_MINIMA = 0.8;

/** Valor de uma coluna de item pela regra lida dos orçamentos da casa. */
function valorDaRegra(regra, quantidade) {
  if (regra === 'zero') return 0;
  if (regra === 'nulo') return null;
  if (regra === 'um') return 1;
  return quantidade;
}

/**
 * Como o Automec da casa preenche CALC, QTDELIB e QTDEPECA nos últimos 200
 * itens da empresa: igual à quantidade, zero, nulo ou um. Só adota a regra
 * que aparece em 80% ou mais; sem maioria clara, fica a quantidade (Pontual)
 * e o relatório mostra que não deu para decidir.
 */
async function lerRegrasDosItens(schema, idEmpresa) {
  const p = schema.tabelas.ORCPROD;
  /** @type {Record<string, any>} */
  const regras = {};
  if (!p.QTDPRODUTO) return regras;
  for (const col of COLUNAS_COPIADAS) {
    if (!p[col]) continue;
    const [c] = await executar(
      `SELECT COUNT(*) AS Q, SUM(IIF(${col} = QTDPRODUTO, 1, 0)) AS QTD, SUM(IIF(${col} = 0, 1, 0)) AS ZERO,
              SUM(IIF(${col} IS NULL, 1, 0)) AS NULO, SUM(IIF(${col} = 1, 1, 0)) AS UM
         FROM (SELECT FIRST 200 ${col}, QTDPRODUTO FROM ORCPROD WHERE IDEMPRESA = ? ORDER BY NRORCAMENTO DESC)`,
      [idEmpresa]
    );
    const total = Number(c && c.q) || 0;
    const contagem = { qtd: Number(c && c.qtd) || 0, zero: Number(c && c.zero) || 0, nulo: Number(c && c.nulo) || 0, um: Number(c && c.um) || 0 };
    const [regra, vezes] = Object.entries(contagem).sort((a, b) => b[1] - a[1])[0];
    const decidiu = total >= 10 && vezes / total >= PARCELA_MINIMA;
    regras[col] = { regra: decidiu ? regra : 'qtd', decidiu, amostra: total, contagem };
  }
  return regras;
}

// Colunas que o Motor preenche por conta própria. As DEMAIS são as que o
// Automec da casa pode preencher e o Motor deixaria nulas.
const COLUNAS_NOSSAS_ORCPROD = new Set([
  'POSIC', 'NRORCAMENTO', 'IDEMPRESA', 'CDPRODUTO', 'DESCRICAO', 'UNID', 'QTDPRODUTO', 'VLUNIT', 'TOTAL',
  'QTDEPECA', 'STATUS', 'CDDEPOSITO', 'DESCONTO', 'IDPRECO', 'ORDEM', 'SUBTOTAL', 'CALC', 'VLBCICMS',
  'PERC_ICMS', 'VLICMS', 'PERC_REDUCAO', 'VLBCST', 'PERC_ST', 'VLST', 'PERC_REDUCAO_ST', 'PERC_COMISS',
  'CDCLIENTE', 'HASH', 'QTDELIB', 'VLCUSTO', 'PRAZOPRODUTO', 'RESUMO_OS'
]);
const TIPOS_NUMERICOS = new Set([7, 8, 10, 16, 27]);
const AMOSTRA_CASA = 200;
const PARCELA_COPIA = 0.9;
const TEXTO_CURTO = 20;

/**
 * Como o Automec da casa preenche as colunas que o Motor NÃO preenche, nos
 * últimos 200 registros da empresa feitos por ele (sem ZR_PEDIDO).
 *
 * Por que existe: na JPR (23/11) o orçamento gravado pelo Motor existia no
 * banco mas não aparecia na tela do Automec — a tela filtra ou liga por algum
 * campo que o próprio Automec sempre preenche. Em vez de adivinhar qual, o
 * Motor copia: coluna de código/indicador (número ou texto de até 20
 * caracteres) que vem com o MESMO valor em 90% ou mais dos registros da casa
 * entra igual no orçamento do Motor. Data, hora, BLOB e texto livre nunca.
 *
 * @returns {Promise<{ constantes: Record<string, any>, perfil: any[] }>}
 */
async function perfilDaCasa(schema, tabela, idEmpresa, nossas) {
  const defs = schema.tabelas[tabela] || {};
  const candidatas = Object.entries(defs).filter(
    ([c, d]) => !nossas.has(c) && c !== COLUNA_ZR && !d.blob
  );
  const vazio = { constantes: {}, perfil: [] };
  if (!candidatas.length || !defs.IDEMPRESA || !defs.NRORCAMENTO) return vazio;

  const comReferencia = tabela === 'ORCAMENTO' && defs.DTORC;
  const selecao = candidatas
    .map(([c, d]) => (d.texto ? `CAST(${c} AS VARCHAR(${Math.max(1, d.tamanho || 1)}) CHARACTER SET OCTETS) AS ${c}` : c))
    .concat(comReferencia ? ['DTORC AS ZR_REF_DTORC'] : [])
    .join(', ');
  const semMotor = existe(schema, 'ORCAMENTO', COLUNA_ZR)
    ? tabela === 'ORCAMENTO'
      ? ` AND ${COLUNA_ZR} IS NULL`
      : ` AND NOT EXISTS (SELECT 1 FROM ORCAMENTO o WHERE o.NRORCAMENTO = t.NRORCAMENTO AND o.IDEMPRESA = t.IDEMPRESA AND o.${COLUNA_ZR} IS NOT NULL)`
    : '';
  const linhas = await executar(
    `SELECT FIRST ${AMOSTRA_CASA} ${selecao} FROM ${tabela} t WHERE IDEMPRESA = ?${semMotor} ORDER BY NRORCAMENTO DESC`,
    [idEmpresa]
  );
  const total = linhas.length;
  if (total < 10) return vazio;

  /** @type {Record<string, any>} */
  const constantes = {};
  const perfil = [];
  for (const [c, d] of candidatas) {
    const chave = c.toLowerCase();
    const contagem = new Map();
    const prazos = new Map();
    let preenchidos = 0;
    for (const l of linhas) {
      let v = l[chave];
      // Data: o que se repete não é o dia, é o PRAZO a partir da data do
      // orçamento (validade de 7 dias, entrega em 3...).
      if (v instanceof Date && l.zr_ref_dtorc instanceof Date) {
        const dias = Math.round((v.getTime() - l.zr_ref_dtorc.getTime()) / 86400000);
        prazos.set(dias, (prazos.get(dias) || 0) + 1);
      }
      if (Buffer.isBuffer(v)) v = fixEncoding(v).trim();
      if (v instanceof Date) v = 'data';
      if (v === null || v === undefined || v === '') continue;
      preenchidos += 1;
      const k = typeof v === 'number' ? `n:${v}` : `s:${v}`;
      contagem.set(k, (contagem.get(k) || 0) + 1);
    }
    let maisComum = null;
    let vezes = 0;
    for (const [k, q] of contagem) {
      if (q > vezes) {
        vezes = q;
        maisComum = k;
      }
    }
    const valor = maisComum === null ? null : maisComum.startsWith('n:') ? Number(maisComum.slice(2)) : maisComum.slice(2);
    const curto = TIPOS_NUMERICOS.has(d.tipo) || (d.texto && (d.tamanho || 0) <= TEXTO_CURTO);
    let copia = curto && valor !== null && valor !== 'data' && vezes / total >= PARCELA_COPIA;
    if (copia) constantes[c] = valor;
    let prazo = null;
    if (!copia && (d.tipo === TIPO_DATA || d.tipo === TIPO_TIMESTAMP) && preenchidos / total >= PARCELA_COPIA) {
      let melhor = null;
      let qtd = 0;
      for (const [dias, q] of prazos) {
        if (q > qtd) {
          qtd = q;
          melhor = dias;
        }
      }
      // 70%: o prazo da casa costuma ser fixo, mas alguém sempre edita um.
      if (melhor !== null && melhor >= 0 && melhor <= 365 && qtd / total >= 0.7) {
        prazo = melhor;
        constantes[c] = { $diasAposDtorc: melhor };
        copia = true;
      }
    }
    if (preenchidos / total >= 0.5) {
      perfil.push({
        coluna: c,
        preenchidos: Math.round((preenchidos / total) * 100),
        // Só código/indicador repetido aparece: nome, telefone e texto livre
        // não saem da máquina do cliente.
        maisComum: prazo !== null ? `data do orçamento + ${prazo} dia(s)` : curto && valor !== 'data' && vezes / total >= 0.3 ? valor : null,
        copiado: copia
      });
    }
  }
  return { constantes, perfil };
}

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
  const itens = await lerRegrasDosItens(schema, idEmpresa);
  const casaOrcamento = await perfilDaCasa(schema, 'ORCAMENTO', idEmpresa, COLUNAS_NOSSAS_ORCAMENTO);
  const casaItens = await perfilDaCasa(schema, 'ORCPROD', idEmpresa, COLUNAS_NOSSAS_ORCPROD);
  const casa = {
    ORCAMENTO: casaOrcamento.constantes,
    ORCPROD: casaItens.constantes,
    perfil: { ORCAMENTO: casaOrcamento.perfil, ORCPROD: casaItens.perfil }
  };
  _convencao = { em: Date.now(), horaBase1899, dataComHora, itens, casa };
  return _convencao;
}

/** Troca { $diasAposDtorc: n } (prazo aprendido da casa) pela data de fato. */
function resolverPrazos(valores, dtorc) {
  /** @type {Record<string, any>} */
  const saida = {};
  for (const [c, v] of Object.entries(valores || {})) {
    if (v && typeof v === 'object' && Number.isInteger(v.$diasAposDtorc)) {
      const d = new Date(dtorc);
      d.setDate(d.getDate() + v.$diasAposDtorc);
      saida[c] = d;
    } else {
      saida[c] = v;
    }
  }
  return saida;
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

  // Não bloqueia (cada loja chama o frete de um jeito), mas o painel mostra:
  // na JPR o código 90 era "EMENDA CALHA AMANCO PLUVIAL".
  const avisos = [];
  if (nomes.frete && !/FRETE|ENTREGA|TAXA|TRANSPORT|MOTOBOY|CARRETO|DELIVERY/i.test(nomes.frete)) {
    avisos.push(`O produto de frete ${config.cdProdutoFrete} no ERP é "${nomes.frete}" — confira se o código está certo.`);
  }
  const resultado = { ok: erros.length === 0, erros, avisos, nomes };
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
// Retirada vai sem endereço (o balcão pode não ter um — como no orçamento do
// PDV Web da Pontual); entrega leva o endereço do pedido.
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

async function gravarItens(tx, schema, p, nr, idEmpresa, cdCliente, extras, modoTexto, avisos, regras = {}, casa = {}) {
  const regra = col => (regras[col] ? regras[col].regra : 'qtd');
  let posic = 0;
  for (const linha of linhasDoPedido(p)) {
    const produto = await lerProduto(tx, schema, linha.cdproduto);
    if (!produto) {
      throw new ErroDefinitivo(`O produto ${linha.cdproduto} (${linha.descricao}) não existe no ERP.`);
    }
    posic += 1;
    const valores = aplicarExtras(
      {
        // O que o Automec da casa sempre põe (ver perfilDaCasa) — por baixo:
        // o mapeamento do Motor e os extras do servidor vencem.
        ...casa,
        POSIC: posic,
        NRORCAMENTO: nr,
        IDEMPRESA: idEmpresa,
        CDPRODUTO: paramDoProduto(schema, linha.cdproduto),
        DESCRICAO: linha.descricao,
        UNID: produto.unid,
        QTDPRODUTO: linha.quantidade,
        VLUNIT: linha.valorUnitario,
        TOTAL: linha.total,
        QTDEPECA: valorDaRegra(regra('QTDEPECA'), linha.quantidade),
        // Situação do item no Automec: EN = entrega, RM = retirada (decisão
        // do dono, 23/11). Nunca 'FF', que é o da Pontual.
        STATUS: p.modalidade === 'retirada' ? 'RM' : 'EN',
        CDDEPOSITO: produto.cddeposito,
        DESCONTO: 0,
        IDPRECO: linha.idpreco ?? produto.idpreco,
        ORDEM: 'A',
        SUBTOTAL: linha.total,
        CALC: valorDaRegra(regra('CALC'), linha.quantidade),
        VLBCICMS: 0, PERC_ICMS: 0, VLICMS: 0, PERC_REDUCAO: 0, VLBCST: 0,
        PERC_ST: 0, VLST: 0, PERC_REDUCAO_ST: 0, PERC_COMISS: 0,
        CDCLIENTE: cdCliente,
        HASH: '',
        QTDELIB: valorDaRegra(regra('QTDELIB'), linha.quantidade),
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
        // Chave repetida: outro caixa pegou o mesmo número no mesmo instante,
        // ou o gerador de uma chave do Automec está atrás dos dados (JPR,
        // 23/11: GEN_ORCPROD atrás do maior POSIC — cada tentativa o avança).
        if (ehViolacaoDeUnicidade(err) && tentativa < TENTATIVAS_NUMERACAO) {
          logWarn(`[Pedidos] Pedido #${p.numero}: chave repetida no ERP (${String(err.message).slice(0, 120)}), tentando de novo (${tentativa}).`);
          // Espera crescente e um pouco aleatória: o concorrente (outro caixa
          // do Automec gravando o mesmo número) termina o commit e o MAX da
          // próxima tentativa já o enxerga.
          await new Promise(r => setTimeout(r, 150 * tentativa + Math.floor(Math.random() * 150)));
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
    let nr = Number(n);
    // Número que uma VENDA já cita (SAIDAESTOQUE.NRORCAMENTO) não pode virar
    // orçamento novo: o Automec liga os dois e o orçamento some da tela de
    // abertos. Na JPR (23/11) havia venda apontando para o 84478 que o Motor
    // acabou de criar. Pula para depois do maior número citado.
    if (schema.tabelas.SAIDAESTOQUE && schema.tabelas.SAIDAESTOQUE.NRORCAMENTO) {
      const filtro = schema.tabelas.SAIDAESTOQUE.IDEMPRESA ? ' AND IDEMPRESA = ?' : '';
      const [{ m }] = await tx.query(
        `SELECT MAX(NRORCAMENTO) AS M FROM SAIDAESTOQUE WHERE NRORCAMENTO >= ?${filtro}`,
        filtro ? [nr, ctx.idEmpresa] : [nr]
      );
      if (m !== null && m !== undefined && Number(m) >= nr) {
        ctx.avisos.push(`Números ${nr} a ${Number(m)} já aparecem em vendas (SAIDAESTOQUE); usei o ${Number(m) + 1}.`);
        nr = Number(m) + 1;
      }
    }
    const vendedor = Number(p.vendedor || config.cdVendedorPadrao || 1);
    const datas = datasDoOrcamento(schema, p.criadoEm, ctx.convencao);
    const valores = aplicarExtras(
      {
        ...resolverPrazos(ctx.convencao.casa.ORCAMENTO, datas.DTORC),
        NRORCAMENTO: nr,
        IDEMPRESA: ctx.idEmpresa,
        CDCLIENTE: ctx.cdCliente,
        ...datas,
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
    const linhas = await gravarItens(tx, schema, p, nr, ctx.idEmpresa, ctx.cdCliente, config.extras, ctx.modoTexto, ctx.avisos, ctx.convencao.itens, ctx.convencao.casa.ORCPROD);
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
  // O que a casa sempre preenche entra só onde está NULO: o Automec pode ter
  // mudado esses campos depois (impressão, conversão), e o Motor não desfaz.
  // É o que conserta, com um "Reenviar", o orçamento gravado antes disto.
  for (const [coluna, valor] of Object.entries(ctx.convencao.casa.ORCAMENTO || {})) {
    const def = schema.tabelas.ORCAMENTO[coluna];
    if (!def) continue;
    if (valor && typeof valor === 'object' && Number.isInteger(valor.$diasAposDtorc)) {
      await tx.query(
        `UPDATE ORCAMENTO SET ${coluna} = DTORC + ${valor.$diasAposDtorc} WHERE NRORCAMENTO = ? AND IDEMPRESA = ? AND ${coluna} IS NULL AND DTORC IS NOT NULL`,
        [nr, ctx.idEmpresa]
      );
      continue;
    }
    const v = valorDaColuna(def, valor, ctx.modoTexto);
    await tx.query(
      `UPDATE ORCAMENTO SET ${coluna} = ${v.marca} WHERE NRORCAMENTO = ? AND IDEMPRESA = ? AND ${coluna} IS NULL`,
      [v.param, nr, ctx.idEmpresa]
    );
  }
  await tx.query('DELETE FROM ORCPROD WHERE NRORCAMENTO = ? AND IDEMPRESA = ?', [nr, ctx.idEmpresa]);
  const linhas = await gravarItens(tx, schema, p, nr, ctx.idEmpresa, ctx.cdCliente, config.extras, ctx.modoTexto, ctx.avisos, ctx.convencao.itens, ctx.convencao.casa.ORCPROD);
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
    driver: geracaoDoDriver(),
    validacao: await validarConfig(config),
    numeracao: {},
    calibracao: {},
    posicionais: []
  };

  try {
    const [m] = await executar('SELECT MAX(NRORCAMENTO) AS M, COUNT(*) AS Q FROM ORCAMENTO WHERE IDEMPRESA = ?', [idEmpresa]);
    saida.numeracao = { maior: m ? m.m : null, proximo: m && m.m !== null ? Number(m.m) + 1 : 1, orcamentos: m ? m.q : 0 };
    // Os números dos orçamentos mais RECENTES pela data: se forem os maiores,
    // o Automec numera por MAX+1 como o Motor; se forem de outra faixa, ele
    // usa um gerador e o Motor precisa seguir o mesmo.
    if (existe(schema, 'ORCAMENTO', 'DTORC')) {
      const recentes = await executar(
        'SELECT FIRST 5 NRORCAMENTO FROM ORCAMENTO WHERE IDEMPRESA = ? ORDER BY DTORC DESC, NRORCAMENTO DESC',
        [idEmpresa]
      );
      saida.numeracao.recentesPorData = recentes.map(r => r.nrorcamento);
    }
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
    _convencao = null;
    const conv = await lerConvencao(schema, idEmpresa);
    saida.calibracao.horaBase1899 = conv.horaBase1899;
    saida.calibracao.dataComHora = conv.dataComHora;
    saida.calibracao.itens = conv.itens;
    for (const col of ['STATUS', 'ORDEM']) {
      if (!schema.tabelas.ORCPROD[col]) continue;
      const dist = await executar(
        `SELECT CAST(${col} AS VARCHAR(20) CHARACTER SET OCTETS) AS V, COUNT(*) AS Q
           FROM (SELECT FIRST 200 ${col} FROM ORCPROD WHERE IDEMPRESA = ? ORDER BY NRORCAMENTO DESC)
          GROUP BY 1 ORDER BY 2 DESC`,
        [idEmpresa]
      );
      saida.calibracao[`ORCPROD_${col}`] = dist.slice(0, 5).map(d => ({ valor: d.v === null ? null : fixEncoding(d.v).trim(), qtd: d.q }));
    }
  } catch (err) {
    saida.calibracao.erro = err.message;
  }

  try {
    const conv = await lerConvencao(schema, idEmpresa);
    saida.casa = { copiados: { ORCAMENTO: conv.casa.ORCAMENTO, ORCPROD: conv.casa.ORCPROD }, perfil: conv.casa.perfil };
    if (existe(schema, 'ORCAMENTO', COLUNA_ZR)) {
      const [ultimo] = await executar(
        `SELECT FIRST 1 NRORCAMENTO FROM ORCAMENTO WHERE IDEMPRESA = ? AND ${COLUNA_ZR} IS NOT NULL ORDER BY NRORCAMENTO DESC`,
        [idEmpresa]
      );
      if (ultimo) {
        saida.casa.ultimoDoMotor = await compararComACasa(config, Number(ultimo.nrorcamento));
        saida.casa.comparacaoDireta = await compararDois(config, Number(ultimo.nrorcamento));
        try {
          saida.historico = await investigarHistorico(Number(ultimo.nrorcamento), saida.casa.comparacaoDireta.casa);
        } catch (err) {
          saida.historico = { erro: err.message };
        }
      }
    }
  } catch (err) {
    saida.casa = { erro: err.message };
  }

  try {
    saida.posicionais = await insercoesPorPosicao();
  } catch (err) {
    saida.posicionais = [`(não deu para verificar: ${err.message})`];
  }
  return saida;
}

/**
 * Um orçamento do Motor, coluna a coluna, contra o que o Automec da casa
 * preenche: as colunas que lá vêm preenchidas em 80% ou mais e aqui estão
 * vazias. É a resposta para "gravou, mas não aparece na tela do Automec".
 */
async function compararComACasa(config, nr) {
  const schema = await lerSchema(true);
  const idEmpresa = Number(config.idEmpresaErp || 1);
  _convencao = null;
  const conv = await lerConvencao(schema, idEmpresa);
  /** @type {any} */
  const saida = { nrOrcamento: nr, idEmpresa, faltando: [], copiadoAgora: conv.casa.ORCAMENTO, itensCopiado: conv.casa.ORCPROD };
  for (const tabela of ['ORCAMENTO', 'ORCPROD']) {
    const perfil = (conv.casa.perfil[tabela] || []).filter(c => c.preenchidos >= 80);
    if (!perfil.length) continue;
    const cols = perfil.map(c => {
      const d = schema.tabelas[tabela][c.coluna];
      return d && d.texto ? `CAST(${c.coluna} AS VARCHAR(${Math.max(1, d.tamanho || 1)}) CHARACTER SET OCTETS) AS ${c.coluna}` : c.coluna;
    });
    const [nosso] = await executar(
      `SELECT FIRST 1 ${cols.join(', ')} FROM ${tabela} WHERE NRORCAMENTO = ? AND IDEMPRESA = ?`,
      [nr, idEmpresa]
    );
    if (!nosso) {
      saida.faltando.push({ tabela, coluna: '*', casa: `o orçamento ${nr} não existe nesta empresa` });
      continue;
    }
    for (const c of perfil) {
      let v = nosso[c.coluna.toLowerCase()];
      if (Buffer.isBuffer(v)) v = fixEncoding(v).trim();
      if (v === null || v === undefined || v === '') {
        saida.faltando.push({ tabela, coluna: c.coluna, casa: `${c.preenchidos}% preenchida`, maisComum: c.maisComum, copiado: c.copiado });
      }
    }
  }
  return saida;
}

// Colunas de dado pessoal ou texto livre: no relatório que sai da máquina,
// só o tamanho ("texto(23)"), nunca o conteúdo.
const COLUNAS_PESSOAIS = /^(CLIENTE|RAZAO|NOME|TELEFONE.*|CELULAR|WHATSAPP|FONE.*|EMAIL|CGC|CPF.*|CNPJ|RG|ENDERECO.*|LOCALENTR|BAIRRO|SUBBAIRRO|COMPLEMENTO|REFERENCIA|CEP|OBS.*|CONTATO|DESCRICAO|HASH)$/;

const COLUNAS_DE_VALOR = /^(NR.*|POSIC|VL.*|TOTAL.*|SUBTOTAL|QTD.*|PRECO.*|DESCONTO|PERC.*|VALOR.*|CUSTO.*|PESO.*|CALC|IDENDERECO|PONTUACAO)$/;

function lerValor(linha, coluna) {
  let v = linha ? linha[coluna.toLowerCase()] : null;
  if (Buffer.isBuffer(v)) v = fixEncoding(v).trim();
  if (v === '') v = null;
  return v === undefined ? null : v;
}

function mostrar(coluna, v, def, local) {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (local) return v;
  if (typeof v === 'string' && (COLUNAS_PESSOAIS.test(coluna) || v.length > TEXTO_CURTO)) return `texto(${v.length})`;
  if (def && def.blob) return `blob(${v})`;
  return v;
}

async function lerLinhas(schema, tabela, where, params, limite) {
  const defs = schema.tabelas[tabela];
  const cols = Object.entries(defs).map(([c, d]) => {
    if (d.blob) return `OCTET_LENGTH(${c}) AS ${c}`;
    if (d.texto) return `CAST(${c} AS VARCHAR(${Math.max(1, d.tamanho || 1)}) CHARACTER SET OCTETS) AS ${c}`;
    return c;
  });
  return executar(`SELECT FIRST ${limite} ${cols.join(', ')} FROM ${tabela} WHERE ${where}`, params);
}

/** Uma linha contra a outra, coluna por coluna, só onde a FORMA difere. */
function diferencas(schema, tabela, casa, motor, local) {
  const saida = [];
  for (const [c, d] of Object.entries(schema.tabelas[tabela])) {
    if (c === COLUNA_ZR) continue;
    const a = lerValor(casa, c);
    const b = lerValor(motor, c);
    if (a === null && b === null) continue;
    let situacao = null;
    if (a !== null && b === null) situacao = 'só na casa';
    else if (a === null && b !== null) situacao = 'só no Motor';
    else {
      const texto = typeof a === 'string' && (COLUNAS_PESSOAIS.test(c) || a.length > TEXTO_CURTO);
      // Valor, quantidade, número e chave sempre diferem entre dois
      // orçamentos — como no texto livre, o que interessa é estar preenchido.
      const valor = typeof a === 'number' && (!Number.isInteger(a) || COLUNAS_DE_VALOR.test(c));
      const igual = a instanceof Date ? b instanceof Date : String(a) === String(b);
      if (!igual && !texto && !valor && !(a instanceof Date)) situacao = 'diferente';
    }
    if (situacao) saida.push({ coluna: c, casa: mostrar(c, a, d, local), motor: mostrar(c, b, d, local), situacao });
  }
  return saida;
}

/**
 * Um orçamento do Motor contra um orçamento feito no próprio Automec, coluna
 * por coluna, no cabeçalho e no primeiro item. Sem `nrCasa`, usa o último
 * orçamento da casa (sem ZR_PEDIDO) de antes de hoje.
 *
 * @param {boolean} local  true na rota local: mostra os valores inteiros.
 */
/**
 * @param {any} config
 * @param {number} nrMotor
 * @param {number|null} [nrCasa]
 * @param {boolean} [local]
 */
async function compararDois(config, nrMotor, nrCasa = null, local = false) {
  const schema = await lerSchema(true);
  const idEmpresa = Number(config.idEmpresaErp || 1);
  let casaNr = nrCasa;
  if (!casaNr) {
    const filtroZr = existe(schema, 'ORCAMENTO', COLUNA_ZR) ? ` AND ${COLUNA_ZR} IS NULL` : '';
    const [l] = await executar(
      `SELECT FIRST 1 NRORCAMENTO FROM ORCAMENTO WHERE IDEMPRESA = ? AND DTORC < CURRENT_DATE${filtroZr} ORDER BY NRORCAMENTO DESC`,
      [idEmpresa]
    );
    casaNr = l ? Number(l.nrorcamento) : null;
  }
  /** @type {any} */
  const saida = { idEmpresa, motor: nrMotor, casa: casaNr };
  if (!casaNr) return { ...saida, erro: 'nenhum orçamento do Automec de antes de hoje nesta empresa' };

  const onde = 'NRORCAMENTO = ? AND IDEMPRESA = ?';
  const [cabCasa] = await lerLinhas(schema, 'ORCAMENTO', onde, [casaNr, idEmpresa], 1);
  const [cabMotor] = await lerLinhas(schema, 'ORCAMENTO', onde, [nrMotor, idEmpresa], 1);
  if (!cabMotor) return { ...saida, erro: `o orçamento ${nrMotor} não existe na empresa ${idEmpresa}` };
  saida.orcamento = diferencas(schema, 'ORCAMENTO', cabCasa, cabMotor, local);

  const ordem = existe(schema, 'ORCPROD', 'POSIC') ? ' ORDER BY POSIC' : '';
  const itensCasa = await lerLinhas(schema, 'ORCPROD', onde + ordem, [casaNr, idEmpresa], 5);
  const itensMotor = await lerLinhas(schema, 'ORCPROD', onde + ordem, [nrMotor, idEmpresa], 5);
  saida.itensQtd = { casa: itensCasa.length, motor: itensMotor.length };
  saida.item = itensCasa[0] && itensMotor[0] ? diferencas(schema, 'ORCPROD', itensCasa[0], itensMotor[0], local) : [];

  // Tabelas que o Automec costuma ligar ao orçamento (parcelas, por exemplo):
  // a casa tem linha lá e o Motor não?
  saida.tabelasLigadas = [];
  const ligadas = await executar(
    `SELECT DISTINCT TRIM(rf.RDB$RELATION_NAME) AS T FROM RDB$RELATION_FIELDS rf
      JOIN RDB$RELATIONS r ON r.RDB$RELATION_NAME = rf.RDB$RELATION_NAME
     WHERE TRIM(rf.RDB$FIELD_NAME) IN ('NRORCAMENTO', 'NRORC') AND COALESCE(r.RDB$SYSTEM_FLAG, 0) = 0
       AND r.RDB$VIEW_BLR IS NULL AND TRIM(rf.RDB$RELATION_NAME) NOT IN ('ORCAMENTO', 'ORCPROD')`
  );
  for (const { t } of ligadas) {
    const tabela = String(t).trim();
    if (!/^[A-Z0-9_$]{1,63}$/.test(tabela)) continue;
    try {
      const temNr = await executar(
        "SELECT TRIM(RDB$FIELD_NAME) AS C FROM RDB$RELATION_FIELDS WHERE TRIM(RDB$RELATION_NAME) = ? AND TRIM(RDB$FIELD_NAME) IN ('NRORCAMENTO', 'NRORC')",
        [tabela]
      );
      const col = String(temNr[0].c).trim();
      const [q] = await executar(
        `SELECT (SELECT COUNT(*) FROM ${tabela} WHERE ${col} = ?) AS CASA, (SELECT COUNT(*) FROM ${tabela} WHERE ${col} = ?) AS MOTOR FROM RDB$DATABASE`,
        [casaNr, nrMotor]
      );
      if (Number(q.casa) || Number(q.motor)) {
        /** @type {any} */
        const item = { tabela, casa: Number(q.casa), motor: Number(q.motor) };
        if (Number(q.motor)) {
          // Datas, situação e códigos da linha ligada ao orçamento do Motor —
          // para saber se ela veio antes dele (número já citado) ou depois
          // (alguém o converteu). Nada de texto.
          const cols = await executar(
            `SELECT TRIM(rf.RDB$FIELD_NAME) AS C, f.RDB$FIELD_TYPE AS T FROM RDB$RELATION_FIELDS rf
               JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
              WHERE TRIM(rf.RDB$RELATION_NAME) = ? ORDER BY rf.RDB$FIELD_POSITION`,
            [tabela]
          );
          const uteis = cols
            .map(x => ({ c: String(x.c).trim(), t: Number(x.t) }))
            .filter(x => [7, 8, 16, 12, 13, 35].includes(x.t) && /^(NR|ID|DT|HORA|STATUS|CD(VENDEDOR|CLIENTE|TPENTREGA)|ORIG|TIPO|SITUAC)/.test(x.c))
            .slice(0, 15)
            .map(x => x.c);
          if (uteis.length) {
            const linhas = await executar(`SELECT FIRST 3 ${uteis.join(', ')} FROM ${tabela} WHERE ${col} = ?`, [nrMotor]);
            item.linhasDoMotor = linhas.map(l => {
              /** @type {Record<string, any>} */
              const o = {};
              for (const c of uteis) {
                const v = l[c.toLowerCase()];
                o[c] = v instanceof Date ? v.toISOString() : v;
              }
              return o;
            });
          }
        }
        saida.tabelasLigadas.push(item);
      }
    } catch (err) {
      saida.tabelasLigadas.push({ tabela, erro: err.message });
    }
  }
  return saida;
}

// ── Histórico do Automec ─────────────────────────────────────────────────────

const PALAVRAS_DE_LOG = ['HIST', 'LOG', 'AUDIT', 'ALTERA', 'OCORR', 'RASTRO'];

function textoCurto(v, limite = 160) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) v = fixEncoding(v);
  if (v instanceof Date) return v.toISOString();
  const t = String(v).trim();
  return t.length > limite ? `${t.slice(0, limite)}…(${t.length})` : t;
}

/**
 * Onde o Automec guarda o histórico do orçamento (a aba "Histórico": Incluir,
 * campos alterados, data, usuário) — o orçamento do Motor não aparece lá
 * (JPR, 23/11). Responde, sem gravar nada:
 *  - os gatilhos de ORCAMENTO/ORCPROD e do banco (conexão/transação), com o
 *    trecho do código que insere em outra tabela ou lê contexto da sessão;
 *  - as tabelas com nome de log/histórico, as colunas e as últimas linhas que
 *    citam ORCAMENTO ou o número de um orçamento da casa e do Motor;
 *  - as procedures que gravam nessas tabelas.
 */
async function investigarHistorico(nrMotor, nrCasa) {
  /** @type {any} */
  const saida = { gatilhos: [], tabelas: [], procedures: [] };

  const gatilhos = await executar(
    `SELECT TRIM(RDB$TRIGGER_NAME) AS N, TRIM(RDB$RELATION_NAME) AS R, RDB$TRIGGER_TYPE AS T,
            COALESCE(RDB$TRIGGER_INACTIVE, 0) AS I,
            CAST(SUBSTRING(RDB$TRIGGER_SOURCE FROM 1 FOR 4000) AS VARCHAR(4000) CHARACTER SET OCTETS) AS S
       FROM RDB$TRIGGERS
      WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0
        AND (TRIM(RDB$RELATION_NAME) IN ('ORCAMENTO', 'ORCPROD') OR RDB$RELATION_NAME IS NULL)`
  );
  for (const g of gatilhos) {
    const fonte = g.s === null || g.s === undefined ? '' : fixEncoding(g.s);
    const grava = [...new Set((fonte.match(/INSERT\s+INTO\s+([A-Z0-9_$"]+)/gi) || []).map(x => x.split(/\s+/).pop()))];
    saida.gatilhos.push({
      nome: String(g.n).trim(),
      tabela: g.r === null ? '(banco)' : String(g.r).trim(),
      tipo: Number(g.t),
      inativo: Number(g.i) === 1,
      gravaEm: grava,
      usaContexto: /RDB\$GET_CONTEXT|CURRENT_USER|CURRENT_ROLE/i.test(fonte),
      trecho: textoCurto(fonte.replace(/\s+/g, ' '), 600)
    });
  }

  const filtro = PALAVRAS_DE_LOG.map(() => 'RDB$RELATION_NAME CONTAINING ?').join(' OR ');
  const tabelas = await executar(
    `SELECT TRIM(RDB$RELATION_NAME) AS N FROM RDB$RELATIONS
      WHERE RDB$VIEW_BLR IS NULL AND COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND (${filtro})`,
    PALAVRAS_DE_LOG
  );
  for (const { n } of tabelas.slice(0, 25)) {
    const tabela = String(n).trim();
    if (!/^[A-Z0-9_$]{1,63}$/.test(tabela)) continue;
    /** @type {any} */
    const info = { tabela };
    try {
      const cols = await executar(
        `SELECT TRIM(rf.RDB$FIELD_NAME) AS C, f.RDB$FIELD_TYPE AS T, f.RDB$CHARACTER_LENGTH AS L
           FROM RDB$RELATION_FIELDS rf JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
          WHERE TRIM(rf.RDB$RELATION_NAME) = ? ORDER BY rf.RDB$FIELD_POSITION`,
        [tabela]
      );
      const colunas = cols.map(c => ({ c: String(c.c).trim(), t: Number(c.t), l: Number(c.l) || null }));
      info.colunas = colunas.map(c => `${c.c}:${TIPO_NOMES[c.t] || c.t}${c.l ? `(${c.l})` : ''}`);
      const [{ q }] = await executar(`SELECT COUNT(*) AS Q FROM ${tabela}`);
      info.linhas = Number(q);
      const textos = colunas.filter(c => TIPO_TEXTO.has(c.t) || c.t === TIPO_BLOB);
      // Linhas que citam ORCAMENTO, ou o número de um orçamento da casa/Motor.
      const sel = colunas.map(c =>
        TIPO_TEXTO.has(c.t) || c.t === TIPO_BLOB
          ? `CAST(SUBSTRING(${c.c} FROM 1 FOR 300) AS VARCHAR(300) CHARACTER SET OCTETS) AS ${c.c}`
          : c.c
      ).join(', ');
      for (const [rotulo, alvo] of [['citaOrcamento', 'ORCAMENTO'], ['casa', nrCasa], ['motor', nrMotor]]) {
        if (!alvo || !textos.length) continue;
        const onde = textos.map(c => `${c.c} CONTAINING ?`).join(' OR ');
        const numericas = colunas.filter(c => TIPOS_NUMERICOS.has(c.t)).map(c => c.c);
        const ondeNum = rotulo !== 'citaOrcamento' && numericas.length ? ` OR ${numericas.map(c => `${c} = ?`).join(' OR ')}` : '';
        const params = [...textos.map(() => String(alvo)), ...(ondeNum ? numericas.map(() => Number(alvo)) : [])];
        const linhas = await executar(`SELECT FIRST 2 ${sel} FROM ${tabela} WHERE ${onde}${ondeNum}`, params);
        info[rotulo] = linhas.map(l => {
          /** @type {Record<string, any>} */
          const o = {};
          for (const c of colunas) o[c.c] = textoCurto(l[c.c.toLowerCase()]);
          return o;
        });
      }
    } catch (err) {
      info.erro = err.message;
    }
    saida.tabelas.push(info);
  }

  // Procedures que gravam numa dessas tabelas: o Automec pode chamar uma ao salvar.
  const nomes = saida.tabelas.map(t => t.tabela);
  if (nomes.length) {
    const procs = await executar(
      `SELECT TRIM(RDB$PROCEDURE_NAME) AS N,
              CAST(SUBSTRING(RDB$PROCEDURE_SOURCE FROM 1 FOR 4000) AS VARCHAR(4000) CHARACTER SET OCTETS) AS S
         FROM RDB$PROCEDURES WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0`
    );
    for (const pr of procs) {
      const fonte = pr.s === null || pr.s === undefined ? '' : fixEncoding(pr.s);
      const usa = nomes.filter(n => new RegExp(`\\b${n}\\b`, 'i').test(fonte));
      if (usa.length) saida.procedures.push({ nome: String(pr.n).trim(), tabelas: usa, trecho: textoCurto(fonte.replace(/\s+/g, ' '), 400) });
    }
  }
  return saida;
}

const TIPO_NOMES = { 7: 'SMALLINT', 8: 'INTEGER', 10: 'FLOAT', 12: 'DATE', 13: 'TIME', 14: 'CHAR', 16: 'BIGINT', 27: 'DOUBLE', 35: 'TIMESTAMP', 37: 'VARCHAR', 261: 'BLOB' };

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
  garantirColunaZr,
  compararComACasa,
  compararDois,
  investigarHistorico,
  relatorio,
  esquecerCaches,
  // exportados para teste
  montarInsert,
  montarUpdate,
  aplicarExtras,
  valorDaRegra,
  datasDoOrcamento,
  resolverPrazos,
  linhasDoPedido,
  cabecalhoVariavel,
  chaveDeNome,
  ErroDefinitivo
};
