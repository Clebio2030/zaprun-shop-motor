// motor/index.js
// Orquestrador do Motor ZapRun Shop.
//
// Ciclo:
//   1. GET /erp/handshake        → confirma o token e recebe a config de frota
//   2. Lê a view ZAPRUN_SHOP do Firebird e agrupa em produtos
//   3. Separa por empresa e pula quem não mudou (hash)
//   4. POST /erp/produtos/sync em lotes ordenados, com fail-fast
//   5. Só grava o hash depois que a API CONFIRMA a contagem entregue
//
// Regra de ouro herdada do Motor de Orçamentos e mantida: NUNCA confie só no
// 200. O hash é o carimbo de "chegou inteiro"; gravá-lo cedo demais faz o Motor
// esquecer alteração de preço que a API nunca recebeu.
//
// Diferença de desenho em relação ao Motor de Orçamentos: aqui NÃO há janela de
// datas. Catálogo não tem data de emissão — um preço muda sem que nenhuma
// coluna de data mude — então o ciclo lê o catálogo inteiro e deixa o hash
// decidir se vale enviar. Ver extractor.extrairProdutos.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const cron = require('node-cron');
const crypto = require('crypto');
const { logInfo, logWarn, logError } = require('../logger');
const { handshake, enviarProdutos, fatiarLote } = require('./sender');
const { extrairProdutos, listarEmpresasDoErp } = require('./extractor');
const { checkStateChanged, getLastSyncedAt, updateState } = require('./syncState');
const { runDatabaseMigrations } = require('./migrations');

/** @typedef {import('../types/zaprun-shop').ProdutoCatalogo} ProdutoCatalogo */

const SOURCE_VERSION = require('../../package.json').version;

// Chave de estado para ERP de empresa única (view sem IDEMPRESA). Zero não é um
// IDEMPRESA válido em nenhum ERP que vimos, então não colide com empresa real.
const EMPRESA_UNICA = 0;

// Defaults usados quando o handshake não responde ou omite o campo. São
// DEFAULTS NO CÓDIGO de propósito — nunca no `.env`, que é preservado no update
// e por isso nunca propagaria uma mudança para a frota.
const PADRAO = {
  cronExpr: '0 8-22 * * *', // de hora em hora, das 08h às 22h
  chunkSize: 500            // cabe folgado no bodyParser de 5 MB do ZapRun
};

let cicloEmAndamento = false;
let cronTask = null;
let cronExprAtual = null;
let ultimoCiclo = null;

// ── Ciclo ────────────────────────────────────────────────────────────────────

async function runMotor() {
  if (cicloEmAndamento) {
    logWarn('[ZapRun] Ciclo anterior ainda em andamento. Ignorando este disparo.');
    return;
  }
  cicloEmAndamento = true;

  const inicio = Date.now();
  const dataReferencia = hojeFormatado();
  const resumo = { empresas: 0, produtos: 0, enviados: 0, inalterados: 0, falhas: 0, erro: null };

  try {
    const config = await resolverConfig();

    if (!config.ativo) {
      logWarn('[ZapRun] Integração desativada no servidor para esta empresa. Ciclo encerrado.');
      return;
    }

    const permitidas = Array.isArray(config.erpCompanyIds) && config.erpCompanyIds.length
      ? config.erpCompanyIds.map(Number)
      : null;

    logInfo(`[ZapRun] Iniciando ciclo — referência ${dataReferencia}.`);

    const { produtos, linhas } = await extrairProdutos(permitidas);
    logInfo(`[ZapRun] View devolveu ${linhas} linha(s) → ${produtos.length} produto(s).`);
    resumo.produtos = produtos.length;

    if (produtos.length === 0) {
      await diagnosticarVazio(permitidas);
      return;
    }

    const porEmpresa = agruparPorEmpresa(produtos);
    resumo.empresas = porEmpresa.size;

    for (const [erpCompanyId, lista] of porEmpresa) {
      const modo = getLastSyncedAt(erpCompanyId) ? 'incremental' : 'full';

      const { changed, hash } = checkStateChanged(erpCompanyId, lista);
      if (!changed) {
        logInfo(
          `[ZapRun] Empresa ${erpCompanyId}: ${lista.length} produto(s), nada mudou. Pulando envio.`
        );
        resumo.inalterados++;
        continue;
      }

      logInfo(`[ZapRun] Empresa ${erpCompanyId}: enviando ${lista.length} produto(s) — modo ${modo}.`);

      const ok = await enviarEmpresa({
        erpCompanyId,
        produtos: lista,
        chunkSize: config.chunkSize,
        meta: { dataReferencia, syncMode: modo }
      });

      if (ok) {
        updateState(erpCompanyId, hash);
        resumo.enviados++;
        logInfo(`[ZapRun] Empresa ${erpCompanyId}: entrega confirmada — hash salvo.`);
      } else {
        resumo.falhas++;
        logWarn(`[ZapRun] Empresa ${erpCompanyId}: hash NÃO salvo. O próximo ciclo reenviará tudo.`);
      }
    }
  } catch (err) {
    resumo.erro = err.message;
    logError('[ZapRun] Erro inesperado no ciclo do motor:', err);
  } finally {
    cicloEmAndamento = false;
    const duracaoMs = Date.now() - inicio;
    ultimoCiclo = { ...resumo, dataReferencia, duracaoMs, em: new Date().toISOString() };
    logInfo(
      `[ZapRun] Ciclo concluído: empresas=${resumo.empresas}, produtos=${resumo.produtos}, enviadas=${resumo.enviados}, inalteradas=${resumo.inalterados}, falhas=${resumo.falhas}, duração=${duracaoMs}ms.`
    );
  }
}

/**
 * Envia o catálogo de UMA empresa como um stream de lotes ordenado.
 *
 * `snapshotId` identifica a entrega inteira; `expectedTotal` é congelado antes
 * do primeiro lote. Ao primeiro lote que falha, aborta (fail-fast): empurrar os
 * seguintes só gravaria metade do catálogo e mascararia a falha. Sem hash
 * salvo, o próximo ciclo refaz a entrega inteira.
 *
 * @returns {Promise<boolean>} true só se a API confirmou TODOS os produtos.
 */
async function enviarEmpresa({ erpCompanyId, produtos, chunkSize, meta }) {
  const expectedTotal = produtos.length;
  const snapshotId = crypto.randomUUID();
  const lotes = fatiarLote(produtos, chunkSize);
  let recebidosConfirmados = 0;
  // Acumulados, não os do último lote: sem isto o log mostrava "confirmou 4859
  // ... novos=359" e 359 era só o tamanho do último lote, o que parecia perda
  // de dado.
  let novos = 0;
  let atualizados = 0;
  let iguais = 0;

  for (let i = 0; i < lotes.length; i++) {
    if (lotes.length > 1) {
      logInfo(
        `[ZapRun] Empresa ${erpCompanyId}: lote ${i + 1}/${lotes.length} (${lotes[i].length} produtos)...`
      );
    }

    const resp = await enviarProdutos({
      ...meta,
      sourceVersion: SOURCE_VERSION,
      snapshotId,
      erpCompanyId: erpCompanyId === EMPRESA_UNICA ? null : erpCompanyId,
      expectedTotal,
      chunkInfo: { atual: i + 1, total: lotes.length },
      produtos: lotes[i]
    });

    if (!resp.ok) {
      logWarn(
        `[ZapRun] Empresa ${erpCompanyId}: lote ${i + 1}/${lotes.length} falhou — abortando entrega (snapshot ${snapshotId}).`
      );
      return false;
    }

    const p = resp.persisted || {};
    recebidosConfirmados += Number(p.received || 0);
    novos += Number(p.inserted || 0);
    atualizados += Number(p.updated || 0);
    iguais += Number(p.unchanged || 0);

    if (Array.isArray(p.rejected) && p.rejected.length > 0) {
      // Produto rejeitado é produto que não aparece na loja. Tem que aparecer
      // nomeado no log, senão ninguém descobre sem RDP na máquina do cliente.
      logWarn(
        `[ZapRun] Empresa ${erpCompanyId}: a API rejeitou ${p.rejected.length} produto(s): ${p.rejected.slice(0, 10).join(', ')}`
      );
      return false;
    }

    if (i + 1 === lotes.length) {
      logInfo(
        `[ZapRun] Empresa ${erpCompanyId}: API confirmou ${recebidosConfirmados} de ${expectedTotal} (novos=${novos}, atualizados=${atualizados}, iguais=${iguais}).`
      );
    }
  }

  // Verificação fim-a-fim. É ISTO que autoriza gravar o hash — não o 200.
  if (recebidosConfirmados !== expectedTotal) {
    logError(
      `[ZapRun] Empresa ${erpCompanyId}: API recebeu ${recebidosConfirmados}, esperado ${expectedTotal} — entrega truncada (snapshot ${snapshotId}).`
    );
    return false;
  }

  return true;
}

// ── Config ───────────────────────────────────────────────────────────────────

/** Handshake com fallback nos defaults do código. Nunca lança. */
async function resolverConfig() {
  const remoto = await handshake();

  if (!remoto) {
    // Servidor fora do ar não pode parar o Motor: ele segue com os defaults e
    // tenta de novo no próximo ciclo. O que NÃO fazemos é assumir `ativo` —
    // isso vem do servidor; sem resposta, mantemos ativo para não perder
    // atualização de catálogo por instabilidade de rede nossa.
    logWarn('[ZapRun] Sem handshake — seguindo com a configuração padrão do código.');
    return { ativo: true, ...PADRAO, erpCompanyIds: null };
  }

  return {
    ativo: remoto.ativo !== false,
    cronExpr: remoto.cronExprShop || remoto.cronExpr || PADRAO.cronExpr,
    chunkSize: Number(remoto.chunkSizeShop || remoto.chunkSize) || PADRAO.chunkSize,
    erpCompanyIds: remoto.erpCompanyIds || null,
    empresa: remoto.empresa || null
  };
}

/**
 * Separa os produtos por empresa do ERP.
 *
 * Produto sem `erpCompanyId` (view de empresa única) cai na chave
 * EMPRESA_UNICA, para que o estado e o hash existam do mesmo jeito.
 *
 * @param {ProdutoCatalogo[]} produtos
 * @returns {Map<number, ProdutoCatalogo[]>}
 */
function agruparPorEmpresa(produtos) {
  const mapa = new Map();
  for (const p of produtos) {
    const id = p.erpCompanyId === null || p.erpCompanyId === undefined
      ? EMPRESA_UNICA
      : Number(p.erpCompanyId);
    if (!mapa.has(id)) mapa.set(id, []);
    mapa.get(id).push(p);
  }
  return mapa;
}

/**
 * Ciclo sem nenhum produto é ambíguo: pode ser "a view está vazia" ou "o token
 * autoriza outra empresa". Distinguir isso pelo log evita uma sessão de RDP na
 * máquina do cliente.
 */
async function diagnosticarVazio(permitidas) {
  try {
    const noErp = await listarEmpresasDoErp();
    if (noErp.length === 0) {
      logWarn(
        '[ZapRun] Nenhum produto na view ZAPRUN_SHOP — confira se ela foi criada e tem dados (GET /produtos no servidor local mostra o erro exato).'
      );
      return;
    }
    if (permitidas && !noErp.some(id => permitidas.includes(id))) {
      logWarn(
        `[ZapRun] Nenhum produto: o token autoriza a(s) empresa(s) [${permitidas.join(', ')}], mas a view só tem [${noErp.join(', ')}]. Corrija o token no painel.`
      );
      return;
    }
    logInfo('[ZapRun] Nenhum produto na view. Nada a enviar.');
  } catch (err) {
    logWarn(`[ZapRun] Nenhum produto (diagnóstico da view falhou: ${err.message}).`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hojeFormatado() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Estado exposto em GET /status do servidor local. */
function estadoDoMotor() {
  return { cicloEmAndamento, cronExpr: cronExprAtual, ultimoCiclo, sourceVersion: SOURCE_VERSION };
}

// ── Cron ─────────────────────────────────────────────────────────────────────

/**
 * (Re)agenda o cron. A expressão vem do handshake, então o servidor pode mudar
 * o ritmo da frota inteira sem release e sem tocar no `.env` de ninguém.
 */
function aplicarCron(expr) {
  if (!cron.validate(expr)) {
    logWarn(
      `[ZapRun] Expressão de cron inválida vinda do servidor ("${expr}"). Mantendo "${cronExprAtual || PADRAO.cronExpr}".`
    );
    return;
  }
  if (expr === cronExprAtual) return;

  if (cronTask) cronTask.stop();
  cronTask = cron.schedule(expr, () => {
    logInfo(`[ZapRun] Cron disparado (${expr}).`);
    runMotor();
  });
  cronExprAtual = expr;
  logInfo(`[ZapRun] Motor agendado — cron: ${expr}.`);
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
// ZAPRUN_DISABLE_BOOTSTRAP=true permite que os testes carreguem este módulo sem
// subir cron nem conectar no Firebird.
if (process.env.ZAPRUN_DISABLE_BOOTSTRAP !== 'true') {
  aplicarCron(PADRAO.cronExpr);

  // Aplica as views no Firebird antes do primeiro ciclo. Falha aqui não pode
  // derrubar o serviço: sem view, o ciclo loga o erro e tenta de novo depois.
  runDatabaseMigrations()
    .catch(err => logError('[ZapRun] Erro na aplicação das views no boot:', err))
    .then(() => {
      // Reagenda com o ritmo que o servidor manda, e roda o primeiro ciclo já.
      // Sem isto, uma instalação nova ficaria até uma hora sem enviar nada, e o
      // implantador não teria como saber se funcionou antes de ir embora.
      runMotor().then(() => resolverConfig().then(c => aplicarCron(c.cronExpr)));
    });
}

module.exports = {
  runMotor,
  enviarEmpresa,
  agruparPorEmpresa,
  estadoDoMotor,
  EMPRESA_UNICA,
  PADRAO
};
