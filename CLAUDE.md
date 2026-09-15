# ZapRun Shop — instruções para IA (Claude e demais)

Este repo é o **Motor ZapRun Shop**: serviço Node.js que roda na máquina de cada
cliente, lê o catálogo de produtos do ERP dele (Firebird local) e entrega na API
do ZapRun via `POST /erp/produtos/sync`, alimentando o catálogo do Shop
(`StoreProduct`).

Derivado do **Motor de Orçamentos** (`../motor-orcamento-erp`), que é o
original. Os princípios abaixo vieram de lá e foram pagos caro — não os reinvente.

## ⚠️ Leia primeiro

1. **[README.md](README.md)** — o produto cartesiano da view e por que ele é o
   problema central deste Motor.
2. **[sql/views_zaprun_shop.sql](sql/views_zaprun_shop.sql)** — o contrato da
   view. É o cabeçalho do arquivo, não o SQL, que importa.
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

- **Trocar de ERP = trocar `sql/views_zaprun_shop.sql` + `motor/mapping.js`.** Se
  uma mudança de ERP encostar em `index.js`, `sender.js` ou `syncState.js`, o
  desenho vazou — repense.
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
| Porta 3001 | colide com o Motor de Orçamentos na mesma máquina (`EADDRINUSE`) |
| Reaproveitar `serviceName`/repo do updater | o Shop se atualiza com a release dos Orçamentos e vira outro serviço |
| Aumentar `chunkSize` sem medir | 413 — o ZapRun tem `bodyParser.json({limit:'5mb'})` **global**, antes das rotas |
| Coluna de texto sem `CHARACTER SET OCTETS` na view | Acentuação perdida **irreversivelmente** na leitura |
| Incluir `raw` no hash | Todo ciclo parece alteração (colunas voláteis do ERP) |
| Escrever DDL em `views_zaprun_shop.sql` sem ler o schema real | `CREATE OR ALTER` substitui a view boa do cliente por um chute, no primeiro boot |

## Release

Código chega na frota por **release no GitHub**
(`Clebio2030/zaprun-motor-zaprunshop`, `releases/latest`); os clientes puxam
pelo updater. O repo é **outro** que o dos Orçamentos, de propósito: release do
Shop não pode virar update do Motor de Orçamentos.

Ativação de comportamento por cliente = **toggle server-side**, nunca `.env`.
