// Testes da transformação view → catálogo.
// Rodam sem Firebird e sem rede: `npm test` na pasta backend.

const test = require('node:test');
const assert = require('node:assert');

const {
  agruparProdutos,
  apenasContrato,
  montarSqlProdutos,
  chaveDaLinha,
  toCodigoBarras,
  toNumber,
  toInt
} = require('./mapping');

// Helper: monta o valor como o driver devolveria uma coluna CHARACTER SET
// OCTETS — Buffer com os bytes WIN1252 crus.
const win1252 = s => Buffer.from(s, 'latin1');

/** Uma linha da view, com os textos já em Buffer. */
function linha({ cd, desc, grupo, codbarra, idpreco, tabela, preco, cddep, dep, saldo, empresa }) {
  const row = { CDPRODUTO: cd };
  if (desc !== undefined) row.PRODUTO_DESCRICAO = win1252(desc);
  if (grupo !== undefined) row.GRUPO = win1252(grupo);
  if (codbarra !== undefined) row.CODBARRA = codbarra === null ? null : win1252(codbarra);
  if (idpreco !== undefined) row.IDPRECO = idpreco;
  if (tabela !== undefined) row.TABELA_PRECO = tabela === null ? null : win1252(tabela);
  if (preco !== undefined) row.PRECO = preco;
  if (cddep !== undefined) row.CDDEPOSITO = cddep;
  if (dep !== undefined) row.DEPOSITO_DESCRICAO = dep === null ? null : win1252(dep);
  if (saldo !== undefined) row.SALDO = saldo;
  if (empresa !== undefined) row.IDEMPRESA = empresa;
  return row;
}

// ── Helpers de conversão ─────────────────────────────────────────────────────

test('toNumber aceita número, ponto decimal e vírgula pt-BR', () => {
  assert.strictEqual(toNumber(44.99), 44.99);
  assert.strictEqual(toNumber('1234.56'), 1234.56);
  assert.strictEqual(toNumber('1.234,56'), 1234.56);
  assert.strictEqual(toNumber(''), null);
  assert.strictEqual(toNumber(null), null);
  assert.strictEqual(toNumber('abc'), null);
});

test('toInt trunca sem arredondar', () => {
  assert.strictEqual(toInt('7.9'), 7);
  assert.strictEqual(toInt(null), null);
});

test('toCodigoBarras preserva zero à esquerda e descarta "sem código"', () => {
  // O motivo de o código de barras nunca passar por Number: como número,
  // "0001234567890" viraria 1234567890 e o produto ficaria inencontrável.
  assert.strictEqual(toCodigoBarras(win1252('0001234567890')), '0001234567890');
  assert.strictEqual(toCodigoBarras(win1252(' 7908572802578 ')), '7908572802578');
  assert.strictEqual(toCodigoBarras(win1252('0')), null);
  assert.strictEqual(toCodigoBarras(win1252('000000')), null);
  assert.strictEqual(toCodigoBarras(null), null);
  assert.strictEqual(toCodigoBarras(win1252('')), null);
});

// ── SQL ──────────────────────────────────────────────────────────────────────

test('montarSqlProdutos: sem filtro lê tudo; com filtro usa parâmetro', () => {
  const todos = montarSqlProdutos();
  assert.match(todos.sql, /SELECT \* FROM ZAPRUN_SHOP ORDER BY CDPRODUTO/);
  assert.deepStrictEqual(todos.params, []);

  const um = montarSqlProdutos(8390);
  assert.match(um.sql, /WHERE CDPRODUTO = \?/);
  assert.deepStrictEqual(um.params, [8390]);
});

test('montarSqlProdutos nunca interpola a entrada — SQL injection não passa', () => {
  // O parâmetro vem de um query param HTTP. Se algum dia alguém trocar o `?`
  // por template string, este teste quebra antes de virar incidente.
  //
  // Entrada que não é um inteiro limpo é REJEITADA por inteiro (nenhum WHERE),
  // e não coagida ao número que dá para arrancar dela: "1; DROP TABLE PRODUTO"
  // não vira `WHERE CDPRODUTO = 1`. Ler o catálogo todo é uma resposta honesta;
  // devolver o produto 1 seria fingir que a entrada fazia sentido.
  const malicioso = montarSqlProdutos('1; DROP TABLE PRODUTO');
  assert.ok(!malicioso.sql.includes('DROP'));
  assert.ok(!malicioso.sql.includes('WHERE'));
  assert.deepStrictEqual(malicioso.params, []);

  const lixo = montarSqlProdutos('abc');
  assert.deepStrictEqual(lixo.params, []);
  assert.ok(!lixo.sql.includes('WHERE'));

  // Já um inteiro legítimo em string (é como chega do query param) passa.
  assert.deepStrictEqual(montarSqlProdutos('8390').params, [8390]);
});

// ── Identidade ───────────────────────────────────────────────────────────────

test('chaveDaLinha exige CDPRODUTO e separa por empresa quando há IDEMPRESA', () => {
  assert.strictEqual(chaveDaLinha({ CDPRODUTO: 8390 }), '8390');
  assert.strictEqual(chaveDaLinha({ CDPRODUTO: 8390, IDEMPRESA: 2 }), '2::8390');
  assert.strictEqual(chaveDaLinha({ PRODUTO_DESCRICAO: win1252('sem código') }), null);
  assert.strictEqual(chaveDaLinha({}), null);
});

// ── O contrato ───────────────────────────────────────────────────────────────

test('produz exatamente a estrutura acordada', () => {
  const { produtos } = agruparProdutos([
    linha({
      cd: 8390, desc: 'NOME DO PRODUTO', grupo: 'NOME DO GRUPO',
      codbarra: '7908572802578',
      idpreco: 1, tabela: 'CARTAO', preco: 44.99,
      cddep: 1004, dep: 'CASA X', saldo: 319.19
    })
  ]);

  assert.deepStrictEqual(produtos.map(apenasContrato), [
    {
      cdproduto: 8390,
      descricao: 'NOME DO PRODUTO',
      grupo: 'NOME DO GRUPO',
      codigos_barra: ['7908572802578'],
      precos: [{ idpreco: 1, tabela: 'CARTAO', preco: 44.99 }],
      estoque: [{ cddeposito: 1004, deposito: 'CASA X', saldo: 319.19 }]
    }
  ]);
});

// ── O produto cartesiano: o defeito que este arquivo existe para evitar ──────

test('deduplica as três dimensões vindas do produto cartesiano', () => {
  // 2 códigos de barra × 2 tabelas de preço × 2 depósitos = 8 linhas para UM
  // produto. Sem deduplicar, sairiam 8 códigos, 8 preços e 8 depósitos.
  const rows = [];
  for (const cb of ['7908572802578', '7891234567890']) {
    for (const [idp, tab, pr] of [[1, 'CARTAO', 44.99], [2, 'DINHEIRO', 39.9]]) {
      for (const [cdd, dp, sl] of [[1004, 'CASA X', 319.19], [1005, 'DEPOSITO 2', 0]]) {
        rows.push(linha({
          cd: 8390, desc: 'PRODUTO', grupo: 'GRUPO',
          codbarra: cb, idpreco: idp, tabela: tab, preco: pr,
          cddep: cdd, dep: dp, saldo: sl
        }));
      }
    }
  }
  assert.strictEqual(rows.length, 8);

  const { produtos } = agruparProdutos(rows);
  assert.strictEqual(produtos.length, 1);

  const p = produtos[0];
  assert.deepStrictEqual(p.codigos_barra, ['7908572802578', '7891234567890']);
  assert.deepStrictEqual(p.precos, [
    { idpreco: 1, tabela: 'CARTAO', preco: 44.99 },
    { idpreco: 2, tabela: 'DINHEIRO', preco: 39.9 }
  ]);
  assert.deepStrictEqual(p.estoque, [
    { cddeposito: 1004, deposito: 'CASA X', saldo: 319.19 },
    { cddeposito: 1005, deposito: 'DEPOSITO 2', saldo: 0 }
  ]);
});

test('agrupa vários produtos preservando a ordem de chegada', () => {
  const { produtos } = agruparProdutos([
    linha({ cd: 8390, desc: 'A', codbarra: '111' }),
    linha({ cd: 42, desc: 'B', codbarra: '222' }),
    linha({ cd: 8390, desc: 'A', codbarra: '333' })
  ]);

  assert.deepStrictEqual(produtos.map(p => p.cdproduto), [8390, 42]);
  assert.deepStrictEqual(produtos[0].codigos_barra, ['111', '333']);
});

// ── LEFT JOIN: nulos nunca entram nos arrays ─────────────────────────────────

test('produto sem código de barras, sem preço e sem estoque vira arrays vazios', () => {
  // É a linha que o LEFT JOIN devolve para um produto recém-cadastrado.
  const { produtos } = agruparProdutos([
    linha({
      cd: 999, desc: 'PRODUTO NOVO', grupo: 'GERAL',
      codbarra: null, idpreco: null, tabela: null, preco: null,
      cddep: null, dep: null, saldo: null
    })
  ]);

  assert.deepStrictEqual(apenasContrato(produtos[0]), {
    cdproduto: 999,
    descricao: 'PRODUTO NOVO',
    grupo: 'GERAL',
    codigos_barra: [],
    precos: [],
    estoque: []
  });
});

test('nenhum array contém null quando só parte das pontas 1:N existe', () => {
  const { produtos } = agruparProdutos([
    // tem preço, não tem depósito nem código de barras
    linha({ cd: 7, codbarra: null, idpreco: 1, tabela: 'CARTAO', preco: 10, cddep: null, dep: null, saldo: null }),
    // tem depósito, não tem preço
    linha({ cd: 7, codbarra: null, idpreco: null, tabela: null, preco: null, cddep: 3, dep: 'LOJA', saldo: 5 })
  ]);

  const p = produtos[0];
  assert.deepStrictEqual(p.codigos_barra, []);
  assert.deepStrictEqual(p.precos, [{ idpreco: 1, tabela: 'CARTAO', preco: 10 }]);
  assert.deepStrictEqual(p.estoque, [{ cddeposito: 3, deposito: 'LOJA', saldo: 5 }]);
  for (const arr of [p.codigos_barra, p.precos, p.estoque]) {
    assert.ok(arr.every(x => x !== null && x !== undefined));
  }
});

test('saldo zero é preservado — é o que marca "esgotado" na loja', () => {
  const { produtos } = agruparProdutos([
    linha({ cd: 5, cddep: 1, dep: 'LOJA', saldo: 0 })
  ]);
  assert.deepStrictEqual(produtos[0].estoque, [{ cddeposito: 1, deposito: 'LOJA', saldo: 0 }]);
});

test('preço nulo não vira entrada, mesmo com a tabela preenchida', () => {
  // { idpreco: 3, tabela: "ATACADO", preco: null } seria pior que a ausência:
  // o servidor trataria como preço zero.
  const { produtos } = agruparProdutos([
    linha({ cd: 5, idpreco: 3, tabela: 'ATACADO', preco: null })
  ]);
  assert.deepStrictEqual(produtos[0].precos, []);
});

// ── Anomalias e escopo ───────────────────────────────────────────────────────

test('linha sem CDPRODUTO é contada, não ignorada em silêncio', () => {
  const { produtos, descartadas } = agruparProdutos([
    linha({ cd: 1, desc: 'OK' }),
    { PRODUTO_DESCRICAO: win1252('SEM CODIGO'), PRECO: 10 },
    { CDPRODUTO: null, PRECO: 20 }
  ]);

  assert.strictEqual(produtos.length, 1);
  assert.strictEqual(descartadas, 2);
});

test('recorta por empresa quando o token não autoriza todas', () => {
  const rows = [
    linha({ cd: 1, desc: 'DA EMPRESA 1', empresa: 1 }),
    linha({ cd: 1, desc: 'DA EMPRESA 2', empresa: 2 })
  ];

  const { produtos, foraDoEscopo } = agruparProdutos(rows, [1]);
  assert.strictEqual(produtos.length, 1);
  assert.strictEqual(produtos[0].descricao, 'DA EMPRESA 1');
  assert.strictEqual(foraDoEscopo, 1);

  // Mesmo CDPRODUTO em empresas diferentes são produtos diferentes.
  const ambas = agruparProdutos(rows, [1, 2]);
  assert.strictEqual(ambas.produtos.length, 2);
});

test('acentuação WIN1252 é decodificada corretamente', () => {
  // Se este teste falhar, o problema está na VIEW (esqueceu o CAST ... OCTETS),
  // não aqui. Ver motor/encoding.js.
  const { produtos } = agruparProdutos([
    linha({ cd: 1, desc: 'CAFÉ EM PÓ 500G', grupo: 'ALIMENTAÇÃO' })
  ]);
  assert.strictEqual(produtos[0].descricao, 'CAFÉ EM PÓ 500G');
  assert.strictEqual(produtos[0].grupo, 'ALIMENTAÇÃO');
});

test('entrada vazia não quebra', () => {
  assert.deepStrictEqual(agruparProdutos([]), { produtos: [], descartadas: 0, foraDoEscopo: 0 });
  assert.deepStrictEqual(agruparProdutos(null), { produtos: [], descartadas: 0, foraDoEscopo: 0 });
});

test('o produto entregue é JSON puro — nenhum Set/Map vaza do agrupamento', () => {
  // Os índices de deduplicação vivem num Map paralelo justamente para isso: se
  // vazassem para dentro do produto, JSON.stringify os serializaria como {}.
  const { produtos } = agruparProdutos([
    linha({ cd: 1, desc: 'X', codbarra: '123', idpreco: 1, tabela: 'A', preco: 9.9, cddep: 1, dep: 'D', saldo: 2 })
  ]);
  const roundtrip = JSON.parse(JSON.stringify(apenasContrato(produtos[0])));
  assert.deepStrictEqual(roundtrip, apenasContrato(produtos[0]));
});
