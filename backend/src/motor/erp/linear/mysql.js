// motor/erp/linear/mysql.js
// Conexão com o MySQL do Linear Sistemas.
//
// Diferente do Automec, o banco NÃO está na máquina do cliente: fica na nuvem
// da Linear, alcançável só pela VPN (OpenVPN) que a Linear entrega para a loja.
// O host padrão (10.0.32.42) é o único endereço que essa VPN roteia.
//
// O usuário é o de BI (`<cnpj8>_bi`), SÓ LEITURA: não cria view, não cria nem
// tabela temporária. Por isso a consulta mora no Motor (consulta.js), e não
// num `CREATE VIEW` aplicado no boot como no Firebird.
//
// `mysql2` é carregado sob demanda, e isso é deliberado: o updater NÃO roda
// `npm install` (backend/node_modules é preservado), então as instalações
// Automec que receberem esta versão por atualização automática não têm o
// pacote. Um `require` no topo derrubaria o serviço delas no boot. Só quem
// instala como Linear passa pelo INSTALAR.bat, que instala as dependências.

const QUERY_TIMEOUT_MS = parseInt(process.env.LINEAR_QUERY_TIMEOUT || '120000', 10);
const CONNECT_TIMEOUT_MS = parseInt(process.env.LINEAR_CONNECT_TIMEOUT || '15000', 10);

function opcoes() {
  return {
    host: process.env.LINEAR_HOST || '10.0.32.42',
    port: Number(process.env.LINEAR_PORT || 3306),
    database: process.env.LINEAR_DATABASE || '',
    user: process.env.LINEAR_USER || '',
    password: process.env.LINEAR_PASSWORD || '',
    charset: 'utf8mb4',
    // Data como texto 'YYYY-MM-DD': sem isto o driver cria um Date no fuso da
    // máquina, e o fim de uma promoção pode "andar" um dia na conversão.
    dateStrings: true,
    connectTimeout: CONNECT_TIMEOUT_MS
  };
}

function carregarDriver() {
  try {
    return require('mysql2/promise');
  } catch (err) {
    throw new Error(
      'Pacote mysql2 não instalado. Rode o INSTALAR.bat de novo nesta máquina (ele executa o npm install).'
    );
  }
}

/** @type {any} */
let _pool = null;
function getPool() {
  if (!_pool) {
    // Duas conexões bastam: o ciclo faz UMA consulta, e a segunda serve à rota
    // /produtos de diagnóstico enquanto um ciclo roda. Mais que isso só
    // ocuparia conexões num banco que não é nosso.
    _pool = carregarDriver().createPool({ ...opcoes(), connectionLimit: 2, enableKeepAlive: true });
  }
  return _pool;
}

/**
 * Executa um SELECT parametrizado. `?` do mysql2 escapa cada parâmetro — nunca
 * concatene entrada externa na string.
 *
 * @param {string} sql
 * @param {Array<unknown>} [params]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function query(sql, params = []) {
  const [rows] = await getPool().query({ sql, timeout: QUERY_TIMEOUT_MS }, params);
  return /** @type {any} */ (rows) || [];
}

/**
 * Teste de vida: abre uma conexão AVULSA, fora do pool, e roda `SELECT 1`.
 *
 * Avulsa pelo mesmo motivo do Firebird: um ciclo ocupando o pool não pode
 * fazer o /health responder "quebrado" e o updater reverter uma versão sadia.
 * Timeout curto: sem VPN o connect fica pendurado, e o /health não pode.
 *
 * @returns {Promise<{ ok: boolean, erro?: string }>}
 */
async function testarConexao() {
  const o = opcoes();
  if (!o.database || !o.user) {
    return { ok: false, erro: 'LINEAR_DATABASE e LINEAR_USER precisam estar no backend/.env' };
  }
  let conexao = null;
  try {
    conexao = await carregarDriver().createConnection({ ...o, connectTimeout: 5000 });
    await conexao.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, erro: explicarErro(err) };
  } finally {
    if (conexao) await conexao.end().catch(() => {});
  }
}

/**
 * Traduz os erros que aparecem de verdade na implantação para o que fazer.
 *
 * Quem lê é o implantador, olhando a tela do instalador ou o /status — não
 * "ETIMEDOUT", e sim "a VPN está desligada".
 *
 * @param {any} err
 * @returns {string}
 */
function explicarErro(err) {
  const codigo = err && err.code;
  const msg = (err && err.message) || String(err);
  if (codigo === 'ETIMEDOUT' || codigo === 'EHOSTUNREACH' || codigo === 'ENETUNREACH') {
    return `Sem acesso ao banco da Linear (${msg}). Confira se a VPN da Linear está conectada nesta máquina.`;
  }
  if (codigo === 'ECONNREFUSED') {
    return `O servidor recusou a conexão (${msg}). Confira LINEAR_HOST e LINEAR_PORT.`;
  }
  if (codigo === 'ER_ACCESS_DENIED_ERROR') {
    return `Usuário ou senha do banco recusados (${msg}). Confira LINEAR_USER e LINEAR_PASSWORD.`;
  }
  if (codigo === 'ER_DBACCESS_DENIED_ERROR' || codigo === 'ER_BAD_DB_ERROR') {
    return `Banco não encontrado ou sem permissão (${msg}). Confira LINEAR_DATABASE (bd + CNPJ, só números).`;
  }
  return msg;
}

module.exports = { query, testarConexao, explicarErro, opcoes };
