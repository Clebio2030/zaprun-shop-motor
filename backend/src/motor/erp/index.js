// motor/erp/index.js
// Qual ERP esta instalação lê — decidido por ERP_TIPO no backend/.env.
//
// É uma das poucas decisões que moram legitimamente no .env: o ERP é um fato
// DAQUELA máquina, escolhido na instalação, e não uma política da frota.
//
// Ausente = 'automec'. Não é só conveniência: é o que mantém funcionando as
// instalações que já existiam antes desta escolha — o .env delas é preservado
// pelo updater e nunca vai ganhar a chave sozinho.
//
// Cada adaptador expõe a mesma forma:
//   id, nome, origem, dicaVazio        identificação e textos de diagnóstico
//   view                               nome da view no banco (null se não há)
//   descreverBanco()                   o que o /status mostra como "banco"
//   prepararBanco(), estadoDoPreparo() views aplicadas no boot (só o Automec)
//   extrairProdutos(permitidas, cd)    { produtos, linhas, descartadas, foraDoEscopo }
//   listarEmpresasDoErp()              diagnóstico de "nenhum produto"
//   testarConexao()                    { ok, erro? } — o /health usa
//   lerColunas(tabelas)                /diagnostico/colunas
//
// Os adaptadores são carregados SOB DEMANDA: o do Linear puxa o mysql2, que as
// instalações Automec atualizadas pelo updater não têm (ver linear/mysql.js).

const ERPS_SUPORTADOS = ['automec', 'linear'];

/** O ERP configurado nesta máquina, normalizado. */
function tipoErp() {
  return String(process.env.ERP_TIPO || 'automec').trim().toLowerCase();
}

/** @type {any} */
let _adaptador = null;

/**
 * O adaptador do ERP desta instalação.
 *
 * ERP_TIPO desconhecido LANÇA, com a lista do que existe. Cair em silêncio no
 * Automec faria uma instalação Linear com erro de digitação tentar abrir um
 * Firebird que não existe — e o erro diria "FB_DATABASE", o que manda o
 * implantador procurar o problema no lugar errado.
 */
function erp() {
  if (_adaptador) return _adaptador;

  const tipo = tipoErp();
  if (tipo === 'automec') _adaptador = require('./automec');
  else if (tipo === 'linear') _adaptador = require('./linear');
  else {
    throw new Error(
      `ERP_TIPO="${tipo}" no backend/.env não é suportado. Use um de: ${ERPS_SUPORTADOS.join(', ')}.`
    );
  }
  return _adaptador;
}

module.exports = { erp, tipoErp, ERPS_SUPORTADOS };
