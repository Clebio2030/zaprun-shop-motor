// Testes da rota GET /produtos — do query param até o JSON de resposta.
//
// Sobem o Express de verdade (porta efêmera) e batem nele com fetch. O que NÃO
// é real é o Firebird: ele é substituído no require.cache antes de qualquer
// módulo carregá-lo, então a suíte roda em qualquer SO, sem banco e sem rede.
// É este teste que garante que o `?cdproduto=` vira WHERE parametrizado.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ── Dublê do Firebird ────────────────────────────────────────────────────────
// Precisa ser instalado ANTES de require('../server'), que carrega o extractor,
// que carrega o firebird. Depois disso o cache já teria o módulo real.

const firebirdPath = require.resolve('./firebird');

/** Última query executada — o teste inspeciona SQL e parâmetros. */
let ultimaQuery = null;
/** O que o "banco" devolve na próxima chamada. */
let proximasLinhas = [];
/** Quando preenchido, a próxima query rejeita com este erro. */
let proximoErro = null;

require.cache[firebirdPath] = {
  id: firebirdPath,
  filename: firebirdPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    query: async (sql, params) => {
      ultimaQuery = { sql, params };
      if (proximoErro) {
        const err = proximoErro;
        proximoErro = null;
        throw err;
      }
      return proximasLinhas;
    }
  }
};

// Sem isto, carregar o motor agendaria o cron e dispararia um ciclo real.
process.env.ZAPRUN_DISABLE_BOOTSTRAP = 'true';
// Mantém o estado de sincronização dos testes fora do arquivo de produção.
process.env.ZAPRUN_STATE_FILE = path.join(
  require('os').tmpdir(),
  `zaprun-shop-test-${process.pid}.json`
);

const { app } = require('../server');

const win1252 = s => Buffer.from(s, 'latin1');

/** Sobe o app numa porta livre, roda o teste e derruba. */
async function comServidor(fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  try {
    return await fn(caminho => fetch(`http://127.0.0.1:${port}${caminho}`));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// ── Testes ───────────────────────────────────────────────────────────────────

test('GET /produtos devolve o catálogo agrupado', async () => {
  proximasLinhas = [
    {
      CDPRODUTO: 8390,
      PRODUTO_DESCRICAO: win1252('NOME DO PRODUTO'),
      GRUPO: win1252('NOME DO GRUPO'),
      CODBARRA: win1252('7908572802578'),
      IDPRECO: 1,
      TABELA_PRECO: win1252('CARTAO'),
      PRECO: 44.99,
      CDDEPOSITO: 1004,
      DEPOSITO_DESCRICAO: win1252('CASA X'),
      SALDO: 319.19
    }
  ];

  await comServidor(async get => {
    const res = await get('/produtos');
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.deepStrictEqual(body.produtos, [
      {
        cdproduto: 8390,
        descricao: 'NOME DO PRODUTO',
        grupo: 'NOME DO GRUPO',
        codigos_barra: ['7908572802578'],
        precos: [{ idpreco: 1, tabela: 'CARTAO', preco: 44.99 }],
        estoque: [{ cddeposito: 1004, deposito: 'CASA X', saldo: 319.19 }]
      }
    ]);

    // Sem filtro: nenhum WHERE, nenhum parâmetro.
    assert.ok(!ultimaQuery.sql.includes('WHERE'));
    assert.deepStrictEqual(ultimaQuery.params, []);
  });
});

test('GET /produtos?cdproduto= filtra com WHERE parametrizado', async () => {
  proximasLinhas = [{ CDPRODUTO: 8390, PRODUTO_DESCRICAO: win1252('X') }];

  await comServidor(async get => {
    const res = await get('/produtos?cdproduto=8390');
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.produtos.length, 1);
    assert.strictEqual(body.produtos[0].cdproduto, 8390);

    assert.match(ultimaQuery.sql, /WHERE CDPRODUTO = \?/);
    assert.deepStrictEqual(ultimaQuery.params, [8390]);
  });
});

test('o _meta expõe o inchaço do produto cartesiano', async () => {
  // 4 linhas para 1 produto é o sinal que o implantador precisa ver quando
  // desconfia que a view multiplicou demais.
  proximasLinhas = [
    { CDPRODUTO: 1, CODBARRA: win1252('111'), IDPRECO: 1, PRECO: 10, CDDEPOSITO: 1, SALDO: 5 },
    { CDPRODUTO: 1, CODBARRA: win1252('111'), IDPRECO: 2, PRECO: 20, CDDEPOSITO: 1, SALDO: 5 },
    { CDPRODUTO: 1, CODBARRA: win1252('222'), IDPRECO: 1, PRECO: 10, CDDEPOSITO: 1, SALDO: 5 },
    { CDPRODUTO: 1, CODBARRA: win1252('222'), IDPRECO: 2, PRECO: 20, CDDEPOSITO: 1, SALDO: 5 }
  ];

  await comServidor(async get => {
    const body = await (await get('/produtos')).json();
    assert.strictEqual(body._meta.linhas, 4);
    assert.strictEqual(body._meta.produtos, 1);
    assert.strictEqual(body._meta.view, 'ZAPRUN_SHOP');
    assert.deepStrictEqual(body.produtos[0].codigos_barra, ['111', '222']);
    assert.strictEqual(body.produtos[0].precos.length, 2);
    assert.strictEqual(body.produtos[0].estoque.length, 1);
  });
});

test('a resposta não vaza campos internos do Motor', async () => {
  // `raw` e `erpCompanyId` servem ao ciclo de sync, não a quem consulta.
  proximasLinhas = [{ CDPRODUTO: 1, IDEMPRESA: 2, PRODUTO_DESCRICAO: win1252('X') }];

  await comServidor(async get => {
    const body = await (await get('/produtos')).json();
    assert.deepStrictEqual(Object.keys(body.produtos[0]).sort(), [
      'cdproduto', 'codigos_barra', 'descricao', 'estoque', 'grupo', 'precos'
    ]);
  });
});

test('cdproduto não numérico volta 400 sem tocar no banco', async () => {
  proximasLinhas = [];
  ultimaQuery = null;

  await comServidor(async get => {
    const res = await get('/produtos?cdproduto=abc');
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.erro, /inteiro/);
    // O banco não foi consultado: a validação veio antes.
    assert.strictEqual(ultimaQuery, null);
  });
});

test('produto inexistente volta 404, não uma lista vazia', async () => {
  proximasLinhas = [];

  await comServidor(async get => {
    const res = await get('/produtos?cdproduto=999999');
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.match(body.erro, /999999/);
  });
});

test('erro do Firebird chega legível, não como "erro interno"', async () => {
  // "Table unknown ZAPRUN_SHOP" é A resposta útil aqui — escondê-la
  // transformaria um diagnóstico de 5 segundos numa sessão remota.
  proximoErro = new Error('Dynamic SQL Error: Table unknown ZAPRUN_SHOP');

  await comServidor(async get => {
    const res = await get('/produtos');
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.match(body.erro, /Table unknown ZAPRUN_SHOP/);
    assert.strictEqual(body.view, 'ZAPRUN_SHOP');
  });
});
