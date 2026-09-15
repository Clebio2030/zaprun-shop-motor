// motor/extractor.js
// Lê a view de produtos do Firebird do cliente e devolve os produtos já
// agrupados, no formato do payload da API.
//
// Fino de propósito: quem conhece o formato do ERP é motor/mapping.js. Aqui só
// existe "consultar a view e agrupar". Trocar de ERP não deve encostar neste
// arquivo.

const { query } = require('./firebird');
const { logInfo, logWarn } = require('../logger');
const { montarSqlProdutos, SQL_EMPRESAS, agruparProdutos, VIEW_SHOP } = require('./mapping');

/** @typedef {import('../types/zaprun-shop').ProdutoCatalogo} ProdutoCatalogo */

/**
 * Descobre quais IDEMPRESA existem na view do ERP.
 *
 * Serve para diagnóstico à distância: se o token autoriza a empresa 1 e o ERP
 * só tem a 3, o log diz isso em vez de reportar "nenhum produto".
 *
 * Em ERP de empresa única a view não tem IDEMPRESA e esta consulta falha com
 * "Column unknown" — o que não é erro nenhum aqui, é a resposta "não é
 * multiempresa". Por isso devolve lista vazia em vez de propagar.
 *
 * @returns {Promise<number[]>}
 */
async function listarEmpresasDoErp() {
  let rows;
  try {
    rows = await query(SQL_EMPRESAS, []);
  } catch (err) {
    logInfo(`[ZapRun] View ${VIEW_SHOP} sem coluna IDEMPRESA (ERP de empresa única).`);
    return [];
  }

  const ids = [];
  for (const row of rows) {
    const v = row.IDEMPRESA ?? row.idempresa;
    const n = Number(v);
    if (Number.isFinite(n)) ids.push(n);
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * Extrai os produtos do catálogo do ERP.
 *
 * Não há janela incremental aqui, e isso é deliberado: catálogo não tem data de
 * emissão. Um produto pode ter o preço alterado sem que nenhuma coluna de data
 * mude, então qualquer filtro temporal perderia alteração de preço — que é
 * justamente o que o Shop precisa ver. O ciclo lê o catálogo inteiro e usa o
 * hash do syncState para não reenviar o que não mudou.
 *
 * @param {number[]|null} [empresasPermitidas] IDEMPRESA que o token autoriza (null = todas)
 * @param {number|string|null} [cdproduto] limita a um produto (diagnóstico)
 * @returns {Promise<{ produtos: ProdutoCatalogo[], linhas: number, descartadas: number, foraDoEscopo: number }>}
 */
async function extrairProdutos(empresasPermitidas = null, cdproduto = null) {
  const { sql, params } = montarSqlProdutos(cdproduto);
  const rows = await query(sql, params);

  const { produtos, descartadas, foraDoEscopo } = agruparProdutos(rows, empresasPermitidas);

  // Descarte é anomalia da view (linha sem CDPRODUTO), não rotina. Precisa
  // aparecer no log — é o único sinal de que a view está devolvendo lixo, e
  // ninguém tem RDP na máquina do cliente para descobrir.
  if (descartadas > 0) {
    logWarn(
      `[ZapRun] ${descartadas} linha(s) de ${VIEW_SHOP} sem CDPRODUTO — descartadas. Verifique a view.`
    );
  }
  if (foraDoEscopo > 0) {
    logInfo(`[ZapRun] ${foraDoEscopo} linha(s) de empresa não autorizada pelo token — ignoradas.`);
  }

  return { produtos, linhas: rows.length, descartadas, foraDoEscopo };
}

module.exports = { extrairProdutos, listarEmpresasDoErp };
