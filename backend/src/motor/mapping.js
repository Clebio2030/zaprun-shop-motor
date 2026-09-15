// motor/mapping.js
// ─────────────────────────────────────────────────────────────────────────────
//  ⚠️  ESTE É O ÚNICO ARQUIVO QUE MUDA QUANDO O ERP MUDA.
// ─────────────────────────────────────────────────────────────────────────────
//
// Ele traduz as LINHAS da view Firebird `ZAPRUN_SHOP` nos OBJETOS de produto que
// a API do ZapRun grava no catálogo do Shop. Todo o resto do Motor (ciclo,
// lotes, retry, estado) é agnóstico ao formato do ERP — trocar de ERP é trocar
// a view + este arquivo.
//
// ── O problema que este arquivo resolve ─────────────────────────────────────
//
// A view é PLANA e RELACIONAL. Um produto tem N códigos de barra, N preços
// (um por tabela) e N saldos (um por depósito), e os LEFT JOINs devolvem o
// PRODUTO CARTESIANO dessas três dimensões. O produto 8390, com 2 códigos de
// barra, 3 tabelas de preço e 4 depósitos, ocupa 2 × 3 × 4 = 24 linhas:
//
//   CDPRODUTO  CODBARRA        IDPRECO  TABELA    CDDEPOSITO  SALDO
//   8390       7908572802578   1        CARTAO    1004        319.19
//   8390       7908572802578   1        CARTAO    1005          0.00
//   8390       7908572802578   2        DINHEIRO  1004        319.19   ← repete
//   8390       7891234567890   1        CARTAO    1004        319.19   ← repete
//   ...
//
// Empilhar cada linha nos arrays daria 24 códigos de barra num produto que tem
// 2. Por isso cada dimensão é DEDUPLICADA pela sua própria chave (o código, o
// IDPRECO, o CDDEPOSITO) enquanto o reduce caminha pelas linhas. É a diferença
// entre um catálogo correto e um catálogo com o mesmo preço repetido 12 vezes.
//
// ── Contrato da view ────────────────────────────────────────────────────────
//
// Coluna OBRIGATÓRIA:
//   CDPRODUTO            chave do produto no ERP → identidade e idempotência
//
// Colunas OPCIONAIS (LEFT JOIN: ausência vira array vazio, nunca null no array):
//   PRODUTO_DESCRICAO, GRUPO
//   CODBARRA
//   IDPRECO, TABELA_PRECO, PRECO
//   CDDEPOSITO, DEPOSITO_DESCRICAO, SALDO
//   IDEMPRESA            só em ERP multiempresa (ver agruparProdutos)
//
// Toda coluna de TEXTO precisa sair da view como
//   CAST(campo AS VARCHAR(n) CHARACTER SET OCTETS)
// senão os acentos se perdem. Ver motor/encoding.js.

const { readTextOrNull } = require('./encoding');

/** @typedef {import('../types/zaprun-shop').ZapRunShopRow} ZapRunShopRow */
/** @typedef {import('../types/zaprun-shop').ProdutoCatalogo} ProdutoCatalogo */
/** @typedef {import('../types/zaprun-shop').ProdutoPreco} ProdutoPreco */
/** @typedef {import('../types/zaprun-shop').ProdutoEstoque} ProdutoEstoque */
/** @typedef {import('../types/zaprun-shop').ResultadoAgrupamento} ResultadoAgrupamento */

/**
 * Índices de deduplicação de UM produto — um Set por dimensão 1:N.
 * Estrutura de trabalho do reduce; nunca sai daqui. Ver agruparProdutos.
 * @typedef {{ codigos: Set<string>, precos: Set<string>, depositos: Set<string> }} IndiceDedup
 */

/**
 * Acumulador do reduce: os produtos em construção, os índices de cada um, e as
 * contagens de anomalia.
 * @typedef {{
 *   porChave: Map<string, ProdutoCatalogo>,
 *   indices: Map<string, IndiceDedup>,
 *   descartadas: number,
 *   foraDoEscopo: number
 * }} AcumuladorAgrupamento
 */

// Nome da view. Se a view do cliente tiver outro nome, mude AQUI e em
// sql/views_zaprun_shop.sql — em nenhum outro lugar.
const VIEW_SHOP = 'ZAPRUN_SHOP';

/**
 * Monta o SELECT da view, com filtro opcional por produto.
 *
 * O `ORDER BY CDPRODUTO` não é estético: ele mantém as linhas de um mesmo
 * produto juntas e a ordem estável entre ciclos. Sem ordem estável o hash do
 * syncState mudaria sozinho e o Motor reenviaria o catálogo inteiro a cada
 * ciclo.
 *
 * O `cdproduto` vai como PARÂMETRO (`?`), nunca interpolado: é entrada externa
 * (query param de uma rota HTTP) e concatenar viraria injeção de SQL.
 *
 * @param {number|string|null} [cdproduto] filtra um produto só; ausente = todos
 * @returns {{ sql: string, params: Array<number> }}
 */
function montarSqlProdutos(cdproduto = null) {
  const codigo = toInt(cdproduto);

  if (codigo === null) {
    return { sql: `SELECT * FROM ${VIEW_SHOP} ORDER BY CDPRODUTO`, params: [] };
  }
  return {
    sql: `SELECT * FROM ${VIEW_SHOP} WHERE CDPRODUTO = ? ORDER BY CDPRODUTO`,
    params: [codigo]
  };
}

// SELECT das empresas presentes na view. Usado só no diagnóstico de "nenhum
// produto": distingue "a view está vazia" de "o token autoriza outra empresa".
const SQL_EMPRESAS = `SELECT DISTINCT IDEMPRESA FROM ${VIEW_SHOP}`;

// ── Helpers de leitura ──────────────────────────────────────────────────────

/** Lê uma coluna tolerando MAIÚSCULA/minúscula. Ausente → undefined. */
function col(row, nome) {
  if (!row) return undefined;
  if (row[nome] !== undefined) return row[nome];
  return row[String(nome).toLowerCase()];
}

/** Número ou null. Aceita "1.234,56" e "1234.56". Nunca lança. */
function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (Buffer.isBuffer(v)) return toNumber(v.toString('latin1'));
  const s = String(v).trim();
  if (s === '') return null;
  // "1.234,56" (pt-BR) → "1234.56"
  const normalizado = /,\d{1,2}$/.test(s)
    ? s.replace(/\./g, '').replace(',', '.')
    : s.replace(/,/g, '');
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

/** Inteiro ou null. */
function toInt(v) {
  const n = toNumber(v);
  return n === null ? null : Math.trunc(n);
}

/**
 * Código de barras → string, ou null quando não há.
 *
 * SEMPRE texto, nunca número: EAN/GTIN admite zero à esquerda ("0001234567890"),
 * e um GTIN-14 chega perto do limite de inteiro seguro do JS. Passar por Number
 * apagaria o zero e, no limite, arredondaria o código — um produto com o código
 * errado é um produto que o leitor do caixa nunca encontra.
 *
 * "0" e "000000" são descartados: é como o ERP marca "sem código", e cadastrar
 * isso no catálogo criaria produtos diferentes com o mesmo código de barras.
 */
function toCodigoBarras(v) {
  const s = readTextOrNull({ v }, 'v');
  if (s === null) return null;
  const limpo = s.trim();
  if (limpo === '') return null;
  if (/^0+$/.test(limpo)) return null;
  return limpo;
}

/**
 * Converte a linha crua num objeto JSON-serializável, decodificando os Buffers
 * (OCTETS) para texto. É isto que vai no campo `raw` — precisa ser JSON puro,
 * senão o Buffer viraria `{"type":"Buffer","data":[...]}` no servidor.
 */
function rawSerializavel(row) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (Buffer.isBuffer(v)) out[k] = readTextOrNull({ [k]: v }, k);
    else if (v instanceof Date) out[k] = Number.isNaN(v.getTime()) ? null : v.toISOString();
    else out[k] = v;
  }
  return out;
}

// ── Mapeamento de uma linha ─────────────────────────────────────────────────

/**
 * O cabeçalho do produto, lido da PRIMEIRA linha do grupo.
 *
 * As demais linhas do mesmo produto repetem estes campos; ler de novo só
 * gastaria CPU. Os três arrays nascem vazios e são preenchidos pelo reduce.
 *
 * @param {ZapRunShopRow} row
 * @param {number} cdproduto
 * @returns {ProdutoCatalogo}
 */
function mapCabecalho(row, cdproduto) {
  return {
    cdproduto,
    descricao: readTextOrNull(row, 'PRODUTO_DESCRICAO'),
    grupo: readTextOrNull(row, 'GRUPO'),
    codigos_barra: [],
    precos: [],
    estoque: [],
    erpCompanyId: toInt(col(row, 'IDEMPRESA')),
    raw: rawSerializavel(row)
  };
}

/**
 * Preço a partir de uma linha, ou null quando a linha não carrega preço.
 *
 * "Carrega preço" = tem PRECO. Sem valor não há o que exibir no catálogo, e
 * uma entrada `{ idpreco: 3, tabela: "ATACADO", preco: null }` seria pior que
 * a ausência: o servidor a trataria como preço zero.
 *
 * @param {ZapRunShopRow} row
 * @returns {ProdutoPreco|null}
 */
function mapPreco(row) {
  const preco = toNumber(col(row, 'PRECO'));
  if (preco === null) return null;

  return {
    idpreco: toInt(col(row, 'IDPRECO')),
    tabela: readTextOrNull(row, 'TABELA_PRECO'),
    preco
  };
}

/**
 * Saldo a partir de uma linha, ou null quando a linha não carrega depósito.
 *
 * Aqui a regra é o DEPÓSITO, não o saldo: saldo 0 (ou negativo) é informação
 * legítima — "o depósito existe e está zerado" é o que deixa o Shop marcar o
 * produto como esgotado em vez de escondê-lo. Descartar por `!saldo` apagaria
 * justamente os zeros.
 *
 * @param {ZapRunShopRow} row
 * @returns {ProdutoEstoque|null}
 */
function mapEstoque(row) {
  const cddeposito = toInt(col(row, 'CDDEPOSITO'));
  const deposito = readTextOrNull(row, 'DEPOSITO_DESCRICAO');
  if (cddeposito === null && deposito === null) return null;

  return {
    cddeposito,
    deposito,
    saldo: toNumber(col(row, 'SALDO'))
  };
}

// ── Agrupamento ─────────────────────────────────────────────────────────────

/**
 * Chave de identidade de uma linha: o produto dentro da empresa.
 *
 * Em ERP multiempresa o mesmo CDPRODUTO existe em empresas diferentes com
 * preços diferentes; agrupar só por CDPRODUTO misturaria os catálogos. Quando a
 * view não traz IDEMPRESA (instalação de empresa única), a chave é só o código.
 *
 * @returns {string|null} null quando a linha não tem CDPRODUTO — linha inútil.
 */
function chaveDaLinha(row) {
  const cdproduto = toInt(col(row, 'CDPRODUTO'));
  if (cdproduto === null) return null;

  const idEmpresa = toInt(col(row, 'IDEMPRESA'));
  return idEmpresa === null ? `${cdproduto}` : `${idEmpresa}::${cdproduto}`;
}

/**
 * Linhas planas da view → lista de produtos aninhados, prontos para o catálogo.
 *
 * Faz UMA passada com `.reduce()`. O acumulador carrega:
 *   • `porChave`  Map chave → produto em construção (preserva a ordem de chegada)
 *   • `indices`   Map chave → os três Sets/Map de deduplicação daquele produto
 *
 * Os índices existem por causa do produto cartesiano descrito no topo do
 * arquivo: sem eles, um produto com 2 códigos × 3 preços × 4 depósitos sairia
 * com 24 entradas em cada array em vez de 2, 3 e 4. Eles são estrutura de
 * trabalho e NÃO entram no objeto final — ficam num Map paralelo justamente
 * para o produto continuar sendo JSON puro, serializável sem limpeza.
 *
 * Chaves de deduplicação, uma por dimensão:
 *   • código de barras → o próprio código
 *   • preço           → IDPRECO, ou o nome da tabela quando IDPRECO é nulo
 *   • estoque         → CDDEPOSITO, ou o nome do depósito quando nulo
 *
 * @param {ZapRunShopRow[]} rows
 * @param {number[]|null} [empresasPermitidas] IDEMPRESA que o token autoriza (null = todas)
 * @returns {ResultadoAgrupamento}
 */
function agruparProdutos(rows, empresasPermitidas = null) {
  // `permitidas` é null quando não há recorte — e é o próprio null que serve de
  // condição adiante, em vez de um booleano separado: dois nomes para o mesmo
  // fato é como eles saem de sincronia.
  const permitidas =
    Array.isArray(empresasPermitidas) && empresasPermitidas.length > 0
      ? new Set(empresasPermitidas.map(Number))
      : null;

  /** @type {AcumuladorAgrupamento} */
  const inicial = {
    porChave: new Map(),
    indices: new Map(),
    descartadas: 0,
    foraDoEscopo: 0
  };

  const acumulado = (rows || []).reduce(
    (acc, row) => {
      // 1. Identidade. Linha sem CDPRODUTO é anomalia da view — contada, nunca
      //    ignorada em silêncio ("a qualidade é o dado").
      const chave = chaveDaLinha(row);
      if (chave === null) {
        acc.descartadas++;
        return acc;
      }

      // 2. Recorte por empresa, quando a view é multiempresa e o token limita.
      if (permitidas) {
        const idEmpresa = toInt(col(row, 'IDEMPRESA'));
        if (idEmpresa !== null && !permitidas.has(idEmpresa)) {
          acc.foraDoEscopo++;
          return acc;
        }
      }

      // 3. Primeira linha do produto: monta o cabeçalho e abre os índices de
      //    deduplicação. As linhas seguintes só contribuem com as pontas 1:N.
      //    Os dois Maps são preenchidos na MESMA condição, de propósito: é o
      //    que garante que todo produto tem índice e nenhum índice fica órfão.
      //    Buscar o índice separadamente depois abriria a porta para os dois
      //    saírem de sincronia — e o compilador cobraria o `undefined`.
      let produto = acc.porChave.get(chave);
      let indice = acc.indices.get(chave);
      if (!produto || !indice) {
        produto = mapCabecalho(row, /** @type {number} */ (toInt(col(row, 'CDPRODUTO'))));
        indice = { codigos: new Set(), precos: new Set(), depositos: new Set() };
        acc.porChave.set(chave, produto);
        acc.indices.set(chave, indice);
      }

      // 4. Código de barras (1:N) — descarta nulo e repetido.
      const codigo = toCodigoBarras(col(row, 'CODBARRA'));
      if (codigo !== null && !indice.codigos.has(codigo)) {
        indice.codigos.add(codigo);
        produto.codigos_barra.push(codigo);
      }

      // 5. Preço (1:N) — uma entrada por tabela de preço.
      const preco = mapPreco(row);
      if (preco !== null) {
        const chavePreco = preco.idpreco !== null ? `id:${preco.idpreco}` : `tab:${preco.tabela}`;
        if (!indice.precos.has(chavePreco)) {
          indice.precos.add(chavePreco);
          produto.precos.push(preco);
        }
      }

      // 6. Estoque (1:N) — uma entrada por depósito.
      const estoque = mapEstoque(row);
      if (estoque !== null) {
        const chaveDeposito =
          estoque.cddeposito !== null ? `cd:${estoque.cddeposito}` : `nome:${estoque.deposito}`;
        if (!indice.depositos.has(chaveDeposito)) {
          indice.depositos.add(chaveDeposito);
          produto.estoque.push(estoque);
        }
      }

      return acc;
    },
    inicial
  );

  return {
    produtos: [...acumulado.porChave.values()],
    descartadas: acumulado.descartadas,
    foraDoEscopo: acumulado.foraDoEscopo
  };
}

/**
 * O mesmo produto, sem os campos internos do Motor.
 *
 * `erpCompanyId` e `raw` servem ao ciclo de sincronização (recorte por empresa e
 * diagnóstico); quem consulta a rota HTTP local quer o contrato puro do
 * catálogo. Filtrar na saída é mais barato que manter duas árvores de objeto.
 *
 * @param {ProdutoCatalogo} produto
 * @returns {ProdutoCatalogo}
 */
function apenasContrato(produto) {
  return {
    cdproduto: produto.cdproduto,
    descricao: produto.descricao,
    grupo: produto.grupo,
    codigos_barra: produto.codigos_barra,
    precos: produto.precos,
    estoque: produto.estoque
  };
}

module.exports = {
  VIEW_SHOP,
  SQL_EMPRESAS,
  montarSqlProdutos,
  agruparProdutos,
  apenasContrato,
  mapCabecalho,
  mapPreco,
  mapEstoque,
  chaveDaLinha,
  rawSerializavel,
  toCodigoBarras,
  toNumber,
  toInt
};
