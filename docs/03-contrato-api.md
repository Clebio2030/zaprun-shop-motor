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
| `erpSistema` | Só no token do Shop. ERP escolhido no painel (`automec`, `linear`). O Motor compara com o `ERP_TIPO` dele e só **avisa** no log. |

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
      "raw": { "QUALQUER_COLUNA_DA_VIEW": "..." },

      // Só o Automec manda (v1.2.0): metragem por caixa fechada (piso).
      // null = não vende por caixa. Ausente = a view não tem a coluna.
      "multCaixa": 2.01,

      // Só o Linear manda os dois abaixo (v1.1.0). Ver docs/06-linear.md.
      "unidade": "KG",
      "promocao": {                  // null = não está em promoção
        "preco": 19.98,
        "inicio": "2026-09-18",
        "fim": "2026-09-30",
        "nome": "2° QUINZ ANIVERSARIO"
      }
    }
  ]
}
```

**`promocao` ausente ≠ `promocao: null`.** Ausente (Automec) = o ERP não informa
oferta: o servidor não toca na caixinha "Ativar oferta", que é do lojista.
Presente = o ERP controla a oferta: o servidor liga a caixinha, grava o preço
"de" (`regularPrice`) e cobra o promocional quando a promoção vale hoje e é
**menor** que o preço normal; senão desliga. O preço normal continua em
`precos`.

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

Não é da API do ZapRun: roda em `127.0.0.1:3010`, na máquina do cliente.

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

---

## Pedidos da Loja → orçamento no ERP (v1.3.0, ADR-307 do ZapRun)

Segundo laço do Motor, independente do catálogo (`backend/src/motor/pedidos/`).
Só o **Automec** grava; o Linear responde "não suportado". Desligado por
padrão — liga em **Loja > Integração ERP > 6. Pedidos no ERP**.

### `POST /erp/pedidos/consultar` (a cada 30 s ligado, 5 min desligado)

```jsonc
// requisição
{ "motorVersao": "1.3.0", "erp": "automec",
  "estado": { "suportado": true, "modo": "gravar", "validacao": {...}, "pendentesDeConfirmacao": 0, "ultimoErro": null },
  "relatorio": null }   // relatório do ERP: 1x por boot e a cada mudança de config

// resposta — desligado
{ "ativo": false, "intervaloSeg": 300 }

// resposta — ligado
{ "ativo": true, "modo": "ensaio|gravar", "intervaloSeg": 30,
  "config": { "idEmpresaErp": 1, "cdClienteErp": 1, "cdVendedorPadrao": "1", "cdProdutoFrete": "90", "extras": null },
  "pedidos": [ {
    "pedidoId": 501, "numero": 12, "versao": "<updatedAt>", "hash": "<sha256>",
    "criadoEm": "...", "cancelado": false, "nrOrcamento": null, "idEmpresaErp": 1, "vendedor": "7",
    "cliente": { "nome": "*MARIA JOSÉ", "telefone": "83999990000", "cpf": null },
    "modalidade": "entrega",
    "entrega": { "logradouro": "RUA X, 100", "complemento": null, "bairro": "CENTRO", "cidade": "JOÃO PESSOA", "uf": "PB", "cep": "58000000" },
    "itens": [ { "cdproduto": "1201", "descricao": "CERVEJA LATA", "quantidade": 3, "valorUnitario": 9.95, "total": 29.85, "idpreco": 2 } ],
    "frete": { "cdproduto": "90", "descricao": "FRETE", "valor": 8 },
    "desconto": 5, "subtotal": 67.85, "total": 62.85,
    "observacao": "PEDIDO ZAPRUN #12 | ENTREGA | PAG: PIX"
  } ] }
```

O servidor manda o **estado desejado**; o Motor reconcilia com o ERP. Texto
(nome com asterisco, observação) é decidido no servidor — mudar é deploy, não
release.

### `POST /erp/pedidos/resultado`

```jsonc
{ "motorVersao": "1.3.0", "resultados": [ {
    "pedidoId": 501, "versao": "...", "hash": "...", "ensaio": false,
    "acao": "criado|atualizado|inalterado|cancelado|travado|removido|ignorado|erro",
    "nrOrcamento": 7301, "nrPrevisto": null, "idEmpresaErp": 1, "cdVendedor": "7", "situacaoErp": 0,
    "erro": null, "transitorio": false, "linhas": 3, "avisos": [], "duracaoMs": 120 } ] }
// resposta: { "ok": true, "recebidos": 1 }  — o Motor só esquece quando bate
```

### O que o Motor faz no Firebird (uma transação por pedido)

| Situação | Ação |
|---|---|
| Não existe + cancelado | `ignorado` |
| Não existe | `MAX(NRORCAMENTO)+1` da empresa, **INSERT puro** em ORCAMENTO e ORCPROD (frete = última linha); colisão de número → numera de novo (3x) |
| Existe, `STATUS ≠ 0` | `travado` — não mexe |
| Existe + cancelado | `STATUS = 2` |
| Existe | UPDATE do cabeçalho (sem número/data/hora/vendedor), DELETE + INSERT dos itens |
| Número conhecido e a linha sumiu | `removido` — **não recria** |
| Modo Ensaio | tudo igual, com ROLLBACK; devolve `nrPrevisto` |

A ligação pedido ↔ orçamento é a coluna **`ORCAMENTO.ZR_PEDIDO`**, criada pelo
Motor na primeira consulta em modo Gravar — sem esperar pedido (v1.3.1), para a
loja conferir a tela de orçamento do Automec antes do primeiro pedido real (`ALTER TABLE ORCAMENTO ADD ZR_PEDIDO
INTEGER`), depois de conferir que nenhuma procedure/trigger insere em ORCAMENTO
sem listar colunas. Guarda o **número do pedido na Loja** (v1.3.12; antes
guardava o `orderId` interno — orçamentos antigos seguem aceitos) na mesma
transação: se o resultado não chegar ao servidor, a próxima consulta acha o
orçamento pela coluna e não duplica.

O número da Loja **se repete**: é `MAX(number)+1` dos pedidos que existem, e
excluir o último pedido devolve o número ao próximo. Por isso, sem o número do
orçamento, o Motor procura `ZR_PEDIDO IN (número, pedidoId)` e só aceita o
orçamento cujo DTORC/HORAORC é o da criação DESTE pedido (o que o Motor grava;
folga de 2 min). Os outros com o mesmo número são de pedidos excluídos e ficam
como estão (v1.3.13; na 1.3.12 o pedido novo ficava "travado" no orçamento
cancelado do excluído, ou regravava o do outro por cima). HORAORC no zero de
1899 vai com a hora exata do pedido desde a 1.3.13 (antes, 28 s adiantado).

`QTDELIB` e `QTDEPECA` dos itens copiam o Automec da casa (v1.3.1): o
Motor olha os últimos 200 itens da empresa e, se 80% ou mais têm o valor igual à
quantidade, zero, nulo ou 1, grava igual; sem maioria, grava a quantidade (como
a Pontual). Na JPR, QTDELIB = quantidade em 0 de 200 — copiar a Pontual punha nos
itens um valor que o próprio Automec nunca põe. O relatório mostra a regra
adotada em `calibracao.itens`. `extras` ainda sobrescreve.

**`CALC` = valor unitário do item (v1.3.9, decisão do dono).** Antes copiava a
casa e, na JPR, sem maioria, caía na quantidade. O relatório conta em
`calibracao.orcprod.calc_vlunit` quantos dos últimos 200 itens têm CALC = VLUNIT.

**O que a casa sempre preenche, o Motor também preenche (v1.3.3).** Na JPR o
orçamento gravado existia no banco e não aparecia na tela do Automec: a tela
filtra ou liga por campos que o próprio Automec sempre põe. O Motor olha os
últimos 200 orçamentos e itens da empresa feitos pelo Automec (sem ZR_PEDIDO) e,
para cada coluna que ele não preenche:

- código ou indicador (número, ou texto de até 20 caracteres) com o mesmo valor
  em 90% ou mais → grava igual;
- data preenchida em 90% ou mais com o mesmo prazo a partir de DTORC em 70% ou
  mais (validade de 7 dias, por exemplo) → grava DTORC + prazo;
- texto livre, BLOB e o resto → não copia, e aparece na comparação.

Na regravação (Reenviar no painel, ou o pedido mudou), esses campos entram só
onde estão NULOS — é assim que um orçamento gravado antes se conserta.
`extras` do servidor e o mapeamento do Motor vencem o que veio da casa.

Diagnóstico: `GET http://127.0.0.1:3010/pedidos/comparar?nr=84478` mostra as
colunas que a casa preenche em 80% ou mais e que esse orçamento tem vazias; o
relatório traz o mesmo para o último orçamento do Motor (`casa.ultimoDoMotor`),
com o valor mais comum só para código/indicador — nome e telefone não saem da
máquina.

**Comparação direta (v1.3.4).** `GET /pedidos/comparar?nr=84478` também traz
`contraUmDaCasa`: o orçamento do Motor contra o último que o próprio Automec
gravou antes de hoje (ou `&com=<número>`), coluna por coluna no cabeçalho e no
primeiro item — o que só a casa tem, o que só o Motor tem, e os códigos que
diferem — e as outras tabelas com NRORCAMENTO em que a casa tem linha e o Motor
não (parcelas, por exemplo). O relatório leva o mesmo em
`casa.comparacaoDireta`, com nome, telefone, endereço e texto livre reduzidos a
`texto(n)`.

**Regras do dono depois da JPR (v1.3.6).**
- Retirada vai SEM endereço (o balcão pode não ter um — como o orçamento do
  PDV Web da Pontual); entrega leva o endereço do pedido.
- STATUS do item: **EN** na entrega, **RM** na retirada. Nunca 'FF'.
- Número: MAX(NRORCAMENTO)+1 do ORCAMENTO da empresa, como o Automec
  (v1.3.11). As versões 1.3.5 a 1.3.10 pulavam números citados em
  `SAIDAESTOQUE.NRORCAMENTO` e, na JB Morais, saiu 79123 em vez de 463.

**Dois orçamentos ao mesmo tempo.** O número é lido (MAX+1 da empresa) e
gravado dentro da mesma transação, com INSERT puro: se outro caixa — ou outro
pedido — pegar o mesmo número no mesmo instante, a chave primária de ORCAMENTO
(NRORCAMENTO, IDEMPRESA) recusa o segundo. Do lado do Motor isso é "chave
repetida": espera um pouco e numera de novo (até 6 vezes); nada é sobrescrito e
nada fica pela metade. 5 pedidos simultâneos no banco de teste saem com 5
números diferentes. O que o Motor não controla: se a tela do Automec RESERVA o
número ao abrir (e não ao gravar), o caixa que abriu antes do Motor gravar
recebe erro de chave ao salvar — como já acontece entre dois caixas.

**Histórico do Automec (v1.3.9).** A aba "Histórico" do orçamento lê
`SIS_APPHISTORY`, que o PROGRAMA Automec grava ao salvar (procedure
`SP_ADDHISTORY(IDMENUITEM, TIPO, CONTEXTO, MENSAGEM, IDUSUARIO)`; não é gatilho).
O Motor grava igual, na mesma transação do orçamento:

| Campo | Valor |
|---|---|
| IDMENUITEM | a tela de orçamento, lida de uma linha da casa com CONTEXTO `NRORCAMENTO=` (15 na JPR) |
| TIPO | 1 na inclusão; 2 na alteração e no cancelamento |
| CONTEXTO | `NRORCAMENTO=199177;IDEMPRESA=1;` |
| MENSAGEM | inclusão: as colunas preenchidas; alteração: só as que mudaram (`VLTOTAL;SUBTOTAL;`), `ITENS;` se só os itens mudaram, `STATUS;` no cancelamento — cortada em 80 |
| IDUSUARIO | 1 (decisão do dono, 23/11) |

- Usa `EXECUTE PROCEDURE` (a da JPR tem SUSPEND sem RETURNS, e o SELECT é
  recusado). Sem a procedure, INSERT direto nas 5 colunas.
- Sem linha de orçamento da casa no histórico, não grava: não inventa a tela.
- "Reenviar" sem mudança não gera linha. Ensaio não deixa linha.
- Falha no histórico vira aviso; o orçamento grava assim mesmo.
- Ajuste sem release, em `extras.HISTORICO` no servidor: `{ "IDUSUARIO": 7 }`,
  `{ "IDMENUITEM": 15 }` ou `{ "desligado": true }`.
- Relatório: `historicoAutomec` (modo, tela, usuário, motivo quando não grava).

Para desfazer (só se a coluna atrapalhar o Automec): desligar no painel e
`ALTER TABLE ORCAMENTO DROP ZR_PEDIDO`.

### Rotas locais

```
GET  /pedidos             estado do laço + os 50 últimos resultados
POST /pedidos/consultar   consulta agora, sem esperar 30 s
GET  /status              ganhou o bloco "pedidos"
```

Teste contra Firebird de teste: `tools/fb-teste/` (schema mínimo + 11 cenários; `testar-casa.js`, `testar-jpr.js`, `testar-historico.js`).
