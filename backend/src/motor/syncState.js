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
 * A forma canônica de UM produto para efeito de comparação.
 *
 * Os arrays 1:N são ordenados aqui: a view só tem `ORDER BY CDPRODUTO`, então a
 * ordem dos preços DENTRO de um produto é indefinida e pode variar entre
 * execuções do mesmo SELECT. Sem ordenar, o produto "mudaria" sozinho e o Motor
 * o reenviaria para sempre.
 *
 * `raw` fica de FORA: carrega colunas voláteis do ERP (timestamps de log,
 * contadores) que mudam sem que o produto tenha mudado.
 */
function formaCanonica(p) {
  return {
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
  };
}

/**
 * Hash de UM produto — a unidade de comparação do envio incremental.
 *
 * 12 caracteres em vez dos 32 do md5: com 10 mil produtos o arquivo de estado
 * cai de ~400 KB para ~200 KB, e ele é reescrito a cada ciclo bem-sucedido. A
 * chance de dois produtos diferentes colidirem em 48 bits é desprezível para o
 * uso (se colidirem, o produto não é reenviado naquele ciclo — o próximo full
 * corrige).
 *
 * @param {ProdutoCatalogo} produto
 * @returns {string}
 */
function hashProduto(produto) {
  return crypto
    .createHash('md5')
    .update(JSON.stringify(formaCanonica(produto)))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Hash estável do catálogo INTEIRO.
 *
 * Continua existindo como atalho: se ele não mudou, nem vale a pena comparar
 * produto a produto. Os produtos são ordenados por `cdproduto` antes de entrar —
 * confiar na ordem que o ERP devolveu é como confiar em ORDER BY ausente.
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
    hash.update(JSON.stringify(formaCanonica(p)));
  }

  return hash.digest('hex');
}

/**
 * O que mudou desde o último envio confirmado.
 *
 * Esta é a peça do envio incremental: em vez de reenviar o catálogo inteiro
 * porque UM preço mudou, o Motor manda só os produtos cujo hash individual
 * saiu diferente. Num cliente de 10 mil produtos, a diferença é entre 10 mil
 * linhas escritas por hora e as três que realmente mudaram.
 *
 * `sumidos` são os que o ERP parou de mandar (produto inativado, apagado, ou
 * que saiu da view). O envio incremental NÃO os comunica — quem quiser agir
 * sobre isso precisa do envio completo, que é justamente por que ele continua
 * acontecendo periodicamente. Ver `precisaFull`.
 *
 * @param {number|string} erpCompanyId
 * @param {ProdutoCatalogo[]} produtos
 * @returns {{ mudados: ProdutoCatalogo[], hashes: Record<string,string>, sumidos: string[], primeiraVez: boolean }}
 */
function diffCatalogo(erpCompanyId, produtos) {
  const entrada = loadState()[String(erpCompanyId)] || null;
  // Estado no formato antigo (um hash só do catálogo) conta como primeira vez:
  // não há hash por produto para comparar, e mandar tudo uma vez é barato
  // perto de arriscar não mandar o que mudou.
  const anterior =
    entrada && entrada.hashes && typeof entrada.hashes === 'object' ? entrada.hashes : null;

  /** @type {Record<string,string>} */
  const hashes = {};
  const mudados = [];

  for (const p of produtos || []) {
    const chave = String(p.cdproduto);
    const h = hashProduto(p);
    hashes[chave] = h;
    if (!anterior || anterior[chave] !== h) mudados.push(p);
  }

  const sumidos = anterior ? Object.keys(anterior).filter(cd => !(cd in hashes)) : [];

  return { mudados, hashes, sumidos, primeiraVez: !anterior };
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

/**
 * Grava o estado. Só chamado quando a API CONFIRMOU a entrega.
 *
 * @param {number|string} erpCompanyId
 * @param {string} newHash hash do catálogo inteiro
 * @param {Record<string,string>|null} [hashes] hash por produto; omitido preserva o que já havia
 * @param {boolean} [foiFull] true só quando o envio levou o catálogo completo
 */
function updateState(erpCompanyId, newHash, hashes = null, foiFull = false) {
  const state = loadState();
  const anterior = state[String(erpCompanyId)] || {};
  const agora = new Date().toISOString();

  state[String(erpCompanyId)] = {
    hash: newHash,
    // Hash por produto: é o que permite mandar só o que mudou no ciclo
    // seguinte. Sem ele o Motor volta a mandar o catálogo inteiro.
    hashes: hashes || anterior.hashes || {},
    lastSyncedAt: agora,
    // Quando foi o último envio COMPLETO. O incremental não comunica produto
    // que sumiu do ERP, então o full periódico é o que reconcilia.
    lastFullAt: foiFull ? agora : anterior.lastFullAt || null
  };

  saveState(state);
}

/**
 * Está na hora de mandar o catálogo inteiro em vez de só o que mudou?
 *
 * Sim quando nunca houve um full, ou quando o último passou de `horas`. O
 * incremental é o caminho normal, mas ele tem um ponto cego por desenho:
 * produto que some do ERP nunca é comunicado, e um hash local corrompido ou
 * defasado só se corrige reenviando tudo. O full periódico é a rede de
 * segurança — barato uma vez por dia, caro de não ter.
 *
 * @param {number|string} erpCompanyId
 * @param {number} horas
 * @returns {boolean}
 */
function precisaFull(erpCompanyId, horas = 24) {
  const entrada = loadState()[String(erpCompanyId)];
  if (!entrada || !entrada.lastFullAt) return true;

  const ultimo = new Date(entrada.lastFullAt).getTime();
  if (Number.isNaN(ultimo)) return true;

  return Date.now() - ultimo >= horas * 60 * 60 * 1000;
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
  hashProduto,
  diffCatalogo,
  precisaFull,
  STATE_FILE_PATH
};
