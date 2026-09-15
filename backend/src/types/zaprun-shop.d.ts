// types/zaprun-shop.d.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Contrato de tipos do Motor ZapRun Shop.
// ─────────────────────────────────────────────────────────────────────────────
//
// O runtime do Motor é JavaScript (CommonJS) de propósito: na máquina do cliente
// o nssm executa `node src/server.js` direto, sem etapa de build — um `dist/`
// quebraria o instalador e o updater (que sincroniza `managedPaths` de código
// fonte). Os tipos vivem aqui e são aplicados por JSDoc nos .js, então
// `npm run typecheck` (tsc --noEmit --checkJs) valida o código de verdade,
// sem nada para compilar no cliente.
//
// Quem mexer aqui mexe também em motor/mapping.js — os dois descrevem o mesmo
// contrato, um para o compilador e outro para o runtime.

// ── Lado do banco ────────────────────────────────────────────────────────────

/**
 * Colunas de TEXTO da view chegam como Buffer, não string.
 *
 * A view precisa emiti-las com `CAST(col AS VARCHAR(n) CHARACTER SET OCTETS)`
 * (ver sql/views_zaprun_shop.sql). Sem isso o node-firebird decodifica bytes
 * WIN1252 como UTF-8 e todo acento vira U+FFFD — perda irreversível na leitura.
 * Quem converte de volta para string é motor/encoding.js.
 */
type ColunaTexto = string | Buffer | null;

/** Coluna numérica. O driver pode devolver string em campos calculados. */
type ColunaNumero = number | string | null;

/**
 * UMA LINHA crua da view `ZAPRUN_SHOP`.
 *
 * A view é plana e relacional: por causa dos relacionamentos 1:N (código de
 * barras, tabela de preço e depósito), o MESMO produto aparece em várias
 * linhas — o produto 8390 com 2 códigos de barra, 3 tabelas de preço e 4
 * depósitos ocupa até 2 × 3 × 4 = 24 linhas, com o cabeçalho repetido em todas.
 * Reduzir isso a um objeto por produto é o trabalho de agruparProdutos().
 *
 * Nomes em CAIXA ALTA porque é assim que a view os declara. Em runtime o driver
 * está configurado com `lowercase_keys: true` (motor/firebird.js), então as
 * chaves chegam minúsculas — por isso todo acesso passa por `col()`/`readText`,
 * que toleram os dois casos, e por isso o index signature abaixo existe.
 *
 * Toda coluna é opcional: a view usa LEFT JOIN, então produto sem código de
 * barras, sem preço ou sem estoque devolve NULL nessas colunas em vez de sumir.
 */
interface ZapRunShopRow {
  /** Chave do produto no ERP. Única coluna obrigatória — sem ela a linha é descartada. */
  CDPRODUTO?: ColunaNumero;
  PRODUTO_DESCRICAO?: ColunaTexto;
  GRUPO?: ColunaTexto;

  /** 1:N — texto, nunca número: código de barras tem zero à esquerda e estoura 2^53. */
  CODBARRA?: ColunaTexto;

  /** 1:N — tabela de preço. */
  IDPRECO?: ColunaNumero;
  TABELA_PRECO?: ColunaTexto;
  PRECO?: ColunaNumero;

  /** 1:N — saldo por depósito. */
  CDDEPOSITO?: ColunaNumero;
  DEPOSITO_DESCRICAO?: ColunaTexto;
  SALDO?: ColunaNumero;

  /**
   * Opcional. Quando a view multiempresa a traz, o Motor recorta os produtos
   * pelas empresas que o token autoriza; quando não vem, todos os produtos são
   * da empresa do token. Ver agruparProdutos().
   */
  IDEMPRESA?: ColunaNumero;

  /** Colunas extras da view chegam aqui e são preservadas em `raw`. */
  [coluna: string]: unknown;
}

// ── Lado do ZapRun ───────────────────────────────────────────────────────────

/** Um preço do produto numa tabela de preço do ERP. */
interface ProdutoPreco {
  idpreco: number | null;
  tabela: string | null;
  preco: number | null;
}

/** O saldo do produto em um depósito. */
interface ProdutoEstoque {
  cddeposito: number | null;
  deposito: string | null;
  saldo: number | null;
}

/**
 * Um produto já agrupado — o objeto que vai para a API e vira StoreProduct no
 * catálogo do ZapRun Shop.
 *
 * As chaves seguem o contrato acordado (minúsculas, `codigos_barra` em
 * snake_case). Não é o estilo do resto do Motor, mas é um CONTRATO DE API: o
 * servidor já espera exatamente estas chaves, e renomear aqui quebraria a
 * ingestão sem aviso.
 *
 * Os três arrays nunca contêm null: uma linha sem código de barras, sem preço
 * ou sem depósito simplesmente não contribui com entrada. Array vazio é a
 * resposta honesta para "esse produto não tem preço cadastrado" — e é
 * diferente de `null`, que significaria "não sei".
 */
interface ProdutoCatalogo {
  cdproduto: number;
  descricao: string | null;
  grupo: string | null;
  codigos_barra: string[];
  precos: ProdutoPreco[];
  estoque: ProdutoEstoque[];
  /** Empresa do ERP. `null` quando a view não tem IDEMPRESA (instalação de empresa única). */
  erpCompanyId?: number | null;
  /** A primeira linha crua do grupo, já JSON-serializável. Ver mapping.rawSerializavel. */
  raw?: Record<string, unknown>;
}

/** Resultado do agrupamento, com as contagens que vão para o log. */
interface ResultadoAgrupamento {
  produtos: ProdutoCatalogo[];
  /** Linhas sem CDPRODUTO válido. Anomalia da view — sempre logadas. */
  descartadas: number;
  /** Linhas de empresa que o token não autoriza. */
  foraDoEscopo: number;
}

/** Envelope de um POST /erp/produtos/sync. */
interface PayloadSync {
  dataReferencia: string;
  syncMode: 'full' | 'incremental';
  sourceVersion: string;
  snapshotId: string;
  erpCompanyId: number | null;
  expectedTotal: number;
  chunkInfo: { atual: number; total: number };
  produtos: ProdutoCatalogo[];
}

/** O que a API devolve — é `persisted.received` que autoriza gravar o hash. */
interface RespostaSync {
  ok: boolean;
  persisted?: {
    received?: number;
    inserted?: number;
    updated?: number;
    unchanged?: number;
    rejected?: Array<string | number>;
  };
  erro?: string;
}

export {
  ColunaTexto,
  ColunaNumero,
  ZapRunShopRow,
  ProdutoPreco,
  ProdutoEstoque,
  ProdutoCatalogo,
  ResultadoAgrupamento,
  PayloadSync,
  RespostaSync
};
