// src/server.js
// Servidor HTTP local do Motor — escuta só em 127.0.0.1, na máquina do cliente.
//
// Ele NÃO é um painel: quem mostra o catálogo é o ZapRun Shop. Ele existe para
// operação e diagnóstico:
//   /health               o updater usa para decidir se faz rollback
//   /status               versão, último ciclo, estado do sync
//   /produtos             o catálogo como o Motor o enxerga (ver abaixo)
//   /diagnostico/colunas  colunas reais do ERP, para escrever a view
//   /sync                 força um ciclo agora
//
// Qualquer rota nova aqui precisa passar no mesmo teste: "isso ajuda alguém a
// consertar uma instalação sem acessar a máquina?". Se não, o lugar é o ZapRun.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');

const { logInfo, logError } = require('./logger');
const {
  ensureUpdaterSchedule,
  ensureUpdaterVersionFile,
  ensureUpdaterHealthUrl
} = require('./ensureUpdaterSchedule');
const { snapshotState } = require('./motor/syncState');
const { erp, tipoErp } = require('./motor/erp');
const { apenasContrato } = require('./motor/mapping');

// Sobe o motor (cron + primeiro ciclo).
const { runMotor, estadoDoMotor } = require('./motor');

const app = express();
const PORT = process.env.PORT || 3010;

app.use(express.json());

/**
 * Teste de vida do banco do ERP desta máquina (Firebird no Automec, MySQL pela
 * VPN no Linear). Nunca lança: ERP_TIPO inválido também é "banco com erro",
 * com o motivo — é o que o /status precisa mostrar.
 *
 * @returns {Promise<{ ok: boolean, erro?: string }>}
 */
async function testarBanco() {
  try {
    return await erp().testarConexao();
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

// ── Rotas ────────────────────────────────────────────────────────────────────

// O updater espera 200 aqui depois de atualizar; qualquer outra coisa dispara
// rollback. Por isso responde 200 mesmo com o banco do ERP fora: banco caído é
// problema do cliente, não da versão que acabou de subir — reverter o código
// não consertaria e ainda desfaria uma atualização boa.
app.get('/health', async (_req, res) => {
  const banco = (await testarBanco()).ok ? 'ok' : 'error';
  res.json({
    status: 'ok',
    erp: tipoErp(),
    banco,
    // `firebird` continua existindo para o Automec: é o campo que o
    // INSTALAR.bat de versões anteriores lê na verificação final.
    ...(tipoErp() === 'automec' ? { firebird: banco } : {}),
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/status', async (_req, res) => {
  const token = process.env.ZAPRUN_TOKEN || '';
  const banco = await testarBanco();
  /** @type {any} */
  let adaptador = null;
  try {
    adaptador = erp();
  } catch (err) {
    // ERP_TIPO inválido: o /status ainda responde, com o motivo em `banco`.
  }
  res.json({
    ...estadoDoMotor(),
    apiUrl: process.env.ZAPRUN_API_URL || 'https://dev.zaprun.com.br',
    // Só o prefixo: o token em claro não pode vazar num log ou print de tela.
    token: token ? `${token.slice(0, 12)}...` : '(não configurado)',
    erpNome: adaptador ? adaptador.nome : '(ERP_TIPO inválido)',
    // Com o motivo: "confira a VPN da Linear" resolve em 1 minuto o que
    // "error" deixaria para uma sessão remota.
    banco: banco.ok ? 'ok' : `erro: ${banco.erro || 'desconhecido'}`,
    database: adaptador ? adaptador.descreverBanco() : '(não configurado)',
    // Por que a view falhou, e não só o sintoma "Table unknown" do ciclo.
    views: adaptador ? adaptador.estadoDoPreparo() : null,
    sincronizacao: snapshotState()
  });
});

// O catálogo como o Motor o enxerga: linhas planas da view já agrupadas em
// produtos aninhados, exatamente o JSON que vai para a API.
//
//   GET /produtos                  catálogo inteiro
//   GET /produtos?cdproduto=8390   um produto só
//
// Existe para responder, sem RDP e sem abrir o ERP, à pergunta que sempre
// aparece: "o produto X está com o preço errado na loja — o ERP está mandando
// o quê?". Por isso devolve o contrato puro (sem `raw` nem `erpCompanyId`) e
// acrescenta `_meta` com as contagens: `linhas` muito maior que `produtos` é o
// sinal de que os JOINs da view multiplicaram, e `descartadas > 0` é linha sem
// CDPRODUTO.
//
// Somente leitura, e só em 127.0.0.1 — não altera nada no ERP nem no ZapRun.
app.get('/produtos', async (req, res) => {
  const cdproduto = req.query.cdproduto ?? null;

  // Validação antes de tocar no banco: `?cdproduto=abc` é erro de quem chamou,
  // e responder 400 com a causa poupa uma investigação no lado errado.
  if (cdproduto !== null && !/^\d+$/.test(String(cdproduto).trim())) {
    return res.status(400).json({
      erro: 'cdproduto deve ser um número inteiro.',
      recebido: String(cdproduto)
    });
  }

  try {
    const { produtos, linhas, descartadas, foraDoEscopo } = await erp().extrairProdutos(
      null,
      cdproduto
    );

    if (cdproduto !== null && produtos.length === 0) {
      return res.status(404).json({
        erro: `Produto ${cdproduto} não encontrado em ${erp().origem}.`,
        _meta: { linhas, descartadas }
      });
    }

    res.json({
      _meta: {
        erp: tipoErp(),
        view: erp().view,
        origem: erp().origem,
        linhas,
        produtos: produtos.length,
        descartadas,
        foraDoEscopo
      },
      produtos: produtos.map(apenasContrato)
    });
  } catch (err) {
    // A mensagem do Firebird vai inteira: "Table unknown ZAPRUN_SHOP" é a
    // resposta útil aqui, e escondê-la atrás de "erro interno" transformaria um
    // diagnóstico de 5 segundos numa sessão remota.
    logError('[ZapRun] Falha ao ler o catálogo do ERP', err);
    /** @type {any} */
    let view = null;
    try {
      view = erp().view;
    } catch (e) {
      // ERP_TIPO inválido: a mensagem de `erro` já diz isso.
    }
    res.status(500).json({ erro: err.message, erp: tipoErp(), view });
  }
});

// Colunas reais das tabelas do ERP.
//
// Serve para escrever a view sem adivinhar: o Firebird recusa a criação inteira
// no PRIMEIRO nome errado, então sem isto cada coluna errada custava uma ida e
// volta com alguém na frente da máquina do cliente.
//
// Lê apenas o CATÁLOGO (RDB$RELATION_FIELDS). Nenhum dado de cliente passa aqui.
//
//   GET /diagnostico/colunas
//   GET /diagnostico/colunas?tabelas=PRODUTO,CODBARRA
app.get('/diagnostico/colunas', async (req, res) => {
  const pedidas = String(req.query.tabelas || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  try {
    const colunas = await erp().lerColunas(pedidas);
    res.json({ erp: tipoErp(), database: erp().descreverBanco(), colunas });
  } catch (err) {
    logError('[ZapRun] Falha ao ler o schema do ERP', err);
    res.status(500).json({ erro: err.message });
  }
});

// Força um ciclo agora. Serve ao implantador: instalou, quer ver o catálogo
// chegar sem esperar a próxima hora. Não devolve o resultado do ciclo — ele
// pode levar minutos; o resultado se acompanha em /status.
app.post('/sync', (_req, res) => {
  runMotor();
  res.json({ ok: true, mensagem: 'Ciclo disparado. Acompanhe em /status.' });
});

// `require.main === module` separa "executado pelo nssm" de "importado pelo
// teste": os testes precisam do `app` para bater nas rotas sem ocupar porta
// nenhuma. Sem esta guarda, rodar a suíte subiria um servidor de verdade e o
// segundo teste falharia com EADDRINUSE.
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    logInfo('================================================');
    logInfo(`  ZapRun Shop rodando em http://127.0.0.1:${PORT}`);
    logInfo('================================================');

    try {
      ensureUpdaterVersionFile();
      ensureUpdaterHealthUrl(PORT);
      ensureUpdaterSchedule();
    } catch (err) {
      logError('[ZapRun] Falha ao garantir o agendamento do updater', err);
    }
  });
}

module.exports = { app };
