// motor/erp/linear/consulta.js
// A consulta do catálogo no banco do Linear Sistemas.
//
// Faz o papel da view ZAPRUN_SHOP do Automec: devolve UMA LINHA POR CÓDIGO DE
// BARRAS, com os MESMOS nomes de coluna — por isso o agrupamento de
// motor/mapping.js serve aos dois ERPs sem mudança. Não é uma view no banco
// porque o usuário de BI só tem SELECT (ver mysql.js).
//
// ── De onde vem cada coisa (conferido no banco real em 23/09/2026) ──────────
//
//   es1            cadastro por empresa: ativo, preço, promoção, estoque, unidade
//   es1p           descrição (es1_desc) e classificação (família, depto, seção)
//   st_familia     o nível de 18 grupos (RESFRIADOS, BAZAR…) — é o mesmo que a
//                  view_sitemercado do próprio Linear chama de "Departamento"
//   es1a_precos    os códigos de barras do produto (1:N)
//   es1b           a agenda de promoções: início, fim, valor, nome
//
// ── Por que NÃO a view_sitemercado ──────────────────────────────────────────
//
// Ela existe e o filtro dela é o mesmo daqui, mas o preço dela é o preço do
// Linear + 12% (é o preço que a loja cobra na SiteMercado — 14.674 de 14.674
// linhas conferidas). O Shop usa o preço de balcão, `es1_prvarejo`. Ela também
// não traz unidade nem as datas da promoção.
//
// ── Regras ──────────────────────────────────────────────────────────────────
//
// • Produto entra se estiver ATIVO e marcado para LOJA VIRTUAL no cadastro do
//   Linear — a mesma regra da view_sitemercado. Quem decide o que vai para a
//   loja online é o lojista, no sistema dele.
// • Estoque é `es1.es2_qatu` (bate com a view_sitemercado); a tabela `estoques`
//   diverge em 8 mil produtos e não é a que o Linear usa.
// • Promoção: `es1_prpromocao > 0` é o preço promocional que o PDV cobra hoje.
//   Ele só vale se houver uma linha ATIVA na agenda (es1b) para HOJE com esse
//   mesmo valor. É ela que dá o fim da promoção e protege contra o ERP ainda não
//   ter limpado uma promoção vencida (o campo volta a 0 por rotina do Linear,
//   não no minuto em que a promoção acaba).
// • "Hoje" é a data da máquina do cliente, passada como parâmetro, e não o
//   CURDATE() do MySQL: o servidor da Linear pode estar em UTC, e às 21h de
//   Brasília o CURDATE() dele já é amanhã.

/**
 * Linhas que representam a tabela de preço e o depósito únicos do Linear.
 *
 * O contrato do Motor é multi-tabela e multi-depósito (o Automec tem várias).
 * O Linear desta integração tem um preço de venda e um saldo por empresa, então
 * eles saem como a tabela 1 e o depósito 1 — e a tela da Loja não tem o que
 * configurar.
 */
const TABELA_PRECO = 'PRECO DE VENDA';
const DEPOSITO = 'LOJA';

const SQL_BASE = `
SELECT
  e.es1_cod                          AS CDPRODUTO,
  TRIM(p.es1_desc)                   AS PRODUTO_DESCRICAO,
  NULLIF(TRIM(e.es1_observacao), '') AS PRODUTO_OBS,
  TRIM(f.tab_desc)                   AS GRUPO,
  a.es1_codbarra                     AS CODBARRA,
  1                                  AS IDPRECO,
  '${TABELA_PRECO}'                  AS TABELA_PRECO,
  e.es1_prvarejo                     AS PRECO,
  1                                  AS CDDEPOSITO,
  '${DEPOSITO}'                      AS DEPOSITO_DESCRICAO,
  e.es2_qatu                         AS SALDO,
  NULLIF(TRIM(e.es1_um), '')         AS UNIDADE,
  CASE WHEN e.es1_prpromocao > 0 AND pr.es1_cod IS NOT NULL
       THEN e.es1_prpromocao END     AS PROMO_PRECO,
  pr.inicio                          AS PROMO_INICIO,
  pr.fim                             AS PROMO_FIM,
  pr.nome                            AS PROMO_NOME
FROM es1 e
LEFT JOIN es1p p        ON p.es1_cod = e.es1_cod
LEFT JOIN st_familia f  ON f.tab_cod = p.es1_familia
LEFT JOIN es1a_precos a ON a.es1_cod = e.es1_cod AND a.es1_empresa = e.es1_empresa
LEFT JOIN (
  -- Agenda de promoções vigentes HOJE, uma linha por (produto, valor). Quando
  -- duas promoções se sobrepõem com o mesmo valor (aniversário + quinta da
  -- carne), o fim é o da que dura mais, e o nome é o dela.
  SELECT b.es1_cod,
         b.es1_valor AS valor,
         MIN(b.es1_dtini) AS inicio,
         MAX(b.es1_dtfim) AS fim,
         SUBSTRING_INDEX(
           GROUP_CONCAT(TRIM(n.tab_desc) ORDER BY b.es1_dtfim DESC SEPARATOR '\\n'),
           '\\n', 1
         ) AS nome
    FROM es1b b
    LEFT JOIN st_nomepromocao n ON n.tab_cod = b.nomepromocao
   WHERE b.es1_empresa = ?
     AND b.es1b_ativo = 1
     AND ? BETWEEN b.es1_dtini AND b.es1_dtfim
   GROUP BY b.es1_cod, b.es1_valor
) pr ON pr.es1_cod = e.es1_cod AND ABS(pr.valor - e.es1_prpromocao) < 0.005
WHERE e.es1_empresa = ?
  AND e.es1_ativo = '1'
  AND e.es1_lojavirtual = 1`;

/** Empresa do Linear (es1_empresa). A loja desta integração é a 1. */
function empresaLinear() {
  const n = parseInt(process.env.LINEAR_EMPRESA || '1', 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** 'YYYY-MM-DD' no calendário da máquina do cliente. */
function hojeLocal(agora = new Date()) {
  const m = String(agora.getMonth() + 1).padStart(2, '0');
  const d = String(agora.getDate()).padStart(2, '0');
  return `${agora.getFullYear()}-${m}-${d}`;
}

/**
 * Monta o SELECT do catálogo, com filtro opcional por produto.
 *
 * `ORDER BY e.es1_cod` pelo mesmo motivo da view do Automec: mantém as linhas de
 * um produto juntas e a ordem estável entre ciclos.
 *
 * @param {number|null} [cdproduto] filtra um produto só (rota /produtos)
 * @param {Date} [agora]
 * @returns {{ sql: string, params: Array<number|string> }}
 */
function montarSqlLinear(cdproduto = null, agora = new Date()) {
  const empresa = empresaLinear();
  const params = [empresa, hojeLocal(agora), empresa];

  if (cdproduto === null || cdproduto === undefined) {
    return { sql: `${SQL_BASE}\nORDER BY e.es1_cod`, params };
  }
  return {
    sql: `${SQL_BASE}\n  AND e.es1_cod = ?\nORDER BY e.es1_cod`,
    params: [...params, cdproduto]
  };
}

module.exports = { montarSqlLinear, hojeLocal, empresaLinear, TABELA_PRECO, DEPOSITO };
