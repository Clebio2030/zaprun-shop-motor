// motor/textoParaErp.js
// Texto que o Motor GRAVA no ERP (pedido → orçamento, ADR-307 do ZapRun).
//
// É o espelho de encoding.js, que trata a LEITURA. O problema é o mesmo, do
// outro lado:
//
//   o node-firebird 1.1.9 ignora a opção `charset` e conecta sempre em UTF8
//   (isc_dpb_lc_ctype vem de `options.encoding`, que ninguém passa). As colunas
//   do Automec são CHARACTER SET NONE com bytes WIN1252. Um parâmetro UTF8
//   gravado direto numa coluna NONE vai como os bytes UTF-8 — "JOSÉ" vira
//   4A 4F 53 C3 89, que a tela do Automec (Delphi, ANSI) mostra "JOSÃ‰".
//
// Solução, em duas metades que precisam existir juntas:
//
//   1. aqui: o texto vira algo que EXISTE em WIN1252 (o que não existe — emoji,
//      ideograma, símbolo — é dobrado para a letra sem acento ou removido) e é
//      cortado no tamanho da coluna (maior que a coluna derruba o INSERT inteiro
//      com "string right truncation");
//   2. no SQL: o parâmetro entra como CAST(? AS VARCHAR(n) CHARACTER SET WIN1252).
//      O Firebird translitera UTF8 → WIN1252 e a coluna NONE recebe os bytes
//      WIN1252, que é o que o Automec lê.
//
// O auto-teste (`testarEscritaWin1252`) confirma no banco do cliente que a
// volta dá os bytes certos. Se não der, o Motor grava SEM ACENTO
// (`modo = 'ascii'`): perder o acento é aceitável; gravar lixo, não.

// Caracteres da faixa 0x80–0x9F do WIN1252 (o resto do WIN1252 é latin1).
const WIN1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

function existeEmWin1252(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  if (cp < 0x80) return true;
  if (cp >= 0xA0 && cp <= 0xFF) return true;
  return WIN1252_EXTRA.has(ch);
}

/** Tira o acento de UMA letra ("ã" → "a"); devolve '' se não sobrar ASCII. */
// Letras que o NFD não decompõe (não têm acento "combinante").
const SEM_DECOMPOSICAO = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', Ŧ: 'T', ŧ: 't' };

function semAcento(ch) {
  if (SEM_DECOMPOSICAO[ch]) return SEM_DECOMPOSICAO[ch];
  return ch.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '');
}

/**
 * Texto pronto para uma coluna de texto do ERP.
 *
 * @param {unknown} valor
 * @param {number|null} tamanho  caracteres da coluna (null = sem corte)
 * @param {'win1252'|'ascii'} modo
 * @returns {string|null} null quando não sobra texto
 */
function textoParaErp(valor, tamanho = null, modo = 'win1252') {
  if (valor === null || valor === undefined) return null;
  let texto = String(valor).normalize('NFC');
  let saida = '';
  for (const ch of texto) {
    if (ch === '\r' || ch === '\n' || ch === '\t') {
      saida += ' ';
      continue;
    }
    const cp = ch.codePointAt(0) || 0;
    if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) continue; // controle
    if (modo === 'ascii') {
      saida += cp < 0x80 ? ch : semAcento(ch);
    } else {
      saida += existeEmWin1252(ch) ? ch : semAcento(ch);
    }
  }
  texto = saida.replace(/\s+/g, ' ').trim();
  if (tamanho && tamanho > 0 && texto.length > tamanho) texto = texto.slice(0, tamanho).trimEnd();
  return texto === '' ? null : texto;
}

/**
 * Fragmento SQL do parâmetro de texto. Em WIN1252 o CAST faz a transliteração;
 * em ASCII não precisa (os bytes são iguais nos dois).
 */
function marcadorDeTexto(tamanho, modo = 'win1252') {
  if (modo !== 'win1252') return '?';
  const n = Math.max(1, Number(tamanho) || 1);
  return `CAST(? AS VARCHAR(${n}) CHARACTER SET WIN1252)`;
}

const AMOSTRA = 'AÇÃO É ÚNICO';
// Bytes WIN1252 esperados para a AMOSTRA.
const ESPERADO = Buffer.from([0x41, 0xC7, 0xC3, 0x4F, 0x20, 0xC9, 0x20, 0xDA, 0x4E, 0x49, 0x43, 0x4F]);

/**
 * Auto-teste no banco do cliente: o texto acentuado, passado pelo mesmo CAST
 * que a gravação usa, volta com os bytes WIN1252 certos? Não grava nada.
 *
 * @param {(sql: string, params: any[]) => Promise<any[]>} consultar
 * @returns {Promise<{ modo: 'win1252'|'ascii', detalhe: string }>}
 */
async function testarEscritaWin1252(consultar) {
  try {
    const linhas = await consultar(
      `SELECT CAST(CAST(CAST(? AS VARCHAR(20) CHARACTER SET WIN1252) AS VARCHAR(20) CHARACTER SET NONE) AS VARCHAR(20) CHARACTER SET OCTETS) AS B FROM RDB$DATABASE`,
      [AMOSTRA]
    );
    const linha = linhas[0] || {};
    const bytes = linha.b ?? linha.B;
    if (Buffer.isBuffer(bytes) && Buffer.compare(bytes.subarray(0, ESPERADO.length), ESPERADO) === 0) {
      return { modo: 'win1252', detalhe: 'acentos OK (WIN1252)' };
    }
    const visto = Buffer.isBuffer(bytes) ? bytes.toString('hex') : JSON.stringify(bytes);
    return { modo: 'ascii', detalhe: `bytes inesperados (${visto}); gravando sem acento` };
  } catch (err) {
    return { modo: 'ascii', detalhe: `teste de acento falhou (${err.message}); gravando sem acento` };
  }
}

// Inverso da tabela de encoding.js, para coluna BLOB de texto: o node-firebird
// manda um Buffer cru para o BLOB, então os bytes WIN1252 saem daqui.
const WIN1252_INVERSO = {};
[...'€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ'].forEach((ch, i) => {
  WIN1252_INVERSO[ch] = 0x80 + i;
});

/** Texto (já passado por textoParaErp) → Buffer WIN1252. */
function paraBufferWin1252(texto) {
  const bytes = [];
  for (const ch of String(texto)) {
    const cp = ch.codePointAt(0) || 0x3F;
    if (cp < 0x80 || (cp >= 0xA0 && cp <= 0xFF)) bytes.push(cp);
    else bytes.push(WIN1252_INVERSO[ch] ?? 0x3F);
  }
  return Buffer.from(bytes);
}

module.exports = { textoParaErp, marcadorDeTexto, testarEscritaWin1252, existeEmWin1252, paraBufferWin1252 };
