# ZapRun Shop — Motor de Catálogo

Serviço Node.js que roda **na máquina do cliente**, lê o catálogo de produtos do
ERP dele (Firebird local) e entrega no catálogo do ZapRun Shop.

```
  Máquina do cliente (Windows)                          Servidor ZapRun
 ┌──────────────────────────────┐                     ┌──────────────────────┐
 │  ERP (Firebird)              │                     │                      │
 │    └── view ZAPRUN_SHOP      │                     │  POST /erp/          │
 │             ▲                │   HTTPS + token     │    produtos/sync     │
 │             │                │  ─────────────────► │                      │
 │  Motor (serviço Windows)     │                     │  StoreProduct        │
 │    porta 3002, só localhost  │  ◄───────────────── │  StoreCategory       │
 │                              │   GET /erp/handshake│                      │
 └──────────────────────────────┘                     └──────────────────────┘
```

Irmão do **Motor de Orçamentos** (`../motor-orcamento-erp`), do qual herda a
arquitetura inteira. As duas máquinas-alvo são a mesma, então **porta 3002** e
**serviço `ZapRunShop`** — ver "Conviver com o outro Motor", abaixo.

## Em uma frase

De hora em hora (08h–22h), o Motor pergunta ao servidor como deve trabalhar, lê
a view de produtos do ERP, reduz as linhas planas a produtos aninhados, e envia
em lotes o catálogo que mudou — conferindo, no fim, que o servidor gravou tudo
o que ele mandou.

## O problema central: a view é plana

A view devolve VÁRIAS linhas por produto. Um produto com 2 códigos de barra, 3
tabelas de preço e 4 depósitos ocupa **2 × 3 × 4 = 24 linhas**, com o cabeçalho
repetido em todas — é o produto cartesiano dos LEFT JOINs.

```
CDPRODUTO  CODBARRA        IDPRECO  TABELA    CDDEPOSITO  SALDO
8390       7908572802578   1        CARTAO    1004        319.19
8390       7908572802578   1        CARTAO    1005          0.00
8390       7908572802578   2        DINHEIRO  1004        319.19   ← repete
8390       7891234567890   1        CARTAO    1004        319.19   ← repete
...
```

`motor/mapping.js` reduz isso a um objeto por produto, **deduplicando cada
dimensão pela sua chave**. Empilhar linha por linha daria 24 códigos de barra
num produto que tem 2:

```json
{
  "cdproduto": 8390,
  "descricao": "NOME DO PRODUTO",
  "grupo": "NOME DO GRUPO",
  "codigos_barra": ["7908572802578"],
  "precos":  [{ "idpreco": 1, "tabela": "CARTAO", "preco": 44.99 }],
  "estoque": [{ "cddeposito": 1004, "deposito": "CASA X", "saldo": 319.19 }]
}
```

Os três arrays **nunca contêm null**: a view usa LEFT JOIN, e produto sem
código de barras, sem preço ou sem estoque devolve array vazio — que é a
resposta honesta, e diferente de `null` ("não sei").

## Estrutura

```
backend/src/
  server.js              HTTP local: /health, /status, /produtos, /sync
  logger.js              log diário em backend/logs/
  types/zaprun-shop.d.ts ⟵ as interfaces do contrato (ver "Tipos", abaixo)
  motor/
    index.js             orquestrador: handshake → extrai → envia → confere
    firebird.js          pool de conexões com timeout
    extractor.js         consulta a view e agrupa
    mapping.js           ⟵ view → catálogo. O ÚNICO arquivo que muda por ERP
    encoding.js          decodificação WIN1252 (acentuação)
    sender.js            handshake, POST, retry, fatiamento por bytes
    syncState.js         hash do catálogo por empresa
    migrations.js        aplica sql/views_zaprun_shop.sql no boot
sql/views_zaprun_shop.sql  ⟵ a view do ERP, aplicada no boot pelo migrations.js
updater/                 atualização automática via release do GitHub
nssm/                    empacota o Node como serviço do Windows
INSTALAR.bat             instalador (rodar como Administrador)
```

## A rota de diagnóstico

```
GET http://127.0.0.1:3002/produtos                  catálogo inteiro
GET http://127.0.0.1:3002/produtos?cdproduto=8390   um produto
```

Responde, sem RDP e sem abrir o ERP, à pergunta que sempre aparece: *"o produto
X está com o preço errado na loja — o ERP está mandando o quê?"*.

O `_meta` da resposta é o que interessa no diagnóstico:

| Campo | O que dizer quando está estranho |
|---|---|
| `linhas` muito > `produtos` | os JOINs da view estão multiplicando (esperado, mas mede o custo) |
| `descartadas` > 0 | há linha sem CDPRODUTO — a view está devolvendo lixo |
| `foraDoEscopo` > 0 | o token não autoriza todas as empresas da view |

Erro do Firebird volta **inteiro** (`Table unknown ZAPRUN_SHOP`), não escondido
atrás de "erro interno": é a diferença entre 5 segundos e uma sessão remota.

## Tipos

O runtime é JavaScript, mas o contrato é tipado: as interfaces vivem em
`backend/src/types/zaprun-shop.d.ts` e são aplicadas por JSDoc nos `.js`.

```bash
cd backend && npm run typecheck   # tsc --noEmit --checkJs
```

Não há passo de build: na máquina do cliente o nssm executa `node
src/server.js` direto, e o updater sincroniza código-fonte. Compilar no Windows
do cliente (sem toolchain) ou versionar um `dist/` sairia de sincronia com o
fonte na primeira release apressada.

## Conviver com o outro Motor

As duas instalações vivem na mesma máquina. O que **precisa** ser diferente:

| | Orçamentos | Shop |
|---|---|---|
| Porta | 3001 | **3002** |
| Serviço Windows | `ZapRunOrcamentos` | **`ZapRunShop`** |
| Repo de release | `zaprun-motor-orcamentos` | **`zaprun-shop-motor`** |
| `backupDir`/`tempDir` | `c:/ZapRun/Orcamentos/…` | **`c:/ZapRun/Shop/…`** |
| View | `ZAPRUN_ORCAMENTOS` | **`ZAPRUN_SHOP`** |
| Endpoint | `/erp/orcamentos/sync` | **`/erp/produtos/sync`** |

Errar a porta faz o segundo serviço morrer com `EADDRINUSE` — e o updater do
primeiro passa a fazer health check no processo errado, o que é pior que
falhar, porque ninguém percebe.

## Comandos

```bash
# testes (rodam em qualquer SO, sem Firebird e sem rede)
cd backend && npm test

# conferir os tipos
cd backend && npm run typecheck

# na máquina do cliente: ver o estado
#   http://127.0.0.1:3002/status
# ver o catálogo como o Motor o enxerga
#   http://127.0.0.1:3002/produtos?cdproduto=8390
# forçar um ciclo agora
#   POST http://127.0.0.1:3002/sync
```

## Estado atual

O Motor está **completo e testado** (41 testes, typecheck limpo).

A view `ZAPRUN_SHOP` está em `sql/views_zaprun_shop.sql` e é aplicada no boot do
serviço. Ela é a view escrita no cliente, com **uma** mudança: todo texto agora
sai com `CHARACTER SET OCTETS`. Sem isso a acentuação se perde de forma
irreversível na leitura — "CAFÉ EM PÓ" chega "CAF? EM P?". Os tamanhos dos CASTs
são generosos e ainda **não foram conferidos** contra o schema real; o cabeçalho
do arquivo diz como fixá-los.

O endpoint `POST /erp/produtos/sync` **existe no código do servidor** (repo
`zaprun`, `backend/src/modules/erp/`), com migration e serviço de ingestão, mas
ainda **não está no ar**: falta rodar a migration e reiniciar o backend. Até lá o
POST volta 404 e o Motor loga a falha sem perder nada — o hash não é gravado e o
ciclo seguinte reenvia.

O que o servidor ainda ACHATA (o Motor já entrega tudo):

| | Motor entrega | Servidor guarda |
|---|---|---|
| Preços | todas as tabelas | um (`ErpSettings.shopIdPreco`) |
| Estoque | saldo por depósito | um número (a soma) |
| Código de barras | todos | o primeiro |

Guardar os três em tabelas filhas está desenhado mas não implementado.
