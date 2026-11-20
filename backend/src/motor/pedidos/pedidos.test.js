const test = require('node:test');
const assert = require('node:assert');

process.env.ERP_TIPO = 'automec';
const api = require('./api');
const automec = require('../erp/automec');
const pedidos = require('./index');

const pedido = n => ({ pedidoId: n, numero: n, total: 10, versao: 'v', hash: 'h' });

test('leva os pedidos ao ERP e só esquece o resultado quando o servidor confirma a contagem', async () => {
  const enviados = [];
  let recebidos = 1; // primeira confirmação vem incompleta
  api.consultar = async () => ({
    ok: true,
    dados: { ativo: true, modo: 'gravar', intervaloSeg: 30, config: { idEmpresaErp: 1 }, pedidos: [pedido(1), pedido(2)] }
  });
  api.enviarResultados = async corpo => {
    enviados.push(corpo.resultados.map(r => r.pedidoId));
    return { ok: true, dados: { recebidos } };
  };
  automec.sincronizarPedido = async p => ({ pedidoId: p.pedidoId, acao: 'criado', nrOrcamento: 7000 + p.pedidoId, duracaoMs: 1 });
  automec.relatorioPedidos = async () => ({ validacao: { ok: true, erros: [] } });

  await pedidos.rodarUmaVez();
  assert.deepStrictEqual(enviados, [[1, 2]]);
  assert.strictEqual(pedidos.estadoDosPedidos().pendentesDeConfirmacao, 2, 'contagem diferente não pode esquecer');

  // Próxima volta: reenvia os pendentes ANTES de consultar, agora confirmados.
  recebidos = 2;
  api.consultar = async () => ({ ok: true, dados: { ativo: true, modo: 'gravar', intervaloSeg: 30, config: { idEmpresaErp: 1 }, pedidos: [] } });
  await pedidos.rodarUmaVez();
  assert.deepStrictEqual(enviados[1], [1, 2]);
  assert.strictEqual(pedidos.estadoDosPedidos().pendentesDeConfirmacao, 0);
  assert.strictEqual(pedidos.ultimosResultados()[0].nrOrcamento, 7002);
});

test('desligado no servidor não toca no ERP', async () => {
  let chamou = false;
  api.consultar = async () => ({ ok: true, dados: { ativo: false, intervaloSeg: 300 } });
  automec.sincronizarPedido = async () => {
    chamou = true;
    return { acao: 'criado' };
  };
  await pedidos.rodarUmaVez();
  assert.strictEqual(chamou, false);
  assert.strictEqual(pedidos.estadoDosPedidos().ativo, false);
});

test('API sem a rota (404) não derruba o laço', async () => {
  api.consultar = async () => ({ ok: false, status: 404, erro: 'HTTP 404' });
  await pedidos.rodarUmaVez();
  assert.match(pedidos.estadoDosPedidos().ultimoErro, /404/);
});

test('descrição do log', () => {
  const linha = pedidos.descrever({ numero: 12, total: 62.85 }, { acao: 'criado', nrOrcamento: 7301, linhas: 3, duracaoMs: 40 });
  assert.strictEqual(linha, 'pedido #12: criado → orçamento 7301, 3 linha(s), R$ 62,85 (40 ms)');
});
