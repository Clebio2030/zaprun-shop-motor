#!/usr/bin/env node
//
// Simulador do Motor — fala com a API do ZapRun sem ERP, sem Firebird e sem
// máquina Windows.
//
// Para que serve, na prática:
//   • conferir que um token novo funciona, antes de mandar o implantador viajar
//   • provar que a idempotência está de pé depois de mexer no servidor
//   • reproduzir um problema de um cliente sem acessar a máquina dele
//
// É também a PROVA DE ACEITE do endpoint POST /erp/produtos/sync: enquanto ele
// não existir, este script falha no passo 2 com 404 — e é assim que se sabe que
// o lado servidor ainda não está pronto.
//
// Uso:
//   ZAPRUN_TOKEN=zrerp_xxx node tools/simular-motor.js
//   ZAPRUN_TOKEN=zrerp_xxx ZAPRUN_API_URL=https://dev.zaprun.com.br node tools/simular-motor.js
//
// Os produtos criados usam CDPRODUTO na faixa 990000+ para você identificar e
// apagar depois. Ele NÃO apaga nada sozinho: apagar dado de um servidor de
// verdade a partir de um script de teste é como se perde dado de cliente por
// engano.

const crypto = require('crypto');

const TOKEN = process.env.ZAPRUN_TOKEN || '';
const API = (process.env.ZAPRUN_API_URL || 'https://dev.zaprun.com.br').replace(/\/+$/, '');
const ERP_COMPANY_ID = Number(process.env.SIM_ERP_COMPANY_ID || 1);

if (!TOKEN) {
  console.error('\nFalta o token.\n');
  console.error('  ZAPRUN_TOKEN=zrerp_xxx node tools/simular-motor.js\n');
  console.error('Gere um no painel do ZapRun em Integracoes > ERP.\n');
  process.exit(1);
}

let falhas = 0;

function checar(nome, ok, detalhe = '') {
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} ${nome}${detalhe ? ` ${detalhe}` : ''}`);
  if (!ok) falhas++;
}

async function chamar(caminho, { metodo = 'GET', corpo } = {}) {
  const res = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      'X-Integration-Token': TOKEN
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });

  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    body = null;
  }
  return { status: res.status, body };
}

// Um produto com a mesma forma que o mapping.js produz a partir da view —
// inclusive um produto "pelado" (arrays vazios), que é o que o LEFT JOIN
// devolve para item recém-cadastrado e é onde a ingestão costuma quebrar.
const produto = (cd, extra = {}) => ({
  cdproduto: cd,
  descricao: `PRODUTO SIMULADO ${cd}`,
  grupo: 'SIMULAÇÃO',
  codigos_barra: [`790${String(cd).padStart(10, '0')}`],
  precos: [
    { idpreco: 1, tabela: 'CARTAO', preco: 44.99 },
    { idpreco: 2, tabela: 'DINHEIRO', preco: 39.9 }
  ],
  estoque: [
    { cddeposito: 1004, deposito: 'CASA X', saldo: 319.19 },
    { cddeposito: 1005, deposito: 'DEPOSITO 2', saldo: 0 }
  ],
  erpCompanyId: ERP_COMPANY_ID,
  raw: { ORIGEM: 'simular-motor.js' },
  ...extra
});

/** Envelope igual ao que o motor/index.js monta. */
const envelope = (produtos, extra = {}) => ({
  sourceVersion: '1.0.0-sim',
  dataReferencia: new Date().toISOString().slice(0, 10),
  syncMode: 'full',
  snapshotId: crypto.randomUUID(),
  erpCompanyId: ERP_COMPANY_ID,
  expectedTotal: produtos.length,
  chunkInfo: { atual: 1, total: 1 },
  produtos,
  ...extra
});

async function main() {
  console.log(`\nSimulador do Motor ZapRun Shop`);
  console.log(`API: ${API}`);
  console.log(`token: ${TOKEN.slice(0, 12)}...`);
  console.log(`empresa do ERP: ${ERP_COMPANY_ID}\n`);

  const base = 990000 + (Date.now() % 1000);
  const ids = [base, base + 1, base + 2];

  console.log('1. Handshake');
  const hs = await chamar('/erp/handshake');
  checar('respondeu 200', hs.status === 200, `(${hs.status})`);
  checar('traz a empresa', Boolean(hs.body?.empresa), hs.body?.empresa?.nome || '');
  checar('integração ativa', hs.body?.ativo !== false);
  if (hs.status === 401) {
    console.log('\n  Token inválido ou revogado. Gere outro no painel.\n');
    process.exit(1);
  }

  console.log('\n2. Primeira entrega (3 produtos novos)');
  const envio1 = await chamar('/erp/produtos/sync', {
    metodo: 'POST',
    corpo: envelope(ids.map(id => produto(id)))
  });
  checar('respondeu 200', envio1.status === 200, `(${envio1.status})`);
  if (envio1.status === 404) {
    console.log('\n  POST /erp/produtos/sync ainda não existe no servidor.');
    console.log('  Ver docs/03-contrato-api.md — é a especificação dele.\n');
    process.exit(1);
  }
  checar('recebeu os 3', envio1.body?.persisted?.received === 3);
  checar('gravou como novos', envio1.body?.persisted?.inserted === 3);

  console.log('\n3. Reenvio idêntico (idempotência)');
  const envio2 = await chamar('/erp/produtos/sync', {
    metodo: 'POST',
    corpo: envelope(ids.map(id => produto(id)))
  });
  checar('respondeu 200', envio2.status === 200, `(${envio2.status})`);
  checar('não duplicou', envio2.body?.persisted?.inserted === 0);
  checar('reconheceu como iguais', envio2.body?.persisted?.unchanged === 3);

  console.log('\n4. Alteração de preço e de saldo');
  const envio3 = await chamar('/erp/produtos/sync', {
    metodo: 'POST',
    corpo: envelope([
      produto(ids[0], {
        precos: [{ idpreco: 1, tabela: 'CARTAO', preco: 99.9 }],
        estoque: [{ cddeposito: 1004, deposito: 'CASA X', saldo: 0 }]
      }),
      produto(ids[1]),
      produto(ids[2])
    ])
  });
  checar('respondeu 200', envio3.status === 200, `(${envio3.status})`);
  checar('atualizou só o que mudou', envio3.body?.persisted?.updated === 1);
  checar('os outros dois seguem iguais', envio3.body?.persisted?.unchanged === 2);

  console.log('\n5. Produto sem preço e sem estoque (o LEFT JOIN vazio)');
  const envio4 = await chamar('/erp/produtos/sync', {
    metodo: 'POST',
    corpo: envelope([
      produto(base + 3, { codigos_barra: [], precos: [], estoque: [] })
    ])
  });
  checar('respondeu 200', envio4.status === 200, `(${envio4.status})`);
  checar('aceitou arrays vazios', envio4.body?.persisted?.received === 1);

  console.log('\n6. Linha ruim é rejeitada e NOMEADA');
  const envio5 = await chamar('/erp/produtos/sync', {
    metodo: 'POST',
    corpo: envelope([produto(base + 4), { descricao: 'sem cdproduto' }])
  });
  checar('respondeu 200', envio5.status === 200, `(${envio5.status})`);
  checar('o produto bom entrou', envio5.body?.persisted?.inserted === 1);
  checar(
    'a linha ruim foi nomeada',
    Array.isArray(envio5.body?.persisted?.rejected) && envio5.body.persisted.rejected.length === 1
  );

  console.log(`\n${falhas === 0 ? 'Tudo certo.' : `${falhas} verificação(ões) falharam.`}`);
  console.log(`\nOs produtos de teste usam CDPRODUTO de ${base} a ${base + 4}.`);
  console.log('Nada foi apagado — remova pelo painel quando terminar.\n');

  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\nErro inesperado:', err.message, '\n');
  process.exit(1);
});
