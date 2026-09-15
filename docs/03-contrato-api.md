# Contrato da API

Base: `https://dev.zaprun.com.br`
Autenticação: header `X-Integration-Token: zrerp_...` em **todas** as rotas.

O token é gerado no painel do ZapRun (**Integrações → ERP**) e aparece **uma
única vez** — só o hash fica no banco. Perdeu, gera outro. É o mesmo tipo de
token do Motor de Orçamentos: um token por cliente serve aos dois Motores.

> **Estado em 15/09/2026:** `GET /erp/handshake` **existe** e responde.
> `POST /erp/produtos/sync` **ainda não existe** — verificado, devolve 404.
> Este documento é a especificação de quem for construí-lo.

---

## `GET /erp/handshake`

O Motor confirma quem é e recebe como deve trabalhar. Já implementado, servindo
os dois Motores.

```json
{
  "ativo": true,
  "empresa": { "id": 4, "nome": "Freitas" },
  "erpCompanyIds": [1],
  "cronExpr": "0 8-22 * * *",
  "chunkSize": 500,
  "serverTime": "2026-09-15T03:00:00.000Z"
}
```

| Campo | Significado |
|---|---|
| `ativo` | `false` = integração pausada no painel. O Motor pula o ciclo e volta depois. |
| `erpCompanyIds` | `IDEMPRESA` que este token pode enviar. `null` = todas. |
| `cronExpr` | Ritmo do ciclo. Mudar aqui muda a frota inteira. |
| `chunkSize` | Produtos por POST. |

O Motor do Shop lê primeiro `cronExprShop` / `chunkSizeShop` e só depois cai nos
campos genéricos. Assim o servidor pode dar ritmos diferentes aos dois Motores
do mesmo cliente — catálogo e orçamento não têm a mesma urgência — **sem** que a
ausência desses campos quebre nada hoje.

Os campos `janelaDias` / `janelaInicialDias` do handshake são **ignorados** aqui:
catálogo não tem janela de datas (ver `01-arquitetura.md`).

**Pausado responde 200, não erro.** O Motor precisa distinguir *"não te
conheço"* (401 → parar de insistir) de *"conheço, mas hoje não"* (voltar no
próximo ciclo).

---

## `POST /erp/produtos/sync`

### Requisição

```jsonc
{
  "sourceVersion": "1.0.0",
  "dataReferencia": "2026-09-15",
  "syncMode": "incremental",         // ou "full" (primeira carga da empresa)
  "snapshotId": "uuid-da-entrega",   // o mesmo em todos os lotes
  "erpCompanyId": 1,                 // null quando a view é de empresa única
  "expectedTotal": 1200,             // congelado antes do 1º lote
  "chunkInfo": { "atual": 1, "total": 3 },
  "produtos": [
    {
      "cdproduto": 8390,                       // OBRIGATÓRIO
      "descricao": "CAFÉ EM PÓ 500G",
      "grupo": "ALIMENTAÇÃO",
      "codigos_barra": ["7908572802578"],
      "precos": [
        { "idpreco": 1, "tabela": "CARTAO",   "preco": 44.99 },
        { "idpreco": 2, "tabela": "DINHEIRO", "preco": 39.90 }
      ],
      "estoque": [
        { "cddeposito": 1004, "deposito": "CASA X",     "saldo": 319.19 },
        { "cddeposito": 1005, "deposito": "DEPOSITO 2", "saldo": 0 }
      ],
      "erpCompanyId": 1,
      "raw": { "QUALQUER_COLUNA_DA_VIEW": "..." }
    }
  ]
}
```

Só `cdproduto` é obrigatório. Tudo mais é opcional, e **`raw` guarda a primeira
linha crua do produto** — coluna que o ERP traz e ainda não tem campo tipado no
ZapRun não se perde.

**Os três arrays podem vir vazios, nunca com `null` dentro.** `[]` significa "o
ERP não tem isso cadastrado para este produto" — e é diferente de ausente.
Produto novo, sem preço e sem estoque, chega com os três vazios.

### O que o servidor precisa decidir

O Motor entrega **todas** as tabelas de preço e **todos** os depósitos, de
propósito: quem escolhe é o servidor, onde a regra é barata de corrigir e não
exige release do Motor. `StoreProduct` tem campos únicos, então a ingestão
precisa resolver três reduções:

| Campo do `StoreProduct` | Vem de | Decisão pendente |
|---|---|---|
| `price` | `precos[]` | qual `IDPRECO`/`TABELA_PRECO` é o preço de venda da loja? Configurável por empresa. |
| `stock` | `estoque[]` | somar todos os depósitos ou usar um só? Depósito de loja ≠ depósito de matriz. |
| `barcode` | `codigos_barra[]` | o primeiro; os demais não têm onde caber hoje. |
| `categoryId` | `grupo` | upsert em `StoreCategory` pelo nome. |
| `name` | `descricao` | direto. |

Sugestão: guardar essas escolhas em `ErpSetting`, junto com o resto da config do
ERP por empresa, e **não** no Motor — mudar de tabela de preço não pode exigir
release para 100 máquinas.

### Resposta

```json
{
  "ok": true,
  "snapshotId": "uuid-da-entrega",
  "expectedTotal": 1200,
  "persisted": {
    "received": 500,
    "inserted": 120,
    "updated": 30,
    "unchanged": 350,
    "rejected": [9981],
    "motivos": ["cdproduto ausente"]
  }
}
```

| Campo | Significado |
|---|---|
| `received` | Quantos foram **realmente persistidos**. Não é o tamanho do array que chegou. |
| `inserted` / `updated` / `unchanged` | Novos / alterados / idênticos (detectados por hash, sem escrever). |
| `rejected` | `cdproduto` de cada produto recusado — **nomeados**. |
| `motivos` | Até 20 explicações, para o log do Motor. |

**`received` é o contrato de integridade.** O Motor não confia no 200: ele soma
os `received` de todos os lotes e só grava o hash se o total bater com o que
enviou. Se não bater, o próximo ciclo reenvia tudo.

### Idempotência

A chave é `(companyId, erpCompanyId, cdproduto)`.

Reenviar o mesmo produto **atualiza a linha, nunca duplica** — depois de um
timeout, de um rollback do updater, de uma reinstalação, de apagar o
`sync_state.json`. Se o conteúdo for idêntico, nem UPDATE acontece: conta como
`unchanged`.

`StoreProduct` hoje **não tem coluna para o `cdproduto` do ERP**. A ingestão vai
precisar de uma (`erpProductId`, indexada junto com `companyId`), senão não há
como reencontrar o produto no segundo ciclo — e cada sync duplicaria o catálogo
inteiro. É a primeira migration desse trabalho.

### Produto que sai do ERP

O sync é um fluxo de **upsert sem exclusão**: produto que some da view continua
no catálogo, à venda. O ERP não avisa "apaguei" — ele simplesmente para de
mandar.

Como `syncMode: "full"` carrega o catálogo inteiro da empresa, dá para tratar
ausência como desativação (`active: false`) **quando e somente quando** o
`snapshotId` fechou com `received == expectedTotal`. Desativar a partir de uma
entrega truncada esvaziaria a loja do cliente por causa de um timeout de rede.

### Códigos

| Código | Quando | O Motor faz |
|---|---|---|
| `200` | Lote processado (mesmo com alguns produtos rejeitados) | segue para o próximo lote |
| `401` | Token inválido ou revogado | para de insistir; precisa de token novo |
| `409` | Integração pausada no painel | volta no próximo ciclo |
| `413` | Payload acima de 5 MB | **não deveria acontecer** — o `sender.js` corta por bytes antes |
| `422` | `produtos` ausente ou não é lista | erro de programação, não retenta |
| `429` | Excesso de requisições | espera e retenta |
| `500` | Falha ao gravar (banco fora, lote grande demais) | **retenta** — é transitório |

> Erro de lote inteiro volta como **500 de propósito**, para o Motor retentar.
> Devolver 4xx faria ele desistir, e o dado se perderia até alguém notar.

### Limites

| Limite | Valor | Onde |
|---|---|---|
| Tamanho do corpo | **5 MB** | `bodyParser.json` global do ZapRun (`app.ts`) |
| POSTs por 15 min | 600 por token | rate limit |
| Handshake por 15 min | 120 por token | rate limit |

O limite de 5 MB é **global e roda antes das rotas** — não dá para afrouxar só
para o ERP. Por isso o `chunkSize` padrão é 500 e o `sender.js` corta também
por bytes (teto de 3 MB).

---

## Rota local do Motor

Não é da API do ZapRun: roda em `127.0.0.1:3002`, na máquina do cliente.

```
GET /produtos                  o catálogo inteiro, já agrupado
GET /produtos?cdproduto=8390   um produto
```

```json
{
  "_meta": { "view": "ZAPRUN_SHOP", "linhas": 24, "produtos": 1,
             "descartadas": 0, "foraDoEscopo": 0 },
  "produtos": [ { "cdproduto": 8390, "...": "..." } ]
}
```

| Código | Quando |
|---|---|
| `200` | ok |
| `400` | `cdproduto` não é inteiro — **sem tocar no banco** |
| `404` | pediu um `cdproduto` que não existe na view |
| `500` | erro do Firebird, com a mensagem original (`Table unknown ZAPRUN_SHOP`) |
