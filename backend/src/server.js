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
const firebird = require('node-firebird');

const { logInfo, logError } = require('./logger');
const {
  ensureUpdaterSchedule,
  ensureUpdaterVersionFile
} = require('./ensureUpdaterSchedule');
const { snapshotState } = require('./motor/syncState');
const { estadoDasViews } = require('./motor/migrations');
const { lerColunas, TABELAS_PADRAO } = require('./motor/schema');
const { extrairProdutos } = require('./motor/extractor');
const { apenasContrato, VIEW_SHOP } = require('./motor/mapping');

// Sobe o motor (cron + primeiro ciclo).
const { runMotor, estadoDoMotor } = require('./motor');

const app = express();
const PORT = process.env.PORT || 3010;

app.use(express.json());

// ── Firebird ─────────────────────────────────────────────────────────────────

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
 * Conexão própria (fora do pool do motor) porque isto é um teste de vida: se o
 * pool estiver saturado por uma extração em andamento, o health check deve
 * responder mesmo assim — senão o updater interpretaria "ocupado" como
 * "quebrado" e faria rollback de uma versão sadia.
 */
function testarFirebird() {
  return new Promise(resolve => {
    const opcoes = opcoesFirebird();
    if (!opcoes.database) return resolve(false);

    firebird.attach(/** @type {any} */ (opcoes), (err, db) => {
      if (err) {
        logError('[ZapRun] Falha ao conectar no Firebird', err);
        return resolve(false);
      }
      db.query('SELECT 1 FROM RDB$DATABASE', [], errQ => {
        db.detach();
        if (errQ) {
          logError('[ZapRun] Falha na query de teste do Firebird', errQ);
          return resolve(false);
        }
        resolve(true);
      });
    });
  });
}

// ── Rotas ────────────────────────────────────────────────────────────────────

// O updater espera 200 aqui depois de atualizar; qualquer outra coisa dispara
// rollback. Por isso responde 200 mesmo com o Firebird fora: banco caído é
// problema do cliente, não da versão que acabou de subir — reverter o código
// não consertaria e ainda desfaria uma atualização boa.
app.get('/health', async (_req, res) => {
  res.json({
    status: 'ok',
    firebird: (await testarFirebird()) ? 'ok' : 'error',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/status', async (_req, res) => {
  const token = process.env.ZAPRUN_TOKEN || '';
  res.json({
    ...estadoDoMotor(),
    apiUrl: process.env.ZAPRUN_API_URL || 'https://dev.zaprun.com.br',
    // Só o prefixo: o token em claro não pode vazar num log ou print de tela.
    token: token ? `${token.slice(0, 12)}...` : '(não configurado)',
    firebird: (await testarFirebird()) ? 'ok' : 'error',
    database: process.env.FB_DATABASE || '(não configurado)',
    // Por que a view falhou, e não só o sintoma "Table unknown" do ciclo.
    views: estadoDasViews(),
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
    const { produtos, linhas, descartadas, foraDoEscopo } = await extrairProdutos(null, cdproduto);

    if (cdproduto !== null && produtos.length === 0) {
      return res.status(404).json({
        erro: `Produto ${cdproduto} não encontrado em ${VIEW_SHOP}.`,
        _meta: { linhas, descartadas }
      });
    }

    res.json({
      _meta: { view: VIEW_SHOP, linhas, produtos: produtos.length, descartadas, foraDoEscopo },
      produtos: produtos.map(apenasContrato)
    });
  } catch (err) {
    // A mensagem do Firebird vai inteira: "Table unknown ZAPRUN_SHOP" é a
    // resposta útil aqui, e escondê-la atrás de "erro interno" transformaria um
    // diagnóstico de 5 segundos numa sessão remota.
    logError('[ZapRun] Falha ao ler a view de produtos', err);
    res.status(500).json({ erro: err.message, view: VIEW_SHOP });
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
    const colunas = await lerColunas(pedidas.length ? pedidas : TABELAS_PADRAO);
    res.json({ database: process.env.FB_DATABASE || null, colunas });
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
      ensureUpdaterSchedule();
    } catch (err) {
      logError('[ZapRun] Falha ao garantir o agendamento do updater', err);
    }
  });
}

module.exports = { app };
