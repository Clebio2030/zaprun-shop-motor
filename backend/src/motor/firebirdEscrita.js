// motor/firebirdEscrita.js
// Conexão de ESCRITA no Firebird do ERP — a gravação de orçamento (ADR-307 do
// ZapRun). Separada do pool de leitura (firebird.js) de propósito:
//
//  - a extração do catálogo pode segurar uma conexão do pool por minutos; um
//    pedido não pode esperar por ela;
//  - cada pedido é UMA transação, com commit ou rollback explícitos. O
//    db.query do pool é autocommit por comando — gravar cabeçalho e itens
//    assim deixaria orçamento pela metade se o segundo comando falhasse.
//
// Transação READ COMMITTED + REC_VERSION + NOWAIT: lê o último commit sem
// travar em linha que alguém está editando no Automec, e um conflito de lock
// vira erro na hora (o pedido volta na próxima consulta) em vez de uma espera
// sem fim que seguraria todos os outros pedidos.

const firebird = require('node-firebird');

const TIMEOUT_COMANDO_MS = parseInt(process.env.FB_WRITE_TIMEOUT || '30000', 10);

// isc_tpb_version3, isc_tpb_write, isc_tpb_nowait, isc_tpb_read_committed, isc_tpb_rec_version
const TPB_ESCRITA = [3, 9, 7, 15, 17];

function opcoes() {
  return {
    host: process.env.FB_HOST || '127.0.0.1',
    port: Number(process.env.FB_PORT || 3050),
    database: process.env.FB_DATABASE || '',
    user: process.env.FB_USER || 'SYSDBA',
    password: process.env.FB_PASSWORD || 'masterkey',
    lowercase_keys: true,
    role: null,
    pageSize: 4096
  };
}

/** @returns {Promise<any>} */
function conectar() {
  return new Promise((resolve, reject) => {
    firebird.attach(/** @type {any} */ (opcoes()), (err, db) => (err ? reject(err) : resolve(db)));
  });
}

function comTempo(promessa, sql) {
  let timer;
  const limite = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`Firebird: comando passou de ${TIMEOUT_COMANDO_MS} ms: ${String(sql).slice(0, 100)}`), { transitorio: true })),
      TIMEOUT_COMANDO_MS
    );
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

/**
 * Executa `fn(tx)` numa transação. `tx.query(sql, params)` devolve as linhas.
 * Commit se `fn` terminar e `desfazer` for falso; rollback em erro ou quando
 * `desfazer` (o Ensaio) — e o detach sempre.
 *
 * @template T
 * @param {(tx: { query: (sql: string, params?: any[]) => Promise<any[]> }) => Promise<T>} fn
 * @param {{ desfazer?: boolean }} [opcoesTx]
 * @returns {Promise<T>}
 */
async function comTransacao(fn, opcoesTx = {}) {
  const db = await conectar();
  try {
    const transacao = await new Promise((resolve, reject) => {
      db.transaction(TPB_ESCRITA, (err, tx) => (err ? reject(err) : resolve(tx)));
    });
    const t = /** @type {any} */ (transacao);
    const tx = {
      query: (sql, params = []) =>
        comTempo(
          new Promise((resolve, reject) => {
            t.query(sql, params, (err, linhas) => (err ? reject(err) : resolve(linhas || [])));
          }),
          sql
        )
    };
    try {
      const resultado = await fn(tx);
      await new Promise((resolve, reject) => {
        const fim = opcoesTx.desfazer ? t.rollback.bind(t) : t.commit.bind(t);
        fim(err => (err ? reject(err) : resolve(undefined)));
      });
      return resultado;
    } catch (err) {
      await new Promise(resolve => t.rollback(() => resolve(undefined)));
      throw err;
    }
  } finally {
    try {
      db.detach();
    } catch (e) {
      // conexão já caiu; nada a devolver
    }
  }
}

/**
 * Um comando fora de transação explícita (autocommit) — para o DDL da coluna
 * ZR_PEDIDO e para as leituras do relatório.
 *
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Promise<any[]>}
 */
async function executar(sql, params = []) {
  const db = await conectar();
  try {
    return await comTempo(
      new Promise((resolve, reject) => {
        db.query(sql, params, (err, linhas) => (err ? reject(err) : resolve(linhas || [])));
      }),
      sql
    );
  } finally {
    try {
      db.detach();
    } catch (e) {
      // idem
    }
  }
}

// gdscode do Firebird que dizem "tente de novo daqui a pouco".
const LOCK_CONFLICT = 335544345;
const DEADLOCK = 335544336;
const UPDATE_CONFLICT = 335544451;
const UNIQUE_VIOLATION = 335544665;
const NO_DUP = 335544349;

function gdscode(err) {
  return Number(err && (err.gdscode || (err.gdsparams && err.gdscode)));
}

function ehViolacaoDeUnicidade(err) {
  const c = gdscode(err);
  return c === UNIQUE_VIOLATION || c === NO_DUP || /violation of PRIMARY or UNIQUE KEY|attempt to store duplicate/i.test(String(err && err.message));
}

function ehTransitorio(err) {
  const c = gdscode(err);
  if (err && err.transitorio) return true;
  if ([LOCK_CONFLICT, DEADLOCK, UPDATE_CONFLICT].includes(c)) return true;
  return /lock conflict|deadlock|update conflicts|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Connection is closed/i.test(String(err && err.message));
}

module.exports = { comTransacao, executar, ehViolacaoDeUnicidade, ehTransitorio, TPB_ESCRITA };
