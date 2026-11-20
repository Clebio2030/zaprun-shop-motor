// motor/pedidos/api.js
// As duas chamadas do laço de pedidos (ADR-307 do ZapRun):
//   POST /erp/pedidos/consultar   estado do Motor → config + pedidos a levar ao ERP
//   POST /erp/pedidos/resultado   o que aconteceu com cada pedido
//
// Sem retry interno: o laço roda a cada 30 s, e é ele que espera e tenta de
// novo. Retry aqui dentro seguraria o laço por minutos.

/** @type {import('axios').AxiosStatic} */
const axios = /** @type {any} */ (require('axios'));
const { getHeaders, baseUrl, detalharErro } = require('../sender');

const TIMEOUT_MS = 30_000;

/**
 * @returns {Promise<{ ok: true, dados: any } | { ok: false, status: number|null, erro: string }>}
 */
async function postar(caminho, corpo) {
  try {
    const { data } = await axios.post(`${baseUrl()}${caminho}`, corpo, {
      headers: getHeaders(),
      timeout: TIMEOUT_MS
    });
    return { ok: true, dados: data };
  } catch (err) {
    return { ok: false, status: err.response ? err.response.status : null, erro: detalharErro(err) };
  }
}

const consultar = corpo => postar('/erp/pedidos/consultar', corpo);
const enviarResultados = corpo => postar('/erp/pedidos/resultado', corpo);

module.exports = { consultar, enviarResultados };
