// setup-env.js — escreve o backend/.env na instalação. Chamado pelo INSTALAR.bat.
//
// Dois modos:
//
//   node setup-env.js <host> <port> <database> <token> [porta]
//       Automec (Firebird). É o modo de SEMPRE: o INSTALAR.bat pergunta no
//       próprio .bat e passa os valores. "EMPTY_VAL" = manter o que está no
//       .env. Grava ERP_TIPO=automec.
//
//   node setup-env.js --linear
//       Linear Sistemas (MySQL pela VPN). INTERATIVO: as perguntas são feitas
//       aqui, e não no .bat, por causa da senha. A do banco da Linear tem `#` e
//       `@`, e uma senha com `!` ou `%` é corrompida pelo `set /p` do cmd com
//       delayed expansion — o implantador digitaria certo e o .env nasceria
//       errado, sem aviso. No Node a senha chega intacta. No fim, testa a
//       conexão e diz o que fazer se falhar (quase sempre: a VPN).
//
// Só credencial/caminho/token: o `.env` é PRESERVADO pelo updater, então config
// de frota (cron, lote, janela) não pode morar aqui — ela vem do handshake com
// o servidor a cada ciclo. Ver backend/.env.example.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Caminho do arquivo .env (na raiz do backend)
const envPath = path.join(__dirname, '.env');

// Template usado quando o .env ainda não existe.
const DEFAULT_ENV = `# Servidor local (escuta só em 127.0.0.1)
#
# 3010, e NÃO 3020: a 3020 é do Motor de Orçamentos, e as duas instalações
# convivem na mesma máquina do cliente. Com as duas na mesma porta, o segundo
# serviço a subir morre com EADDRINUSE — e o updater do primeiro passa a fazer
# health check no processo errado, o que é pior que falhar porque ninguém
# percebe. O healthUrl em updater/updater-config.json aponta para a 3010.
PORT=3010

# ERP desta loja: automec (Firebird local) ou linear (MySQL pela VPN da Linear).
ERP_TIPO=automec

# Firebird do ERP (Automec)
FB_HOST=127.0.0.1
FB_PORT=3050
FB_DATABASE=
FB_USER=SYSDBA
FB_PASSWORD=masterkey
FB_CHARSET=WIN1252

# ZapRun
ZAPRUN_TOKEN=
ZAPRUN_API_URL=https://dev.zaprun.com.br
`;

// ── Leitura e escrita do .env ────────────────────────────────────────────────

/**
 * Valor pronto para o .env, entre aspas quando precisa.
 *
 * O dotenv corta o valor sem aspas no primeiro ` #` e tira espaço das pontas;
 * foi assim que uma senha com `#` já chegou truncada ao banco (23/09/2026).
 * Aspas simples são literais no dotenv — nada de `\n` virar quebra de linha —,
 * então são a primeira escolha. Só quando o valor tem aspa simples caímos para
 * as duplas, e daí para crase.
 *
 * @param {string} valor
 */
function formatarValor(valor) {
  const s = String(valor);
  if (/^[A-Za-z0-9_.\-:/\\]*$/.test(s)) return s; // caminho, IP, token: sem aspas, como sempre foi
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"') && !s.includes('\\')) return `"${s}"`;
  return `\`${s}\``;
}

/**
 * Aplica `updates` sobre o conteúdo do .env: troca as chaves que existem,
 * acrescenta as que faltam, preserva o resto (comentários, ordem, chaves que
 * não são desta instalação).
 *
 * Valor vazio/ausente em `updates` = MANTER o que está no arquivo.
 *
 * @param {string} conteudo
 * @param {Record<string, string|undefined>} updates
 * @returns {string}
 */
function aplicarAtualizacoes(conteudo, updates) {
  const vale = v => v !== undefined && v !== null && v !== '' && v !== 'EMPTY_VAL';
  const processadas = new Set();
  const saida = [];

  for (const linha of conteudo.split(/\r?\n/)) {
    const casou = linha.match(/^\s*([A-Z0-9_]+)\s*=(.*)/i);
    if (casou && Object.prototype.hasOwnProperty.call(updates, casou[1].trim())) {
      const chave = casou[1].trim();
      if (processadas.has(chave)) continue; // chave repetida: fica só a primeira
      processadas.add(chave);
      saida.push(vale(updates[chave]) ? `${chave}=${formatarValor(String(updates[chave]))}` : linha);
    } else {
      saida.push(linha);
    }
  }

  for (const chave of Object.keys(updates)) {
    if (!processadas.has(chave) && vale(updates[chave])) {
      saida.push(`${chave}=${formatarValor(String(updates[chave]))}`);
    }
  }

  return saida.join(os.EOL);
}

/** Valores atuais do .env (para sugerir como padrão nas perguntas). */
function lerEnvAtual() {
  if (!fs.existsSync(envPath)) return {};
  try {
    return require('dotenv').parse(fs.readFileSync(envPath, 'utf8'));
  } catch (err) {
    return {};
  }
}

function gravar(updates) {
  const conteudo = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : DEFAULT_ENV;
  if (!fs.existsSync(envPath)) console.log('Arquivo .env não encontrado. Usando template padrão.');
  fs.writeFileSync(envPath, aplicarAtualizacoes(conteudo, updates), 'utf8');
  console.log('Arquivo .env salvo em:', envPath);
}

// ── Modo Automec (posicional, o de sempre) ──────────────────────────────────

function modoAutomec(args) {
  const valor = v => (v === 'EMPTY_VAL' ? '' : v);
  gravar({
    ERP_TIPO: 'automec',
    FB_HOST: valor(args[0]),
    FB_PORT: valor(args[1]),
    FB_DATABASE: valor(args[2]),
    ZAPRUN_TOKEN: valor(args[3]),
    PORT: valor(args[4])
  });
}

// ── Modo Linear (interativo) ────────────────────────────────────────────────

/** CNPJ só com dígitos, ou null. */
function soDigitosCnpj(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 14 ? d : null;
}

/**
 * Banco e usuário que a Linear dá para a loja seguem o CNPJ: banco "bd" + CNPJ
 * completo, usuário os 8 primeiros dígitos + "_bi". Conferido na loja
 * 17.124.086/0001-67 (bd17124086000167 / 17124086_bi).
 */
function sugestoesPorCnpj(cnpj) {
  const d = soDigitosCnpj(cnpj);
  if (!d) return null;
  return { database: `bd${d}`, user: `${d.slice(0, 8)}_bi` };
}

async function modoLinear() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Senha sem eco: o implantador pode estar com o cliente olhando a tela, ou
  // compartilhando a tela por AnyDesk.
  let mudo = false;
  const escreverOriginal = /** @type {any} */ (rl)._writeToOutput;
  /** @type {any} */ (rl)._writeToOutput = function (s) {
    if (mudo && !/\r?\n/.test(s)) return;
    escreverOriginal.call(rl, s);
  };

  // As respostas são lidas de uma FILA de linhas, e não por rl.question: com a
  // entrada vinda de pipe (teste automatizado, ou alguém colando as respostas
  // de uma vez), o question perde as linhas que chegam antes da pergunta e o
  // script morre no meio sem gravar o .env.
  const linhas = rl[Symbol.asyncIterator]();
  let entradaAcabou = false;

  /** @returns {Promise<string>} */
  const perguntar = async (texto, padrao = '', { secreto = false } = {}) => {
    const sufixo = padrao ? (secreto ? ' [Enter mantém a atual]' : ` [${padrao}]`) : '';
    process.stdout.write(`${texto}${sufixo}: `);
    mudo = secreto;
    const { value, done } = await linhas.next();
    if (done) entradaAcabou = true;
    mudo = false;
    if (secreto) process.stdout.write(os.EOL);
    const resposta = done ? '' : String(value).trim();
    return resposta === '' ? padrao : resposta;
  };

  const atual = lerEnvAtual();

  console.log('');
  console.log('Dados do banco da Linear. Quem fornece é o suporte da Linear.');
  console.log('Deixe em branco para aceitar o valor entre colchetes.');
  console.log('');

  const cnpj = await perguntar('CNPJ da loja (só para sugerir banco e usuário; Enter pula)', '');
  const sugestao = sugestoesPorCnpj(cnpj);
  if (cnpj && !sugestao) console.log('  CNPJ precisa ter 14 dígitos — sem sugestão, siga preenchendo.');

  const host = await perguntar('Endereço do banco (LINEAR_HOST)', atual.LINEAR_HOST || '10.0.32.42');
  const porta = await perguntar('Porta (LINEAR_PORT)', atual.LINEAR_PORT || '3306');
  const banco = await perguntar(
    'Nome do banco (LINEAR_DATABASE)',
    (sugestao && sugestao.database) || atual.LINEAR_DATABASE || ''
  );
  const usuario = await perguntar(
    'Usuário (LINEAR_USER)',
    (sugestao && sugestao.user) || atual.LINEAR_USER || ''
  );
  // A senha não aparece ao digitar — e foi exatamente por isso que, na
  // primeira loja (23/09/2026), ela ficou VAZIA: o implantador deu Enter
  // achando que o campo não respondia, o .env nasceu sem LINEAR_PASSWORD e o
  // teste de conexão (que falhou antes, por VPN) não denunciou. Agora: vazia
  // sem senha anterior é recusada, e o tamanho do que chegou é mostrado — dá
  // retorno sem expor a senha na tela.
  let senha = '';
  for (;;) {
    senha = await perguntar('Senha (LINEAR_PASSWORD) — não aparece ao digitar', atual.LINEAR_PASSWORD || '', {
      secreto: true
    });
    if (senha || entradaAcabou) break;
    console.log('  A senha não pode ficar vazia. Digite (ou cole com o botão direito) e dê Enter.');
  }
  console.log(
    senha === atual.LINEAR_PASSWORD
      ? '  Mantida a senha que já estava no .env.'
      : `  Senha recebida (${senha.length} caracteres).`
  );
  const empresa = await perguntar('Empresa no Linear (LINEAR_EMPRESA)', atual.LINEAR_EMPRESA || '1');

  console.log('');
  console.log('O TOKEN é gerado no painel do ZapRun, em Loja > Integração ERP.');
  const token = await perguntar('ZAPRUN_TOKEN', atual.ZAPRUN_TOKEN || '');

  gravar({
    ERP_TIPO: 'linear',
    LINEAR_HOST: host,
    LINEAR_PORT: porta,
    LINEAR_DATABASE: banco,
    LINEAR_USER: usuario,
    LINEAR_PASSWORD: senha,
    LINEAR_EMPRESA: empresa,
    ZAPRUN_TOKEN: token
  });

  // Teste de conexão com o que acabou de ser gravado — lido DO ARQUIVO, para
  // testar o .env de verdade (aspas incluídas), não os valores em memória.
  const env = require('dotenv').parse(fs.readFileSync(envPath, 'utf8'));
  for (const k of Object.keys(env)) process.env[k] = env[k];
  const { testarConexao } = require('./src/motor/erp/linear/mysql');

  for (;;) {
    console.log('');
    console.log('Testando a conexão com o banco da Linear...');
    const r = await testarConexao();
    if (r.ok) {
      console.log('[SUCESSO] Conectou no banco da Linear.');
      break;
    }
    console.log(`[ATENÇÃO] ${r.erro}`);
    const deNovo = await perguntar('Tentar de novo? Confira a VPN antes (S/N)', 'N');
    if (!/^s/i.test(deNovo)) {
      console.log('Seguindo sem conexão. O serviço tenta de novo a cada ciclo; acompanhe em http://127.0.0.1:3010/status');
      break;
    }
  }

  rl.close();
}

// ── Entrada ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  console.log('Iniciando configuração do ambiente...');
  if (args[0] === '--linear') {
    modoLinear().catch(err => {
      console.error('Erro ao configurar o .env:', err.message);
      process.exit(1);
    });
  } else {
    try {
      modoAutomec(args);
    } catch (err) {
      console.error('Erro ao salvar arquivo .env:', err.message);
      process.exit(1);
    }
  }
}

module.exports = { formatarValor, aplicarAtualizacoes, sugestoesPorCnpj, DEFAULT_ENV };
