// Testes da adaptação da view ao schema real do ERP.
// Rodam sem Firebird e sem rede: `npm test` na pasta backend.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { adaptarAoSchema, separarComandos, SQL_PATH } = require('./migrations');

const VIEW = fs.readFileSync(SQL_PATH, 'utf8');

test('ERP COM a coluna MULTCAIXA: a view usa p.multcaixa', () => {
  const { sql, ausentes } = adaptarAoSchema(VIEW, { PRODUTO: [{ coluna: 'CDPRODUTO' }, { coluna: 'MEMOOBS' }, { coluna: 'MULTCAIXA' }, { coluna: 'PESOUNIT' }, { coluna: 'PESOBRUTO' }] });
  assert.deepStrictEqual(ausentes, []);
  assert.match(separarComandos(sql).join('\n'), /p\.multcaixa/);
  assert.match(separarComandos(sql).join('\n'), /NULLIF\(p\.pesounit, 0\), p\.pesobruto/);
});

test('ERP SEM a coluna: a view sobe com NULL no lugar, e a coluna MULTCAIXA continua na lista', () => {
  const { sql, ausentes } = adaptarAoSchema(VIEW, { PRODUTO: [{ coluna: 'CDPRODUTO' }] });
  assert.deepStrictEqual(ausentes, ['PRODUTO.MEMOOBS', 'PRODUTO.MULTCAIXA', 'PRODUTO.PESOUNIT', 'PRODUTO.PESOBRUTO']);
  const comando = separarComandos(sql).join('\n');
  assert.doesNotMatch(comando, /p\.multcaixa/i);
  assert.match(comando, /CAST\(NULL AS DOUBLE PRECISION\)/);
  assert.doesNotMatch(comando, /p\.memoobs/i);
  assert.match(comando, /MULTCAIXA,\s*PESO\)/);
  assert.doesNotMatch(comando, /p\.peso/i);
});

test('schema ilegível (null): trata como ausente — o lado seguro', () => {
  const { ausentes } = adaptarAoSchema(VIEW, null);
  assert.deepStrictEqual(ausentes, ['PRODUTO.MEMOOBS', 'PRODUTO.MULTCAIXA', 'PRODUTO.PESOUNIT', 'PRODUTO.PESOBRUTO']);
});

test('base com MEMOBS (um O só): a view usa p.memobs, sem NULL', () => {
  const { sql, ausentes } = adaptarAoSchema(VIEW, { PRODUTO: [{ coluna: 'MEMOBS' }, { coluna: 'MULTCAIXA' }, { coluna: 'PESOUNIT' }, { coluna: 'PESOBRUTO' }] });
  assert.deepStrictEqual(ausentes, []);
  assert.match(separarComandos(sql).join('\n'), /p\.memobs/);
});

test('só PESOBRUTO no ERP: PESOUNIT vira NULL e o peso sai do bruto', () => {
  const { sql, ausentes } = adaptarAoSchema(VIEW, { PRODUTO: [{ coluna: 'MEMOOBS' }, { coluna: 'MULTCAIXA' }, { coluna: 'PESOBRUTO' }] });
  assert.deepStrictEqual(ausentes, ['PRODUTO.PESOUNIT']);
  assert.match(separarComandos(sql).join('\n'), /NULLIF\(CAST\(NULL AS DOUBLE PRECISION\), 0\), p\.pesobruto/);
});
