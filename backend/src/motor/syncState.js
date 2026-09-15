// motor/syncState.js
// Estado local do Motor, gravado em backend/sync_state.json.
//
// O arquivo é PRESERVADO pelo updater (preservePaths), então ele guarda só o
// que é legítimo por-máquina: um hash do catálogo para pular ciclo sem mudança
// e a marca do último envio confirmado. Nunca guarde config de frota aqui —
// isso vem do handshake.
//
// Formato (uma entrada por IDEMPRESA do ERP; "0" quando a view é de empresa
// única e não traz IDEMPRESA):
//   { "1": { "hash": "...", "lastSyncedAt": "2026-09-15T12:00:00.000Z" } }
//
// Ausência de entrada = empresa nunca sincronizada. Isso é o que torna o Motor
// auto-curável: apagar o arquivo força um reenvio completo do catálogo, e nada
// mais.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logError } = require('../logger');

/** @typedef {import('../types/zaprun-shop').ProdutoCatalogo} ProdutoCatalogo */

// Sobrescrevível por env para testes isolados (não toca no estado de produção).
const STATE_FILE_PATH =
  process.env.ZAPRUN_STATE_FILE || path.join(__dirname, '..', '..', 'sync_state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    }
  } catch (err) {
    // Estado corrompido não pode derrubar o serviço: tratamos como "nunca
    // sincronizou" e o próximo ciclo reconstrói tudo.
    logError('[ZapRun] Erro ao ler sync_state.json (será tratado como vazio):', err);
  }
  return {};
}

function saveState(state) {
  try {
    // Escrita atômica: grava num temporário e renomeia. Sem isto, uma queda de
    // energia no meio do writeFileSync deixaria um JSON truncado — e o Motor
    // reenviaria o catálogo inteiro no próximo boot.
    const tmp = `${STATE_FILE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE_PATH);
  } catch (err) {
    logError('[ZapRun] Erro ao salvar sync_state.json:', err);
  }
}

/**
 * Hash estável de um catálogo.
 *
 * "Estável" aqui é o requisito inteiro: se o mesmo catálogo produzir hashes
 * diferentes em dois ciclos, o Motor reenvia milhares de produtos por nada; se
 * produzir o MESMO hash para catálogos diferentes, uma alteração de preço nunca
 * chega ao Shop. Daí as três precauções:
 *
 *  1. Os produtos são ordenados por `cdproduto` antes de entrar no hash — a
 *     view ordena por CDPRODUTO, mas confiar na ordem do ERP é como confiar em
 *     ORDER BY ausente.
 *  2. Os arrays 1:N (preços, depósitos, códigos de barra) também são ordenados.
 *     A view só tem `ORDER BY CDPRODUTO`: a ordem dos preços DENTRO de um
 *     produto é indefinida e pode variar entre execuções do mesmo SELECT.
 *  3. `raw` fica de FORA: carrega colunas voláteis do ERP (timestamps de log,
 *     contadores) que mudam sem que o produto tenha mudado.
 *
 * @param {ProdutoCatalogo[]} produtos
 * @returns {string}
 */
function generateHash(produtos) {
  const hash = crypto.createHash('md5');

  const ordenados = [...(produtos || [])].sort(
    (a, b) => Number(a.cdproduto) - Number(b.cdproduto)
  );

  for (const p of ordenados) {
    hash.update(
      JSON.stringify({
        cdproduto: p.cdproduto,
        descricao: p.descricao,
        grupo: p.grupo,
        codigos_barra: [...(p.codigos_barra || [])].sort(),
        precos: [...(p.precos || [])]
          .map(x => [x.idpreco, x.tabela, x.preco])
          .sort((a, b) => String(a).localeCompare(String(b))),
        estoque: [...(p.estoque || [])]
          .map(x => [x.cddeposito, x.deposito, x.saldo])
          .sort((a, b) => String(a).localeCompare(String(b)))
      })
    );
  }

  return hash.digest('hex');
}

/**
 * @param {number|string} erpCompanyId
 * @returns {string|null} ISO do último sync bem-sucedido, ou null se nunca houve.
 */
function getLastSyncedAt(erpCompanyId) {
  return loadState()[String(erpCompanyId)]?.lastSyncedAt ?? null;
}

/**
 * @param {number|string} erpCompanyId
 * @param {ProdutoCatalogo[]} produtos
 * @returns {{ changed: boolean, hash: string }}
 */
function checkStateChanged(erpCompanyId, produtos) {
  const state = loadState();
  const currentHash = generateHash(produtos);
  const previousHash = state[String(erpCompanyId)]?.hash ?? null;
  return { changed: currentHash !== previousHash, hash: currentHash };
}

/** Grava hash + timestamp. Só chamado quando a API CONFIRMOU a entrega. */
function updateState(erpCompanyId, newHash) {
  const state = loadState();
  state[String(erpCompanyId)] = {
    hash: newHash,
    lastSyncedAt: new Date().toISOString()
  };
  saveState(state);
}

/** Snapshot do estado — servido em GET /status para diagnóstico sem RDP. */
function snapshotState() {
  return loadState();
}

module.exports = {
  checkStateChanged,
  getLastSyncedAt,
  updateState,
  snapshotState,
  generateHash,
  STATE_FILE_PATH
};
