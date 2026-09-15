// Testes do estado local e do hash do catálogo.
// Rodam sem Firebird e sem rede: `npm test` na pasta backend.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Estado isolado: nunca tocar no sync_state.json de produção.
process.env.ZAPRUN_STATE_FILE = path.join(
  os.tmpdir(),
  `zaprun-shop-state-${process.pid}.json`
);

const {
  generateHash,
  checkStateChanged,
  updateState,
  getLastSyncedAt,
  STATE_FILE_PATH
} = require('./syncState');

function limparEstado() {
  try {
    fs.unlinkSync(STATE_FILE_PATH);
  } catch (_) {
    /* não existia */
  }
}

/** Um produto no formato que o mapping entrega. */
function produto(over = {}) {
  return {
    cdproduto: 8390,
    descricao: 'PRODUTO',
    grupo: 'GRUPO',
    codigos_barra: ['7908572802578'],
    precos: [{ idpreco: 1, tabela: 'CARTAO', preco: 44.99 }],
    estoque: [{ cddeposito: 1004, deposito: 'CASA X', saldo: 319.19 }],
    ...over
  };
}

test('empresa nunca sincronizada não tem lastSyncedAt', () => {
  limparEstado();
  assert.strictEqual(getLastSyncedAt(1), null);
});

test('a ordem dos produtos não muda o hash', () => {
  const a = produto({ cdproduto: 1 });
  const b = produto({ cdproduto: 2 });
  assert.strictEqual(generateHash([a, b]), generateHash([b, a]));
});

test('a ordem DENTRO dos arrays 1:N não muda o hash', () => {
  // A view só tem ORDER BY CDPRODUTO: a ordem dos preços dentro de um produto é
  // indefinida e pode variar entre execuções do mesmo SELECT. Sem ordenar antes
  // de hashear, o Motor reenviaria o catálogo inteiro sem nada ter mudado.
  const precos = [
    { idpreco: 1, tabela: 'CARTAO', preco: 44.99 },
    { idpreco: 2, tabela: 'DINHEIRO', preco: 39.9 }
  ];
  const estoque = [
    { cddeposito: 1004, deposito: 'CASA X', saldo: 319.19 },
    { cddeposito: 1005, deposito: 'CASA Y', saldo: 0 }
  ];

  assert.strictEqual(
    generateHash([produto({ precos, estoque, codigos_barra: ['111', '222'] })]),
    generateHash([
      produto({
        precos: [...precos].reverse(),
        estoque: [...estoque].reverse(),
        codigos_barra: ['222', '111']
      })
    ])
  );
});

test('`raw` não entra no hash (colunas voláteis do ERP)', () => {
  const semRaw = produto();
  const comRaw = produto({ raw: { ULTIMA_ALTERACAO: '2026-09-15T10:00:00Z', CONTADOR: 991 } });
  assert.strictEqual(generateHash([semRaw]), generateHash([comRaw]));
});

test('mudança de preço muda o hash', () => {
  const antes = produto();
  const depois = produto({ precos: [{ idpreco: 1, tabela: 'CARTAO', preco: 49.99 }] });
  assert.notStrictEqual(generateHash([antes]), generateHash([depois]));
});

test('mudança de saldo muda o hash', () => {
  // Se isto passar a falhar, o Shop para de refletir "esgotado".
  const antes = produto();
  const depois = produto({ estoque: [{ cddeposito: 1004, deposito: 'CASA X', saldo: 0 }] });
  assert.notStrictEqual(generateHash([antes]), generateHash([depois]));
});

test('código de barras novo muda o hash', () => {
  const antes = produto();
  const depois = produto({ codigos_barra: ['7908572802578', '7891234567890'] });
  assert.notStrictEqual(generateHash([antes]), generateHash([depois]));
});

test('ciclo completo: muda → grava → não muda mais', () => {
  limparEstado();
  const catalogo = [produto()];

  const primeiro = checkStateChanged(1, catalogo);
  assert.strictEqual(primeiro.changed, true);

  updateState(1, primeiro.hash);
  assert.ok(getLastSyncedAt(1));

  const segundo = checkStateChanged(1, catalogo);
  assert.strictEqual(segundo.changed, false);

  // Alterou o preço no ERP → volta a mudar.
  const terceiro = checkStateChanged(1, [produto({ precos: [{ idpreco: 1, tabela: 'CARTAO', preco: 1 }] })]);
  assert.strictEqual(terceiro.changed, true);
});

test('empresas têm estados independentes', () => {
  limparEstado();
  const { hash } = checkStateChanged(1, [produto()]);
  updateState(1, hash);

  assert.strictEqual(checkStateChanged(1, [produto()]).changed, false);
  assert.strictEqual(checkStateChanged(2, [produto()]).changed, true);
});

test('arquivo de estado corrompido é tratado como vazio, sem derrubar o serviço', () => {
  fs.writeFileSync(STATE_FILE_PATH, '{ isto não é json', 'utf8');
  assert.strictEqual(getLastSyncedAt(1), null);
  assert.strictEqual(checkStateChanged(1, [produto()]).changed, true);
  limparEstado();
});
