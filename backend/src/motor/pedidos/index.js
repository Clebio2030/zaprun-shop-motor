// motor/pedidos/index.js
// Laço de PEDIDOS: o pedido da Loja vira orçamento no ERP (ADR-306 do ZapRun).
//
// Independente do cron do catálogo — a extração do catálogo pode levar
// minutos, e um pedido não pode esperar por ela. Um setTimeout encadeado (e não
// setInterval): a próxima consulta só é agendada quando esta termina, então
// duas nunca se sobrepõem, por mais lento que o Firebird esteja.
//
//   consultar ─► servidor devolve { ativo, modo, intervaloSeg, config, pedidos }
//      │
//      ├─ para cada pedido: erp().sincronizarPedido(p, config, modo)
//      │     (uma transação no Firebird; no Ensaio, desfeita no fim)
//      │
//      └─ resultado ─► servidor confirma `recebidos`
//           Só esquece o resultado quando a contagem bate. Se o envio falhar,
//           ele vai de novo na próxima volta — e, se o Motor reiniciar antes,
//           a coluna ZR_PEDIDO no ERP faz a regravação achar o mesmo orçamento.
//
// O ritmo vem do servidor (30 s ligado, 5 min desligado). Sem servidor, o laço
// espera cada vez mais (até 10 min) e loga só quando o estado muda — nada de
// uma linha de erro a cada 30 s no log do cliente.

const { logInfo, logWarn, logError } = require('../../logger');
const { erp, tipoErp } = require('../erp');
const api = require('./api');

const SOURCE_VERSION = require('../../../package.json').version;

const PADRAO_INTERVALO_MS = 30_000;
const MAX_ESPERA_MS = 10 * 60_000;
const API_SEM_ROTA_MS = 30 * 60_000;
const SINAL_DE_VIDA_MS = 30 * 60_000;
const ULTIMOS = 50;

/** @type {any} */
const estado = {
  ativo: false,
  modo: null,
  ultimaConsultaEm: null,
  ultimoErro: null,
  processados: 0,
  consultasSemPedido: 0,
  falhasSeguidas: 0
};

/** Resultados ainda não confirmados pelo servidor. */
let pendentes = [];
/** Os últimos resultados, para GET /pedidos no servidor local. */
const ultimos = [];

let timer = null;
let rodando = false;
let relatorioEnviado = false;
let chaveDaConfig = null;
let ultimoSinalDeVida = Date.now();
let ultimaSituacaoLogada = null;
let ultimaValidacao = null;
/** A config da última resposta ligada — o relatório é montado com ela. */
let configAtual = null;

function agendar(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    rodarUmaVez().catch(err => logError('[Pedidos] Erro inesperado no laço:', err));
  }, ms);
  // Quem segura o processo vivo é o servidor HTTP, não este timer (e os
  // testes terminam sem precisar desligá-lo).
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/** Loga só quando a situação muda — o laço roda 2.880 vezes por dia. */
function logarSituacao(texto, nivel = 'info') {
  if (texto === ultimaSituacaoLogada) return;
  ultimaSituacaoLogada = texto;
  if (nivel === 'warn') logWarn(`[Pedidos] ${texto}`);
  else logInfo(`[Pedidos] ${texto}`);
}

function adaptador() {
  try {
    const a = erp();
    return typeof a.sincronizarPedido === 'function' ? a : null;
  } catch (err) {
    return null;
  }
}

function estadoParaServidor() {
  return {
    erp: tipoErp(),
    suportado: !!adaptador(),
    modo: estado.modo,
    validacao: ultimaValidacao,
    pendentesDeConfirmacao: pendentes.length,
    ultimoErro: estado.ultimoErro
  };
}

async function confirmarPendentes() {
  if (!pendentes.length) return true;
  const lote = pendentes.slice();
  const resp = await api.enviarResultados({ motorVersao: SOURCE_VERSION, resultados: lote });
  if (resp.ok && Number(resp.dados && resp.dados.recebidos) === lote.length) {
    pendentes = pendentes.slice(lote.length);
    return true;
  }
  // Nunca confie só no 200: contagem diferente = manda de novo na próxima.
  logWarn(
    `[Pedidos] Servidor não confirmou ${lote.length} resultado(s) ` +
      `(${resp.ok ? `recebidos=${resp.dados && resp.dados.recebidos}` : resp.erro}). Reenvio na próxima consulta.`
  );
  return false;
}

function descrever(p, r) {
  const valor = `R$ ${Number(p.total || 0).toFixed(2).replace('.', ',')}`;
  const nr = r.nrOrcamento || r.nrPrevisto;
  const prefixo = r.ensaio ? 'ENSAIO ' : '';
  if (r.acao === 'erro') {
    return `${prefixo}pedido #${p.numero}: ERRO${r.transitorio ? ' (transitório)' : ''} — ${r.erro} (${r.duracaoMs} ms)`;
  }
  return (
    `${prefixo}pedido #${p.numero}: ${r.acao}${nr ? ` → orçamento ${nr}${r.ensaio ? ' (previsto)' : ''}` : ''}` +
    `${r.linhas ? `, ${r.linhas} linha(s)` : ''}, ${valor} (${r.duracaoMs} ms)` +
    `${r.avisos && r.avisos.length ? ` | avisos: ${r.avisos.join(' / ')}` : ''}`
  );
}

async function rodarUmaVez() {
  if (rodando) return;
  rodando = true;
  let proxima = PADRAO_INTERVALO_MS;
  try {
    // Resultado que ficou sem confirmação vai antes de pegar pedido novo.
    await confirmarPendentes();

    const a = adaptador();

    // Relatório do ERP: vai JUNTO da consulta (uma segunda consulta reservaria
    // pedidos no servidor e os deixaria parados), uma vez por boot e a cada
    // mudança de configuração — depois que o servidor disse que está ligado.
    let relatorio = null;
    if (a && estado.ativo && configAtual && !relatorioEnviado && typeof a.relatorioPedidos === 'function') {
      try {
        relatorio = await a.relatorioPedidos(configAtual);
        ultimaValidacao = relatorio.validacao || null;
        if (relatorio.validacao && !relatorio.validacao.ok) {
          logWarn(`[Pedidos] Configuração com problema: ${relatorio.validacao.erros.join(' ')}`);
        }
      } catch (err) {
        logWarn(`[Pedidos] Não consegui montar o relatório do ERP: ${err.message}`);
      }
    }

    const corpo = { motorVersao: SOURCE_VERSION, erp: tipoErp(), estado: estadoParaServidor(), relatorio };
    const resp = await api.consultar(corpo);
    estado.ultimaConsultaEm = new Date().toISOString();
    if (resp.ok && relatorio) {
      relatorioEnviado = true;
      logInfo(
        `[Pedidos] Relatório do ERP enviado: próximo orçamento ${relatorio.numeracao && relatorio.numeracao.proximo}, ` +
          `texto ${relatorio.texto && relatorio.texto.modo}, coluna ZR_PEDIDO ${relatorio.colunaZr ? 'existe' : 'ainda não existe'}.`
      );
    }

    if (!resp.ok) {
      estado.falhasSeguidas += 1;
      if (resp.status === 404) {
        proxima = API_SEM_ROTA_MS;
        logarSituacao('A API do ZapRun ainda não tem /erp/pedidos — o recurso fica parado até o servidor ser atualizado.', 'warn');
      } else if (resp.status === 401 || resp.status === 403) {
        proxima = MAX_ESPERA_MS;
        logarSituacao(`Token recusado na consulta de pedidos (${resp.erro}). Confira o ZAPRUN_TOKEN (Loja > Integração ERP).`, 'warn');
      } else {
        proxima = Math.min(PADRAO_INTERVALO_MS * 2 ** Math.min(estado.falhasSeguidas, 5), MAX_ESPERA_MS);
        logarSituacao(`Sem resposta da API de pedidos (${resp.erro}). Tentando de novo com espera crescente.`, 'warn');
      }
      estado.ultimoErro = resp.erro;
      return;
    }

    estado.falhasSeguidas = 0;
    const dados = resp.dados || {};
    proxima = Math.max(10, Number(dados.intervaloSeg) || PADRAO_INTERVALO_MS / 1000) * 1000;
    estado.ativo = !!dados.ativo;
    estado.modo = dados.ativo ? dados.modo || 'ensaio' : null;

    if (!dados.ativo) {
      relatorioEnviado = false;
      logarSituacao('Pedidos → orçamento: desligado no painel do ZapRun.');
      return;
    }
    if (!a) {
      estado.ultimoErro = `o ERP "${tipoErp()}" ainda não grava orçamento`;
      logarSituacao(`Ligado no painel, mas este Motor (${tipoErp()}) não grava orçamento. Nada a fazer.`, 'warn');
      return;
    }

    const config = dados.config || {};
    configAtual = config;
    const chave = JSON.stringify([config, estado.modo]);
    if (chave !== chaveDaConfig) {
      chaveDaConfig = chave;
      relatorioEnviado = false;
      if (typeof a.esquecerCachesPedidos === 'function') a.esquecerCachesPedidos();
    }
    logarSituacao(`Pedidos → orçamento LIGADO, modo ${estado.modo.toUpperCase()}, consulta a cada ${proxima / 1000}s.`);

    const pedidos = Array.isArray(dados.pedidos) ? dados.pedidos : [];
    if (!pedidos.length) {
      estado.consultasSemPedido += 1;
      if (Date.now() - ultimoSinalDeVida > SINAL_DE_VIDA_MS) {
        logInfo(`[Pedidos] Sem pedido novo nas últimas ${estado.consultasSemPedido} consultas (${estado.processados} processado(s) desde o boot).`);
        ultimoSinalDeVida = Date.now();
        estado.consultasSemPedido = 0;
      }
      return;
    }

    for (const p of pedidos) {
      const r = await a.sincronizarPedido(p, config, estado.modo);
      estado.processados += 1;
      estado.ultimoErro = r.acao === 'erro' ? r.erro : null;
      pendentes.push(r);
      ultimos.unshift({ em: new Date().toISOString(), numero: p.numero, total: p.total, ...r });
      if (ultimos.length > ULTIMOS) ultimos.length = ULTIMOS;
      const linha = `[Pedidos] ${descrever(p, r)}`;
      if (r.acao === 'erro') logWarn(linha);
      else logInfo(linha);
    }
    await confirmarPendentes();
    // Havia trabalho: talvez haja mais na fila. Volta logo.
    proxima = Math.min(proxima, 5_000);
  } catch (err) {
    estado.ultimoErro = err.message;
    logError('[Pedidos] Erro inesperado:', err);
  } finally {
    rodando = false;
    agendar(proxima);
  }
}

/** Sobe o laço. Primeira consulta em 15 s, para não disputar com o boot do catálogo. */
function iniciarPedidos() {
  agendar(15_000);
  logInfo('[Pedidos] Laço de pedidos iniciado.');
}

/** POST /pedidos/consultar no servidor local: consulta agora. */
function consultarAgora() {
  agendar(0);
}

function estadoDosPedidos() {
  return {
    ...estado,
    pendentesDeConfirmacao: pendentes.length,
    validacao: ultimaValidacao,
    rodando
  };
}

function ultimosResultados() {
  return ultimos.slice();
}

module.exports = { iniciarPedidos, consultarAgora, estadoDosPedidos, ultimosResultados, rodarUmaVez, descrever };
