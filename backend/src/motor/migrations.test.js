// Testes da adaptação da view ao schema real do ERP.
// Rodam sem Firebird e sem rede: `npm test` na pasta backend.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { adaptarAoSchema, separarComandos, SQL_PATH } = require('./migrations');

const VIEW = fs.readFileSync(SQL_PATH, 'utf8');

test('ERP COM a coluna MULTCAIXA: a view usa p.multcaixa', () => {
  const { sql, ausentes } = adaptarAoSchema(VIEW, { PRODUTO: [{ coluna: 'CDPRODUTO' }, { coluna: 'MULTCAIXA' }] });
  assert.deepStrictEqual(ausentes, []);
  assert.match(separarComandos(sql).join('\n'), /p\.multcaixa/);
});

test('ERP SEM a coluna: a view sobe com NULL no lugar, e a coluna MULTCAIXA continua na lista', () => {
  const { sql, ausentes } = adaptarAoSchema(VIEW, { PRODUTO: [{ coluna: 'CDPRODUTO' }] });
  assert.deepStrictEqual(ausentes, ['PRODUTO.MULTCAIXA']);
  const comando = separarComandos(sql).join('\n');
  assert.doesNotMatch(comando, /p\.multcaixa/i);
  assert.match(comando, /CAST\(NULL AS DOUBLE PRECISION\)/);
  assert.match(comando, /MULTCAIXA\)/);
});

test('schema ilegível (null): trata como ausente — o lado seguro', () => {
  const { ausentes } = adaptarAoSchema(VIEW, null);
  assert.deepStrictEqual(ausentes, ['PRODUTO.MULTCAIXA']);
});
