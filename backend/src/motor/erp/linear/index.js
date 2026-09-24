// motor/erp/linear/index.js
// ERP Linear Sistemas — MySQL na nuvem da Linear, pela VPN da loja.
//
// Entrega os produtos no MESMO formato do Automec (motor/mapping.js), com dois
// campos a mais que só o Linear informa: `unidade` e `promocao`.

const { logInfo } = require('../../../logger');
const { agruparProdutos, toInt } = require('../../mapping');
const { query, testarConexao, opcoes } = require('./mysql');
const { montarSqlLinear, empresaLinear } = require('./consulta');

/** @typedef {import('../../../types/zaprun-shop').ProdutoCatalogo} ProdutoCatalogo */

/**
 * O código é um GTIN de verdade (EAN-8, UPC, EAN-13, GTIN-14)?
 *
 * Todo produto pesável do Linear tem um código interno de balança no lugar do
 * EAN: "0000000000003" na salsicha a granel, "0000000002147" na abóbora. O
 * servidor aceita 13 dígitos, então esses códigos passariam — e a busca
 * automática de foto por código de barras casaria "0000000000003" com o
 * produto de outra pessoa numa base pública. É o defeito descrito nas
 * armadilhas do CLAUDE.md, com outra cara.
 *
 * Duas conferências, porque cada uma sozinha deixa passar lixo:
 *  • dígito verificador GS1 — o código de balança quase sempre falha nele;
 *  • sem os zeros à esquerda, sobram pelo menos 8 dígitos — "…0003" com o
 *    dígito certo por acaso (1 em 10) ainda não vira EAN.
 *
 * @param {string} codigo
 * @returns {boolean}
 */
function gtinValido(codigo) {
  if (!/^\d+$/.test(codigo)) return false;
  if (![8, 12, 13, 14].includes(codigo.length)) return false;
  if (codigo.replace(/^0+/, '').length < 8) return false;

  const digitos = codigo.split('').map(Number);
  const verificador = /** @type {number} */ (digitos.pop());
  // Da direita para a esquerda, pesos 3,1,3,1… — vale para todo comprimento.
  const soma = digitos
    .reverse()
    .reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (soma % 10)) % 10 === verificador;
}

/**
 * @param {number[]|null} [_empresasPermitidas] não se aplica: a empresa do
 *   Linear vem do LINEAR_EMPRESA, e o produto sai sem IDEMPRESA (empresa única).
 * @param {number|string|null} [cdproduto]
 */
async function extrairProdutos(_empresasPermitidas = null, cdproduto = null) {
  const { sql, params } = montarSqlLinear(toInt(cdproduto));
  const rows = await query(sql, params);

  const { produtos, descartadas, foraDoEscopo } = agruparProdutos(rows, null);

  for (const p of produtos) {
    p.codigos_barra = p.codigos_barra.filter(gtinValido);
  }

  if (descartadas > 0) {
    logInfo(`[ZapRun] ${descartadas} linha(s) do Linear sem código de produto — descartadas.`);
  }

  return { produtos, linhas: rows.length, descartadas, foraDoEscopo };
}

/**
 * Colunas das tabelas pedidas, pelo information_schema. É o equivalente do
 * /diagnostico/colunas do Firebird: lê só o CATÁLOGO do banco, nunca dado.
 *
 * @param {string[]} tabelas
 */
async function lerColunas(tabelas = []) {
  const alvo = (tabelas.length ? tabelas : ['es1', 'es1p', 'es1a_precos', 'es1b'])
    .map(t => String(t).trim())
    .filter(t => /^[A-Za-z0-9_]+$/.test(t));
  if (!alvo.length) return {};

  const rows = await query(
    `SELECT table_name AS tabela, column_name AS coluna, column_type AS tipo, is_nullable AS nulo
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name IN (?)
      ORDER BY table_name, ordinal_position`,
    [alvo]
  );

  /** @type {Record<string, Array<{coluna:string, tipo:string, obrigatorio:boolean}>>} */
  const saida = {};
  for (const t of alvo) saida[t] = [];
  for (const r of rows) {
    const tabela = String(r.tabela ?? r.TABELA ?? '');
    if (!saida[tabela]) saida[tabela] = [];
    saida[tabela].push({
      coluna: String(r.coluna ?? r.COLUNA ?? ''),
      tipo: String(r.tipo ?? r.TIPO ?? ''),
      obrigatorio: String(r.nulo ?? r.NULO ?? '') === 'NO'
    });
  }
  return saida;
}

module.exports = {
  id: 'linear',
  nome: 'Linear Sistemas (MySQL)',
  origem: 'banco do Linear',
  // Sem view: a consulta mora no Motor (consulta.js).
  view: null,
  dicaVazio:
    'confira no Linear se há produtos ativos marcados para loja virtual, e o LINEAR_EMPRESA do backend/.env.',
  descreverBanco: () => {
    const o = opcoes();
    return `${o.user || '?'}@${o.host}:${o.port}/${o.database || '(não configurado)'} (empresa ${empresaLinear()})`;
  },
  // Nada a aplicar: o usuário de BI não cria view, e a consulta mora no Motor.
  prepararBanco: async () => ({ aplicados: 0, falhas: 0 }),
  estadoDoPreparo: () => ({ estado: 'nao-se-aplica', aplicados: 0, falhas: 0, erros: [] }),
  extrairProdutos,
  // Empresa única: o recorte por empresa do token não se aplica ao Linear.
  listarEmpresasDoErp: async () => [],
  testarConexao,
  lerColunas,
  gtinValido
};
