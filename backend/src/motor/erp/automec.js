// motor/erp/automec.js
// ERP Automec — Firebird LOCAL, na máquina do cliente.
//
// Este é o Motor como ele sempre foi: a view ZAPRUN_SHOP (sql/views_zaprun_shop.sql)
// é aplicada no boot pelo migrations.js, e o extractor lê dela. Este arquivo só
// dá a esse caminho a mesma cara que os outros ERPs têm (ver erp/index.js) —
// nenhuma regra do Automec mudou aqui.

const firebird = require('node-firebird');
const { logError } = require('../../logger');
const { extrairProdutos, listarEmpresasDoErp } = require('../extractor');
const { runDatabaseMigrations, estadoDasViews } = require('../migrations');
const { lerColunas, TABELAS_PADRAO } = require('../schema');
const { VIEW_SHOP } = require('../mapping');

function opcoesFirebird() {
  return {
    host: process.env.FB_HOST || '127.0.0.1',
    port: Number(process.env.FB_PORT || 3050),
    database: process.env.FB_DATABASE || '',
    user: process.env.FB_USER || 'SYSDBA',
    password: process.env.FB_PASSWORD || 'masterkey',
    lowercase_keys: true,
    role: null,
    pageSize: 4096,
    charset: process.env.FB_CHARSET || 'WIN1252'
  };
}

/**
 * Teste de vida do banco.
 *
 * Conexão própria (fora do pool do motor) porque isto é um teste de vida: se o
 * pool estiver saturado por uma extração em andamento, o health check deve
 * responder mesmo assim — senão o updater interpretaria "ocupado" como
 * "quebrado" e faria rollback de uma versão sadia.
 *
 * @returns {Promise<{ ok: boolean, erro?: string }>}
 */
function testarConexao() {
  return new Promise(resolve => {
    const opcoes = opcoesFirebird();
    if (!opcoes.database) {
      return resolve({ ok: false, erro: 'FB_DATABASE não configurado no backend/.env' });
    }

    firebird.attach(/** @type {any} */ (opcoes), (err, db) => {
      if (err) {
        logError('[ZapRun] Falha ao conectar no Firebird', err);
        return resolve({ ok: false, erro: err.message });
      }
      db.query('SELECT 1 FROM RDB$DATABASE', [], errQ => {
        db.detach();
        if (errQ) {
          logError('[ZapRun] Falha na query de teste do Firebird', errQ);
          return resolve({ ok: false, erro: errQ.message });
        }
        resolve({ ok: true });
      });
    });
  });
}

module.exports = {
  id: 'automec',
  nome: 'Automec (Firebird)',
  origem: `view ${VIEW_SHOP}`,
  view: VIEW_SHOP,
  dicaVazio:
    'confira se a view foi criada e tem dados (GET /produtos no servidor local mostra o erro exato).',
  descreverBanco: () => process.env.FB_DATABASE || '(não configurado)',
  prepararBanco: runDatabaseMigrations,
  estadoDoPreparo: estadoDasViews,
  extrairProdutos,
  listarEmpresasDoErp,
  testarConexao,
  lerColunas: (tabelas = []) => lerColunas(tabelas.length ? tabelas : TABELAS_PADRAO)
};
