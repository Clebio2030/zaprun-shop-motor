# ZapRun Shop — instruções para IA (Claude e demais)

Este repo é o **Motor ZapRun Shop**: serviço Node.js que roda na máquina de cada
cliente, lê o catálogo de produtos do ERP dele — **Automec** (Firebird local) ou
**Linear Sistemas** (MySQL na nuvem, pela VPN), por `ERP_TIPO` — e entrega na API
do ZapRun via `POST /erp/produtos/sync`, alimentando o catálogo do Shop
(`StoreProduct`).

Derivado do **Motor de Orçamentos** (`../motor-orcamento-erp`), que é o
original. Os princípios abaixo vieram de lá e foram pagos caro — não os reinvente.

## ⚠️ Leia primeiro

1. **[README.md](README.md)** — o produto cartesiano da view e por que ele é o
   problema central deste Motor.
2. **[sql/views_zaprun_shop.sql](sql/views_zaprun_shop.sql)** — a view do ERP, e
   o cabeçalho que explica a única mudança feita nela (os CASTs OCTETS) e os
   três riscos que sobraram.
3. **[backend/src/types/zaprun-shop.d.ts](backend/src/types/zaprun-shop.d.ts)** —
   o contrato em tipos.

O lado servidor vive em outro repo: `zaprun`, em `backend/src/modules/erp/` e
`backend/src/models/StoreProduct.ts`. Mudança de contrato mexe nos dois.

## Princípios não-negociáveis

**Pense em 100+ clientes, zero trabalho manual por máquina.**
Config de frota **nunca** no `.env` — ele é preservado no update e não propaga.
Use default no código ou toggle server-side (handshake). O `.env` guarda só
credencial, caminho e token.

**Sem perda de dado. "A qualidade é o dado."**
Falha tem de ser fail-safe: nunca deixar estado parcial nem descartar linha em
silêncio. Linha ruim é **contada e nomeada** no log. Idempotência em tudo.

**Nunca confie só no `200`.**
A entrega só está confirmada quando `persisted.received` bate com o
`expectedTotal`. Gravar o hash antes disso faz o Motor esquecer alteração de
preço que a API nunca recebeu — e nada a traz de volta.

**Retrocompatibilidade + canário.**
Motor e API atualizam em ritmos diferentes. Payload novo tem de ser inofensivo
para a versão antiga da API, e vice-versa. Valide num cliente antes da frota.

**Observável de fora.**
Ninguém tem RDP nessas máquinas. Log estruturado, `/status`, `/produtos`, e
mensagens que digam o que fazer — não "erro 400", mas "o token autoriza a
empresa 1, mas a view só tem [3]".

## Ao trabalhar aqui

- **ERP novo = um adaptador em `motor/erp/`** que devolve linhas com os nomes de
  coluna de `motor/mapping.js` (a consulta dele faz os aliases). O agrupamento é
  o mesmo para todos. Se um ERP novo encostar em `index.js`, `sender.js` ou
  `syncState.js`, o desenho vazou — repense. Ver `docs/06-linear.md`.
- **Campo que só um ERP informa** (`unidade`, `promocao`) só EXISTE no produto
  quando a consulta traz a coluna. Nunca `null` por padrão: para o servidor,
  `promocao: null` desmarca a oferta, e o hash do Automec mudaria.
- Rode os dois portões: `cd backend && npm test && npm run typecheck`.
  Ambos rodam sem Firebird e sem rede.
- `.env` e `sync_state.json` são preservados no update. Não dependa deles para
  propagar mudança.
- **Encoding (WIN1252/OCTETS) é trilha própria.** Não misture com outra mudança
  no mesmo commit — foi caro de acertar e é fácil de regredir.
- Os `.bat` precisam de CRLF (`.gitattributes` cuida). Com LF puro o `cmd.exe`
  quebra em labels e blocos, e o instalador fecha sozinho no meio.

## Armadilhas conhecidas

| Armadilha | Consequência |
|---|---|
| Empilhar as linhas da view sem deduplicar | produto com 2 códigos de barra sai com 24 — o produto cartesiano dos LEFT JOINs |
| Tratar `CODBARRA` como número | zero à esquerda some e GTIN-14 arredonda; o leitor do caixa nunca acha o produto |
| Descartar estoque por `!saldo` | saldo 0 é o que marca "esgotado"; descartá-lo esconde o produto em vez de marcá-lo |
| Hashear os arrays 1:N sem ordenar | a view só ordena por CDPRODUTO; a ordem dos preços varia e o Motor reenvia tudo todo ciclo |
| Porta 3020 | colide com o Motor de Orçamentos na mesma máquina (`EADDRINUSE`) |
| Reaproveitar `serviceName`/repo do updater | o Shop se atualiza com a release dos Orçamentos e vira outro serviço |
| Aumentar `chunkSize` sem medir | 413 — o ZapRun tem `bodyParser.json({limit:'5mb'})` **global**, antes das rotas |
| Coluna de texto sem `CHARACTER SET OCTETS` na view | Acentuação perdida **irreversivelmente** na leitura |
| Incluir `raw` no hash | Todo ciclo parece alteração (colunas voláteis do ERP) |
| Mexer em `views_zaprun_shop.sql` sem ler o schema real | `CREATE OR ALTER` roda a cada boot e substitui a view do cliente — um nome de coluna errado a derruba inteira |
| `CAST(... AS VARCHAR(n))` menor que a coluna real | não trunca: derruba a leitura com "string right truncation" e o ciclo não entrega nada. Maior é sempre seguro |
| Ligar o `HAVING SUM(qtdeatual) > 0` na subconsulta de estoque | o produto que zera some da lista de depósitos, e o Shop deixa de distinguir "esgotado" de "sem informação" |
| `require('mysql2')` fora de `erp/linear/mysql.js` (carregado sob demanda) | o updater não roda `npm install`: o Automec atualizado cai no boot com "Cannot find module" |
| Senha do Linear no `.env` sem aspas | `#` é comentário para o dotenv — senha cortada, `Access denied` que parece culpa da Linear |
| `CURDATE()` na consulta do Linear | MySQL da Linear pode estar em UTC; às 21h de Brasília já é amanhã. Use a data da máquina, por parâmetro |
| `CAST(pcb.codbarra AS VARCHAR(...))` puro, sem validar comprimento | ERPs costumam ter linha de `produto_codbarra` com o próprio CDPRODUTO no lugar do EAN — a busca automática de imagem então casa "10" com o código de outro produto qualquer, e a vitrine mostra a foto errada. Só deixe passar dígitos no comprimento de um código real (8, 12, 13, 14) |

## Gravação de orçamento (v1.3.0)

O Motor também **escreve** no Automec: o pedido da Loja vira orçamento
(`motor/pedidos/` + `motor/erp/automec-orcamento.js`; contrato em
`docs/03-contrato-api.md`). Regras desta trilha:

| Armadilha | Consequência |
|---|---|
| `UPDATE OR INSERT ... MATCHING (NRORCAMENTO, IDEMPRESA)` (como a Pontual) | número colidido SOBRESCREVE o orçamento do balcão. Use INSERT puro + renumerar |
| Parâmetro de texto sem `CAST(? AS VARCHAR(n) CHARACTER SET WIN1252)` | o node-firebird conecta em UTF8 e ignora `charset`: "É" vira `C3 89` e o Automec mostra "Ã‰" (`textoParaErp.js`) |
| Texto maior que a coluna | "string right truncation" derruba o pedido inteiro — corte pelo tamanho lido do RDB$ |
| Gravar cabeçalho e itens pelo pool (`firebird.js`) | autocommit por comando: orçamento pela metade. Use `firebirdEscrita.comTransacao` |
| Criar `ZR_PEDIDO` no boot | o DDL só acontece em modo Gravar, para quem ligou o recurso |
| Recriar orçamento que sumiu do ERP | a loja excluiu de propósito — responda `removido` |
| Criar `ZR_PEDIDO` só no primeiro pedido | a loja não consegue conferir a tela do Automec antes do pedido real, e um pedido barrado no servidor deixa a coluna sem nascer (visto 19/11). Crie na consulta em modo Gravar |
| TPB montado à mão passado ao `db.transaction()` | o updater preserva o `node_modules` e há máquina com node-firebird 2.x, que põe versão/escrita/espera sozinho: o TPB da 1.x vira `[3, 3, ...]` e o Firebird recusa ("isc_tpb_shared requires table name"). Use `parametrosDaTransacao()` |
| Deixar nulo o que o Automec da casa sempre preenche | o orçamento existe no banco e não aparece na tela do Automec (JPR, 23/11). `perfilDaCasa` copia códigos e prazos; teste em `tools/fb-teste/testar-casa.js` |
| Item com STATUS 'FF' (da Pontual), ou endereço do balcão na retirada | o dono definiu: item EN (entrega) / RM (retirada); retirada sem endereço (`tools/fb-teste/testar-jpr.js`) |
| Pular número de orçamento por causa de `SAIDAESTOQUE.NRORCAMENTO` | vendas antigas citam números altos: na JB Morais saiu 79123 em vez de 463, e o balcão passou a numerar dali. O número é MAX(NRORCAMENTO)+1 do ORCAMENTO, e nada mais |
| `ZR_PEDIDO` = id interno do banco do ZapRun (orderId) | o dono não reconhece o orderId. `ZR_PEDIDO` guarda o **número do pedido na Loja** (`p.numero`), que é o que aparece no painel e no chat |
| Achar o orçamento só por `ZR_PEDIDO` = número | o número se REPETE (MAX+1 dos pedidos que existem: excluir o último devolve o número). Na 1.3.12 o pedido novo ficava "travado" no orçamento cancelado do excluído, ou regravava o do outro. Busque `ZR_PEDIDO IN (número, pedidoId)` e aceite só o orçamento com DTORC/HORAORC da criação DESTE pedido (`nasceuJunto`, `tools/fb-teste/testar-numero-repetido.js`) |
| `new Date(1899, 11, 30, h, m, s)` no HORAORC | o node-firebird grava com o fuso em minutos inteiros e o fuso de 1899 em São Paulo é −3:06:28: ia 28 s adiantado. `datasDoOrcamento` monta a data para o driver gravar a hora exata |
| Valor fixo da Pontual em QTDELIB/QTDEPECA | o Automec da casa preenche diferente (JPR: QTDELIB = quantidade em 0 de 200 itens). Copie a convenção dos últimos itens |
| CALC do item = quantidade | o dono definiu (23/11): CALC = VLUNIT, sempre. Não volte a copiar a casa nessa coluna |
| Orçamento sem linha em `SIS_APPHISTORY` | não aparece na aba Histórico do Automec — quem grava é o programa (`SP_ADDHISTORY`), não gatilho. `EXECUTE PROCEDURE`, nunca `SELECT` (SUSPEND sem RETURNS). Falha no histórico nunca derruba o orçamento (`tools/fb-teste/testar-historico.js`) |
| Buscar em `SIS_APPHISTORY` com ORDER BY ou CONTAINING | 1,4 milhão de linhas na JPR, e não há índice conhecido em CONTEXTO: risco de varredura inteira. `FIRST 1` sem ORDER BY para no primeiro achado |

## Release

Código chega na frota por **release no GitHub**
(`Clebio2030/zaprun-shop-motor`, `releases/latest`); os clientes puxam
pelo updater. O repo é **outro** que o dos Orçamentos, de propósito: release do
Shop não pode virar update do Motor de Orçamentos.

Ativação de comportamento por cliente = **toggle server-side**, nunca `.env`.
